import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPlugin } from "../helpers/plugin-build";
import { importClientArtifact, isClientEntry, loadPlugin } from "../helpers/plugin-contract";
import { repoPath } from "../helpers/repo-files";

const PLUGIN_ID = "catalog-sync";
const EVENT_NAME = "pi-web-ui:plugin-run-command";
const CATALOG_URL = "https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json";

interface FakeEvent {
	type: string;
	detail?: unknown;
}

interface FakeWindow {
	dispatchEvent(event: FakeEvent): boolean;
}

interface FakeElement {
	textContent: string;
	value: string;
	type: string;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
	click(): void;
}

interface FakeDocument {
	defaultView?: FakeWindow;
	createElement(tagName: string): FakeElement;
}

function createFakeDom(defaultView?: FakeWindow): { document: FakeDocument; container: FakeElement } {
	const document = {} as FakeDocument;
	const makeElement = (tagName: string): FakeElement => {
		const listeners = new Map<string, Set<() => void>>();
		const element: FakeElement = {
			textContent: "",
			value: "",
			type: tagName === "button" ? "button" : "",
			children: [],
			ownerDocument: document,
			append(...children) {
				element.children.push(...children);
			},
			replaceChildren(...children) {
				element.children = children;
			},
			addEventListener(type, listener) {
				let handlers = listeners.get(type);
				if (!handlers) listeners.set(type, (handlers = new Set()));
				handlers.add(listener);
			},
			removeEventListener(type, listener) {
				listeners.get(type)?.delete(listener);
			},
			click() {
				for (const listener of listeners.get("click") ?? []) listener();
			},
		};
		return element;
	};
	document.defaultView = defaultView;
	document.createElement = (tagName) => makeElement(tagName);
	return { document, container: makeElement("main") };
}

interface CatalogSyncClientModule {
	CATALOG_URL: string;
	reloadCommand(): string;
	default: {
		mount?(container: unknown, ctx: unknown): (() => void) | undefined;
	};
}

const SOURCE_MODULE = "../../plugins/catalog-sync/src/client.ts";

async function loadSource(): Promise<CatalogSyncClientModule> {
	return (await import(SOURCE_MODULE)) as CatalogSyncClientModule;
}

function decodeCommandScript(command: string): string {
	const encoded = command.match(/Buffer\.from\('([^']+)', 'base64'\)/)?.[1];
	if (!encoded) throw new Error("reload command did not contain an encoded Node script");
	return Buffer.from(encoded, "base64").toString("utf8");
}

interface ScriptRun {
	status: number | null;
	stderr: string;
	calls: string[];
	catalog: string | undefined;
}

async function runCommandScript(
	entries: unknown,
	failId = "",
	httpStatus = 200,
	previousCatalog?: string,
): Promise<ScriptRun> {
	const root = mkdtempSync(join(tmpdir(), "catalog-sync-script-"));
	const bin = join(root, "bin");
	const dataDir = join(root, "data");
	const log = join(root, "calls.log");
	mkdirSync(bin, { recursive: true });
	if (previousCatalog !== undefined) {
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "plugin-catalog.json"), previousCatalog, "utf8");
	}
	const cli = join(bin, "pi-web-ui");
	writeFileSync(
		cli,
		'#!/bin/sh\nprintf "%s\\n" "$*" >> "$CATALOG_SYNC_LOG"\nif [ -n "$FAIL_ID" ]; then case "$*" in *"--name $FAIL_ID "*) exit 7;; esac; fi\n',
		"utf8",
	);
	chmodSync(cli, 0o755);

	const { reloadCommand } = await loadSource();
	const source = decodeCommandScript(reloadCommand());
	const response = JSON.stringify(entries) ?? "undefined";
	const runner = `globalThis.fetch = async () => ({ ok: ${httpStatus >= 200 && httpStatus < 300}, status: ${httpStatus}, json: async () => ${response} }); await (async () => {${source}})();`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			CATALOG_SYNC_LOG: log,
			PI_WEB_DATA_DIR: dataDir,
			FAIL_ID: failId,
		},
	});
	const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	const catalogPath = join(dataDir, "plugin-catalog.json");
	const catalog = existsSync(catalogPath) ? readFileSync(catalogPath, "utf8") : undefined;
	rmSync(root, { recursive: true, force: true });
	return { status: result.status, stderr: result.stderr ?? "", calls, catalog };
}

describe("catalog-sync terminal command", () => {
	const entries = [
		{ id: "alpha", source: "owner/repo/plugins/alpha" },
		{ id: "catalog-sync", source: "owner/repo/plugins/catalog-sync" },
		{ id: "beta", source: "https://example.com/plugins/beta" },
	];

	it("installs each source with its catalog id and publishes the catalog atomically", async () => {
		const run = await runCommandScript(entries);

		expect(run.status).toBe(0);
		expect(run.calls).toEqual([
			"install owner/repo/plugins/alpha --name alpha --force",
			"install https://example.com/plugins/beta --name beta --force",
		]);
		expect(JSON.parse(run.catalog ?? "null")).toEqual({ entries });
	});

	it("rejects an HTTP failure without installing or replacing the catalog", async () => {
		const previous = '{"entries":[{"id":"old","source":"owner/repo/old"}]}\n';
		const run = await runCommandScript([], "", 503, previous);
		expect(run.status).not.toBe(0);
		expect(run.calls).toEqual([]);
		expect(run.catalog).toBe(previous);
	});

	it.each([
		["a non-array response", null],
		["an empty catalog", []],
		["an entry without a source", [{ id: "broken" }]],
		["an invalid id", [{ id: "bad id", source: "owner/repo/plugin" }]],
		[
			"duplicate ids",
			[
				{ id: "same", source: "owner/repo/one" },
				{ id: "same", source: "owner/repo/two" },
			],
		],
	] as const)("rejects %s without installing or replacing the catalog", async (_label, value) => {
		const run = await runCommandScript(value);
		expect(run.status).not.toBe(0);
		expect(run.calls).toEqual([]);
		expect(run.catalog).toBeUndefined();
	});

	it("leaves the previous catalog untouched when an install fails", async () => {
		const previous = '{"entries":[{"id":"old","source":"owner/repo/old"}]}\n';
		const run = await runCommandScript(entries, "beta", 200, previous);

		expect(run.status).toBe(7);
		expect(run.calls).toEqual([
			"install owner/repo/plugins/alpha --name alpha --force",
			"install https://example.com/plugins/beta --name beta --force",
		]);
		expect(run.catalog).toBe(previous);
	});
});

describe("catalog-sync manifest and distribution", () => {
	it("declares a client-only view with no unnecessary permissions", () => {
		const plugin = loadPlugin(PLUGIN_ID);
		expect(plugin.id).toBe(PLUGIN_ID);
		expect(plugin.manifest.name).toBe("Plugin Catalog Sync");
		expect(plugin.manifest.version).toBe("0.1.0");
		expect(plugin.manifest.view).toBe(true);
		expect(plugin.manifest.renderers).toBeUndefined();
		expect(plugin.manifest.permissions ?? []).toEqual([]);
		expect(plugin.raw).not.toHaveProperty("descriptionEn");
		expect(plugin.hasServerSource).toBe(false);
		expect(plugin.hasClientSource).toBe(true);
	});

	it("documents the terminal-command limitation and source URL", () => {
		const readme = readFileSync(repoPath("plugins", PLUGIN_ID, "README.md"), "utf8");
		expect(readme).toContain(EVENT_NAME);
		expect(readme).toContain(CATALOG_URL);
		expect(readme).toContain("private host event");
	});

	it("builds a client artifact the host can load", async () => {
		const result = buildPlugin(PLUGIN_ID);
		expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
		expect(result.serverEntry).toBeUndefined();
		expect(result.clientEntry).toBeDefined();
		expect(isClientEntry(await importClientArtifact(PLUGIN_ID))).toBe(true);
	});
});

describe("catalog-sync view", () => {
	it("renders one reload control and sends the catalog sync command", async () => {
		const events: FakeEvent[] = [];
		const { container } = createFakeDom({
			dispatchEvent(event) {
				events.push(event);
				return true;
			},
		});
		const { default: entry, CATALOG_URL: sourceUrl } = await loadSource();

		expect(sourceUrl).toBe(CATALOG_URL);
		const cleanup = entry.mount?.(container as unknown as HTMLElement, {} as never);
		expect(container.children).toHaveLength(2);
		expect(container.children[0]?.textContent).toBe("Reload custom plugins");
		expect(container.children[1]?.textContent).toBe("Ready.");

		container.children[0]?.click();
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe(EVENT_NAME);
		const firstEvent = events[0]!;
		expect(firstEvent.detail).toMatchObject({ title: "Reload custom plugins" });
		const command = (firstEvent.detail as { command: string }).command;
		expect(command).toContain(
			"pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/catalog-sync --name catalog-sync --force",
		);
		expect(command).toContain("node --input-type=module");
		const script = decodeCommandScript(command);
		expect(script).toContain(CATALOG_URL);
		expect(script).toContain("plugin-catalog.json");
		expect(container.children[1]?.textContent).toBe("Reload request sent to the terminal.");
		cleanup?.();
		expect(container.children).toEqual([]);
	});

	it("supports repeated reloads without sharing mutable event details", async () => {
		const events: FakeEvent[] = [];
		const { container } = createFakeDom({
			dispatchEvent(event) {
				events.push(event);
				return true;
			},
		});
		const { default: entry } = await loadSource();
		entry.mount?.(container as unknown as HTMLElement, {} as never);

		container.children[0]?.click();
		container.children[0]?.click();
		expect(events).toHaveLength(2);
		expect(events.map((event) => event.type)).toEqual([EVENT_NAME, EVENT_NAME]);
		const firstDetail = events[0]!.detail as { title: string; command: string };
		const secondDetail = events[1]!.detail as { title: string; command: string };
		expect(firstDetail.title).toBe("Reload custom plugins");
		expect(secondDetail.title).toBe("Reload custom plugins");
		expect(firstDetail.command).toBe(secondDetail.command);
	});

	it("shows a useful error when the host terminal bridge is unavailable", async () => {
		const { container } = createFakeDom();
		const { default: entry } = await loadSource();
		entry.mount?.(container as unknown as HTMLElement, {} as never);

		expect(() => container.children[0]?.click()).not.toThrow();
		expect(container.children[1]?.textContent).toBe("The terminal bridge is unavailable.");
	});

	it("shows a useful error when the host rejects dispatch", async () => {
		const { container } = createFakeDom({
			dispatchEvent: vi.fn(() => {
				throw new Error("host unavailable");
			}),
		});
		const { default: entry } = await loadSource();
		entry.mount?.(container as unknown as HTMLElement, {} as never);

		expect(() => container.children[0]?.click()).not.toThrow();
		expect(container.children[1]?.textContent).toBe("Could not start the reload command.");
	});
});

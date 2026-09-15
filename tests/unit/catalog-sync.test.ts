/**
 * catalog-sync after the 0.86 retirement.
 *
 * The plugin used to clone this repository into a temp dir, run `npm ci` and the
 * repo build, then install each plugin through the private
 * `pi-web-ui:plugin-run-command` terminal event. pi-web-ui 0.86 does all of that
 * itself: the marketplace installs with "Build from source" (`install --build`),
 * and `host.reloadCatalog(source, { install, replace })` is a supported,
 * receipt-returning catalog sync.
 *
 * What is left is one button. These tests pin the behaviour of that button -
 * what it asks the host for, and what the user is told for every answer the host
 * can give - plus the invariant that the retired machinery is really gone.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildPlugin } from "../helpers/plugin-build";
import { importClientArtifact, isClientEntry, loadPlugin } from "../helpers/plugin-contract";
import { repoPath } from "../helpers/repo-files";

const PLUGIN_ID = "catalog-sync";
const CATALOG_URL = "https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json";
const RETIRED_EVENT = "pi-web-ui:plugin-run-command";

type Receipt = { ok: boolean; error?: string; entries?: unknown[]; installed?: unknown[] };

interface FakeElement {
	tagName: string;
	textContent: string;
	type: string;
	disabled: boolean;
	className: string;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
	click(): void;
	listenerCount(): number;
}

interface FakeDocument {
	defaultView?: { __piWebUiHost?: unknown; dispatchEvent?: (event: unknown) => boolean };
	createElement(tagName: string): FakeElement;
}

function createDom(host?: unknown): {
	document: FakeDocument;
	container: FakeElement;
	dispatched: unknown[];
} {
	const dispatched: unknown[] = [];
	const document = {} as FakeDocument;
	document.defaultView = {
		...(host === undefined ? {} : { __piWebUiHost: host }),
		dispatchEvent: (event: unknown) => {
			dispatched.push(event);
			return true;
		},
	};
	document.createElement = (tagName: string): FakeElement => {
		const listeners = new Map<string, Set<() => void>>();
		const element: FakeElement = {
			tagName,
			textContent: "",
			type: "",
			disabled: false,
			className: "",
			children: [],
			ownerDocument: document,
			append(...children) {
				element.children.push(...children);
			},
			replaceChildren(...children) {
				element.children = children;
			},
			addEventListener(type, listener) {
				if (!listeners.has(type)) listeners.set(type, new Set());
				listeners.get(type)?.add(listener);
			},
			removeEventListener(type, listener) {
				listeners.get(type)?.delete(listener);
			},
			click() {
				for (const listener of [...(listeners.get("click") ?? [])]) listener();
			},
			listenerCount() {
				return [...listeners.values()].reduce((total, set) => total + set.size, 0);
			},
		};
		return element;
	};
	return { document, container: document.createElement("div"), dispatched };
}

function flatten(element: FakeElement): FakeElement[] {
	return [element, ...element.children.flatMap(flatten)];
}

/** Everything the view currently shows the user, as one string. */
function visibleText(container: FakeElement): string {
	return flatten(container)
		.filter((element) => element.tagName !== "style")
		.map((element) => element.textContent)
		.filter(Boolean)
		.join(" | ");
}

function syncButton(container: FakeElement): FakeElement {
	const button = flatten(container).find((element) => element.tagName === "button");
	if (!button) throw new Error("the view renders no button");
	return button;
}

async function mountView(host?: unknown): Promise<{
	container: FakeElement;
	dispatched: unknown[];
	cleanup: () => void;
}> {
	const module = (await importClientArtifact(PLUGIN_ID)) as {
		default: { mount(container: unknown, ctx: unknown): () => void };
	};
	const { container, dispatched } = createDom(host);
	const cleanup = module.default.mount(container, { pluginId: PLUGIN_ID, send: () => {}, onData: () => () => {} });
	return { container, dispatched, cleanup };
}

/** A host whose reloadCatalog resolves with the given receipt. */
function hostReturning(receipt: Receipt) {
	return {
		version: 6,
		reloadCatalog: vi.fn(async (_source: string, _options?: { install?: boolean; replace?: boolean }) => receipt),
	};
}

describe("catalog-sync client", () => {
	it("builds and exposes a client entry the host accepts", async () => {
		const result = buildPlugin(PLUGIN_ID);
		expect(result.ok, `stderr: ${result.stderr}`).toBe(true);
		const plugin = loadPlugin(PLUGIN_ID);
		expect(plugin.hasClientArtifact).toBe(true);
		expect(plugin.hasServerSource, "the view needs no server half").toBe(false);
		expect(isClientEntry(await importClientArtifact(PLUGIN_ID))).toBe(true);
	});

	it("asks the host to replace the catalog with this repository's list", async () => {
		const host = hostReturning({ ok: true, entries: [{ id: "webmail" }, { id: "mermaid" }] });
		const { container, cleanup } = await mountView(host);

		syncButton(container).click();
		await vi.waitFor(() => expect(host.reloadCatalog).toHaveBeenCalledTimes(1));

		expect(host.reloadCatalog).toHaveBeenCalledWith(CATALOG_URL, { replace: true });
		await vi.waitFor(() => expect(visibleText(container)).toMatch(/2 plugins/));
		cleanup();
	});

	it("never installs plugins on the user's behalf: that is the marketplace's job", async () => {
		const host = hostReturning({ ok: true, entries: [{ id: "webmail" }] });
		const { container, dispatched, cleanup } = await mountView(host);

		syncButton(container).click();
		await vi.waitFor(() => expect(host.reloadCatalog).toHaveBeenCalled());

		const options = host.reloadCatalog.mock.calls[0]?.[1] as { install?: boolean } | undefined;
		expect(options?.install ?? false).toBe(false);
		expect(dispatched, "the private terminal event is retired").toEqual([]);
		cleanup();
	});

	it("blocks a second sync while one is in flight", async () => {
		let release = (): void => {};
		const host = {
			version: 6,
			reloadCatalog: vi.fn(
				() =>
					new Promise<Receipt>((resolve) => {
						release = () => resolve({ ok: true, entries: [] });
					}),
			),
		};
		const { container, cleanup } = await mountView(host);
		const button = syncButton(container);

		button.click();
		await vi.waitFor(() => expect(button.disabled).toBe(true));
		button.click();
		expect(host.reloadCatalog).toHaveBeenCalledTimes(1);

		release();
		await vi.waitFor(() => expect(button.disabled).toBe(false));
		cleanup();
	});

	it("reports the host's own error instead of claiming success", async () => {
		const host = hostReturning({ ok: false, error: "Failed to fetch the catalog: HTTP 404" });
		const { container, cleanup } = await mountView(host);

		syncButton(container).click();
		await vi.waitFor(() => expect(visibleText(container)).toContain("HTTP 404"));
		expect(visibleText(container)).not.toMatch(/synced/i);
		cleanup();
	});

	it("reports a rejected sync rather than hanging on 'Syncing'", async () => {
		const host = { version: 6, reloadCatalog: vi.fn(async () => Promise.reject(new Error("socket hang up"))) };
		const { container, cleanup } = await mountView(host);

		syncButton(container).click();
		await vi.waitFor(() => expect(visibleText(container)).toContain("socket hang up"));
		expect(syncButton(container).disabled).toBe(false);
		cleanup();
	});

	it("explains the requirement on a host too old to have reloadCatalog", async () => {
		for (const host of [undefined, { version: 3 }]) {
			const { container, cleanup } = await mountView(host);
			syncButton(container).click();
			expect(visibleText(container)).toMatch(/0\.86/);
			cleanup();
		}
	});

	it("ignores a receipt that arrives after unmount", async () => {
		let release = (): void => {};
		const host = {
			version: 6,
			reloadCatalog: vi.fn(
				() =>
					new Promise<Receipt>((resolve) => {
						release = () => resolve({ ok: true, entries: [{ id: "webmail" }] });
					}),
			),
		};
		const { container, cleanup } = await mountView(host);
		const button = syncButton(container);

		button.click();
		await vi.waitFor(() => expect(button.disabled).toBe(true));
		cleanup();
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(container.children, "cleanup must empty the container").toEqual([]);
		expect(button.listenerCount(), "cleanup must remove the click listener").toBe(0);
	});
});

describe("retired machinery", () => {
	it("no longer carries a cloning, npm-running or terminal-driving source", () => {
		// Comments stripped: the history may be explained, it may not be executed.
		const source = readFileSync(repoPath("plugins", PLUGIN_ID, "src", "client.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const retired of [RETIRED_EVENT, "git clone", "npm ci", "spawnSync", "mkdtemp", "pi-web-ui install", "btoa"]) {
			expect(source, `catalog-sync still references "${retired}"`).not.toContain(retired);
		}
	});

	it("tells the user to install with --build instead of the old bootstrap dance", () => {
		const readme = readFileSync(repoPath("plugins", PLUGIN_ID, "README.md"), "utf8");
		expect(readme).toContain("--build");
		// The retired event may be named in the history section, but never as a step.
		expect(readme).not.toContain("Install/update selected");
		expect(readme).toMatch(/0\.86/);
	});
});

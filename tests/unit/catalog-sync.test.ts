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
	value: string;
	checked: boolean;
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
			value: "",
			checked: false,
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

/** The button that hands the update command to a visible terminal. */
function sendButton(container: FakeElement): FakeElement {
	const button = flatten(container).find(
		(element) => element.tagName === "button" && /terminal/i.test(element.textContent),
	);
	if (!button) throw new Error("the view renders no send-to-terminal button");
	return button;
}

async function mountView(host?: unknown): Promise<{
	container: FakeElement;
	dispatched: unknown[];
	sent: unknown[];
	push: (payload: unknown) => void;
	cleanup: () => void;
}> {
	const module = (await importClientArtifact(PLUGIN_ID)) as {
		default: { mount(container: unknown, ctx: unknown): () => void };
	};
	const { container, dispatched } = createDom(host);
	const sent: unknown[] = [];
	const listeners = new Set<(payload: unknown) => void>();
	const cleanup = module.default.mount(container, {
		pluginId: PLUGIN_ID,
		send: (payload: unknown) => sent.push(payload),
		onData: (cb: (payload: unknown) => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	});
	const push = (payload: unknown): void => {
		for (const listener of [...listeners]) listener(payload);
	};
	return { container, dispatched, sent, push, cleanup };
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
		expect(plugin.hasServerSource, "update detection needs filesystem access").toBe(true);
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

describe("update list", () => {
	const rows = [
		{
			id: "webmail",
			name: "Webmail",
			version: "0.2.0",
			status: "update-available",
			command: "pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/webmail --name webmail --build --force",
		},
		{
			id: "mermaid",
			name: "Mermaid",
			version: "1.0.0",
			status: "current",
			// The server sets a command for every row it knows the source of, not just
			// the stale ones, so a forced rebuild stays possible.
			command: "pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/mermaid --name mermaid --build --force",
		},
		{ id: "legacy", name: "Legacy", status: "unknown" },
	];

	it("asks the server for update status on mount", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { sent, cleanup } = await mountView(host);
		expect(sent).toContainEqual({ action: "check_updates" });
		cleanup();
	});

	it("shows each plugin with its state, and the command for the stale ones", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { container, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows });

		const text = visibleText(container);
		expect(text).toContain("Webmail");
		expect(text).toContain("Mermaid");
		expect(text, "the stale plugin's update command must be copyable").toContain("--build --force");
		// A plugin that is already current needs no command cluttering the row.
		expect(text.split("--build --force").length - 1).toBe(1);
		cleanup();
	});

	it("distinguishes 'nothing to do' from 'could not tell'", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { container, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows });

		const text = visibleText(container).toLowerCase();
		expect(text).toMatch(/update available/);
		expect(text).toMatch(/up to date/);
		expect(text, "an unreadable remote must not look reassuring").toMatch(/unknown/);
		cleanup();
	});

	it("lets you pick which plugins to update and sends one command to a terminal", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { container, dispatched, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows });

		const boxes = flatten(container).filter((element) => element.type === "checkbox");
		expect(boxes.length, "a box per updatable plugin").toBeGreaterThan(0);
		// The stale ones are the answer to "what do I want to update", so they start ticked.
		expect(boxes.filter((box) => box.checked).map((box) => box.value)).toEqual(["webmail"]);

		sendButton(container).click();

		expect(dispatched).toHaveLength(1);
		const event = dispatched[0] as { type: string; detail: { title?: string; command?: string } };
		expect(event.type).toBe(RETIRED_EVENT);
		expect(event.detail.command).toContain("plugins/webmail");
		expect(event.detail.command).toContain("--build");
		expect(event.detail.command).toContain("--force");
		expect(event.detail.command, "an up-to-date plugin was not selected").not.toContain("plugins/mermaid");
		cleanup();
	});

	it("chains exactly the plugins that are still ticked", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { container, dispatched, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows });

		const boxes = flatten(container).filter((element) => element.type === "checkbox");
		const mermaid = boxes.find((box) => box.value === "mermaid");
		if (!mermaid) throw new Error("an up-to-date plugin must still be selectable for a forced reinstall");
		mermaid.checked = true;
		mermaid.click();
		sendButton(container).click();

		const command = (dispatched[0] as { detail: { command: string } }).detail.command;
		expect(command).toContain("plugins/webmail");
		expect(command).toContain("plugins/mermaid");
		// One terminal run, not one per plugin.
		expect(command.split("&&")).toHaveLength(2);
		cleanup();
	});

	it("refuses to send an empty command when nothing is ticked", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { container, dispatched, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows });

		const webmail = flatten(container).find((element) => element.value === "webmail");
		webmail!.checked = false;
		webmail!.click();

		expect(sendButton(container).disabled).toBe(true);
		sendButton(container).click();
		expect(dispatched).toEqual([]);
		cleanup();
	});

	it("never claims it can update a plugin by itself", async () => {
		// reloadCatalog({install:true}) is the only install path a plugin can reach
		// and it never passes --build, which would replace these source-only plugins
		// with unbuilt source. So no button may promise an update.
		const host = hostReturning({ ok: true, entries: [] });
		const { container, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows });

		const buttons = flatten(container).filter((element) => element.tagName === "button");
		for (const button of buttons) {
			expect(button.textContent.toLowerCase()).not.toMatch(/^update\b/);
		}
		cleanup();
	});

	it("reports a plugin set it could not read rather than rendering nothing", async () => {
		const host = hostReturning({ ok: true, entries: [] });
		const { container, push, cleanup } = await mountView(host);
		push({ kind: "updates", rows: [] });
		expect(visibleText(container).toLowerCase()).toMatch(/no plugins/);
		cleanup();
	});
});

describe("retired machinery", () => {
	it("no longer clones, runs npm, or hides what it does behind base64", () => {
		// Comments stripped: the history may be explained, it may not be executed.
		const source = readFileSync(repoPath("plugins", PLUGIN_ID, "src", "client.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		// The terminal event is back on purpose - it is the only build-capable path
		// a plugin can reach - but the temp-checkout machinery stays dead, and the
		// command must be readable in the terminal rather than an encoded blob.
		for (const retired of ["git clone", "npm ci", "spawnSync", "mkdtemp", "btoa", "--input-type=module"]) {
			expect(source, `catalog-sync still references "${retired}"`).not.toContain(retired);
		}
	});

	it("sends a command a human can read and audit before it runs", () => {
		const source = readFileSync(repoPath("plugins", PLUGIN_ID, "src", "client.ts"), "utf8");
		expect(source, "the private bridge must be named and explained, not smuggled in").toContain(RETIRED_EVENT);
		expect(source).toMatch(/only way to reach a build-capable install|never passes --build/);
	});

	it("tells the user to install with --build instead of the old bootstrap dance", () => {
		const readme = readFileSync(repoPath("plugins", PLUGIN_ID, "README.md"), "utf8");
		expect(readme).toContain("--build");
		// The retired event may be named in the history section, but never as a step.
		expect(readme).not.toContain("Install/update selected");
		expect(readme).toMatch(/0\.86/);
	});
});

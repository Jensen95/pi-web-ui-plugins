/**
 * topbar-fix: a stopgap stylesheet for xing-shuyin/pi-web-ui#162.
 *
 * The host renders `.plugin-topbar-menu` (the `⋯` overflow menu) inside
 * `.view-switch`, which carries `overflow: hidden` so its `border-radius: 9px`
 * clips the segmented buttons. That also clips the absolutely positioned
 * dropdown, which opens below the control - so the menu is in the DOM and can
 * never be seen. This plugin injects the CSS that releases it.
 *
 * How it gets a chance to run: the host eagerly imports client/entry.mjs for
 * every plugin with `hasClient && view !== false` on each client attach, before
 * anyone opens anything. The module patches the document at import time. The
 * price of that eagerness is a top-bar tab, so the patch hides its own tab too -
 * and if the patch ever stops matching, the tab reappears and explains itself.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "../helpers/plugin-build";
import { importClientArtifact, isClientEntry, loadPlugin } from "../helpers/plugin-contract";
import { repoPath } from "../helpers/repo-files";

const PLUGIN_ID = "topbar-fix";

interface FakeElement {
	tagName: string;
	id: string;
	textContent: string;
	href: string;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	remove(): void;
}

interface FakeDocument {
	head: FakeElement;
	createElement(tag: string): FakeElement;
	getElementById(id: string): FakeElement | null;
}

/** Every text node the view rendered, so an assertion reads what a user sees
 *  rather than how the DOM was assembled. */
function visibleText(element: FakeElement): string {
	return [element.textContent, element.href, ...element.children.map(visibleText)].filter(Boolean).join(" ");
}

function createDocument(): FakeDocument {
	const byId = new Map<string, FakeElement>();
	const document = {} as FakeDocument;
	const make = (tagName: string): FakeElement => {
		const element: FakeElement = {
			tagName,
			id: "",
			textContent: "",
			href: "",
			children: [],
			ownerDocument: document,
			append(...children) {
				for (const child of children) {
					element.children.push(child);
					if (child.id) byId.set(child.id, child);
				}
			},
			replaceChildren(...children) {
				element.children = children;
			},
			remove() {
				if (element.id) byId.delete(element.id);
			},
		};
		return element;
	};
	document.head = make("head");
	document.createElement = make;
	document.getElementById = (id) => byId.get(id) ?? null;
	return document;
}

interface PatchModule {
	STYLE_ID: string;
	PATCH_CSS: string;
	applyPatch(doc: unknown): () => void;
	default: { mount(container: unknown, ctx: unknown): () => void };
}

const manifest = JSON.parse(readFileSync(repoPath("plugins", PLUGIN_ID, "manifest.json"), "utf8")) as {
	name: string;
	view?: unknown;
	ui?: unknown;
};

function loadModule(): Promise<PatchModule> {
	return importClientArtifact(PLUGIN_ID) as Promise<PatchModule>;
}

describe("topbar-fix stylesheet", () => {
	it("builds a client entry the host accepts", async () => {
		const result = buildPlugin(PLUGIN_ID);
		expect(result.ok, `stderr: ${result.stderr}`).toBe(true);
		expect(loadPlugin(PLUGIN_ID).hasClientArtifact).toBe(true);
		expect(isClientEntry(await loadModule())).toBe(true);
	});

	it("keeps the view flag on, because that is what makes the host load it at all", () => {
		// view:false would drop it from the eager import loop, and a stylesheet that
		// only applies once you open its page is useless.
		expect(manifest.view, "topbar-fix must stay eagerly loaded").not.toBe(false);
		expect(manifest.ui, "it contributes no slot entries; it only patches CSS").toBeUndefined();
	});

	it("releases the menu from its clipping ancestor", async () => {
		const { PATCH_CSS } = await loadModule();
		expect(PATCH_CSS).toMatch(/\.view-switch\s*\{[^}]*overflow:\s*visible/);
	});

	it("keeps the segmented control's rounded corners the overflow was clipping", async () => {
		const { PATCH_CSS } = await loadModule();
		expect(PATCH_CSS, "first child needs its left corners back").toMatch(/first-child[^}]*border-radius/);
		expect(PATCH_CSS, "last child needs its right corners back").toMatch(/last-child[^}]*border-radius/);
	});

	it("releases the portalled menu's clip only while a nested panel is open", async () => {
		const { PATCH_CSS } = await loadModule();
		// The portal declares overflow-y:auto, so overflow-x computes to auto and
		// clips the wider, right-anchored .dd-menu on its left overhang. Only
		// `overflow: visible` lifts that, and it must be gated on .dd-menu being in
		// the DOM so a long plain overflow menu keeps scrolling.
		expect(PATCH_CSS).toMatch(/\.plugin-topbar-menu\.portal:has\(\.dd-menu\)\s*\{[^}]*overflow:\s*visible/);
		expect(PATCH_CSS, "an ungated overflow:visible would kill scrolling for long menus").not.toMatch(
			/\.plugin-topbar-menu\.portal\s*\{/,
		);
	});

	it("restores the dropdown trigger the host's unscoped button rule flattens", async () => {
		const { PATCH_CSS } = await loadModule();
		// `.plugin-topbar-menu button` (0,1,1) beats `.chip` (0,1,0), so a host
		// control moved into the menu loses its inline-flex row and its border.
		const rule = /\.plugin-topbar-menu \.dropdown > button\s*\{([^}]*)\}/.exec(PATCH_CSS)?.[1] ?? "";
		expect(rule).toMatch(/display:\s*inline-flex/);
		expect(rule, "width:100% from the host rule has to go").toMatch(/width:\s*auto/);
		expect(rule, "border:0 from the host rule has to go").toMatch(/border:\s*1px solid/);
	});

	it("restores the panel rows, not just the trigger", async () => {
		const { PATCH_CSS } = await loadModule();
		// The same host rule also outranks .dd-item, which misaligns the active
		// item's checkmark. The ellipsis on a long theme name is wanted, so
		// overflow/text-overflow are deliberately not reset.
		const rule = /\.plugin-topbar-menu \.dd-item\s*\{([^}]*)\}/.exec(PATCH_CSS)?.[1] ?? "";
		expect(rule).toMatch(/display:\s*flex/);
		expect(rule).toMatch(/justify-content:\s*space-between/);
		expect(rule).not.toMatch(/text-overflow/);
	});

	it("leaves real overflow menu entries alone", async () => {
		const { PATCH_CSS } = await loadModule();
		// Plugin entries are direct <button role="menuitem"> children of the portal.
		// A bare descendant selector here would re-break exactly what the host rule
		// breaks, in the other direction.
		expect(PATCH_CSS).not.toMatch(/\.plugin-topbar-menu button\s*\{/);
		expect(PATCH_CSS).not.toMatch(/\.plugin-topbar-menu\.portal button\s*\{/);
	});

	it("leaves the top bar's horizontal scrolling alone", async () => {
		const { PATCH_CSS } = await loadModule();
		// .topbar-actions is a second, latent clipper, but its overflow-x:auto is
		// what keeps a narrow window usable. Widening it here would trade a hidden
		// menu for an unreachable top bar.
		expect(PATCH_CSS).not.toMatch(/\.topbar-actions\s*\{[^}]*overflow/);
	});

	it("hides its own tab, which only exists to get the module loaded", async () => {
		const { PATCH_CSS } = await loadModule();
		expect(PATCH_CSS).toContain(manifest.name);
		expect(PATCH_CSS).toMatch(/display:\s*none/);
	});

	it("injects exactly one style element, however often it runs", async () => {
		const { applyPatch, STYLE_ID } = await loadModule();
		const doc = createDocument();

		const undo = applyPatch(doc);
		expect(doc.head.children).toHaveLength(1);
		expect(doc.head.children[0]?.tagName).toBe("style");
		expect(doc.head.children[0]?.id).toBe(STYLE_ID);
		expect(doc.head.children[0]?.textContent).toContain(".view-switch");

		applyPatch(doc);
		applyPatch(doc);
		expect(doc.head.children, "a re-attach must not stack stylesheets").toHaveLength(1);

		undo();
		expect(doc.getElementById(STYLE_ID)).toBeNull();
	});

	it("survives a document that is missing or headless instead of throwing", async () => {
		const { applyPatch } = await loadModule();
		// The host imports this module in a browser, but a stray import elsewhere
		// (SSR, a test, a node tool) must not explode on a missing document.
		expect(() => applyPatch(undefined)()).not.toThrow();
		expect(() => applyPatch({})()).not.toThrow();
	});

	it("explains itself when opened, since the tab only shows if the patch failed", async () => {
		const module = await loadModule();
		const doc = createDocument();
		const container = doc.createElement("div");

		const cleanup = module.default.mount(container, { pluginId: PLUGIN_ID, send: () => {}, onData: () => () => {} });
		expect(visibleText(container)).toContain("162");
		cleanup();
		expect(container.children).toHaveLength(0);
	});
});

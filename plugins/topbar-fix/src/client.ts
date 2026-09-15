/**
 * Stopgap stylesheet for xing-shuyin/pi-web-ui#162.
 *
 * The host renders the top-bar overflow menu (`⋯`, `.plugin-topbar-menu`) inside
 * `.view-switch`. That element carries `overflow: hidden` so its
 * `border-radius: 9px` clips the segmented buttons - and it clips the menu too,
 * which is absolutely positioned and opens below the control. The menu exists in
 * the DOM, validates fine, and is never visible.
 *
 * This module injects the CSS that releases it, and puts the rounded corners
 * back by hand, since that is what the `overflow: hidden` was buying.
 *
 * It runs at import time on purpose: the host eagerly imports client/entry.mjs
 * for every plugin with `hasClient && view !== false` on each client attach, so
 * the patch lands before anyone opens anything. That eagerness is why this
 * plugin keeps a view - and the patch then hides its own tab, which has nothing
 * to show. If the patch ever stops matching the host's markup, the tab comes
 * back and explains itself.
 *
 * `.topbar-actions` is a second, latent clipper of the same subtree, but its
 * horizontal scrolling is what keeps a narrow window usable, so it is left
 * alone: a hidden menu beats an unreachable top bar.
 *
 * Delete this plugin once #162 ships.
 */

export const ISSUE_URL = "https://github.com/xing-shuyin/pi-web-ui/issues/162";
export const STYLE_ID = "pi-web-ui-plugins-topbar-fix";
/** Must match manifest.json "name": the host puts it in the tab's title. */
const PLUGIN_NAME = "Top Bar Fix";

export const PATCH_CSS = `
/* pi-web-ui#162: release the overflow menu from its clipping ancestor. */
.view-switch { overflow: visible; }
/* Put back the corner clipping that overflow:hidden was providing. */
.view-switch > :first-child { border-radius: 8px 0 0 8px; }
.view-switch > :last-child { border-radius: 0 8px 8px 0; }
/* This plugin has nothing to show; it only needs to be loaded. */
.view-switch button.plugin-tab[title^="${PLUGIN_NAME}"] { display: none; }
`;

/** The few DOM members this patch needs, so a non-browser caller (or a test
 *  double) is a type error rather than a crash. */
interface StyleElement {
	id: string;
	textContent: string;
	remove?(): void;
}

interface StyleHost {
	head?: { append?(node: StyleElement): void };
	createElement?(tag: string): StyleElement;
	getElementById?(id: string): StyleElement | null;
}

/** Inject the patch once. Returns a remover; calling it twice is harmless. */
export function applyPatch(doc: unknown): () => void {
	const target = doc as StyleHost | undefined;
	if (!target || typeof target.createElement !== "function" || typeof target.head?.append !== "function") {
		return () => {};
	}
	if (target.getElementById?.(STYLE_ID)) return () => {};
	const style = target.createElement("style");
	style.id = STYLE_ID;
	style.textContent = PATCH_CSS;
	target.head.append(style);
	return () => style.remove?.();
}

// The whole point: patch on import, not on mount.
if (typeof document !== "undefined") applyPatch(document);

/** The narrow browser view contract supplied by pi-web-ui. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

const clientEntry = {
	mount(container: HTMLElement, _ctx: ViewContext): () => void {
		const document = container.ownerDocument;
		const root = document.createElement("section");
		const heading = document.createElement("h1");
		heading.textContent = "Top bar overflow fix";
		const body = document.createElement("p");
		body.textContent =
			"This plugin only injects a stylesheet: the host clips its own top-bar overflow menu inside " +
			".view-switch, so the menu can never be seen. If you are reading this, its tab failed to hide " +
			"itself, which means the patch no longer matches the host markup.";
		const link = document.createElement("a");
		link.href = ISSUE_URL;
		link.target = "_blank";
		link.rel = "noreferrer";
		link.textContent = "Upstream issue 162";
		root.append(heading, body, link);
		container.append(root);
		return () => container.replaceChildren();
	},
};

export default clientEntry;

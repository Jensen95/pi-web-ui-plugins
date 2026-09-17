/**
 * Stopgap stylesheet for two top-bar overflow-menu bugs in pi-web-ui.
 *
 * 1. xing-shuyin/pi-web-ui#162 - the menu is clipped by `.view-switch`.
 * 2. xing-shuyin/pi-web-ui#183 - on 0.87.x the menu is portalled to
 *    `document.body` (which fixed #162) but
 *    now clips and restyles the host controls rendered inside it.
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
 * The second bug: in 0.87.x the menu is `createPortal(<div class="plugin-topbar-menu
 * portal">, document.body)`, and a host control switched off the top bar in
 * Settings (Theme, Language, Sound, Update) is re-rendered inside it as the real
 * host Dropdown - `.dropdown > button.chip` plus an absolutely positioned
 * `.dd-menu`. Two host rules then misfire on it: the portal's `overflow-y: auto`
 * makes overflow-x compute to `auto` as well, which clips the wider `.dd-menu`
 * on its left overhang (the sliced "ANGUAGE"/"HEME" headings), and the unscoped
 * `.plugin-topbar-menu button` rule outranks `.chip` and `.dd-item` and flattens
 * their flex layout.
 *
 * Delete this plugin once both ship upstream.
 */

/** The clipped-by-.view-switch bug: fixed upstream by portalling the menu. */
export const ISSUE_URL = "https://github.com/xing-shuyin/pi-web-ui/issues/162";
/** The portal bug this plugin now mostly exists for: the portalled menu clips
 *  and flattens the host controls rendered inside it. */
export const PORTAL_ISSUE_URL = "https://github.com/xing-shuyin/pi-web-ui/issues/183";
export const STYLE_ID = "pi-web-ui-plugins-topbar-fix";
/** Must match manifest.json "name": the host puts it in the tab's title. */
const PLUGIN_NAME = "Top Bar Fix";

export const PATCH_CSS = `
/* pi-web-ui#162: release the overflow menu from its clipping ancestor. Hosts
   from 0.87 portal the menu to document.body, so .view-switch is no longer an
   ancestor and this is a harmless no-op there - it is kept for older hosts. */
.view-switch { overflow: visible; }
/* Put back the corner clipping that overflow:hidden was providing. */
.view-switch > :first-child { border-radius: 8px 0 0 8px; }
.view-switch > :last-child { border-radius: 0 8px 8px 0; }
/* 0.87.x: the portalled menu declares overflow-y:auto, so per CSS Overflow its
   overflow-x computes to auto too and clips. A nested .dd-menu is right-anchored
   and min-width:340px inside a max-width:320px menu, so it overhangs the LEFT
   edge and is sliced off with no scroll position that can reach it. Only
   overflow:visible lifts the clip (overflow-x alone recomputes back to auto),
   so gate it on a panel actually being open: .dd-menu is in the DOM only while
   its dropdown is open, so a long plain overflow menu keeps its scrolling. */
.plugin-topbar-menu.portal:has(.dd-menu) { overflow: visible; }
/* The host's ".plugin-topbar-menu button" (0,1,1) is unscoped and outranks
   .chip (0,1,0), so a dropdown TRIGGER inside the menu gets display:block,
   width:100% and border:0 - its icon, label and caret stop being a row and the
   box stops fitting them. Restore just the layout, at (0,2,1), with the host's
   own .chip values. The child combinator keeps this off panel items. */
.plugin-topbar-menu .dropdown > button {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	width: auto;
	border: 1px solid var(--border);
	border-radius: 9px;
}
/* The same host rule outranks .dd-item (0,1,0) inside the opened panel, so its
   rows lose flex and space-between and the .dd-item.active:after checkmark
   stops sitting at the right edge. overflow/text-overflow are left alone: the
   ellipsis on a long theme name is wanted. */
.plugin-topbar-menu .dd-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
}
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
			"This plugin only injects a stylesheet: older hosts clip the top-bar overflow menu inside " +
			".view-switch so it can never be seen, and 0.87.x hosts clip and flatten the Theme, Language " +
			"and Sound controls rendered inside the portalled menu. If you are reading this, its tab failed " +
			"to hide itself, which means the patch no longer matches the host markup.";
		const links = document.createElement("p");
		// Index, not childNodes: the host DOM is real, but the unit test drives this
		// with a minimal element stub that has no childNodes.
		const issues = [
			[ISSUE_URL, "Upstream issue 162"],
			[PORTAL_ISSUE_URL, "Upstream issue 183"],
		] as const;
		issues.forEach(([href, text], index) => {
			const link = document.createElement("a");
			link.href = href;
			link.target = "_blank";
			link.rel = "noreferrer";
			link.textContent = text;
			if (index > 0) {
				const gap = document.createElement("span");
				gap.textContent = " · ";
				links.append(gap);
			}
			links.append(link);
		});
		root.append(heading, body, links);
		container.append(root);
		return () => container.replaceChildren();
	},
};

export default clientEntry;

/**
 * manifest "ui" contributions, checked against the host's own normalisation.
 *
 * pi-web-ui 0.86 renders 11 UI slots from `manifest.ui` (issue #146). The host
 * is deliberately forgiving - server/plugins.ts parseUiItem() SKIPS an entry it
 * dislikes rather than failing the install - so a typo costs a menu entry with
 * no error anywhere. These tests re-express the host's rules (the same approach
 * catalog.test.ts takes for catalog entries) and apply them to the real
 * manifests, so a dropped entry fails here instead of silently vanishing.
 *
 * Host facts mirrored from server/plugins.ts:
 *   - UI_SLOTS / UI_SLOT_ALIASES: "topbar.overflow" is a slot, "topbar.more" an
 *     alias for it, "topbar" an alias for "topbar.primary".
 *   - parseUiItem: id must match ID_RE (it is concatenated into `<pluginId>:<id>`
 *     and lands in a DOM data attribute), label is required and trimmed to 60,
 *     icon to 16, kind must be one of UI_KINDS.
 *   - A "view" item with no explicit `view` opens `plugin:<pluginId>`, which is
 *     the same target the plugin's top-bar tab uses.
 *   - The capability gate: strict = permissions.length > 0 || apiVersion >= 2.
 *     In strict mode the ENTIRE ui block is ignored unless some permission's
 *     family (the part before ":") is "ui".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listPlugins } from "../helpers/plugin-contract";
import { repoPath } from "../helpers/repo-files";

/**
 * Plugins that are a settings page and nothing else: configuration surfaces you
 * visit and leave, not views you work inside.
 *
 * They are NOT in the top-bar overflow menu either, for two reasons: an entry in
 * both places is the same plugin listed twice, and the host's overflow menu is
 * currently unreachable anyway - `.plugin-topbar-menu` is `position: absolute`
 * inside `.topbar-actions`, which is a clipping context
 * (`overflow-x: auto; overflow-y: hidden`), so the menu renders and is cut off.
 */
const SETTINGS_PAGE_PLUGINS = ["catalog-sync", "mcp-manager", "ui-shortcuts"];

/**
 * Plugins that legitimately own two surfaces: one work view plus one settings
 * page for configuration local to that work.
 *
 * This is only safe because the host gives the plugin a way to tell them apart -
 * the settings container sits inside `.plugin-page`, work views do not
 * (the ctx is byte-identical on both paths). One screen per surface, never both.
 */
const SPLIT_SURFACE_PLUGINS = ["jira-review", "session-shadow"];

const ID_RE = /^[A-Za-z0-9_-]+$/;
const UI_KINDS = new Set(["view", "action", "badge", "menu", "page", "organizer", "divider"]);
const UI_SLOTS = new Set([
	"topbar.primary",
	"topbar.overflow",
	"bottombar",
	"composer.actions",
	"message.actions",
	"rightpanel.tabs",
	"contextmenu.topbar",
	"contextmenu.message",
	"contextmenu.session",
	"contextmenu.file",
	"settings.pages",
]);
const UI_SLOT_ALIASES: Record<string, string> = {
	topbar: "topbar.primary",
	"topbar.more": "topbar.overflow",
	composer: "composer.actions",
	message: "message.actions",
	rightpanel: "rightpanel.tabs",
	settings: "settings.pages",
};

interface UiItem {
	id?: unknown;
	label?: unknown;
	icon?: unknown;
	kind?: unknown;
	view?: unknown;
	action?: unknown;
}

interface RawManifest {
	id?: string;
	name?: string;
	permissions?: string[];
	apiVersion?: number;
	ui?: Record<string, unknown>;
	topbar?: unknown;
}

function manifestOf(dirName: string): RawManifest {
	return JSON.parse(readFileSync(repoPath("plugins", dirName, "manifest.json"), "utf8")) as RawManifest;
}

/** The host's own gate: would it parse this manifest's ui block at all? */
export function uiBlockIsHonoured(manifest: RawManifest): boolean {
	const permissions = manifest.permissions ?? [];
	const strict = permissions.length > 0 || (manifest.apiVersion ?? 1) >= 2;
	if (!strict) return true;
	return permissions.some((permission) => permission.split(":")[0] === "ui");
}

/** Why the host would drop this item, or undefined when it survives. */
export function rejectionReason(item: UiItem, slot: string): string | undefined {
	const resolved = UI_SLOT_ALIASES[slot] ?? slot;
	if (!UI_SLOTS.has(resolved)) return `unknown slot "${slot}"`;
	if (typeof item.id !== "string" || !ID_RE.test(item.id)) return `id "${String(item.id)}" fails the host id pattern`;
	if (item.id.length > 64) return "id is longer than 64 characters";
	if (typeof item.label !== "string" || item.label.trim() === "") return "label is required";
	if (item.label.length > 60) return "label is truncated at 60 characters";
	if (item.kind !== undefined && (typeof item.kind !== "string" || !UI_KINDS.has(item.kind))) {
		return `unknown kind "${String(item.kind)}"`;
	}
	if (item.icon !== undefined && (typeof item.icon !== "string" || item.icon.length > 16)) {
		return "icon is truncated at 16 characters";
	}
	return undefined;
}

const plugins = listPlugins();

describe("ui contributions", () => {
	it("declares no top-bar overflow entry while the host clips that menu", () => {
		// Re-add these once the overflow menu escapes its clipping ancestor; until
		// then an entry there is invisible, and the same plugin is already a page.
		for (const plugin of plugins) {
			expect(
				manifestOf(plugin.dirName).ui?.["topbar.overflow"],
				`plugins/${plugin.dirName} puts an entry in a menu the host cannot show`,
			).toBeUndefined();
		}
	});

	it("survives the host's item normalisation", () => {
		for (const plugin of plugins) {
			const manifest = manifestOf(plugin.dirName);
			for (const [slot, items] of Object.entries(manifest.ui ?? {})) {
				if (slot === "arrange" || slot === "items") continue;
				for (const item of items as UiItem[]) {
					expect(
						rejectionReason(item, slot),
						`the host would drop plugins/${plugin.dirName} ui.${slot} entry`,
					).toBeUndefined();
				}
			}
		}
	});

	it("declares the ui capability wherever the permission gate is strict", () => {
		for (const plugin of plugins) {
			const manifest = manifestOf(plugin.dirName);
			if (!manifest.ui) continue;
			expect(
				uiBlockIsHonoured(manifest),
				`plugins/${plugin.dirName} declares permissions, so its ui block is ignored without a "ui" permission`,
			).toBe(true);
		}
	});

	it("uses the ui slot framework, not the topbar field 0.86 stopped parsing", () => {
		for (const plugin of plugins) {
			expect(
				manifestOf(plugin.dirName).topbar,
				`plugins/${plugin.dirName} uses the retired top-level topbar`,
			).toBeUndefined();
		}
	});

	it("lists each plugin in exactly one place, unless it splits surfaces on purpose", () => {
		for (const plugin of plugins) {
			const manifest = manifestOf(plugin.dirName) as RawManifest & { view?: unknown };
			const slots = Object.keys(manifest.ui ?? {}).filter((slot) => slot !== "arrange" && slot !== "items");
			const hasTab = manifest.view !== false;
			const allowed = SPLIT_SURFACE_PLUGINS.includes(plugin.dirName) ? 2 : 1;
			expect(
				slots.length + (hasTab ? 1 : 0),
				`plugins/${plugin.dirName} appears in ${slots.join(", ")}${hasTab ? " and the top-bar tabs" : ""}`,
			).toBeLessThanOrEqual(allowed);
		}
	});

	it("gives a split-surface plugin one settings page beside one work view", () => {
		for (const dirName of SPLIT_SURFACE_PLUGINS) {
			const manifest = manifestOf(dirName) as RawManifest & { view?: unknown };
			const pages = manifest.ui?.["settings.pages"];
			expect(Array.isArray(pages), `plugins/${dirName} declares no settings page`).toBe(true);
			// The host cannot tell the plugin WHICH page was opened, so a second one
			// would be indistinguishable from the first.
			expect((pages as UiItem[]).length).toBe(1);
			expect((pages as UiItem[])[0]?.kind).toBe("page");

			const workSlots = Object.entries(manifest.ui ?? {}).filter(
				([slot, items]) => slot !== "settings.pages" && slot !== "arrange" && slot !== "items" && Array.isArray(items),
			);
			const workViews = workSlots.length + (manifest.view === false ? 0 : 1);
			expect(workViews, `plugins/${dirName} needs exactly one work view beside settings`).toBe(1);
		}
	});
});

describe("settings-page-only plugins", () => {
	it("declares one settings page instead of a view", () => {
		for (const dirName of SETTINGS_PAGE_PLUGINS) {
			const manifest = manifestOf(dirName) as RawManifest & { view?: unknown };
			const pages = manifest.ui?.["settings.pages"];
			expect(Array.isArray(pages), `plugins/${dirName} declares no settings.pages entry`).toBe(true);
			expect((pages as UiItem[]).length).toBe(1);
			expect((pages as UiItem[])[0]?.kind).toBe("page");
		}
	});

	it("opts out of the top bar entirely: no tab, no overflow entry", () => {
		for (const dirName of SETTINGS_PAGE_PLUGINS) {
			const manifest = manifestOf(dirName) as RawManifest & { view?: unknown };
			// The host renders a tab for every plugin whose manifest view is not false,
			// and skips preloading its bundle when it is - the page mounts on demand
			// (PluginPage imports client/entry.mjs itself and only needs hasClient).
			expect(manifest.view, `plugins/${dirName} still claims a view`).toBe(false);
			expect(manifest.ui?.["topbar.overflow"]).toBeUndefined();
			expect(manifest.ui?.["topbar.primary"]).toBeUndefined();
		}
	});

	it("still ships a mountable client entry, which is what the page renders", () => {
		for (const dirName of SETTINGS_PAGE_PLUGINS) {
			const plugin = plugins.find((p) => p.dirName === dirName);
			expect(plugin?.hasClientSource, `plugins/${dirName} has no client to mount`).toBe(true);
		}
	});
});

describe("the normalisation rules these tests rely on", () => {
	it("rejects exactly what the host rejects", () => {
		const good = { id: "open", label: "MCP Servers", icon: "🔌", kind: "view" };
		expect(rejectionReason(good, "topbar.overflow")).toBeUndefined();
		expect(rejectionReason(good, "topbar.more"), "topbar.more is an alias").toBeUndefined();

		expect(rejectionReason(good, "topbar.dropdown")).toMatch(/unknown slot/);
		expect(rejectionReason({ ...good, id: "open menu" }, "topbar.overflow")).toMatch(/id pattern/);
		expect(rejectionReason({ ...good, label: "  " }, "topbar.overflow")).toMatch(/label/);
		expect(rejectionReason({ ...good, label: "x".repeat(61) }, "topbar.overflow")).toMatch(/60/);
		expect(rejectionReason({ ...good, kind: "tab" }, "topbar.overflow")).toMatch(/unknown kind/);
		expect(rejectionReason({ ...good, icon: "x".repeat(17) }, "topbar.overflow")).toMatch(/icon/);
	});

	it("models the capability gate on both sides", () => {
		expect(uiBlockIsHonoured({ permissions: [] }), "no permissions means the old permissive mode").toBe(true);
		expect(uiBlockIsHonoured({}), "no permissions key at all").toBe(true);
		expect(uiBlockIsHonoured({ permissions: ["fs"] }), "strict without ui").toBe(false);
		expect(uiBlockIsHonoured({ permissions: ["fs", "ui"] })).toBe(true);
		expect(uiBlockIsHonoured({ permissions: ["ui:topbar"] }), "family is the part before the colon").toBe(true);
		expect(uiBlockIsHonoured({ apiVersion: 2 }), "apiVersion 2 is strict on its own").toBe(false);
	});
});

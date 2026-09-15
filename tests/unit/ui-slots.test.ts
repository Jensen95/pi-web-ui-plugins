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

/** Plugins that belong in the top-bar overflow menu rather than only in a tab:
 *  occasional-use utilities, not things you sit inside while working. */
const OVERFLOW_PLUGINS = ["mcp-manager", "ui-shortcuts"];

/** Plugins that are a settings page and nothing else: too small to deserve a
 *  view of their own. catalog-sync is one button. */
const SETTINGS_PAGE_PLUGINS = ["catalog-sync"];

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

describe("top-bar overflow entries", () => {
	it("puts the occasional-use plugins in the overflow menu", () => {
		for (const dirName of OVERFLOW_PLUGINS) {
			const manifest = manifestOf(dirName);
			const items = manifest.ui?.["topbar.overflow"];
			expect(Array.isArray(items), `plugins/${dirName} declares no topbar.overflow items`).toBe(true);
			expect((items as unknown[]).length).toBe(1);
		}
	});

	it("opens the plugin's own view, the same target as its tab", () => {
		for (const dirName of OVERFLOW_PLUGINS) {
			const manifest = manifestOf(dirName);
			const item = (manifest.ui?.["topbar.overflow"] as UiItem[])[0] as UiItem;
			expect(item.kind, `${dirName} overflow entry must be a view entry`).toBe("view");
			// No explicit view: the host then routes to `plugin:<pluginId>` itself,
			// so the id can never drift away from the plugin it opens.
			expect(item.view).toBeUndefined();
			expect(item.action).toBeUndefined();
			expect(item.label).toBe(manifest.name);
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

	it("adds no overflow entry for the plugins meant to stay out of the menu", () => {
		for (const plugin of plugins) {
			if (OVERFLOW_PLUGINS.includes(plugin.dirName)) continue;
			expect(manifestOf(plugin.dirName).ui?.["topbar.overflow"]).toBeUndefined();
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
			// and skips preloading its bundle when it is - the page mounts on demand.
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

/**
 * plugins/catalog.json is the built-in plugin-marketplace list the pi-web-ui host
 * reads at <pkgRoot>/plugins/catalog.json (server/index.ts:871) and pushes to the
 * browser as the `plugin_catalog` message.
 *
 * These tests assert the observable contract of that file, not its formatting:
 * it parses, it lists exactly the plugins this repo ships, and every entry
 * survives the host's own normalisation rules (server/plugin-catalog.ts:
 * isValidSource + ID_RE + deriveCatalogId). An entry the host would silently drop
 * is a broken catalog even when every field looks present, so the normalisation
 * rules are re-expressed here and applied to the real file.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCjk, formatCjkHits, repoPath } from "../helpers/repo-files";

const CATALOG_REL = "plugins/catalog.json";

/** The twelve plugins this repo ships. legado-web and demo-mailbox are not ported. */
const EXPECTED_IDS = [
	"catalog-sync",
	"db-client",
	"image-toolkit",
	"jira-review",
	"mcp-manager",
	"mermaid",
	"run-trace",
	"topbar-fix",
	"ui-shortcuts",
	"vscode-editor",
	"webmail",
	"worktree-preparer",
].sort();

/** Where every entry must point: this repo, not upstream. */
const REPO_SLUG = "Jensen95/pi-web-ui-plugins";

/** One catalog entry as the host reads it. Extra keys are rejected below. */
interface CatalogEntry {
	id: string;
	name: string;
	icon: string;
	description: string;
	source: string;
	homepage: string;
	[key: string]: unknown;
}

// --- the host's own validation rules, mirrored from server/plugin-catalog.ts ---

/** Valid plugin id, same regex as the host's ID_RE (prevents path traversal). */
const HOST_ID_RE = /^[A-Za-z0-9_-]+$/;

/** host isValidSource(): owner/repo or owner/repo/subpath[#ref], or a full URL. */
function hostAcceptsSource(source: string): boolean {
	if (!source || source.length > 300) return false;
	if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) return false;
	if (/^https?:\/\//.test(source)) return true;
	const spec = source.split("#")[0]!.replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2) return false;
	return !segs.some((s) => s === "." || s === "..");
}

/** host deriveCatalogId(): explicit valid id wins, else the last source segment. */
function hostDerivesId(raw: string | undefined, source: string): string {
	if (raw && HOST_ID_RE.test(raw)) return raw;
	const segs = source.split("#")[0]!.replace(/\/+$/, "").split("/").filter(Boolean);
	const last = segs.length >= 2 ? segs[segs.length - 1]! : (segs[0] ?? "plugin");
	return last.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

function readRaw(): string {
	return readFileSync(repoPath(CATALOG_REL), "utf8");
}

function readCatalog(): CatalogEntry[] {
	return JSON.parse(readRaw()) as CatalogEntry[];
}

describe("plugins/catalog.json", () => {
	it("is valid JSON and a non-empty array", () => {
		const parsed: unknown = JSON.parse(readRaw());
		expect(Array.isArray(parsed), "catalog.json must be a JSON array").toBe(true);
		expect((parsed as unknown[]).length).toBe(EXPECTED_IDS.length);
	});

	it("lists exactly the twelve plugins this repo ships", () => {
		const ids = readCatalog()
			.map((entry) => entry.id)
			.sort();
		expect(ids).toEqual(EXPECTED_IDS);
	});

	it("does not list the plugins that were not ported", () => {
		const ids = readCatalog().map((entry) => entry.id);
		expect(ids).not.toContain("legado-web");
		expect(ids).not.toContain("demo-mailbox");
	});

	it("has unique ids", () => {
		const ids = readCatalog().map((entry) => entry.id);
		expect(new Set(ids).size, `duplicate catalog ids: ${ids.join(", ")}`).toBe(ids.length);
	});

	it("gives every entry a non-empty id, name, icon, description, source and homepage", () => {
		const required = ["id", "name", "icon", "description", "source", "homepage"] as const;
		const problems: string[] = [];
		for (const entry of readCatalog()) {
			for (const key of required) {
				const value = entry[key];
				if (typeof value !== "string" || value.trim() === "") problems.push(`${entry.id ?? "?"}.${key}`);
			}
		}
		expect(problems, `missing or empty fields: ${problems.join(", ")}`).toEqual([]);
	});

	it("carries no key other than the six the host reads", () => {
		const allowed = new Set(["id", "name", "icon", "description", "source", "homepage"]);
		const extra = readCatalog().flatMap((entry) => Object.keys(entry).filter((key) => !allowed.has(key)));
		expect(extra, `unexpected catalog keys: ${extra.join(", ")}`).toEqual([]);
	});

	it("has no descriptionEn key anywhere (English lives in description)", () => {
		// Checked on the raw text too: a descriptionEn key with a null value would
		// still mean the repo kept the two-field upstream convention.
		expect(readRaw()).not.toContain("descriptionEn");
		const keys = readCatalog().flatMap((entry) => Object.keys(entry));
		expect(keys).not.toContain("descriptionEn");
	});

	it("points every source at this repo, in a form the host accepts", () => {
		const problems: string[] = [];
		for (const entry of readCatalog()) {
			if (entry.source !== `${REPO_SLUG}/plugins/${entry.id}`) {
				problems.push(`${entry.id}: source is "${entry.source}"`);
			}
			if (!hostAcceptsSource(entry.source)) problems.push(`${entry.id}: host would reject source "${entry.source}"`);
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("points every homepage at a well-formed URL on this repo's main branch", () => {
		const problems: string[] = [];
		for (const entry of readCatalog()) {
			const expected = `https://github.com/${REPO_SLUG}/tree/main/plugins/${entry.id}`;
			if (entry.homepage !== expected) {
				problems.push(`${entry.id}: homepage is "${entry.homepage}", expected "${expected}"`);
				continue;
			}
			let url: URL;
			try {
				url = new URL(entry.homepage);
			} catch {
				problems.push(`${entry.id}: homepage is not a parseable URL`);
				continue;
			}
			if (url.protocol !== "https:" || url.hostname !== "github.com") {
				problems.push(`${entry.id}: homepage is not an https github.com URL`);
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("references no upstream owner anywhere in the file", () => {
		expect(readRaw()).not.toContain("xing-shuyin");
		expect(readRaw()).not.toContain("xingshuyin");
	});

	it("survives the host's entry normalisation with its id intact", () => {
		// readCatalog()/toEntry() drops an entry whose source is invalid or whose
		// derived id fails ID_RE. A dropped entry never reaches the marketplace UI,
		// so re-run the host's rules over the real file.
		const problems: string[] = [];
		for (const entry of readCatalog()) {
			if (!hostAcceptsSource(entry.source)) {
				problems.push(`${entry.id}: host would drop this entry (invalid source)`);
				continue;
			}
			const derived = hostDerivesId(entry.id, entry.source);
			if (!HOST_ID_RE.test(derived)) problems.push(`${entry.id}: derived id "${derived}" fails the host ID_RE`);
			if (derived !== entry.id) problems.push(`${entry.id}: host would file this under "${derived}"`);
			// The install directory is <dataDir>/plugins/<derived>, so the source
			// subpath has to agree with the id or the plugin lands in the wrong place.
			const subpath = entry.source.split("/").slice(2).join("/");
			if (subpath !== `plugins/${derived}`) {
				problems.push(`${entry.id}: source subpath "${subpath}" does not match plugins/${derived}`);
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("writes a real English sentence in every description", () => {
		const problems: string[] = [];
		for (const entry of readCatalog()) {
			const text = entry.description;
			if (text.length < 30) problems.push(`${entry.id}: description is only ${text.length} chars`);
			if (!text.includes(" ")) problems.push(`${entry.id}: description is a single token`);
			if (!/[A-Za-z]{3}/.test(text)) problems.push(`${entry.id}: description has no English words`);
			// The icon is a top-bar tab glyph, not a label.
			if ([...entry.icon].length > 4) problems.push(`${entry.id}: icon "${entry.icon}" is not a single glyph`);
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("contains zero CJK characters", () => {
		const offenders = formatCjkHits(CATALOG_REL, findCjk(CATALOG_REL), 25);
		expect(offenders, `CJK characters found:\n${offenders.join("\n")}`).toEqual([]);
	});
});

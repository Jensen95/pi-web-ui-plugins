/**
 * Repo file enumeration the way git sees it, plus the CJK scanner the
 * English-only invariant is built on.
 *
 * Using `git ls-files` (rather than a plain walk) is what keeps gitignored build
 * output - plugins/<id>/index.mjs, plugins/<id>/client/entry.mjs and
 * plugins/<id>/client/vendor/ - out of the repo-wide English scan, while
 * listCompiledEntries() adds the two compiled entry points back on purpose so a
 * stale artifact cannot hide behind .gitignore.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in tests/helpers/). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** CJK punctuation + ideographs (base and ext-A) + compatibility ideographs +
 *  fullwidth forms. U+2018-U+201F are deliberately excluded: those are English
 *  smart quotes. This is the class every English-only check in this repo uses. */
export const CJK_CHAR_CLASS = "\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";

/** Non-global so `exec`/`test` carry no lastIndex state between calls. */
export const CJK_RE = new RegExp(`[${CJK_CHAR_CLASS}]`);

/** The same class without fullwidth forms. Compiled client entries inline npm
 *  dependencies, and @codemirror/autocomplete ships a bracket auto-closing table
 *  containing fullwidth brackets as data. scripts/check-english.mjs keeps its own
 *  copy of this rule because it has to run under plain node; see its header for
 *  why the carve-out is safe. */
export const CJK_NO_FULLWIDTH_CHAR_CLASS = "\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
export const CJK_NO_FULLWIDTH_RE = new RegExp(`[${CJK_NO_FULLWIDTH_CHAR_CLASS}]`);

/** A compiled client bundle inlines npm code; everything else is ours alone. */
const INLINES_NPM_DEPS = /^plugins\/[^/]+\/client\/entry\.mjs$/;

/** Which CJK class applies to a repo-relative path. */
export function cjkPatternFor(relPath: string): RegExp {
	return INLINES_NPM_DEPS.test(relPath.split("\\").join("/")) ? CJK_NO_FULLWIDTH_RE : CJK_RE;
}

/** True when git would ignore this path (works for paths that do not exist yet,
 *  since matching is purely pattern-based). */
export function isGitIgnored(relPath: string): boolean {
	try {
		execFileSync("git", ["check-ignore", "-q", relPath], { cwd: REPO_ROOT, stdio: "ignore" });
		return true;
	} catch {
		// git exits 1 when the path is not ignored, and 128 on a real error.
		return false;
	}
}

/** One offending line found by findCjk. */
export interface CjkHit {
	/** 1-based line number. */
	line: number;
	/** 1-based column of the first CJK character on that line. */
	column: number;
	/** The trimmed line text. */
	text: string;
}

/** Absolute path of a repo-relative path. */
export function repoPath(...parts: string[]): string {
	return join(REPO_ROOT, ...parts);
}

/** UI plugin ids: directories under plugins/ with a host manifest. */
export function pluginIds(): string[] {
	const dir = repoPath("plugins");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => {
			const plugin = join(dir, name);
			return statSync(plugin).isDirectory() && existsSync(join(plugin, "manifest.json"));
		})
		.sort();
}

/** True for generated third-party vendor output, which may legitimately hold CJK. */
export function isVendorPath(relPath: string): boolean {
	const normalized = relPath.split("\\").join("/");
	return normalized.startsWith("plugins/") && normalized.includes("/client/vendor/");
}

/**
 * Every file git considers part of the repo: tracked plus untracked-but-not-
 * ignored. Falls back to a walk that honours the same ignore rules when git is
 * unavailable. Paths are repo-relative with forward slashes, sorted.
 */
export function repoFiles(): string[] {
	let files: string[];
	try {
		const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		files = out.split("\0").filter(Boolean);
	} catch {
		files = walk();
	}
	return files
		.filter((file) => existsSync(repoPath(file)))
		.filter((file) => !isVendorPath(file))
		.map((file) => file.split("\\").join("/"))
		.sort();
}

/** Fallback enumeration for a checkout without git. */
function walk(): string[] {
	const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "storage"]);
	const found: string[] = [];
	const step = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) step(full);
			} else if (entry.isFile()) {
				found.push(relative(REPO_ROOT, full));
			}
		}
	};
	step(REPO_ROOT);
	return found;
}

/**
 * The compiled plugin entry points: plugins/<id>/index.mjs and
 * plugins/<id>/client/entry.mjs. These are gitignored build output, so they are
 * NOT in repoFiles(); they are listed separately because they must still be
 * English (a stale hand-written artifact would otherwise be invisible to the
 * scan and still be loaded by the host). Only files that exist are returned.
 */
export function listCompiledEntries(): string[] {
	const entries: string[] = [];
	for (const id of pluginIds()) {
		for (const rel of [`plugins/${id}/index.mjs`, `plugins/${id}/client/entry.mjs`]) {
			if (existsSync(repoPath(rel))) entries.push(rel);
		}
	}
	return entries.sort();
}

/** True when the buffer looks binary (a NUL byte in the leading bytes). */
export function isBinary(content: Buffer): boolean {
	return content.subarray(0, 8192).includes(0);
}

/**
 * Scan one file for CJK characters, one hit per offending line.
 * @param filePath repo-relative or absolute path
 * @param pattern  override the class, e.g. to skip fullwidth forms for a bundle
 *                 that inlines npm dependencies (see scripts/check-english.mjs)
 */
export function findCjk(filePath: string, pattern: RegExp = CJK_RE): CjkHit[] {
	const absolute = filePath.startsWith("/") ? filePath : repoPath(filePath);
	const content = readFileSync(absolute);
	if (isBinary(content)) return [];
	const hits: CjkHit[] = [];
	content
		.toString("utf8")
		.split("\n")
		.forEach((text, index) => {
			const match = pattern.exec(text);
			if (match) hits.push({ line: index + 1, column: match.index + 1, text: text.trim() });
		});
	return hits;
}

/** Format hits as `path:line:col: text`, the shape the gate prints. */
export function formatCjkHits(filePath: string, hits: CjkHit[], limit = 20): string[] {
	const shown = hits.slice(0, limit).map((hit) => `${filePath}:${hit.line}:${hit.column}: ${hit.text}`);
	if (hits.length > limit) shown.push(`${filePath}: ... ${hits.length - limit} more offending lines`);
	return shown;
}

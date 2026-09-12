#!/usr/bin/env node
/**
 * English-only gate. Exits non-zero if any scanned file contains a CJK character.
 *
 * This repo is English-only by decision: every comment, string literal, README,
 * manifest field, test name and generated artifact must be free of CJK. The host
 * picks a plugin description with `locale !== "zh" && descriptionEn ? descriptionEn
 * : description`, so English lives in "description" and no "descriptionEn" key
 * exists here.
 *
 * What gets scanned (always, no flag needed):
 *   1. Every file git reports as tracked or untracked-but-not-ignored
 *      (`git ls-files --cached --others --exclude-standard`). Gitignored build
 *      output is therefore skipped in this pass.
 *   2. Separately, the compiled plugin entries - plugins/<id>/index.mjs and
 *      plugins/<id>/client/entry.mjs. These ARE gitignored, but scanning them
 *      anyway is the point: a stale hand-written Chinese artifact left behind by
 *      an interrupted conversion would otherwise hide from pass 1 and still be
 *      loaded by the host. Missing entries are not an error (a plugin that has
 *      not been built yet simply has nothing to scan).
 *
 * What is never scanned:
 *   - plugins/<id>/client/vendor/ - third-party npm output (mermaid, vis-timeline)
 *     that may legitimately contain CJK we do not control.
 *   - Binary files (detected by a NUL byte in the leading bytes).
 *
 * Character classes:
 *   - Default: [\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]
 *     (CJK punctuation + ideographs + compatibility ideographs + fullwidth forms).
 *     U+2018-U+201F are deliberately NOT included: those are English smart quotes.
 *   - Exception, compiled plugins/<id>/client/entry.mjs only: the fullwidth range
 *     \uff00-\uffef is not flagged, because that bundle inlines npm dependencies
 *     and @codemirror/autocomplete ships a bracket auto-closing table whose data
 *     is a string of paired open/close brackets that ends with the fullwidth
 *     forms U+FF3B U+FF3D U+FF5B U+FF5D. Those are functional characters, not
 *     prose, and cannot be translated away. CJK ideographs and CJK punctuation
 *     are still flagged in that file, and any real Chinese string or comment
 *     necessarily contains ideographs, so a stale Chinese artifact is still
 *     caught. Compiled plugins/<id>/index.mjs keeps npm packages external, so it
 *     inlines no third-party code and is scanned with the full class.
 *
 * Output: one `path:line:col: text` line per offending line (col is the first
 * offending character on that line, 1-based), capped per file so a 1.7MB bundle
 * cannot flood the log, then a total. Exit code 1 if anything was found.
 *
 * Usage:
 *   node scripts/check-english.mjs            # the whole repo (what CI runs)
 *   node scripts/check-english.mjs <path>     # one file or directory, handy while
 *                                             # porting; skips the git/compiled passes
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Full class: CJK punctuation, ideographs, compatibility ideographs, fullwidth forms. */
const CJK_FULL = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** Same class without fullwidth forms, for bundles that inline npm dependencies. */
const CJK_NO_FULLWIDTH = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Offending lines reported per file before the rest is summarised as a count. */
const MAX_LINES_PER_FILE = 50;

/** Compiled client entries inline npm code; everything else is ours alone. */
const INLINES_NPM_DEPS = /^plugins[/\\][^/\\]+[/\\]client[/\\]entry\.mjs$/;

function listGitFiles() {
	const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out.split("\0").filter(Boolean);
}

/** Fallback for a checkout without git: walk the tree, skipping generated/ignored paths. */
function walkFiles() {
	const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "storage"]);
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(full);
			} else if (entry.isFile()) {
				found.push(relative(ROOT, full));
			}
		}
	};
	walk(ROOT);
	return found;
}

/** The gitignored compiled entries, scanned separately so a stale artifact cannot hide. */
function listCompiledEntries() {
	const pluginsDir = join(ROOT, "plugins");
	if (!existsSync(pluginsDir)) return [];
	const entries = [];
	for (const id of readdirSync(pluginsDir)) {
		const dir = join(pluginsDir, id);
		if (!statSync(dir).isDirectory()) continue;
		for (const candidate of [join(dir, "index.mjs"), join(dir, "client", "entry.mjs")]) {
			if (existsSync(candidate)) entries.push(relative(ROOT, candidate));
		}
	}
	return entries;
}

function isBinary(buf) {
	const head = buf.subarray(0, 8192);
	return head.includes(0);
}

function toAbsolute(relPath) {
	return relPath.startsWith("/") ? relPath : join(ROOT, relPath);
}

/** @returns {{line:number, column:number, text:string}[]} */
function findCjk(relPath, pattern) {
	const buf = readFileSync(toAbsolute(relPath));
	if (isBinary(buf)) return [];
	const hits = [];
	const lines = buf.toString("utf8").split("\n");
	lines.forEach((text, i) => {
		const match = pattern.exec(text);
		if (match) hits.push({ line: i + 1, column: match.index + 1, text: text.trim() });
	});
	return hits;
}

function safeListGitFiles() {
	try {
		return listGitFiles();
	} catch {
		return null;
	}
}

/** Every file under an explicitly requested directory. */
function listDirFiles(dir) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listDirFiles(full));
		else found.push(full);
	}
	return found;
}

function collectFiles() {
	const target = process.argv[2];
	if (target === undefined) return new Set([...(safeListGitFiles() ?? walkFiles()), ...listCompiledEntries()]);
	const absolute = toAbsolute(target);
	if (!existsSync(absolute)) {
		console.error(`No such file or directory: ${target}`);
		process.exit(1);
	}
	const paths = statSync(absolute).isDirectory() ? listDirFiles(absolute) : [absolute];
	// Report in-repo files relative to the root; keep anything outside it absolute
	// so toAbsolute() still resolves it.
	return new Set(paths.map((p) => (p.startsWith(`${ROOT}/`) ? relative(ROOT, p) : p)));
}

const files = collectFiles();

let totalHits = 0;
let totalFiles = 0;
let scanned = 0;

for (const relPath of [...files].sort()) {
	// Third-party npm output is out of our control.
	if (relPath.includes("plugins/") && relPath.includes("/client/vendor/")) continue;
	if (!existsSync(toAbsolute(relPath))) continue;

	scanned++;
	const pattern = INLINES_NPM_DEPS.test(relPath) ? CJK_NO_FULLWIDTH : CJK_FULL;
	const hits = findCjk(relPath, pattern);
	if (hits.length === 0) continue;

	totalFiles++;
	totalHits += hits.length;
	for (const hit of hits.slice(0, MAX_LINES_PER_FILE)) {
		const text = hit.text.length > 160 ? `${hit.text.slice(0, 160)}...` : hit.text;
		console.log(`${relPath}:${hit.line}:${hit.column}: ${text}`);
	}
	if (hits.length > MAX_LINES_PER_FILE) {
		console.log(`${relPath}: ... ${hits.length - MAX_LINES_PER_FILE} more offending lines in this file`);
	}
}

if (totalHits > 0) {
	console.error(
		`\nEnglish-only check FAILED: ${totalHits} offending line(s) in ${totalFiles} file(s) ` +
			`(scanned ${scanned} files). This repo must contain zero CJK characters.`,
	);
	process.exit(1);
}

console.log(`English-only check passed: 0 CJK characters in ${scanned} scanned files.`);

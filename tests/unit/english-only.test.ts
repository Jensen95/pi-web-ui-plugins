/**
 * The repo-wide English-only invariant.
 *
 * This is the user's hard requirement: zero CJK characters in any file, in any
 * language - source, comments, JSDoc, string literals, test names, assertion
 * messages, JSON, YAML, README, workflows, build scripts and the compiled output
 * those produce.
 *
 * Two passes keep the compiled-entry check explicit: the repo-wide pass covers
 * committed files, while the compiled-entry pass also checks build output that
 * catalog-sync creates in its temporary checkout.
 *   1. every file git tracks or would track (repoFiles)
 *   2. every compiled plugin entry that exists (listCompiledEntries)
 * Third-party vendor output is the only exclusion.
 *
 * NOTE: while plugins are still being ported from upstream this suite is red on
 * purpose. Do not skip it, narrow it or add exclusions to make it pass - port the
 * file instead. The failure message lists file:line:col for every offender.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CJK_RE,
	cjkPatternFor,
	findCjk,
	formatCjkHits,
	isGitIgnored,
	isVendorPath,
	listCompiledEntries,
	repoFiles,
	repoPath,
} from "../helpers/repo-files";

/** Scan one path and return `file:line:col: text` strings for every offender. */
function offendersIn(relPath: string): string[] {
	return formatCjkHits(relPath, findCjk(relPath, cjkPatternFor(relPath)), 25);
}

describe("English-only invariant", () => {
	it("scans a non-empty set of repo files (the scan is not vacuous)", () => {
		const files = repoFiles();
		// Guards the whole suite: if git or the walk ever returns nothing, every
		// other assertion here would pass without having looked at a single file.
		expect(files.length).toBeGreaterThan(20);
		expect(files).toContain("package.json");
		expect(files).toContain("scripts/check-english.mjs");
		expect(files).toContain("tests/helpers/mock-host.ts");
	});

	it("finds zero CJK characters in every non-ignored repo file", () => {
		const offenders = repoFiles().flatMap(offendersIn);
		expect(offenders, `CJK characters found (translate them):\n${offenders.join("\n")}`).toEqual([]);
	});

	it("finds zero CJK characters in every compiled plugin entry", () => {
		const entries = listCompiledEntries();
		const offenders = entries.flatMap(offendersIn);
		expect(
			offenders,
			`CJK characters found in compiled artifacts (delete the stale file and rebuild from src/*.ts):\n` +
				`${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("excludes only third-party vendor output from the scan", () => {
		expect(repoFiles().filter(isVendorPath)).toEqual([]);
		expect(listCompiledEntries().filter(isVendorPath)).toEqual([]);
		// The exclusion is scoped to generated vendor output, not to whole plugins.
		expect(isVendorPath("plugins/mermaid/client/vendor/mermaid.bundle.mjs")).toBe(true);
		expect(isVendorPath("plugins/mermaid/client/entry.mjs")).toBe(false);
		expect(isVendorPath("plugins/mermaid/src/client.ts")).toBe(false);
		expect(isVendorPath("plugins/mermaid/manifest.json")).toBe(false);
	});

	it("scans compiled entries separately, because every one of them is gitignored", () => {
		// All build output is ignored now that the host rebuilds it on install, so
		// repoFiles() never sees an artifact; listCompiledEntries() is the only way a
		// stale hand-written .mjs would still be scanned.
		const compiled = listCompiledEntries();
		expect(compiled.length, "no compiled entries found - run npm run build first").toBeGreaterThan(0);
		const tracked = repoFiles();
		for (const entry of compiled) {
			expect(isGitIgnored(entry), `${entry} must be build output`).toBe(true);
			expect(tracked, `${entry} must not be part of the repo file pass`).not.toContain(entry);
		}
	});

	it("detects a planted CJK character and reports its line and column", () => {
		// Proves findCjk actually scans: without this, an empty result above could
		// mean "no CJK" or "the scanner never looked".
		const dir = mkdtempSync(join(tmpdir(), "cjk-probe-"));
		const file = join(dir, "probe.ts");
		try {
			writeFileSync(file, "export const a = 1;\nexport const b = 2; // \u4e2d\u6587 note\n", "utf8");
			const hits = findCjk(file);
			expect(hits).toHaveLength(1);
			expect(hits[0]?.line).toBe(2);
			// Column points at the first CJK character, 1-based.
			expect(hits[0]?.column).toBe(24);
			expect(hits[0]?.text).toContain("//");
			expect(formatCjkHits("probe.ts", hits)).toEqual([`probe.ts:2:24: ${hits[0]?.text ?? ""}`]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats English smart quotes as English, not as CJK", () => {
		// U+2018-U+201F are legitimate English typography and are deliberately
		// outside the class; if someone widens CJK_RE this test fails.
		const dir = mkdtempSync(join(tmpdir(), "quote-probe-"));
		const file = join(dir, "probe.md");
		try {
			writeFileSync(file, "the \u2018host\u2019 said \u201cno\u201d \u2014 fine\n", "utf8");
			expect(findCjk(file)).toEqual([]);
			expect(CJK_RE.test("the \u2018host\u2019 said \u201cno\u201d")).toBe(false);
			expect(CJK_RE.test("\u4e2d")).toBe(true);
			expect(CJK_RE.test("\u3002")).toBe(true);
			expect(CJK_RE.test("\uff21")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("narrows the class only for compiled client bundles, and still catches ideographs there", () => {
		expect(cjkPatternFor("plugins/vscode-editor/client/entry.mjs")).not.toBe(CJK_RE);
		expect(cjkPatternFor("plugins/vscode-editor/index.mjs")).toBe(CJK_RE);
		expect(cjkPatternFor("plugins/vscode-editor/src/client.ts")).toBe(CJK_RE);

		const dir = mkdtempSync(join(tmpdir(), "entry-probe-"));
		const file = join(dir, "entry.mjs");
		try {
			// A fullwidth bracket alone is allowed in a client bundle (npm data)...
			writeFileSync(file, 'var definedClosing = "()[]{}\uff3b\uff3d";\n', "utf8");
			expect(findCjk(file, cjkPatternFor("plugins/x/client/entry.mjs"))).toEqual([]);
			// ...but a stale Chinese artifact is still caught, which is the point.
			writeFileSync(file, "/* \u4e2d\u6587 bundle */\nexport default {};\n", "utf8");
			const hits = findCjk(file, cjkPatternFor("plugins/x/client/entry.mjs"));
			expect(hits).toHaveLength(1);
			expect(hits[0]?.line).toBe(1);
			// The same fullwidth character IS flagged in a server entry, which keeps
			// npm packages external and therefore inlines no third-party code.
			writeFileSync(file, 'var x = "\uff3b";\n', "utf8");
			expect(findCjk(file, cjkPatternFor("plugins/x/index.mjs"))).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the repo's own English-only gate script free of CJK", () => {
		// The gate cannot enforce a rule it breaks itself.
		expect(offendersIn("scripts/check-english.mjs")).toEqual([]);
		expect(repoPath("scripts", "check-english.mjs")).toContain("scripts");
	});
});

/**
 * Build smoke test for the vscode-editor CLIENT bundle.
 *
 * The host hardcodes plugins/<id>/client/entry.mjs and serves only the client/
 * subtree over HTTP, so the browser loads that file as bare ESM: it must exist,
 * export a mountable view, carry no npm specifier (nothing can resolve one in a
 * browser) and be English, because its TypeScript source is.
 *
 * This is the only test that can see a misconfigured esbuild step - unit tests
 * against src/ run through vitest's own transform and would keep passing even if
 * the builder produced nothing at all.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "../helpers/plugin-build";
import { importClientArtifact, isClientEntry } from "../helpers/plugin-contract";
import { CJK_CHAR_CLASS, cjkPatternFor, findCjk, formatCjkHits, isGitIgnored } from "../helpers/repo-files";

const PLUGIN_ID = "vscode-editor";
const CLIENT_ARTIFACT = `plugins/${PLUGIN_ID}/client/entry.mjs`;

/** Every character in the wide CJK class, for the bundle-wide sweep below. */
const CJK_RE_G = new RegExp(`[${CJK_CHAR_CLASS}]`, "g");

/** A static `import`/`export ... from` statement at the start of a line. */
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm;

/** Every module specifier the bundle imports or re-exports statically. */
function staticSpecifiers(text: string): string[] {
	STATIC_IMPORT.lastIndex = 0;
	return [...text.matchAll(STATIC_IMPORT)].map((match) => match[1]);
}

/** Specifiers a browser cannot resolve on its own. */
function bareSpecifiers(text: string): string[] {
	return staticSpecifiers(text).filter(
		(spec) => !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:"),
	);
}

const build = buildPlugin(PLUGIN_ID);
const bundle = build.clientEntry ? readFileSync(build.clientEntry, "utf8") : "";

describe("vscode-editor client build", () => {
	it("compiles src/client.ts to the path the browser imports", () => {
		expect(build.ok, `build failed:\n${build.stderr}\n${build.stdout}`).toBe(true);
		expect(build.clientEntry, "client/entry.mjs was not produced").toBeDefined();
		expect(isGitIgnored(CLIENT_ARTIFACT), "catalog-sync builds this artifact before install").toBe(true);
		expect(bundle).toContain(`from plugins/${PLUGIN_ID}/src/client.ts`);
	});

	it("produces a bundle big enough to hold the inlined editor and terminal", () => {
		// CodeMirror + xterm are bundled in; a bundle without them means the
		// dependencies were left external instead of inlined.
		expect(bundle.length).toBeGreaterThan(500_000);
	});

	it("keeps no bare npm specifier in the bundle", () => {
		// Proves the extractor is not vacuously empty before relying on it.
		expect(staticSpecifiers('import x from "react";\nimport "./local.mjs";')).toEqual(["react", "./local.mjs"]);
		expect(bareSpecifiers("import { y } from '@xterm/xterm';")).toEqual(["@xterm/xterm"]);
		expect(bareSpecifiers(bundle)).toEqual([]);
	});

	it("inlines the xterm stylesheet as text so the terminal renders", () => {
		// esbuild's {".css": "text"} loader turns the stylesheet import into a
		// string that mount() injects as a <style> element. Without it the rule
		// text is simply absent from the bundle.
		expect(bundle).toContain(".xterm .xterm-helpers {");
		expect(bundle).toContain("Copyright (c) 2014 The xterm.js authors");
	});

	it("is valid ESM whose default export the frontend loader accepts", async () => {
		expect(build.clientEntry, "client/entry.mjs was not produced").toBeDefined();
		const mod = await importClientArtifact(PLUGIN_ID);
		expect(isClientEntry(mod), "default export is not a mountable view").toBe(true);
		if (!isClientEntry(mod)) return;
		expect(typeof mod.default.mount).toBe("function");
	});

	it("compiles to English", () => {
		// The bundle inlines npm code, so cjkPatternFor() applies this repo's
		// documented carve-out: @codemirror/autocomplete ships fullwidth brackets
		// as data in its bracket-closing table. Our own text may not contain a
		// single character from the full class, which is what this asserts.
		const hits = findCjk(CLIENT_ARTIFACT, cjkPatternFor(CLIENT_ARTIFACT));
		expect(formatCjkHits(CLIENT_ARTIFACT, hits)).toEqual([]);
	});

	it("carries no character from the wider CJK class except the dependency's own brackets", () => {
		// Proves the carve-out above is dependency data and nothing else: the only
		// fullwidth characters in the bundle are the four brackets
		// @codemirror/autocomplete keeps in its bracket-closing table.
		const wide = new Set(bundle.match(CJK_RE_G) ?? []);
		expect([...wide].sort()).toEqual(["\uff3b", "\uff3d", "\uff5b", "\uff5d"]);
	});
});

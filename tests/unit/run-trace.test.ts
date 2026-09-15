/**
 * run-trace packaging: the manifest contract, the English-only invariant for this
 * plugin's own files, and the build smoke test.
 *
 * The build assertions matter more than they look: plugins/<id>/index.mjs and
 * plugins/<id>/client/entry.mjs are gitignored, so a stale hand-written Chinese
 * artifact left behind by the port would be invisible to `git ls-files` and would
 * still be the file the pi-web-ui host loads. Proving the artifact was produced by
 * the shared builder from src/*.ts, that it imports as valid ESM with the right
 * default export, and that the client bundle carries no bare npm specifier is what
 * makes the port provably English rather than accidentally English.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "../helpers/plugin-build";
import {
	importClientArtifact,
	importServerArtifact,
	isClientEntry,
	isServerEntry,
	loadPlugin,
} from "../helpers/plugin-contract";
import { CJK_RE, findCjk, formatCjkHits, isGitIgnored, repoPath } from "../helpers/repo-files";

const ID = "run-trace";
const plugin = loadPlugin(ID);

/** One build for the whole file: it writes the artifacts every later assertion reads. */
const build = buildPlugin(ID);

/** First line of a compiled artifact. */
function firstLineOf(relPath: string): string {
	return readFileSync(repoPath(relPath), "utf8").split("\n")[0] ?? "";
}

/** Every module specifier the client bundle imports, dynamically or statically. */
function importSpecifiers(text: string): string[] {
	const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
	return [...text.matchAll(specifier)].map((match) => match[1] ?? "");
}

/** This plugin's own committed files: manifest, README and every TypeScript source. */
function ownedSources(): string[] {
	const sources = readdirSync(repoPath("plugins", ID, "src"))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `plugins/${ID}/src/${name}`);
	return [`plugins/${ID}/manifest.json`, `plugins/${ID}/README.md`, ...sources].sort();
}

describe("manifest", () => {
	it("parses and keeps the upstream metadata", () => {
		expect(plugin.id).toBe(ID);
		expect(plugin.dirName).toBe(ID);
		expect(plugin.manifest.version).toBe("0.1.0");
		expect(plugin.manifest.icon).toBe("🧭");
	});

	it("is named and described in English", () => {
		expect(plugin.manifest.name).toBe("Run Trace");
		const description = plugin.manifest.description ?? "";
		expect(description.length).toBeGreaterThan(40);
		expect(description).toMatch(/run trajectory/i);
		expect(description).toMatch(/timeline/i);
		expect(findCjk(plugin.manifestPath)).toEqual([]);
	});

	it("carries no descriptionEn key, because this repo has one locale", () => {
		expect(plugin.raw).not.toHaveProperty("descriptionEn");
		expect(plugin.raw).not.toHaveProperty("nameEn");
	});

	it("declares exactly the fields upstream declared - no permissions, no view flag, no renderers", () => {
		expect(Object.keys(plugin.raw).sort()).toEqual(["build", "description", "icon", "id", "name", "version"]);
		expect(plugin.manifest.permissions).toBeUndefined();
		expect(plugin.manifest.view).toBeUndefined();
		expect(plugin.manifest.renderers).toBeUndefined();
	});
});

describe("English-only invariant", () => {
	it("owns a real, non-empty set of source files", () => {
		const files = ownedSources();
		expect(files).toContain(`plugins/${ID}/src/index.ts`);
		expect(files).toContain(`plugins/${ID}/src/client.ts`);
		expect(files.length).toBeGreaterThanOrEqual(4);
		for (const rel of files) {
			expect(readFileSync(repoPath(rel), "utf8").trim().length, `${rel} is empty`).toBeGreaterThan(0);
		}
	});

	it("has no CJK character in any committed file of this plugin", () => {
		const offenders: string[] = [];
		for (const rel of [
			...ownedSources(),
			`tests/unit/run-trace.test.ts`,
			`tests/unit/run-trace-client.test.ts`,
			`tests/unit/run-trace-server.test.ts`,
			`tests/unit/run-trace-trace.test.ts`,
		]) {
			offenders.push(...formatCjkHits(rel, findCjk(rel, CJK_RE)));
		}
		expect(offenders).toEqual([]);
	});

	it("ships no obsolete upstream JavaScript next to the TypeScript sources", () => {
		const strays = readdirSync(repoPath("plugins", ID, "src")).filter((name) => !name.endsWith(".ts"));
		expect(strays).toEqual([]);
		// Upstream shipped no per-plugin build file for this plugin; this repo has one shared builder.
		expect(existsSync(repoPath("plugins", ID, "build.mjs"))).toBe(false);
		expect(existsSync(repoPath("plugins", ID, "package.json"))).toBe(false);
	});
});

describe("README", () => {
	const text = readFileSync(repoPath("plugins", ID, "README.md"), "utf8");

	it("is English prose of a useful length", () => {
		expect(findCjk(`plugins/${ID}/README.md`)).toEqual([]);
		expect(text.length).toBeGreaterThan(800);
		expect(text.startsWith("# ")).toBe(true);
	});

	it("names the plugin and documents where its data comes from", () => {
		expect(text).toMatch(/run-trace/);
		expect(text).toMatch(/Run Trace/);
		expect(text).toMatch(/getActiveConversation/);
		expect(text).toMatch(/onRunEvent/);
	});

	it("documents how to build it", () => {
		expect(text).toMatch(/npm run build/);
	});
});

describe("build", () => {
	it("builds both entries from the TypeScript sources", () => {
		expect(build.stderr, build.stderr).toBe("");
		expect(build.status).toBe(0);
		expect(build.ok).toBe(true);
		expect(build.stdout).toContain(`+ ${ID}: plugins/${ID}/index.mjs`);
		expect(build.stdout).toContain(`+ ${ID}: plugins/${ID}/client/entry.mjs`);
		expect(build.artifacts).toEqual([`plugins/${ID}/index.mjs`, `plugins/${ID}/client/entry.mjs`]);
	});

	it("keeps generated artifacts as build output for catalog-sync", () => {
		expect(firstLineOf(`plugins/${ID}/index.mjs`)).toBe(
			`/* Generated by scripts/build-plugins.mjs from plugins/${ID}/src/index.ts - do not edit. */`,
		);
		expect(firstLineOf(`plugins/${ID}/client/entry.mjs`)).toBe(
			`/* Generated by scripts/build-plugins.mjs from plugins/${ID}/src/client.ts - do not edit. */`,
		);
		expect(isGitIgnored(`plugins/${ID}/index.mjs`)).toBe(true);
		expect(isGitIgnored(`plugins/${ID}/client/entry.mjs`)).toBe(true);
		expect(isGitIgnored(`plugins/${ID}/src/index.ts`)).toBe(false);
		expect(isGitIgnored(`plugins/${ID}/manifest.json`)).toBe(false);
	});

	it("compiles a server entry the host can activate", async () => {
		const mod = await importServerArtifact(ID);
		expect(isServerEntry(mod)).toBe(true);
		if (!isServerEntry(mod)) return;
		expect(typeof mod.default.activate).toBe("function");
		// Upstream exported its pure trace helpers from the server entry; the port keeps that surface.
		expect(typeof (mod as Record<string, unknown>).estTextMs).toBe("function");
		expect(typeof (mod as Record<string, unknown>).extractPaths).toBe("function");
		expect(typeof (mod as Record<string, unknown>).toolHeadline).toBe("function");
	});

	it("compiles a client entry the frontend loader can mount", async () => {
		const mod = await importClientArtifact(ID);
		expect(isClientEntry(mod)).toBe(true);
		if (!isClientEntry(mod)) return;
		expect(typeof mod.default.mount).toBe("function");
		expect(mod.default.renderers).toBeUndefined();
	});

	it("compiles artifacts with no CJK character in them", () => {
		// Full class for both: the client bundle inlines no npm code (vis-timeline is
		// loaded at runtime from client/vendor/), so nothing here is third-party data.
		for (const rel of [`plugins/${ID}/index.mjs`, `plugins/${ID}/client/entry.mjs`]) {
			expect(formatCjkHits(rel, findCjk(rel, CJK_RE)), `${rel} contains CJK`).toEqual([]);
		}
	});

	it("leaves the client bundle self-contained bare ESM", () => {
		const text = readFileSync(repoPath(`plugins/${ID}/client/entry.mjs`), "utf8");
		const specifiers = importSpecifiers(text);
		// Non-vacuous: the three-tier timeline fallback must have survived the build.
		expect(specifiers).toContain("./vendor/vis-timeline.bundle.mjs");
		expect(specifiers).toContain("https://esm.sh/vis-timeline@8.5.4/standalone/esm/vis-timeline-graph2d.min.mjs");
		expect(text).toContain("./vendor/vis-timeline.css");

		const bare = specifiers.filter((s) => !s.startsWith(".") && !s.startsWith("/") && !/^https?:\/\//.test(s));
		expect(bare, "a bare npm specifier cannot be resolved by a browser").toEqual([]);
	});

	it("keeps the server entry free of bundled npm code", () => {
		const text = readFileSync(repoPath(`plugins/${ID}/index.mjs`), "utf8");
		// The server entry has no runtime dependencies at all; anything it imports is
		// its own inlined module or a node builtin.
		expect(importSpecifiers(text)).toEqual([]);
	});
});

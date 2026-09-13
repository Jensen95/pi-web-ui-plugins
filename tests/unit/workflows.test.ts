/**
 * Structural assertions over .github/workflows/*.yml.
 *
 * No YAML parser is in this repo's dependency tree (`yaml` and `js-yaml` are both
 * absent, and adding one just to test two files is not worth a dependency), so
 * these are targeted text checks against the raw file. They assert the things that
 * actually break CI:
 *   - a `run:` step invoking an npm script that does not exist in package.json
 *     (the single most common workflow bug, and invisible until CI goes red)
 *   - step ORDER, because check:english also scans the compiled plugin entries,
 *     so `npm run build` must run first or half the English-only gate is unenforced
 *   - the release workflow's archive verification, since GitHub Release archives
 *     remain an optional supported install path for these plugins
 *
 * YAML validity is checked by shape (required top-level keys, and the indentation
 * of every block the assertions depend on) rather than by a parser.
 *
 * CJK is not checked here: tests/unit/english-only.test.ts already scans every
 * non-ignored repo file, which includes .github/workflows/.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoPath } from "../helpers/repo-files";

const WORKFLOW_DIR = ".github/workflows";

/** Exactly two workflows: CI on every push/PR, Release on a tag. No sharding. */
const EXPECTED_WORKFLOWS = ["ci.yml", "release.yml"];

interface PackageJson {
	scripts?: Record<string, string>;
	engines?: { node?: string };
}

function readPackageJson(): PackageJson {
	return JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as PackageJson;
}

function workflowNames(): string[] {
	return readdirSync(repoPath(WORKFLOW_DIR))
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort();
}

/** Read fresh on every assertion: these files are edited while the suite runs. */
function workflow(name: string): string {
	return readFileSync(repoPath(WORKFLOW_DIR, name), "utf8");
}

/** npm subcommands that are not script invocations, so they need no package.json
 *  entry. `npm test` is deliberately absent: it is an alias for `npm run test`
 *  and must resolve to a real script like any other. */
const NPM_BUILTINS = new Set([
	"ci",
	"install",
	"i",
	"uninstall",
	"ls",
	"exec",
	"cache",
	"audit",
	"dedupe",
	"outdated",
	"publish",
	"pack",
	"prune",
	"update",
	"link",
	"rebuild",
	"fund",
]);

/** Every package.json script a file invokes, via `npm run <s>` or `npm <s>`. */
function npmScriptsInvoked(text: string): string[] {
	return [...text.matchAll(/\bnpm (?:run |run-script )?([A-Za-z0-9_:.-]+)/g)]
		.map((match) => match[1]!)
		.filter((token) => !NPM_BUILTINS.has(token));
}

/** Top-level (column 0) YAML keys, in order. */
function topLevelKeys(text: string): string[] {
	return [...text.matchAll(/^([A-Za-z][\w-]*):/gm)].map((match) => match[1]!);
}

/** Offset of the first occurrence, or -1. Used for step-order assertions. */
function offsetOf(text: string, needle: string): number {
	return text.indexOf(needle);
}

describe("workflow inventory", () => {
	it("ships exactly ci.yml and release.yml", () => {
		expect(workflowNames()).toEqual(EXPECTED_WORKFLOWS);
	});

	it("invokes only npm scripts that exist in the root package.json", () => {
		const scripts = readPackageJson().scripts ?? {};
		const missing = EXPECTED_WORKFLOWS.flatMap((name) =>
			npmScriptsInvoked(workflow(name))
				.filter((script) => !(script in scripts))
				.map((script) => `${name}: npm run ${script}`),
		);
		expect(missing, `workflows call scripts that do not exist:\n${missing.join("\n")}`).toEqual([]);
	});

	it("invokes npm scripts at all, so the check above cannot pass on an empty scan", () => {
		const invoked = EXPECTED_WORKFLOWS.flatMap((name) => npmScriptsInvoked(workflow(name)));
		expect(invoked.length).toBeGreaterThanOrEqual(6);
		expect(invoked).toContain("build");
	});

	it("installs with npm ci against a committed lockfile on a Node that satisfies engines", () => {
		const enginesNode = readPackageJson().engines?.node ?? "";
		const major = Number(enginesNode.match(/\d+/)?.[0]);
		expect(major, `engines.node "${enginesNode}" has no parseable major`).toBeGreaterThanOrEqual(22);
		expect(readFileSync(repoPath("package-lock.json"), "utf8").length).toBeGreaterThan(1000);
		for (const name of EXPECTED_WORKFLOWS) {
			const text = workflow(name);
			expect(text, `${name} must install with npm ci (needs the lockfile)`).toContain("npm ci");
			expect(text, `${name} must pin Node 22`).toMatch(/node-version:\s*22/);
			expect(offsetOf(text, "node-version:")).toBeLessThan(offsetOf(text, "npm ci"));
			expect(offsetOf(text, "actions/checkout@")).toBeLessThan(offsetOf(text, "npm ci"));
		}
	});
});

describe("ci.yml", () => {
	it("declares name, on and jobs at the top level", () => {
		const keys = topLevelKeys(workflow("ci.yml"));
		for (const key of ["name", "on", "jobs"]) expect(keys, `ci.yml is missing top-level "${key}:"`).toContain(key);
	});

	it("triggers on pushes to main and on pull requests", () => {
		const text = workflow("ci.yml");
		expect(text).toMatch(/^\s{2}push:/m);
		expect(text).toMatch(/^\s{4}branches:\s*\[main\]/m);
		expect(text).toMatch(/^\s{2}pull_request:/m);
	});

	it("cancels superseded runs and bounds the job with a timeout", () => {
		const text = workflow("ci.yml");
		expect(text).toMatch(/^\s{2}cancel-in-progress:\s*true/m);
		expect(text).toMatch(/^\s{4}timeout-minutes:\s*\d+/m);
	});

	it("runs every gate: build, format:check, lint, typecheck, check:english, test", () => {
		const invoked = npmScriptsInvoked(workflow("ci.yml"));
		for (const script of ["build", "format:check", "lint", "typecheck", "check:english", "test"]) {
			expect(invoked, `ci.yml never runs "npm run ${script}"`).toContain(script);
		}
	});

	it("builds BEFORE check:english, because the gate also scans compiled entries", () => {
		const text = workflow("ci.yml");
		const build = offsetOf(text, "npm run build");
		const english = offsetOf(text, "npm run check:english");
		expect(build, "ci.yml has no build step").toBeGreaterThan(-1);
		expect(english, "ci.yml has no check:english step").toBeGreaterThan(-1);
		expect(build, "build must precede check:english or the compiled entries go unscanned").toBeLessThan(english);
	});

	it("builds BEFORE test, because the artifact smoke tests import compiled entries", () => {
		const text = workflow("ci.yml");
		const test = offsetOf(text, "npm test");
		expect(test, "ci.yml has no test step").toBeGreaterThan(-1);
		expect(offsetOf(text, "npm run build")).toBeLessThan(test);
	});
});

describe("release.yml", () => {
	it("declares name, on, permissions and jobs at the top level", () => {
		const keys = topLevelKeys(workflow("release.yml"));
		for (const key of ["name", "on", "permissions", "jobs"]) {
			expect(keys, `release.yml is missing top-level "${key}:"`).toContain(key);
		}
	});

	it("triggers on v* tags and on manual dispatch", () => {
		const text = workflow("release.yml");
		expect(text).toMatch(/^\s{4}tags:\s*\["v\*"\]/m);
		expect(text).toMatch(/^\s{2}workflow_dispatch:/m);
	});

	it("grants contents: write so it can create the GitHub Release", () => {
		expect(workflow("release.yml")).toMatch(/^permissions:\s*\n\s{2}contents:\s*write/m);
	});

	it("installs, then builds, then archives - in that order", () => {
		const text = workflow("release.yml");
		const ci = offsetOf(text, "npm ci");
		const build = offsetOf(text, "npm run build");
		const archive = offsetOf(text, "tar -czf");
		expect(ci, "release.yml has no npm ci step").toBeGreaterThan(-1);
		expect(build, "release.yml must build the gitignored entries itself").toBeGreaterThan(-1);
		expect(archive, "release.yml must produce an archive").toBeGreaterThan(-1);
		expect(ci).toBeLessThan(build);
		expect(build, "build must precede archiving or the archive has no entry point").toBeLessThan(archive);
	});

	it("runs the test suite before packaging, since a tag can come from any commit", () => {
		const text = workflow("release.yml");
		const test = offsetOf(text, "npm test");
		expect(test, "release.yml never runs the suite it is about to publish").toBeGreaterThan(-1);
		expect(offsetOf(text, "npm run build")).toBeLessThan(test);
		expect(test, "tests must pass before anything is archived").toBeLessThan(offsetOf(text, "tar -czf"));
	});

	it("packages every plugin directory, manifest and README included", () => {
		const text = workflow("release.yml");
		expect(text, "must iterate the plugin directories").toMatch(/for dir in plugins\/\*\//);
		expect(text).toContain("manifest.json");
		expect(text).toContain("README.md");
	});

	it("verifies each archive holds the manifest and a compiled entry, and fails the job if not", () => {
		const text = workflow("release.yml");
		expect(text, "must list archive contents to verify them").toContain("tar -tzf");
		expect(text, "must require manifest.json in the archive").toMatch(/grep -qx "\.\/manifest\.json"/);
		expect(text, "must require the compiled server entry").toContain("index.mjs");
		expect(text, "must require the compiled client entry").toContain("client/entry.mjs");
		// A verification that cannot fail the job is decoration.
		expect(
			[...text.matchAll(/exit 1/g)].length,
			"archive verification must be able to fail the job",
		).toBeGreaterThanOrEqual(3);
	});

	it("keeps TypeScript sources and node_modules out of the archives", () => {
		const text = workflow("release.yml");
		expect(text, "must reject an archive that contains src/").toMatch(/grep -q "\^\\\.\/src\/"/);
		expect(text, "must reject an archive that contains node_modules").toContain("node_modules");
	});

	it("publishes archives both as workflow artifacts and on a GitHub Release", () => {
		const text = workflow("release.yml");
		expect(text).toContain("actions/upload-artifact@");
		expect(text, "an empty artifact upload must fail, not pass silently").toMatch(/if-no-files-found:\s*error/);
		expect(text, "must attach the archives to the Release").toContain("gh release upload");
		expect(text).toContain("GITHUB_TOKEN");
	});
});

/**
 * The convention-driven build pipeline, verified end to end.
 *
 * These tests invoke the real builder rather than reading its source, so they
 * assert what the pipeline produces: un-converted plugins are skipped instead of
 * crashing the run, the vendor bundles land at the paths the plugins load them
 * from, and nothing the builder writes could ever be committed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactRelPaths, artifactSnapshot, buildPlugin } from "../helpers/plugin-build";
import { listPlugins } from "../helpers/plugin-contract";
import { REPO_ROOT, isGitIgnored, repoPath } from "../helpers/repo-files";

const BUILD_SCRIPTS = ["build-plugins.mjs", "build-mermaid-vendor.mjs", "build-runtrace-vendor.mjs"];

/** Read once: no test adds or removes a plugin directory. */
const plugins = listPlugins();

/** Vendor artifacts the two vendor builds must produce, and a marker each one has
 *  to contain for the bundle to be usable by its plugin. */
const VENDOR_ARTIFACTS = [
	{ path: "plugins/mermaid/client/vendor/mermaid.bundle.mjs", marker: "mermaid" },
	{ path: "plugins/run-trace/client/vendor/vis-timeline.bundle.mjs", marker: "vis-timeline" },
	{ path: "plugins/run-trace/client/vendor/vis-timeline.css", marker: "vis-timeline" },
];

/** Repo-relative paths git reports as added/modified/untracked, one per file. */
function gitStatusPaths(): string[] {
	const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "-z"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return (
		out
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.slice(3).trim())
			// Renames are reported as "old -> new"; keep the new path.
			.map((path) => (path.includes(" -> ") ? (path.split(" -> ")[1] ?? path) : path))
	);
}

function runFullBuild(): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "build-plugins.mjs")], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("build script wiring", () => {
	it("has the shared builder and both vendor build scripts", () => {
		for (const script of BUILD_SCRIPTS) {
			const path = repoPath("scripts", script);
			expect(existsSync(path), `scripts/${script} is missing`).toBe(true);
			expect(statSync(path).size, `scripts/${script} is empty`).toBeGreaterThan(100);
		}
	});

	it("is what the npm scripts actually invoke", () => {
		const pkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts.build).toBe("node scripts/build-plugins.mjs");
		expect(pkg.scripts["check:english"]).toBe("node scripts/check-english.mjs");
		for (const plugin of listPlugins()) {
			expect(pkg.scripts[`build:${plugin.dirName}`]).toBe(`node scripts/build-plugins.mjs ${plugin.dirName}`);
		}
		// The full build is the only entry point; vendor builds run from inside it.
		expect(pkg.scripts.build).not.toContain("build-mermaid-vendor");
		for (const script of BUILD_SCRIPTS) {
			const source = readFileSync(repoPath("scripts", script), "utf8");
			expect(source.length, `${script} has no content`).toBeGreaterThan(100);
		}
		expect(readFileSync(repoPath("scripts", "build-plugins.mjs"), "utf8")).toContain("build-mermaid-vendor.mjs");
		expect(readFileSync(repoPath("scripts", "build-plugins.mjs"), "utf8")).toContain("build-runtrace-vendor.mjs");
	});
});

describe("full build run", () => {
	const portedIds = plugins.filter((p) => p.hasServerSource || p.hasClientSource).map((p) => p.dirName);
	const unportedIds = plugins.filter((p) => !p.hasServerSource && !p.hasClientSource).map((p) => p.dirName);

	it("exits 0 and reports one line per plugin", () => {
		const run = runFullBuild();
		expect(run.status, `build failed:\n${run.stderr}\n${run.stdout}`).toBe(0);
		expect(run.stdout).toContain("Summary:");
		for (const plugin of plugins) {
			expect(run.stdout, `no summary line for ${plugin.dirName}`).toContain(plugin.dirName);
		}
	});

	it("skips plugins that have no src/ yet instead of failing the run", () => {
		const run = runFullBuild();
		expect(run.status).toBe(0);
		for (const id of unportedIds) {
			const line = run.stdout.split("\n").find((l) => l.includes(`${id}:`));
			expect(line, `no line for ${id}`).toBeDefined();
			expect(line).toMatch(/skipped/);
		}
		// The summary count has to agree with what is actually on disk, otherwise the
		// builder is claiming work it did not do.
		const summary = run.stdout.match(/Summary: (\d+) built.*?(\d+) skipped.*?(\d+) failed/s);
		expect(summary, `unparseable summary:\n${run.stdout}`).not.toBeNull();
		expect(Number(summary?.[1])).toBe(portedIds.length);
		expect(Number(summary?.[2])).toBe(unportedIds.length);
		expect(Number(summary?.[3])).toBe(0);
	});

	it("produces both vendor bundles at the paths the plugins load them from", () => {
		runFullBuild();
		for (const artifact of VENDOR_ARTIFACTS) {
			const absolute = repoPath(artifact.path);
			expect(existsSync(absolute), `${artifact.path} was not built`).toBe(true);
			const size = statSync(absolute).size;
			// A truncated or empty bundle would still exist, so check real content.
			expect(size, `${artifact.path} is suspiciously small (${size} bytes)`).toBeGreaterThan(1000);
			expect(readFileSync(absolute, "utf8"), `${artifact.path} missing "${artifact.marker}"`).toContain(
				artifact.marker,
			);
		}
	});

	it("builds vendor bundles that carry no bare npm specifiers", () => {
		runFullBuild();
		// The browser loads these by URL from the served client/ subtree, so a bare
		// import would be an unresolvable request at runtime.
		const bareImport = /(?:^|[\s;}])(?:import|export)[^;\n]*?from\s*["'](?!\.|\/|https?:)[^"']+["']/m;
		for (const artifact of VENDOR_ARTIFACTS.slice(0, 2)) {
			const source = readFileSync(repoPath(artifact.path), "utf8");
			expect(bareImport.test(source), `${artifact.path} still has a bare npm import`).toBe(false);
		}
	});

	it("writes nothing that git would commit", () => {
		runFullBuild();
		// The whole point of gitignoring the artifacts: a build must never dirty the
		// tracked tree, and every path it creates must be ignored.
		const generated = gitStatusPaths().filter(
			(path) =>
				/^plugins\/(?!image-toolkit\/)[^/]+\/index\.mjs$/.test(path) ||
				/^plugins\/(?!image-toolkit\/)[^/]+\/client\/entry\.mjs$/.test(path) ||
				/^plugins\/[^/]+\/client\/vendor\//.test(path),
		);
		expect(generated, `generated artifacts are not gitignored`).toEqual([]);
	});
});

describe("per-plugin build", () => {
	it("builds exactly one plugin when given an id", () => {
		const ported = plugins.filter((p) => p.hasServerSource || p.hasClientSource);
		const target = ported[0] ?? plugins[0];
		if (!target) throw new Error("no plugins found");

		const result = buildPlugin(target.dirName);
		expect(result.ok, `stderr: ${result.stderr}`).toBe(true);
		expect(result.stdout).toContain("Summary:");
		// Other plugins are not mentioned as built or skipped in a single-plugin run.
		for (const other of plugins) {
			if (other.dirName === target.dirName) continue;
			expect(result.stdout, `single-plugin build touched ${other.dirName}`).not.toContain(`${other.dirName}:`);
		}
		// Every artifact it reports is a gitignored generated path.
		for (const artifact of result.artifacts) {
			const trackedInstallArtifact = artifact.startsWith("plugins/image-toolkit/");
			expect(isGitIgnored(artifact), `${artifact} ignore policy`).toBe(!trackedInstallArtifact);
		}
	});

	it("writes only the two documented artifact paths for a plugin", () => {
		for (const plugin of plugins) {
			const { server, client } = artifactRelPaths(plugin.dirName);
			expect(server).toBe(`plugins/${plugin.dirName}/index.mjs`);
			expect(client).toBe(`plugins/${plugin.dirName}/client/entry.mjs`);
			// Those are exactly the filenames the host hardcodes, so they are also
			// image-toolkit is the tracked direct-install exception.
			const trackedInstallArtifact = plugin.dirName === "image-toolkit";
			expect(isGitIgnored(server)).toBe(!trackedInstallArtifact);
			expect(isGitIgnored(client)).toBe(!trackedInstallArtifact);
		}
	});

	it("leaves an un-converted plugin's directory untouched", () => {
		const unported = plugins.filter((p) => !p.hasServerSource && !p.hasClientSource);
		const target = unported[0];
		if (!target) return; // every plugin is ported: the skip path has no input left

		// Upstream's hand-written artifacts still occupy these paths until the port
		// deletes them, so the invariant is "the builder wrote nothing", not "nothing
		// is there".
		const before = artifactSnapshot(target.dirName);
		const result = buildPlugin(target.dirName);
		expect(result.ok, `stderr: ${result.stderr}`).toBe(true);
		expect(artifactSnapshot(target.dirName)).toEqual(before);
	});

	it.skipIf(plugins.every((p) => !p.hasServerSource && !p.hasClientSource))(
		"rebuilds a converted plugin to the same artifact paths",
		() => {
			const target = plugins.filter((p) => p.hasServerSource || p.hasClientSource)[0];
			if (!target) throw new Error("no converted plugin");
			const first = buildPlugin(target.dirName);
			expect(first.ok, `stderr: ${first.stderr}`).toBe(true);
			expect(first.artifacts.length).toBeGreaterThan(0);

			const paths = first.artifacts;
			const second = buildPlugin(target.dirName);
			expect(second.ok, `stderr: ${second.stderr}`).toBe(true);
			// The host hardcodes these filenames, so a rebuild must not move them.
			expect(second.artifacts).toEqual(paths);
			for (const artifact of paths) {
				expect(isGitIgnored(artifact), `${artifact} must be gitignored`).toBe(true);
			}
		},
	);
});

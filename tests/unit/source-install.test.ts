/**
 * Source-only install, the way pi-web-ui >= 0.86 performs it (`install --build`,
 * issue #150).
 *
 * The host copies ONLY the plugin directory into a temp dir (its filter drops
 * .git and node_modules), runs `manifest.build.install`, then
 * `manifest.build.command`, verifies every path in `manifest.build.outputs`
 * exists, and only then replaces the installed plugin. Nothing outside the
 * plugin directory is available - the repo root, its package.json and
 * scripts/build-plugins.mjs are all gone by then.
 *
 * So each manifest carries a standalone build plan, and these tests run that
 * plan the way the host would: copy the directory alone, delete the declared
 * outputs, run the declared command, and require the artifacts to come back.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isClientEntry, isServerEntry, listPlugins } from "../helpers/plugin-contract";
import { repoPath } from "../helpers/repo-files";

/** esbuild flags that mirror scripts/build-plugins.mjs, in CLI form. */
const SERVER_FLAGS = "--bundle --platform=node --format=esm --target=es2022 --packages=external";
const CLIENT_FLAGS =
	"--bundle --platform=browser --format=esm --target=es2022 --loader:.css=text --external:./vendor/*";

const plugins = listPlugins();
const rootPkg = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as {
	devDependencies: Record<string, string>;
};

/** The host's own copy filter (bin/pi-web-ui.mjs PLUGIN_COPY_FILTER). */
const HOST_COPY_FILTER = (path: string): boolean => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path);

interface BuildPlan {
	install: string;
	command: string;
	outputs: string[];
}

function declaredBuild(dirName: string): BuildPlan | undefined {
	const manifest = JSON.parse(readFileSync(repoPath("plugins", dirName, "manifest.json"), "utf8")) as {
		build?: BuildPlan;
	};
	return manifest.build;
}

/** A bare npm specifier, as opposed to a relative path, a node: builtin or the
 *  CDN URL run-trace imports at runtime. */
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*(?:\/.*)?$/;

function importSpecifiers(text: string): string[] {
	return [...text.matchAll(/(?:from|import|import\()\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
	const base = join(fromFile, "..", specifier);
	for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * npm package names the CLIENT bundle inlines, so a standalone build has to
 * install them.
 *
 * Only the graph reachable from src/client.ts counts: the server bundle is built
 * with `--packages=external`, so a server-side dependency (vscode-editor's ssh2)
 * is resolved at runtime by the host's ensureDeps, never at build time.
 */
function importedPackages(dirName: string): string[] {
	const entry = repoPath("plugins", dirName, "src", "client.ts");
	if (!existsSync(entry)) return [];
	const names = new Set<string>();
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || seen.has(file)) continue;
		seen.add(file);
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".")) {
				const resolved = resolveRelative(file, specifier);
				if (resolved) queue.push(resolved);
				continue;
			}
			if (specifier.startsWith("node:") || !PACKAGE_SPECIFIER.test(specifier)) continue;
			const parts = specifier.split("/");
			names.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? ""));
		}
	}
	return [...names].filter(Boolean).sort();
}

/** `name@version`, pinned exactly: a caret is the escape character in cmd.exe,
 *  and the host runs the build command through a shell on every platform. */
function pinned(name: string): string {
	const range = rootPkg.devDependencies[name];
	if (!range) throw new Error(`${name} is imported by a plugin but absent from the root devDependencies`);
	const version = range.replace(/^[\^~]/, "");
	expect(version, `${name} must be pinned without a range operator`).toMatch(/^\d+\.\d+\.\d+/);
	return `${name}@${version}`;
}

/** The build plan the conventions imply for a plugin directory. */
function conventionalBuild(dirName: string): BuildPlan {
	const plugin = plugins.find((p) => p.dirName === dirName);
	if (!plugin) throw new Error(`unknown plugin ${dirName}`);
	const deps = ["esbuild", ...importedPackages(dirName).filter((name) => name !== "esbuild")];
	const steps: string[] = [];
	const outputs: string[] = [];
	if (plugin.hasServerSource) {
		steps.push(`npx --no-install esbuild src/index.ts ${SERVER_FLAGS} --outfile=index.mjs`);
		outputs.push("index.mjs");
	}
	if (plugin.hasClientSource) {
		steps.push(`npx --no-install esbuild src/client.ts ${CLIENT_FLAGS} --outfile=client/entry.mjs`);
		outputs.push("client/entry.mjs");
	}
	return {
		install: `npm install --ignore-scripts --no-audit --no-fund ${deps.map(pinned).join(" ")}`,
		command: steps.join(" && "),
		outputs,
	};
}

const temporaryDirs: string[] = [];
afterAll(() => {
	for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

interface BuildRun {
	status: number | null;
	stderr: string;
	missing: string[];
	dir: string;
}

/**
 * Run a plugin's declared build the way the host does: the plugin directory on
 * its own, declared outputs deleted first so an artifact left over from
 * `npm run build` cannot pass the test for it.
 *
 * `install` is not executed (it would hit the network); the root node_modules is
 * symlinked instead, which is what `npx --no-install` resolves against.
 */
function runDeclaredBuild(dirName: string, mutate?: (dir: string) => void): BuildRun {
	const plan = declaredBuild(dirName);
	if (!plan) throw new Error(`plugins/${dirName}/manifest.json declares no build`);
	const tmp = mkdtempSync(join(tmpdir(), "pwu-source-install-"));
	temporaryDirs.push(tmp);
	const dir = join(tmp, "build");
	cpSync(repoPath("plugins", dirName), dir, { recursive: true, filter: HOST_COPY_FILTER });
	symlinkSync(repoPath("node_modules"), join(dir, "node_modules"), "junction");
	for (const output of plan.outputs) rmSync(join(dir, output), { force: true });
	mutate?.(dir);

	const result = spawnSync(plan.command, {
		cwd: dir,
		shell: true,
		encoding: "utf8",
		timeout: 180_000,
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		status: result.status,
		stderr: result.stderr ?? "",
		missing: plan.outputs.filter((output) => !existsSync(join(dir, output))),
		dir,
	};
}

describe("manifest build declarations", () => {
	it("declares a standalone build for every plugin", () => {
		for (const plugin of plugins) {
			const plan = declaredBuild(plugin.dirName);
			expect(plan, `plugins/${plugin.dirName}/manifest.json needs a "build" block`).toBeDefined();
			expect(typeof plan?.install).toBe("string");
			expect(plan?.command.length).toBeGreaterThan(0);
			expect(plan?.outputs.length).toBeGreaterThan(0);
		}
	});

	it("declares exactly the artifacts its sources produce", () => {
		for (const plugin of plugins) {
			const plan = declaredBuild(plugin.dirName);
			const expected: string[] = [];
			if (plugin.hasServerSource) expected.push("index.mjs");
			if (plugin.hasClientSource) expected.push("client/entry.mjs");
			expect(plan?.outputs, `plugins/${plugin.dirName} outputs`).toEqual(expected);
		}
	});

	it("installs a pinned build dependency for every npm package its sources inline", () => {
		for (const plugin of plugins) {
			const plan = declaredBuild(plugin.dirName);
			expect(plan?.install, `${plugin.dirName} must install esbuild`).toContain(pinned("esbuild"));
			for (const name of importedPackages(plugin.dirName)) {
				expect(plan?.install, `${plugin.dirName} inlines ${name} but never installs it`).toContain(pinned(name));
			}
			// A caret would be swallowed by cmd.exe and silently install another major.
			expect(plan?.install).not.toContain("@^");
		}
	});

	it("never reaches outside the plugin directory the host copies", () => {
		for (const plugin of plugins) {
			const plan = declaredBuild(plugin.dirName);
			expect(plan?.command, `${plugin.dirName} build escapes its directory`).not.toMatch(/\.\.[\\/]/);
			expect(plan?.command, `${plugin.dirName} build uses a repo-root script`).not.toContain("scripts/");
			expect(plan?.install).not.toMatch(/\.\.[\\/]/);
		}
	});

	it("matches the repo build conventions, so the two pipelines cannot drift", () => {
		for (const plugin of plugins) {
			const expected = conventionalBuild(plugin.dirName);
			expect(
				declaredBuild(plugin.dirName),
				`plugins/${plugin.dirName}/manifest.json "build" should be:\n${JSON.stringify(expected, null, 2)}`,
			).toEqual(expected);
		}
	});
});

describe("install --build, run the way the host runs it", () => {
	it("rebuilds a client-only plugin from its directory alone", async () => {
		const run = runDeclaredBuild("catalog-sync");
		expect(run.status, `build failed: ${run.stderr}`).toBe(0);
		expect(run.missing).toEqual([]);

		const module = await import(pathToFileURL(join(run.dir, "client", "entry.mjs")).href);
		expect(isClientEntry(module), "the host would refuse this client entry").toBe(true);
	});

	it("rebuilds a server-and-client plugin from its directory alone", async () => {
		const run = runDeclaredBuild("mcp-manager");
		expect(run.status, `build failed: ${run.stderr}`).toBe(0);
		expect(run.missing).toEqual([]);
		expect(statSync(join(run.dir, "index.mjs")).size).toBeGreaterThan(0);

		const server = await import(pathToFileURL(join(run.dir, "index.mjs")).href);
		expect(isServerEntry(server), "the host would refuse this server entry").toBe(true);
		const client = await import(pathToFileURL(join(run.dir, "client", "entry.mjs")).href);
		expect(isClientEntry(client)).toBe(true);
	});

	it("fails loudly when a declared source is missing, so the host keeps the old install", () => {
		const run = runDeclaredBuild("mcp-manager", (dir) => rmSync(join(dir, "src", "client.ts")));
		expect(run.status).not.toBe(0);
		expect(run.missing).toContain("client/entry.mjs");
	});
});

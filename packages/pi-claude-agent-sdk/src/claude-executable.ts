// Pick a Claude Code CLI that can actually serve the selected model.
// The Agent SDK bundles its own binary (`claudeCodeVersion` in its package.json).
// Some models (Fable 5.1) 400 against an older CLI; when the bundle is below
// the model's minimum we use a current `claude` on PATH, matching what the
// README already told people to set via pathToClaudeCodeExecutable.

import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { minClaudeCodeVersionForModel } from "./models.js";

const require = createRequire(import.meta.url);

export type ClaudeVersion = { major: number; minor: number; patch: number };

export type ClaudeExecutableSource = "configured" | "bundled" | "path";

export type ClaudeExecutableResolution = {
	/** Absolute path for the SDK, or undefined to use the bundled CLI. */
	path?: string;
	source: ClaudeExecutableSource;
	/** Set when no available CLI meets the model's minimum version. */
	error?: string;
};

export type ClaudeExecutableDeps = {
	bundledVersion?: () => ClaudeVersion | undefined;
	findOnPath?: () => string | undefined;
	readVersion?: (executable: string) => ClaudeVersion | undefined;
};

const versionCache = new Map<string, ClaudeVersion | undefined>();

export function parseClaudeVersion(text: string): ClaudeVersion | undefined {
	const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatClaudeVersion(version: ClaudeVersion): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareClaudeVersion(a: ClaudeVersion, b: ClaudeVersion): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function readBundledClaudeCodeVersion(): ClaudeVersion | undefined {
	try {
		// The SDK does not export ./package.json; read the file next to its entry.
		const pkgPath = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { claudeCodeVersion?: string };
		return parseClaudeVersion(pkg.claudeCodeVersion ?? "");
	} catch {
		return undefined;
	}
}

export function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const pathEnv = env.PATH ?? env.Path;
	if (!pathEnv) return undefined;
	const exts = process.platform === "win32"
		? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
		: [""];
	const names = process.platform === "win32" && !exts.some((ext) => name.toUpperCase().endsWith(ext.toUpperCase()))
		? [name, ...exts.map((ext) => name + ext)]
		: [name];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const candidateName of names) {
			const candidate = join(dir, candidateName);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return undefined;
}

export function readClaudeCliVersion(executable: string): ClaudeVersion | undefined {
	if (versionCache.has(executable)) return versionCache.get(executable);
	try {
		const result = spawnSync(executable, ["--version"], {
			encoding: "utf8",
			timeout: 8000,
			env: process.env,
			windowsHide: true,
		});
		const version = parseClaudeVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
		versionCache.set(executable, version);
		return version;
	} catch {
		versionCache.set(executable, undefined);
		return undefined;
	}
}

function tooOldError(modelId: string, min: ClaudeVersion, found: string): string {
	return `${modelId} requires Claude Code ${formatClaudeVersion(min)} or newer (${found}). Install a current claude on PATH, or set provider.pathToClaudeCodeExecutable in ~/.pi/agent/claude-bridge.json.`;
}

export function resolveClaudeCodeExecutable(
	modelId: string,
	configured?: string,
	deps: ClaudeExecutableDeps = {},
): ClaudeExecutableResolution {
	const bundledVersion = deps.bundledVersion ?? readBundledClaudeCodeVersion;
	const findOnPath = deps.findOnPath ?? (() => findExecutableOnPath("claude"));
	const readVersion = deps.readVersion ?? readClaudeCliVersion;
	const minText = minClaudeCodeVersionForModel(modelId);
	const min = minText ? parseClaudeVersion(minText) : undefined;

	if (configured) {
		if (min) {
			const version = readVersion(configured);
			if (version && compareClaudeVersion(version, min) < 0) {
				return {
					source: "configured",
					error: tooOldError(modelId, min, `provider.pathToClaudeCodeExecutable is ${formatClaudeVersion(version)} at ${configured}`),
				};
			}
		}
		return { path: configured, source: "configured" };
	}

	if (!min) return { source: "bundled" };

	const bundled = bundledVersion();
	if (bundled && compareClaudeVersion(bundled, min) >= 0) {
		return { source: "bundled" };
	}

	const pathClaude = findOnPath();
	if (pathClaude) {
		const version = readVersion(pathClaude);
		if (version && compareClaudeVersion(version, min) >= 0) {
			return { path: pathClaude, source: "path" };
		}
	}

	if (bundled) {
		return { source: "bundled", error: tooOldError(modelId, min, `bundled CLI is ${formatClaudeVersion(bundled)}`) };
	}

	// Bundle version unknown and PATH missing/unreadable: let the SDK try.
	return { source: "bundled" };
}

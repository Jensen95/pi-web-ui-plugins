/**
 * Run the shared convention-driven build for one plugin and report what it
 * produced. Safe to call from tests: the build runs in a child process and both
 * streams are captured instead of thrown, so a failure becomes an assertion
 * rather than a crashed suite.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, repoPath } from "./repo-files";

/** Result of a single-plugin build. */
export interface BuildResult {
	/** True when the build script exited 0. */
	ok: boolean;
	pluginId: string;
	/** Exit code (0 on success, 1 on failure, null if the process was signalled). */
	status: number | null;
	stdout: string;
	stderr: string;
	/** Repo-relative paths of the artifacts that exist after the build. */
	artifacts: string[];
	/** Absolute path of plugins/<id>/index.mjs when it exists. */
	serverEntry: string | undefined;
	/** Absolute path of plugins/<id>/client/entry.mjs when it exists. */
	clientEntry: string | undefined;
}

/** Repo-relative artifact paths a plugin can produce. */
export function artifactRelPaths(id: string): { server: string; client: string } {
	return { server: `plugins/${id}/index.mjs`, client: `plugins/${id}/client/entry.mjs` };
}

/** Which of a plugin's artifacts currently exist on disk (repo-relative). */
export function existingArtifacts(id: string): string[] {
	const { server, client } = artifactRelPaths(id);
	return [server, client].filter((rel) => existsSync(repoPath(rel)));
}

/** Size + mtime of every artifact on disk for a plugin, so a test can prove a
 *  build did (or did not) rewrite them. A stale upstream artifact may already
 *  occupy these paths before a plugin is ported, so "nothing was written" cannot
 *  be expressed as "nothing exists". */
export function artifactSnapshot(id: string): string[] {
	return existingArtifacts(id).map((rel) => {
		const stats = statSync(repoPath(rel));
		return `${rel}:${stats.size}:${stats.mtimeMs}`;
	});
}

/**
 * Build one plugin with scripts/build-plugins.mjs.
 * The builder also refreshes that plugin's vendor bundle when it owns one
 * (mermaid, run-trace), matching `npm run build:<id>`.
 */
export function buildPlugin(id: string): BuildResult {
	const script = join(REPO_ROOT, "scripts", "build-plugins.mjs");
	let ok = true;
	let status: number | null = 0;
	let stdout = "";
	let stderr = "";
	try {
		stdout = execFileSync(process.execPath, [script, id], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		ok = false;
		const failure = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
		status = failure.status ?? null;
		stdout = failure.stdout ?? "";
		stderr = failure.stderr ?? failure.message ?? String(err);
	}
	const { server, client } = artifactRelPaths(id);
	return {
		ok,
		pluginId: id,
		status,
		stdout,
		stderr,
		artifacts: existingArtifacts(id),
		serverEntry: existsSync(repoPath(server)) ? repoPath(server) : undefined,
		clientEntry: existsSync(repoPath(client)) ? repoPath(client) : undefined,
	};
}

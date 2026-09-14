import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isGitIgnored, pluginIds, repoPath } from "../helpers/repo-files";

function trackedFiles(): Set<string> {
	return new Set(
		execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: repoPath(), encoding: "utf8" })
			.split("\0")
			.filter(Boolean),
	);
}

describe("direct GitHub install payload", () => {
	it("tracks only the bootstrap entry; catalog-sync builds source-only plugins first", () => {
		const tracked = trackedFiles();
		const client = "plugins/catalog-sync/client/entry.mjs";
		expect(existsSync(repoPath(client))).toBe(true);
		expect(tracked.has(client)).toBe(true);
		expect(isGitIgnored(client)).toBe(false);

		for (const id of pluginIds().filter((id) => id !== "catalog-sync")) {
			for (const artifact of [`plugins/${id}/index.mjs`, `plugins/${id}/client/entry.mjs`]) {
				expect(isGitIgnored(artifact), `${artifact} is build output`).toBe(true);
				expect(tracked.has(artifact), `${artifact} must not be committed`).toBe(false);
			}
		}
	});

	it("does not require vendored browser assets in the direct install payload", () => {
		for (const id of pluginIds().filter((id) => id !== "catalog-sync")) {
			expect(isGitIgnored(`plugins/${id}/client/vendor/anything.bundle.mjs`)).toBe(true);
		}
	});
});

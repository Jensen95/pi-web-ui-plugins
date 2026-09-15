import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
	it("commits no build output at all: the host builds every plugin with install --build", () => {
		const tracked = trackedFiles();

		for (const id of pluginIds()) {
			for (const artifact of [`plugins/${id}/index.mjs`, `plugins/${id}/client/entry.mjs`]) {
				expect(isGitIgnored(artifact), `${artifact} is build output`).toBe(true);
				expect(tracked.has(artifact), `${artifact} must not be committed`).toBe(false);
			}
		}
	});

	it("declares a build in every manifest, so --build has something to run", () => {
		for (const id of pluginIds()) {
			const manifest = JSON.parse(readFileSync(repoPath("plugins", id, "manifest.json"), "utf8")) as {
				build?: { command?: string };
			};
			expect(manifest.build?.command, `plugins/${id} cannot be installed from source`).toBeTruthy();
		}
	});

	it("does not require vendored browser assets in the direct install payload", () => {
		for (const id of pluginIds()) {
			expect(isGitIgnored(`plugins/${id}/client/vendor/anything.bundle.mjs`)).toBe(true);
		}
	});
});

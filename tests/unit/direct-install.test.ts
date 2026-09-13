import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isGitIgnored, pluginIds, repoPath } from "../helpers/repo-files";

function trackedFiles(): Set<string> {
	return new Set(
		execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: repoPath(), encoding: "utf8" })
			.split("\0")
			.filter(Boolean),
	);
}

function filesUnder(rel: string): string[] {
	const root = repoPath(rel);
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = `${dir}/${entry.name}`;
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile()) files.push(full.slice(repoPath().length + 1).replaceAll("\\", "/"));
		}
	};
	visit(root);
	return files.sort();
}

describe("direct GitHub install payload", () => {
	it("tracks every compiled entry required by every catalog plugin", () => {
		const tracked = trackedFiles();
		const missing: string[] = [];
		for (const id of pluginIds()) {
			for (const [source, artifact] of [
				[`plugins/${id}/src/index.ts`, `plugins/${id}/index.mjs`],
				[`plugins/${id}/src/client.ts`, `plugins/${id}/client/entry.mjs`],
			] as const) {
				if (!existsSync(repoPath(source))) continue;
				if (!existsSync(repoPath(artifact))) missing.push(`${artifact} is missing`);
				if (!tracked.has(artifact)) missing.push(`${artifact} is not tracked`);
				if (isGitIgnored(artifact)) missing.push(`${artifact} is gitignored`);
			}
		}
		expect(missing, missing.join("\n")).toEqual([]);
	});

	it("tracks every vendored browser asset required by a plugin", () => {
		const tracked = trackedFiles();
		const vendorFiles = pluginIds().flatMap((id) => filesUnder(`plugins/${id}/client/vendor`));
		expect(vendorFiles.length, "the install payload should include any required vendor assets").toBeGreaterThan(0);
		const missing = vendorFiles.filter((file) => !tracked.has(file) || isGitIgnored(file));
		expect(missing, `vendor assets are not directly installable:\n${missing.join("\n")}`).toEqual([]);
	});
});

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoPath } from "../helpers/repo-files";

const extension = repoPath("plugins", "page-picker", "extension");
const dist = join(extension, "dist");
const release = repoPath("release", "page-picker-extension.zip");
const requiredEntries = ["background.js", "picker.js", "bind.js", "bridge.js", "options.js"];

function run(script: string): void {
	execFileSync(process.execPath, [join(extension, script)], { cwd: repoPath(), stdio: "pipe" });
}

describe("page-picker extension packaging", () => {
	it("builds every MV3 entry point from the extension sources", () => {
		run("build.mjs");
		for (const entry of requiredEntries) {
			const path = join(dist, entry);
			expect(existsSync(path), `missing extension/dist/${entry}`).toBe(true);
			expect(readFileSync(path, "utf8").length, `empty extension/dist/${entry}`).toBeGreaterThan(100);
		}
	});

	it("packs a loadable archive without source files", () => {
		run("build.mjs");
		run("pack.mjs");
		expect(existsSync(release)).toBe(true);
		const listing = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				'import { readFileSync } from "node:fs"; import { readZip } from "./plugins/page-picker/extension/zip.mjs"; process.stdout.write(readZip(new Uint8Array(readFileSync(process.argv[1]))).entries.map(({ name }) => name).join("\\n"));',
				release,
			],
			{ cwd: repoPath(), encoding: "utf8" },
		);
		expect(listing.split("\n")).toEqual(
			expect.arrayContaining(["manifest.json", "options.html", ...requiredEntries.map((entry) => `dist/${entry}`)]),
		);
		expect(listing).not.toMatch(/(^|\n)src\//);
	});
});

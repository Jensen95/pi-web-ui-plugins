import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoPath } from "../helpers/repo-files";

const PLUGIN_IDS = ["db-client", "image-toolkit", "mcp-manager", "mermaid", "run-trace", "vscode-editor", "webmail"];

function read(rel: string): string {
	return readFileSync(repoPath(rel), "utf8");
}

describe("image-toolkit distribution", () => {
	it("ships an English manifest with both host entry points", () => {
		expect(existsSync(repoPath("plugins/image-toolkit/manifest.json"))).toBe(true);
		const manifest = JSON.parse(read("plugins/image-toolkit/manifest.json")) as Record<string, unknown>;
		expect(manifest).toMatchObject({
			id: "image-toolkit",
			name: "Image Toolkit",
			permissions: ["fs", "http", "tools"],
		});
		expect(manifest.description).toEqual(expect.any(String));
		expect(manifest).not.toHaveProperty("descriptionEn");
	});

	it("documents direct installation for every plugin", () => {
		const readme = read("README.md");
		for (const id of PLUGIN_IDS) {
			expect(readme).toContain(`pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/${id}`);
		}
		expect(readme).not.toContain("DOES NOT WORK");
	});

	it("documents adding the repository catalog as a custom catalog", () => {
		const readme = read("README.md");
		expect(readme).toContain("plugin-catalog.json");
		expect(readme).toContain("jq '{entries: .}'");
		expect(readme).toContain("Settings");
	});

	it("configures Dependabot for npm and GitHub Actions", () => {
		const config = read(".github/dependabot.yml");
		expect(config).toContain("package-ecosystem: npm");
		expect(config).toContain("package-ecosystem: github-actions");
		expect(config).toContain("directory: /");
	});
});

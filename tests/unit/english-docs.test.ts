import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CJK_RE, repoPath } from "../helpers/repo-files";

interface Manifest {
	name: string;
	version: string;
	description: string;
	descriptionEn?: unknown;
	icon?: unknown;
	permissions?: unknown;
	view?: unknown;
	renderers?: unknown;
}

const PLUGINS = [
	{
		id: "run-trace",
		name: "Run Trace",
		version: "0.1.0",
		icon: "🧭",
		permissions: undefined,
		view: undefined,
		renderers: undefined,
	},
	{
		id: "webmail",
		name: "Webmail",
		version: "0.2.0",
		icon: undefined,
		permissions: ["net:imap/smtp", "tools"],
		view: undefined,
		renderers: undefined,
	},
	{
		id: "vscode-editor",
		name: "Editor",
		version: "0.3.1",
		icon: undefined,
		// "fs", not the old descriptive "fs:workspace+ssh": the host matches fs capability
		// strings exactly ("fs" / "fs:read" / "fs:write") and denies anything else.
		permissions: ["fs", "net:ssh", "terminal"],
		view: undefined,
		renderers: undefined,
	},
] as const;

function read(relativePath: string): string {
	return readFileSync(repoPath(relativePath), "utf8");
}

describe("English plugin documentation", () => {
	it("contains no CJK characters in exactly the six translated files", () => {
		const files = PLUGINS.flatMap(({ id }) => [`plugins/${id}/README.md`, `plugins/${id}/manifest.json`]);
		const offenders = files.filter((file) => CJK_RE.test(read(file)));
		expect(files).toHaveLength(6);
		expect(offenders).toEqual([]);
	});

	it("uses English manifest descriptions without changing upstream metadata", () => {
		for (const expected of PLUGINS) {
			const manifest = JSON.parse(read(`plugins/${expected.id}/manifest.json`)) as Manifest;
			expect(manifest.name).toBe(expected.name);
			expect(manifest.version).toBe(expected.version);
			expect(manifest.icon).toEqual(expected.icon);
			expect(manifest.permissions).toEqual(expected.permissions);
			expect(manifest.view).toEqual(expected.view);
			expect(manifest.renderers).toEqual(expected.renderers);
			expect(manifest.description).toMatch(/[A-Za-z]/);
			expect(manifest.descriptionEn).toBeUndefined();
		}
	});
});

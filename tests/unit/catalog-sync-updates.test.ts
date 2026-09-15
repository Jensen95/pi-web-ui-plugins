/**
 * catalog-sync update detection.
 *
 * The host already knows how to answer "is there something newer": at install
 * time the CLI writes `.pi-source.json` (the source spec) and `.pi-git-sha`
 * (`git ls-remote <remote> HEAD`, truncated to 12) into each plugin directory,
 * and its own `checkPluginUpdates()` compares that sha against the remote's
 * current HEAD. That check is CLI-only - nothing in the server or the web bundle
 * calls it - so this plugin re-expresses the same comparison and shows it.
 *
 * What it deliberately does NOT do is update anything. `reloadCatalog({install:
 * true})` is the only install path a plugin can reach, and it never passes
 * `--build` (plugin-installer.js buildPluginJobArgs only adds the flag when the
 * job spec carries `build: true`, which the catalog-sync path never sets). For a
 * source-only repository that would replace working plugins with unbuilt source,
 * so detection stops at telling the user the exact command to run.
 */
import { describe, expect, it } from "vitest";
import { importServerArtifact, isServerEntry, loadPlugin } from "../helpers/plugin-contract";
import { buildPlugin } from "../helpers/plugin-build";

const PLUGIN_ID = "catalog-sync";

interface InstalledPlugin {
	id: string;
	source?: string;
	installedSha?: string;
	version?: string;
	name?: string;
}

interface UpdateRow {
	id: string;
	name: string;
	version?: string;
	source?: string;
	installedSha?: string;
	remoteSha?: string;
	status: "update-available" | "current" | "unknown";
	command?: string;
}

interface UpdatesModule {
	remoteOf(source: string): string | undefined;
	buildUpdateRows(installed: InstalledPlugin[], remoteShas: Record<string, string | undefined>): UpdateRow[];
	updateCommand(source: string, id: string): string;
}

async function updatesModule(): Promise<UpdatesModule> {
	return (await importServerArtifact(PLUGIN_ID)) as unknown as UpdatesModule;
}

const REPO = "Jensen95/pi-web-ui-plugins";

describe("catalog-sync server entry", () => {
	it("builds a server half the host can activate", async () => {
		const result = buildPlugin(PLUGIN_ID);
		expect(result.ok, `stderr: ${result.stderr}`).toBe(true);
		const plugin = loadPlugin(PLUGIN_ID);
		expect(plugin.hasServerSource, "update detection needs filesystem access").toBe(true);
		expect(isServerEntry(await importServerArtifact(PLUGIN_ID))).toBe(true);
	});
});

describe("remoteOf", () => {
	it("maps every source spelling to the repository it clones from", async () => {
		const { remoteOf } = await updatesModule();
		// One remote for the whole monorepo: twelve plugins share a single
		// `git ls-remote`, and .pi-git-sha holds that repo's HEAD, not a per-path sha.
		expect(remoteOf(`${REPO}/plugins/webmail`)).toBe(`https://github.com/${REPO}.git`);
		expect(remoteOf(REPO)).toBe(`https://github.com/${REPO}.git`);
		expect(remoteOf(`https://github.com/${REPO}/tree/main/plugins/webmail`)).toBe(`https://github.com/${REPO}.git`);
		expect(remoteOf(`${REPO}/plugins/webmail#v1.2`)).toBe(`https://github.com/${REPO}.git`);
	});

	it("refuses what it cannot resolve instead of guessing a remote", async () => {
		const { remoteOf } = await updatesModule();
		expect(remoteOf("/home/mje/local/plugin")).toBeUndefined();
		expect(remoteOf("")).toBeUndefined();
		expect(remoteOf("not a source")).toBeUndefined();
	});
});

describe("buildUpdateRows", () => {
	const remote = `https://github.com/${REPO}.git`;
	const installed: InstalledPlugin[] = [
		{
			id: "webmail",
			name: "Webmail",
			version: "0.2.0",
			source: `${REPO}/plugins/webmail`,
			installedSha: "aaaaaaaaaaaa",
		},
		{
			id: "mermaid",
			name: "Mermaid",
			version: "1.0.0",
			source: `${REPO}/plugins/mermaid`,
			installedSha: "bbbbbbbbbbbb",
		},
	];

	it("flags a plugin whose remote has moved on", async () => {
		const { buildUpdateRows } = await updatesModule();
		const rows = buildUpdateRows(installed, { [remote]: "bbbbbbbbbbbb" });

		const webmail = rows.find((row) => row.id === "webmail");
		const mermaid = rows.find((row) => row.id === "mermaid");
		expect(webmail?.status).toBe("update-available");
		expect(mermaid?.status, "same sha means nothing to do").toBe("current");
	});

	it("says unknown rather than current when the remote could not be read", async () => {
		const { buildUpdateRows } = await updatesModule();
		// An offline machine must not render twelve reassuring "current" rows.
		const rows = buildUpdateRows(installed, {});
		expect(rows.map((row) => row.status)).toEqual(["unknown", "unknown"]);
	});

	it("says unknown for a plugin installed before the sha marker existed", async () => {
		const { buildUpdateRows } = await updatesModule();
		const rows = buildUpdateRows([{ id: "webmail", name: "Webmail", source: `${REPO}/plugins/webmail` }], {
			[remote]: "bbbbbbbbbbbb",
		});
		expect(rows[0]?.status).toBe("unknown");
	});

	it("says unknown for a plugin installed from a local directory", async () => {
		const { buildUpdateRows } = await updatesModule();
		const rows = buildUpdateRows(
			[{ id: "local", name: "Local", source: "/home/mje/dev/plugin", installedSha: "aaaaaaaaaaaa" }],
			{ [remote]: "bbbbbbbbbbbb" },
		);
		expect(rows[0]?.status).toBe("unknown");
	});

	it("gives every row the exact command that updates it, with --build", async () => {
		const { buildUpdateRows } = await updatesModule();
		const rows = buildUpdateRows(installed, { [remote]: "cccccccccccc" });
		for (const row of rows) {
			// --build is the whole point: a plain install leaves a source-only plugin
			// with no compiled entries, and --force is what makes it an update.
			expect(row.command).toContain("--build");
			expect(row.command).toContain("--force");
			expect(row.command).toContain(`plugins/${row.id}`);
		}
	});

	it("keeps the rows stable and named, so the view can render them directly", async () => {
		const { buildUpdateRows } = await updatesModule();
		const rows = buildUpdateRows(installed, { [remote]: "cccccccccccc" });
		expect(rows.map((row) => row.id)).toEqual(["mermaid", "webmail"]);
		expect(rows.every((row) => typeof row.name === "string" && row.name.length > 0)).toBe(true);
	});

	it("survives an empty plugins directory", async () => {
		const { buildUpdateRows } = await updatesModule();
		expect(buildUpdateRows([], { [remote]: "cccccccccccc" })).toEqual([]);
	});
});

describe("updateCommand", () => {
	it("quotes nothing it does not have to, and targets the plugin's own source", async () => {
		const { updateCommand } = await updatesModule();
		expect(updateCommand(`${REPO}/plugins/webmail`, "webmail")).toBe(
			`pi-web-ui install ${REPO}/plugins/webmail --name webmail --build --force`,
		);
	});
});

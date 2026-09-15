/**
 * Update detection for the plugins installed from this repository.
 *
 * The host already knows how to answer "is there something newer", it just never
 * shows it: `pi-web-ui install` writes `.pi-source.json` (the source spec) and
 * `.pi-git-sha` (`git ls-remote <remote> HEAD`, first 12 chars) into every
 * installed plugin directory, and the CLI's own `checkPluginUpdates()` compares
 * that sha against the remote's current HEAD. Nothing in the server or the web
 * bundle calls it. This server half runs the same comparison and hands the view
 * a row per plugin.
 *
 * It stops at detection on purpose. The only install path a plugin can reach is
 * `host.reloadCatalog(source, { install: true })`, and that never passes
 * `--build`: `buildPluginJobArgs` adds the flag only when the job spec carries
 * `build: true`, which the catalog-sync path never sets. On a source-only
 * repository that would replace working plugins with unbuilt source - strictly
 * worse than doing nothing - so each row carries the exact command instead.
 *
 * The sha is the repository HEAD, not a per-plugin path sha, so one commit marks
 * every plugin from this repo as updatable. That is the host's own notion of
 * "outdated" and staying consistent with it beats inventing a second one.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A plugin directory under <dataDir>/plugins, as the CLI left it. */
export interface InstalledPlugin {
	id: string;
	name?: string;
	version?: string;
	/** From .pi-source.json, e.g. "Jensen95/pi-web-ui-plugins/plugins/webmail". */
	source?: string;
	/** From .pi-git-sha: the remote HEAD at install time. */
	installedSha?: string;
}

export type UpdateStatus = "update-available" | "current" | "unknown";

export interface UpdateRow {
	id: string;
	name: string;
	version?: string;
	source?: string;
	installedSha?: string;
	remoteSha?: string;
	status: UpdateStatus;
	command?: string;
}

/** `owner/repo` at the front of a source spec, ignoring any subdirectory, branch
 *  suffix or github.com/tree/... spelling. Undefined for a local path. */
export function remoteOf(source: string): string | undefined {
	const spec = (source ?? "").trim().split("#")[0] ?? "";
	if (!spec || spec.startsWith("/") || spec.startsWith(".")) return undefined;
	const path = spec
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/^git@github\.com:/i, "")
		.replace(/\.git$/i, "");
	const [owner, repo] = path.split("/");
	if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
	return `https://github.com/${owner}/${repo}.git`;
}

/** The command that updates one plugin: --build because the source ships no
 *  artifacts, --force because the directory already exists. */
export function updateCommand(source: string, id: string): string {
	return `pi-web-ui install ${source} --name ${id} --build --force`;
}

/** Compare each installed plugin against the HEAD sha of its remote. */
export function buildUpdateRows(
	installed: InstalledPlugin[],
	remoteShas: Record<string, string | undefined>,
): UpdateRow[] {
	return [...installed]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((plugin): UpdateRow => {
			const remote = plugin.source ? remoteOf(plugin.source) : undefined;
			const remoteSha = remote ? remoteShas[remote] : undefined;
			// Unknown beats a reassuring "current": no marker, no remote, or an
			// unreachable network all mean we simply do not know.
			const status: UpdateStatus =
				!plugin.installedSha || !remoteSha
					? "unknown"
					: plugin.installedSha === remoteSha
						? "current"
						: "update-available";
			return {
				id: plugin.id,
				name: plugin.name ?? plugin.id,
				...(plugin.version ? { version: plugin.version } : {}),
				...(plugin.source ? { source: plugin.source } : {}),
				...(plugin.installedSha ? { installedSha: plugin.installedSha } : {}),
				...(remoteSha ? { remoteSha } : {}),
				status,
				...(plugin.source ? { command: updateCommand(plugin.source, plugin.id) } : {}),
			};
		});
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Read <dataDir>/plugins/*: manifest for the name, plus the CLI's markers. */
export function readInstalledPlugins(pluginsDir: string): InstalledPlugin[] {
	let names: string[];
	try {
		names = readdirSync(pluginsDir);
	} catch {
		return [];
	}
	const found: InstalledPlugin[] = [];
	for (const id of names) {
		const dir = join(pluginsDir, id);
		const manifest = readJson(join(dir, "manifest.json"));
		if (!manifest) continue;
		const marker = readJson(join(dir, ".pi-source.json"));
		const shaFile = join(dir, ".pi-git-sha");
		found.push({
			id,
			name: typeof manifest.name === "string" ? manifest.name : id,
			...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
			...(typeof marker?.source === "string" ? { source: marker.source } : {}),
			...(existsSync(shaFile) ? { installedSha: readFileSync(shaFile, "utf8").trim() } : {}),
		});
	}
	return found;
}

/** `git ls-remote <remote> HEAD`, truncated the way the CLI truncates it. */
function headSha(remote: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["ls-remote", remote, "HEAD"], { timeout: 20_000 }, (error, stdout) => {
			const sha = /^([0-9a-f]{40})\b/i.exec((stdout ?? "").trim())?.[1];
			resolve(error || !sha ? undefined : sha.slice(0, 12));
		});
	});
}

/** One lookup per distinct remote: the whole monorepo is a single clone. */
export async function resolveRemoteShas(installed: InstalledPlugin[]): Promise<Record<string, string | undefined>> {
	const remotes = [...new Set(installed.map((p) => (p.source ? remoteOf(p.source) : undefined)).filter(Boolean))];
	const pairs = await Promise.all((remotes as string[]).map(async (r) => [r, await headSha(r)] as const));
	return Object.fromEntries(pairs);
}

interface ServerHost {
	dataDir: string;
	sendTo(clientId: string, payload: unknown): void;
	broadcast(payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
}

export default {
	activate(host: ServerHost): () => void {
		const off = host.onMessage((payload, from) => {
			const message = payload as { action?: unknown };
			if (message?.action !== "check_updates") return;
			void (async () => {
				const installed = readInstalledPlugins(join(host.dataDir, "plugins"));
				const rows = buildUpdateRows(installed, await resolveRemoteShas(installed));
				const response = { kind: "updates", rows };
				if (from) host.sendTo(from, response);
				else host.broadcast(response);
			})();
		});
		return () => off();
	},
};

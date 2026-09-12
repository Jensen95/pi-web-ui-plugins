/**
 * Load a plugin directory the way the pi-web-ui host does, and import its
 * compiled artifacts, so a test can prove the TypeScript -> .mjs pipeline yields
 * a plugin the host would actually accept.
 *
 * Host facts this mirrors (server/plugins.ts, web/src/plugin-loader.ts):
 *   - The plugin id defaults to the directory name when manifest.json has no "id"
 *     (webmail relies on that).
 *   - The server entry is only activated when plugins/<id>/index.mjs exists, and
 *     it is imported as a file URL with a `?e=<epoch>` query to defeat Node's
 *     module cache. importServerArtifact() does the same.
 *   - hasClient is `existsSync(plugins/<id>/client/entry.mjs)`; the browser
 *     imports that URL with the same `?e=` cache buster.
 *   - Only the client/ subtree is served over HTTP, so a client bundle must be
 *     self-contained bare ESM with no npm specifiers left in it.
 *
 * Caveats worth knowing when a smoke test imports an artifact:
 *   - A server artifact keeps npm packages external, so it may only import node
 *     builtins at top level. Runtime drivers are loaded through createRequire
 *     after host.ensureDeps(). A top-level npm import makes the import fail with
 *     MODULE_NOT_FOUND, which is the contract check working as intended.
 *   - A client artifact is browser code. Importing it under vitest's "node"
 *     environment only evaluates its module top level, so it must not touch
 *     document/window until mount() runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginClientEntry, PluginServerEntry } from "./mock-host";
import { REPO_ROOT, pluginIds, repoPath } from "./repo-files";

/** manifest.json fields the host reads. This repo is English-only, so
 *  "descriptionEn" is deliberately absent from the type: English goes in
 *  "description" and no manifest may carry a descriptionEn key. Use `raw` when a
 *  test needs to assert that. */
export interface PluginManifest {
	id?: string;
	name: string;
	version?: string;
	description?: string;
	icon?: string;
	permissions?: string[];
	/** False for renderer-only plugins, so the frontend does not eagerly load them. */
	view?: boolean;
	/** Fenced-code languages this plugin renders. */
	renderers?: string[];
	settings?: unknown[];
	apiVersion?: number;
}

export interface LoadedPlugin {
	/** manifest.id, or the directory name when the manifest omits it. */
	id: string;
	/** Directory name under plugins/. */
	dirName: string;
	/** Absolute plugin directory. */
	dir: string;
	/** Absolute path to manifest.json. */
	manifestPath: string;
	manifest: PluginManifest;
	/** manifest.json exactly as parsed, for assertions about absent keys. */
	raw: Record<string, unknown>;
	/** plugins/<id>/src/index.ts exists. */
	hasServerSource: boolean;
	/** plugins/<id>/src/client.ts exists. */
	hasClientSource: boolean;
	/** plugins/<id>/index.mjs exists (built). */
	hasServerArtifact: boolean;
	/** plugins/<id>/client/entry.mjs exists (built). */
	hasClientArtifact: boolean;
}

/** Read and validate one plugin directory. Throws when it is missing or its
 *  manifest is absent/unparseable/nameless. */
export function loadPlugin(dirName: string): LoadedPlugin {
	const dir = repoPath("plugins", dirName);
	if (!existsSync(dir)) throw new Error(`no such plugin directory: plugins/${dirName}`);
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) throw new Error(`plugins/${dirName}/manifest.json is missing`);

	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`plugins/${dirName}/manifest.json is not valid JSON: ${(err as Error).message}`);
	}
	if (typeof raw.name !== "string" || raw.name.trim() === "") {
		throw new Error(`plugins/${dirName}/manifest.json has no usable "name"`);
	}

	const manifest = raw as unknown as PluginManifest;
	const id = typeof manifest.id === "string" && manifest.id !== "" ? manifest.id : dirName;
	return {
		id,
		dirName,
		dir,
		manifestPath,
		manifest,
		raw,
		hasServerSource: existsSync(join(dir, "src", "index.ts")),
		hasClientSource: existsSync(join(dir, "src", "client.ts")),
		hasServerArtifact: existsSync(join(dir, "index.mjs")),
		hasClientArtifact: existsSync(join(dir, "client", "entry.mjs")),
	};
}

/** Every plugin directory under plugins/, sorted by directory name. */
export function listPlugins(): LoadedPlugin[] {
	return pluginIds().map(loadPlugin);
}

/** Monotonic cache buster, mirroring the host's epoch counter. */
let epoch = 0;

function importArtifact(relPath: string): Promise<unknown> {
	const absolute = join(REPO_ROOT, relPath);
	if (!existsSync(absolute)) throw new Error(`${relPath} does not exist - run npm run build first`);
	epoch += 1;
	return import(pathToFileURL(absolute).href + `?e=${epoch}`);
}

/** Import plugins/<id>/index.mjs (the server entry the host activates). */
export function importServerArtifact(id: string): Promise<unknown> {
	return importArtifact(`plugins/${id}/index.mjs`);
}

/** Import plugins/<id>/client/entry.mjs (the bundle the browser loads). */
export function importClientArtifact(id: string): Promise<unknown> {
	return importArtifact(`plugins/${id}/client/entry.mjs`);
}

/** True when a module's default export is a server entry the host can activate. */
export function isServerEntry(mod: unknown): mod is { default: PluginServerEntry } {
	const entry = (mod as { default?: unknown })?.default;
	return typeof entry === "object" && entry !== null && typeof (entry as PluginServerEntry).activate === "function";
}

/** True when a module's default export is a view (mount) or a fence renderer
 *  plugin (renderers), which is what the frontend loader requires. */
export function isClientEntry(mod: unknown): mod is { default: PluginClientEntry } {
	const entry = (mod as { default?: unknown })?.default;
	if (typeof entry !== "object" || entry === null) return false;
	const view = entry as PluginClientEntry;
	return typeof view.mount === "function" || (typeof view.renderers === "object" && view.renderers !== null);
}

/** Repo-relative paths of a plugin's compiled artifacts that exist. */
export function artifactPaths(plugin: LoadedPlugin): string[] {
	const paths: string[] = [];
	if (plugin.hasServerArtifact) paths.push(`plugins/${plugin.dirName}/index.mjs`);
	if (plugin.hasClientArtifact) paths.push(`plugins/${plugin.dirName}/client/entry.mjs`);
	return paths;
}

/**
 * MCP config discovery, precedence resolution and the write path.
 *
 * This module is the whole contract between the plugin and pi-mcp-adapter's
 * config files. It implements no MCP protocol, no OAuth and no server
 * launching: it reads the six JSON config layers the adapter already reads,
 * resolves them the same way, and writes ONLY the project Pi override
 * (`.pi/mcp.json`) - never the file a server definition came from, and never a
 * credential copied out of one.
 *
 * Every function takes the filesystem roots explicitly ({@link McpRoots}) so the
 * logic is testable against a temp directory and never reaches for os.homedir()
 * or process.cwd() on its own. The server entry builds the real roots.
 *
 * Layer order, labels, ids, the `mcp-servers` spelling, `disabled === true`
 * semantics and the "enable removes the flag unless a lower layer is disabled"
 * rule all mirror pi-mcp-adapter (config.ts, types.ts). Precedence is lowest
 * first, so the last layer that defines a server wins.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Config source ids, matching pi-mcp-adapter's own ConfigSourceSpec ids. */
export type McpLayerId =
	"shared-global" | "agents-global" | "agents-nested-global" | "pi-global" | "shared-project" | "pi-project";

/** Filesystem roots every config path is derived from. Injected, never global. */
export interface McpRoots {
	/** Stands in for os.homedir(). */
	home: string;
	/** Stands in for the pi agent directory, e.g. ~/.pi/agent. */
	agentDir: string;
	/** Stands in for the live project working directory. */
	projectDir: string;
}

/** One config file in the precedence chain. */
export interface McpConfigLayer {
	id: McpLayerId;
	label: string;
	path: string;
	scope: "global" | "project";
	/** A Pi-owned file rather than a tool-agnostic shared one. */
	piOwned: boolean;
	/** This plugin may write it. Only the project Pi override qualifies. */
	writable: boolean;
}

/**
 * A server definition. The named fields are the ones this plugin displays or
 * redacts; the index signature keeps every other adapter field (lifecycle,
 * directTools, oauth, includeTools, ...) intact when a file is rewritten.
 */
export interface McpServerEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	bearerToken?: string;
	bearerTokenEnv?: string;
	disabled?: boolean;
	[key: string]: unknown;
}

/** Why a config file could not be used. */
export interface ConfigFileError {
	/** "EACCES", "invalid-json", ... */
	code: string;
	message: string;
}

/** One layer as read from disk. */
export interface LayerState {
	layer: McpConfigLayer;
	exists: boolean;
	/** Empty when the file is missing, unreadable or malformed. */
	servers: Record<string, McpServerEntry>;
	/** Present when the file exists but could not be read or parsed. */
	error?: ConfigFileError;
}

/** A server after the precedence merge. */
export interface EffectiveServer {
	name: string;
	/** Merged definition, unredacted - never send this to a browser as-is. */
	entry: McpServerEntry;
	/** Highest-precedence layer that defines it: where it "came from". */
	source: McpConfigLayer;
	/** Every layer that defines it, lowest precedence first. */
	layers: McpLayerId[];
	disabled: boolean;
}

export type WriteFailureCode = "read-failed" | "invalid-config" | "invalid-name" | "invalid-entry" | "write-failed";

/** Outcome of a write. Failures are values, never exceptions. */
export type WriteResult =
	{ ok: true; path: string; changed: boolean } | { ok: false; path: string; code: WriteFailureCode; message: string };

type WriteFailure = Extract<WriteResult, { ok: false }>;

/** What a browser receives: the same view, with credential values masked. */
export interface ClientLayer extends McpConfigLayer {
	exists: boolean;
	serverCount: number;
	error?: ConfigFileError;
}

export interface ClientServer {
	name: string;
	entry: McpServerEntry;
	disabled: boolean;
	source: McpConfigLayer;
	layers: McpLayerId[];
}

export interface ClientState {
	layers: ClientLayer[];
	servers: ClientServer[];
	/** Absolute path of the only file this plugin ever writes. */
	projectOverridePath: string;
}

/**
 * Downstream wire payloads. They live here because this is the only module both
 * the server entry and the browser view may import (the view imports it as types
 * alone, so nothing from node:fs can reach the client bundle).
 */
export interface StateMessage {
	type: "state";
	state: ClientState;
}

export interface ErrorMessage {
	type: "error";
	/** The upstream action this is the answer to, "" when there was none. */
	action: string;
	code: string;
	message: string;
}

export type ServerMessage = StateMessage | ErrorMessage;

/** The value a masked secret is replaced with. */
export const REDACTED = "***";

/** Object keys that would hit a prototype accessor instead of becoming data. */
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Fields that belong to the stdio transport only. */
const STDIO_FIELDS = ["command", "args", "env", "cwd", "inheritEnv", "literalEnv", "pluginDataDir"] as const;

/** Fields that belong to the HTTP transport only. */
const HTTP_FIELDS = [
	"url",
	"headers",
	"caFile",
	"auth",
	"bearerToken",
	"bearerTokenEnv",
	"bearerTokenStore",
	"requestHeadersCommand",
	"httpTransport",
] as const;

/** Credential material bound to the url that supplied it. */
const URL_BOUND_FIELDS = [
	"headers",
	"caFile",
	"bearerToken",
	"bearerTokenEnv",
	"bearerTokenStore",
	"requestHeadersCommand",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
	return isRecord(err) && typeof err.message === "string" ? err.message : String(err);
}

function codeOf(err: unknown, fallback: string): string {
	return isRecord(err) && typeof err.code === "string" ? err.code : fallback;
}

function fail(path: string, code: WriteFailureCode, message: string): WriteFailure {
	return { ok: false, path, code, message };
}

/** The six config layers, lowest precedence first (pi-mcp-adapter's order). */
export function configLayers(roots: McpRoots): McpConfigLayer[] {
	return [
		{
			id: "shared-global",
			label: "user-global standard MCP",
			path: join(roots.home, ".config", "mcp", "mcp.json"),
			scope: "global",
			piOwned: false,
			writable: false,
		},
		{
			id: "agents-global",
			label: "user-global .agents MCP",
			path: join(roots.home, ".agents", "mcp.json"),
			scope: "global",
			piOwned: false,
			writable: false,
		},
		{
			id: "agents-nested-global",
			label: "user-global .agents nested MCP",
			path: join(roots.home, ".agents", "mcp", "mcp.json"),
			scope: "global",
			piOwned: false,
			writable: false,
		},
		{
			id: "pi-global",
			label: "Pi global override",
			path: join(roots.agentDir, "mcp.json"),
			scope: "global",
			piOwned: true,
			writable: false,
		},
		{
			id: "shared-project",
			label: "project standard MCP",
			path: join(roots.projectDir, ".mcp.json"),
			scope: "project",
			piOwned: false,
			writable: false,
		},
		{
			id: "pi-project",
			label: "project Pi override",
			path: join(roots.projectDir, ".pi", "mcp.json"),
			scope: "project",
			piOwned: true,
			writable: true,
		},
	];
}

/** The project Pi override: the highest-precedence layer and the only writable one. */
export function projectOverridePath(roots: McpRoots): string {
	return join(roots.projectDir, ".pi", "mcp.json");
}

/** Parse one document's server map, accepting both `mcpServers` and `mcp-servers`. */
function serversOf(parsed: unknown): Record<string, McpServerEntry> {
	if (!isRecord(parsed)) return {};
	const raw = parsed.mcpServers ?? parsed["mcp-servers"];
	if (!isRecord(raw)) return {};
	// Object.fromEntries, not assignment: a server literally named "__proto__"
	// has to stay an own data property instead of hitting the prototype setter.
	return Object.fromEntries(Object.entries(raw).filter(([, entry]) => isRecord(entry))) as Record<
		string,
		McpServerEntry
	>;
}

function readLayer(layer: McpConfigLayer): LayerState {
	if (!existsSync(layer.path)) return { layer, exists: false, servers: {} };
	let text: string;
	try {
		text = readFileSync(layer.path, "utf8");
	} catch (err) {
		return {
			layer,
			exists: true,
			servers: {},
			error: { code: codeOf(err, "read-failed"), message: `cannot read ${layer.path}: ${messageOf(err)}` },
		};
	}
	try {
		return { layer, exists: true, servers: serversOf(JSON.parse(text)) };
	} catch (err) {
		return {
			layer,
			exists: true,
			servers: {},
			error: { code: "invalid-json", message: `invalid JSON in ${layer.path}: ${messageOf(err)}` },
		};
	}
}

/** Read every layer. A file that cannot be used is reported, never thrown. */
export function readLayers(roots: McpRoots): LayerState[] {
	return configLayers(roots).map(readLayer);
}

/**
 * Merge a higher-precedence definition over a lower one, field by field.
 *
 * pi-mcp-adapter drops the fields of a transport a definition no longer uses,
 * and drops url-bound credentials when the url changes, so that a resolved
 * server never carries one endpoint's secrets to another. The same rule is
 * applied here or the definition this plugin shows would describe a server the
 * adapter never launches.
 */
function mergeEntry(base: McpServerEntry, next: McpServerEntry): McpServerEntry {
	const merged: McpServerEntry = { ...base };
	const toHttp = typeof next.url === "string" && typeof merged.command === "string";
	const toStdio = typeof next.command === "string" && typeof merged.url === "string";
	const dropped = toHttp ? STDIO_FIELDS : toStdio ? HTTP_FIELDS : [];
	for (const field of dropped) delete merged[field];
	if (typeof next.url === "string" && typeof merged.url === "string" && next.url !== merged.url) {
		for (const field of URL_BOUND_FIELDS) delete merged[field];
	}
	return { ...merged, ...next };
}

/** Resolve already-read layers into the effective server list, sorted by name. */
export function resolveServers(states: LayerState[]): EffectiveServer[] {
	const merged = new Map<string, { entry: McpServerEntry; source: McpConfigLayer; layers: McpLayerId[] }>();
	for (const state of states) {
		for (const [name, entry] of Object.entries(state.servers)) {
			const previous = merged.get(name);
			merged.set(
				name,
				previous
					? {
							entry: mergeEntry(previous.entry, entry),
							source: state.layer,
							layers: [...previous.layers, state.layer.id],
						}
					: { entry: { ...entry }, source: state.layer, layers: [state.layer.id] },
			);
		}
	}
	return [...merged]
		.map(([name, value]) => ({
			name,
			entry: value.entry,
			source: value.source,
			layers: value.layers,
			disabled: value.entry.disabled === true,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

/** Read every layer and resolve the effective servers. */
export function listServers(roots: McpRoots): EffectiveServer[] {
	return resolveServers(readLayers(roots));
}

/** The project override as parsed for writing, plus which key spelling it uses. */
interface ProjectDoc {
	existed: boolean;
	raw: Record<string, unknown>;
	serverKey: "mcpServers" | "mcp-servers";
	servers: Record<string, unknown>;
}

type DocRead = { ok: true; doc: ProjectDoc } | { ok: false; result: WriteFailure };

/** Read `.pi/mcp.json` for a write. Anything unusable is a typed failure, so a
 *  hand-edited or corrupt file is never overwritten. */
function readProjectDoc(path: string): DocRead {
	if (!existsSync(path)) {
		return { ok: true, doc: { existed: false, raw: {}, serverKey: "mcpServers", servers: {} } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		// A JSON syntax error carries no errno code; a read error does.
		const reason = codeOf(err, "") === "" ? `invalid JSON (${messageOf(err)})` : messageOf(err);
		return { ok: false, result: fail(path, "read-failed", `cannot use ${path}: ${reason}`) };
	}
	if (!isRecord(parsed)) {
		return { ok: false, result: fail(path, "invalid-config", `${path} must contain a JSON object`) };
	}
	const serverKey: ProjectDoc["serverKey"] =
		parsed.mcpServers === undefined && parsed["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
	const existing = parsed[serverKey];
	if (existing !== undefined && !isRecord(existing)) {
		return { ok: false, result: fail(path, "invalid-config", `${serverKey} in ${path} must be an object`) };
	}
	return {
		ok: true,
		doc: {
			existed: true,
			raw: parsed,
			serverKey,
			servers: { ...(existing as Record<string, unknown> | undefined) },
		},
	};
}

/** Write the document back atomically: a half-written mcp.json would stop every
 *  configured MCP server from loading. */
function writeProjectDoc(path: string, raw: Record<string, unknown>): WriteResult {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return { ok: true, path, changed: true };
	} catch (err) {
		return fail(path, "write-failed", `cannot write ${path}: ${messageOf(err)}`);
	}
}

/**
 * Read `.pi/mcp.json`, let `mutate` change its server map in place, and write it
 * back only when something actually changed. Top-level keys (imports, settings)
 * and every other server entry are preserved, and no other layer is opened for
 * writing.
 */
function mutateProjectConfig(
	roots: McpRoots,
	mutate: (servers: Record<string, unknown>) => WriteFailure | undefined,
): WriteResult {
	const path = projectOverridePath(roots);
	const read = readProjectDoc(path);
	if (!read.ok) return read.result;

	const { doc } = read;
	const before = JSON.stringify(doc.raw);
	const failure = mutate(doc.servers);
	if (failure) return failure;
	if (!doc.existed && Object.keys(doc.servers).length === 0) return { ok: true, path, changed: false };

	doc.raw[doc.serverKey] = doc.servers;
	if (JSON.stringify(doc.raw) === before) return { ok: true, path, changed: false };
	return writeProjectDoc(path, doc.raw);
}

/** A name that can safely become an object key in a config file. */
function validName(name: unknown): name is string {
	return typeof name === "string" && name.trim() !== "" && !UNSAFE_NAMES.has(name);
}

function invalidName(path: string, name: unknown): WriteFailure {
	return fail(path, "invalid-name", `"${typeof name === "string" ? name : String(name)}" is not a usable server name`);
}

/**
 * Enable or disable a server by persisting ONLY the `disabled` field into the
 * project Pi override - the same contract `/mcp enable|disable` implements.
 *
 * Disabling writes `{ "disabled": true }`. Enabling removes the project flag,
 * unless a lower layer is itself disabled, in which case an explicit `false` is
 * written to override it. Sibling fields of an existing override entry survive.
 * The layer the definition came from is never rewritten.
 */
export function setServerDisabled(roots: McpRoots, name: string, disabled: boolean): WriteResult {
	const path = projectOverridePath(roots);
	if (!validName(name)) return invalidName(path, name);

	// Enabling has to know whether a lower layer is disabled; disabling does not
	// read anything but the override file itself.
	const lowerDisabled =
		disabled ||
		resolveServers(readLayers(roots).filter((state) => state.layer.id !== "pi-project")).find(
			(server) => server.name === name,
		)?.disabled === true;

	return mutateProjectConfig(roots, (servers) => {
		const previous = servers[name];
		if (previous !== undefined && !isRecord(previous)) {
			return fail(path, "invalid-config", `server "${name}" in ${path} must be an object`);
		}
		const existing = previous as Record<string, unknown> | undefined;
		let next: Record<string, unknown>;
		if (disabled) {
			next = { ...existing, disabled: true };
		} else {
			next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
			if (lowerDisabled) next.disabled = false;
		}
		if (Object.keys(next).length === 0) delete servers[name];
		else servers[name] = next;
		return undefined;
	});
}

/**
 * Add or replace a server in the project Pi override. Only what the caller
 * supplies is written: no definition and no credential is ever copied out of
 * another layer.
 */
export function addServer(roots: McpRoots, name: string, entry: McpServerEntry): WriteResult {
	const path = projectOverridePath(roots);
	if (!validName(name)) return invalidName(path, name);
	const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
	const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
	if (!hasCommand && !hasUrl) {
		return fail(path, "invalid-entry", `server "${name}" needs a non-empty command or url`);
	}
	return mutateProjectConfig(roots, (servers) => {
		servers[name] = { ...entry };
		return undefined;
	});
}

/**
 * Remove a server from the project Pi override. A server defined in a lower
 * layer cannot be removed from here (that file is never written); it reports
 * `changed: false` and the caller should offer disabling it instead.
 */
export function removeServer(roots: McpRoots, name: string): WriteResult {
	const path = projectOverridePath(roots);
	if (!validName(name)) return invalidName(path, name);
	return mutateProjectConfig(roots, (servers) => {
		delete servers[name];
		return undefined;
	});
}

function maskValues(record: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(Object.keys(record).map((key) => [key, REDACTED]));
}

/**
 * Mask every credential VALUE in a definition, keeping the keys so the UI can
 * still show which variables or headers are configured. Env values, HTTP header
 * values, bearer tokens and OAuth client secrets never reach a browser.
 */
export function redactEntry(entry: McpServerEntry): McpServerEntry {
	const redacted: McpServerEntry = { ...entry };
	if (isRecord(redacted.env)) redacted.env = maskValues(redacted.env);
	if (isRecord(redacted.headers)) redacted.headers = maskValues(redacted.headers);
	if (typeof redacted.bearerToken === "string") redacted.bearerToken = REDACTED;
	const oauth = redacted.oauth;
	if (isRecord(oauth) && typeof oauth.clientSecret === "string") {
		redacted.oauth = { ...oauth, clientSecret: REDACTED };
	}
	return redacted;
}

/** Everything the browser view needs, in one redacted payload. */
export function toClientState(roots: McpRoots): ClientState {
	const states = readLayers(roots);
	return {
		layers: states.map((state) => ({
			...state.layer,
			exists: state.exists,
			serverCount: Object.keys(state.servers).length,
			...(state.error ? { error: state.error } : {}),
		})),
		servers: resolveServers(states).map((server) => ({ ...server, entry: redactEntry(server.entry) })),
		projectOverridePath: projectOverridePath(roots),
	};
}

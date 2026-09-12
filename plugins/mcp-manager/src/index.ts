/**
 * mcp-manager server entry.
 *
 * A thin bridge: it turns the browser view's messages into calls on config.ts
 * and replies with the redacted state. No MCP protocol client, no OAuth, no
 * server launching - pi-mcp-adapter does all of that. This plugin only reads the
 * config layers the adapter reads and writes the one project Pi override file it
 * is allowed to write.
 *
 * Message protocol (upstream from the view, one payload per action):
 *   { action: "list" }                                  -> { type: "state", state }
 *   { action: "toggle", name, disabled? }               -> state, or { type: "error", ... }
 *   { action: "add", name, entry }                      -> state, or { type: "error", ... }
 *   { action: "remove", name }                          -> state, or { type: "error", ... }
 *   anything else                                       -> { type: "error", code: "unknown-action" }
 * A reply goes to the sending client when the host gives a client id, and is
 * broadcast otherwise. `disabled` is only false when the payload says false, so
 * a toggle without the flag disables.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ErrorMessage, McpRoots, McpServerEntry, ServerMessage, WriteResult } from "./config.ts";
import { addServer, removeServer, setServerDisabled, toClientState } from "./config.ts";

/** The slice of the pi-web-ui plugin host this entry uses. Declared locally
 *  because a plugin bundle cannot import the host's own types. */
export interface PluginHost {
	/** Live workspace root; moves when the user switches project. */
	cwd: string;
	broadcast(payload: unknown): void;
	sendTo(clientId: string, payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
}

/** What a compiled index.mjs must look like to the host. */
export interface PluginEntry {
	activate(host: PluginHost): () => void;
}

/**
 * The pi agent directory: `$PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
 * ponytail: pi-mcp-adapter also follows a rebranded host (PI_PACKAGE_DIR ->
 * piConfig.name -> <NAME>_CODING_AGENT_DIR, plus piConfig.configDir for the
 * project `.pi` directory name). Add that if a rebranded distribution shows up.
 */
function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

/** Real roots: the developer's home, the pi agent directory and the live project. */
export function defaultRoots(host: Pick<PluginHost, "cwd">): McpRoots {
	return { home: homedir(), agentDir: agentDir(), projectDir: host.cwd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Browser input arrives untyped; config.ts rejects whatever is not usable. */
function asName(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asEntry(value: unknown): McpServerEntry | undefined {
	return isRecord(value) ? (value as McpServerEntry) : undefined;
}

function errorMessage(action: string, code: string, message: string): ErrorMessage {
	return { type: "error", action, code, message };
}

/** A successful write replies with fresh state, a failed one with the reason. */
function reply(action: string, result: WriteResult, roots: McpRoots): ServerMessage {
	if (result.ok) return { type: "state", state: toClientState(roots) };
	return errorMessage(action, result.code, result.message);
}

function handle(payload: unknown, roots: McpRoots): ServerMessage {
	const message = isRecord(payload) ? payload : {};
	const action = typeof message.action === "string" ? message.action : "";
	switch (action) {
		case "list":
			return { type: "state", state: toClientState(roots) };
		case "toggle":
			return reply(action, setServerDisabled(roots, asName(message.name), message.disabled !== false), roots);
		case "add": {
			const entry = asEntry(message.entry);
			if (!entry) {
				return errorMessage(action, "invalid-entry", "a server definition object is required");
			}
			return reply(action, addServer(roots, asName(message.name), entry), roots);
		}
		case "remove":
			return reply(action, removeServer(roots, asName(message.name)), roots);
		default:
			return errorMessage(action, "unknown-action", action === "" ? "missing action" : `unknown action "${action}"`);
	}
}

/**
 * Build the plugin entry. `resolveRoots` is injectable so tests can point the
 * plugin at a temp directory; it is called per message, which is what makes the
 * view follow a project switch without re-activating.
 */
export function createEntry(resolveRoots: (host: PluginHost) => McpRoots = defaultRoots): PluginEntry {
	return {
		activate(host: PluginHost) {
			return host.onMessage((payload, from) => {
				const response = handle(payload, resolveRoots(host));
				if (from) host.sendTo(from, response);
				else host.broadcast(response);
			});
		},
	};
}

export default createEntry();

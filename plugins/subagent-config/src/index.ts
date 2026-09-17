/**
 * subagent-config server entry.
 *
 * A thin bridge: it turns the settings page's messages into calls on agents.ts,
 * settings.ts and models.ts, and replies with the whole state. It never imports
 * @tintinweb/pi-subagents, never spawns an agent and never touches the pi event
 * bus - it only reads and writes the files that extension reads.
 *
 * Message protocol (upstream from the view, one payload per action):
 *   { action: "list" }                                               -> { type: "state", state }
 *   { action: "saveAgent", layer, file, frontmatter, body? }         -> state, or error
 *   { action: "deleteAgent", layer, file }                           -> state, or error
 *   { action: "saveSettings", scope, values }                        -> state, or error
 *   { action: "checkModel", pin }                                    -> { type: "model", verdict }
 *   anything else                                                    -> { type: "error", code: "unknown-action" }
 * A reply goes to the sending client when the host gives a client id, and is
 * broadcast otherwise. Roots are resolved per message, so the page follows a
 * project switch with no re-activation.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentsState } from "./agents.ts";
import { AGENT_FIELDS, deleteAgentFile, readAgentsState, saveAgentFile } from "./agents.ts";
import type { ModelOption, ModelVerdict, SubagentRoots } from "./models.ts";
import { readModels, resolveModelPin } from "./models.ts";
import type { SettingsState, WriteResult } from "./settings.ts";
import { effectiveValue, readSettingsState, saveSettings } from "./settings.ts";

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

/** Everything the settings page renders, in one payload. */
export interface ClientState {
	roots: SubagentRoots;
	agents: AgentsState;
	/** The editable frontmatter fields, so the view does not hardcode them. */
	agentFields: typeof AGENT_FIELDS;
	settings: SettingsState;
	models: ModelOption[];
	modelsPath: string;
	modelsError?: { code: string; message: string };
	/**
	 * Effective `worktreeIsolation`. When false, every `isolation: worktree` is
	 * silently dropped project-wide (pi-subagents dist/agent-manager.js).
	 */
	worktreeIsolation: boolean;
	/**
	 * Whether pi-subagents reports running agents right now, or undefined when
	 * the extension is not active in this process. Undefined is not a fault: the
	 * symbol comes and goes as pi-web-ui creates and releases session runtimes.
	 */
	subagentsRunning?: boolean;
}

export interface StateMessage {
	type: "state";
	state: ClientState;
}

export interface ModelMessage {
	type: "model";
	verdict: ModelVerdict;
}

export interface ErrorMessage {
	type: "error";
	/** The upstream action this answers, "" when there was none. */
	action: string;
	code: string;
	message: string;
}

export type ServerMessage = StateMessage | ModelMessage | ErrorMessage;

/**
 * The pi agent directory: `$PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
 * Same rule pi-subagents' getAgentDir() follows.
 */
function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

/** Real roots: the developer's home, the pi agent directory and the live project. */
export function defaultRoots(host: Pick<PluginHost, "cwd">): SubagentRoots {
	return { home: homedir(), agentDir: agentDir(), projectDir: host.cwd };
}

/**
 * Tier 2, and the whole of it. pi-subagents publishes a four-member facade at
 * `globalThis[Symbol.for("pi-subagents:manager")]`; of those only `hasRunning()`
 * is safely callable from here. Listing, stopping and spawning agents live on
 * the in-process pi event bus, which a pi-web-ui plugin cannot reach - so this
 * returns one honest boolean and nothing is faked around it.
 *
 * `undefined` means "unknown", which the view hides. It is never a diagnosis:
 * the symbol is deleted on session shutdown and recreated per conversation.
 */
export function subagentsRunning(): boolean | undefined {
	try {
		const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
		if (typeof manager !== "object" || manager === null) return undefined;
		const hasRunning = (manager as { hasRunning?: unknown }).hasRunning;
		return typeof hasRunning === "function" ? Boolean((hasRunning as () => unknown).call(manager)) : undefined;
	} catch {
		return undefined;
	}
}

/** Read every layer once and build the payload the view renders. */
export function toClientState(roots: SubagentRoots): ClientState {
	const store = readModels(roots);
	const settings = readSettingsState(roots);
	const worktreeIsolation = effectiveValue(settings, "worktreeIsolation") !== false;
	const running = subagentsRunning();
	return {
		roots,
		agents: readAgentsState(roots, store.models, !worktreeIsolation),
		agentFields: AGENT_FIELDS,
		settings,
		models: store.models,
		modelsPath: store.path,
		...(store.error ? { modelsError: store.error } : {}),
		worktreeIsolation,
		...(running === undefined ? {} : { subagentsRunning: running }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(action: string, code: string, message: string): ErrorMessage {
	return { type: "error", action, code, message };
}

/** A successful write replies with fresh state, a failed one with the reason. */
function reply(action: string, result: WriteResult, roots: SubagentRoots): ServerMessage {
	if (result.ok) return { type: "state", state: toClientState(roots) };
	return errorMessage(action, result.code, result.message);
}

export function handle(payload: unknown, roots: SubagentRoots): ServerMessage {
	const message = isRecord(payload) ? payload : {};
	const action = typeof message.action === "string" ? message.action : "";
	switch (action) {
		case "list":
			return { type: "state", state: toClientState(roots) };
		case "saveAgent": {
			const frontmatter = isRecord(message.frontmatter) ? message.frontmatter : undefined;
			if (!frontmatter) return errorMessage(action, "invalid-value", "a frontmatter patch object is required");
			return reply(action, saveAgentFile(roots, message.layer, message.file, frontmatter, message.body), roots);
		}
		case "deleteAgent":
			return reply(action, deleteAgentFile(roots, message.layer, message.file), roots);
		case "saveSettings": {
			const values = isRecord(message.values) ? message.values : undefined;
			if (!values) return errorMessage(action, "invalid-value", "a settings object is required");
			const scope = message.scope === "global" ? "global" : message.scope === "project" ? "project" : undefined;
			if (!scope) return errorMessage(action, "invalid-config", 'scope must be "global" or "project"');
			return reply(action, saveSettings(roots, scope, values), roots);
		}
		case "checkModel":
			return { type: "model", verdict: resolveModelPin(message.pin, readModels(roots).models) };
		default:
			return errorMessage(action, "unknown-action", action === "" ? "missing action" : `unknown action "${action}"`);
	}
}

/**
 * Build the plugin entry. `resolveRoots` is injectable so tests can point the
 * plugin at a temp directory; it is called per message, which is what makes the
 * page follow a project switch without re-activating.
 */
export function createEntry(resolveRoots: (host: PluginHost) => SubagentRoots = defaultRoots): PluginEntry {
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

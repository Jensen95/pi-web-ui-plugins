/**
 * The model catalogue and the pin resolver.
 *
 * A subagent's model comes from `options.model ?? resolveDefaultModel(ctx.model,
 * registry, agentConfig?.model)` (pi-subagents dist/agent-runner.js), and
 * `agentConfig.model` is only ever an agent file's `model:` frontmatter field.
 * When that pin does not resolve the run silently inherits the parent session's
 * model - no error, no note. So the pin has to be checked before it is written,
 * which is what {@link resolveModelPin} is for.
 *
 * The matching rules are a port of pi-subagents dist/model-resolver.js
 * `resolveModel`: exact "provider/id", then a fuzzy score over every model (with
 * "." and "-" treated as the same separator and a trailing -YYYYMMDD date stamp
 * optional), then a retry of the bare id against every provider.
 *
 * The one thing this module cannot reproduce is the registry's availability
 * filter: the extension scores `registry.getAvailable()` (models whose provider
 * has auth configured), while models-store.json lists everything that was ever
 * fetched. A pin that resolves here but whose provider has no credentials will
 * still inherit the parent model, so the verdict is "what the resolver would
 * pick", not a promise about auth.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Filesystem roots every path in this plugin is derived from. Injected, never global. */
export interface SubagentRoots {
	/** Stands in for os.homedir(). */
	home: string;
	/** The pi agent directory, e.g. ~/.pi/agent. */
	agentDir: string;
	/** The live project working directory. */
	projectDir: string;
}

/** Why a file could not be used. Shared by every layer reader in this plugin. */
export interface ConfigFileError {
	code: string;
	message: string;
}

/** One selectable model, flattened out of models-store.json. */
export interface ModelOption {
	provider: string;
	id: string;
	/** Display name, falling back to the id. */
	name: string;
	/** What goes in `model:` frontmatter. */
	pin: string;
}

/** What the resolver would do with a pin, in terms a view can render. */
export interface ModelVerdict {
	/** The pin exactly as the user typed it. */
	pin: string;
	/** `empty` means no pin at all, which inherits the parent model on purpose. */
	status: "empty" | "resolved" | "unavailable";
	/** True when the pin matched a model without any fuzzy interpretation. */
	exact: boolean;
	/** The model the extension would actually run. Absent when unavailable. */
	target?: ModelOption;
	/** One English line for the UI. */
	message: string;
}

/** Path of the model store this plugin reads. */
export function modelsStorePath(roots: SubagentRoots): string {
	return join(roots.agentDir, "models-store.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
	return isRecord(err) && typeof err.message === "string" ? err.message : String(err);
}

/** Every model in `~/.pi/agent/models-store.json`, sorted by provider then id. */
export function readModels(roots: SubagentRoots): { models: ModelOption[]; path: string; error?: ConfigFileError } {
	const path = modelsStorePath(roots);
	if (!existsSync(path)) return { models: [], path };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { models: [], path, error: { code: "read-failed", message: `cannot read ${path}: ${messageOf(err)}` } };
	}
	if (!isRecord(parsed)) {
		return { models: [], path, error: { code: "invalid-config", message: `${path} must contain a JSON object` } };
	}
	const models: ModelOption[] = [];
	for (const [providerKey, providerValue] of Object.entries(parsed)) {
		if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) continue;
		for (const entry of providerValue.models) {
			if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") continue;
			const provider = typeof entry.provider === "string" && entry.provider !== "" ? entry.provider : providerKey;
			const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.id;
			models.push({ provider, id: entry.id, name, pin: `${provider}/${entry.id}` });
		}
	}
	return {
		models: models.sort((left, right) => left.pin.localeCompare(right.pin)),
		path,
	};
}

/** Cosmetic punctuation is not significant: "claude-haiku-4.5" is "claude-haiku-4-5". */
function normalize(value: string): string {
	return value.toLowerCase().replace(/\./g, "-");
}

/** The extension's scoring function, ported verbatim in behaviour. */
function score(model: ModelOption, query: string): number {
	const id = normalize(model.id);
	const name = normalize(model.name);
	const full = normalize(model.pin);
	if (id === query || full === query) return 100;
	if (id.includes(query) || full.includes(query)) return 60 + (query.length / id.length) * 30;
	if (name.includes(query)) return 40 + (query.length / name.length) * 20;
	// A trailing date stamp ("claude-haiku-4-5-20251001") is optional, so every
	// non-date token being present somewhere still counts as a match.
	const parts = query.split(/[\s\-/]+/);
	const everyPart = parts.every(
		(part) =>
			/^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || model.provider.toLowerCase().includes(part),
	);
	return everyPart ? 20 : 0;
}

function bestMatch(query: string, models: ModelOption[]): ModelOption | undefined {
	let best: ModelOption | undefined;
	let bestScore = 0;
	for (const model of models) {
		const value = score(model, query);
		if (value > bestScore) {
			bestScore = value;
			best = model;
		}
	}
	return bestScore >= 20 ? best : undefined;
}

/**
 * What the extension would resolve `pin` to, or an explicit "unavailable".
 *
 * An empty pin is not an error: it is the documented way to inherit the parent
 * session's model. A pin that resolves to something other than itself is still
 * `resolved`, with `exact: false`, so the view can show which model will
 * actually run instead of the string the user typed.
 */
export function resolveModelPin(pin: unknown, models: ModelOption[]): ModelVerdict {
	const input = typeof pin === "string" ? pin.trim() : "";
	if (input === "") {
		return { pin: "", status: "empty", exact: true, message: "no model pinned - inherits the parent session model" };
	}
	const slash = input.indexOf("/");
	const exact = models.find((model) => model.pin.toLowerCase() === input.toLowerCase());
	if (slash !== -1 && exact) {
		return { pin: input, status: "resolved", exact: true, target: exact, message: `resolves to ${exact.pin}` };
	}
	const fuzzy = bestMatch(normalize(input), models);
	const bare = fuzzy ?? (slash !== -1 ? bestMatch(normalize(input.slice(slash + 1)), models) : undefined);
	if (bare) {
		return {
			pin: input,
			status: "resolved",
			exact: bare.pin.toLowerCase() === input.toLowerCase(),
			target: bare,
			message: `resolves to ${bare.pin}`,
		};
	}
	return {
		pin: input,
		status: "unavailable",
		exact: false,
		message: `"${input}" matches no known model - the subagent will silently inherit the parent session model`,
	};
}

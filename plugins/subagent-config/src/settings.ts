/**
 * subagents.json: the two layers, their merge, and the sanitizer's own rules.
 *
 * pi-subagents reads `{...global, ...project}` per key (dist/settings.js
 * `loadSettings`), where global is `<agentDir>/subagents.json` and project is
 * `<cwd>/.pi/subagents.json`. Both files are run through `sanitize()` on load,
 * and sanitize is SILENT: a value of the wrong type or outside a ceiling is
 * dropped without a warning, so a hand-written `maxConcurrent: 5000` looks
 * saved and does nothing.
 *
 * {@link FIELDS} is that sanitizer restated as data, and {@link validateValue}
 * enforces it before anything is written, so this plugin can never persist a
 * value the extension would throw away.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigFileError, SubagentRoots } from "./models.ts";

/** Which subagents.json a value lives in. */
export type SettingsScope = "global" | "project";

/** A value subagents.json can hold. */
export type SettingsValue = string | number | boolean;

/** One key of subagents.json, described the way the sanitizer checks it. */
export interface SettingsField {
	key: string;
	/** `string` currently means fallbackSubagent, which also accepts `false`. */
	kind: "integer" | "boolean" | "enum" | "string";
	/** Inclusive floor for `integer`. */
	min?: number;
	/** Inclusive ceiling for `integer`. */
	max?: number;
	/** Accepted values for `enum`. */
	options?: string[];
	/** One English line the view can put under the control. */
	help: string;
}

/**
 * The 24 keys `sanitize()` keeps, with its own floors, ceilings and enums.
 * Ported from pi-subagents dist/settings.js.
 */
export const FIELDS: SettingsField[] = [
	{ key: "maxConcurrent", kind: "integer", min: 1, max: 1024, help: "Subagents allowed to run at once." },
	{
		key: "maxConcurrentForeground",
		kind: "integer",
		min: 0,
		max: 1024,
		help: "Foreground slots. 0 means unlimited.",
	},
	{ key: "defaultMaxTurns", kind: "integer", min: 0, max: 10000, help: "Turn budget when an agent sets none." },
	{ key: "graceTurns", kind: "integer", min: 1, max: 1000, help: "Extra turns granted after the budget runs out." },
	{ key: "maxSubagentDepth", kind: "integer", min: 0, max: 16, help: "How deep subagents may spawn subagents." },
	{
		key: "defaultJoinMode",
		kind: "enum",
		options: ["async", "group", "smart"],
		help: "How results are joined back into the session.",
	},
	{ key: "backgroundByDefault", kind: "boolean", help: "Start subagents in the background unless told otherwise." },
	{ key: "schedulingEnabled", kind: "boolean", help: "Allow scheduled subagent runs." },
	{ key: "disableDefaultAgents", kind: "boolean", help: "Hide the built-in agent types." },
	{
		key: "fallbackSubagent",
		kind: "string",
		help: 'Agent used when a requested type is unknown. Empty clears it; "none" disables the fallback.',
	},
	{ key: "workflowsEnabled", kind: "boolean", help: "Enable the workflow runner." },
	{
		key: "worktreeIsolation",
		kind: "boolean",
		help: "Project-wide switch. When false, every agent file's isolation: worktree is silently ignored.",
	},
	{ key: "strictAgentFiles", kind: "boolean", help: "Fail loudly instead of skipping an unparseable agent file." },
	{ key: "rememberAgents", kind: "boolean", help: "Remember the agent chosen for a task." },
	{ key: "outputTranscript", kind: "boolean", help: "Write each finished agent's output to a transcript file." },
	{ key: "reportUsage", kind: "boolean", help: "Report token usage for each run." },
	{ key: "showCost", kind: "boolean", help: "Show cost in the widget." },
	{ key: "showModel", kind: "boolean", help: "Show the resolved model in the widget." },
	{ key: "scopeModels", kind: "boolean", help: "Restrict a subagent to its own model scope." },
	{
		key: "toolDescriptionMode",
		kind: "enum",
		options: ["full", "compact", "custom"],
		help: "How much of the Agent tool description is sent to the model.",
	},
	{ key: "fleetView", kind: "boolean", help: "Enable the fleet view." },
	{
		key: "agentMentions",
		kind: "enum",
		options: ["model", "direct", "off"],
		help: "How @agent mentions are dispatched.",
	},
	{
		key: "viewerMarkdown",
		kind: "enum",
		options: ["off", "assistant", "all"],
		help: "Markdown rendering in the conversation viewer.",
	},
	{
		key: "widgetMode",
		kind: "enum",
		options: ["all", "background", "off"],
		help: "Which runs the status widget shows.",
	},
];

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/** The `fallbackSubagent: false` spelling the sanitizer accepts as "no fallback". */
const NO_FALLBACK = false;

/** One subagents.json file as read from disk. */
export interface SettingsLayer {
	scope: SettingsScope;
	label: string;
	path: string;
	exists: boolean;
	/** This plugin may write it. Both files qualify; only project is pi-owned. */
	writable: boolean;
	/** Values that survive the sanitizer. */
	values: Record<string, SettingsValue>;
	/** Keys present in the file that the sanitizer drops, so the UI can warn. */
	droppedKeys: string[];
	error?: ConfigFileError;
}

/** One key after the merge, with the layer it came from. */
export interface EffectiveSetting {
	key: string;
	value?: SettingsValue;
	/** Absent when neither file sets the key and the extension default applies. */
	source?: SettingsScope;
}

export interface SettingsState {
	layers: SettingsLayer[];
	effective: EffectiveSetting[];
	fields: SettingsField[];
}

export type WriteFailureCode =
	"read-failed" | "invalid-config" | "invalid-name" | "invalid-value" | "not-writable" | "write-failed";

/** Outcome of a write. Failures are values, never exceptions. */
export type WriteResult =
	{ ok: true; path: string; changed: boolean } | { ok: false; path: string; code: WriteFailureCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
	return isRecord(err) && typeof err.message === "string" ? err.message : String(err);
}

function codeOf(err: unknown, fallback: string): string {
	return isRecord(err) && typeof err.code === "string" ? err.code : fallback;
}

export function settingsPath(roots: SubagentRoots, scope: SettingsScope): string {
	return scope === "global" ? join(roots.agentDir, "subagents.json") : join(roots.projectDir, ".pi", "subagents.json");
}

/** A value the sanitizer keeps, or the reason it would be dropped. */
export type ValueCheck = { ok: true; value: SettingsValue } | { ok: false; message: string };

/**
 * The sanitizer's rule for one key, restated so the UI can refuse a value the
 * extension would silently drop. `agentMentions: true|false` is accepted the way
 * the sanitizer accepts it (a legacy boolean becomes "model" or "off").
 */
export function validateValue(key: string, value: unknown): ValueCheck {
	const field = FIELD_BY_KEY.get(key);
	if (!field) return { ok: false, message: `"${key}" is not a subagents.json setting` };
	switch (field.kind) {
		case "integer": {
			const min = field.min ?? 0;
			const max = field.max ?? Number.MAX_SAFE_INTEGER;
			if (!Number.isInteger(value)) return { ok: false, message: `${key} must be a whole number` };
			const numeric = value as number;
			if (numeric < min || numeric > max) {
				return { ok: false, message: `${key} must be between ${min} and ${max} - the extension drops anything else` };
			}
			return { ok: true, value: numeric };
		}
		case "boolean":
			if (typeof value !== "boolean") return { ok: false, message: `${key} must be true or false` };
			return { ok: true, value };
		case "enum": {
			const options = field.options ?? [];
			if (key === "agentMentions" && typeof value === "boolean") return { ok: true, value: value ? "model" : "off" };
			if (typeof value !== "string" || !options.includes(value)) {
				return { ok: false, message: `${key} must be one of ${options.join(", ")}` };
			}
			return { ok: true, value };
		}
		default: {
			if (value === NO_FALLBACK) return { ok: true, value: NO_FALLBACK };
			if (typeof value !== "string" || value.trim() === "") {
				return { ok: false, message: `${key} must be a non-empty agent name, or false for no fallback` };
			}
			return { ok: true, value: value.trim() };
		}
	}
}

/** Apply the sanitizer to a parsed document, reporting what it would drop. */
function sanitize(raw: Record<string, unknown>): { values: Record<string, SettingsValue>; droppedKeys: string[] } {
	const values: Record<string, SettingsValue> = {};
	const droppedKeys: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const check = validateValue(key, value);
		if (check.ok) values[key] = check.value;
		else droppedKeys.push(key);
	}
	return { values, droppedKeys };
}

function readLayer(roots: SubagentRoots, scope: SettingsScope): SettingsLayer {
	const path = settingsPath(roots, scope);
	const base = {
		scope,
		label: scope === "global" ? "global subagents.json" : "project subagents.json",
		path,
		writable: true,
	};
	if (!existsSync(path)) return { ...base, exists: false, values: {}, droppedKeys: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		const reason = codeOf(err, "") === "" ? `invalid JSON (${messageOf(err)})` : messageOf(err);
		return {
			...base,
			exists: true,
			values: {},
			droppedKeys: [],
			error: { code: "read-failed", message: `cannot use ${path}: ${reason}` },
		};
	}
	if (!isRecord(parsed)) {
		return {
			...base,
			exists: true,
			values: {},
			droppedKeys: [],
			error: { code: "invalid-config", message: `${path} must contain a JSON object` },
		};
	}
	return { ...base, exists: true, ...sanitize(parsed) };
}

/** Both layers, global first (the order the extension merges them in). */
export function readSettingsLayers(roots: SubagentRoots): SettingsLayer[] {
	return [readLayer(roots, "global"), readLayer(roots, "project")];
}

/** `{...global, ...project}`, per key, with the layer each value came from. */
export function resolveSettings(layers: SettingsLayer[]): EffectiveSetting[] {
	return FIELDS.map((field) => {
		let result: EffectiveSetting = { key: field.key };
		for (const layer of layers) {
			if (Object.hasOwn(layer.values, field.key)) {
				result = { key: field.key, value: layer.values[field.key], source: layer.scope };
			}
		}
		return result;
	});
}

/** Everything the view needs about subagents.json. */
export function readSettingsState(roots: SubagentRoots): SettingsState {
	const layers = readSettingsLayers(roots);
	return { layers, effective: resolveSettings(layers), fields: FIELDS };
}

/** The merged value of one key, for cross-checks like `worktreeIsolation`. */
export function effectiveValue(state: SettingsState, key: string): SettingsValue | undefined {
	return state.effective.find((entry) => entry.key === key)?.value;
}

/** tmp + rename in the target directory: a half-written settings file would
 *  revert every setting at once. */
export function writeJsonAtomic(path: string, raw: Record<string, unknown>): WriteResult {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return { ok: true, path, changed: true };
	} catch (err) {
		return { ok: false, path, code: "write-failed", message: `cannot write ${path}: ${messageOf(err)}` };
	}
}

/**
 * Persist settings into one layer.
 *
 * `updates` is a sparse patch: a key mapped to `null` is removed, every other
 * key is validated against the sanitizer first and the whole write is refused if
 * any value would be dropped. Unrelated top-level keys in the existing file are
 * preserved, a malformed existing file is a typed failure rather than an
 * overwrite, and an unchanged document is not rewritten at all.
 */
export function saveSettings(
	roots: SubagentRoots,
	scope: SettingsScope,
	updates: Record<string, unknown>,
): WriteResult {
	const path = settingsPath(roots, scope);
	if (scope !== "global" && scope !== "project") {
		return { ok: false, path, code: "not-writable", message: `unknown settings scope "${String(scope)}"` };
	}
	if (!isRecord(updates)) {
		return { ok: false, path, code: "invalid-value", message: "a settings object is required" };
	}

	const checked: Record<string, SettingsValue | undefined> = {};
	for (const [key, value] of Object.entries(updates)) {
		if (value === null || value === undefined) {
			if (!FIELD_BY_KEY.has(key)) {
				return { ok: false, path, code: "invalid-value", message: `"${key}" is not a subagents.json setting` };
			}
			checked[key] = undefined;
			continue;
		}
		const check = validateValue(key, value);
		if (!check.ok) return { ok: false, path, code: "invalid-value", message: check.message };
		checked[key] = check.value;
	}

	let doc: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (err) {
			const reason = codeOf(err, "") === "" ? `invalid JSON (${messageOf(err)})` : messageOf(err);
			return { ok: false, path, code: "read-failed", message: `cannot use ${path}: ${reason}` };
		}
		if (!isRecord(parsed)) {
			return { ok: false, path, code: "invalid-config", message: `${path} must contain a JSON object` };
		}
		doc = { ...parsed };
	}

	const before = JSON.stringify(doc);
	for (const [key, value] of Object.entries(checked)) {
		if (value === undefined) delete doc[key];
		else doc[key] = value;
	}
	if (JSON.stringify(doc) === before) return { ok: true, path, changed: false };
	return writeJsonAtomic(path, doc);
}

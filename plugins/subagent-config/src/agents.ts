/**
 * Agent files: discovery, frontmatter round-trip and the write path.
 *
 * pi-subagents loads `*.md` from three directories (dist/custom-agents.js):
 * global `<agentDir>/agents`, the shared read-only workspace
 * `<cwd>/.agents/agents`, then the project authority `<cwd>/.pi/agents` - in
 * that order, so the last one to define a name wins. The YAML frontmatter is
 * the agent's configuration and the markdown body is its system prompt.
 *
 * Two properties drive every decision in this module:
 *
 * 1. An agent file is the user's, not ours. Round-tripping must not drop a key
 *    this plugin does not know about, must not reformat keys it did not touch,
 *    and must not rewrite the body at all. So the frontmatter is edited as
 *    LINES: a patched key replaces its own line, a new key is appended, and
 *    every other byte of the file survives untouched. That also means no YAML
 *    dependency - plugins in this repo bundle standalone.
 * 2. A file this module cannot represent as flat `key: value` lines (block
 *    sequences, nested mappings, folded scalars) is marked unsupported and
 *    served read-only rather than round-tripped through a lossy serializer.
 *
 * Edits take effect on the next `Agent` call: custom agents reload on
 * activation and again on every call (dist/custom-agents.js), so no restart and
 * no /reload is needed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ConfigFileError, ModelOption, ModelVerdict, SubagentRoots } from "./models.ts";
import { resolveModelPin } from "./models.ts";
import type { WriteFailureCode, WriteResult } from "./settings.ts";

/** Which directory an agent file lives in. */
export type AgentLayerId = "global" | "workspace" | "project";

/** One agent directory in the discovery chain. */
export interface AgentLayer {
	id: AgentLayerId;
	label: string;
	dir: string;
	scope: "global" | "project";
	/** `.agents/agents` is a shared cross-tool location: read it, never write it. */
	writable: boolean;
}

/** A frontmatter value this module can read and write back. */
export type FrontmatterValue = string | number | boolean | string[];

/** A parsed agent file, kept close enough to the bytes to write it back. */
export interface AgentDoc {
	hasFrontmatter: boolean;
	/** Raw frontmatter lines, fences excluded, exactly as written minus the line break. */
	lines: string[];
	/** The file's own line ending, so a CRLF file is not rewritten as mixed. */
	eol: string;
	/** Parsed flat fields. Unknown keys are here too, and are preserved on write. */
	fields: Record<string, FrontmatterValue>;
	/** Everything after the closing fence, verbatim. The agent's system prompt. */
	body: string;
	/** Set when the frontmatter uses YAML this module will not rewrite. */
	unsupported?: string;
}

/** A frontmatter key the extension actually reads, described for the editor. */
export interface AgentField {
	key: string;
	kind: "string" | "text" | "boolean" | "integer" | "enum" | "list";
	options?: string[];
	help: string;
}

/** The frontmatter fields pi-subagents parses (dist/custom-agents.js). */
export const AGENT_FIELDS: AgentField[] = [
	{ key: "name", kind: "string", help: "The agent type. Defaults to the filename. May not contain a colon." },
	{ key: "display_name", kind: "string", help: "Label shown in the UI." },
	{ key: "description", kind: "text", help: "What the agent is for. The model reads this when choosing an agent." },
	{ key: "color", kind: "string", help: "Badge colour." },
	{ key: "model", kind: "string", help: "Model pin, as provider/id. Empty inherits the parent session model." },
	{
		key: "thinking",
		kind: "enum",
		options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		help: "Reasoning level for this agent.",
	},
	{ key: "tools", kind: "list", help: "Allowed tools. Empty or none grants nothing." },
	{ key: "disallowed_tools", kind: "list", help: "Tools removed from the inherited set." },
	{ key: "extensions", kind: "list", help: "Extensions to load. inherit keeps the session's." },
	{ key: "exclude_extensions", kind: "list", help: "Extensions to drop." },
	{ key: "skills", kind: "list", help: "Skills to load. inherit keeps the session's." },
	{ key: "memory", kind: "string", help: "Memory scope for the agent." },
	{
		key: "isolation",
		kind: "enum",
		options: ["worktree", "off"],
		help: "worktree runs the agent in its own git worktree - ignored when worktreeIsolation is off.",
	},
	{ key: "max_turns", kind: "integer", help: "Turn budget for one run." },
	{ key: "persist_session", kind: "boolean", help: "Keep the agent's session file." },
	{ key: "output_transcript", kind: "boolean", help: "Write the run's output to a transcript file." },
	{ key: "session_dir", kind: "string", help: "Where to keep persisted sessions." },
	{ key: "inherit_context", kind: "boolean", help: "Start from the parent conversation instead of a clean one." },
	{ key: "run_in_background", kind: "boolean", help: "Start this agent in the background." },
	{ key: "isolated", kind: "boolean", help: "Run without shared state." },
	{ key: "allowed_subagents", kind: "list", help: "Agent types this agent may spawn." },
	{ key: "enabled", kind: "boolean", help: "false disables the agent, which is how a built-in is hidden." },
];

/** One agent file as read from disk. */
export interface AgentFileState {
	layer: AgentLayerId;
	path: string;
	/** Basename, e.g. "reviewer.md". */
	file: string;
	/** The type the extension registers: frontmatter `name`, else the filename. */
	name: string;
	/** Present when the file declares its own name. */
	declaredName?: string;
	fields: Record<string, FrontmatterValue>;
	/** Keys present that AGENT_FIELDS does not describe. Preserved on write. */
	unknownKeys: string[];
	body: string;
	enabled: boolean;
	/** True when the layer is read-only or the frontmatter cannot be rewritten. */
	readOnly: boolean;
	/** Why it is read-only, when it is not simply the layer. */
	unsupported?: string;
	error?: ConfigFileError;
	/** What the extension would resolve `model:` to. */
	model: ModelVerdict;
	/** `isolation: worktree` set while the project switched worktreeIsolation off. */
	worktreeIgnored: boolean;
}

/** An agent after the discovery merge: the file that actually wins the name. */
export interface EffectiveAgent {
	name: string;
	winner: AgentFileState;
	/** Every file claiming this name, discovery order, shadowed ones first. */
	shadowed: { layer: AgentLayerId; path: string }[];
}

export interface AgentsState {
	layers: (AgentLayer & { exists: boolean; fileCount: number })[];
	files: AgentFileState[];
	agents: EffectiveAgent[];
}

const KNOWN_KEYS = new Set(AGENT_FIELDS.map((field) => field.key));

/** Keys that would hit a prototype accessor instead of becoming data. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The one character a declared `name:` may not contain (plugin-scoped ids use it). */
const RESERVED_IN_NAME = ":";

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The three agent directories, lowest precedence first. */
export function agentLayers(roots: SubagentRoots): AgentLayer[] {
	return [
		{
			id: "global",
			label: "global agents",
			dir: join(roots.agentDir, "agents"),
			scope: "global",
			writable: true,
		},
		{
			id: "workspace",
			label: "shared workspace agents (read-only)",
			dir: join(roots.projectDir, ".agents", "agents"),
			scope: "project",
			writable: false,
		},
		{
			id: "project",
			label: "project agents",
			dir: join(roots.projectDir, ".pi", "agents"),
			scope: "project",
			writable: true,
		},
	];
}

export function agentLayer(roots: SubagentRoots, id: unknown): AgentLayer | undefined {
	return agentLayers(roots).find((layer) => layer.id === id);
}

// ---- frontmatter ----

function unquote(text: string): string {
	const quote = text[0];
	if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length >= 2) {
		const inner = text.slice(1, -1);
		return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
	}
	return text;
}

/** The flat scalar subset agent files actually use. */
function parseValue(raw: string): FrontmatterValue {
	const text = raw.trim();
	if (text === "") return "";
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+$/.test(text)) return Number(text);
	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1).trim();
		if (inner === "") return [];
		return inner.split(",").map((item) => unquote(item.trim()));
	}
	return unquote(text);
}

/** Quote only when a bare scalar would parse as something else. */
function formatValue(value: FrontmatterValue): string {
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map((item) => formatValue(item)).join(", ")}]`;
	if (value === "") return '""';
	if (/^[\s]|[\s]$/.test(value)) return JSON.stringify(value);
	if (/^(true|false|-?\d+)$/.test(value)) return JSON.stringify(value);
	if (/^["'[\]{}&*!|>%@`,#-]/.test(value)) return JSON.stringify(value);
	if (value.includes(": ") || value.includes(" #") || value.endsWith(":")) return JSON.stringify(value);
	return value;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;
/** A key this module is willing to write. Stricter than KEY_LINE: no trailing space. */
const WRITABLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Split an agent file into frontmatter lines, parsed fields and a verbatim body.
 * Never throws: a file whose frontmatter is not flat `key: value` comes back
 * marked `unsupported`, which the caller renders read-only.
 */
export function parseAgentDoc(text: string): AgentDoc {
	const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const lines = source.split("\n");
	const eol = source.includes("\r\n") ? "\r\n" : "\n";
	if (lines[0]?.trimEnd() !== "---") {
		return { hasFrontmatter: false, lines: [], eol, fields: {}, body: source };
	}
	const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
	if (end === -1) {
		return {
			hasFrontmatter: false,
			lines: [],
			eol,
			fields: {},
			body: source,
			unsupported: "frontmatter is not closed",
		};
	}
	// Line endings are held in `eol`, so a CRLF file's keys are not parsed with a stray \r.
	const frontmatter = lines.slice(1, end).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const body = lines.slice(end + 1).join("\n");
	const fields: Record<string, FrontmatterValue> = {};
	let unsupported: string | undefined;
	for (const [index, line] of frontmatter.entries()) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = KEY_LINE.exec(line);
		if (!match || line !== line.trimStart()) {
			unsupported ??= `frontmatter uses YAML this editor will not rewrite: "${trimmed}"`;
			continue;
		}
		const [, key, rest] = match;
		if (key === undefined || rest === undefined) continue;
		if (UNSAFE_KEYS.has(key)) {
			unsupported ??= `frontmatter key "${key}" is not editable here`;
			continue;
		}
		if (rest.trim() === "" && key !== "") {
			// `key:` with nothing after it introduces a block value in YAML.
			const next = frontmatter[index + 1];
			if (next !== undefined && /^\s+\S/.test(next)) {
				unsupported ??= `frontmatter key "${key}" holds a block value this editor will not rewrite`;
				continue;
			}
		}
		fields[key] = parseValue(rest);
	}
	return { hasFrontmatter: true, lines: frontmatter, eol, fields, body, ...(unsupported ? { unsupported } : {}) };
}

/**
 * Apply a sparse patch to a document's frontmatter and return the whole file.
 *
 * A key in `updates` replaces its own line in place; `null` removes the line; a
 * key that is not there yet is appended. Lines this plugin did not touch -
 * including keys it does not understand, comments and blank lines - come back
 * byte for byte, and the body is never rewritten unless `body` is given.
 */
export function serializeAgentDoc(
	doc: AgentDoc,
	updates: Record<string, FrontmatterValue | null> = {},
	body?: string,
): string {
	const pending = new Map(Object.entries(updates));
	const written = new Set<string>();
	const lines: string[] = [];
	for (const line of doc.lines) {
		const match = KEY_LINE.exec(line);
		const key = match?.[1];
		if (key === undefined || !pending.has(key)) {
			lines.push(line);
			continue;
		}
		// A duplicated key must not survive: in YAML the last one wins, so leaving a
		// second copy behind would quietly undo the edit.
		if (written.has(key)) continue;
		written.add(key);
		const value = pending.get(key);
		if (value !== null && value !== undefined) lines.push(`${key}: ${formatValue(value)}`);
	}
	for (const [key, value] of pending) {
		if (written.has(key)) continue;
		if (value !== null && value !== undefined) lines.push(`${key}: ${formatValue(value)}`);
	}
	const text = body ?? doc.body;
	const eol = doc.eol;
	return `---${eol}${lines.length > 0 ? `${lines.join(eol)}${eol}` : ""}---${eol}${text}`;
}

// ---- reading ----

function readAgentFile(layer: AgentLayer, file: string, models: ModelOption[], worktreeOff: boolean): AgentFileState {
	const path = join(layer.dir, file);
	const base = {
		layer: layer.id,
		path,
		file,
		unknownKeys: [] as string[],
		fields: {} as Record<string, FrontmatterValue>,
		body: "",
		enabled: true,
		worktreeIgnored: false,
	};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		return {
			...base,
			name: basename(file, ".md"),
			readOnly: true,
			model: resolveModelPin("", models),
			error: { code: "read-failed", message: `cannot read ${path}: ${messageOf(err)}` },
		};
	}
	const doc = parseAgentDoc(text);
	const declared = typeof doc.fields.name === "string" ? doc.fields.name.trim() : undefined;
	const skipped = declared !== undefined && declared.includes(RESERVED_IN_NAME);
	const model = resolveModelPin(doc.fields.model, models);
	return {
		...base,
		fields: doc.fields,
		body: doc.body,
		name: declared !== undefined && declared !== "" && !skipped ? declared : basename(file, ".md"),
		...(declared !== undefined ? { declaredName: declared } : {}),
		unknownKeys: Object.keys(doc.fields).filter((key) => !KNOWN_KEYS.has(key)),
		enabled: doc.fields.enabled !== false,
		readOnly: !layer.writable || doc.unsupported !== undefined,
		...(doc.unsupported ? { unsupported: doc.unsupported } : {}),
		...(skipped
			? {
					error: {
						code: "invalid-name",
						message: `name "${declared}" contains ":" - pi-subagents skips this file entirely`,
					},
				}
			: {}),
		model,
		worktreeIgnored: worktreeOff && doc.fields.isolation === "worktree",
	};
}

function listMarkdown(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Every agent file, plus the discovery merge.
 *
 * `worktreeOff` is the merged `worktreeIsolation` setting: when the project
 * switched it off, an `isolation: worktree` field is silently ignored by the
 * extension, so each file carries a flag for the view to warn about it.
 */
export function readAgentsState(roots: SubagentRoots, models: ModelOption[], worktreeOff: boolean): AgentsState {
	const layers = agentLayers(roots);
	const files: AgentFileState[] = [];
	const merged = new Map<string, EffectiveAgent>();
	const described = layers.map((layer) => {
		const names = listMarkdown(layer.dir);
		for (const file of names) {
			const state = readAgentFile(layer, file, models, worktreeOff);
			files.push(state);
			// A file skipped for a colon in its name registers nothing.
			if (state.error?.code === "invalid-name") continue;
			const previous = merged.get(state.name);
			merged.set(state.name, {
				name: state.name,
				winner: state,
				shadowed: previous ? [...previous.shadowed, { layer: previous.winner.layer, path: previous.winner.path }] : [],
			});
		}
		return { ...layer, exists: existsSync(layer.dir), fileCount: names.length };
	});
	return {
		layers: described,
		files,
		agents: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
	};
}

// ---- writing ----

function fail(path: string, code: WriteFailureCode, message: string): Extract<WriteResult, { ok: false }> {
	return { ok: false, path, code, message };
}

/** A filename that stays inside the agent directory and is a markdown file. */
export function normalizeFileName(name: unknown): string | undefined {
	if (typeof name !== "string") return undefined;
	const trimmed = name.trim();
	if (trimmed === "" || trimmed !== basename(trimmed)) return undefined;
	if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) return undefined;
	const file = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
	const stem = file.slice(0, -3);
	// A dotfile or an empty stem is not an agent the extension would ever register.
	if (stem === "" || stem.startsWith(".") || UNSAFE_KEYS.has(stem)) return undefined;
	return file;
}

/** Only flat scalars and string lists can be written back. */
function checkValue(key: string, value: unknown): string | undefined {
	if (value === null) return undefined;
	if (typeof value === "string" || typeof value === "boolean") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? undefined : `${key} must be a finite number`;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return undefined;
	return `${key} must be a string, number, boolean or list of strings`;
}

function writeTextAtomic(path: string, text: string): WriteResult {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, path);
		return { ok: true, path, changed: true };
	} catch (err) {
		return fail(path, "write-failed", `cannot write ${path}: ${messageOf(err)}`);
	}
}

/**
 * Create or patch one agent file.
 *
 * `updates` is a sparse frontmatter patch (`null` removes a key) and `body`
 * replaces the system prompt only when supplied. The read-only workspace layer
 * is refused, a `name:` containing ":" is refused (the extension would skip the
 * whole file), a file whose frontmatter this module cannot rewrite is refused
 * rather than flattened, and an unchanged document is not written at all.
 */
export function saveAgentFile(
	roots: SubagentRoots,
	layerId: unknown,
	fileName: unknown,
	updates: Record<string, unknown>,
	body?: unknown,
): WriteResult {
	const layer = agentLayer(roots, layerId);
	if (!layer) return fail("", "invalid-config", `unknown agent location "${String(layerId)}"`);
	const file = normalizeFileName(fileName);
	if (!file) return fail(layer.dir, "invalid-name", `"${String(fileName)}" is not a usable agent file name`);
	const path = join(layer.dir, file);
	if (!layer.writable) return fail(path, "not-writable", `${layer.label} is read-only - copy the agent to edit it`);
	if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
		return fail(path, "invalid-value", "a frontmatter patch object is required");
	}
	if (body !== undefined && typeof body !== "string") {
		return fail(path, "invalid-value", "body must be a string");
	}

	const patch: Record<string, FrontmatterValue | null> = {};
	for (const [key, value] of Object.entries(updates)) {
		if (!WRITABLE_KEY.test(key) || UNSAFE_KEYS.has(key)) {
			return fail(path, "invalid-name", `"${key}" is not a usable frontmatter key`);
		}
		const problem = checkValue(key, value);
		if (problem) return fail(path, "invalid-value", problem);
		patch[key] = value === null || value === undefined ? null : (value as FrontmatterValue);
	}
	const name = patch.name;
	if (typeof name === "string" && name.includes(RESERVED_IN_NAME)) {
		return fail(path, "invalid-name", `name "${name}" may not contain ":" - pi-subagents would skip the file`);
	}

	let existing = "";
	if (existsSync(path)) {
		try {
			existing = readFileSync(path, "utf8");
		} catch (err) {
			return fail(path, "read-failed", `cannot read ${path}: ${messageOf(err)}`);
		}
	}
	const doc = parseAgentDoc(existing);
	if (existing !== "" && doc.unsupported) {
		return fail(path, "invalid-config", `${path}: ${doc.unsupported}`);
	}
	const next = serializeAgentDoc(doc, patch, typeof body === "string" ? body : undefined);
	if (next === existing) return { ok: true, path, changed: false };
	return writeTextAtomic(path, next);
}

/** Delete an agent file from a writable layer. Missing is a no-op, not an error. */
export function deleteAgentFile(roots: SubagentRoots, layerId: unknown, fileName: unknown): WriteResult {
	const layer = agentLayer(roots, layerId);
	if (!layer) return fail("", "invalid-config", `unknown agent location "${String(layerId)}"`);
	const file = normalizeFileName(fileName);
	if (!file) return fail(layer.dir, "invalid-name", `"${String(fileName)}" is not a usable agent file name`);
	const path = join(layer.dir, file);
	if (!layer.writable) return fail(path, "not-writable", `${layer.label} is read-only`);
	if (!existsSync(path)) return { ok: true, path, changed: false };
	try {
		unlinkSync(path);
		return { ok: true, path, changed: true };
	} catch (err) {
		return fail(path, "write-failed", `cannot delete ${path}: ${messageOf(err)}`);
	}
}

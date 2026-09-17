/**
 * subagent-config browser view.
 *
 * Compiled to client/entry.mjs and loaded by the browser as bare ESM, so this
 * file may not import anything at runtime: plain DOM only, no host imports and
 * no types pulled from the server module (the wire payload is normalised here
 * instead, tolerantly, so a small server-side shape drift cannot blank the
 * page).
 *
 * What it edits: pi-subagents agent files (.md with YAML frontmatter) and
 * subagents.json. The single most important thing it does is tell the user when
 * a `model:` pin does not resolve - pi-subagents falls back to the parent
 * session model silently, which looks exactly like the pin working.
 */

/** The narrow channel the host gives a view. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

export type AgentScope = "project" | "workspace" | "global";

export interface AgentView {
	id: string;
	/** Basename of the file, which is what `saveAgent` addresses. */
	file: string;
	name: string;
	displayName: string;
	description: string;
	path: string;
	scope: AgentScope;
	writable: boolean;
	shadowed: boolean;
	enabled: boolean;
	model: string;
	modelResolves: boolean;
	thinking: string;
	isolation: string;
	tools: string;
	maxTurns: string;
	body: string;
	unknown: Array<{ key: string; value: string }>;
	error: string;
	/** The file cannot be rewritten at all (unreadable, or YAML this editor will not flatten). */
	blocked: boolean;
}

export interface ModelGroup {
	provider: string;
	models: Array<{ value: string; label: string }>;
}

export interface SettingView {
	key: string;
	value: unknown;
	source: string;
	projectValue: unknown;
	globalValue: unknown;
}

export interface ClientState {
	agents: AgentView[];
	layers: Array<{ label: string; path: string; scope: string; writable: boolean; exists: boolean; error: string }>;
	models: ModelGroup[];
	settings: SettingView[];
	settingsProjectPath: string;
	settingsGlobalPath: string;
	running: boolean | undefined;
}

export const THINKING_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ISOLATION_LEVELS = ["", "off", "worktree"] as const;

/** The 24 keys the extension's sanitizer accepts, with the ceilings it enforces. */
export const SETTING_SPECS: Array<
	| { key: string; kind: "number"; min: number; max: number }
	| { key: string; kind: "boolean" }
	| { key: string; kind: "string" }
> = [
	{ key: "maxConcurrent", kind: "number", min: 1, max: 1024 },
	{ key: "maxConcurrentForeground", kind: "number", min: 0, max: 1024 },
	{ key: "defaultMaxTurns", kind: "number", min: 0, max: 10000 },
	{ key: "graceTurns", kind: "number", min: 1, max: 1000 },
	{ key: "maxSubagentDepth", kind: "number", min: 0, max: 16 },
	{ key: "defaultJoinMode", kind: "string" },
	{ key: "backgroundByDefault", kind: "boolean" },
	{ key: "schedulingEnabled", kind: "boolean" },
	{ key: "disableDefaultAgents", kind: "boolean" },
	{ key: "fallbackSubagent", kind: "string" },
	{ key: "workflowsEnabled", kind: "boolean" },
	{ key: "worktreeIsolation", kind: "boolean" },
	{ key: "strictAgentFiles", kind: "boolean" },
	{ key: "rememberAgents", kind: "boolean" },
	{ key: "outputTranscript", kind: "boolean" },
	{ key: "reportUsage", kind: "boolean" },
	{ key: "showCost", kind: "boolean" },
	{ key: "showModel", kind: "boolean" },
	{ key: "scopeModels", kind: "boolean" },
	{ key: "toolDescriptionMode", kind: "string" },
	{ key: "fleetView", kind: "boolean" },
	{ key: "agentMentions", kind: "boolean" },
	{ key: "viewerMarkdown", kind: "boolean" },
	{ key: "widgetMode", kind: "string" },
];

const STYLES = `
.subagent-config { padding: 12px; color: var(--text, inherit); font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
.subagent-config h3 { margin: 0 0 4px; font-size: 15px; }
.subagent-config h4 { margin: 0 0 6px; font-size: 13px; }
.subagent-config p { margin: 0 0 8px; }
.subagent-config .hint { color: var(--text-dim, #9aa1b4); }
.subagent-config code { padding: 0 4px; border-radius: 3px; background: rgba(127, 127, 127, 0.18); }
.subagent-config section { margin-top: 18px; }
.subagent-config table { width: 100%; border-collapse: collapse; }
.subagent-config th, .subagent-config td { padding: 4px 8px; border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25)); text-align: left; vertical-align: top; }
.subagent-config td.name { font-weight: 600; white-space: nowrap; }
.subagent-config td.actions { white-space: nowrap; text-align: right; }
.subagent-config .muted { color: var(--text-dim, #9aa1b4); }
.subagent-config .faint { color: var(--text-faint, #6b7284); }
.subagent-config .off { opacity: 0.55; }
.subagent-config .warn { color: var(--red, #f87171); font-weight: 600; }
.subagent-config .amber { color: var(--amber, #fbbf24); }
.subagent-config .error { margin: 6px 0; color: var(--red, #f87171); white-space: pre-wrap; }
.subagent-config .banner { margin: 6px 0 10px; padding: 6px 8px; border: 1px solid var(--red, #f87171); border-radius: 4px; color: var(--red, #f87171); }
.subagent-config button { padding: 2px 8px; border: 1px solid var(--border, rgba(127, 127, 127, 0.5)); border-radius: 4px; background: var(--bg-elev2, rgba(127, 127, 127, 0.12)); color: inherit; font: inherit; cursor: pointer; }
.subagent-config button + button { margin-left: 6px; }
.subagent-config form { display: grid; gap: 8px; max-width: 720px; }
.subagent-config label { display: grid; gap: 2px; }
.subagent-config input, .subagent-config textarea, .subagent-config select { padding: 3px 6px; border: 1px solid var(--border, rgba(127, 127, 127, 0.4)); border-radius: 4px; background: var(--bg-elev, rgba(127, 127, 127, 0.08)); color: inherit; font: inherit; }
.subagent-config ul { margin: 0; padding: 0; list-style: none; }
.subagent-config .row { display: flex; gap: 8px; align-items: center; }
`;

/* ------------------------------------------------------------------ */
/* Tolerant payload parsing - all pure, all exported for node tests.    */
/* ------------------------------------------------------------------ */

/** Any non-array object, or an empty one. Never throws, never returns null. */
export function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A string, or a printable rendering of whatever arrived instead. */
export function str(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map((item) => str(item)).join(", ");
	return fallback;
}

/** Defaults matter: `enabled` defaults true, everything else false. */
export function bool(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

/** Whatever a frontmatter or wire field may hold before it is narrowed. */
export type FieldValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;

function scopeOf(value: unknown): AgentScope {
	return value === "project" || value === "workspace" || value === "global" ? value : "global";
}

/** Names defined more than once: the later load wins, the earlier one is shadowed. */
export function shadowedIds(agents: AgentView[]): Set<string> {
	const winner = new Map<string, string>();
	for (const agent of agents) winner.set(agent.name, agent.id);
	const shadowed = new Set<string>();
	for (const agent of agents) if (winner.get(agent.name) !== agent.id) shadowed.add(agent.id);
	return shadowed;
}

function normalizeAgent(raw: unknown, index: number): AgentView {
	const source = record(raw);
	const front = record(source.frontmatter);
	const pick = (key: string): FieldValue => (source[key] !== undefined ? source[key] : front[key]) as FieldValue;
	const path = str(pick("path"));
	const name = str(pick("name")) || path.split("/").pop()?.replace(/\.md$/, "") || `agent-${index}`;
	const unknownSource = record(pick("unknown") ?? pick("unknownKeys"));
	const errorValue = pick("error");
	return {
		id: str(source.id) || `${path}#${index}`,
		file: str(pick("file")) || (path.split("/").pop() ?? ""),
		name,
		displayName: str(pick("display_name") ?? pick("displayName")),
		description: str(pick("description")),
		path,
		scope: scopeOf(pick("scope")),
		writable: bool(pick("writable")),
		shadowed: bool(pick("shadowed")),
		enabled: bool(pick("enabled"), true),
		model: str(pick("model")),
		modelResolves: bool(pick("modelResolves") ?? pick("modelResolved"), true),
		thinking: str(pick("thinking")),
		isolation: str(pick("isolation")),
		tools: str(pick("tools")),
		maxTurns: str(pick("max_turns") ?? pick("maxTurns")),
		body: str(pick("body")),
		unknown: Object.entries(unknownSource).map(([key, value]) => ({ key, value: str(value, JSON.stringify(value)) })),
		error: typeof errorValue === "string" ? errorValue : str(record(errorValue).message),
		blocked: bool(pick("blocked")),
	};
}

/** One agent file of the server payload, flattened into the loose shape above. */
function adaptAgentFile(raw: unknown): Record<string, unknown> {
	const file = record(raw);
	const fields = record(file.fields);
	const verdict = record(file.model);
	const failure = record(file.error);
	const unknown: Record<string, unknown> = {};
	for (const key of Array.isArray(file.unknownKeys) ? file.unknownKeys : []) unknown[str(key)] = fields[str(key)];
	const unsupported = str(file.unsupported);
	return {
		id: str(file.path),
		file: file.file,
		path: file.path,
		scope: file.layer,
		writable: file.readOnly !== true,
		name: file.name,
		enabled: file.enabled,
		model: str(verdict.pin),
		modelResolves: verdict.status !== "unavailable",
		frontmatter: fields,
		unknown,
		body: file.body,
		error: str(failure.message) || unsupported,
		// A colon in `name:` is fixable here; an unreadable or block-YAML file is not.
		blocked: unsupported !== "" || str(failure.code) === "read-failed",
	};
}

/**
 * The server's own payload (plugins/subagent-config/src/index.ts `ClientState`)
 * flattened into the loose shape the normalisers above read. Any other payload
 * is passed through untouched, which is what keeps the tolerant path honest.
 */
export function adaptServerState(state: Record<string, unknown>): Record<string, unknown> {
	const agents = record(state.agents);
	if (!Array.isArray(agents.files)) return state;
	const models: Record<string, { models: Array<{ id: string; name: string }> }> = {};
	for (const raw of Array.isArray(state.models) ? state.models : []) {
		const option = record(raw);
		const provider = str(option.provider);
		(models[provider] ??= { models: [] }).models.push({ id: str(option.id), name: str(option.name) });
	}
	const settingsSource = record(state.settings);
	const layers = (Array.isArray(settingsSource.layers) ? settingsSource.layers : []).map(record);
	const layerOf = (scope: string): Record<string, unknown> =>
		record(layers.find((candidate) => candidate.scope === scope));
	const globalValues = record(layerOf("global").values);
	const projectValues = record(layerOf("project").values);
	const settings: Record<string, unknown> = {};
	for (const raw of Array.isArray(settingsSource.effective) ? settingsSource.effective : []) {
		const entry = record(raw);
		const key = str(entry.key);
		if (key === "") continue;
		settings[key] = {
			value: entry.value,
			source: entry.source ?? "default",
			globalValue: globalValues[key],
			projectValue: projectValues[key],
		};
	}
	return {
		agents: agents.files.map(adaptAgentFile),
		layers: (Array.isArray(agents.layers) ? agents.layers : []).map((raw) => {
			const layer = record(raw);
			return {
				label: layer.label,
				path: layer.dir,
				scope: layer.id,
				writable: layer.writable,
				exists: layer.exists,
				error: layer.error,
			};
		}),
		models,
		settings,
		settingsGlobalPath: layerOf("global").path,
		settingsProjectPath: layerOf("project").path,
		running: state.subagentsRunning,
	};
}

function normalizeModels(raw: unknown): ModelGroup[] {
	const groups: ModelGroup[] = [];
	const push = (provider: string, models: unknown): void => {
		const list = Array.isArray(models) ? models : [];
		const entries = list.map((item) => {
			const model = record(item);
			const id = str(model.id) || str(item);
			return { value: `${provider}/${id}`, label: str(model.name) || id };
		});
		if (entries.length > 0) groups.push({ provider, models: entries });
	};
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const group = record(item);
			push(str(group.provider), group.models);
		}
	} else {
		for (const [provider, value] of Object.entries(record(raw))) {
			const group = record(value);
			push(provider, group.models ?? value);
		}
	}
	return groups;
}

function normalizeSettings(raw: unknown): SettingView[] {
	const byKey = new Map<string, Record<string, unknown>>();
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const entry = record(item);
			const key = str(entry.key);
			if (key !== "") byKey.set(key, entry);
		}
	} else {
		for (const [key, value] of Object.entries(record(raw))) byKey.set(key, record(value));
	}
	return SETTING_SPECS.map((spec) => {
		const entry = byKey.get(spec.key) ?? {};
		return {
			key: spec.key,
			value: entry.value,
			source: str(entry.source) || (entry.value === undefined ? "default" : "unknown"),
			projectValue: entry.projectValue,
			globalValue: entry.globalValue,
		};
	});
}

/** The whole wire payload, made safe. A malformed message yields an empty page, not a crash. */
export function normalizeState(payload: unknown): ClientState {
	const source = record(payload);
	const state = adaptServerState(record(source.state ?? source));
	const agents = (Array.isArray(state.agents) ? state.agents : []).map(normalizeAgent);
	const shadowed = shadowedIds(agents);
	for (const agent of agents) if (shadowed.has(agent.id)) agent.shadowed = true;
	const live = record(state.live);
	const runningValue = state.running ?? live.running ?? live.hasRunning;
	return {
		agents,
		layers: (Array.isArray(state.layers) ? state.layers : []).map((item) => {
			const layer = record(item);
			return {
				label: str(layer.label),
				path: str(layer.path),
				scope: str(layer.scope),
				writable: bool(layer.writable),
				exists: bool(layer.exists, true),
				error: str(record(layer.error).message ?? layer.error),
			};
		}),
		models: normalizeModels(state.models),
		settings: normalizeSettings(state.settings),
		settingsProjectPath: str(state.settingsProjectPath) || ".pi/subagents.json",
		settingsGlobalPath: str(state.settingsGlobalPath) || "~/.pi/agent/subagents.json",
		running: typeof runningValue === "boolean" ? runningValue : undefined,
	};
}

/* ------------------------------------------------------------------ */
/* Pure view logic.                                                     */
/* ------------------------------------------------------------------ */

export const SCOPE_LABELS: Record<AgentScope, string> = {
	project: "Project - <cwd>/.pi/agents (editable)",
	workspace: "Workspace - <cwd>/.agents/agents (read-only)",
	global: "Global - <agent dir>/agents (editable)",
};

/** Scope order is load order: later wins, so global is listed last. */
export function groupByScope(agents: AgentView[]): Array<{ scope: AgentScope; agents: AgentView[] }> {
	return (["project", "workspace", "global"] as AgentScope[])
		.map((scope) => ({ scope, agents: agents.filter((agent) => agent.scope === scope) }))
		.filter((group) => group.agents.length > 0);
}

/** The bug this plugin exists for: an unresolvable pin is not an error, it is a silent downgrade. */
export function modelWarning(agent: { model: string; modelResolves: boolean }): string {
	if (agent.model === "") return "";
	return agent.modelResolves ? "" : `Model "${agent.model}" is unavailable - will silently inherit the parent model.`;
}

/** isolation: worktree is dropped without a word when the project switch is off. */
export function isolationWarning(agent: { isolation: string }, worktreeIsolation: unknown): string {
	if (agent.isolation !== "worktree") return "";
	return worktreeIsolation === false
		? "worktreeIsolation is off, so isolation: worktree is silently dropped for every agent."
		: "";
}

/** The extension skips a file whose frontmatter name contains a colon. */
export function validateAgentName(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "") return "A name is required.";
	if (trimmed.includes(":")) return 'A name may not contain ":" - pi-subagents skips such a file with a warning.';
	if (/[/\\]/.test(trimmed)) return "A name may not contain a path separator.";
	if (trimmed === "__proto__" || trimmed === "constructor" || trimmed === "prototype") return "That name is reserved.";
	return "";
}

/** Form text to a subagents.json value, or a message saying why not. */
export function parseSettingValue(
	key: string,
	text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const spec = SETTING_SPECS.find((candidate) => candidate.key === key);
	if (!spec) return { ok: false, error: `Unknown key ${key}.` };
	const trimmed = text.trim();
	if (trimmed === "") return { ok: true, value: undefined };
	if (spec.kind === "boolean") {
		if (trimmed === "true") return { ok: true, value: true };
		if (trimmed === "false") return { ok: true, value: false };
		return { ok: false, error: `${key} must be true or false.` };
	}
	if (spec.kind === "number") {
		const value = Number(trimmed);
		if (!Number.isFinite(value) || !Number.isInteger(value))
			return { ok: false, error: `${key} must be a whole number.` };
		if (value < spec.min || value > spec.max) {
			return {
				ok: false,
				error: `${key} must be between ${spec.min} and ${spec.max} - other values are dropped silently.`,
			};
		}
		return { ok: true, value };
	}
	return { ok: true, value: trimmed };
}

/** Empty string means "inherit parent model"; an unresolvable pin stays selectable so a save does not erase it. */
export function modelOptions(
	models: ModelGroup[],
	current: string,
	resolves = true,
): Array<{ group: string; options: Array<{ value: string; label: string }> }> {
	const groups = models.map((group) => ({
		group: group.provider,
		options: group.models.map((model) => ({ value: model.value, label: `${model.label} (${model.value})` })),
	}));
	const known = groups.some((group) => group.options.some((option) => option.value === current));
	if (current !== "" && !known) {
		groups.unshift({
			group: resolves ? "Current pin" : "Current pin (unavailable)",
			options: [{ value: current, label: current }],
		});
	}
	return groups;
}

/** An empty agent, for the "new agent" form. The file name comes from the name field on save. */
export function blankAgent(scope: AgentScope): AgentView {
	return {
		id: "",
		file: "",
		name: "",
		displayName: "",
		description: "",
		path: "",
		scope,
		writable: true,
		shadowed: false,
		enabled: true,
		model: "",
		modelResolves: true,
		thinking: "",
		isolation: "",
		tools: "",
		maxTurns: "",
		body: "",
		unknown: [],
		error: "",
		blocked: false,
	};
}

/** What the editor form holds, before it becomes a frontmatter patch. */
export interface AgentForm {
	name: string;
	description: string;
	model: string;
	thinking: string;
	isolation: string;
	tools: string;
	maxTurns: string;
	enabled: boolean;
}

/**
 * The form as the sparse frontmatter patch `saveAgent` takes: `null` removes a
 * key, so clearing a field deletes the line instead of writing an empty one, and
 * an enabled agent simply has no `enabled:` key (true is the default).
 */
export function buildAgentPatch(
	form: AgentForm,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
	const invalid = validateAgentName(form.name);
	if (invalid !== "") return { ok: false, error: invalid };
	const text = (value: string): string | null => (value.trim() === "" ? null : value.trim());
	const list = (value: string): string[] | null => {
		const items = value
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item !== "");
		return items.length === 0 ? null : items;
	};
	const turns = form.maxTurns.trim();
	if (turns !== "" && !/^\d+$/.test(turns)) return { ok: false, error: "max_turns must be a whole number." };
	return {
		ok: true,
		patch: {
			name: form.name.trim(),
			description: text(form.description),
			model: text(form.model),
			thinking: text(form.thinking),
			isolation: text(form.isolation),
			tools: list(form.tools),
			max_turns: turns === "" ? null : Number(turns),
			enabled: form.enabled ? null : false,
		},
	};
}

/** One line of provenance per subagents.json key. */
export function describeSetting(setting: SettingView): string {
	const value = setting.value === undefined ? "(unset - extension default)" : JSON.stringify(setting.value);
	return `${value} - ${setting.source}`;
}

/* ------------------------------------------------------------------ */
/* DOM.                                                                 */
/* ------------------------------------------------------------------ */

type Doc = Document;

function make(doc: Doc, tag: string, className?: string, text?: string): HTMLElement {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const doc = container?.ownerDocument;
		if (!doc || typeof container.replaceChildren !== "function") return () => {};

		const el = (tag: string, className?: string, text?: string): HTMLElement => make(doc, tag, className, text);
		const button = (label: string, onClick: () => void): HTMLButtonElement => {
			const node = el("button", undefined, label) as HTMLButtonElement;
			node.type = "button";
			node.addEventListener("click", onClick);
			return node;
		};
		const field = (form: HTMLElement, labelText: string, input: HTMLElement): void => {
			const label = el("label");
			label.append(el("span", "muted", labelText), input);
			form.append(label);
		};

		const root = el("div", "subagent-config");
		const style = el("style");
		style.textContent = STYLES;
		const error = el("div", "error");
		error.hidden = true;
		const body = el("div");
		root.append(style, error, body);
		container.append(root);

		const send = (payload: unknown): void => ctx.send(payload);
		let state: ClientState = normalizeState({});
		let selectedId = "";
		/** Set while a new agent file is being drafted, to the layer it will be written to. */
		let draft: AgentScope | undefined;

		function worktreeIsolation(): boolean | undefined {
			const value = state.settings.find((setting) => setting.key === "worktreeIsolation")?.value;
			return typeof value === "boolean" ? value : undefined;
		}

		function intro(): HTMLElement {
			const section = el("section");
			section.append(el("h4", undefined, "What this edits"));
			const list = el("ul");
			for (const layer of state.layers) {
				const item = el("li", layer.exists ? "muted" : "faint");
				item.append(
					`${layer.label} - ${layer.path}${layer.writable ? " (editable)" : " (read-only)"}${layer.exists ? "" : " - not present"}`,
				);
				if (layer.error !== "") item.append(" ", el("span", "error", layer.error));
				list.append(item);
			}
			section.append(list);
			section.append(
				el(
					"p",
					"hint",
					"pi-subagents reloads agent files on every Agent call, so an edit here takes effect on the next subagent - no restart and no /reload.",
				),
			);
			if (state.running !== undefined) {
				section.append(el("p", "hint", `Subagent activity: ${state.running ? "running" : "idle"}.`));
			}
			return section;
		}

		function agentsSection(): HTMLElement {
			const section = el("section");
			section.append(el("h4", undefined, `Agents (${state.agents.length})`));
			const actions = el("div", "row");
			actions.append(
				button("New project agent", () => startDraft("project")),
				button("New global agent", () => startDraft("global")),
			);
			section.append(actions);
			if (state.agents.length === 0) {
				section.append(
					el(
						"p",
						"muted",
						"No agent files were found. Every subagent therefore inherits the main session model - add one below to pin a model.",
					),
				);
			}
			for (const group of groupByScope(state.agents)) {
				section.append(el("h4", "muted", SCOPE_LABELS[group.scope]));
				const table = el("table") as HTMLTableElement;
				const head = el("tr");
				for (const label of ["Agent", "Model", "Thinking", "Isolation", "State", ""])
					head.append(el("th", undefined, label));
				table.append(head);
				for (const agent of group.agents) table.append(agentRow(agent));
				section.append(table);
			}
			return section;
		}

		function agentRow(agent: AgentView): HTMLElement {
			const row = el("tr", agent.enabled && !agent.shadowed ? undefined : "off");
			const name = el("td", "name", agent.name);
			if (agent.shadowed) name.append(" ", el("span", "amber", "(shadowed - a later layer wins)"));
			if (agent.error !== "") name.append(" ", el("span", "error", agent.error));
			row.append(name);

			const model = el("td");
			model.append(el("span", undefined, agent.model === "" ? "inherits parent model" : agent.model));
			const warning = modelWarning(agent);
			if (warning !== "") model.append(el("div", "warn", warning));
			row.append(model);

			row.append(el("td", undefined, agent.thinking || "-"));

			const isolation = el("td");
			isolation.append(el("span", undefined, agent.isolation || "-"));
			const dropped = isolationWarning(agent, worktreeIsolation());
			if (dropped !== "") isolation.append(el("div", "amber", dropped));
			row.append(isolation);

			row.append(el("td", undefined, agent.enabled ? "enabled" : "disabled"));

			const actions = el("td", "actions");
			actions.append(button(agent.writable ? "Edit" : "View", () => select(agent.id)));
			row.append(actions);
			return row;
		}

		function editorSection(): HTMLElement {
			const section = el("section");
			const agent = draft ? blankAgent(draft) : state.agents.find((candidate) => candidate.id === selectedId);
			if (!agent) return section;
			section.append(
				el("h4", undefined, draft ? `New ${draft} agent` : `${agent.writable ? "Edit" : "View"} ${agent.name}`),
			);
			section.append(el("p", "hint", draft ? SCOPE_LABELS[draft] : agent.path));
			if (!agent.writable) {
				section.append(
					el("p", "amber", "This layer is read-only - copy the agent into the project layer to change it."),
				);
			}
			if (agent.blocked) {
				section.append(el("p", "banner", `This file is shown read-only: ${agent.error}`));
				return section;
			}
			if (agent.error !== "") section.append(el("p", "banner", agent.error));

			const form = el("form") as HTMLFormElement;
			const formError = el("div", "error");
			formError.hidden = true;

			const name = doc.createElement("input");
			name.type = "text";
			name.value = agent.name;
			field(form, "Name", name);

			const description = doc.createElement("input");
			description.type = "text";
			description.value = agent.description;
			field(form, "Description", description);

			const model = doc.createElement("select");
			const inherit = doc.createElement("option");
			inherit.value = "";
			inherit.textContent = "inherit parent model";
			model.append(inherit);
			for (const group of modelOptions(state.models, agent.model, agent.modelResolves)) {
				const optgroup = doc.createElement("optgroup");
				optgroup.label = group.group;
				for (const option of group.options) {
					const node = doc.createElement("option");
					node.value = option.value;
					node.textContent = option.label;
					optgroup.append(node);
				}
				model.append(optgroup);
			}
			model.value = agent.model;
			field(form, "Model", model);
			const modelNote = el("div", "warn", modelWarning(agent));
			modelNote.hidden = modelWarning(agent) === "";
			form.append(modelNote);

			const thinking = doc.createElement("select");
			for (const level of THINKING_LEVELS) {
				const node = doc.createElement("option");
				node.value = level;
				node.textContent = level === "" ? "(unset)" : level;
				thinking.append(node);
			}
			thinking.value = agent.thinking;
			field(form, "Thinking", thinking);

			const isolation = doc.createElement("select");
			for (const level of ISOLATION_LEVELS) {
				const node = doc.createElement("option");
				node.value = level;
				node.textContent = level === "" ? "(unset)" : level;
				isolation.append(node);
			}
			isolation.value = agent.isolation;
			field(form, "Isolation", isolation);
			form.append(
				el(
					"div",
					"amber",
					`subagents.json worktreeIsolation is ${JSON.stringify(worktreeIsolation() ?? "unset")} - when it is false, isolation: worktree is dropped silently.`,
				),
			);

			const tools = doc.createElement("input");
			tools.type = "text";
			tools.value = agent.tools;
			field(form, "Tools (comma separated)", tools);

			const maxTurns = doc.createElement("input");
			maxTurns.type = "text";
			maxTurns.value = agent.maxTurns;
			field(form, "max_turns", maxTurns);

			const enabled = doc.createElement("input");
			enabled.type = "checkbox";
			enabled.checked = agent.enabled;
			field(form, "Enabled", enabled);

			const promptBody = doc.createElement("textarea");
			promptBody.rows = 10;
			promptBody.value = agent.body;
			field(form, "System prompt", promptBody);

			if (agent.unknown.length > 0) {
				const list = el("ul");
				for (const entry of agent.unknown) list.append(el("li", "muted", `${entry.key}: ${entry.value}`));
				const wrapper = el("div");
				wrapper.append(el("div", "muted", "Other frontmatter keys (kept as-is on save)"), list);
				form.append(wrapper);
			}

			form.addEventListener("submit", (event) => {
				event.preventDefault();
				formError.hidden = true;
				const built = buildAgentPatch({
					name: name.value,
					description: description.value,
					model: model.value,
					thinking: thinking.value,
					isolation: isolation.value,
					tools: tools.value,
					maxTurns: maxTurns.value,
					enabled: enabled.checked,
				});
				if (!built.ok) {
					formError.textContent = built.error;
					formError.hidden = false;
					return;
				}
				send({
					action: "saveAgent",
					layer: agent.scope,
					file: agent.file === "" ? `${name.value.trim()}.md` : agent.file,
					frontmatter: built.patch,
					body: promptBody.value,
				});
				draft = undefined;
			});

			if (agent.writable) {
				const submit = el("button", undefined, draft ? "Create agent" : "Save agent") as HTMLButtonElement;
				submit.type = "submit";
				form.append(submit);
				if (!draft) {
					form.append(
						button("Delete agent", () => send({ action: "deleteAgent", layer: agent.scope, file: agent.file })),
					);
				}
			} else {
				for (const node of [name, description, model, thinking, isolation, tools, maxTurns, enabled, promptBody]) {
					(node as HTMLInputElement).disabled = true;
				}
			}
			form.append(formError);
			section.append(form);
			return section;
		}

		function settingsSection(): HTMLElement {
			const section = el("section");
			section.append(el("h4", undefined, "subagents.json"));
			const hint = el("p", "hint");
			hint.append(
				"Project values are written to ",
				el("code", undefined, state.settingsProjectPath),
				" and override the read-only global defaults in ",
				el("code", undefined, state.settingsGlobalPath),
				". Values outside the sanitizer range are dropped silently, so they are rejected here first.",
			);
			section.append(hint);

			const table = el("table") as HTMLTableElement;
			const head = el("tr");
			for (const label of ["Key", "Effective", "Global", "Project", ""]) head.append(el("th", undefined, label));
			table.append(head);
			for (const setting of state.settings) table.append(settingRow(setting));
			section.append(table);
			return section;
		}

		function settingRow(setting: SettingView): HTMLElement {
			const spec = SETTING_SPECS.find((candidate) => candidate.key === setting.key);
			const row = el("tr");
			const key = el("td", "name", setting.key);
			if (setting.key === "worktreeIsolation") {
				key.append(" ", el("span", "amber", "(off drops every isolation: worktree)"));
			}
			row.append(key);
			row.append(el("td", undefined, describeSetting(setting)));
			row.append(el("td", "muted", setting.globalValue === undefined ? "-" : JSON.stringify(setting.globalValue)));

			const editCell = el("td");
			const input = doc.createElement("input");
			input.type = "text";
			input.value = setting.projectValue === undefined ? "" : String(setting.projectValue);
			input.placeholder =
				spec?.kind === "boolean" ? "true / false" : spec?.kind === "number" ? `${spec.min}..${spec.max}` : "(unset)";
			editCell.append(input);
			const cellError = el("div", "error");
			cellError.hidden = true;
			editCell.append(cellError);
			row.append(editCell);

			const actions = el("td", "actions");
			actions.append(
				button("Apply", () => {
					const parsed = parseSettingValue(setting.key, input.value);
					if (!parsed.ok) {
						cellError.textContent = parsed.error;
						cellError.hidden = false;
						return;
					}
					cellError.hidden = true;
					send({
						action: "saveSettings",
						scope: "project",
						values: { [setting.key]: parsed.value === undefined ? null : parsed.value },
					});
				}),
			);
			row.append(actions);
			return row;
		}

		function select(id: string): void {
			selectedId = id;
			draft = undefined;
			render();
		}

		function startDraft(scope: AgentScope): void {
			draft = scope;
			selectedId = "";
			render();
		}

		function render(): void {
			error.hidden = true;
			const header = el("div");
			header.append(el("h3", undefined, "Subagent configuration"));
			header.append(
				el(
					"p",
					"hint",
					"Edit pi-subagents agent files and subagents.json. An agent with no model pin inherits the main session model - that is why a subagent can run on a model you never chose.",
				),
			);
			const actions = el("div", "row");
			actions.append(button("Refresh", () => send({ action: "list" })));
			header.append(actions);
			body.replaceChildren(header, intro(), agentsSection(), editorSection(), settingsSection());
		}

		function showError(message: string): void {
			error.textContent = message;
			error.hidden = false;
		}

		const off = ctx.onData((payload) => {
			const message = record(payload);
			if (message.type === "state") {
				state = normalizeState(message);
				render();
			} else if (message.type === "error") {
				showError(`${str(message.action) || "request"} failed: ${str(message.message)}`);
			}
		});

		render();
		send({ action: "list" });
		return () => {
			off();
			root.remove();
		};
	},
};

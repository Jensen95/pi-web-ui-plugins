/**
 * A typed, recording mock of the pi-web-ui plugin host.
 *
 * The shapes below mirror the real contract in pi-web-ui's server/plugins.ts
 * (PluginHost, PluginToolEvent, PluginRunEvent, PluginConversationSnapshot,
 * PluginAgentTool, PluginCommandDef) and docs/architecture-plugins.md, so a
 * plugin's `activate(host)` typechecks here and behaves the same way.
 *
 * Fidelity - these host rules are reproduced because they are observable:
 *   - Every registration method returns an unsubscribe function; once called, the
 *     handler no longer fires and the registration disappears from `recorded`.
 *   - Capability gating by manifest.permissions family (the part before ":"):
 *     registerAgentTool needs "tools", route needs "http", host.fs needs "fs".
 *     With permissions declared, an ungated call is refused and recorded in
 *     `recorded.rejections`. With NO permissions declared (and apiVersion < 2) the
 *     host is in legacy full-access mode: it allows the call and records one
 *     warning in `recorded.legacyWarnings`.
 *   - registerAgentTool refuses a tool missing name/description/execute, and
 *     refuses a duplicate tool name.
 *   - registerCommand strips leading slashes, refuses a name that does not match
 *     ^[a-zA-Z][a-zA-Z0-9:_-]*$, refuses a missing run(), refuses a duplicate
 *     name, and stores the command under its NORMALIZED name.
 *   - route uppercases the method, refuses a method outside GET/POST/PUT/DELETE,
 *     a path not starting with "/", or a non-function handler, and keys routes as
 *     "METHOD /path".
 *   - registerBackgroundTask refuses an empty or duplicate id and returns a
 *     no-op handle when it does; update() after unregister() is ignored.
 *   - host.fs is anchored to the workspace root: absolute paths and paths that
 *     escape it ("../x") are rejected, matching WorkspaceFS.
 *   - handleMessage dispatches to every registered onMessage handler in
 *     registration order.
 *
 * Deliberate deviations, chosen for testability:
 *   - The real host isolates plugin failures (it logs a throwing handler and
 *     carries on) and does not await async message handlers. This mock instead
 *     rethrows and awaits, so a broken handler fails the test instead of being
 *     silently swallowed and so assertions after `await emit.*` are deterministic.
 *   - The real host logs registrations and refusals to the console. This mock
 *     prints nothing; everything lands in `recorded` instead.
 *   - storage/secrets/fs are in-memory. Nothing is written to disk.
 *
 * There is no DOM here: vitest runs with environment "node", so client-side
 * mount()/renderer tests must either supply their own element stub or be limited
 * to the pure helpers a client module exports. `createMockViewContext()` covers
 * the narrow send/onData channel that views and fence renderers receive.
 */
import { isAbsolute, join, normalize, posix } from "node:path";

// ---------------------------------------------------------------------------
// Host contract shapes
// ---------------------------------------------------------------------------

/** One content block inside a message. The real UiContentBlock is a union of
 *  text/thinking/toolCall/image/bash blocks plus an open fallback; plugins read
 *  `type` and then narrow, so an open record is the faithful minimal shape. */
export interface MockContentBlock {
	type: string;
	[key: string]: unknown;
}

/** A chat message as the host hands it to plugins (UiMessage). */
export interface MockMessage {
	id: string;
	role: string;
	content: MockContentBlock[];
	/** Any other UiMessage field a test wants to supply (toolName, isError, ...). */
	[key: string]: unknown;
}

/** SDK tool execution event forwarded to host.onToolEvent. */
export interface MockToolEvent {
	phase: "start" | "end";
	toolName: string;
	conversationId?: string;
	toolCallId?: string;
	durationMs?: number;
	isError?: boolean;
}

/** Agent run-trace event forwarded to host.onRunEvent. One user task produces
 *  run_start -> (turn_start/message/tool_start/tool_end ... interleaved) -> run_end. */
export interface MockRunEvent {
	type: "run_start" | "run_end" | "turn_start" | "turn_end" | "message" | "tool_start" | "tool_end";
	conversationId?: string;
	at: number;
	task?: string;
	message?: MockMessage;
	toolCallId?: string;
	toolName?: string;
	argsText?: string;
	resultText?: string;
	durationMs?: number;
	isError?: boolean;
	stopReason?: string;
}

/** Snapshot returned by host.getActiveConversation(); null means none is open. */
export interface MockConversationSnapshot {
	conversationId: string;
	title: string;
	at: number;
	isStreaming: boolean;
	messages: MockMessage[];
	streamingMessage: MockMessage | null;
	stats: {
		totalMessages: number;
		tokens: { input: number; output: number; total: number };
		cost: number;
	};
}

/** A tool a plugin exposes to the AI (host.registerAgentTool). */
export interface MockAgentTool {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** A slash command a plugin registers (host.registerCommand). This repo is
 *  English-only: put the English text in `description` / `argumentHint` and leave
 *  the `*En` fields unset - they exist only because the host contract has them. */
export interface MockCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** Argument to host.registerBackgroundTask. */
export interface MockBackgroundTaskDef {
	id: string;
	label: string;
	stop?: () => void;
	status?: string;
}

/** A live background task as the host tracks it. */
export interface MockBackgroundTask extends MockBackgroundTaskDef {
	since: number;
}

/** Handle returned by host.registerBackgroundTask. */
export interface MockBackgroundTaskHandle {
	update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
	unregister(): void;
}

/** Request a plugin's host.route handler receives. Express is not a dependency
 *  here, so this is the structural subset the host actually guarantees. */
export interface MockRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	params: Record<string, string>;
	headers: Record<string, string | undefined>;
	body: unknown;
	[key: string]: unknown;
}

/** Response object handed to a host.route handler; captures what was written. */
export interface MockResponse {
	statusCode: number;
	/** Body passed to json()/send(); undefined until one of them is called. */
	body: unknown;
	headers: Record<string, string>;
	/** True once json()/send()/end() finished the response. */
	finished: boolean;
	status(code: number): MockResponse;
	set(field: string, value: string): MockResponse;
	json(value: unknown): MockResponse;
	send(value?: unknown): MockResponse;
	end(): void;
	[key: string]: unknown;
}

export type MockRouteHandler = (req: MockRequest, res: MockResponse) => void;

/** Workspace file access (host.fs), anchored to the current workspace root. */
export interface MockWorkspaceFs {
	list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
	read(relPath: string): Promise<Buffer>;
	readText(relPath: string, maxBytes?: number): Promise<string>;
	write(relPath: string, data: string | Uint8Array): Promise<void>;
	remove(relPath: string): Promise<void>;
}

/** The host object a plugin's activate() receives. */
export interface MockPluginHost {
	/** The plugin's own directory (<dataDir>/plugins/<id>). */
	dir: string;
	/** The global data directory (~/.pi-web). */
	dataDir: string;
	/** Live workspace root; changes when emit.notifyCwd() fires. */
	cwd: string;
	broadcast(payload: unknown): void;
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	sendTo(clientId: string, payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onAttach(handler: (clientId: string) => void): () => void;
	onToolEvent(handler: (ev: MockToolEvent) => void): () => void;
	onRunEvent(handler: (ev: MockRunEvent) => void): () => void;
	onConversationChanged(handler: () => void): () => void;
	onCwdChange(handler: (cwd: string) => void): () => void;
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	getActiveConversation(): MockConversationSnapshot | null;
	registerAgentTool(tool: MockAgentTool): () => void;
	registerCommand(cmd: MockCommandDef): () => void;
	registerBackgroundTask(task: MockBackgroundTaskDef): MockBackgroundTaskHandle;
	route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: MockRouteHandler): () => void;
	getSettings(): Record<string, unknown>;
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
	};
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	fs: MockWorkspaceFs;
	log(...args: unknown[]): void;
}

/** What a plugin's compiled index.mjs default export looks like to the host.
 *  activate() may return the deactivate function directly (that is the only
 *  cleanup the host honours - a separate `deactivate` property is ignored). */
export interface PluginServerEntry {
	activate(host: MockPluginHost): ActivateResult;
}

/** activate()'s return value: nothing, a cleanup function, or a promise of either. */
export type ActivateResult = void | (() => void) | Promise<void | (() => void)>;

// ---------------------------------------------------------------------------
// Client-side contract (views and fence renderers)
// ---------------------------------------------------------------------------

/** The narrow channel a view's mount() or a fence renderer receives. */
export interface MockViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

/** A fenced-code renderer: returns DOM, or null to fall back to a plain block. */
export type MockFenceRenderer = (code: string, ctx: MockViewContext) => unknown | null | Promise<unknown | null>;

/** What a compiled client/entry.mjs default export looks like to the frontend. */
export interface PluginClientEntry {
	mount?(container: unknown, ctx: MockViewContext): void | (() => void);
	renderers?: Record<string, MockFenceRenderer>;
}

// ---------------------------------------------------------------------------
// Recording surface
// ---------------------------------------------------------------------------

/** A registration or call the host refused. */
export interface MockRejection {
	/** Host API that refused the call, e.g. "registerAgentTool". */
	api: string;
	reason: string;
}

/** Everything a plugin did to the host, for assertions. */
export interface MockRecorded {
	/** Payloads passed to broadcast(), in call order. */
	broadcasts: unknown[];
	/** Every notify() call. */
	notifications: { level: "info" | "warning" | "error"; text: string; textEn?: string }[];
	/** Every sendTo() call. */
	sent: { clientId: string; payload: unknown }[];
	/** Arguments of every host.log() call. */
	logs: unknown[][];
	/** Specs arrays passed to ensureDeps(), in call order. */
	ensureDepsCalls: string[][];
	/** Currently registered AI tools, keyed by tool name. */
	agentTools: Map<string, MockAgentTool>;
	/** Currently registered slash commands, keyed by normalized name. */
	commands: Map<string, MockCommandDef>;
	/** Currently registered HTTP routes, keyed by "METHOD /path". */
	routes: Map<string, MockRouteHandler>;
	/** Currently registered background tasks, keyed by id. */
	backgroundTasks: Map<string, MockBackgroundTask>;
	/** Calls the host refused (validation failure or missing capability). */
	rejections: MockRejection[];
	/** Legacy full-access warnings (at most one, like the real host). */
	legacyWarnings: string[];
	/** Live storage contents. */
	storage: Map<string, unknown>;
	/** Live secrets contents. */
	secrets: Map<string, string>;
	/** In-memory workspace files, keyed by relative posix path. */
	files: Map<string, string>;
	/** Registered handlers per extension point, in registration order. */
	handlers: {
		message: Set<(payload: unknown, from?: string) => void>;
		attach: Set<(clientId: string) => void>;
		toolEvent: Set<(ev: MockToolEvent) => void>;
		runEvent: Set<(ev: MockRunEvent) => void>;
		conversationChanged: Set<() => void>;
		cwdChange: Set<(cwd: string) => void>;
		settingsChanged: Set<(values: Record<string, unknown>) => void>;
	};
}

/** Invoke registered handlers the way the host does. Always await these. Each
 *  returns the number of handlers that were invoked. */
export interface MockEmit {
	message(payload: unknown, from?: string): Promise<number>;
	attach(clientId: string): Promise<number>;
	toolEvent(ev: MockToolEvent): Promise<number>;
	runEvent(ev: MockRunEvent): Promise<number>;
	conversationChanged(): Promise<number>;
	/** Mirrors the host's notifyCwd(): updates host.cwd, then fires onCwdChange. */
	notifyCwd(cwd: string): Promise<number>;
	settingsChanged(values: Record<string, unknown>): Promise<number>;
}

/** The mock host: the real contract plus inspection and trigger surfaces. */
export interface MockHost extends MockPluginHost {
	recorded: MockRecorded;
	emit: MockEmit;
	agentTool(name: string): MockAgentTool | undefined;
	command(name: string): MockCommandDef | undefined;
	routeHandler(method: string, path: string): MockRouteHandler | undefined;
	backgroundTask(id: string): MockBackgroundTask | undefined;
	/** Build a response object and run a registered route handler against it. */
	callRoute(method: string, path: string, req?: Partial<MockRequest>): Promise<MockResponse>;
}

/** Knobs for createMockHost(). Every field is optional; the defaults describe a
 *  legacy plugin with no declared permissions and an empty workspace. */
export interface MockHostOverrides {
	dir?: string;
	dataDir?: string;
	cwd?: string;
	/** manifest.permissions. Omit or pass [] for legacy full-access mode. */
	permissions?: string[];
	/** manifest.apiVersion; 2 and above force strict capability gating. */
	apiVersion?: number;
	/** Value returned by getActiveConversation(). */
	activeConversation?: MockConversationSnapshot | null;
	/** Value returned by getSettings(). */
	settings?: Record<string, unknown>;
	/** Initial storage contents. */
	storage?: Record<string, unknown>;
	/** Initial secrets contents. */
	secrets?: Record<string, string>;
	/** Initial in-memory workspace files for host.fs, keyed by relative path. */
	files?: Record<string, string>;
	/** What ensureDeps resolves to (default true). */
	ensureDepsResult?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Command names the host accepts (server/plugins.ts registerCommand). */
const COMMAND_NAME_RE = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

function createResponse(): MockResponse {
	const res: MockResponse = {
		statusCode: 200,
		body: undefined,
		headers: {},
		finished: false,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		set(field: string, value: string) {
			res.headers[field.toLowerCase()] = value;
			return res;
		},
		json(value: unknown) {
			res.body = value;
			res.headers["content-type"] = "application/json";
			res.finished = true;
			return res;
		},
		send(value?: unknown) {
			res.body = value;
			res.finished = true;
			return res;
		},
		end() {
			res.finished = true;
		},
	};
	return res;
}

/** Anchor a plugin-supplied path inside the workspace root the way WorkspaceFS
 *  does, returning the normalized relative path or null when it escapes. */
function anchor(relPath: string): string | null {
	if (typeof relPath !== "string" || relPath === "" || isAbsolute(relPath)) return null;
	const normalized = normalize(relPath).split(/[\\/]/).join(posix.sep);
	if (normalized === ".." || normalized.startsWith(`..${posix.sep}`)) return null;
	return normalized.replace(/^\.\//, "");
}

/** anchor() with the distinct error a plugin should see when it reaches outside
 *  the workspace, as opposed to a path that is simply not there. */
function anchored(relPath: string): string {
	const key = anchor(relPath);
	if (key === null) throw new Error(`path escapes the workspace root: ${String(relPath)}`);
	return key;
}

export function createMockHost(overrides: MockHostOverrides = {}): MockHost {
	const tmp = join("/tmp", "pi-web-ui-plugins-mock");
	const permissions = overrides.permissions ?? [];
	const apiVersion = overrides.apiVersion ?? 1;
	const strict = permissions.length > 0 || apiVersion >= 2;
	const families = new Set(permissions.map((perm) => perm.split(":")[0] ?? perm));

	const recorded: MockRecorded = {
		broadcasts: [],
		notifications: [],
		sent: [],
		logs: [],
		ensureDepsCalls: [],
		agentTools: new Map(),
		commands: new Map(),
		routes: new Map(),
		backgroundTasks: new Map(),
		rejections: [],
		legacyWarnings: [],
		storage: new Map(Object.entries(overrides.storage ?? {})),
		secrets: new Map(Object.entries(overrides.secrets ?? {})),
		files: new Map(Object.entries(overrides.files ?? {})),
		handlers: {
			message: new Set(),
			attach: new Set(),
			toolEvent: new Set(),
			runEvent: new Set(),
			conversationChanged: new Set(),
			cwdChange: new Set(),
			settingsChanged: new Set(),
		},
	};

	let legacyWarned = false;

	/** Capability gate: declared family wins, legacy mode warns once, else refuse. */
	function can(family: string, api: string): boolean {
		if (families.has(family)) return true;
		if (!strict) {
			if (!legacyWarned) {
				legacyWarned = true;
				recorded.legacyWarnings.push(
					`manifest declares no permissions (legacy full-access mode) - allowed "${family}"`,
				);
			}
			return true;
		}
		recorded.rejections.push({ api, reason: `missing capability "${family}" (manifest.permissions)` });
		return false;
	}

	function refuse(api: string, reason: string): void {
		recorded.rejections.push({ api, reason });
	}

	const noop = () => {};

	const files = recorded.files;

	const fs: MockWorkspaceFs = {
		async list(relDir) {
			if (!can("fs", "fs.list")) return Promise.reject(denied("fs"));
			const dir = anchored(relDir ?? ".");
			const prefix = dir === "." ? "" : `${dir}/`;
			const names = new Map<string, "file" | "dir">();
			for (const key of files.keys()) {
				if (prefix !== "" && !key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest === "") continue;
				const slash = rest.indexOf("/");
				if (slash === -1) names.set(rest, "file");
				else names.set(rest.slice(0, slash), "dir");
			}
			return [...names].map(([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
		},
		async read(relPath) {
			if (!can("fs", "fs.read")) return Promise.reject(denied("fs"));
			return Buffer.from(await fs.readText(relPath), "utf8");
		},
		async readText(relPath, maxBytes) {
			if (!can("fs", "fs.readText")) return Promise.reject(denied("fs"));
			const key = anchored(relPath);
			if (!files.has(key)) throw new Error(`ENOENT: no such file, read '${relPath}'`);
			const text = files.get(key) ?? "";
			if (typeof maxBytes === "number" && maxBytes >= 0) {
				return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
			}
			return text;
		},
		async write(relPath, data) {
			if (!can("fs", "fs.write")) return Promise.reject(denied("fs"));
			files.set(anchored(relPath), typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
		},
		async remove(relPath) {
			if (!can("fs", "fs.remove")) return Promise.reject(denied("fs"));
			const key = anchored(relPath);
			if (!files.delete(key)) throw new Error(`ENOENT: no such file, remove '${relPath}'`);
		},
	};

	function denied(family: string): Error {
		return new Error(`plugin did not declare capability "${family}" (manifest.permissions) - request refused`);
	}

	const host: MockHost = {
		dir: overrides.dir ?? join(tmp, "plugins", "mock-plugin"),
		dataDir: overrides.dataDir ?? tmp,
		cwd: overrides.cwd ?? join(tmp, "workspace"),

		broadcast(payload) {
			recorded.broadcasts.push(payload);
		},
		notify(level, text, textEn) {
			recorded.notifications.push(textEn === undefined ? { level, text } : { level, text, textEn });
		},
		sendTo(clientId, payload) {
			recorded.sent.push({ clientId, payload });
		},
		log(...args) {
			recorded.logs.push(args);
		},

		onMessage(handler) {
			recorded.handlers.message.add(handler);
			return () => {
				recorded.handlers.message.delete(handler);
			};
		},
		onAttach(handler) {
			recorded.handlers.attach.add(handler);
			return () => {
				recorded.handlers.attach.delete(handler);
			};
		},
		onToolEvent(handler) {
			recorded.handlers.toolEvent.add(handler);
			return () => {
				recorded.handlers.toolEvent.delete(handler);
			};
		},
		onRunEvent(handler) {
			recorded.handlers.runEvent.add(handler);
			return () => {
				recorded.handlers.runEvent.delete(handler);
			};
		},
		onConversationChanged(handler) {
			recorded.handlers.conversationChanged.add(handler);
			return () => {
				recorded.handlers.conversationChanged.delete(handler);
			};
		},
		onCwdChange(handler) {
			recorded.handlers.cwdChange.add(handler);
			return () => {
				recorded.handlers.cwdChange.delete(handler);
			};
		},
		onSettingsChanged(handler) {
			recorded.handlers.settingsChanged.add(handler);
			return () => {
				recorded.handlers.settingsChanged.delete(handler);
			};
		},

		getActiveConversation() {
			return overrides.activeConversation ?? null;
		},
		getSettings() {
			return { ...overrides.settings };
		},

		registerAgentTool(tool) {
			if (!can("tools", "registerAgentTool")) return noop;
			if (!tool || typeof tool.execute !== "function" || !tool.name || !tool.description) {
				refuse("registerAgentTool", "missing name, description or execute");
				return noop;
			}
			if (recorded.agentTools.has(tool.name)) {
				refuse("registerAgentTool", `tool "${tool.name}" is already registered`);
				return noop;
			}
			recorded.agentTools.set(tool.name, tool);
			return () => {
				recorded.agentTools.delete(tool.name);
			};
		},

		registerCommand(cmd) {
			const name = String(cmd?.name ?? "").replace(/^\/+/, "");
			if (!COMMAND_NAME_RE.test(name)) {
				refuse("registerCommand", `invalid name "${String(cmd?.name ?? "")}"`);
				return noop;
			}
			if (typeof cmd?.run !== "function") {
				refuse("registerCommand", `command "${name}" has no run()`);
				return noop;
			}
			if (recorded.commands.has(name)) {
				refuse("registerCommand", `command "/${name}" is already registered`);
				return noop;
			}
			const def: MockCommandDef = { ...cmd, name };
			recorded.commands.set(name, def);
			return () => {
				if (recorded.commands.get(name) === def) recorded.commands.delete(name);
			};
		},

		route(method, path, handler) {
			if (!can("http", "route")) return noop;
			const m = String(method ?? "GET").toUpperCase();
			if (!ROUTE_METHODS.has(m) || typeof path !== "string" || !path.startsWith("/") || typeof handler !== "function") {
				refuse("route", `invalid arguments (method=${String(method)} path=${String(path)})`);
				return noop;
			}
			const key = `${m} ${path}`;
			recorded.routes.set(key, handler);
			return () => {
				recorded.routes.delete(key);
			};
		},

		registerBackgroundTask(task) {
			const id = String(task?.id ?? "").trim();
			if (!id || recorded.backgroundTasks.has(id)) {
				refuse("registerBackgroundTask", `invalid or duplicate id "${String(task?.id ?? "")}"`);
				return { update: noop, unregister: noop };
			}
			const entry: MockBackgroundTask = {
				id,
				label: String(task?.label ?? id),
				since: Date.now(),
				...(typeof task?.stop === "function" ? { stop: task.stop } : {}),
				...(typeof task?.status === "string" ? { status: task.status } : {}),
			};
			recorded.backgroundTasks.set(id, entry);
			return {
				update(next) {
					if (!recorded.backgroundTasks.has(id)) return;
					if (next.label !== undefined) entry.label = String(next.label);
					if (next.status !== undefined) entry.status = next.status;
					if (typeof next.stop === "function") entry.stop = next.stop;
				},
				unregister() {
					recorded.backgroundTasks.delete(id);
				},
			};
		},

		storage: {
			get<T>(key: string, fallback?: T): T | undefined {
				return recorded.storage.has(key) ? (recorded.storage.get(key) as T) : fallback;
			},
			set(key, value) {
				recorded.storage.set(key, value);
			},
			delete(key) {
				recorded.storage.delete(key);
			},
			all() {
				return Object.fromEntries(recorded.storage);
			},
		},

		secrets: {
			set(name, value) {
				recorded.secrets.set(name, value);
			},
			get(name) {
				return recorded.secrets.get(name);
			},
			has(name) {
				return recorded.secrets.has(name);
			},
			delete(name) {
				recorded.secrets.delete(name);
			},
			list() {
				return [...recorded.secrets.keys()];
			},
		},

		async ensureDeps(specs, opts) {
			const list = Array.isArray(specs) ? specs : [];
			recorded.ensureDepsCalls.push(list);
			if (opts?.onProgress) opts.onProgress(`installing ${list.join(" ")}`);
			return overrides.ensureDepsResult ?? true;
		},

		fs,

		recorded,

		emit: {
			async message(payload, from) {
				const handlers = [...recorded.handlers.message];
				for (const handler of handlers) await handler(payload, from);
				return handlers.length;
			},
			async attach(clientId) {
				const handlers = [...recorded.handlers.attach];
				for (const handler of handlers) await handler(clientId);
				return handlers.length;
			},
			async toolEvent(ev) {
				const handlers = [...recorded.handlers.toolEvent];
				for (const handler of handlers) await handler(ev);
				return handlers.length;
			},
			async runEvent(ev) {
				const handlers = [...recorded.handlers.runEvent];
				for (const handler of handlers) await handler(ev);
				return handlers.length;
			},
			async conversationChanged() {
				const handlers = [...recorded.handlers.conversationChanged];
				for (const handler of handlers) await handler();
				return handlers.length;
			},
			async notifyCwd(cwd) {
				host.cwd = cwd;
				const handlers = [...recorded.handlers.cwdChange];
				for (const handler of handlers) await handler(cwd);
				return handlers.length;
			},
			async settingsChanged(values) {
				const handlers = [...recorded.handlers.settingsChanged];
				for (const handler of handlers) await handler(values);
				return handlers.length;
			},
		},

		agentTool(name) {
			return recorded.agentTools.get(name);
		},
		command(name) {
			return recorded.commands.get(name.replace(/^\/+/, ""));
		},
		routeHandler(method, path) {
			return recorded.routes.get(`${method.toUpperCase()} ${path}`);
		},
		backgroundTask(id) {
			return recorded.backgroundTasks.get(id);
		},
		async callRoute(method, path, req) {
			const handler = host.routeHandler(method, path);
			if (!handler) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
			const res = createResponse();
			await handler(
				{
					method: method.toUpperCase(),
					path,
					query: {},
					params: {},
					headers: {},
					body: undefined,
					...req,
				},
				res,
			);
			return res;
		},
	};

	return host;
}

/** Run a plugin's server entry against a fresh mock host and hand back both.
 *  The returned deactivate is the function activate() returned, which is the only
 *  cleanup the real host honours. */
export async function activatePlugin(
	entry: PluginServerEntry,
	overrides?: MockHostOverrides,
): Promise<{ host: MockHost; deactivate: (() => void) | undefined }> {
	const host = createMockHost(overrides);
	const ret = await entry.activate(host);
	return { host, deactivate: typeof ret === "function" ? ret : undefined };
}

/** The narrow view/renderer channel, recording what the plugin sends upstream. */
export interface MockViewContextRecorder {
	ctx: MockViewContext;
	/** Payloads the plugin passed to ctx.send(), in call order. */
	sent: unknown[];
	/** Push a payload down to every subscriber registered via ctx.onData(). */
	push(payload: unknown): number;
	/** Currently subscribed onData callbacks. */
	subscribers: Set<(payload: unknown) => void>;
}

export function createMockViewContext(pluginId = "mock-plugin"): MockViewContextRecorder {
	const sent: unknown[] = [];
	const subscribers = new Set<(payload: unknown) => void>();
	const ctx: MockViewContext = {
		pluginId,
		send(payload) {
			sent.push(payload);
		},
		onData(cb) {
			subscribers.add(cb);
			return () => {
				subscribers.delete(cb);
			};
		},
	};
	return {
		ctx,
		sent,
		subscribers,
		push(payload) {
			const targets = [...subscribers];
			for (const cb of targets) cb(payload);
			return targets.length;
		},
	};
}

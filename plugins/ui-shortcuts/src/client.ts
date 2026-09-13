/** Keyboard shortcuts for switching views and triggering common pi-web-ui actions. */

export interface Shortcut {
	readonly key: string;
	readonly label: string;
	readonly view: string;
}

export const SHORTCUTS = [
	{ key: "t", label: "Terminal", view: "terminal" },
	{ key: "e", label: "Editor", view: "plugin:vscode-editor" },
	{ key: "r", label: "Run Trace", view: "plugin:run-trace" },
] as const satisfies readonly Shortcut[];

export type ShortcutAction =
	| { type: "view"; view: string }
	| { type: "compose"; text: string }
	| { type: "startChat"; prompt: string; newChat: boolean };

export interface ShortcutBinding {
	readonly id: string;
	readonly shortcut: string;
	readonly label: string;
	readonly action: ShortcutAction;
	readonly builtin?: boolean;
}

export const DEFAULT_BINDINGS: readonly ShortcutBinding[] = [
	{
		id: "terminal",
		shortcut: "Mod+Alt+T",
		label: "Terminal",
		action: { type: "view", view: "terminal" },
		builtin: true,
	},
	{
		id: "editor",
		shortcut: "Mod+Alt+E",
		label: "Editor",
		action: { type: "view", view: "plugin:vscode-editor" },
		builtin: true,
	},
	{
		id: "run-trace",
		shortcut: "Mod+Alt+R",
		label: "Run Trace",
		action: { type: "view", view: "plugin:run-trace" },
		builtin: true,
	},
];

export const STORAGE_KEY = "pi-web-ui.ui-shortcuts.bindings";

export interface ShortcutKeyEvent {
	key?: unknown;
	code?: unknown;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	repeat?: boolean;
	isComposing?: boolean;
	defaultPrevented?: boolean;
	target?: unknown;
}

export interface ShortcutStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

interface HostApi {
	setView?: (view: string) => void;
	compose?: (options: { text: string }) => boolean;
	startChat?: (options: { prompt: string; newChat?: boolean }) => boolean;
}

type HostWindow = Window & { __piWebUiHost?: HostApi };

type Modifier = "Ctrl" | "Meta" | "Mod" | "Alt" | "Shift";

const MODIFIERS: Record<string, Modifier> = {
	ctrl: "Ctrl",
	control: "Ctrl",
	cmd: "Meta",
	command: "Meta",
	meta: "Meta",
	win: "Meta",
	windows: "Meta",
	mod: "Mod",
	alt: "Alt",
	option: "Alt",
	shift: "Shift",
};

const KEY_NAMES: Record<string, string> = {
	backspace: "Backspace",
	delete: "Delete",
	down: "ArrowDown",
	end: "End",
	enter: "Enter",
	esc: "Escape",
	escape: "Escape",
	home: "Home",
	left: "ArrowLeft",
	pagedown: "PageDown",
	pageup: "PageUp",
	right: "ArrowRight",
	space: "Space",
	tab: "Tab",
	up: "ArrowUp",
};

const MODIFIER_ORDER: readonly Modifier[] = ["Ctrl", "Meta", "Mod", "Alt", "Shift"];
const VIEW_NAMES = /^(?:chat|terminal|git|plugin:[a-z0-9][a-z0-9._-]*)$/i;

function canonicalKey(raw: string): string | undefined {
	const value = raw.trim();
	if (value.length === 1 && /^[a-z0-9]$/i.test(value)) return value.toUpperCase();
	const named = KEY_NAMES[value.toLowerCase()];
	if (named) return named;
	if (/^F(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
	return undefined;
}

/** Normalize a shortcut such as `cmd + alt + k` to a stable storage form. */
export function normalizeShortcut(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const parts = raw
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length < 2) return undefined;

	const modifiers: Modifier[] = [];
	let key: string | undefined;
	for (const part of parts) {
		const modifier = MODIFIERS[part.toLowerCase()];
		if (modifier) {
			if (modifiers.includes(modifier)) return undefined;
			modifiers.push(modifier);
			continue;
		}
		if (key) return undefined;
		key = canonicalKey(part);
	}
	if (!key || modifiers.length === 0) return undefined;
	if (modifiers.includes("Mod") && (modifiers.includes("Ctrl") || modifiers.includes("Meta"))) return undefined;
	return [...MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)), key].join("+");
}

function shortcutParts(shortcut: string): { modifiers: Set<Modifier>; key: string } | undefined {
	const normalized = normalizeShortcut(shortcut);
	if (!normalized) return undefined;
	const parts = normalized.split("+");
	const key = parts.pop();
	if (!key) return undefined;
	return { modifiers: new Set(parts as Modifier[]), key };
}

function eventKey(event: ShortcutKeyEvent): string | undefined {
	if (typeof event.key !== "string") return undefined;
	return canonicalKey(event.key) ?? (event.key.length === 1 ? event.key.toUpperCase() : undefined);
}

function matchesShortcut(event: ShortcutKeyEvent, shortcut: string): boolean {
	const parsed = shortcutParts(shortcut);
	if (!parsed || eventKey(event) !== parsed.key) return false;
	const modifiers = parsed.modifiers;
	const ctrl = event.ctrlKey === true;
	const meta = event.metaKey === true;
	const mod = modifiers.has("Mod");
	if (mod) {
		if (ctrl === meta) return false;
	} else if (ctrl !== modifiers.has("Ctrl") || meta !== modifiers.has("Meta")) {
		return false;
	}
	const alt = event.altKey === true;
	const shift = event.shiftKey === true;
	return alt === modifiers.has("Alt") && shift === modifiers.has("Shift");
}

/** Return the first configured shortcut for an intentional, unclaimed key event. */
export function bindingForEvent(
	event: ShortcutKeyEvent | null | undefined,
	bindings: readonly ShortcutBinding[] = DEFAULT_BINDINGS,
): ShortcutBinding | undefined {
	if (!event || event.defaultPrevented || event.repeat || event.isComposing) return undefined;
	return bindings.find((binding) => matchesShortcut(event, binding.shortcut));
}

/** Preserve the original three-shortcut API for callers that only know about views. */
export function shortcutForEvent(event: ShortcutKeyEvent | null | undefined): Shortcut | undefined {
	const binding = bindingForEvent(event, DEFAULT_BINDINGS);
	const action = binding?.action;
	if (!action || action.type !== "view") return undefined;
	return SHORTCUTS.find((shortcut) => shortcut.view === action.view);
}

function validView(view: string): boolean {
	return VIEW_NAMES.test(view.trim());
}

function customId(shortcut: string, label: string): string {
	const slug = `${shortcut}-${label}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return `custom-${slug || "shortcut"}`;
}

export interface BindingResult {
	binding?: ShortcutBinding;
	error?: string;
}

/** Validate form values and create one persisted custom binding. */
export function createBinding(shortcut: unknown, label: unknown, actionType: unknown, value: unknown): BindingResult {
	const normalized = normalizeShortcut(shortcut);
	if (!normalized) return { error: "Use a key plus at least one modifier, such as Ctrl+Alt+K." };
	const name = typeof label === "string" ? label.trim() : "";
	if (!name) return { error: "A shortcut label is required." };
	if (name.length > 80) return { error: "The shortcut label is too long." };
	const input = typeof value === "string" ? value.trim() : "";
	let action: ShortcutAction;
	if (actionType === "view") {
		if (!validView(input)) return { error: "Use chat, terminal, git, or plugin:<id> as the view." };
		action = { type: "view", view: input };
	} else if (actionType === "compose") {
		if (!input) return { error: "Compose text is required." };
		action = { type: "compose", text: input };
	} else if (actionType === "startChat") {
		if (!input) return { error: "A chat prompt is required." };
		action = { type: "startChat", prompt: input, newChat: true };
	} else {
		return { error: "Choose a supported action." };
	}
	return { binding: { id: customId(normalized, name), shortcut: normalized, label: name, action } };
}

function normalizeStoredBinding(raw: unknown): ShortcutBinding | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const id = typeof source.id === "string" ? source.id.trim() : "";
	const shortcut = normalizeShortcut(source.shortcut);
	const label = typeof source.label === "string" ? source.label.trim() : "";
	const sourceAction = source.action;
	if (!id || !shortcut || !label || !sourceAction || typeof sourceAction !== "object") return undefined;
	const action = sourceAction as Record<string, unknown>;
	if (action.type === "view" && typeof action.view === "string" && validView(action.view)) {
		return { id, shortcut, label, action: { type: "view", view: action.view.trim() } };
	}
	if (action.type === "compose" && typeof action.text === "string" && action.text.trim()) {
		return { id, shortcut, label, action: { type: "compose", text: action.text.trim() } };
	}
	if (action.type === "startChat" && typeof action.prompt === "string" && action.prompt.trim()) {
		return {
			id,
			shortcut,
			label,
			action: { type: "startChat", prompt: action.prompt.trim(), newChat: action.newChat !== false },
		};
	}
	return undefined;
}

/** Load and sanitize custom bindings from local storage. */
export function readCustomBindings(storage?: ShortcutStorage | null): ShortcutBinding[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		if (!Array.isArray(parsed)) return [];
		const seenIds = new Set<string>();
		const seenShortcuts = new Set<string>();
		return parsed.flatMap((item): ShortcutBinding[] => {
			const binding = normalizeStoredBinding(item);
			if (!binding || seenIds.has(binding.id) || seenShortcuts.has(binding.shortcut)) return [];
			seenIds.add(binding.id);
			seenShortcuts.add(binding.shortcut);
			return [binding];
		});
	} catch {
		return [];
	}
}

/** Save only custom bindings; built-ins remain code-defined defaults. */
export function writeCustomBindings(
	storage: ShortcutStorage | null | undefined,
	bindings: readonly ShortcutBinding[],
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(bindings.filter((binding) => !binding.builtin)));
		return true;
	} catch {
		return false;
	}
}

function mergedBindings(custom: readonly ShortcutBinding[]): ShortcutBinding[] {
	const seen = new Set(DEFAULT_BINDINGS.map((binding) => binding.shortcut));
	return [
		...DEFAULT_BINDINGS,
		...custom.filter((binding) => !seen.has(binding.shortcut) && (seen.add(binding.shortcut), true)),
	];
}

export function performAction(host: HostApi | null | undefined, action: ShortcutAction): boolean {
	try {
		if (action.type === "view") {
			if (typeof host?.setView !== "function") return false;
			host.setView(action.view);
			return true;
		}
		if (action.type === "compose") {
			return typeof host?.compose === "function" && host.compose({ text: action.text }) !== false;
		}
		return (
			typeof host?.startChat === "function" &&
			host.startChat({ prompt: action.prompt, newChat: action.newChat }) !== false
		);
	} catch {
		return false;
	}
}

function isEditableTarget(target: unknown): boolean {
	if (!target || typeof target !== "object") return false;
	const element = target as { tagName?: unknown; isContentEditable?: unknown };
	const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
	return element.isContentEditable === true || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function displayShortcut(shortcut: string): string {
	return shortcut.replace(/^Mod\+/, "Ctrl+").replace(/^Meta\+/, "Cmd+");
}

function makeInput(document: Document, field: string, type: string, placeholder: string): HTMLInputElement {
	const input = document.createElement("input");
	input.type = type;
	input.placeholder = placeholder;
	input.dataset.field = field;
	return input;
}

function describeAction(action: ShortcutAction): string {
	if (action.type === "view") return `View: ${action.view}`;
	if (action.type === "compose") return `Compose: ${action.text}`;
	return `Start chat: ${action.prompt}`;
}

export default {
	mount(container: HTMLElement, _ctx: unknown): () => void {
		if (!container || typeof container.append !== "function") return () => {};
		const hostWindow = container.ownerDocument?.defaultView as HostWindow | null;
		if (!hostWindow) return () => {};
		const storage = (() => {
			try {
				return hostWindow.localStorage as ShortcutStorage;
			} catch {
				return undefined;
			}
		})();

		let activeView: string | null = null;
		let bindings = mergedBindings(readCustomBindings(storage));
		const document = container.ownerDocument;
		const setError = (element: HTMLElement, message: string): void => {
			element.textContent = message;
		};
		const runBinding = (binding: ShortcutBinding): void => {
			if (binding.action.type === "view") {
				const next = activeView === binding.action.view ? "chat" : binding.action.view;
				if (performAction(hostWindow.__piWebUiHost, { type: "view", view: next })) {
					activeView = next === "chat" ? null : binding.action.view;
				}
				return;
			}
			performAction(hostWindow.__piWebUiHost, binding.action);
		};

		const render = (): void => {
			const buttons = DEFAULT_BINDINGS.map((binding) => {
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = binding.label;
				button.dataset.view = binding.action.type === "view" ? binding.action.view : "";
				button.dataset.key = displayShortcut(binding.shortcut);
				button.setAttribute("aria-keyshortcuts", displayShortcut(binding.shortcut));
				button.addEventListener("click", () => runBinding(binding));
				return button;
			});

			const panel = document.createElement("section");
			panel.dataset.ui = "shortcut-settings";
			const heading = document.createElement("h3");
			heading.textContent = "Custom shortcuts";
			panel.append(heading);

			const form = document.createElement("form");
			form.dataset.ui = "shortcut-form";
			const labelInput = makeInput(document, "label", "text", "Label");
			const shortcutInput = makeInput(document, "shortcut", "text", "Ctrl+Alt+K");
			const valueInput = makeInput(document, "value", "text", "Action value");
			const actionSelect = document.createElement("select");
			actionSelect.dataset.field = "action";
			for (const [value, text] of [
				["view", "Switch view"],
				["compose", "Compose text"],
				["startChat", "Start a new chat"],
			]) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = text;
				actionSelect.append(option);
			}
			const addButton = document.createElement("button");
			addButton.type = "submit";
			addButton.textContent = "Add shortcut";
			const error = document.createElement("p");
			error.dataset.ui = "shortcut-error";
			error.setAttribute("role", "alert");
			form.append(labelInput, shortcutInput, actionSelect, valueInput, addButton, error);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				const result = createBinding(shortcutInput.value, labelInput.value, actionSelect.value, valueInput.value);
				if (!result.binding) {
					setError(error, result.error ?? "Could not add shortcut.");
					return;
				}
				if (bindings.some((binding) => binding.shortcut === result.binding!.shortcut)) {
					setError(error, "That shortcut is already in use.");
					return;
				}
				bindings = [...bindings, result.binding];
				if (!writeCustomBindings(storage, bindings)) {
					bindings = bindings.slice(0, -1);
					setError(error, "Shortcuts could not be saved in this browser.");
					return;
				}
				render();
			});
			panel.append(form);

			const custom = bindings.filter((binding) => !binding.builtin);
			for (const binding of custom) {
				const row = document.createElement("div");
				row.dataset.bindingId = binding.id;
				row.textContent = `${binding.label} · ${displayShortcut(binding.shortcut)} · ${describeAction(binding.action)}`;
				const remove = document.createElement("button");
				remove.type = "button";
				remove.textContent = "Remove";
				remove.addEventListener("click", () => {
					bindings = bindings.filter((item) => item.id !== binding.id);
					writeCustomBindings(storage, bindings);
					render();
				});
				row.append(remove);
				panel.append(row);
			}

			const reset = document.createElement("button");
			reset.type = "button";
			reset.textContent = "Reset custom shortcuts";
			reset.addEventListener("click", () => {
				bindings = [...DEFAULT_BINDINGS];
				writeCustomBindings(storage, bindings);
				render();
			});
			panel.append(reset);
			container.replaceChildren(...buttons, panel);
		};

		render();
		const onKey = (event: KeyboardEvent): void => {
			if (isEditableTarget(event.target)) return;
			const binding = bindingForEvent(event, bindings);
			if (!binding) return;
			event.preventDefault();
			runBinding(binding);
		};
		hostWindow.addEventListener("keydown", onKey);

		return () => {
			hostWindow.removeEventListener("keydown", onKey);
			container.replaceChildren();
		};
	},
};

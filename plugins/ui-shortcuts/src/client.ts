/** Small keyboard shortcuts for switching between the pi-web-ui views. */

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

export interface ShortcutKeyEvent {
	key?: unknown;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	repeat?: boolean;
	isComposing?: boolean;
	defaultPrevented?: boolean;
	target?: unknown;
}

/** Return a configured shortcut only for an intentional, unclaimed key event. */
export function shortcutForEvent(event: ShortcutKeyEvent | null | undefined): Shortcut | undefined {
	if (
		!event ||
		event.defaultPrevented ||
		event.repeat ||
		event.isComposing ||
		!(event.ctrlKey || event.metaKey) ||
		!event.altKey ||
		event.shiftKey
	)
		return undefined;
	const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
	return SHORTCUTS.find((shortcut) => shortcut.key === key);
}

function isEditableTarget(target: unknown): boolean {
	if (!target || typeof target !== "object") return false;
	const element = target as { tagName?: unknown; isContentEditable?: unknown };
	const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
	return element.isContentEditable === true || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

interface HostApi {
	setView?: (view: string) => void;
}

type HostWindow = Window & { __piWebUiHost?: HostApi };

function keyLabel(shortcut: Shortcut): string {
	return `Ctrl+Alt+${shortcut.key.toUpperCase()}`;
}

export default {
	mount(container: HTMLElement, _ctx: unknown): () => void {
		if (!container || typeof container.append !== "function") return () => {};
		const hostWindow = container.ownerDocument?.defaultView as HostWindow | null;
		if (!hostWindow) return () => {};

		let activeView: string | null = null;
		const setView = (view: string): boolean => {
			const bridge = hostWindow.__piWebUiHost;
			if (!bridge || typeof bridge.setView !== "function") return false;
			try {
				bridge.setView(view);
				return true;
			} catch {
				return false;
			}
		};
		const toggleView = (view: string): void => {
			const next = activeView === view ? "chat" : view;
			if (setView(next)) activeView = next === "chat" ? null : view;
		};

		const buttons = SHORTCUTS.map((shortcut) => {
			const button = container.ownerDocument.createElement("button");
			button.type = "button";
			button.textContent = shortcut.label;
			button.dataset.view = shortcut.view;
			button.dataset.key = keyLabel(shortcut);
			button.setAttribute("aria-keyshortcuts", keyLabel(shortcut));
			button.addEventListener("click", () => toggleView(shortcut.view));
			return button;
		});
		container.append(...buttons);

		const onKey = (event: KeyboardEvent): void => {
			if (isEditableTarget(event.target)) return;
			const shortcut = shortcutForEvent(event);
			if (!shortcut) return;
			event.preventDefault();
			toggleView(shortcut.view);
		};
		hostWindow.addEventListener("keydown", onKey);

		return () => {
			hostWindow.removeEventListener("keydown", onKey);
			container.replaceChildren();
		};
	},
};

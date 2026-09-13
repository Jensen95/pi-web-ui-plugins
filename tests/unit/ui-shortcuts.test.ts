import { describe, expect, it, vi } from "vitest";
import clientEntry, { SHORTCUTS, shortcutForEvent } from "../../plugins/ui-shortcuts/src/client";

interface FakeEventTarget {
	addEventListener(type: string, listener: (event: FakeKeyEvent) => void): void;
	removeEventListener(type: string, listener: (event: FakeKeyEvent) => void): void;
	dispatchKey(event: FakeKeyEvent): void;
	localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

interface FakeKeyEvent {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	repeat?: boolean;
	isComposing?: boolean;
	defaultPrevented?: boolean;
	target?: unknown;
	preventDefault(): void;
}

interface FakeElement {
	tagName: string;
	textContent: string;
	value: string;
	type: string;
	placeholder: string;
	dataset: Record<string, string>;
	disabled: boolean;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	addEventListener(type: string, listener: (event?: unknown) => void): void;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	click(): void;
	dispatch(type: string, event?: unknown): void;
	setAttribute(name: string, value: string): void;
}

interface FakeDocument {
	defaultView: FakeEventTarget & { __piWebUiHost?: { setView?: (view: string) => void } };
	createElement(tagName: string): FakeElement;
}

function createFakeDom(): { document: FakeDocument; container: FakeElement } {
	const windowListeners = new Map<string, Set<(event: FakeKeyEvent) => void>>();
	const values = new Map<string, string>();
	const defaultView: FakeDocument["defaultView"] = {
		addEventListener(type, listener) {
			let listeners = windowListeners.get(type);
			if (!listeners) windowListeners.set(type, (listeners = new Set()));
			listeners.add(listener);
		},
		removeEventListener(type, listener) {
			windowListeners.get(type)?.delete(listener);
		},
		dispatchKey(event) {
			for (const listener of windowListeners.get("keydown") ?? []) listener(event);
		},
		localStorage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => void values.set(key, value),
		},
	};

	const document = {} as FakeDocument;
	const makeElement = (tagName: string): FakeElement => {
		const listeners = new Map<string, Set<(event?: unknown) => void>>();
		const element: FakeElement = {
			tagName,
			textContent: "",
			value: "",
			type: "",
			placeholder: "",
			dataset: {},
			disabled: false,
			children: [],
			ownerDocument: document,
			addEventListener(type, listener) {
				let handlers = listeners.get(type);
				if (!handlers) listeners.set(type, (handlers = new Set()));
				handlers.add(listener);
			},
			append(...children) {
				element.children.push(...children);
			},
			replaceChildren(...children) {
				element.children = children;
			},
			click() {
				if (!element.disabled) {
					for (const listener of listeners.get("click") ?? []) listener();
				}
			},
			dispatch(type, event) {
				for (const listener of listeners.get(type) ?? []) listener(event);
			},
			setAttribute(name, value) {
				if (name === "data-view") element.dataset.view = value;
				if (name === "data-key") element.dataset.key = value;
			},
		};
		return element;
	};
	document.defaultView = defaultView;
	document.createElement = (tagName) => makeElement(tagName);
	const container = makeElement("div");
	return { document, container };
}

function key(overrides: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
	return {
		key: "t",
		ctrlKey: true,
		altKey: true,
		preventDefault: vi.fn(),
		...overrides,
	};
}

function descendants(root: FakeElement): FakeElement[] {
	return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("UI shortcuts client contract", () => {
	it("exports a mountable view and the three default destinations", () => {
		expect(typeof clientEntry).toBe("object");
		expect(typeof clientEntry.mount).toBe("function");
		expect(SHORTCUTS).toEqual([
			{ key: "t", label: "Terminal", view: "terminal" },
			{ key: "e", label: "Editor", view: "plugin:vscode-editor" },
			{ key: "r", label: "Run Trace", view: "plugin:run-trace" },
		]);
	});

	it("matches Ctrl/Command+Alt shortcuts case-insensitively", () => {
		expect(shortcutForEvent(key())).toMatchObject({ view: "terminal" });
		expect(shortcutForEvent(key({ key: "E", ctrlKey: false, metaKey: true }))).toMatchObject({
			view: "plugin:vscode-editor",
		});
		expect(shortcutForEvent(key({ key: "r" }))).toMatchObject({ view: "plugin:run-trace" });
	});

	it("rejects collisions, incomplete modifiers, repeats and browser-handled events", () => {
		for (const event of [
			key({ key: "x" }),
			key({ altKey: false }),
			key({ ctrlKey: false, metaKey: false }),
			key({ shiftKey: true }),
			key({ repeat: true }),
			key({ isComposing: true }),
			key({ defaultPrevented: true }),
		]) {
			expect(shortcutForEvent(event)).toBeUndefined();
		}
	});

	it("renders controls, switches views, and toggles the selected view back to chat", () => {
		const { document, container } = createFakeDom();
		const setView = vi.fn();
		document.defaultView.__piWebUiHost = { setView };

		const cleanup = clientEntry.mount?.(container as unknown as HTMLElement, {});
		const buttons = container.children.filter((child) => child.dataset.view);
		expect(buttons.map((child) => child.textContent)).toEqual(["Terminal", "Editor", "Run Trace"]);
		expect(buttons.map((child) => child.dataset.key)).toEqual(["Ctrl+Alt+T", "Ctrl+Alt+E", "Ctrl+Alt+R"]);

		buttons[0]?.click();
		buttons[0]?.click();
		buttons[1]?.click();
		expect(setView.mock.calls).toEqual([["terminal"], ["chat"], ["plugin:vscode-editor"]]);
		cleanup?.();
		expect(container.children).toEqual([]);
	});

	it("renders a custom shortcut form and persists a new view action", () => {
		const { document, container } = createFakeDom();
		const setView = vi.fn();
		document.defaultView.__piWebUiHost = { setView };
		const cleanup = clientEntry.mount?.(container as unknown as HTMLElement, {});
		const form = descendants(container).find((element) => element.dataset.ui === "shortcut-form");
		expect(form).toBeDefined();
		const fields = new Map(
			descendants(form!)
				.filter((element) => element.dataset.field)
				.map((element) => [element.dataset.field, element]),
		);
		fields.get("label")!.value = "Open terminal";
		fields.get("shortcut")!.value = "Ctrl+Alt+K";
		fields.get("action")!.value = "view";
		fields.get("value")!.value = "terminal";
		form!.dispatch("submit", { preventDefault: vi.fn() });
		expect(document.defaultView.localStorage.getItem("pi-web-ui.ui-shortcuts.bindings")).toContain("Open terminal");
		document.defaultView.dispatchKey(key({ key: "k" }));
		expect(setView).toHaveBeenCalledWith("terminal");
		cleanup?.();
	});

	it("handles keyboard shortcuts globally without stealing editable input", () => {
		const { document, container } = createFakeDom();
		const setView = vi.fn();
		document.defaultView.__piWebUiHost = { setView };
		const cleanup = clientEntry.mount?.(container as unknown as HTMLElement, {});

		const event = key({ key: "r" });
		document.defaultView.dispatchKey(event);
		expect(setView).toHaveBeenCalledWith("plugin:run-trace");
		expect(event.preventDefault).toHaveBeenCalledOnce();

		const inputEvent = key({ key: "e", target: { tagName: "INPUT" } });
		document.defaultView.dispatchKey(inputEvent);
		expect(setView).toHaveBeenCalledTimes(1);
		cleanup?.();
	});

	it("cleans up its global listener and tolerates a missing or broken host bridge", () => {
		const missing = createFakeDom();
		const cleanupMissing = clientEntry.mount?.(missing.container as unknown as HTMLElement, {});
		expect(() => missing.container.children[0]?.click()).not.toThrow();
		cleanupMissing?.();

		const broken = createFakeDom();
		broken.document.defaultView.__piWebUiHost = {
			setView: () => {
				throw new Error("host unavailable");
			},
		};
		const cleanupBroken = clientEntry.mount?.(broken.container as unknown as HTMLElement, {});
		expect(() => broken.container.children[0]?.click()).not.toThrow();
		cleanupBroken?.();

		const setView = vi.fn();
		broken.document.defaultView.__piWebUiHost = { setView };
		const cleanup = clientEntry.mount?.(broken.container as unknown as HTMLElement, {});
		cleanup?.();
		broken.document.defaultView.dispatchKey(key());
		expect(setView).not.toHaveBeenCalled();
	});
});

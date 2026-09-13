import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_BINDINGS,
	STORAGE_KEY,
	bindingForEvent,
	createBinding,
	normalizeShortcut,
	performAction,
	readCustomBindings,
	writeCustomBindings,
	type ShortcutAction,
	type ShortcutStorage,
} from "../../plugins/ui-shortcuts/src/client";

function event(overrides: Record<string, unknown> = {}) {
	return {
		key: "k",
		ctrlKey: true,
		altKey: true,
		preventDefault: vi.fn(),
		...overrides,
	};
}

function storage(): ShortcutStorage & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => void values.set(key, value),
	};
}

describe("custom shortcut configuration", () => {
	it("normalizes modifier aliases and rejects unsafe shortcuts", () => {
		expect(normalizeShortcut("cmd + alt + k")).toBe("Meta+Alt+K");
		expect(normalizeShortcut("mod+shift+f2")).toBe("Mod+Shift+F2");
		expect(normalizeShortcut("k")).toBeUndefined();
		expect(normalizeShortcut("ctrl+alt+k+k")).toBeUndefined();
		expect(normalizeShortcut("ctrl+alt+not-a-key")).toBeUndefined();
	});

	it("validates and creates view, compose, and new-chat actions", () => {
		expect(createBinding("Ctrl+Alt+K", "Open files", "view", "terminal")).toMatchObject({
			binding: {
				shortcut: "Ctrl+Alt+K",
				label: "Open files",
				action: { type: "view", view: "terminal" },
			},
		});
		expect(createBinding("Ctrl+Alt+C", "Explain", "compose", "Explain this page")).toMatchObject({
			binding: { action: { type: "compose", text: "Explain this page" } },
		});
		expect(createBinding("Ctrl+Alt+N", "New chat", "startChat", "Start a new chat")).toMatchObject({
			binding: { action: { type: "startChat", prompt: "Start a new chat", newChat: true } },
		});
		expect(createBinding("K", "Missing modifier", "view", "chat").error).toMatch(/modifier/i);
		expect(createBinding("Ctrl+Alt+K", "", "view", "chat").error).toMatch(/label/i);
		expect(createBinding("Ctrl+Alt+K", "Bad view", "view", "wat").error).toMatch(/view/i);
		expect(createBinding("Ctrl+Alt+K", "Empty prompt", "compose", "").error).toMatch(/text|prompt/i);
	});

	it("ignores malformed stored data and persists only valid custom bindings", () => {
		const store = storage();
		store.setItem(
			STORAGE_KEY,
			JSON.stringify([
				{ id: "saved", shortcut: "Ctrl+Alt+K", label: "Saved", action: { type: "view", view: "terminal" } },
				{ id: "bad", shortcut: "K", label: "Bad", action: { type: "view", view: "chat" } },
				{ id: "duplicate", shortcut: "Ctrl+Alt+K", label: "Duplicate", action: { type: "compose", text: "No" } },
				"not an object",
			]),
		);
		const loaded = readCustomBindings(store);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.id).toBe("saved");
		writeCustomBindings(store, [
			...DEFAULT_BINDINGS,
			...loaded,
			{ id: "new", shortcut: "Ctrl+Alt+N", label: "New", action: { type: "compose", text: "Hello" } },
		]);
		expect(JSON.parse(store.getItem(STORAGE_KEY) ?? "null")).toHaveLength(2);
	});

	it("routes keyboard events and host actions without throwing", () => {
		const custom = createBinding("Ctrl+Alt+K", "Compose", "compose", "Hello")!.binding!;
		const bindings = [...DEFAULT_BINDINGS, custom];
		expect(bindingForEvent(event(), bindings)?.id).toBe(custom.id);
		expect(bindingForEvent(event({ key: "t" }), bindings)?.id).toBe("terminal");
		expect(bindingForEvent(event({ key: "k", target: { tagName: "INPUT" } }), bindings)?.id).toBe(custom.id);

		const host = {
			setView: vi.fn(),
			compose: vi.fn(),
			startChat: vi.fn(),
		};
		expect(performAction(host, { type: "view", view: "terminal" })).toBe(true);
		expect(performAction(host, { type: "compose", text: "Hello" })).toBe(true);
		expect(performAction(host, { type: "startChat", prompt: "New", newChat: true })).toBe(true);
		expect(host.setView).toHaveBeenCalledWith("terminal");
		expect(host.compose).toHaveBeenCalledWith({ text: "Hello" });
		expect(host.startChat).toHaveBeenCalledWith({ prompt: "New", newChat: true });
	});

	it("returns false for unavailable or throwing bridges", () => {
		const action: ShortcutAction = { type: "compose", text: "Hello" };
		expect(performAction({}, action)).toBe(false);
		expect(
			performAction(
				{
					compose: () => {
						throw new Error("offline");
					},
				},
				action,
			),
		).toBe(false);
	});
});

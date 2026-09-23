import { describe, expect, it } from "vitest";
import client, { IDENTITY_KEY } from "../../plugins/session-shadow/src/client";
import server, { CHAT_STORAGE_KEY } from "../../plugins/session-shadow/src/index";
import { createMockHost, createMockViewContext } from "../helpers/mock-host";
import type { MockConversationSnapshot, MockHost, MockMessage } from "../helpers/mock-host";

function message(
	id: string,
	role: string,
	content: MockMessage["content"],
	extra: Record<string, unknown> = {},
): MockMessage {
	return { id, role, content, timestamp: Number(id.replace(/\D/g, "")) || 1, ...extra };
}

function snapshot(
	conversationId: string,
	title: string,
	firstMessageId: string,
	overrides: Partial<MockConversationSnapshot> = {},
): MockConversationSnapshot {
	return {
		conversationId,
		title,
		at: 4_000,
		isStreaming: false,
		messages: [
			message(firstMessageId, "user", [{ type: "text", text: `Question for ${title}` }]),
			message(`${firstMessageId}-answer`, "assistant", [
				{ type: "thinking", thinking: "private chain of thought" },
				{ type: "text", text: `Answer for ${title}` },
				{ type: "toolCall", id: `${firstMessageId}-tool`, name: "read", argumentsText: '{"path":"src/app.ts"}' },
			]),
			message(`${firstMessageId}-result`, "toolResult", [{ type: "text", text: "file contents" }], {
				toolCallId: `${firstMessageId}-tool`,
				toolName: "read",
				isError: false,
			}),
		],
		streamingMessage: null,
		stats: { totalMessages: 3, tokens: { input: 10, output: 20, total: 30 }, cost: 0.01 },
		...overrides,
	};
}

function sentState(host: MockHost, clientId = "browser-b"): Record<string, unknown> {
	const record = [...host.recorded.sent]
		.reverse()
		.find((item) => item.clientId === clientId && (item.payload as { kind?: string }).kind === "state");
	expect(record, `no state was sent to ${clientId}`).toBeDefined();
	return record!.payload as Record<string, unknown>;
}

function sentErrors(host: MockHost, clientId = "browser-a"): Record<string, unknown>[] {
	return host.recorded.sent
		.filter((item) => item.clientId === clientId && (item.payload as { kind?: string }).kind === "result")
		.map((item) => item.payload as Record<string, unknown>);
}

describe("session-shadow server", () => {
	it("sends a compact, read-only view of the active session to an attaching browser", async () => {
		const active = snapshot("conv-local", "Fix login", "user-global-1");
		const host = createMockHost({ activeConversation: active });
		const cleanup = server.activate(host);

		await host.emit.attach("browser-b");

		const state = sentState(host);
		expect(state).toMatchObject({ kind: "state", activeSessionId: "user-global-1" });
		const sessions = state.sessions as Array<Record<string, unknown>>;
		expect(sessions).toEqual([
			expect.objectContaining({ id: "user-global-1", title: "Fix login", isStreaming: false }),
		]);
		const observed = state.session as { activity: Array<Record<string, unknown>> };
		expect(observed.activity).toEqual([
			expect.objectContaining({ kind: "user", text: "Question for Fix login" }),
			expect.objectContaining({ kind: "thinking", text: "Thinking" }),
			expect.objectContaining({ kind: "answer", text: "Answer for Fix login" }),
			expect.objectContaining({ kind: "tool", text: expect.stringMatching(/read.*src\/app\.ts/i) }),
			expect.objectContaining({ kind: "tool-result", text: "file contents", isError: false }),
		]);
		expect(JSON.stringify(state)).not.toContain("private chain of thought");
		expect(state).not.toHaveProperty("messages");
		cleanup?.();
	});

	it("refreshes from run events and keeps sessions separate", async () => {
		let active = snapshot("conv-a", "Session A", "session-a-root");
		const host = createMockHost();
		host.getActiveConversation = () => active;
		const cleanup = server.activate(host);

		active = snapshot("conv-b", "Session B", "session-b-root", {
			isStreaming: true,
			streamingMessage: message("stream-b", "assistant", [{ type: "text", text: "Still working" }]),
		});
		await host.emit.runEvent({ type: "message", conversationId: "conv-b", at: 5_000 });
		await host.emit.attach("browser-b");

		const state = sentState(host);
		expect(state).toMatchObject({ activeSessionId: "session-b-root" });
		expect((state.sessions as Array<{ id: string }>).map((item) => item.id).sort()).toEqual([
			"session-a-root",
			"session-b-root",
		]);
		expect(state.session).toMatchObject({ id: "session-b-root", isStreaming: true });
		expect((state.session as { activity: Array<{ text: string }> }).activity.at(-1)?.text).toBe("Still working");

		await host.emit.message({ action: "get_session", sessionId: "session-a-root" }, "browser-b");
		const selected = sentState(host);
		expect(selected.session).toMatchObject({ id: "session-a-root", title: "Session A" });
		cleanup?.();
	});

	it("shares persisted human chat across browsers without mixing session rooms", async () => {
		let active = snapshot("conv-a", "Session A", "session-a-root");
		const host = createMockHost();
		host.getActiveConversation = () => active;
		const cleanup = server.activate(host);

		await host.emit.message(
			{
				action: "post_chat",
				requestId: "chat-a-1",
				sessionId: "session-a-root",
				identity: { name: "Alice", email: "alice@example.com" },
				text: "Watching this run.",
			},
			"browser-a",
		);
		expect(sentErrors(host).at(-1)).toMatchObject({ kind: "result", ok: true, requestId: "chat-a-1" });

		active = snapshot("conv-b", "Session B", "session-b-root");
		await host.emit.conversationChanged();
		await host.emit.message(
			{
				action: "post_chat",
				sessionId: "session-b-root",
				identity: { name: "Bob", email: "bob@example.com" },
				text: "This belongs to B.",
			},
			"browser-b",
		);

		await host.emit.message({ action: "get_session", sessionId: "session-a-root" }, "browser-c");
		const roomA = sentState(host, "browser-c").session as { chat: Array<Record<string, unknown>> };
		expect(roomA.chat).toEqual([
			expect.objectContaining({ name: "Alice", email: "alice@example.com", text: "Watching this run." }),
		]);
		expect(JSON.stringify(roomA.chat)).not.toContain("This belongs to B.");

		const stored = host.recorded.storage.get(CHAT_STORAGE_KEY) as Record<string, unknown[]>;
		expect(stored["session-a-root"]).toHaveLength(1);
		expect(stored["session-b-root"]).toHaveLength(1);
		cleanup?.();
	});

	it("rejects malformed chat, unknown sessions, and failed persistence without broadcasting", async () => {
		const host = createMockHost({ activeConversation: snapshot("conv-a", "Session A", "session-a-root") });
		const cleanup = server.activate(host);
		const before = host.recorded.broadcasts.length;

		for (const payload of [
			{ action: "post_chat", sessionId: "missing", identity: { name: "A", email: "a@example.com" }, text: "x" },
			{ action: "post_chat", sessionId: "session-a-root", identity: { name: "", email: "a@example.com" }, text: "x" },
			{ action: "post_chat", sessionId: "session-a-root", identity: { name: "A", email: "bad" }, text: "x" },
			{ action: "post_chat", sessionId: "session-a-root", identity: { name: "A", email: "a@example.com" }, text: " " },
			{
				action: "post_chat",
				sessionId: "session-a-root",
				identity: { name: "A", email: "a@example.com" },
				text: "x".repeat(2_001),
			},
		]) {
			await host.emit.message(payload, "browser-a");
		}

		expect(sentErrors(host)).toHaveLength(5);
		expect(host.recorded.broadcasts).toHaveLength(before);
		expect(host.recorded.storage.get(CHAT_STORAGE_KEY)).toBeUndefined();

		host.storage.set = () => {
			throw new Error("disk full");
		};
		await host.emit.message(
			{
				action: "post_chat",
				sessionId: "session-a-root",
				requestId: "chat-failed-1",
				identity: { name: "Alice", email: "alice@example.com" },
				text: "Do not publish this.",
			},
			"browser-a",
		);
		expect(sentErrors(host).at(-1)).toMatchObject({ requestId: "chat-failed-1" });
		expect(sentErrors(host).at(-1)?.error).toMatch(/save|persist|disk/i);
		expect(host.recorded.broadcasts).toHaveLength(before);
		cleanup?.();
	});

	it("isolates missing or broken snapshots and unregisters every listener on cleanup", async () => {
		const host = createMockHost();
		host.getActiveConversation = () => null;
		const cleanup = server.activate(host);
		await host.emit.attach("browser-b");
		expect(sentState(host)).toMatchObject({ activeSessionId: null, sessions: [], session: null });

		host.getActiveConversation = () => {
			throw new Error("snapshot unavailable");
		};
		await expect(host.emit.conversationChanged()).resolves.toBe(1);
		expect(host.recorded.logs.flat().join(" ")).toMatch(/snapshot unavailable/);

		cleanup?.();
		expect(host.recorded.handlers.attach.size).toBe(0);
		expect(host.recorded.handlers.message.size).toBe(0);
		expect(host.recorded.handlers.runEvent.size).toBe(0);
		expect(host.recorded.handlers.conversationChanged.size).toBe(0);
	});
});

interface FakeStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

interface FakeEvent {
	preventDefault(): void;
}

interface FakeElement {
	tagName: string;
	textContent: string;
	className: string;
	type: string;
	value: string;
	disabled: boolean;
	dataset: Record<string, string>;
	attributes: Record<string, string>;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	setAttribute(name: string, value: string): void;
	addEventListener(type: string, listener: (event: FakeEvent) => void): void;
	dispatch(type: string): void;
	focus(): void;
	closest(selector: string): FakeElement | null;
}

interface FakeDocument {
	activeElement?: FakeElement;
	defaultView: { localStorage: FakeStorage };
	createElement(tagName: string): FakeElement;
}

function createDom(settingsSurface = false): {
	container: FakeElement;
	storage: FakeStorage;
	values: Map<string, string>;
} {
	const values = new Map<string, string>();
	const storage: FakeStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => void values.set(key, value),
	};
	const document = { defaultView: { localStorage: storage } } as FakeDocument;
	document.createElement = (tagName: string): FakeElement => {
		const listeners = new Map<string, Set<(event: FakeEvent) => void>>();
		const element: FakeElement = {
			tagName,
			textContent: "",
			className: "",
			type: "",
			value: "",
			disabled: false,
			dataset: {},
			attributes: {},
			children: [],
			ownerDocument: document,
			append(...children) {
				element.children.push(...children);
			},
			replaceChildren(...children) {
				element.children = children;
			},
			setAttribute(name, value) {
				element.attributes[name] = value;
			},
			addEventListener(type, listener) {
				if (!listeners.has(type)) listeners.set(type, new Set());
				listeners.get(type)!.add(listener);
			},
			dispatch(type) {
				const event = { preventDefault() {} };
				for (const listener of listeners.get(type) ?? []) listener(event);
			},
			focus() {
				document.activeElement = element;
			},
			closest(selector) {
				return settingsSurface && selector === ".plugin-page" ? element : null;
			},
		};
		return element;
	};
	return { container: document.createElement("div"), storage, values };
}

function flatten(element: FakeElement): FakeElement[] {
	return [element, ...element.children.flatMap(flatten)];
}

function visibleText(element: FakeElement): string {
	return flatten(element)
		.filter((item) => item.tagName !== "style")
		.map((item) => item.textContent)
		.filter(Boolean)
		.join(" | ");
}

function field(container: FakeElement, name: string): FakeElement {
	const found = flatten(container).find((item) => item.dataset.field === name);
	if (!found) throw new Error(`missing field ${name}`);
	return found;
}

function form(container: FakeElement): FakeElement {
	const found = flatten(container).find((item) => item.tagName === "form");
	if (!found) throw new Error("missing form");
	return found;
}

describe("session-shadow client", () => {
	it("renders observed activity and shared chat, then posts only human chat input", () => {
		const { container, storage } = createDom();
		storage.setItem(IDENTITY_KEY, JSON.stringify({ name: "Alice", email: "alice@example.com" }));
		const channel = createMockViewContext("session-shadow");
		const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);

		expect(channel.sent).toEqual([{ action: "state" }]);
		channel.push({
			kind: "state",
			activeSessionId: "session-a-root",
			sessions: [{ id: "session-a-root", title: "Fix login", isStreaming: true }],
			session: {
				id: "session-a-root",
				title: "Fix login",
				isStreaming: true,
				activity: [
					{ id: "a1", kind: "user", text: "<b>do not parse me</b>" },
					{ id: "a2", kind: "answer", text: "Working on it" },
				],
				chat: [
					{
						id: "c1",
						name: "Bob",
						email: "bob@example.com",
						text: "I am observing too.",
						at: 1,
					},
				],
			},
		});

		expect(visibleText(container)).toContain("Fix login");
		expect(visibleText(container)).toContain("<b>do not parse me</b>");
		expect(visibleText(container)).toContain("Bob");
		expect(visibleText(container)).toContain("I am observing too.");
		expect(visibleText(container)).toContain("Live · Agent responding");
		expect(field(container, "chat").attributes["aria-label"]).toBe("Message to observers");
		expect(field(container, "chat").attributes.maxlength).toBe("2000");

		field(container, "chat").value = "Looks good.";
		field(container, "chat").dispatch("input");
		expect(visibleText(container)).toContain("11 / 2,000");
		form(container).dispatch("submit");
		expect(channel.sent.at(-1)).toMatchObject({
			action: "post_chat",
			requestId: expect.any(String),
			sessionId: "session-a-root",
			identity: { name: "Alice", email: "alice@example.com" },
			text: "Looks good.",
		});
		cleanup?.();
	});

	it("keeps a draft and a browsed room when live updates arrive for the active room", () => {
		const { container, storage } = createDom();
		storage.setItem(IDENTITY_KEY, JSON.stringify({ name: "Alice", email: "alice@example.com" }));
		const channel = createMockViewContext("session-shadow");
		const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);
		const sessions = [
			{ id: "session-a-root", title: "Older room", isStreaming: false },
			{ id: "session-b-root", title: "Active room", isStreaming: true },
		];
		const room = (id: string, title: string, activity: string) => ({
			id,
			title,
			isStreaming: id === "session-b-root",
			activity: [{ id: `${id}-activity`, kind: "answer", text: activity }],
			chat: [],
		});

		channel.push({
			kind: "state",
			activeSessionId: "session-b-root",
			sessions,
			session: room("session-b-root", "Active room", "Active room activity"),
		});
		field(container, "session").value = "session-a-root";
		field(container, "session").dispatch("change");
		channel.push({
			kind: "state",
			activeSessionId: "session-b-root",
			sessions,
			session: room("session-a-root", "Older room", "Older room activity"),
		});
		field(container, "chat").value = "An unsent draft";
		field(container, "chat").dispatch("input");
		field(container, "chat").focus();

		channel.push({
			kind: "state",
			activeSessionId: "session-b-root",
			sessions,
			session: room("session-b-root", "Active room", "New active update"),
		});

		expect(field(container, "session").value).toBe("session-a-root");
		expect(field(container, "chat").value).toBe("An unsent draft");
		expect(container.ownerDocument.activeElement).toBe(field(container, "chat"));
		expect(visibleText(container)).toContain("Older room activity");
		expect(visibleText(container)).not.toContain("New active update");
		cleanup?.();
	});

	it("does not label a previously streaming room live after the active session ends", () => {
		const { container } = createDom();
		const channel = createMockViewContext("session-shadow");
		const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);
		const room = { id: "session-a-root", title: "Session A", isStreaming: true, activity: [], chat: [] };
		channel.push({ kind: "state", activeSessionId: room.id, sessions: [room], session: room });
		channel.push({ kind: "state", activeSessionId: null, sessions: [room], session: null });
		field(container, "session").value = room.id;
		field(container, "session").dispatch("change");
		channel.push({ kind: "state", activeSessionId: null, sessions: [room], session: room });
		expect(visibleText(container)).toContain("Paused · No active response");
		cleanup?.();
	});

	it("clears a submitted draft only after its correlated success and reports outcomes", () => {
		const { container, storage } = createDom();
		storage.setItem(IDENTITY_KEY, JSON.stringify({ name: "Alice", email: "alice@example.com" }));
		const channel = createMockViewContext("session-shadow");
		const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);
		channel.push({
			kind: "state",
			activeSessionId: "session-a-root",
			sessions: [{ id: "session-a-root", title: "Session A", isStreaming: false }],
			session: { id: "session-a-root", title: "Session A", isStreaming: false, activity: [], chat: [] },
		});

		field(container, "chat").value = "Keep this if persistence fails";
		field(container, "chat").dispatch("input");
		form(container).dispatch("submit");
		const failedRequest = channel.sent.at(-1) as Record<string, unknown>;
		expect(failedRequest).toMatchObject({ action: "post_chat", sessionId: "session-a-root" });
		expect(failedRequest.requestId).toEqual(expect.any(String));
		channel.push({
			kind: "result",
			ok: false,
			requestId: failedRequest.requestId,
			error: "Could not persist chat: disk full",
		});
		expect(field(container, "chat").value).toBe("Keep this if persistence fails");
		expect(visibleText(container)).toMatch(/disk full/i);

		field(container, "chat").value = "A newer draft";
		field(container, "chat").dispatch("input");
		channel.push({ kind: "result", ok: true, requestId: failedRequest.requestId });
		expect(field(container, "chat").value).toBe("A newer draft");

		form(container).dispatch("submit");
		const successfulRequest = channel.sent.at(-1) as Record<string, unknown>;
		channel.push({ kind: "result", ok: true, requestId: successfulRequest.requestId });
		expect(field(container, "chat").value).toBe("");
		expect(visibleText(container)).toMatch(/message sent/i);
		cleanup?.();
	});

	it("stores a different identity in each browser through the plugin settings page", () => {
		const { container, values } = createDom(true);
		const channel = createMockViewContext("session-shadow");
		const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);

		field(container, "name").value = "Alice";
		field(container, "email").value = "alice@example.com";
		form(container).dispatch("submit");

		expect(JSON.parse(values.get(IDENTITY_KEY)!)).toEqual({ name: "Alice", email: "alice@example.com" });
		expect(visibleText(container)).toMatch(/saved/i);
		expect(channel.sent).toEqual([]);
		cleanup?.();
	});

	it("blocks chat until valid browser identity settings exist", () => {
		const { container } = createDom();
		const channel = createMockViewContext("session-shadow");
		const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);
		channel.push({
			kind: "state",
			activeSessionId: "session-a-root",
			sessions: [{ id: "session-a-root", title: "Session A", isStreaming: false }],
			session: { id: "session-a-root", title: "Session A", isStreaming: false, activity: [], chat: [] },
		});

		expect(visibleText(container)).toMatch(/settings.*name.*email/i);
		expect(field(container, "chat").disabled).toBe(true);
		form(container).dispatch("submit");
		expect(channel.sent).toEqual([{ action: "state" }]);
		cleanup?.();
	});
});

import { randomUUID } from "node:crypto";
import {
	normalizeIdentity,
	type ActivityItem,
	type ChatMessage,
	type SessionState,
	type SessionSummary,
	type StatePayload,
} from "./protocol.js";

export const CHAT_STORAGE_KEY = "sessionChats";

const MAX_SESSIONS = 10;
const MAX_ACTIVITY = 20;
const MAX_CHAT = 50;
const MAX_CHAT_TEXT = 2_000;

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	argumentsText?: string;
	[key: string]: unknown;
}

interface Message {
	id?: string;
	role?: string;
	content?: ContentBlock[];
	toolName?: string;
	isError?: boolean;
}

interface ConversationSnapshot {
	conversationId?: string;
	title?: string;
	at?: number;
	isStreaming?: boolean;
	messages?: Message[];
	streamingMessage?: Message | null;
}

interface StorageHost {
	get<T>(key: string, fallback?: T): T | undefined;
	set(key: string, value: unknown): void;
}

interface PluginHost {
	broadcast(payload: unknown): void;
	sendTo(clientId: string, payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void | Promise<void>): () => void;
	onAttach(handler: (clientId: string) => void): () => void;
	onRunEvent(handler: (event: unknown) => void): () => void;
	onConversationChanged(handler: () => void): () => void;
	getActiveConversation(): ConversationSnapshot | null;
	storage: StorageHost;
	log(...args: unknown[]): void;
}

function text(value: unknown, max = 2_000): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toolLabel(block: ContentBlock): string {
	const name = text(block.name, 80) || "tool";
	let location = "";
	try {
		const args = JSON.parse(text(block.argumentsText, 10_000)) as Record<string, unknown>;
		location = text(args.path ?? args.file_path ?? args.command, 180);
	} catch {
		// A malformed argument preview still leaves a useful tool name.
	}
	return location ? `${name} · ${location}` : name;
}

function messageActivity(message: Message, live = false): ActivityItem[] {
	const id = text(message.id, 200) || randomUUID();
	const items: ActivityItem[] = [];
	for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
		if (!block || typeof block !== "object") continue;
		const itemId = `${id}:${index}`;
		if (message.role === "user" && block.type === "text") {
			const value = text(block.text);
			if (value) items.push({ id: itemId, kind: "user", text: value, ...(live ? { live: true } : {}) });
		} else if (message.role === "assistant" && block.type === "thinking") {
			items.push({ id: itemId, kind: "thinking", text: "Thinking", ...(live ? { live: true } : {}) });
		} else if (message.role === "assistant" && block.type === "text") {
			const value = text(block.text);
			if (value) items.push({ id: itemId, kind: "answer", text: value, ...(live ? { live: true } : {}) });
		} else if (message.role === "assistant" && block.type === "toolCall") {
			items.push({ id: itemId, kind: "tool", text: toolLabel(block), ...(live ? { live: true } : {}) });
		}
	}
	if (message.role === "toolResult") {
		const result = (Array.isArray(message.content) ? message.content : [])
			.map((block) => text(block?.text))
			.filter(Boolean)
			.join("\n");
		items.push({
			id: `${id}:result`,
			kind: "tool-result",
			text: result || `${text(message.toolName, 80) || "Tool"} finished`,
			isError: message.isError === true,
			...(live ? { live: true } : {}),
		});
	}
	return items;
}

function sessionId(snapshot: ConversationSnapshot): string | null {
	const first = Array.isArray(snapshot.messages) ? snapshot.messages.find((item) => text(item?.id)) : undefined;
	if (first?.id) return text(first.id, 200);
	const conversationId = text(snapshot.conversationId, 100);
	const at = Number(snapshot.at);
	return conversationId && Number.isFinite(at) ? `${conversationId}:${at}` : null;
}

function summarize(snapshot: ConversationSnapshot, chat: ChatMessage[]): SessionState | null {
	const id = sessionId(snapshot);
	if (!id) return null;
	const activity = (Array.isArray(snapshot.messages) ? snapshot.messages : []).flatMap((item) => messageActivity(item));
	if (snapshot.streamingMessage) activity.push(...messageActivity(snapshot.streamingMessage, true));
	return {
		id,
		title: text(snapshot.title, 120) || "Untitled session",
		isStreaming: snapshot.isStreaming === true,
		activity: activity.slice(-MAX_ACTIVITY),
		chat: chat.slice(-MAX_CHAT),
	};
}

function validStoredMessage(value: unknown): ChatMessage | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const identity = normalizeIdentity(record);
	const body = text(record.text, MAX_CHAT_TEXT);
	const at = Number(record.at);
	if (!identity || !body || !Number.isFinite(at)) return null;
	return { id: text(record.id, 200) || randomUUID(), ...identity, text: body, at };
}

function loadChat(host: PluginHost): Record<string, ChatMessage[]> {
	try {
		const raw = host.storage.get<unknown>(CHAT_STORAGE_KEY, {});
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw as Record<string, unknown>)
				.map(([id, messages]) => [
					id,
					(Array.isArray(messages) ? messages.map(validStoredMessage).filter(Boolean) : []).slice(-MAX_CHAT),
				])
				.filter(([, messages]) => (messages as ChatMessage[]).length > 0),
		) as Record<string, ChatMessage[]>;
	} catch (error) {
		host.log("error", "Loading session chat failed:", error instanceof Error ? error.message : String(error));
		return {};
	}
}

export default {
	activate(host: PluginHost): () => void {
		const rooms = new Map<string, SessionState>();
		let chats = loadChat(host);
		let activeSessionId: string | null = null;

		const summaries = (): SessionSummary[] => {
			const result: SessionSummary[] = [];
			for (const { id, title, isStreaming } of rooms.values()) result.unshift({ id, title, isStreaming });
			return result;
		};

		const payload = (selectedId = activeSessionId): StatePayload => ({
			kind: "state",
			activeSessionId,
			sessions: summaries(),
			session: selectedId ? (rooms.get(selectedId) ?? null) : null,
		});

		const publish = (clientId?: string, selectedId = activeSessionId): void => {
			if (clientId) host.sendTo(clientId, payload(selectedId));
			else host.broadcast(payload(selectedId));
		};

		const refresh = (): void => {
			let snapshot: ConversationSnapshot | null;
			try {
				snapshot = host.getActiveConversation();
			} catch (error) {
				host.log(
					"error",
					"Reading the active conversation failed:",
					error instanceof Error ? error.message : String(error),
				);
				return;
			}
			if (!snapshot) {
				activeSessionId = null;
				publish();
				return;
			}
			const room = summarize(snapshot, chats[sessionId(snapshot) ?? ""] ?? []);
			if (!room) return;
			rooms.delete(room.id);
			rooms.set(room.id, room);
			while (rooms.size > MAX_SESSIONS) rooms.delete(rooms.keys().next().value as string);
			activeSessionId = room.id;
			publish();
		};

		const reject = (clientId: string | undefined, error: string, requestId = ""): void => {
			if (clientId) host.sendTo(clientId, { kind: "result", ok: false, error, ...(requestId ? { requestId } : {}) });
		};

		const onMessage = host.onMessage((raw, from) => {
			if (!raw || typeof raw !== "object") return reject(from, "Malformed request");
			const request = raw as Record<string, unknown>;
			const requestId = text(request.requestId, 80);
			const action = text(request.action, 40);
			if (action === "state") return publish(from);
			if (action === "get_session") {
				const id = text(request.sessionId, 200);
				if (!rooms.has(id)) return reject(from, "Unknown session", requestId);
				return publish(from, id);
			}
			if (action !== "post_chat") return reject(from, "Unknown action", requestId);

			const id = text(request.sessionId, 200);
			if (!rooms.has(id)) return reject(from, "Unknown session", requestId);
			const identity = normalizeIdentity(request.identity);
			if (!identity) return reject(from, "Set a valid name and email in Session Shadow settings", requestId);
			const body = text(request.text, MAX_CHAT_TEXT + 1);
			if (!body) return reject(from, "Chat message is empty", requestId);
			if (body.length > MAX_CHAT_TEXT)
				return reject(from, `Chat message exceeds ${MAX_CHAT_TEXT} characters`, requestId);

			const entry: ChatMessage = { id: randomUUID(), ...identity, text: body, at: Date.now() };
			const nextRoom = [...(chats[id] ?? []), entry].slice(-MAX_CHAT);
			const nextChats = { ...chats, [id]: nextRoom };
			try {
				host.storage.set(CHAT_STORAGE_KEY, nextChats);
			} catch (error) {
				return reject(
					from,
					`Could not persist chat: ${error instanceof Error ? error.message : String(error)}`,
					requestId,
				);
			}
			chats = nextChats;
			const room = rooms.get(id);
			if (!room) return reject(from, "Unknown session", requestId);
			rooms.set(id, { ...room, chat: nextRoom });
			publish(undefined, id);
			if (from) host.sendTo(from, { kind: "result", ok: true, ...(requestId ? { requestId } : {}) });
		});

		const onAttach = host.onAttach((clientId) => publish(clientId));
		const onRunEvent = host.onRunEvent(() => refresh());
		const onConversationChanged = host.onConversationChanged(() => refresh());
		refresh();

		return () => {
			onMessage();
			onAttach();
			onRunEvent();
			onConversationChanged();
		};
	},
};

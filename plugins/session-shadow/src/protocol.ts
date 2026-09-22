export interface Identity {
	name: string;
	email: string;
}

export function normalizeIdentity(value: unknown): Identity | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name.trim().slice(0, 80) : "";
	const email = typeof record.email === "string" ? record.email.trim().slice(0, 254) : "";
	if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
	return { name, email };
}

export interface ActivityItem {
	id: string;
	kind: "user" | "thinking" | "answer" | "tool" | "tool-result";
	text: string;
	isError?: boolean;
	live?: boolean;
}

export interface ChatMessage extends Identity {
	id: string;
	text: string;
	at: number;
}

export interface SessionSummary {
	id: string;
	title: string;
	isStreaming: boolean;
}

export interface SessionState extends SessionSummary {
	activity: ActivityItem[];
	chat: ChatMessage[];
}

export interface StatePayload {
	kind: "state";
	activeSessionId: string | null;
	sessions: SessionSummary[];
	session: SessionState | null;
}

export interface ResultPayload {
	kind: "result";
	ok: boolean;
	error?: string;
}

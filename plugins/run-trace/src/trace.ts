/**
 * The run-trace data model: limits, classifiers and the pure helpers both entries
 * are built on, plus the wire types for the payloads they exchange.
 *
 * This lives in its own module so the browser view can import the segment types
 * without pulling in the server entry, and so the trace math - the part where a
 * translation or a type conversion could silently change what the timeline says -
 * is testable on its own.
 */

/** Maximum characters kept for a segment's one-line summary. */
export const SUMMARY_CAP = 300;
/** Maximum characters kept for a segment's on-demand detail text. */
export const DETAIL_CAP = 8000;
/** Maximum characters kept for the argument/result preview inside a segment. */
export const PREVIEW_CAP = 4000;
/** How many conversations are kept in memory before the oldest is dropped. */
export const MAX_CONVS = 10;
/** Debounce for "history changed, re-pull it" triggers. */
export const REFRESH_DEBOUNCE_MS = 300;
/** Poll interval while a conversation is streaming. */
export const POLL_STREAMING_MS = 5000;
/** Poll interval while nothing is running. */
export const POLL_IDLE_MS = 30000;

/** Tool names that look like they write files: a hit means paths are pulled out
 *  of the arguments and a file segment is appended once the call succeeds. */
export const WRITE_TOOL_RE = /edit|write|patch|apply|create|save|move|rename|delete|remove|mkdir/i;
/** Read-only tool names: shown with a 📖 icon and never produce a file segment. */
export const READONLY_TOOL_RE = /^(read|get|list|glob|grep|search|show|cat|fetch|query)/i;
/** Argument keys whose values may hold a path. */
export const PATH_KEYS = new Set([
	"path",
	"file",
	"filepath",
	"filePath",
	"filename",
	"fileName",
	"paths",
	"files",
	"dir",
	"cwd",
]);

/** One content block of a message. The host's UiContentBlock is a union of
 *  text/thinking/toolCall/image/bash blocks plus an open fallback; the code reads
 *  `type` and then narrows, so an open record is the faithful minimal shape. */
export interface ContentBlock {
	type: string;
	[key: string]: unknown;
}

/** What a segment is. "result" is only ever read by the view, which tolerates it
 *  for forward compatibility; the server does not currently emit one. */
export type TraceSegKind = "user" | "thinking" | "text" | "tool" | "file" | "system" | "result";

/** Which swimlane of the timeline a segment is drawn in. */
export type TraceLane = "input" | "model" | "tools";

/** Segment lifecycle, as the view colours it. */
export type TraceStatus = "done" | "running" | "error";

/** The per-segment extras the view reads. Which ones are set depends on the kind. */
export interface TraceSegMeta {
	tool?: string;
	toolCallId?: string;
	/** Truncated argument JSON. */
	args?: string;
	files?: string[];
	/** Truncated result text. */
	result?: string;
	dur?: number;
	chars?: number;
	command?: string;
	exitCode?: number;
}

/** One timeline segment. Timestamps are milliseconds; `t` is the start and `end`
 *  the end (equal for an instantaneous segment). */
export interface TraceSeg {
	/** Stable key: `h-<messageId>`, `h-<toolCallId>` or `L-<toolCallId>` for a live one. */
	key: string;
	kind: TraceSegKind;
	lane: TraceLane;
	t: number;
	end?: number;
	/** Real duration in milliseconds, once known. */
	dur?: number;
	title: string;
	/** Un-decorated title of a live tool segment, so tool_end can rebuild the title. */
	headline?: string;
	summary: string;
	source: string;
	status: TraceStatus;
	/** 1-based user turn this segment belongs to; 0 while unknown. */
	turn: number;
	meta?: TraceSegMeta;
	/** Live segments carry their own detail text; history keeps it in the conversation. */
	detail?: string;
}

/** Per-tool totals inside a conversation analysis. */
export interface TraceToolStat {
	name: string;
	calls: number;
	ms: number;
	errs: number;
}

/** Conversation-level analysis, recomputed on every refresh. */
export interface TraceAnalysis {
	startedAt: number;
	totalMs: number;
	turns: number;
	/** Segment count per kind. */
	counts: Record<string, number>;
	toolCalls: number;
	toolErrs: number;
	toolMs: number;
	chars: number;
	filesChanged: string[];
	tools: TraceToolStat[];
}

/** Analysis of a single segment, sent with its detail. */
export interface TraceSegAnalysis {
	/** "#3/17", or an em dash when the segment is not in the list. */
	position: string;
	turnText: string;
	convTurns: number;
	/** Present for a tool segment once the conversation has been analysed. */
	tool?: TraceToolStat;
	convToolCalls?: number;
	convToolMs?: number;
}

/** One conversation as the view's conversation strip shows it. */
export interface TraceConvSummary {
	id: string;
	title?: string;
	active: boolean;
	isStreaming: boolean;
	segCount: number;
	updatedAt: number;
	analysis: TraceAnalysis | null;
}

/**
 * Every server -> browser payload, on one open interface because `kind` is the
 * only thing the runtime can actually check: the remaining fields are present for
 * their own kind alone, and the view narrows with the same guards it always had.
 */
export interface TracePayload {
	kind?: string;
	conversations?: TraceConvSummary[];
	activeId?: string | null;
	conv?: TraceConvSummary;
	convId?: string;
	reset?: boolean;
	segs?: TraceSeg[];
	key?: string;
	patch?: Partial<TraceSeg>;
	detail?: string;
	seg?: TraceSeg;
	analysis?: TraceSegAnalysis;
}

/** Clamp a value to a maximum length, marking the cut when it happens. */
export function cut(value: unknown, cap: number): string {
	const text = String(value ?? "");
	return text.length <= cap ? text : `${text.slice(0, cap)}\n… [truncated]`;
}

/** First line of a value, trimmed and capped (100 characters by default). */
export function firstLine(value: unknown, cap = 100): string {
	const line = String(value ?? "").split("\n")[0] ?? "";
	const trimmed = line.trim();
	return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}…`;
}

/**
 * Estimated generation time of a text block (thinking or answer), in milliseconds.
 *
 * An assistant message's timestamp is when it was created - the START of
 * generation, as the transcript shows: it always sits right after the previous
 * tool result - so text can only be laid out forwards from that point. This
 * estimate is what splits one message into blocks and what gets scaled down
 * proportionally when the blocks would run past the next message's timestamp.
 * Roughly 50 characters per second, with an 800ms floor so a block stays visible
 * and a 120s ceiling so one long text cannot swallow the whole timeline.
 */
export function estTextMs(chars: unknown): number {
	const n = Math.max(0, Number(chars) || 0);
	return Math.min(120000, Math.max(800, Math.round(n * 20)));
}

/**
 * Pull file paths out of a tool call's argument JSON.
 *
 * Deliberately heuristic: only whitelisted keys, only one object level plus one
 * array level. Values must be 1-300 characters after trimming and contain a
 * slash, a backslash or a dot; the result is deduped and capped at ten paths.
 * Unparseable arguments yield nothing rather than throwing.
 */
export function extractPaths(argsText: unknown): string[] {
	const out: string[] = [];
	try {
		const args: unknown = JSON.parse(String(argsText ?? "null"));
		if (!args || typeof args !== "object") return out;
		const push = (value: unknown): void => {
			if (typeof value !== "string") return;
			const trimmed = value.trim();
			if (trimmed.length < 1 || trimmed.length > 300) return;
			if (!/[/\\.]/.test(trimmed)) return;
			if (out.length < 10 && !out.includes(trimmed)) out.push(trimmed);
		};
		for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
			if (!PATH_KEYS.has(key)) continue;
			if (typeof value === "string") push(value);
			else if (Array.isArray(value)) for (const item of value as unknown[]) push(item);
		}
	} catch {
		/* The arguments do not parse, so there are no paths to find. */
	}
	return out;
}

/** Title of a tool segment, so the timeline says at a glance what it is doing. */
export function toolHeadline(toolName: unknown, argsText: unknown): string {
	const name = String(toolName ?? "tool");
	if (name === "bash") {
		try {
			const command = (JSON.parse(String(argsText ?? "{}")) as { command?: unknown } | null)?.command;
			if (command) return `bash · ${firstLine(command)}`;
		} catch {
			/* Unparseable arguments: fall through to the bare tool name. */
		}
		return "bash";
	}
	const paths = extractPaths(argsText);
	if (paths.length) return `${name} · ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`;
	const flat = firstLine(String(argsText ?? "").replace(/^\{|\}$/g, ""), 80);
	return flat ? `${name} · ${flat}` : name;
}

/** Concatenate one field of every matching block, skipping empty and non-string values. */
export function blockText(blocks: readonly ContentBlock[] | undefined, type: string, field: string): string {
	const parts: string[] = [];
	for (const block of blocks ?? []) {
		if (block?.type !== type) continue;
		const value = block[field];
		if (typeof value === "string" && value.trim()) parts.push(value);
	}
	return parts.join("\n");
}

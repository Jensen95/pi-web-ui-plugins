/**
 * run-trace server entry - run trajectory aggregation (the data layer of the
 * harness-style trace view).
 *
 * Two inputs merged into one timeline:
 *  1. Full history: host.getActiveConversation() - every message of the currently
 *     open conversation plus its stats - refreshed on a timer and on events. So the
 *     view shows "the timeline of the open conversation", not merely the runs that
 *     happened after the plugin was installed: open an older conversation and its
 *     trace is already there.
 *  2. Live increments: host.onRunEvent. tool_start/tool_end carry the exact
 *     duration, arguments and result; message/run_* events trigger a history
 *     re-pull.
 *
 * The server is the single source of truth: a client that attaches is pushed the
 * state through onAttach instead of having to ask for it.
 *
 * Message bodies are not sent wholesale. The list and the timeline carry summaries
 * only, and detail is fetched per segment on demand (get_seg): a single message can
 * be 200K, so shipping every body would blow up the snapshot.
 */
import {
	DETAIL_CAP,
	MAX_CONVS,
	POLL_IDLE_MS,
	POLL_STREAMING_MS,
	PREVIEW_CAP,
	READONLY_TOOL_RE,
	REFRESH_DEBOUNCE_MS,
	SUMMARY_CAP,
	WRITE_TOOL_RE,
	blockText,
	cut,
	estTextMs,
	extractPaths,
	firstLine,
	toolHeadline,
} from "./trace";
import type {
	ContentBlock,
	TraceAnalysis,
	TraceConvSummary,
	TracePayload,
	TraceSeg,
	TraceSegAnalysis,
	TraceToolStat,
} from "./trace";

// Upstream exported these from the server entry; the compiled index.mjs keeps that
// module surface even though the host itself only reads the default export.
export { estTextMs, extractPaths, toolHeadline } from "./trace";

/** A message as the host hands it over. Only the fields this entry reads. */
interface UiMessage {
	id: string;
	role: string;
	content?: ContentBlock[];
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Assistant messages record which agent model produced them. */
	model?: string;
	provider?: string;
}

/** The streaming message is tagged while it is being built, so it renders as running. */
type HistoryMessage = UiMessage & { _live?: boolean };

/** The open conversation's snapshot (host.getActiveConversation). */
interface ConversationSnapshot {
	conversationId: string;
	title: string;
	isStreaming: boolean;
	messages: UiMessage[];
	streamingMessage: UiMessage | null;
}

/** A run-trace event (host.onRunEvent). One user task produces
 *  run_start -> (turn_start/message/tool_start/tool_end ... interleaved) -> run_end. */
interface RunEvent {
	/** Compared against literals, so it stays open: unknown events re-pull history. */
	type: string;
	conversationId?: string;
	at: number;
	toolCallId?: string;
	toolName?: string;
	argsText?: string;
	resultText?: string;
	durationMs?: number;
	isError?: boolean;
}

/** What the browser view sends up through ctx.send(). */
interface PluginMessage {
	action?: string;
	convId?: string;
	key?: string;
}

/** The slice of the pi-web-ui plugin host this entry uses (server/plugins.ts). */
interface PluginHost {
	broadcast(payload: unknown): void;
	sendTo(clientId: string, payload: unknown): void;
	log(...args: unknown[]): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onAttach(handler: (clientId: string) => void): () => void;
	onRunEvent(handler: (ev: RunEvent) => void): () => void;
	/** Optional on purpose: hosts old enough to lack it simply never fire it. */
	onConversationChanged?(handler: () => void): () => void;
	getActiveConversation?(): ConversationSnapshot | null;
}

/** One conversation as this entry tracks it. */
interface Conv {
	id: string;
	title?: string;
	active: boolean;
	isStreaming: boolean;
	segs: TraceSeg[];
	/** segment key -> full detail text, fetched on demand. */
	full: Map<string, string>;
	analysis: TraceAnalysis | null;
	/** toolCallId -> the live segment still waiting for its result. */
	liveTools: Map<string, TraceSeg>;
	updatedAt: number;
}

/** An argument of a pending tool call, kept to compute its duration and paths. */
interface CallInfo {
	argsText: string;
	ts: number;
}

/** Read an optional string field off an open content block. */
function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export default {
	activate(host: PluginHost): () => void {
		/** convId -> conversation (segments, detail store, analysis, live tools). */
		const convs = new Map<string, Conv>();
		let activeId: string | null = null;
		let refreshTimer: ReturnType<typeof setTimeout> | null = null;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		let disposed = false;

		const getConv = (id: string, title: string | undefined): Conv => {
			let c = convs.get(id);
			if (!c) {
				c = {
					id,
					title,
					active: false,
					isStreaming: false,
					segs: [],
					full: new Map(),
					analysis: null,
					liveTools: new Map(),
					updatedAt: 0,
				};
				convs.set(id, c);
				while (convs.size > MAX_CONVS) {
					const oldest = [...convs.values()]
						.filter((x) => x.id !== activeId)
						.sort((a, b) => a.updatedAt - b.updatedAt)[0];
					if (!oldest) break;
					convs.delete(oldest.id);
				}
			}
			if (title) c.title = title;
			return c;
		};

		const summaryOf = (c: Conv): TraceConvSummary => ({
			id: c.id,
			title: c.title,
			active: c.id === activeId,
			isStreaming: c.isStreaming,
			segCount: c.segs.length,
			updatedAt: c.updatedAt,
			analysis: c.analysis,
		});

		const pushState = (to?: string): void => {
			const payload: TracePayload = { kind: "state", conversations: [...convs.values()].map(summaryOf), activeId };
			if (to) host.sendTo(to, payload);
			else host.broadcast(payload);
		};

		/** UiMessage[] -> unified segments (the history part). */
		function buildHistory(
			messages: UiMessage[] | undefined,
			streamingMessage: UiMessage | null,
		): { segs: TraceSeg[]; full: Map<string, string>; toolKeys: Set<string> } {
			const segs: TraceSeg[] = [];
			const full = new Map<string, string>();
			const toolKeys = new Set<string>();
			let turn = 0;
			/** toolCallId -> segment, waiting to be paired with its toolResult. */
			const pending = new Map<string, TraceSeg>();
			/** toolCallId -> { argsText, ts }, to compute durations and pull paths. */
			const callInfo = new Map<string, CallInfo>();

			/** Largest end timestamp of the segments already laid down. Text blocks are
			 *  clamped to it when their start is derived backwards, so serial work never
			 *  overlaps itself. */
			let prevEnd = 0;
			const addSeg = (seg: TraceSeg, detail?: string): TraceSeg => {
				segs.push(seg);
				if (detail !== undefined) full.set(seg.key, detail);
				const e = seg.end ?? seg.t;
				if (e > prevEnd) prevEnd = e;
				return seg;
			};

			const all: HistoryMessage[] = streamingMessage
				? [...(messages ?? []), { ...streamingMessage, _live: true }]
				: (messages ?? []);
			/** For each message, the timestamp of the first timestamped message after it:
			 *  the ceiling of the generation window, since generation must finish first. */
			const nextTByMsg = new Map<HistoryMessage, number | undefined>();
			{
				let nxt: number | undefined;
				for (let i = all.length - 1; i >= 0; i--) {
					const message = all[i];
					if (!message) continue;
					nextTByMsg.set(message, nxt);
					const ts = message.timestamp;
					if (typeof ts === "number") nxt = ts;
				}
			}
			for (const m of all) {
				const live = !!m._live;
				const t = m.timestamp ?? Date.now();
				if (m.role === "user") {
					turn += 1;
					const text = blockText(m.content, "text", "text").trim() || "(attachment or empty message)";
					addSeg(
						{
							key: `h-${m.id}`,
							kind: "user",
							lane: "input",
							t,
							end: t,
							title: `User · turn ${turn}`,
							summary: cut(text, SUMMARY_CAP),
							source: "User",
							status: "done",
							turn,
							meta: { chars: text.length },
						},
						cut(text, DETAIL_CAP),
					);
				} else if (m.role === "assistant") {
					// Text blocks (thinking/answer) only carry the timestamp of when they
					// finished being created: their start is derived from their length so
					// that "thinking -> answer -> tool call" lines up serially on the
					// timeline instead of stacking at zero width on the same point.
					const blocks = m.content ?? [];
					// Which agent model produced this message, for the segment's source line.
					const modelTag = str(m.model) ? ` · ${str(m.model)}` : "";
					const ests: number[] = [];
					let totalEst = 0;
					for (const b of blocks) {
						const thinking = str(b?.thinking);
						const text = str(b?.text);
						if (b?.type === "thinking" && thinking?.trim()) {
							const e = live ? 0 : estTextMs(thinking.length);
							ests.push(e);
							totalEst += e;
						} else if (b?.type === "text" && text?.trim()) {
							const e = live ? 0 : estTextMs(text.length);
							ests.push(e);
							totalEst += e;
						}
					}
					let cursor = Math.max(t, prevEnd);
					// Generation window [t, next message): when the estimated total
					// overruns it, every block is scaled down proportionally so the text
					// stays inside the window and ends exactly where the tool call starts.
					if (!live && totalEst > 0) {
						const nextT = nextTByMsg.get(m);
						const budget = nextT !== undefined ? Math.max(0, nextT - t) : Infinity;
						if (totalEst > budget) {
							const s = budget > 0 ? budget / totalEst : 0;
							for (let i = 0; i < ests.length; i++) ests[i] = Math.max(1, Math.floor((ests[i] ?? 0) * s));
						}
					}
					let ei = 0;
					let bi = 0;
					for (const b of blocks) {
						const thinking = str(b?.thinking);
						const text = str(b?.text);
						if (b?.type === "thinking" && thinking?.trim()) {
							const est = ests[ei++] ?? 0;
							const start = cursor;
							const end = live ? t : start + Math.max(1, est);
							cursor = end;
							addSeg(
								{
									key: `h-${m.id}-${bi++}`,
									kind: "thinking",
									lane: "model",
									t: start,
									end,
									...(live ? {} : { dur: Math.max(0, end - start) }),
									title: "Thinking",
									summary: cut(thinking.trim(), SUMMARY_CAP),
									source: `Model · thinking${modelTag}`,
									status: live ? "running" : "done",
									turn,
									meta: { chars: thinking.length },
								},
								cut(thinking, DETAIL_CAP),
							);
						} else if (b?.type === "text" && text?.trim()) {
							const est = ests[ei++] ?? 0;
							const start = cursor;
							const end = live ? t : start + Math.max(1, est);
							cursor = end;
							addSeg(
								{
									key: `h-${m.id}-${bi++}`,
									kind: "text",
									lane: "model",
									t: start,
									end,
									...(live ? {} : { dur: Math.max(0, end - start) }),
									title: "Answer",
									summary: cut(text.trim(), SUMMARY_CAP),
									source: `Model · answer${modelTag}`,
									status: live ? "running" : "done",
									turn,
									meta: { chars: text.length },
								},
								cut(text, DETAIL_CAP),
							);
						} else if (b?.type === "toolCall" && b.id) {
							const callId = String(b.id);
							// A call that is still running already has a live segment, which is
							// more precise: history only records its index and builds nothing.
							if (liveTools(currentConvId, callId)) {
								callInfo.set(callId, { argsText: str(b.argumentsText) ?? "null", ts: Math.max(t, cursor) });
								continue;
							}
							const argsText = str(b.argumentsText) ?? "null";
							const toolName = str(b.name);
							const toolT = Math.max(t, cursor);
							callInfo.set(callId, { argsText, ts: toolT });
							const readonly = READONLY_TOOL_RE.test(toolName ?? "");
							const seg: TraceSeg = {
								key: `h-${callId}`,
								kind: "tool",
								lane: "tools",
								t: toolT,
								end: toolT,
								title: `${readonly ? "📖" : "🔧"} ${toolHeadline(toolName, argsText)}`,
								summary: live ? "Running…" : "(waiting for result)",
								source: `Tool · ${toolName}`,
								status: "running",
								turn,
								meta: {
									tool: toolName,
									toolCallId: callId,
									args: cut(argsText, PREVIEW_CAP),
									files: extractPaths(argsText),
								},
							};
							toolKeys.add(callId);
							pending.set(callId, seg);
							addSeg(seg, cut(argsText, DETAIL_CAP));
						}
					}
				} else if (m.role === "toolResult" && m.toolCallId) {
					const toolCallId = m.toolCallId;
					const text = blockText(m.content, "text", "text");
					const info = callInfo.get(toolCallId);
					const dur = info && m.timestamp && info.ts ? Math.max(0, m.timestamp - info.ts) : undefined;
					toolKeys.add(toolCallId);
					const seg = pending.get(toolCallId);
					const toolName = m.toolName ?? seg?.meta?.tool ?? "tool";
					if (seg) {
						pending.delete(toolCallId);
						seg.status = m.isError ? "error" : "done";
						// Clamp when the result timestamp precedes the call's start (the start
						// moved later while text blocks were derived/compressed), so no
						// duration goes negative.
						seg.end = Math.max(m.timestamp ?? seg.t, seg.t);
						const realDur =
							info && seg.end !== undefined && info.ts !== undefined ? Math.max(0, seg.end - info.ts) : undefined;
						if (realDur !== undefined) seg.dur = realDur;
						seg.title = `${m.isError ? "❌" : "✅"} ${toolHeadline(toolName, info?.argsText)}`;
						seg.summary = cut(
							m.isError
								? `Failed${realDur !== undefined ? ` · ${(realDur / 1000).toFixed(1)}s` : ""}`
								: text.trim().slice(0, 200) || "Done",
							SUMMARY_CAP,
						);
						seg.meta = { ...seg.meta, result: cut(text, PREVIEW_CAP), dur: realDur };
						full.set(seg.key, cut(text || "(no output)", DETAIL_CAP));
						if (seg.end > prevEnd) prevEnd = seg.end;
					} else {
						// A historical call that finished before the plugin was loaded (and
						// left no toolCall block behind) becomes a segment of its own.
						addSeg(
							{
								key: `h-${toolCallId}`,
								kind: "tool",
								lane: "tools",
								t,
								end: m.timestamp ?? t,
								...(dur !== undefined ? { dur } : {}),
								title: `${m.isError ? "❌" : "✅"} ${toolName}`,
								summary: cut(text.trim().slice(0, 200) || (m.isError ? "Failed" : "Done"), SUMMARY_CAP),
								source: `Tool · ${toolName}`,
								status: m.isError ? "error" : "done",
								turn,
								meta: { tool: toolName, toolCallId, result: cut(text, PREVIEW_CAP), dur },
							},
							cut(text || "(no output)", DETAIL_CAP),
						);
					}
					// File-change segment: a successful write-style tool yields the paths
					// hidden in its call arguments.
					if (!m.isError && WRITE_TOOL_RE.test(String(toolName)) && !READONLY_TOOL_RE.test(String(toolName))) {
						const files = extractPaths(info?.argsText);
						if (files.length) {
							addSeg(
								{
									key: `h-${toolCallId}-files`,
									kind: "file",
									lane: "tools",
									t,
									end: m.timestamp ?? t,
									title: `📝 ${files.length} file(s) changed`,
									summary: files.slice(0, 3).join(", ") + (files.length > 3 ? ` (of ${files.length} total)` : ""),
									source: `Tool · ${toolName}`,
									status: "done",
									turn,
									meta: { tool: toolName, files },
								},
								files.join("\n"),
							);
						}
					}
				} else if (m.role === "bashExecution") {
					const b = ((m.content ?? []).find((x) => x?.type === "bash") ?? {}) as {
						command?: unknown;
						output?: unknown;
						exitCode?: number;
						cancelled?: boolean;
					};
					const command = str(b.command) ?? "";
					const output =
						String(b.output ?? "")
							.trim()
							.slice(0, 200) || "Done";
					const failed = !!b.cancelled || (!!b.exitCode && b.exitCode !== 0);
					addSeg(
						{
							key: `h-${m.id}`,
							kind: "tool",
							lane: "tools",
							t,
							end: t,
							title: `${failed ? "❌" : "✅"} bash · ${firstLine(b.command)}`,
							summary: cut(output, SUMMARY_CAP),
							source: "Tool · bash",
							status: failed ? "error" : "done",
							turn,
							meta: { tool: "bash", command: cut(command, PREVIEW_CAP), exitCode: b.exitCode },
						},
						`$ ${command}\n${cut(String(b.output ?? ""), DETAIL_CAP)}`,
					);
				} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
					const text = blockText(m.content, "text", "text").trim();
					if (text) {
						addSeg(
							{
								key: `h-${m.id}`,
								kind: "system",
								lane: "model",
								t,
								end: t,
								title: m.role === "compactionSummary" ? "🗜️ context compacted" : "🌿 branch summary",
								summary: cut(text, SUMMARY_CAP),
								source: "System",
								status: "done",
								turn,
								meta: { chars: text.length },
							},
							cut(text, DETAIL_CAP),
						);
					}
				}
				// Custom roles other than toolResult already own a segment: no duplicate.
			}
			return { segs, full, toolKeys };
		}

		let currentConvId: string | null = null;
		const liveTools = (convId: string | null, toolCallId: string): boolean => {
			const c = convs.get(convId ?? "");
			return c ? c.liveTools.has(toolCallId) : false;
		};

		function computeAnalysis(c: Conv): TraceAnalysis {
			const tools = new Map<string, TraceToolStat>();
			let turns = 0;
			const filesChanged: string[] = [];
			let chars = 0;
			let toolErrs = 0;
			let toolMs = 0;
			const counts: Record<string, number> = { user: 0, thinking: 0, text: 0, tool: 0, file: 0, system: 0 };
			for (const s of c.segs) {
				if (s.kind in counts) counts[s.kind] += 1;
				if (s.kind === "user") turns = Math.max(turns, s.turn);
				if (s.meta?.chars) chars += s.meta.chars;
				const tool = s.meta?.tool;
				if (s.kind === "tool" && tool) {
					const stat = tools.get(tool) ?? { name: tool, calls: 0, ms: 0, errs: 0 };
					stat.calls += 1;
					if (s.dur !== undefined) {
						stat.ms += s.dur;
						toolMs += s.dur;
					}
					if (s.status === "error") {
						stat.errs += 1;
						toolErrs += 1;
					}
					tools.set(tool, stat);
				}
				const files = s.meta?.files;
				if (s.kind === "file" && Array.isArray(files)) {
					for (const file of files) if (!filesChanged.includes(file)) filesChanged.push(file);
				}
			}
			const startedAt = c.segs.length ? (c.segs[0]?.t ?? c.updatedAt) : c.updatedAt;
			const lastEnd = c.segs.reduce((max, s) => Math.max(max, s.end ?? s.t), startedAt);
			return {
				startedAt,
				totalMs: Math.max(0, lastEnd - startedAt),
				turns,
				counts,
				toolCalls: [...tools.values()].reduce((n, x) => n + x.calls, 0),
				toolErrs,
				toolMs,
				chars,
				filesChanged: filesChanged.slice(0, 50),
				tools: [...tools.values()].sort((a, b) => b.ms - a.ms).slice(0, 12),
			};
		}

		/** Pull the open conversation from the host and rebuild its timeline (debounced). */
		function refresh(): void {
			if (disposed) return;
			let snap: ConversationSnapshot | null | undefined;
			try {
				snap = host.getActiveConversation?.();
			} catch (err) {
				host.log("getActiveConversation failed:", err instanceof Error ? err.message : err);
				return;
			}
			if (!snap) return; // No conversation yet (server just started, or no session).
			const c = getConv(snap.conversationId, snap.title);
			const firstSeen = c.updatedAt === 0;
			const becameActive = activeId !== c.id;
			currentConvId = c.id;
			c.isStreaming = !!snap.isStreaming;
			c.title = snap.title || c.title;
			const { segs, full, toolKeys } = buildHistory(snap.messages, snap.streamingMessage);
			// Live tool segments: retire the ones history now contains (same toolCallId)
			// and append the rest at the end.
			for (const [id] of c.liveTools) {
				if (toolKeys.has(id)) c.liveTools.delete(id);
			}
			const live = [...c.liveTools.values()];
			c.segs = [...segs, ...live];
			c.full = full;
			for (const s of live) if (s.detail !== undefined) c.full.set(s.key, s.detail);
			c.analysis = computeAnalysis(c);
			c.updatedAt = Date.now();
			// Build everything (analysis included) before broadcasting, so the very first
			// state payload already carries the complete analysis.
			if (becameActive) {
				activeId = c.id;
				for (const x of convs.values()) x.active = x.id === activeId;
			}
			if (becameActive || firstSeen) pushState();
			host.broadcast({ kind: "segs", convId: c.id, reset: true, segs: c.segs });
			host.broadcast({ kind: "conv_update", conv: summaryOf(c) });
			if (firstSeen) host.broadcast({ kind: "conv_new", conv: summaryOf(c) });
		}

		const scheduleRefresh = (): void => {
			if (refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				refresh();
			}, REFRESH_DEBOUNCE_MS);
		};

		const offRun = host.onRunEvent((ev) => {
			try {
				if (ev.type === "tool_start") {
					const c = getConv(ev.conversationId ?? currentConvId ?? "unknown", undefined);
					const readonly = READONLY_TOOL_RE.test(String(ev.toolName ?? ""));
					const headline = toolHeadline(ev.toolName, ev.argsText);
					const argsText = String(ev.argsText ?? "null");
					const detail = cut(argsText, DETAIL_CAP);
					const seg: TraceSeg = {
						key: `L-${ev.toolCallId ?? `${Date.now()}`}`,
						kind: "tool",
						lane: "tools",
						t: ev.at,
						end: ev.at,
						title: `${readonly ? "📖" : "🔧"} ${headline}`,
						headline,
						summary: "Running…",
						source: `Tool · ${ev.toolName}`,
						status: "running",
						turn: 0,
						meta: {
							tool: ev.toolName,
							toolCallId: ev.toolCallId,
							args: cut(argsText, PREVIEW_CAP),
							files: extractPaths(ev.argsText),
						},
						detail,
					};
					if (ev.toolCallId) c.liveTools.set(ev.toolCallId, seg);
					c.segs = [...c.segs, seg];
					c.full.set(seg.key, detail);
					host.broadcast({ kind: "segs", convId: c.id, reset: false, segs: [seg] });
					// tool_start is incremental only: history does not know this call yet.
					return;
				}
				if (ev.type === "tool_end") {
					const c = convs.get(ev.conversationId ?? "");
					const seg = ev.toolCallId ? c?.liveTools.get(ev.toolCallId) : undefined;
					if (seg && c) {
						const secs = ev.durationMs !== undefined ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : "";
						const preview = cut(String(ev.resultText ?? ""), DETAIL_CAP).trim();
						const patch: Partial<TraceSeg> = {
							status: ev.isError ? "error" : "done",
							end: ev.at,
							...(ev.durationMs !== undefined ? { dur: ev.durationMs } : {}),
							title: `${ev.isError ? "❌" : "✅"} ${seg.headline ?? ev.toolName}`,
							summary: cut(
								ev.isError ? `Failed${secs}` : preview ? `${preview.slice(0, 200)}${secs}` : `Done${secs}`,
								SUMMARY_CAP,
							),
							source: seg.source,
							turn: seg.turn,
							meta: { ...seg.meta, result: cut(String(ev.resultText ?? ""), PREVIEW_CAP), dur: ev.durationMs },
						};
						Object.assign(seg, patch);
						const detail = preview || "(no output)";
						seg.detail = detail;
						c.full.set(seg.key, detail);
						host.broadcast({ kind: "seg_update", convId: c.id, key: seg.key, patch });
					}
					scheduleRefresh();
					return;
				}
				// message / run_* / turn_* -> re-pull history (debounced).
				scheduleRefresh();
			} catch (err) {
				host.log("run event failed:", err instanceof Error ? err.message : err);
			}
		});

		const offMsg = host.onMessage((payload, from) => {
			const msg = (payload ?? {}) as PluginMessage;
			try {
				switch (msg.action) {
					case "state":
						pushState(from);
						// The view has just mounted: pull the open conversation as well
						// (onAttach already pushed the state, this completes the segments).
						scheduleRefresh();
						break;
					case "get_conv": {
						const c = convs.get(String(msg.convId ?? ""));
						if (c && from) {
							host.sendTo(from, { kind: "segs", convId: c.id, reset: true, segs: c.segs });
							host.sendTo(from, { kind: "conv_update", conv: summaryOf(c) });
						} else if (from) {
							scheduleRefresh();
							host.sendTo(from, { kind: "segs", convId: String(msg.convId ?? ""), reset: true, segs: [] });
						}
						break;
					}
					case "get_seg": {
						const c = convs.get(String(msg.convId ?? ""));
						const seg = c?.segs.find((s) => s.key === String(msg.key ?? ""));
						if (c && seg && from) {
							host.sendTo(from, {
								kind: "seg_detail",
								convId: c.id,
								key: seg.key,
								detail: c.full.get(seg.key) ?? seg.summary ?? "",
								seg,
								analysis: segAnalysis(c, seg),
							});
						}
						break;
					}
					case "clear":
						convs.clear();
						activeId = null;
						currentConvId = null;
						host.broadcast({ kind: "cleared" });
						pushState();
						scheduleRefresh();
						break;
					default:
						break;
				}
			} catch (err) {
				host.log("message failed:", err instanceof Error ? err.message : err);
			}
		});

		/** Analysis of a single segment (the overview tab): tool segments carry the
		 *  totals of their own tool, everything else carries its position. */
		function segAnalysis(c: Conv, seg: TraceSeg): TraceSegAnalysis {
			const a = c.analysis;
			const total = c.segs.length || 1;
			const idx = c.segs.findIndex((s) => s.key === seg.key);
			const base: TraceSegAnalysis = {
				position: idx >= 0 ? `#${idx + 1}/${total}` : "—",
				turnText: seg.turn ? `Turn ${seg.turn}` : "—",
				convTurns: a?.turns ?? 0,
			};
			const tool = seg.meta?.tool;
			if (seg.kind === "tool" && tool && a) {
				const stat = a.tools.find((x) => x.name === tool);
				return {
					...base,
					tool: stat ?? { name: tool, calls: 1, ms: seg.dur ?? 0, errs: seg.status === "error" ? 1 : 0 },
					convToolCalls: a.toolCalls,
					convToolMs: a.toolMs,
				};
			}
			return base;
		}

		// Conversation switch (opening history / switching to the running one / a new
		// conversation / a project switch) re-pulls at once instead of waiting for the poll.
		const offConvChanged = host.onConversationChanged ? host.onConversationChanged(() => scheduleRefresh()) : () => {};

		const offAttach = host.onAttach((clientId) => {
			try {
				pushState(clientId);
				scheduleRefresh();
			} catch (err) {
				host.log("attach push failed:", err instanceof Error ? err.message : err);
			}
		});

		// Polling: 5s while streaming, 30s while idle (the safety net for external
		// changes such as switching or opening a conversation).
		const poll = (): void => {
			if (disposed) return;
			try {
				const streaming = [...convs.values()].some((c) => c.isStreaming);
				refresh();
				pollTimer = setTimeout(poll, streaming ? POLL_STREAMING_MS : POLL_IDLE_MS);
			} catch {
				pollTimer = setTimeout(poll, POLL_IDLE_MS);
			}
		};
		refresh();
		pollTimer = setTimeout(poll, POLL_STREAMING_MS);

		host.log("activated (v2: open-conversation timeline + analysis)");
		return () => {
			disposed = true;
			offRun();
			offMsg();
			offAttach();
			offConvChanged();
			if (refreshTimer) clearTimeout(refreshTimer);
			if (pollTimer) clearTimeout(pollTimer);
		};
	},
};

/**
 * run-trace server entry: what activate() wires into the host, and what those
 * wires do when they are driven.
 *
 * Everything here goes through the public surface - the default export, the mock
 * host's recorded registrations, the payloads it broadcasts and sends - and then
 * invokes them with realistic snapshots and run events. Timers are faked, so the
 * 300ms debounce and the 5s/30s poll cadence are asserted as observable behaviour
 * rather than waited out.
 *
 * The point of the exercise: a translation or a JS -> TS conversion that changed
 * a segment title, a truncation cap, a protocol key or a debounce would fail here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "../../plugins/run-trace/src/index";
import { activatePlugin, createMockHost } from "../helpers/mock-host";
import type { MockConversationSnapshot, MockHost, MockMessage } from "../helpers/mock-host";
import type { TracePayload, TraceSeg } from "../../plugins/run-trace/src/trace";

/** Marker cut() appends when it truncates. */
const TRUNCATED = "\n… [truncated]";

/** A user message asking for a novel. */
function userMessage(text: string, timestamp: number): MockMessage {
	return { id: `u-${timestamp}`, role: "user", content: [{ type: "text", text }], timestamp };
}

/** An assistant message that thinks, answers and then calls a tool. */
function assistantMessage(
	timestamp: number,
	over: { thinking?: string; text?: string; toolCall?: { id: string; name: string; argumentsText: string } } = {},
): MockMessage {
	const content: MockMessage["content"] = [];
	if (over.thinking !== undefined) content.push({ type: "thinking", thinking: over.thinking });
	if (over.text !== undefined) content.push({ type: "text", text: over.text });
	if (over.toolCall) content.push({ type: "toolCall", ...over.toolCall });
	return { id: `a-${timestamp}`, role: "assistant", content, timestamp };
}

/** A tool result closing an earlier toolCall block. */
function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	timestamp: number,
	isError = false,
): MockMessage {
	return {
		id: `t-${toolCallId}`,
		role: "toolResult",
		toolCallId,
		toolName,
		isError,
		content: [{ type: "text", text }],
		timestamp,
	};
}

/** The same turn with the tool call still in flight (no result yet). */
function pendingConversation(): MockConversationSnapshot {
	return fixtureConversation({
		messages: [
			userMessage("write a novel", 1000),
			assistantMessage(2000, {
				thinking: "hmm",
				text: "ok",
				toolCall: { id: "tc1", name: "edit", argumentsText: '{"path":"novel.md"}' },
			}),
		],
	});
}

/** The conversation the whole suite is built around: one turn, one edit, one result. */
function fixtureConversation(over: Partial<MockConversationSnapshot> = {}): MockConversationSnapshot {
	return {
		conversationId: "conv-1",
		title: "write a novel",
		at: 5000,
		isStreaming: false,
		messages: [
			userMessage("write a novel", 1000),
			assistantMessage(2000, {
				thinking: "hmm",
				text: "ok",
				toolCall: { id: "tc1", name: "edit", argumentsText: '{"path":"novel.md"}' },
			}),
			toolResult("tc1", "edit", "done editing", 5000),
		],
		streamingMessage: null,
		stats: { totalMessages: 3, tokens: { input: 0, output: 0, total: 0 }, cost: 0 },
		...over,
	};
}

/** Recorded broadcasts, narrowed to the plugin's own wire shape. */
function broadcasts(host: MockHost): TracePayload[] {
	return host.recorded.broadcasts as TracePayload[];
}

/** The `kind` of every broadcast so far, in order. */
function kinds(host: MockHost): (string | undefined)[] {
	return broadcasts(host).map((payload) => payload.kind);
}

/** Every broadcast that reset a conversation's segment list. */
function segResets(host: MockHost): TracePayload[] {
	return broadcasts(host).filter((payload) => payload.kind === "segs" && payload.reset === true);
}

/** The segments of the last full reset broadcast. */
function lastSegs(host: MockHost): TraceSeg[] {
	const resets = broadcasts(host).filter((payload) => payload.kind === "segs" && payload.reset === true);
	return resets[resets.length - 1]?.segs ?? [];
}

/** Recorded sendTo payloads, narrowed the same way. */
function sent(host: MockHost): { clientId: string; payload: TracePayload }[] {
	return host.recorded.sent as { clientId: string; payload: TracePayload }[];
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("activate", () => {
	it("subscribes to run events, client messages, attaches and conversation changes", async () => {
		const { host, deactivate } = await activatePlugin(entry);
		expect(host.recorded.handlers.runEvent.size).toBe(1);
		expect(host.recorded.handlers.message.size).toBe(1);
		expect(host.recorded.handlers.attach.size).toBe(1);
		expect(host.recorded.handlers.conversationChanged.size).toBe(1);
		// Nothing else: this plugin exposes no agent tool, slash command or HTTP route.
		expect(host.recorded.agentTools.size).toBe(0);
		expect(host.recorded.commands.size).toBe(0);
		expect(host.recorded.routes.size).toBe(0);
		expect(host.recorded.backgroundTasks.size).toBe(0);
		deactivate?.();
	});

	it("does nothing but log when no conversation is open", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		expect(host.recorded.broadcasts).toEqual([]);
		expect(host.recorded.logs.some((args) => String(args[0]).startsWith("activated"))).toBe(true);
		deactivate?.();
	});

	it("logs and carries on when the host snapshot throws", async () => {
		const host = createMockHost();
		host.getActiveConversation = () => {
			throw new Error("boom");
		};
		const cleanup = entry.activate(host);
		expect(host.recorded.logs).toContainEqual(["getActiveConversation failed:", "boom"]);
		expect(host.recorded.broadcasts).toEqual([]);
		if (typeof cleanup === "function") cleanup();
	});
});

describe("building the timeline from a conversation snapshot", () => {
	it("broadcasts state, the full segment list and the conversation summaries", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		expect(kinds(host)).toEqual(["state", "segs", "conv_update", "conv_new"]);

		const state = broadcasts(host)[0];
		expect(state?.activeId).toBe("conv-1");
		expect(state?.conversations).toHaveLength(1);
		expect(state?.conversations?.[0]).toMatchObject({
			id: "conv-1",
			title: "write a novel",
			active: true,
			isStreaming: false,
			segCount: 5,
		});
		deactivate?.();
	});

	it("turns one turn into user, thinking, answer, tool and file segments", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		const segs = lastSegs(host);
		expect(segs.map((s) => [s.key, s.kind, s.lane, s.status])).toEqual([
			["h-u-1000", "user", "input", "done"],
			["h-a-2000-0", "thinking", "model", "done"],
			["h-a-2000-1", "text", "model", "done"],
			["h-tc1", "tool", "tools", "done"],
			["h-tc1-files", "file", "tools", "done"],
		]);
		deactivate?.();
	});

	it("lays the text blocks out serially from the message timestamp", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		const [, thinking, answer, tool] = lastSegs(host);
		// Both blocks are short, so each is clamped to the 800ms floor and they run
		// one after the other from the assistant timestamp, not on top of each other.
		expect(thinking).toMatchObject({ t: 2000, end: 2800, dur: 800 });
		expect(answer).toMatchObject({ t: 2800, end: 3600, dur: 800 });
		// The tool call starts where the text ended and ends where the result arrived.
		expect(tool).toMatchObject({ t: 3600, end: 5000, dur: 1400 });
		deactivate?.();
	});

	it("compresses estimated generation time into the window before the next message", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					userMessage("hi", 1000),
					assistantMessage(2000, { thinking: "x".repeat(2000), text: "y".repeat(2000) }),
					userMessage("next", 4000),
				],
			}),
		});
		const [, thinking, answer] = lastSegs(host);
		// Uncompressed both blocks would want 40s each; the window is 2s, so each is
		// scaled to half of it and the pair still ends exactly where the window ends.
		expect(thinking?.t).toBe(2000);
		expect(thinking?.end).toBe(3000);
		expect(answer?.t).toBe(3000);
		expect(answer?.end).toBe(4000);
		deactivate?.();
	});

	it("titles and sources every segment in English", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		const [user, thinking, answer, tool, file] = lastSegs(host);
		expect(user).toMatchObject({ title: "User · turn 1", source: "User", summary: "write a novel", turn: 1 });
		expect(thinking).toMatchObject({ title: "Thinking", source: "Model · thinking", summary: "hmm" });
		expect(answer).toMatchObject({ title: "Answer", source: "Model · answer", summary: "ok" });
		expect(tool).toMatchObject({ title: "✅ edit · novel.md", source: "Tool · edit", summary: "done editing" });
		expect(file).toMatchObject({ title: "📝 1 file(s) changed", source: "Tool · edit", summary: "novel.md" });
		deactivate?.();
	});

	it("marks a pending tool call as running with a read-only or write icon", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					assistantMessage(1000, { toolCall: { id: "r1", name: "read", argumentsText: '{"path":"a/b.txt"}' } }),
					assistantMessage(2000, { toolCall: { id: "w1", name: "write", argumentsText: '{"path":"c/d.txt"}' } }),
				],
			}),
		});
		const segs = lastSegs(host);
		expect(segs.map((s) => [s.key, s.title, s.status, s.summary])).toEqual([
			["h-r1", "📖 read · a/b.txt", "running", "(waiting for result)"],
			["h-w1", "🔧 write · c/d.txt", "running", "(waiting for result)"],
		]);
		// No result arrived, so neither call produced a file-change segment.
		expect(segs.filter((s) => s.kind === "file")).toEqual([]);
		deactivate?.();
	});

	it("marks a failed tool call as an error and says so", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					assistantMessage(1000, { toolCall: { id: "e1", name: "edit", argumentsText: '{"path":"a/b.txt"}' } }),
					toolResult("e1", "edit", "permission denied", 3000, true),
				],
			}),
		});
		const segs = lastSegs(host);
		expect(segs.map((s) => [s.key, s.status])).toEqual([["h-e1", "error"]]);
		expect(segs[0]).toMatchObject({ title: "❌ edit · a/b.txt", summary: "Failed · 2.0s" });
		// A failed write changed nothing, so it produces no file segment.
		expect(segs.filter((s) => s.kind === "file")).toEqual([]);
		deactivate?.();
	});

	it("does not add a file segment for a read-only tool that mentions a path", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					assistantMessage(1000, { toolCall: { id: "r1", name: "read", argumentsText: '{"path":"a/b.txt"}' } }),
					toolResult("r1", "read", "contents", 2000),
				],
			}),
		});
		expect(lastSegs(host).map((s) => s.kind)).toEqual(["tool"]);
		deactivate?.();
	});

	it("lists up to three changed files and says how many there are in total", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					assistantMessage(1000, {
						toolCall: { id: "w1", name: "write", argumentsText: '{"files":["a/1","b/2","c/3","d/4","e/5"]}' },
					}),
					toolResult("w1", "write", "ok", 2000),
				],
			}),
		});
		const file = lastSegs(host).find((s) => s.kind === "file");
		expect(file?.summary).toBe("a/1, b/2, c/3 (of 5 total)");
		expect(file?.meta?.files).toEqual(["a/1", "b/2", "c/3", "d/4", "e/5"]);
		deactivate?.();
	});

	it("renders a bash execution message as a tool segment", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					{
						id: "b1",
						role: "bashExecution",
						content: [{ type: "bash", command: "ls -la", output: "total 0", exitCode: 0 }],
						timestamp: 1000,
					},
					{
						id: "b2",
						role: "bashExecution",
						content: [{ type: "bash", command: "false", output: "", exitCode: 1 }],
						timestamp: 2000,
					},
				],
			}),
		});
		const segs = lastSegs(host);
		expect(segs.map((s) => [s.title, s.status, s.summary])).toEqual([
			["✅ bash · ls -la", "done", "total 0"],
			["❌ bash · false", "error", "Done"],
		]);
		expect(segs[0]?.meta).toMatchObject({ tool: "bash", exitCode: 0, command: "ls -la" });
		deactivate?.();
	});

	it("renders compaction and branch summaries as system segments", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					{ id: "c1", role: "compactionSummary", content: [{ type: "text", text: "compacted" }], timestamp: 1000 },
					{ id: "c2", role: "branchSummary", content: [{ type: "text", text: "branched" }], timestamp: 2000 },
					{ id: "c3", role: "compactionSummary", content: [{ type: "text", text: "   " }], timestamp: 3000 },
				],
			}),
		});
		const segs = lastSegs(host);
		expect(segs.map((s) => [s.kind, s.lane, s.title, s.summary])).toEqual([
			["system", "model", "🗜️ context compacted", "compacted"],
			["system", "model", "🌿 branch summary", "branched"],
		]);
		deactivate?.();
	});

	it("labels an empty user message instead of showing a blank row", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [{ id: "u1", role: "user", content: [], timestamp: 1000 }],
			}),
		});
		const fallback = "(attachment or empty message)";
		expect(lastSegs(host)[0]).toMatchObject({ summary: fallback, meta: { chars: fallback.length } });
		deactivate?.();
	});

	it("shows the streaming message as running, without a duration", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [userMessage("go", 1000)],
				streamingMessage: {
					id: "a-live",
					role: "assistant",
					content: [{ type: "thinking", thinking: "still working" }],
					timestamp: 2000,
				},
			}),
		});
		const live = lastSegs(host).find((s) => s.key === "h-a-live-0");
		expect(live).toMatchObject({ kind: "thinking", status: "running", t: 2000, end: 2000 });
		expect(live?.dur).toBeUndefined();
		expect("dur" in (live ?? {})).toBe(false);
		deactivate?.();
	});

	it("rebuilds a tool result that has no matching tool call left", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [toolResult("orphan", "grep", "3 matches", 4000)],
			}),
		});
		expect(lastSegs(host).map((s) => [s.key, s.kind, s.title, s.status, s.dur])).toEqual([
			["h-orphan", "tool", "✅ grep", "done", undefined],
		]);
		deactivate?.();
	});

	it("truncates the summary, the argument preview and the stored detail", async () => {
		const hugeResult = "r".repeat(9000);
		const hugeArgs = JSON.stringify({ path: "a/b.txt", pad: "p".repeat(5000) });
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					assistantMessage(1000, { toolCall: { id: "big", name: "edit", argumentsText: hugeArgs } }),
					toolResult("big", "edit", hugeResult, 2000),
				],
			}),
		});
		const tool = lastSegs(host).find((s) => s.key === "h-big");
		expect(tool?.summary).toHaveLength(200);
		expect(tool?.meta?.args).toHaveLength(4000 + TRUNCATED.length);
		expect(tool?.meta?.result).toHaveLength(4000 + TRUNCATED.length);
		expect(tool?.meta?.args?.endsWith(TRUNCATED)).toBe(true);

		// The stored detail is only visible through get_seg.
		await host.emit.message({ action: "get_seg", convId: "conv-1", key: "h-big" }, "client-1");
		const detail = sent(host).find((x) => x.payload.kind === "seg_detail")?.payload;
		expect(detail?.detail).toHaveLength(8000 + TRUNCATED.length);
		expect(detail?.detail?.startsWith(hugeResult.slice(0, 8000))).toBe(true);
		deactivate?.();
	});

	it("computes the conversation analysis the detail pane shows", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		const conv = broadcasts(host).find((payload) => payload.kind === "conv_update")?.conv;
		expect(conv?.analysis).toMatchObject({
			startedAt: 1000,
			totalMs: 4000,
			turns: 1,
			toolCalls: 1,
			toolErrs: 0,
			toolMs: 1400,
			chars: 18,
			filesChanged: ["novel.md"],
			counts: { user: 1, thinking: 1, text: 1, tool: 1, file: 1, system: 0 },
		});
		expect(conv?.analysis?.tools).toEqual([{ name: "edit", calls: 1, ms: 1400, errs: 0 }]);
		deactivate?.();
	});

	it("counts failed tool calls in the analysis", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({
				messages: [
					assistantMessage(1000, { toolCall: { id: "x1", name: "bash", argumentsText: '{"command":"false"}' } }),
					toolResult("x1", "bash", "exit 1", 2000, true),
					assistantMessage(3000, { toolCall: { id: "x2", name: "bash", argumentsText: '{"command":"true"}' } }),
					toolResult("x2", "bash", "ok", 4000),
				],
			}),
		});
		const analysis = broadcasts(host).find((payload) => payload.kind === "conv_update")?.conv?.analysis;
		expect(analysis).toMatchObject({ toolCalls: 2, toolErrs: 1, toolMs: 2000 });
		expect(analysis?.tools).toEqual([{ name: "bash", calls: 2, ms: 2000, errs: 1 }]);
		deactivate?.();
	});
});

describe("client message protocol", () => {
	it("answers a state request with the sender only", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.broadcasts.length = 0;
		await host.emit.message({ action: "state" }, "client-1");
		expect(host.recorded.broadcasts).toEqual([]);
		expect(sent(host)).toHaveLength(1);
		expect(sent(host)[0]).toMatchObject({ clientId: "client-1" });
		expect(sent(host)[0]?.payload.kind).toBe("state");
		deactivate?.();
	});

	it("sends the segments and summary of a known conversation", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "get_conv", convId: "conv-1" }, "client-1");
		expect(sent(host).map((x) => x.payload.kind)).toEqual(["segs", "conv_update"]);
		expect(sent(host)[0]?.payload).toMatchObject({ convId: "conv-1", reset: true });
		expect(sent(host)[0]?.payload.segs).toHaveLength(5);
		deactivate?.();
	});

	it("answers an unknown conversation with an empty segment list", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "get_conv", convId: "nope" }, "client-1");
		expect(sent(host)).toHaveLength(1);
		expect(sent(host)[0]?.payload).toEqual({ kind: "segs", convId: "nope", reset: true, segs: [] });
		deactivate?.();
	});

	it("sends one segment's detail with its own analysis", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "get_seg", convId: "conv-1", key: "h-tc1" }, "client-1");
		const payload = sent(host)[0]?.payload;
		expect(payload?.kind).toBe("seg_detail");
		expect(payload).toMatchObject({ convId: "conv-1", key: "h-tc1", detail: "done editing" });
		expect(payload?.analysis).toEqual({
			position: "#4/5",
			turnText: "Turn 1",
			convTurns: 1,
			tool: { name: "edit", calls: 1, ms: 1400, errs: 0 },
			convToolCalls: 1,
			convToolMs: 1400,
		});
		expect(payload?.seg?.title).toBe("✅ edit · novel.md");
		deactivate?.();
	});

	it("sends the position of a segment that is not a tool call", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		await host.emit.message({ action: "get_seg", convId: "conv-1", key: "h-u-1000" }, "client-1");
		const payload = sent(host).find((x) => x.payload.kind === "seg_detail")?.payload;
		expect(payload?.analysis).toEqual({ position: "#1/5", turnText: "Turn 1", convTurns: 1 });
		deactivate?.();
	});

	it("sends nothing for a segment key that does not exist", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "get_seg", convId: "conv-1", key: "missing" }, "client-1");
		await host.emit.message({ action: "get_seg", convId: "nope", key: "h-tc1" }, "client-1");
		expect(sent(host)).toEqual([]);
		deactivate?.();
	});

	it("ignores an unknown, malformed or sender-less message", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.broadcasts.length = 0;
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "nonsense" }, "client-1");
		await host.emit.message(undefined, "client-1");
		await host.emit.message("not an object", "client-1");
		await host.emit.message({ action: "get_conv", convId: "conv-1" });
		expect(host.recorded.broadcasts).toEqual([]);
		expect(sent(host)).toEqual([]);
		deactivate?.();
	});

	it("clears every conversation and tells the clients", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.broadcasts.length = 0;
		await host.emit.message({ action: "clear" }, "client-1");
		expect(kinds(host)).toEqual(["cleared", "state"]);
		expect(broadcasts(host)[1]).toMatchObject({ conversations: [], activeId: null });

		// The cache is really gone: the same conversation now answers with nothing.
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "get_conv", convId: "conv-1" }, "client-1");
		expect(sent(host)[0]?.payload).toEqual({ kind: "segs", convId: "conv-1", reset: true, segs: [] });
		deactivate?.();
	});

	it("pushes the full state to a client that just attached", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		host.recorded.sent.length = 0;
		await host.emit.attach("client-9");
		expect(sent(host)).toHaveLength(1);
		expect(sent(host)[0]?.clientId).toBe("client-9");
		expect(sent(host)[0]?.payload.kind).toBe("state");
		deactivate?.();
	});
});

describe("live run events", () => {
	it("appends a running tool segment on tool_start without re-pulling history", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({
			type: "tool_start",
			at: 10_000,
			conversationId: "c1",
			toolCallId: "tc9",
			toolName: "read",
			argsText: '{"path":"a/b.txt"}',
		});
		expect(kinds(host)).toEqual(["segs"]);
		const payload = broadcasts(host)[0];
		expect(payload).toMatchObject({ convId: "c1", reset: false });
		expect(payload?.segs).toEqual([
			{
				key: "L-tc9",
				kind: "tool",
				lane: "tools",
				t: 10_000,
				end: 10_000,
				title: "📖 read · a/b.txt",
				headline: "read · a/b.txt",
				summary: "Running…",
				source: "Tool · read",
				status: "running",
				turn: 0,
				meta: { tool: "read", toolCallId: "tc9", args: '{"path":"a/b.txt"}', files: ["a/b.txt"] },
				detail: '{"path":"a/b.txt"}',
			},
		]);
		deactivate?.();
	});

	it("patches the live segment in place when the tool finishes", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({
			type: "tool_start",
			at: 10_000,
			conversationId: "c1",
			toolCallId: "tc9",
			toolName: "edit",
			argsText: '{"path":"a/b.txt"}',
		});
		await host.emit.runEvent({
			type: "tool_end",
			at: 10_500,
			conversationId: "c1",
			toolCallId: "tc9",
			toolName: "edit",
			resultText: "file body",
			durationMs: 500,
		});
		const update = broadcasts(host).find((payload) => payload.kind === "seg_update");
		expect(update).toMatchObject({ convId: "c1", key: "L-tc9" });
		expect(update?.patch).toEqual({
			status: "done",
			end: 10_500,
			dur: 500,
			title: "✅ edit · a/b.txt",
			summary: "file body · 0.5s",
			source: "Tool · edit",
			turn: 0,
			meta: {
				tool: "edit",
				toolCallId: "tc9",
				args: '{"path":"a/b.txt"}',
				files: ["a/b.txt"],
				result: "file body",
				dur: 500,
			},
		});
		deactivate?.();
	});

	it("reports a failed tool and an empty result differently", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({
			type: "tool_start",
			at: 1000,
			conversationId: "c1",
			toolCallId: "bad",
			toolName: "bash",
			argsText: '{"command":"false"}',
		});
		await host.emit.runEvent({
			type: "tool_end",
			at: 2000,
			conversationId: "c1",
			toolCallId: "bad",
			toolName: "bash",
			resultText: "",
			durationMs: 1000,
			isError: true,
		});
		await host.emit.runEvent({
			type: "tool_start",
			at: 3000,
			conversationId: "c1",
			toolCallId: "quiet",
			toolName: "bash",
			argsText: '{"command":"true"}',
		});
		await host.emit.runEvent({
			type: "tool_end",
			at: 3000,
			conversationId: "c1",
			toolCallId: "quiet",
			toolName: "bash",
			resultText: "",
		});
		const patches = broadcasts(host).filter((payload) => payload.kind === "seg_update");
		expect(patches[0]?.patch).toMatchObject({ status: "error", title: "❌ bash · false", summary: "Failed · 1.0s" });
		// No durationMs at all: the patch carries no dur and the summary has no time.
		expect(patches[1]?.patch).toMatchObject({ status: "done", title: "✅ bash · true", summary: "Done" });
		expect(patches[1]?.patch?.dur).toBeUndefined();
		deactivate?.();
	});

	it("serves the finished live segment's detail to get_seg", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({
			type: "tool_start",
			at: 1000,
			conversationId: "c1",
			toolCallId: "tc9",
			toolName: "read",
			argsText: '{"path":"a/b.txt"}',
		});
		await host.emit.runEvent({
			type: "tool_end",
			at: 1500,
			conversationId: "c1",
			toolCallId: "tc9",
			toolName: "read",
			resultText: "the body",
			durationMs: 500,
		});
		await host.emit.message({ action: "get_seg", convId: "c1", key: "L-tc9" }, "client-1");
		const payload = sent(host).find((x) => x.payload.kind === "seg_detail")?.payload;
		expect(payload?.detail).toBe("the body");
		// No snapshot was ever available, so there is no conversation analysis yet.
		expect(payload?.analysis).toEqual({ position: "#1/1", turnText: "—", convTurns: 0 });
		deactivate?.();
	});

	it("stores an empty result as an explicit no-output detail", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({
			type: "tool_start",
			at: 1000,
			conversationId: "c1",
			toolCallId: "tc9",
			toolName: "read",
			argsText: '{"path":"a/b.txt"}',
		});
		await host.emit.runEvent({
			type: "tool_end",
			at: 1500,
			conversationId: "c1",
			toolCallId: "tc9",
			resultText: "   ",
		});
		await host.emit.message({ action: "get_seg", convId: "c1", key: "L-tc9" }, "client-1");
		const payload = sent(host).find((x) => x.payload.kind === "seg_detail")?.payload;
		expect(payload?.detail).toBe("(no output)");
		deactivate?.();
	});

	it("ignores a tool_end for a call it never saw start", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({
			type: "tool_end",
			at: 1000,
			conversationId: "c1",
			toolCallId: "unknown",
			toolName: "read",
			resultText: "x",
			durationMs: 5,
		});
		expect(broadcasts(host).filter((payload) => payload.kind === "seg_update")).toEqual([]);
		deactivate?.();
	});

	it("gives a tool_start without an id a generated key and no live entry", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		await host.emit.runEvent({ type: "tool_start", at: 1000, conversationId: "c1", toolName: "read" });
		const payload = broadcasts(host)[0];
		expect(payload?.segs?.[0]?.key).toMatch(/^L-\d+$/);
		// Without an id nothing can be matched later, so tool_end cannot patch it.
		await host.emit.runEvent({ type: "tool_end", at: 1100, conversationId: "c1", durationMs: 100 });
		expect(broadcasts(host).filter((x) => x.kind === "seg_update")).toEqual([]);
		deactivate?.();
	});

	it("re-pulls history after a debounced 300ms for any other run event", async () => {
		const overrides = { activeConversation: null as MockConversationSnapshot | null };
		const { host, deactivate } = await activatePlugin(entry, overrides);
		overrides.activeConversation = fixtureConversation();

		await host.emit.runEvent({ type: "message", at: 1000, conversationId: "conv-1" });
		expect(segResets(host)).toHaveLength(0);
		vi.advanceTimersByTime(299);
		expect(segResets(host)).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(segResets(host)).toHaveLength(1);
		expect(lastSegs(host)).toHaveLength(5);
		deactivate?.();
	});

	it("collapses a burst of run events into a single re-pull", async () => {
		const overrides = { activeConversation: null as MockConversationSnapshot | null };
		const { host, deactivate } = await activatePlugin(entry, overrides);
		overrides.activeConversation = fixtureConversation();

		for (let i = 0; i < 5; i++) {
			await host.emit.runEvent({ type: "turn_start", at: 1000 + i, conversationId: "conv-1" });
			vi.advanceTimersByTime(50);
		}
		vi.advanceTimersByTime(300);
		expect(segResets(host)).toHaveLength(1);
		deactivate?.();
	});

	it("keeps the live segment while the same call is still in flight", async () => {
		const overrides = { activeConversation: null as MockConversationSnapshot | null };
		const { host, deactivate } = await activatePlugin(entry, overrides);
		await host.emit.runEvent({
			type: "tool_start",
			at: 1000,
			conversationId: "conv-1",
			toolCallId: "tc1",
			toolName: "edit",
			argsText: '{"path":"novel.md"}',
		});
		// The snapshot has the toolCall but no result yet: the live segment is more
		// precise, so history must not build a second segment for the same call.
		overrides.activeConversation = pendingConversation();
		await host.emit.runEvent({ type: "message", at: 2000, conversationId: "conv-1" });
		vi.advanceTimersByTime(300);

		const segs = lastSegs(host);
		expect(segs.filter((s) => s.key === "h-tc1")).toEqual([]);
		expect(segs.filter((s) => s.key === "L-tc1")).toHaveLength(1);
		expect(segs[segs.length - 1]?.key).toBe("L-tc1");
		expect(segs[segs.length - 1]?.status).toBe("running");
		deactivate?.();
	});

	it("retires a live segment once history contains its result", async () => {
		const overrides = { activeConversation: null as MockConversationSnapshot | null };
		const { host, deactivate } = await activatePlugin(entry, overrides);
		await host.emit.runEvent({
			type: "tool_start",
			at: 1000,
			conversationId: "conv-1",
			toolCallId: "tc1",
			toolName: "edit",
			argsText: '{"path":"novel.md"}',
		});
		overrides.activeConversation = pendingConversation();
		await host.emit.runEvent({ type: "message", at: 2000, conversationId: "conv-1" });
		vi.advanceTimersByTime(300);
		expect(lastSegs(host).some((s) => s.key === "L-tc1")).toBe(true);

		// The snapshot now carries the result too, so history owns the segment.
		overrides.activeConversation = fixtureConversation();
		await host.emit.runEvent({ type: "run_end", at: 6000, conversationId: "conv-1" });
		vi.advanceTimersByTime(300);
		const segs = lastSegs(host);
		expect(segs.some((s) => s.key === "L-tc1")).toBe(false);
		expect(segs.filter((s) => s.key === "h-tc1")).toHaveLength(1);
		// The call was still live when the history pass ran, so the result is rebuilt
		// as a standalone segment (bare tool name) rather than patched into a pending one.
		expect(segs.find((s) => s.key === "h-tc1")).toMatchObject({ status: "done", title: "✅ edit", dur: 1400 });
		expect(segs.some((s) => s.key === "h-tc1-files")).toBe(true);
		deactivate?.();
	});
});

describe("refresh cadence", () => {
	it("polls every 5 seconds while a conversation is streaming", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({ isStreaming: true }),
		});
		expect(segResets(host)).toHaveLength(1);
		vi.advanceTimersByTime(5000);
		expect(segResets(host)).toHaveLength(2);
		vi.advanceTimersByTime(5000);
		expect(segResets(host)).toHaveLength(3);
		deactivate?.();
	});

	it("drops to a 30 second poll once nothing is streaming", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation({ isStreaming: false }),
		});
		expect(segResets(host)).toHaveLength(1);
		// The first poll is always scheduled at the streaming interval.
		vi.advanceTimersByTime(5000);
		expect(segResets(host)).toHaveLength(2);
		vi.advanceTimersByTime(5000);
		expect(segResets(host)).toHaveLength(2);
		vi.advanceTimersByTime(25_000);
		expect(segResets(host)).toHaveLength(3);
		deactivate?.();
	});

	it("re-pulls immediately when the open conversation changes", async () => {
		const overrides = { activeConversation: null as MockConversationSnapshot | null };
		const { host, deactivate } = await activatePlugin(entry, overrides);
		overrides.activeConversation = fixtureConversation();
		await host.emit.conversationChanged();
		vi.advanceTimersByTime(300);
		expect(segResets(host)).toHaveLength(1);
		deactivate?.();
	});

	it("does not re-announce state or the conversation on a later refresh", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		expect(kinds(host)).toEqual(["state", "segs", "conv_update", "conv_new"]);
		host.recorded.broadcasts.length = 0;
		vi.advanceTimersByTime(30_000);
		expect(kinds(host)).toEqual(["segs", "conv_update"]);
		deactivate?.();
	});

	it("announces a second conversation without dropping the first", async () => {
		const overrides = { activeConversation: fixtureConversation() as MockConversationSnapshot | null };
		const { host, deactivate } = await activatePlugin(entry, overrides);
		host.recorded.broadcasts.length = 0;
		overrides.activeConversation = fixtureConversation({ conversationId: "conv-2", title: "fix a bug" });
		await host.emit.conversationChanged();
		vi.advanceTimersByTime(300);

		expect(kinds(host)).toEqual(["state", "segs", "conv_update", "conv_new"]);
		const state = broadcasts(host)[0];
		expect(state?.activeId).toBe("conv-2");
		expect(state?.conversations?.map((c) => c.id).sort()).toEqual(["conv-1", "conv-2"]);
		deactivate?.();
	});

	it("keeps at most ten conversations, evicting the least recently updated", async () => {
		const { host, deactivate } = await activatePlugin(entry, { activeConversation: null });
		for (let i = 1; i <= 12; i++) {
			await host.emit.runEvent({
				type: "tool_start",
				at: i,
				conversationId: `c${i}`,
				toolCallId: `t${i}`,
				toolName: "read",
			});
		}
		await host.emit.message({ action: "state" }, "client-1");
		const state = sent(host).find((x) => x.payload.kind === "state")?.payload;
		const ids = state?.conversations?.map((c) => c.id) ?? [];
		expect(ids).toHaveLength(10);
		expect(ids).not.toContain("c1");
		expect(ids).not.toContain("c2");
		expect(ids).toContain("c12");
		deactivate?.();
	});
});

describe("deactivate", () => {
	it("unregisters every handler and stops the timers", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		expect(typeof deactivate).toBe("function");
		deactivate?.();

		expect(host.recorded.handlers.runEvent.size).toBe(0);
		expect(host.recorded.handlers.message.size).toBe(0);
		expect(host.recorded.handlers.attach.size).toBe(0);
		expect(host.recorded.handlers.conversationChanged.size).toBe(0);

		const before = host.recorded.broadcasts.length;
		vi.advanceTimersByTime(120_000);
		expect(host.recorded.broadcasts).toHaveLength(before);
	});

	it("stops answering client messages once deactivated", async () => {
		const { host, deactivate } = await activatePlugin(entry, {
			activeConversation: fixtureConversation(),
		});
		deactivate?.();
		host.recorded.sent.length = 0;
		await host.emit.message({ action: "state" }, "client-1");
		expect(sent(host)).toEqual([]);
	});
});

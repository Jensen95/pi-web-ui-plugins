#!/usr/bin/env node

/**
 * Pi summarization and extension-owned nested completions set
 * cacheRetention="none". The bridge must route those requests to a standalone
 * Claude Code subprocess before prompt capture or shared-session handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

describe("standalone provider routing", () => {
	it("recognizes the one-message, tool-free, explicit no-cache shape", () => {
		const standalone = { messages: [user("summarize")] };
		assert.equal(__test.isStandaloneRequest(standalone, { cacheRetention: "none" }), true);
		assert.equal(__test.isStandaloneRequest(standalone, { cacheRetention: "short" }), false);
		assert.equal(__test.isStandaloneRequest(standalone, {}), false);
		assert.equal(__test.isStandaloneRequest(standalone), false);
		assert.equal(
			__test.isStandaloneRequest({ ...standalone, tools: [] }, { cacheRetention: "none" }),
			false,
			"an ordinary agent turn may disable caching without becoming a standalone call",
		);
		assert.equal(
			__test.isStandaloneRequest({ messages: [user("a"), user("b")] }, { cacheRetention: "none" }),
			false,
		);
	});

	it("accepts the one-user-message shape used by summaries and planners", () => {
		assert.equal(
			__test.extractStandalonePrompt({ systemPrompt: "planner", messages: [user("PLAN REQUEST")] }),
			"PLAN REQUEST",
		);
	});

	it("rejects stateful conversations and tool-bearing standalone calls", () => {
		assert.throws(
			() => __test.extractStandalonePrompt({ messages: [user("a"), user("b")] }),
			/expected exactly 1 user message/,
		);
		assert.throws(
			() => __test.extractStandalonePrompt({ messages: [user("a")], tools: [{ name: "plan" }] }),
			/do not support tools/,
		);
	});

	it("does not compete with other compaction or tree extensions", () => {
		const handlers = activateWithMockPi();
		assert.equal(handlers.has("session_before_compact"), false);
		assert.equal(handlers.has("session_before_tree"), false);
	});
});

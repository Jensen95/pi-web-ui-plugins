#!/usr/bin/env node
// Branch summarization through the generic standalone provider route, end to end.
//
// Pi marks summary calls cacheRetention="none". The bridge must route that request
// before prompt capture and shared-session synchronization because its internal
// summarization prompt never passed through `before_agent_start`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

const harness = createRpcHarness({
	name: "branch-summary",
	args: [
		"-e", "./tests/fixtures/tree-nav-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("branch summarization standalone routing", () => {
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => { await stop(); });

	/** The command returns before the summary finishes, and a slash command emits no
	 *  agent_end, so wait on the standalone subprocess log. */
	async function waitForLog(mark, pattern, timeout = 90_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const slice = readFileSync(DEBUG_LOG, "utf8").slice(mark);
			if (pattern.test(slice)) return slice;
			await sleep(500);
		}
		return readFileSync(DEBUG_LOG, "utf8").slice(mark);
	}

	it("summarizes an abandoned branch without routing through the live provider", { timeout: TEST_TIMEOUT }, async () => {
		// Two turns so rewinding to the first leaves something worth summarizing.
		await promptAndWait("Reply with exactly the word ALPHA and nothing else.");
		await promptAndWait("Reply with exactly the word BETA and nothing else.");

		const mark = statSync(DEBUG_LOG).size;
		await send({ type: "prompt", message: "/rewind-summarize" });

		const log = await waitForLog(mark, /standalone: done textLen=/);

		assert.match(log, /routing standalone cacheRetention=none request to isolated subprocess/, `standalone route never fired:\n${log.slice(-1500)}`);
		assert.match(
			log,
			/standalone: done textLen=[1-9]\d*/,
			`standalone route produced no summary:\n${log.slice(-1500)}`,
		);
		// The whole point: the resolver that would have refused Pi's internal
		// summarization prompt was never consulted.
		assert.doesNotMatch(log, /no capture for this \d+-char system prompt/, "the summary reached the provider path");
	});
});

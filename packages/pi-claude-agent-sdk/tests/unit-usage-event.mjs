import assert from "node:assert/strict";
import { describe, it } from "node:test";
const { __test } = await import("../src/index.js");

const model = { id: "claude-sonnet-5", provider: "claude-bridge-personal", api: "claude-bridge" };
describe("Claude usage events", () => {
	it("normalizes rate_limit_event for its folder-backed profile", async () => {
		async function* stream() { yield { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: .8, resetsAt: 123 } }; }
		const seen = [];
		const context = { currentPiStream: null, turnOutput: null };
		await __test.consumeQuery(stream(), new Map(), model, () => false, context, { name: "personal", providerId: "claude-bridge-personal", claudeDir: "/tmp/personal" }, (event) => seen.push(event));
		assert.equal(seen.length, 1);
		assert.deepEqual({ ...seen[0], observedAt: 0 }, { providerId: "claude-bridge-personal", profile: "personal", observedAt: 0, status: "allowed_warning", rateLimitType: "five_hour", utilization: .8, resetsAt: 123 });
	});
});

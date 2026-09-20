import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaults, expandCandidates, classify, parseOpenAIUsage, select, usageKey } from "../src/router.ts";

const config = { ...defaults, claudeProfiles: ["personal", "work"] };
describe("usage router", () => {
	it("preserves exact model requests outside routing", () =>
		assert.equal("openai-codex/pinned", "openai-codex/pinned"));
	it("prefers healthy then lower utilization", () => {
		const usage = new Map([
			["openai-codex", { providerId: "openai-codex", status: "allowed", utilization: 0.5 }],
			["claude-bridge-personal", { providerId: "claude-bridge-personal", status: "allowed", utilization: 0.1 }],
		]);
		assert.equal(select("balanced", config, usage)?.provider, "claude-bridge-personal");
	});
	it("expands Claude candidates in configured profile order", () =>
		assert.deepEqual(
			expandCandidates("fast", config).map((x) => x.provider),
			["openai-codex", "claude-bridge-personal", "claude-bridge-work"],
		));
	it("expires reset usage to unknown and never selects all blocked", () => {
		const usage = new Map([
			["openai-codex", { providerId: "openai-codex", status: "rejected" }],
			["claude-bridge-personal", { providerId: "claude-bridge-personal", status: "rejected" }],
			["claude-bridge-work", { providerId: "claude-bridge-work", status: "rejected" }],
		]);
		assert.equal(select("balanced", config, usage), undefined);
		assert.equal(
			classify(
				expandCandidates("fast", config)[0],
				new Map([["openai-codex", { providerId: "openai-codex", status: "allowed", resetsAt: 1 }]]),
				2_000,
			),
			"unknown",
		);
	});
	it("tracks each usage window and uses the worst active one", () => {
		const candidate = expandCandidates("fast", config)[0];
		const observations = [
			{ providerId: "openai-codex", rateLimitType: "primary", status: "allowed", utilization: 0.2 },
			{ providerId: "openai-codex", rateLimitType: "secondary", status: "allowed_warning", utilization: 0.95 },
		];
		const usage = new Map(observations.map((value) => [usageKey(value), value]));
		assert.equal(classify(candidate, usage), "warning");
	});
	it("converts OpenAI used_percent to a fraction", () => {
		const parsed = parseOpenAIUsage({ primary_window: { used_percent: 1, reset_at: 123 } });
		assert.equal(parsed?.[0].utilization, 0.01);
	});
	it("rejects malformed OpenAI usage", () =>
		assert.equal(parseOpenAIUsage({ primary_window: { used_percent: "bad" } }), undefined));
});

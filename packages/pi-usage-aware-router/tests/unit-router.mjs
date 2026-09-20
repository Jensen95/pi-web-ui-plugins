import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaults, expandCandidates, classify, parseOpenAIUsage, select } from "../src/router.ts";

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
	it("rejects malformed OpenAI usage", () =>
		assert.equal(parseOpenAIUsage({ primary_window: { used_percent: "bad" } }), undefined));
});

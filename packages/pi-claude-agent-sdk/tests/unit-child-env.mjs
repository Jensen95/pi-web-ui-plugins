import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { CC_CHILD_ENV, buildClaudeChildEnv } = await import("../src/child-env.js");

describe("Claude Code profile environment", () => {
	it("disables auto-compaction and claude.ai MCP servers", () => {
		assert.deepEqual(CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
	});

	it("binds the child to its configured folder and strips inherited credentials", () => {
		const env = buildClaudeChildEnv(
			{
				CLAUDE_CONFIG_DIR: "/wrong",
				CLAUDE_CODE_OAUTH_TOKEN: "wrong-oauth",
				ANTHROPIC_API_KEY: "wrong-key",
				ANTHROPIC_AUTH_TOKEN: "wrong-token",
				ANTHROPIC_BASE_URL: "https://wrong.invalid",
				CLAUDE_CODE_USE_BEDROCK: "1",
			},
			"/profiles/personal",
		);
		assert.equal(env.CLAUDE_CONFIG_DIR, "/profiles/personal");
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
		assert.equal(env.ANTHROPIC_BASE_URL, undefined);
		assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
	});

	it("rejects a blank folder", () => {
		assert.throws(() => buildClaudeChildEnv({}, " "), /folder must not be blank/);
	});
});

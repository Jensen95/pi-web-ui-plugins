import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: registerClaudeProvider } = await import("../src/index.js");

describe("profile provider registration", () => {
	it("registers one model-picker provider for every configured profile", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const providers = [];
		const handlers = new Map();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "claude-bridge.json"),
			JSON.stringify({
				profiles: {
					personal: { claudeDir: "/profiles/personal" },
					work: { claudeDir: "/profiles/work" },
				},
			}),
		);
		try {
			registerClaudeProvider({
				on: (event, handler) => handlers.set(event, handler),
				registerProvider: (id) => providers.push(id),
			});
			assert.deepEqual(providers, ["claude-bridge-personal", "claude-bridge-work"]);
		} finally {
			handlers.get("session_shutdown")?.();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

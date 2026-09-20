import assert from "node:assert/strict";
import { describe, it } from "node:test";
import register from "../src/index.ts";

describe("UsageAwareAgent RPC", () => {
	it("forwards the selected exact model to pi-subagents", async () => {
		let tool;
		const listeners = new Map();
		let sent;
		register({
			registerTool: (value) => {
				tool = value;
			},
			events: {
				on: (name, fn) => {
					listeners.set(name, fn);
					return () => listeners.delete(name);
				},
				emit: (name, value) => {
					if (name === "subagents:rpc:spawn") {
						sent = value;
						listeners.get(`subagents:rpc:spawn:reply:${value.requestId}`)({ success: true, data: { id: "agent-1" } });
					}
				},
			},
		});
		const result = await tool.execute("call", {
			subagent_type: "Explore",
			prompt: "inspect",
			model: "openai-codex/gpt-5.6-sol",
		});
		assert.equal(sent.options.model, "openai-codex/gpt-5.6-sol");
		assert.equal(result.details.id, "agent-1");
	});
});

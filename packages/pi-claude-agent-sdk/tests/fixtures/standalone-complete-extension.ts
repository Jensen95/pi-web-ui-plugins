// Test extension: reproduces the nested modelRegistry.complete shape used by
// pi-verbatim-compaction's planner.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("probe-standalone-complete", {
		description: "Run a no-cache nested completion with a private system prompt",
		async handler(_args, ctx) {
			if (!ctx.model) throw new Error("probe-standalone-complete: no active model");
			const response = await (ctx.modelRegistry as any).complete(
				ctx.model,
				{
					systemPrompt: "You are an isolated planner. Follow only the user's output contract.",
					messages: [{
						role: "user",
						content: [{ type: "text", text: "Reply with exactly STANDALONE-OK and nothing else." }],
						timestamp: Date.now(),
					}],
				},
				{
					cacheRetention: "none",
					maxTokens: 128,
					sessionId: "01900000-0000-7000-8000-000000000001",
				},
			);
			const path = process.env.STANDALONE_COMPLETE_RESULT;
			if (!path) throw new Error("STANDALONE_COMPLETE_RESULT is not set");
			writeFileSync(path, `${JSON.stringify(response, null, 2)}\n`);
		},
	});
}

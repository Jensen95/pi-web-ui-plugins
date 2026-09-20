import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseOpenAIUsage, select, type Usage } from "./router.js";

const params = Type.Object({
	subagent_type: Type.String(),
	prompt: Type.String(),
	tier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("strong")])),
	model: Type.Optional(Type.String({ description: "Exact provider/model; bypasses usage routing." })),
	description: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
});
type Reply = { success: boolean; data?: { id: string }; error?: string };

function openAIAuth(): { token: string; account: string } | undefined {
	try {
		const credential = readStoredCredential("openai-codex") as { access?: string; expires?: number } | undefined;
		const token =
			credential?.expires && credential.expires < Date.now() + 300_000
				? execFileSync("pi", ["auth", "print-bearer-token", "--provider", "openai-codex"], {
						encoding: "utf8",
						timeout: 5_000,
					}).trim()
				: credential?.access;
		const payload = JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString());
		const account = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof token === "string" && typeof account === "string" ? { token, account } : undefined;
	} catch {
		return undefined;
	}
}
async function refreshOpenAI(usage: Map<string, Usage>, signal: AbortSignal): Promise<void> {
	const auth = openAIAuth();
	if (!auth) return;
	try {
		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers: {
				Authorization: `Bearer ${auth.token}`,
				"chatgpt-account-id": auth.account,
				originator: "pi",
				"User-Agent": "pi",
			},
			signal,
		});
		if (!response.ok) return;
		const observations = parseOpenAIUsage(await response.json());
		if (!observations) return;
		const highest = observations.reduce((a, b) => ((b.utilization ?? 0) > (a.utilization ?? 0) ? b : a));
		usage.set("openai-codex", highest);
	} catch {
		/* Unknown retains an unexpired observation. */
	}
}

export default function (pi: ExtensionAPI) {
	const usage = new Map<string, Usage>();
	let lastOpenAI = 0;
	pi.events.on("claude-bridge:usage", (event: unknown) => {
		const value = event as Usage;
		usage.set(value.providerId, value);
	});
	pi.registerTool<typeof params>({
		name: "UsageAwareAgent",
		label: "Usage-aware agent",
		description:
			"Delegate when no exact model is requested. Chooses a subscription model with available usage; ordinary Agent remains available for normal delegation.",
		parameters: params,
		async execute(_id, input, signal) {
			const config = loadConfig(process.cwd());
			if (Date.now() - lastOpenAI >= config.openaiRefreshMs) {
				lastOpenAI = Date.now();
				await refreshOpenAI(usage, signal ?? new AbortController().signal);
			}
			const selected =
				input.model ??
				(() => {
					const candidate = select(input.tier ?? "balanced", config, usage);
					return candidate && `${candidate.provider}/${candidate.model}`;
				})();
			if (!selected)
				return {
					content: [{ type: "text" as const, text: "No configured candidate has available usage." }],
					details: {},
				};
			const requestId = crypto.randomUUID();
			const reply = await new Promise<Reply>((resolve, reject) => {
				const timer = setTimeout(() => {
					unsubscribe();
					reject(new Error("pi-subagents RPC spawn timed out"));
				}, 10_000);
				const unsubscribe = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (value: unknown) => {
					clearTimeout(timer);
					unsubscribe();
					resolve(value as Reply);
				});
				pi.events.emit("subagents:rpc:spawn", {
					requestId,
					type: input.subagent_type,
					prompt: input.prompt,
					options: { model: selected, description: input.description ?? input.name, isBackground: true },
				});
			});
			if (!reply.success || !reply.data?.id) throw new Error(reply.error ?? "pi-subagents failed to spawn agent");
			return {
				content: [{ type: "text" as const, text: `Spawned ${reply.data.id} with ${selected}.` }],
				details: { id: reply.data.id, model: selected },
			};
		},
	});
}

export { refreshOpenAI };

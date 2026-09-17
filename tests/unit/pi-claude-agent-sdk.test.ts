import { afterEach, describe, expect, it, vi } from "vitest";
import {
	accountNames,
	resolveAccount,
	selectAccount,
	type AccountsConfig,
} from "../../packages/pi-claude-agent-sdk/src/accounts.ts";
import { resolveClaudeChildEnv } from "../../packages/pi-claude-agent-sdk/src/child-env.ts";
import {
	fetchCodexUsage,
	parseAnthropicUsage,
	parseCodexUsage,
	type UsageSnapshot,
} from "../../packages/pi-claude-agent-sdk/src/usage.ts";

const anthropicUsage = {
	five_hour: { utilization: 37.5, resets_at: "2026-10-01T12:00:00Z" },
	seven_day: { utilization: 62, resets_at: "2026-10-06T09:00:00Z" },
};

const codexUsage = {
	account_id: "work-account",
	rate_limit: {
		primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_790_000_000 },
		secondary_window: { used_percent: 63, limit_window_seconds: 604_800, reset_at: 1_790_500_000 },
	},
};

describe("named account profiles", () => {
	const config: AccountsConfig = {
		activeAccount: "work",
		accounts: {
			personal: { anthropic: { authProvider: "anthropic" } },
			work: { anthropic: { authProvider: "anthropic-work" } },
			ci: { codex: { accessTokenEnv: "CI_CODEX_TOKEN" } },
		},
	};

	it("supports any number of named accounts and preserves stable ordering", () => {
		expect(accountNames(config)).toEqual(["ci", "personal", "work"]);
	});

	it("resolves the configured active account and an explicit account", () => {
		expect(resolveAccount(config)).toMatchObject({ name: "work", config: config.accounts!.work });
		expect(resolveAccount(config, "ci")).toMatchObject({ name: "ci", config: config.accounts!.ci });
	});

	it("uses a usable default when no account config exists", () => {
		expect(resolveAccount({})).toEqual({ name: "default", config: {} });
	});

	it("routes a named account through its configured environment credential", async () => {
		const registry = { getProviderAuth: vi.fn() };
		const env = await resolveClaudeChildEnv(
			registry,
			{
				WORK_ANTHROPIC_TOKEN: "work-secret",
				ANTHROPIC_API_KEY: "inherited-secret",
			},
			{ anthropic: { tokenEnv: "WORK_ANTHROPIC_TOKEN" } },
		);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("work-secret");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(registry.getProviderAuth).not.toHaveBeenCalled();
	});

	it("does not borrow the default Anthropic credential for a Codex-only account", async () => {
		const registry = { getProviderAuth: vi.fn().mockResolvedValue({ auth: { apiKey: "default-secret" } }) };
		await expect(resolveClaudeChildEnv(registry, {}, { codex: {} })).rejects.toThrow(/no anthropic credential/i);
		expect(registry.getProviderAuth).not.toHaveBeenCalled();
	});

	it("rejects an unknown or blank account instead of silently using another credential", () => {
		expect(() => resolveAccount(config, "missing")).toThrow(/unknown account.*missing/i);
		expect(() => resolveAccount(config, " ")).toThrow(/account name/i);
	});

	it("changes only the active account while retaining every profile", () => {
		expect(selectAccount(config, "ci")).toEqual({ ...config, activeAccount: "ci" });
		expect(selectAccount(config, "ci").accounts).toEqual(config.accounts);
	});
});

describe("usage normalization", () => {
	it("normalizes Anthropic five-hour and seven-day windows", () => {
		expect(parseAnthropicUsage(anthropicUsage, "work")).toEqual<UsageSnapshot>({
			provider: "anthropic",
			account: "work",
			windows: {
				fiveHour: { usedPercent: 37.5, resetsAt: "2026-10-01T12:00:00Z" },
				sevenDay: { usedPercent: 62, resetsAt: "2026-10-06T09:00:00Z" },
			},
		});
	});

	it("normalizes the Codex primary and secondary windows by duration", () => {
		expect(parseCodexUsage(codexUsage, "work")).toEqual<UsageSnapshot>({
			provider: "codex",
			account: "work",
			windows: {
				fiveHour: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_790_000_000 },
				sevenDay: { usedPercent: 63, windowMinutes: 10_080, resetsAt: 1_790_500_000 },
			},
		});
	});

	it("does not invent a window when a provider omits it", () => {
		const result = parseAnthropicUsage({ five_hour: null, seven_day: { utilization: 0 } }, "personal");
		expect(result.windows).toEqual({ sevenDay: { usedPercent: 0 } });
	});

	it("rejects malformed or out-of-range provider data", () => {
		expect(() => parseAnthropicUsage({ five_hour: { utilization: 101 } }, "personal")).toThrow(/utilization/i);
		expect(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: -1 } } }, "personal")).toThrow(
			/used_percent/i,
		);
	});
});

describe("usage requests", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("fetches Codex usage with both bearer and account headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(codexUsage), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchCodexUsage({
				account: "work",
				token: "codex-secret",
				accountId: "work-account",
				endpoint: "https://chat.test/",
			}),
		).resolves.toMatchObject({ provider: "codex", account: "work" });
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chat.test/api/codex/usage");
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer codex-secret");
		expect(headers.get("chatgpt-account-id")).toBe("work-account");
	});

	it("uses Codex's ChatGPT WHAM usage endpoint by default", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(codexUsage), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		await fetchCodexUsage({ account: "work", token: "codex-secret" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/wham/usage");
	});

	it("turns an HTTP failure into a useful error without exposing the credential", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("secret-token", { status: 401, statusText: "Unauthorized" })),
		);
		await expect(
			fetchCodexUsage({ account: "personal", token: "secret-token", endpoint: "https://usage.test/oauth" }),
		).rejects.toThrow(/401|unauthorized/i);
		await expect(
			fetchCodexUsage({ account: "personal", token: "secret-token", endpoint: "https://usage.test/oauth" }),
		).rejects.not.toThrow("secret-token");
	});
});

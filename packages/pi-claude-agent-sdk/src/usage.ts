export interface UsageWindow {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: string | number;
}

export interface UsageSnapshot {
	provider: "anthropic" | "codex";
	account: string;
	windows: {
		fiveHour?: UsageWindow;
		sevenDay?: UsageWindow;
	};
}

export interface CodexUsageRequest {
	account: string;
	token: string;
	accountId?: string;
	endpoint?: string;
	signal?: AbortSignal;
}

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredAccount(account: string): string {
	if (!account.trim()) throw new Error("account name must not be blank");
	return account;
}

function requiredToken(token: string): string {
	if (!token.trim()) throw new Error("usage credential must not be blank");
	return token;
}

function percent(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		throw new Error(`${field} must be a number between 0 and 100`);
	}
	return value;
}

function reset(value: unknown, field: string): string | number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" && typeof value !== "number") throw new Error(`${field} must be a string or number`);
	return value;
}

function anthropicWindow(value: unknown, name: string): UsageWindow | undefined {
	if (value === null || value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${name} usage window must be an object`);
	if (value.utilization === null || value.utilization === undefined) return undefined;
	const window: UsageWindow = { usedPercent: percent(value.utilization, `${name}.utilization`) };
	const resetsAt = reset(value.resets_at, `${name}.resets_at`);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	return window;
}

/** Normalize the Claude Agent SDK's structured `rate_limits` response. */
export function parseAnthropicUsage(payload: unknown, account: string): UsageSnapshot {
	requiredAccount(account);
	if (!isRecord(payload)) throw new Error("Anthropic usage response must be an object");
	const windows: UsageSnapshot["windows"] = {};
	const fiveHour = anthropicWindow(payload.five_hour, "five_hour");
	const sevenDay = anthropicWindow(payload.seven_day, "seven_day");
	if (fiveHour) windows.fiveHour = fiveHour;
	if (sevenDay) windows.sevenDay = sevenDay;
	if (!fiveHour && !sevenDay) throw new Error("Anthropic usage response contains no supported windows");
	return { provider: "anthropic", account, windows };
}

interface CodexWindowData {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: string | number;
}

function codexWindow(value: unknown, name: string): CodexWindowData | undefined {
	if (value === null || value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${name} usage window must be an object`);
	if (value.used_percent === null || value.used_percent === undefined) return undefined;
	const window: CodexWindowData = { usedPercent: percent(value.used_percent, `${name}.used_percent`) };
	if (value.limit_window_seconds !== undefined && value.limit_window_seconds !== null) {
		if (
			typeof value.limit_window_seconds !== "number" ||
			!Number.isFinite(value.limit_window_seconds) ||
			value.limit_window_seconds < 0
		) {
			throw new Error(`${name}.limit_window_seconds must be a non-negative number`);
		}
		window.windowMinutes = value.limit_window_seconds / 60;
	}
	const resetsAt = reset(value.reset_at, `${name}.reset_at`);
	if (resetsAt !== undefined) window.resetsAt = resetsAt;
	return window;
}

function isFiveHour(window: CodexWindowData, primary: boolean): boolean {
	return window.windowMinutes === 300 || (window.windowMinutes === undefined && primary);
}

function isSevenDay(window: CodexWindowData, primary: boolean): boolean {
	return window.windowMinutes === 10_080 || (window.windowMinutes === undefined && !primary);
}

export function parseCodexUsage(payload: unknown, account: string): UsageSnapshot {
	requiredAccount(account);
	if (!isRecord(payload)) throw new Error("Codex usage response must be an object");
	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : payload.rate_limits;
	if (!isRecord(rateLimit)) throw new Error("Codex usage response contains no rate limit data");

	const windows: UsageSnapshot["windows"] = {};
	const primary = codexWindow(rateLimit.primary_window, "primary_window");
	const secondary = codexWindow(rateLimit.secondary_window, "secondary_window");
	if (primary && isFiveHour(primary, true)) windows.fiveHour = primary;
	if (secondary && isSevenDay(secondary, false)) windows.sevenDay = secondary;
	if (primary && !windows.fiveHour && isSevenDay(primary, true)) windows.sevenDay = primary;
	if (secondary && !windows.sevenDay && isFiveHour(secondary, false)) windows.fiveHour = secondary;
	if (!windows.fiveHour && !windows.sevenDay) throw new Error("Codex usage response contains no supported windows");
	return { provider: "codex", account, windows };
}

async function getJson(endpoint: string, headers: HeadersInit, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(endpoint, { method: "GET", headers, signal });
	if (!response.ok) throw new Error(`usage request failed (${response.status} ${response.statusText || "HTTP error"})`);
	try {
		return await response.json();
	} catch {
		throw new Error("usage response was not valid JSON");
	}
}

export async function fetchCodexUsage(request: CodexUsageRequest): Promise<UsageSnapshot> {
	const account = requiredAccount(request.account);
	const token = requiredToken(request.token);
	const configuredEndpoint = request.endpoint?.replace(/\/$/, "");
	const endpoint =
		!configuredEndpoint || /\/(?:wham|api\/codex)\/usage$/.test(configuredEndpoint)
			? (configuredEndpoint ?? CODEX_USAGE_ENDPOINT)
			: `${configuredEndpoint}${configuredEndpoint.endsWith("/backend-api") ? "/wham/usage" : "/api/codex/usage"}`;
	const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
	if (request.accountId?.trim()) headers["chatgpt-account-id"] = request.accountId;
	const payload = await getJson(endpoint, headers, request.signal);
	return parseCodexUsage(payload, account);
}

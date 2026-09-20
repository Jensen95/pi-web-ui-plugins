import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tier = "fast" | "balanced" | "strong";
export type Status = "allowed" | "allowed_warning" | "rejected";
export interface Usage {
	providerId: string;
	status: Status;
	utilization?: number;
	resetsAt?: number;
}
export interface Candidate {
	provider: string;
	model: string;
	profile?: string;
	order: number;
}
export interface Config {
	claudeProfiles: string[];
	maxUtilization: number;
	openaiRefreshMs: number;
	tiers: Record<Tier, string[]>;
}

export const defaults: Config = {
	claudeProfiles: ["personal", "work"],
	maxUtilization: 0.9,
	openaiRefreshMs: 60_000,
	tiers: {
		fast: ["openai-codex/gpt-5.6-luna", "claude-bridge/claude-haiku-4-5"],
		balanced: ["openai-codex/gpt-5.6-terra", "claude-bridge/claude-sonnet-5"],
		strong: ["openai-codex/gpt-5.6-sol", "claude-bridge/claude-opus-5"],
	},
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("usage-router config must be an object");
	return value as Record<string, unknown>;
}
function read(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return object(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(`invalid JSON: ${path}`);
	}
}
function strings(value: unknown, label: string, models = true): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || (models && !v.includes("/"))))
		throw new Error(`${label} must be ${models ? "model strings" : "strings"}`);
	return value;
}

export function loadConfig(
	cwd: string,
	agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): Config {
	const global = read(join(agentDir, "usage-router.json"));
	const project = read(join(cwd, ".pi", "usage-router.json"));
	const raw: Record<string, unknown> = {
		...global,
		...project,
		tiers: { ...(global.tiers ? object(global.tiers) : {}), ...(project.tiers ? object(project.tiers) : {}) },
	};
	const config: Config = { ...defaults, tiers: { ...defaults.tiers } };
	if (raw.claudeProfiles !== undefined)
		config.claudeProfiles = strings(raw.claudeProfiles, "claudeProfiles", false).map((p) =>
			p.replace(/^claude-bridge-/, ""),
		);
	if (raw.maxUtilization !== undefined) {
		if (typeof raw.maxUtilization !== "number" || raw.maxUtilization < 0 || raw.maxUtilization > 1)
			throw new Error("maxUtilization must be 0..1");
		config.maxUtilization = raw.maxUtilization;
	}
	if (raw.openaiRefreshMs !== undefined) {
		const refresh = raw.openaiRefreshMs;
		if (typeof refresh !== "number" || !Number.isInteger(refresh) || refresh < 1000)
			throw new Error("openaiRefreshMs must be an integer >= 1000");
		config.openaiRefreshMs = refresh;
	}
	if (raw.tiers !== undefined) {
		const tiers = object(raw.tiers);
		for (const tier of ["fast", "balanced", "strong"] as Tier[])
			if (tiers[tier] !== undefined) config.tiers[tier] = strings(tiers[tier], `tiers.${tier}`);
	}
	return config;
}

export function expandCandidates(tier: Tier, config: Config): Candidate[] {
	let order = 0;
	return config.tiers[tier].flatMap((entry) => {
		const [provider, model] = entry.split("/", 2);
		if (provider !== "claude-bridge") return [{ provider, model, order: order++ }];
		return config.claudeProfiles.map((profile) => ({
			provider: profile === "default" ? provider : `${provider}-${profile}`,
			model,
			profile,
			order: order++,
		}));
	});
}

export function classify(
	candidate: Candidate,
	usage: Map<string, Usage>,
	now = Date.now(),
	max = defaults.maxUtilization,
): "healthy" | "unknown" | "warning" | "blocked" {
	const observed = usage.get(candidate.provider);
	if (!observed || (observed.resetsAt && observed.resetsAt * 1000 <= now)) return "unknown";
	if (observed.status === "rejected" || (observed.utilization ?? 0) >= 1) return "blocked";
	if (observed.status === "allowed_warning" || (observed.utilization ?? 0) >= max) return "warning";
	return "healthy";
}
export function select(tier: Tier, config: Config, usage: Map<string, Usage>, now = Date.now()): Candidate | undefined {
	const rank = { healthy: 0, unknown: 1, warning: 2, blocked: 3 };
	return expandCandidates(tier, config)
		.filter((c) => classify(c, usage, now, config.maxUtilization) !== "blocked")
		.sort((a, b) => {
			const ar = rank[classify(a, usage, now, config.maxUtilization)],
				br = rank[classify(b, usage, now, config.maxUtilization)];
			if (ar !== br) return ar - br;
			const au = usage.get(a.provider)?.utilization,
				bu = usage.get(b.provider)?.utilization;
			if (au !== undefined && bu !== undefined && au !== bu) return au - bu;
			if (au !== undefined && bu === undefined) return -1;
			if (au === undefined && bu !== undefined) return 1;
			return a.order - b.order;
		})[0];
}

export function parseOpenAIUsage(value: unknown): Usage[] | undefined {
	const body = value as { primary_window?: any; secondary_window?: any };
	const windows = [body?.primary_window, body?.secondary_window].filter(Boolean);
	if (!windows.length) return undefined;
	const parsed = windows.map((window) => {
		const utilization = window.used_percent ?? window.utilization;
		const resetsAt = window.reset_at ?? window.reset_at_unix;
		if (typeof utilization !== "number" || !Number.isFinite(utilization) || typeof resetsAt !== "number")
			return undefined;
		return {
			providerId: "openai-codex",
			status:
				utilization >= 1
					? ("rejected" as const)
					: utilization >= 0.9
						? ("allowed_warning" as const)
						: ("allowed" as const),
			utilization: utilization > 1 ? utilization / 100 : utilization,
			resetsAt,
		};
	});
	return parsed.every(Boolean) ? (parsed as Usage[]) : undefined;
}

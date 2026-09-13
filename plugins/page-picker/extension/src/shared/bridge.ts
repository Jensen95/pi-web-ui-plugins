/// <reference lib="dom" />

export const BRIDGE_VERSION = 1;

export const BRIDGE_ATTR = "data-pi-bridge";

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

export const MAX_OP_CHARS = 64;

export const MAX_ARGS_CHARS = 256 * 1024;
export const MAX_RESULT_CHARS = 512 * 1024;

export interface BridgePair {
	id: string;

	a: string;
	b: string;
	enabled: boolean;

	createdAt: string;

	note?: string;
}

export function normalizeOrigin(raw: unknown): string | undefined {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return undefined;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (!url.hostname) return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function pairId(x: string, y: string): string {
	return [x, y].sort().join(" | ");
}

export function peerOf(pair: BridgePair, origin: string): string | undefined {
	if (pair.a === origin) return pair.b;
	if (pair.b === origin) return pair.a;
	return undefined;
}

export function normalizePairs(raw: unknown): BridgePair[] {
	const list = Array.isArray(raw) ? raw : [];
	const out: BridgePair[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const src = item as Record<string, unknown>;
		const x = normalizeOrigin(src.a);
		const y = normalizeOrigin(src.b);
		if (!x || !y || x === y) continue;
		const [a, b] = x < y ? [x, y] : [y, x];
		const id = pairId(a, b);
		if (seen.has(id)) continue;
		seen.add(id);
		const note = typeof src.note === "string" ? src.note.trim() : "";
		out.push({
			id,
			a,
			b,

			enabled: src.enabled !== false,
			createdAt: typeof src.createdAt === "string" ? src.createdAt : "",
			...(note ? { note: note.slice(0, 120) } : {}),
		});
	}
	return out.sort((x, y) => x.id.localeCompare(y.id));
}

export function pairsFor(pairs: BridgePair[], origin: unknown, enabledOnly = true): BridgePair[] {
	const self = normalizeOrigin(origin);
	if (!self) return [];
	return pairs.filter((p) => pairOfOrigin(p, self) && (!enabledOnly || p.enabled));
}

function pairOfOrigin(pair: BridgePair, origin: string): boolean {
	return pair.a === origin || pair.b === origin;
}

export function peersOf(pairs: BridgePair[], origin: unknown): string[] {
	const peers = pairsFor(pairs, origin).map((p) => peerOf(p, normalizeOrigin(origin) ?? "") ?? "");
	return [...new Set(peers.filter(Boolean))];
}

export type RouteDecision =
	| { ok: true; pair: BridgePair; peer: string }
	| { ok: false; code: "bad-origin" | "no-pair" | "ambiguous" | "disabled"; message: string };

export function decideRoute(pairs: BridgePair[], fromOrigin: unknown, toOrigin?: unknown): RouteDecision {
	const from = normalizeOrigin(fromOrigin);
	if (!from) {
		return {
			ok: false,
			code: "bad-origin",
			message: `Caller origin is invalid (${String(fromOrigin)}) -- only http/https pages are supported`,
		};
	}
	const rawTo = typeof toOrigin === "string" ? toOrigin.trim() : "";
	const want = rawTo ? normalizeOrigin(rawTo) : undefined;
	if (rawTo && !want) {
		return {
			ok: false,
			code: "bad-origin",
			message: `Peer origin is invalid (${rawTo}) -- only http/https pages are supported`,
		};
	}
	if (want === from) {
		return {
			ok: false,
			code: "bad-origin",
			message: "The peer is the caller itself -- the bridge is for cross-page calls",
		};
	}

	const touching = pairs.filter((p) => pairOfOrigin(p, from));
	const enabled = touching.filter((p) => p.enabled);
	if (enabled.length === 0) {
		if (touching.length > 0) {
			return {
				ok: false,
				code: "disabled",
				message: `${from} has a disabled pair -- enable it in the extension options under "Page bridge"`,
			};
		}
		return {
			ok: false,
			code: "no-pair",
			message: `${from} has no paired pages -- add one in the extension options under "Page bridge"`,
		};
	}

	const peerList = [...new Set(enabled.map((p) => peerOf(p, from)).filter((v): v is string => Boolean(v)))];
	if (want) {
		const pair = enabled.find((p) => peerOf(p, from) === want);
		if (!pair) {
			return {
				ok: false,
				code: "no-pair",
				message: `${from} and ${want} have no pair (current peers: ${peerList.join(", ") || "none"})`,
			};
		}
		return { ok: true, pair, peer: want };
	}
	if (peerList.length > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: `${from} has multiple peers (${peerList.join(", ")}) -- specify the peer with to`,
		};
	}
	return { ok: true, pair: enabled[0], peer: peerList[0] };
}

export interface SizeCheck {
	ok: boolean;
	message?: string;
	chars?: number;
}

export function measureForTransport(value: unknown, what: string, limit: number): SizeCheck {
	if (value === undefined) return { ok: true, chars: 0 };
	if (typeof value === "function" || typeof value === "symbol") {
		return {
			ok: false,
			message: `${what} cannot cross the page boundary (functions and Symbols are not transferable)`,
		};
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (err) {
		return {
			ok: false,
			message: `${what} cannot cross the page boundary: ${err instanceof Error ? err.message : String(err)} (circular references and BigInt are not transferable)`,
		};
	}
	if (text === undefined) return { ok: false, message: `${what} cannot cross the page boundary` };
	const chars = text.length;
	if (chars > limit) {
		return {
			ok: false,
			message: `${what} is too large (${Math.round(chars / 1024)}KB > limit ${Math.round(limit / 1024)}KB) -- send only necessary fields`,
		};
	}
	return { ok: true, chars };
}

export function clampTimeout(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(n)));
}

export interface BridgeCall {
	to?: string;
	op: string;
	args?: unknown;
	timeoutMs: number;
}

export function parseBridgeCall(raw: unknown): { ok: true; call: BridgeCall } | { ok: false; message: string } {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const op = typeof src.op === "string" ? src.op.trim() : "";
	if (!op) return { ok: false, message: "Call is missing an operation name (op)" };
	if (op.length > MAX_OP_CHARS)
		return { ok: false, message: `Operation name is too long (${op.length} > ${MAX_OP_CHARS} )` };

	if (/[\u0000-\u001f\u007f]/.test(op)) return { ok: false, message: "Operation name contains control characters" };
	const size = measureForTransport(src.args, "Arguments", MAX_ARGS_CHARS);
	if (!size.ok) return { ok: false, message: size.message ?? "Invalid arguments" };
	const to = typeof src.to === "string" && src.to.trim() ? src.to.trim() : undefined;
	return {
		ok: true,
		call: {
			...(to ? { to } : {}),
			op,
			...(src.args === undefined ? {} : { args: src.args }),
			timeoutMs: clampTimeout(src.timeoutMs),
		},
	};
}

export function describePair(pair: BridgePair): string {
	const note = pair.note ? `(${pair.note})` : "";
	return `${pair.a} <-> ${pair.b}${note}`;
}

export function upsertPair(
	pairs: BridgePair[],
	x: unknown,
	y: unknown,
	opts: { note?: string; now?: string; enabled?: boolean } = {},
): { pairs: BridgePair[]; pair?: BridgePair; error?: string } {
	const a = normalizeOrigin(x);
	const b = normalizeOrigin(y);
	if (!a || !b) return { pairs, error: "Both endpoints must be http/https URLs, such as https://a.example" };
	if (a === b) return { pairs, error: "The endpoints must be different" };
	const id = pairId(a, b);
	const existing = pairs.find((p) => p.id === id);
	const note = (opts.note ?? existing?.note ?? "").trim();
	const merged: BridgePair = {
		id,
		a: a < b ? a : b,
		b: a < b ? b : a,
		enabled: opts.enabled ?? existing?.enabled ?? true,
		createdAt: existing?.createdAt || opts.now || "",
		...(note ? { note: note.slice(0, 120) } : {}),
	};
	const rest = pairs.filter((p) => p.id !== id);
	return { pairs: [...rest, merged].sort((p, q) => p.id.localeCompare(q.id)), pair: merged };
}

export function removePair(pairs: BridgePair[], id: string): BridgePair[] {
	return pairs.filter((p) => p.id !== id);
}

export interface RecentOrigin {
	origin: string;

	title?: string;

	at: string;
}

export const MAX_RECENT = 12;

export function normalizeRecent(raw: unknown): RecentOrigin[] {
	const list = Array.isArray(raw) ? raw : [];
	const best = new Map<string, RecentOrigin>();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const src = item as Record<string, unknown>;
		const origin = normalizeOrigin(src.origin);
		if (!origin) continue;
		const title = typeof src.title === "string" ? src.title.trim() : "";
		const entry: RecentOrigin = {
			origin,
			title: title ? title.slice(0, 80) : origin,
			at: typeof src.at === "string" ? src.at : "",
		};

		const prev = best.get(origin);
		if (!prev || entry.at > prev.at) best.set(origin, entry);
	}
	return [...best.values()]
		.sort((x, y) => (x.at === y.at ? x.origin.localeCompare(y.origin) : y.at.localeCompare(x.at)))
		.slice(0, MAX_RECENT);
}

export function rememberRecent(
	list: RecentOrigin[],
	origin: unknown,
	opts: { title?: string; now?: string } = {},
): RecentOrigin[] {
	const self = normalizeOrigin(origin);
	if (!self) return list;
	const rest = list.filter((item) => item.origin !== self);
	const title = (opts.title ?? "").trim();
	return normalizeRecent([
		{ origin: self, ...(title ? { title } : {}), at: opts.now ?? new Date().toISOString() },
		...rest,
	]);
}

export type AiPage = RecentOrigin;

export const normalizeAiPages = normalizeRecent;

export const BUILTIN_OPS = [
	"status",
	"openOptions",
	"pages",
	"read",
	"click",
	"type",
	"scroll",
	"goto",
	"wait",
	"eval",
	"shot",
	"metrics",
] as const;

export type BuiltinOp = (typeof BUILTIN_OPS)[number];

export function isBuiltinOp(v: unknown): v is BuiltinOp {
	return typeof v === "string" && (BUILTIN_OPS as readonly string[]).includes(v);
}

export const SHOT_PERMISSION_ORIGINS = ["http://*/*", "https://*/*"] as const;

export const EVAL_OP: BuiltinOp = "eval";

export type AiRouteDecision =
	| { ok: true; page: AiPage; peer: string }
	| { ok: false; code: "bad-origin" | "no-page" | "ambiguous"; message: string };

export function decideAiRoute(aiPages: AiPage[], toOrigin?: unknown): AiRouteDecision {
	const rawTo = typeof toOrigin === "string" ? toOrigin.trim() : "";
	const want = rawTo ? normalizeOrigin(rawTo) : undefined;
	if (rawTo && !want) {
		return {
			ok: false,
			code: "bad-origin",
			message: `Target page origin is invalid (${rawTo}) -- only http/https pages are supported`,
		};
	}
	if (aiPages.length === 0) {
		return {
			ok: false,
			code: "no-page",
			message:
				'No page is authorized for AI control -- authorize one under "AI page control" in the page-picker options',
		};
	}
	if (want) {
		const page = aiPages.find((p) => p.origin === want);
		if (!page) {
			return {
				ok: false,
				code: "no-page",
				message: `${want} is not authorized for AI control (authorized pages: ${aiPages.map((p) => p.origin).join(", ")})`,
			};
		}
		return { ok: true, page, peer: want };
	}
	if (aiPages.length > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: `Multiple pages are authorized (${aiPages.map((p) => p.origin).join(", ")}) -- specify one with target`,
		};
	}
	return { ok: true, page: aiPages[0], peer: aiPages[0].origin };
}

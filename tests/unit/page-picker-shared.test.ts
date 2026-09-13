import { describe, expect, it } from "vitest";
import {
	BUILTIN_OPS,
	MAX_ARGS_CHARS,
	clampTimeout,
	decideAiRoute,
	decideRoute,
	isBuiltinOp,
	normalizeOrigin,
	pairId,
	parseBridgeCall,
	upsertPair,
	type BridgePair,
} from "../../plugins/page-picker/extension/src/shared/bridge.js";
import {
	normalizeSettings,
	DEFAULT_SERVER_URL,
	isValidMatchPattern,
} from "../../plugins/page-picker/extension/src/shared/settings.js";
import { sectionsForDepth, normalizeSections } from "../../plugins/page-picker/extension/src/shared/contract.js";
import { planCrop } from "../../plugins/page-picker/extension/src/shared/shot-crop.js";
import { toPrompt } from "../../plugins/page-picker/extension/src/shared/to-prompt.js";
import type { PickPayload } from "../../plugins/page-picker/extension/src/shared/contract.js";

const A = "https://a.example";
const B = "https://b.example";

function pair(a = A, b = B, enabled = true): BridgePair {
	return { id: pairId(a, b), a, b, enabled, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("page-picker shared contract", () => {
	it("normalizes origins and refuses unsupported schemes", () => {
		expect(normalizeOrigin("https://a.example/app?tab=1")).toBe(A);
		expect(normalizeOrigin("localhost:5173")).toBe("http://localhost:5173");
		for (const value of ["file:///tmp/page.html", "chrome://extensions", "", null, 42]) {
			expect(normalizeOrigin(value)).toBeUndefined();
		}
	});

	it("routes only enabled, explicitly paired pages", () => {
		expect(decideRoute([], A)).toMatchObject({ ok: false, code: "no-pair" });
		expect(decideRoute([pair()], A)).toMatchObject({ ok: true, peer: B });
		expect(decideRoute([pair(A, B, false)], A)).toMatchObject({ ok: false, code: "disabled" });
		expect(decideRoute([pair(A, B), pair(A, "https://c.example")], A)).toMatchObject({ ok: false, code: "ambiguous" });
		expect(decideAiRoute([{ origin: B, title: "Orders", at: "now" }], B)).toMatchObject({ ok: true, peer: B });
		expect(decideAiRoute([], undefined)).toMatchObject({ ok: false, code: "no-page" });
	});

	it("sanitizes calls, timeouts, settings, and match patterns at boundaries", () => {
		expect(parseBridgeCall({ op: " read ", args: { id: 1 }, timeoutMs: 999999 })).toMatchObject({
			ok: true,
			call: { op: "read", timeoutMs: 30000 },
		});
		expect(parseBridgeCall({ op: "x", args: "x".repeat(MAX_ARGS_CHARS + 1) })).toMatchObject({ ok: false });
		expect(clampTimeout(undefined)).toBe(5000);
		expect(clampTimeout(-1)).toBe(1);
		expect(normalizeSettings({ serverUrl: "bad://", allowEval: "yes" })).toMatchObject({
			serverUrl: DEFAULT_SERVER_URL,
			allowEval: false,
		});
		expect(isValidMatchPattern("https://example.com/*")).toBe(true);
		expect(isValidMatchPattern("https://example.com")).toBe(false);
	});

	it("keeps section selections valid and preserves the documented action list", () => {
		expect(sectionsForDepth("compact")).toContain("selector");
		expect(normalizeSections(["selector", "selector", "unknown"])).toEqual(["selector"]);
		expect(BUILTIN_OPS).toContain("read");
		expect(isBuiltinOp("read")).toBe(true);
		expect(isBuiltinOp("delete-all-data")).toBe(false);
	});

	it("plans visible screenshot crops with device-pixel scaling", () => {
		expect(
			planCrop({ x: 10, y: 20, w: 100, h: 50, vwPct: 0, vhPct: 0 }, { dpr: 2, imageW: 800, imageH: 600 }),
		).toMatchObject({
			srcX: 20,
			srcY: 40,
			srcW: 200,
			srcH: 100,
		});
		expect(
			planCrop({ x: -98, y: 10, w: 100, h: 100, vwPct: 0, vhPct: 0 }, { dpr: 1, imageW: 800, imageH: 600 }),
		).toBeNull();
	});

	it("renders only selected element data and omits missing optional fields", () => {
		const payload: PickPayload = {
			id: "pick-1",
			pickedAt: "2026-01-01T00:00:00.000Z",
			page: { url: "https://site.example", title: "Dashboard", viewport: { w: 1200, h: 800, dpr: 1 } },
			detail: "compact",
			sections: ["page", "selector", "text"],
			elements: [
				{
					snapshot: {
						tag: "button",
						classes: [],
						selector: "#save",
						text: "Save",
						rect: { x: 0, y: 0, w: 80, h: 30, vwPct: 0, vhPct: 0 },
					},
				},
			],
		};
		const markdown = toPrompt(payload);
		expect(markdown).toContain("Web element pick");
		expect(markdown).toContain("`#save`");
		expect(markdown).toContain("Save");
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("HTML skeleton");
	});

	it("upserts pairs without duplicates and rejects invalid endpoints", () => {
		const first = upsertPair([], A, B, { now: "t1" });
		const second = upsertPair(first.pairs, B, A, { note: "Orders to tools" });
		expect(second.pairs).toHaveLength(1);
		expect(second.pairs[0]?.createdAt).toBe("t1");
		expect(second.pair?.note).toBe("Orders to tools");
		expect(upsertPair([], "file:///tmp/a", B).error).toMatch(/http/);
	});
});

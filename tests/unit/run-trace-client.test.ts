/**
 * run-trace client view: the pure model behind the timeline.
 *
 * mount() is DOM orchestration and vitest runs with environment "node" (jsdom is
 * not a dependency of this repo), so what is tested here is everything the view
 * computes before it touches the DOM: escaping, duration/clock/tick formatting,
 * the segment chip and colour mapping, the visible-span math, the initial
 * "active window" clustering that decides what the timeline zooms to, and the
 * replay-track coordinate math that drives playback.
 *
 * The default export shape is asserted too, because that is the whole contract
 * the frontend loader has with this bundle.
 */
import { describe, expect, it } from "vitest";
import clientEntry, {
	I18N,
	activeIndexAt,
	activeWindow,
	buildReplayTrack,
	chipFor,
	esc,
	flowTimeAt,
	flowX,
	fmtClock,
	fmtDur,
	fmtTick,
	laneColor,
	realTimeAt,
	spanMs,
	toolColor,
} from "../../plugins/run-trace/src/client";
import type { FlowWindow, ReplayTrack } from "../../plugins/run-trace/src/client";
import type { TraceSeg } from "../../plugins/run-trace/src/trace";

/** A segment with every required field defaulted, so a test states only what matters. */
function seg(over: Partial<TraceSeg> = {}): TraceSeg {
	return {
		key: "k",
		kind: "tool",
		lane: "tools",
		t: 0,
		title: "title",
		summary: "summary",
		source: "source",
		status: "done",
		turn: 0,
		...over,
	};
}

const WINDOW: FlowWindow = { a: 1000, b: 3000, span: 2000 };

describe("client entry contract", () => {
	it("exports the view shape the frontend loader requires", () => {
		expect(typeof clientEntry).toBe("object");
		expect(typeof clientEntry.mount).toBe("function");
		// mount(container, ctx) - the loader calls it with exactly two arguments.
		expect(clientEntry.mount.length).toBe(2);
	});

	it("is a view plugin, not a fenced-code renderer plugin", () => {
		expect(clientEntry.renderers).toBeUndefined();
	});
});

describe("labels", () => {
	it("ships one English bundle and no locale switch", () => {
		const keys = Object.keys(I18N).sort();
		expect(keys).not.toContain("zh");
		expect(keys).not.toContain("en");
		expect(keys).toEqual(
			[
				"clear",
				"confirmClear",
				"copied",
				"copy",
				"current",
				"empty",
				"emptyHint",
				"exitReplay",
				"f",
				"fit",
				"flowHint",
				"follow",
				"lanes",
				"live",
				"loading",
				"noMatch",
				"pause",
				"play",
				"replay",
				"search",
				"selectHint",
				"skipIdle",
				"speed",
				"status",
				"tabs",
				"title",
				"zoomHint",
			].sort(),
		);
	});

	it("labels the view, lanes, tabs and statuses in English", () => {
		expect(I18N.title).toBe("Run Trace");
		expect(I18N.lanes).toEqual({ input: "Input", model: "Model", tools: "Tools" });
		expect(I18N.tabs).toEqual({ overview: "Overview", preview: "Preview", raw: "Raw", source: "Source" });
		expect(I18N.status).toEqual({ done: "Done", running: "Running", error: "Failed" });
		expect(I18N.f.total).toBe("Total");
		expect(I18N.f.errRate).toBe("Error rate");
	});
});

describe("esc", () => {
	it("escapes every HTML-significant character", () => {
		expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
	});

	it("leaves plain text and numbers alone", () => {
		expect(esc("plain text")).toBe("plain text");
		expect(esc(0)).toBe("0");
		expect(esc(123)).toBe("123");
	});

	it("renders nullish input as an empty string", () => {
		expect(esc(undefined)).toBe("");
		expect(esc(null)).toBe("");
	});
});

describe("fmtDur", () => {
	it("uses an em dash for a missing duration", () => {
		expect(fmtDur(undefined)).toBe("—");
		expect(fmtDur(null)).toBe("—");
	});

	it("formats sub-second durations in milliseconds", () => {
		expect(fmtDur(0)).toBe("0ms");
		expect(fmtDur(1)).toBe("1ms");
		expect(fmtDur(999)).toBe("999ms");
	});

	it("formats sub-minute durations in seconds with one decimal", () => {
		expect(fmtDur(1000)).toBe("1.0s");
		expect(fmtDur(1500)).toBe("1.5s");
		expect(fmtDur(59_999)).toBe("60.0s");
	});

	it("formats a minute or more as minutes plus rounded seconds", () => {
		expect(fmtDur(60_000)).toBe("1m0s");
		expect(fmtDur(75_400)).toBe("1m15s");
		expect(fmtDur(720_000)).toBe("12m0s");
	});

	it("clamps a negative duration to zero seconds but keeps the raw milliseconds", () => {
		expect(fmtDur(-5)).toBe("-5ms");
	});
});

describe("fmtClock", () => {
	it("renders a timestamp as a locale time", () => {
		expect(fmtClock(0).length).toBeGreaterThan(0);
		expect(fmtClock(Date.UTC(2024, 0, 1, 12, 0, 0))).toMatch(/\d/);
	});

	it("does not throw on an unusable timestamp", () => {
		expect(fmtClock(Number.NaN)).toBe("Invalid Date");
	});
});

describe("fmtTick", () => {
	it("renders hours and minutes, and adds seconds when asked", () => {
		const at = Date.UTC(2024, 0, 1, 12, 34, 56);
		expect(fmtTick(at, false)).toMatch(/^\d{2}:\d{2}$/);
		expect(fmtTick(at, true)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	it("zero-pads single-digit components", () => {
		const parts = fmtTick(0, true).split(":");
		expect(parts).toHaveLength(3);
		for (const part of parts) expect(part).toHaveLength(2);
	});
});

describe("chipFor", () => {
	it("labels every non-tool kind", () => {
		expect(chipFor(seg({ kind: "user" }))).toBe("user");
		expect(chipFor(seg({ kind: "thinking" }))).toBe("think");
		expect(chipFor(seg({ kind: "text" }))).toBe("text");
		expect(chipFor(seg({ kind: "file" }))).toBe("file");
		expect(chipFor(seg({ kind: "system" }))).toBe("sys");
		expect(chipFor(seg({ kind: "result" }))).toBe("done");
	});

	it("labels a tool segment with its tool name, cut to ten characters", () => {
		expect(chipFor(seg({ kind: "tool", meta: { tool: "edit" } }))).toBe("edit");
		expect(chipFor(seg({ kind: "tool", meta: { tool: "a-very-long-tool-name" } }))).toBe("a-very-lon");
		expect(chipFor(seg({ kind: "tool" }))).toBe("tool");
	});
});

describe("toolColor", () => {
	it("pins the fixed colours for read, write and bash tools", () => {
		expect(toolColor("read")).toBe("#2dd4bf");
		expect(toolColor("grep")).toBe("#2dd4bf");
		expect(toolColor("edit")).toBe("#f59e0b");
		expect(toolColor("write")).toBe("#f59e0b");
		expect(toolColor("bash")).toBe("#a78bfa");
	});

	it("hashes any other name into the palette, deterministically", () => {
		const colour = toolColor("deploy");
		expect(colour).toMatch(/^#[0-9a-f]{6}$/);
		expect(toolColor("deploy")).toBe(colour);
		expect(toolColor("rollback")).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("treats a missing name as 'tool'", () => {
		expect(toolColor(undefined)).toBe(toolColor("tool"));
		expect(toolColor(null)).toBe(toolColor("tool"));
	});
});

describe("laneColor", () => {
	it("marks a failed segment red whatever its lane", () => {
		expect(laneColor(seg({ status: "error", lane: "tools", meta: { tool: "read" } }))).toBe("#f87171");
		expect(laneColor(seg({ status: "error", lane: "model", kind: "thinking" }))).toBe("#f87171");
	});

	it("colours tool segments by tool name", () => {
		expect(laneColor(seg({ lane: "tools", meta: { tool: "bash" } }))).toBe("#a78bfa");
		expect(laneColor(seg({ lane: "tools", kind: "file" }))).toBe(toolColor("file"));
		expect(laneColor(seg({ lane: "tools", kind: "system" }))).toBe(toolColor("tool"));
	});

	it("separates thinking from answering inside the model lane", () => {
		expect(laneColor(seg({ lane: "model", kind: "thinking" }))).toBe("#38bdf8");
		expect(laneColor(seg({ lane: "model", kind: "text" }))).toBe("#3b82f6");
		expect(laneColor(seg({ lane: "model", kind: "system" }))).toBeNull();
	});

	it("leaves the input lane to the stylesheet", () => {
		expect(laneColor(seg({ lane: "input", kind: "user" }))).toBeNull();
	});

	it("keeps a running tool in its tool colour", () => {
		expect(laneColor(seg({ status: "running", lane: "tools", meta: { tool: "read" } }))).toBe("#2dd4bf");
	});
});

describe("spanMs", () => {
	it("returns 1 for no segments, so callers never divide by zero", () => {
		expect(spanMs([])).toBe(1);
	});

	it("returns 1 for a single instant segment", () => {
		expect(spanMs([seg({ t: 100 })])).toBe(1);
	});

	it("spans from the earliest start to the latest end", () => {
		expect(spanMs([seg({ t: 0, end: 5000 }), seg({ t: 1000 })])).toBe(5000);
		expect(spanMs([seg({ t: 1000 }), seg({ t: 0, end: 5000 })])).toBe(5000);
	});

	it("ignores an end earlier than its own start", () => {
		expect(spanMs([seg({ t: 5000, end: 0 })])).toBe(1);
		expect(spanMs([seg({ t: 5000, end: 0 }), seg({ t: 0, end: 2000 })])).toBe(5000);
	});
});

describe("activeWindow", () => {
	it("has nothing to focus on for an empty timeline", () => {
		expect(activeWindow([])).toBeNull();
	});

	it("returns null when the whole run is one continuous cluster", () => {
		const all = [seg({ t: 0, end: 1000 }), seg({ t: 1200, end: 2000 }), seg({ t: 2100, end: 3000 })];
		expect(activeWindow(all)).toBeNull();
	});

	it("merges segments whose gap is inside the idle threshold", () => {
		// span 3000 -> idle = min(max(90000, 150), 1200) = 1200, and the 1000ms gap fits.
		const all = [seg({ t: 0, end: 1000 }), seg({ t: 2000, end: 3000 })];
		expect(activeWindow(all)).toBeNull();
	});

	it("returns null when activity is too scattered to focus on one cluster", () => {
		const all = [seg({ t: 0, end: 10 }), seg({ t: 1_000_000, end: 1_000_010 })];
		expect(activeWindow(all)).toBeNull();
	});

	it("focuses the dominant cluster when it owns at least 40% of the span", () => {
		const all = [seg({ t: 0, end: 500_000 }), seg({ t: 1_000_000, end: 1_010_000 })];
		expect(activeWindow(all)).toEqual({ start: 0, end: 500_000 });
	});

	it("trims idle time on both sides of a single burst of work", () => {
		const all = [
			seg({ t: 0, end: 100 }),
			seg({ t: 400_000, end: 900_000 }),
			seg({ t: 900_500, end: 950_000 }),
			seg({ t: 1_200_000, end: 1_200_100 }),
		];
		expect(activeWindow(all)).toEqual({ start: 400_000, end: 950_000 });
	});

	it("treats a segment without an end as a point in time", () => {
		const all = [seg({ t: 0 }), seg({ t: 500_000, end: 900_000 })];
		expect(activeWindow(all)).toEqual({ start: 500_000, end: 900_000 });
	});

	it("does not depend on the segments arriving in chronological order", () => {
		const all = [seg({ t: 1_000_000, end: 1_010_000 }), seg({ t: 0, end: 500_000 })];
		expect(activeWindow(all)).toEqual({ start: 0, end: 500_000 });
	});
});

describe("buildReplayTrack", () => {
	const first = seg({ key: "a", t: 0, end: 1000 });
	const second = seg({ key: "b", t: 5000, end: 6000 });

	it("is empty for an empty timeline", () => {
		const track = buildReplayTrack([], true);
		expect(track.segs).toEqual([]);
		expect(track.totalLen).toBe(0);
		expect(track.realStart).toBe(0);
		expect(track.skipIdle).toBe(true);
	});

	it("keeps real offsets and the real total when idle time is played", () => {
		const track = buildReplayTrack([second, first], false);
		expect(track.realStart).toBe(0);
		expect(track.totalLen).toBe(6000);
		expect(track.skipIdle).toBe(false);
		expect(track.segs.map((item) => [item.seg.key, item.p0, item.p1])).toEqual([
			["a", 0, 1000],
			["b", 5000, 6000],
		]);
	});

	it("packs segments back to back when idle time is skipped", () => {
		const track = buildReplayTrack([second, first], true);
		expect(track.totalLen).toBe(2000);
		expect(track.skipIdle).toBe(true);
		expect(track.segs.map((item) => [item.seg.key, item.p0, item.p1])).toEqual([
			["a", 0, 1000],
			["b", 1000, 2000],
		]);
	});

	it("keeps a one-millisecond floor for instant segments", () => {
		const track = buildReplayTrack([seg({ key: "a", t: 100 }), seg({ key: "b", t: 200 })], true);
		expect(track.realStart).toBe(100);
		expect(track.totalLen).toBe(1);
		expect(track.segs.map((item) => [item.p0, item.p1])).toEqual([
			[0, 0],
			[0, 0],
		]);
	});
});

describe("activeIndexAt", () => {
	const track: ReplayTrack = buildReplayTrack(
		[seg({ key: "a", t: 0, end: 1000 }), seg({ key: "b", t: 5000, end: 6000 })],
		true,
	);

	it("is -1 before anything started and on an empty track", () => {
		expect(activeIndexAt(track, -1)).toBe(-1);
		expect(activeIndexAt(buildReplayTrack([], true), 0)).toBe(-1);
	});

	it("stays on the last segment that started, including across idle time", () => {
		expect(activeIndexAt(track, 0)).toBe(0);
		expect(activeIndexAt(track, 999)).toBe(0);
		expect(activeIndexAt(track, 1000)).toBe(1);
		expect(activeIndexAt(track, 10_000)).toBe(1);
	});
});

describe("realTimeAt", () => {
	it("advances from the real start when nothing is active", () => {
		const track = buildReplayTrack([seg({ key: "a", t: 1000, end: 2000 })], true);
		expect(realTimeAt(track, 250, -1)).toBe(1250);
	});

	it("advances continuously through idle time when idle is played", () => {
		const track = buildReplayTrack([seg({ key: "a", t: 0, end: 1000 }), seg({ key: "b", t: 5000, end: 6000 })], false);
		expect(realTimeAt(track, 3000, 0)).toBe(3000);
		expect(realTimeAt(track, 5500, 1)).toBe(5500);
	});

	it("scans inside the active segment when idle is skipped", () => {
		const track = buildReplayTrack([seg({ key: "a", t: 0, end: 1000 }), seg({ key: "b", t: 5000, end: 6000 })], true);
		expect(realTimeAt(track, 1500, 1)).toBe(5500);
		expect(realTimeAt(track, 1000, 1)).toBe(5000);
	});

	it("never rewinds before the active segment's own start", () => {
		const track = buildReplayTrack([seg({ key: "a", t: 0, end: 1000 }), seg({ key: "b", t: 5000, end: 6000 })], true);
		expect(realTimeAt(track, 0, 1)).toBe(5000);
	});
});

describe("flowX and flowTimeAt", () => {
	it("map the window edges onto the drawing area edges", () => {
		expect(flowX(1000, WINDOW, 200)).toBe(0);
		expect(flowX(2000, WINDOW, 200)).toBe(100);
		expect(flowX(3000, WINDOW, 200)).toBe(200);
	});

	it("invert each other", () => {
		expect(flowTimeAt(0, WINDOW, 200)).toBe(1000);
		expect(flowTimeAt(100, WINDOW, 200)).toBe(2000);
		expect(flowTimeAt(200, WINDOW, 200)).toBe(3000);
		expect(flowTimeAt(flowX(2500, WINDOW, 200), WINDOW, 200)).toBe(2500);
	});
});

/**
 * run-trace client view v2 - harness-style trace analysis.
 *
 * A horizontal swimlane timeline across the top (input / model / tools) gives the
 * whole picture, the left column locates a segment, and the right column analyses
 * it (overview / preview / raw / source) instead of just showing the conversation
 * again.
 *
 * Contract: the ESM default export is { mount(container, ctx) -> cleanup? }, plain
 * DOM with no framework. The timeline engine is loaded in three tiers - the vendored
 * vis-timeline bundle first, an esm.sh CDN fallback, then a hand-written div
 * timeline - so the view never renders blank.
 *
 * This repo is English-only, so the two-locale label table and the language toggle
 * upstream shipped are gone; one English bundle remains and t() still hands it out,
 * which keeps every call site reading the same as it did upstream.
 */
import type { TraceConvSummary, TracePayload, TraceSeg, TraceSegAnalysis } from "./trace";

/** What the frontend gives a mounted view: a narrow two-way channel. */
interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

/** Every label the view renders. English only - see the file header. */
export const I18N = {
	title: "Run Trace",
	live: "live",
	current: "active",
	search: "Search segments…",
	fit: "⤢ Fit",
	follow: "◎ Follow",
	zoomHint: "wheel zoom · drag pan · click a block for analysis",
	flowHint: "live flow · fixed ruler · drag pauses follow",
	replay: "Replay",
	exitReplay: "Exit replay",
	play: "Play",
	pause: "Pause",
	speed: "Speed",
	skipIdle: "skip idle",
	clear: "Clear",
	confirmClear: "Clear all traces? (re-pull restores the open conversation)",
	empty: "No conversation",
	emptyHint: "Open a conversation and its timeline + analysis show up here.",
	selectHint: "Click a ruler block or a left segment for analysis.",
	loading: "Loading…",
	noMatch: "No matching segments (check search/filters).",
	copy: "Copy",
	copied: "Copied",
	lanes: { input: "Input", model: "Model", tools: "Tools" },
	tabs: { overview: "Overview", preview: "Preview", raw: "Raw", source: "Source" },
	status: { done: "Done", running: "Running", error: "Failed" },
	f: {
		source: "Source",
		status: "Status",
		dur: "Duration",
		turn: "Turn",
		len: "Length",
		pos: "Position",
		total: "Total",
		turns: "Turns",
		segs: "Segments",
		toolCalls: "Tool calls",
		toolErr: "Tool errors",
		toolTime: "Tool time",
		slowest: "Slowest tools",
		files: "Files changed",
		phase: "Phases",
		calls: "Calls",
		avg: "Avg",
		errRate: "Error rate",
		share: "Time share",
		msgKey: "Message",
		toolCall: "Call",
		conv: "Conversation",
		time: "Time",
	},
};

/** The three swimlanes, in drawing order. */
const LANES = ["input", "model", "tools"] as const;

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for interpolation into innerHTML. */
export function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Replace an element's contents using the browser's HTML parser. Interpolated values are escaped by esc(). */
function setMarkup(element: Element, markup: string): void {
	const range = document.createRange();
	range.selectNode(element);
	element.replaceChildren(range.createContextualFragment(markup));
}

/** A timestamp as the browser's locale time; empty when it cannot be formatted. */
export function fmtClock(t: number): string {
	try {
		return new Date(t).toLocaleTimeString();
	} catch {
		return "";
	}
}

/** A duration in the shortest unit that still reads: ms, s, or m+s. */
export function fmtDur(ms: number | null | undefined): string {
	if (ms === undefined || ms === null) return "—";
	const s = Math.max(0, ms) / 1000;
	if (s < 1) return `${Math.round(ms)}ms`;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/** The short chip label of a segment in the left list. */
export function chipFor(seg: TraceSeg): string {
	if (seg.kind === "user") return "user";
	if (seg.kind === "thinking") return "think";
	if (seg.kind === "text") return "text";
	if (seg.kind === "file") return "file";
	if (seg.kind === "system") return "sys";
	if (seg.kind === "result") return "done";
	if (seg.kind === "tool") return (seg.meta?.tool ?? "tool").slice(0, 10);
	return seg.kind;
}

/* Tool colours: fixed colours for the common tools (read = teal, write = amber,
 * bash = purple), everything else hashed into the palette by name, so a given
 * tool always gets the same colour. */
const TOOL_PALETTE = [
	"#3b82f6",
	"#22c55e",
	"#ec4899",
	"#06b6d4",
	"#f97316",
	"#84cc16",
	"#818cf8",
	"#fb7185",
	"#eab308",
	"#14b8a6",
];
const TOOL_FIXED: Record<string, string> = {
	read: "#2dd4bf",
	get: "#2dd4bf",
	list: "#2dd4bf",
	glob: "#2dd4bf",
	grep: "#2dd4bf",
	search: "#2dd4bf",
	fetch: "#2dd4bf",
	cat: "#2dd4bf",
	show: "#2dd4bf",
	query: "#2dd4bf",
	edit: "#f59e0b",
	write: "#f59e0b",
	patch: "#f59e0b",
	apply: "#f59e0b",
	create: "#f59e0b",
	save: "#f59e0b",
	move: "#f59e0b",
	rename: "#f59e0b",
	bash: "#a78bfa",
};

/** Colour of a tool block: fixed for the common ones, hashed for the rest. */
export function toolColor(name: unknown): string {
	const n = String(name ?? "tool");
	if (TOOL_FIXED[n]) return TOOL_FIXED[n] as string;
	let h = 0;
	for (let i = 0; i < n.length; i++) h = ((h << 5) - h + n.charCodeAt(i)) | 0;
	return TOOL_PALETTE[Math.abs(h) % TOOL_PALETTE.length] as string;
}

/* Two shades inside the model lane: thinking = light sky blue, answer = blue.
 * A failure still wins and is drawn red. */
const MODEL_COLORS: Record<"thinking" | "text", string> = { thinking: "#38bdf8", text: "#3b82f6" };

/** Inline colour of a segment, or null to let the stylesheet's lane colour apply. */
export function laneColor(seg: TraceSeg): string | null {
	if (seg.status === "error") return "#f87171";
	if (seg.lane === "tools") return toolColor(seg.meta?.tool ?? (seg.kind === "file" ? "file" : "tool"));
	if (seg.lane === "model" && (seg.kind === "thinking" || seg.kind === "text")) return MODEL_COLORS[seg.kind];
	return null;
}

/** Total span of a segment list in milliseconds, with a 1ms floor. */
export function spanMs(all: TraceSeg[]): number {
	if (!all.length) return 1;
	let min = Infinity;
	let max = -Infinity;
	for (const s of all) {
		if (s.t < min) min = s.t;
		const e = Math.max(s.end ?? s.t, s.t);
		if (e > max) max = e;
	}
	return Math.max(1, max - min);
}

/**
 * The "active window" for the initial overview: trim the long idle stretches
 * between turns so the time actually spent working fills the viewport.
 *
 * Returns { start, end } in milliseconds, or null when there is nothing to trim or
 * activity is spread too thinly to justify showing only a sliver (the caller then
 * falls back to fitting everything).
 *
 * Rules: (1) a gap larger than the idle threshold (90s by default, never more than
 * 40% of the total span) counts as "not working" and splits a cluster; (2) a single
 * cluster is one continuous stretch of work, so the idle around it is trimmed;
 * (3) with several clusters, the largest is only focused when it owns a significant
 * share (>= 40%) of the span - the typical shape being one main run plus scattered
 * follow-ups - otherwise the full overview is kept.
 */
export function activeWindow(all: TraceSeg[]): { start: number; end: number } | null {
	if (!all.length) return null;
	const ivs = all.map((s) => [s.t, Math.max(s.end ?? s.t, s.t)]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
	const first = ivs[0] ?? [0, 0];
	let minT = first[0] ?? 0;
	let maxT = first[1] ?? 0;
	for (const [a, b] of ivs) {
		if ((a ?? 0) < minT) minT = a ?? 0;
		if ((b ?? 0) > maxT) maxT = b ?? 0;
	}
	const span = Math.max(1, maxT - minT);
	const idle = Math.min(Math.max(90000, span * 0.05), span * 0.4);
	const clusters: number[][] = [];
	let cs = first[0] ?? 0;
	let ce = first[1] ?? 0;
	for (let i = 1; i < ivs.length; i++) {
		const [a, b] = ivs[i] as number[];
		if (a - ce > idle) {
			clusters.push([cs, ce]);
			cs = a;
			ce = b;
		} else {
			if (a < cs) cs = a;
			if (b > ce) ce = b;
		}
	}
	clusters.push([cs, ce]);
	if (clusters.length === 1) {
		const [s, e] = clusters[0] as number[];
		return e - s >= span * 0.95 ? null : { start: s, end: e };
	}
	let best = clusters[0] as number[];
	let bl = best[1] - best[0];
	for (const c of clusters) {
		const l = (c[1] ?? 0) - (c[0] ?? 0);
		if (l > bl) {
			bl = l;
			best = c;
		}
	}
	return bl >= span * 0.4 ? { start: best[0] ?? 0, end: best[1] ?? 0 } : null;
}

/** A ruler tick label: HH:MM, or HH:MM:SS when the step is finer than a minute. */
export function fmtTick(t: number, withSec: boolean): string {
	const d = new Date(t);
	const p = (n: number): string => String(n).padStart(2, "0");
	return withSec
		? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
		: `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The current time window of the timeline, in milliseconds. */
export interface FlowWindow {
	a: number;
	b: number;
	span: number;
}

/** Milliseconds -> pixels inside the drawing area. */
export function flowX(ms: number, win: FlowWindow, width: number): number {
	return ((ms - win.a) / win.span) * width;
}

/** Pixels inside the drawing area -> milliseconds. */
export function flowTimeAt(x: number, win: FlowWindow, width: number): number {
	return win.a + (x / width) * win.span;
}

/** One segment placed on the replay axis: [p0, p1) in playback milliseconds. */
export interface ReplayItem {
	seg: TraceSeg;
	p0: number;
	p1: number;
}

/** The replay axis built from the visible segments. */
export interface ReplayTrack {
	segs: ReplayItem[];
	totalLen: number;
	realStart: number;
	skipIdle: boolean;
}

/**
 * Map segments onto replay-axis coordinates, by real duration rather than by
 * stepping through blocks on a timer.
 *
 * With skipIdle the coordinates accumulate active time only (segments end where the
 * next begins); otherwise a coordinate is its real offset inside the total window.
 */
export function buildReplayTrack(all: TraceSeg[], skipIdle: boolean): ReplayTrack {
	if (!all.length) return { segs: [], totalLen: 0, realStart: 0, skipIdle };
	const segs = [...all].sort((a, b) => a.t - b.t);
	const realStart = segs[0]?.t ?? 0;
	const realEnd = Math.max(...segs.map((s) => Math.max(s.end ?? s.t, s.t)));
	const span = Math.max(1, realEnd - realStart);
	if (!skipIdle) {
		return {
			segs: segs.map((s) => ({ seg: s, p0: s.t - realStart, p1: Math.max(s.end ?? s.t, s.t) - realStart })),
			totalLen: span,
			realStart,
			skipIdle: false,
		};
	}
	let acc = 0;
	return {
		segs: segs.map((s) => {
			const dur = Math.max(0, Math.max(s.end ?? s.t, s.t) - s.t);
			const item = { seg: s, p0: acc, p1: acc + dur };
			acc += dur;
			return item;
		}),
		totalLen: Math.max(1, acc),
		realStart,
		skipIdle: true,
	};
}

/** Playback position -> index of the active segment: the last one that has started
 *  and not finished. During idle time the previous segment stays active. */
export function activeIndexAt(track: ReplayTrack, pos: number): number {
	let idx = -1;
	for (let i = 0; i < track.segs.length; i++) {
		if ((track.segs[i]?.p0 ?? Infinity) <= pos) idx = i;
		else break;
	}
	return idx;
}

/** Playback position -> real time in milliseconds. Continuous through idle time
 *  when idle is played; pinned to the active segment's own timeline when it is
 *  skipped, so the playhead scans inside each block instead of jumping between them. */
export function realTimeAt(track: ReplayTrack, pos: number, idx: number): number {
	if (idx < 0) return track.realStart + pos;
	if (!track.skipIdle) return track.realStart + pos;
	const item = track.segs[idx];
	if (!item) return track.realStart + pos;
	return item.seg.t + Math.max(0, pos - item.p0);
}

/* ---------------------------------------------------------------------------
 * The timeline engine, loaded at runtime. The vendored bundle is tried first
 * (offline), then the esm.sh CDN, and when both fail the view falls back to a
 * hand-written div timeline. These interfaces describe only what this view calls,
 * because the module is fetched by URL and has no compile-time types.
 * ------------------------------------------------------------------------ */

/** One timeline item. Always a range: see visItems(). */
interface VisItem {
	id: string;
	group: string;
	start: Date;
	end: Date;
	type: string;
	content: string;
	className: string;
	style?: string;
}

interface VisGroup {
	id: string;
	content: string;
}

/** The event payload fields this view reads. */
interface VisEventProps {
	items?: (string | number)[];
	byUser?: boolean;
	item?: string | number;
	event?: MouseEvent;
}

interface VisDataSet {
	add(items: VisItem[]): void;
	update(items: { id: string; end: Date }[]): void;
	clear(): void;
	get(id: string): { end?: Date | number } | null;
}

interface VisTimeline {
	on(event: string, cb: (props: VisEventProps) => void): void;
	destroy(): void;
	setWindow(start: number, end: number, opts: { animation: boolean }): void;
	fit(opts: { animation: boolean }): void;
	setGroups(groups: VisGroup[]): void;
	setSelection(ids: string[]): void;
	getWindow(): { start: Date | number; end: Date | number } | undefined;
	moveTo(time: number, opts: { animation: boolean }): void;
	redraw(): void;
	/** Undocumented hook: the redraw vis wraps once animations are enabled. */
	_origRedraw?(): void;
}

interface VisApi {
	Timeline: new (
		container: HTMLElement,
		items: VisDataSet,
		groups: VisGroup[],
		options: Record<string, unknown>,
	) => VisTimeline;
	DataSet: new (items: VisItem[]) => VisDataSet;
}

/** The vendored bundle lives next to this compiled entry and is left external by
 *  the build, so the browser resolves it as a plain relative URL. */
function importVendor(): Promise<VisApi> {
	// @ts-expect-error - runtime-only specifier: client/vendor/ is served beside this bundle, not resolved at build time.
	return import("./vendor/vis-timeline.bundle.mjs");
}

/** Second tier: the CDN, for an install whose vendor files are missing. */
function importCdn(): Promise<VisApi> {
	// @ts-expect-error - runtime-only specifier: a URL import the type checker cannot resolve.
	return import("https://esm.sh/vis-timeline@8.5.4/standalone/esm/vis-timeline-graph2d.min.mjs");
}

/** querySelector for markup this view has just written, where the selector cannot
 *  miss. The cast keeps the rest of the view free of null checks it can never hit. */
function at<T extends Element>(root: ParentNode, selector: string): T {
	return root.querySelector<T>(selector) as T;
}

const clientEntry: {
	mount(container: HTMLElement, ctx: ViewContext): () => void;
	renderers?: never;
} = {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const t = (): typeof I18N => I18N;
		let convs: TraceConvSummary[] = [];
		let activeId: string | null = null;
		// Last server-side active conversation seen: only follow when it changes, so
		// reading history is not yanked away by a repeated state push.
		let lastActiveId: string | null = null;
		let selectedConvId: string | null = null;
		const segsCache = new Map<string, TraceSeg[]>(); // convId -> light segments
		const detailCache = new Map<string, { detail: string; seg?: TraceSeg; analysis?: TraceSegAnalysis }>();
		const pendingSeg = new Set<string>();
		let selectedKey: string | null = null;
		// Set by selectSeg(scroll:true); the next render scrolls that row into view.
		let pendingScroll: string | null = null;
		let detailTab = "overview";
		let search = "";
		const filters: Record<string, boolean> = { input: true, model: true, tools: true };
		const replay = { on: false, idx: 0, playing: false, speed: 1, skipIdle: true, raf: 0, basePos: 0, baseClock: 0 };
		let raf = 0;
		// vis-timeline state (the vendor bundle is loaded lazily; a hand-written div
		// timeline is the fallback when it cannot be loaded).
		let visApi: VisApi | null = null;
		let visPromise: Promise<VisApi | null> | null = null;
		let tl: VisTimeline | null = null;
		let tlItems: VisDataSet | null = null;
		let tlDomEl: HTMLElement | null = null;
		let tlConv: string | null = null;
		let followEnabled = true;
		let suppressSelect = false;
		let tlRO: ResizeObserver | null = null;
		let roTimer: ReturnType<typeof setTimeout> | 0 = 0;
		/** Segments drawn by the hand-written fallback, keyed by the element holding
		 *  them, so a click can map a block index back to its segment. */
		const fallbackSegs = new WeakMap<Element, TraceSeg[]>();

		function ensureVis(): void {
			if (!visPromise) {
				visPromise = (async () => {
					try {
						const mod = await importVendor().catch(() => importCdn());
						injectVisCss();
						return { Timeline: mod.Timeline, DataSet: mod.DataSet };
					} catch {
						return null;
					}
				})();
				void visPromise.then((api) => {
					visApi = api;
					if (api) scheduleRender(false);
				});
			}
		}

		function injectVisCss(): void {
			try {
				if (document.querySelector("link[data-rtr-vis]")) return;
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.dataset.rtrVis = "1";
				link.href = new URL("./vendor/vis-timeline.css", import.meta.url).href;
				document.head.appendChild(link);
			} catch {
				/* On the CDN fallback there is no stylesheet of our own; the built-in
				 * overrides below still make it usable. */
			}
		}

		function tlDom(): HTMLElement {
			if (!tlDomEl) tlDomEl = document.createElement("div");
			return tlDomEl;
		}

		function destroyTl(): void {
			hideTip();
			flowStop();
			try {
				tl?.destroy();
			} catch {
				/* already gone */
			}
			tl = null;
			tlItems = null;
			tlConv = null;
		}

		setMarkup(
			container,
			`
<div class="rtr">
	<style>
		.rtr { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--text, #e6e8ef); position: relative; }
		.rtr-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, #262a35); flex-wrap: wrap; }
		.rtr-hd h2 { margin: 0; font-size: 15px; }
		.rtr-live { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--green-soft, rgba(52,211,153,.12)); color: var(--green, #34d399); }
		.rtr-hd input[type="search"] { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 9px; font: inherit; width: 140px; }
		.rtr-hd .sp { flex: 1; }
		.rtr-btn { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
		.rtr-btn:hover { border-color: var(--accent, #8b5cff); }
		.rtr-btn.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-btn.danger:hover { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-convs { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border, #262a35); overflow-x: auto; align-items: center; }
		.rtr-conv { border: 1px solid var(--border, #262a35); background: transparent; color: inherit; font: inherit; border-radius: 99px; padding: 3px 12px; cursor: pointer; white-space: nowrap; font-size: 12px; opacity: .65; }
		.rtr-conv.sel { opacity: 1; border-color: var(--accent, #8b5cff); background: var(--accent-soft, rgba(139,92,246,.14)); }
		.rtr-conv .cur { color: var(--green, #34d399); }
		.rtr-ruler { border-bottom: 1px solid var(--border, #262a35); padding: 6px 12px 8px; background: var(--bg-elev, #14161c); }
		.rtr-rulerbar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
		.rtr-rulerbar .hint { font-size: 11px; opacity: .5; }
		.rtr-rulerbar .sp { flex: 1; }
		.rtr-rulerbar .rtr-btn { font-size: 11px; padding: 2px 9px; }
		.rtr-tlbody { height: 252px; position: relative; }
		.rtr-tlbody .vis-timeline { border: 0; background: transparent; }
		/* Flow mode: hide vis's own axis and grid lines, and let .rtr-flowgrid draw a
		   ruler that stays put on screen while its values scroll. */
		.rtr-tlbody.flowing .vis-panel.vis-top, .rtr-tlbody.flowing .vis-panel.vis-background.vis-vertical { visibility: hidden; }
		.rtr-tlbody.flowing .vis-itemset { will-change: transform; }
		.rtr-flowgrid { position: absolute; inset: 0; pointer-events: none; z-index: 5; display: none; }
		.rtr-tlbody.flowing .rtr-flowgrid { display: block; }
		.rtr-fgtop, .rtr-fgcols { position: absolute; overflow: hidden; }
		.rtr-fgtop { top: 0; height: 24px; }
		.rtr-fgcols { bottom: 0; }
		.rtr-fgcols i { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border-soft, #1e2230); }
		.rtr-fgtop b { position: absolute; top: 0; font-weight: 400; font-size: 11px; line-height: 20px; color: var(--text-faint, #6b7284); white-space: nowrap; font-variant-numeric: tabular-nums; }
		.rtr-fgnow { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent, #8b5cff); box-shadow: 0 0 8px var(--accent-soft, rgba(139,92,246,.5)); }
		.rtr-fgnow u { position: absolute; top: 0; left: 50%; transform: translateX(-50%); padding: 0 5px; border-radius: 0 0 4px 4px; background: var(--accent, #8b5cff); color: #fff; font-size: 10px; line-height: 15px; text-decoration: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
		.rtr-tlbody .vis-panel.vis-left, .rtr-tlbody .vis-panel.vis-center { border-color: var(--border-soft, #1e2230); }
		.rtr-tlbody .vis-labelset .vis-label { color: var(--text-dim, #9aa1b4); border-color: var(--border-soft, #1e2230); background: transparent; }
		.rtr-tlbody .vis-time-axis .vis-text { color: var(--text-faint, #6b7284); }
		.rtr-tlbody .vis-time-axis .vis-grid.vis-minor, .rtr-tlbody .vis-time-axis .vis-grid.vis-major { border-color: var(--border-soft, #1e2230); }
		.rtr-tlbody .vis-item { border-radius: 0; cursor: pointer; height: 12px; }
		.rtr-tlbody .vis-item::after { content: ""; position: absolute; left: -5px; right: -5px; top: -6px; bottom: -6px; }
		.rtr-tip { position: absolute; z-index: 50; pointer-events: none; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--accent, #8b5cff); border-radius: 7px; padding: 6px 10px; font-size: 12px; max-width: 320px; box-shadow: 0 4px 16px rgba(0,0,0,.45); }
		.rtr-tip .tt { font-weight: 700; margin-bottom: 2px; }
		.rtr-tip .tm { opacity: .65; font-size: 11px; }
		.rtr-tlbody .vis-item .vis-item-content { display: none; }
		.rtr-tlbody .vis-item.lane-input { background: #64748b; border-color: #64748b; }
		.rtr-tlbody .vis-item.lane-model { background: #3b82f6; border-color: #3b82f6; }
		.rtr-tlbody .vis-item.lane-tools { background: #22c55e; border-color: #16a34a; }
		.rtr-tlbody .vis-item.st-error { background: var(--red, #f87171); border-color: var(--red, #f87171); }
		.rtr-tlbody .vis-item.st-running { animation: rtr-blink 1.2s infinite; }
		.rtr-tlbody .vis-item.vis-selected { outline: 2px solid #fff; outline-offset: -1px; z-index: 2; }
		.rtr-tlbody .vis-item { box-shadow: 0 1px 5px rgba(0,0,0,.4); }
		.rtr-tlbody .vis-item.vis-selected { box-shadow: 0 0 0 1px #fff, 0 2px 10px rgba(0,0,0,.5); }
		.rtr-axis { display: flex; justify-content: space-between; font-size: 11px; opacity: .55; margin-bottom: 4px; }
		.rtr-legend { display: flex; gap: 4px 12px; flex-wrap: wrap; padding: 5px 0 7px; font-size: 11px; }
		.rtr-legend .lg-item { display: inline-flex; align-items: center; gap: 5px; opacity: .85; }
		.rtr-legend .lg-item i { width: 10px; height: 10px; border-radius: 0; display: inline-block; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
		.rtr-lane { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
		.rtr-lane .ln { width: 34px; flex: none; font-size: 11px; opacity: .6; text-align: right; }
		.rtr-track { position: relative; flex: 1; height: 16px; background: var(--bg-elev2, #1a1d26); border-radius: 4px; overflow: hidden; }
		.rtr-blk { position: absolute; top: 2px; height: 10px; border-radius: 0; background: #3b82f6; opacity: .85; cursor: pointer; }
		.rtr-blk.lane-input { background: #64748b; }
		.rtr-blk.lane-model { background: #3b82f6; }
		.rtr-blk.lane-tools { background: #22c55e; }
		.rtr-blk.st-error { background: var(--red, #f87171); }
		.rtr-blk.st-running { animation: rtr-blink 1.2s infinite; }
		.rtr-blk.sel { outline: 2px solid #fff; outline-offset: -1px; z-index: 1; }
		@keyframes rtr-blink { 50% { opacity: .35; } }
		.rtr-bd { display: flex; flex: 1; min-height: 0; }
		.rtr-list { flex: 1; min-width: 0; border-right: 1px solid var(--border, #262a35); overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
		.rtr-row { display: flex; gap: 8px; align-items: baseline; border: 1px solid transparent; border-radius: 7px; padding: 6px 9px; cursor: pointer; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; }
		.rtr-row:hover { border-color: var(--accent, #8b5cff); }
		.rtr-row.sel { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-chip { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 5px; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #262a35); }
		.rtr-row .tt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.rtr-row time { flex: none; font-size: 11px; opacity: .55; }
		.rtr-row.err .rtr-chip { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-detail { width: 320px; min-width: 320px; flex: none; overflow-y: auto; padding: 12px 14px; min-height: 0; }
		.rtr-dtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #262a35); margin-bottom: 10px; }
		.rtr-dtab { background: transparent; border: 0; border-bottom: 2px solid transparent; color: inherit; font: inherit; padding: 6px 12px; cursor: pointer; opacity: .6; }
		.rtr-dtab.on { opacity: 1; border-bottom-color: var(--accent, #8b5cff); }
		.rtr-kv { display: grid; grid-template-columns: 86px 1fr; gap: 5px 10px; font-size: 12px; margin-bottom: 12px; }
		.rtr-kv dt { opacity: .55; }
		.rtr-kv dd { margin: 0; word-break: break-word; }
		.rtr-sec { font-size: 12px; font-weight: 700; margin: 12px 0 6px; opacity: .8; }
		.rtr-bar { height: 8px; border-radius: 4px; background: var(--bg-elev2, #1a1d26); overflow: hidden; margin: 3px 0 7px; }
		.rtr-bar i { display: block; height: 100%; background: #3b82f6; }
		.rtr-detail pre { white-space: pre-wrap; word-break: break-word; background: var(--bg-elev, #14161c); border: 1px solid var(--border, #262a35); border-radius: 8px; padding: 9px 11px; font-size: 12px; margin: 0; }
		.rtr-empty { opacity: .6; text-align: center; padding: 40px 20px; }
		.rtr-spin { display: inline-block; animation: rtr-blink 1s infinite; }
		.rtr-replaybar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border, #262a35); background: var(--bg-elev, #14161c); font-size: 12px; }
		.rtr-replaybar input[type="range"] { flex: 1; accent-color: var(--accent, #8b5cff); }
		.rtr-replaybar select { background: var(--bg-elev2, #1a1d26); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; font: inherit; padding: 2px 6px; }
		.rtr-replaybar .skip { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; opacity: .85; white-space: nowrap; }
		.rtr-replaybar .skip input { accent-color: var(--accent, #8b5cff); margin: 0; }
		.rtr-tlbody .rtr-playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent, #8b5cff); pointer-events: none; z-index: 6; display: none; }
		/* ---- Narrow portrait phones (<= 640px): overrides only, desktop untouched ---- */
		@media (max-width: 640px) {
			/* Stack the three sections instead of sitting side by side: the timeline on
			   top, the list and the detail below sharing the remaining height and each
			   scrolling on its own. */
			.rtr-bd { flex-direction: column; overflow: hidden; padding-bottom: env(safe-area-inset-bottom, 0px); }
			.rtr-list { flex: 1 1 0; min-height: 0; max-height: none; border-right: 0; border-bottom: 1px solid var(--border, #262a35); overflow-y: auto; }
			.rtr-detail { width: auto; min-width: 0; flex: 1 1 0; min-height: 0; overflow-y: auto; }
			/* Header: the search field takes the rest of the row, buttons get a tappable size. */
			.rtr-hd { gap: 10px; padding: 10px; }
			.rtr-hd input[type="search"] { flex: 1 1 140px; width: auto; min-width: 120px; min-height: 36px; padding: 8px 10px; }
			/* iOS zooms the page when focusing an input whose font-size is below 16px,
			   so on narrow screens everything is raised to 16px. */
			.rtr input, .rtr select, .rtr textarea { font-size: 16px; }
			.rtr-btn { min-height: 36px; padding: 7px 12px; }
			.rtr-conv { padding: 8px 14px; min-height: 36px; }
			.rtr-dtab { padding: 8px 12px; min-height: 36px; }
			.rtr-row { padding: 10px; min-height: 36px; }
			/* Save vertical space on the timeline: the height:"252px" this view passes to
			   vis is overridden in the display layer by the next !important rule, so the
			   script does not need to know about it. */
			.rtr-ruler { padding: 6px 8px 8px; }
			.rtr-rulerbar { gap: 10px; }
			.rtr-rulerbar .rtr-btn { font-size: 12px; padding: 7px 12px; min-height: 36px; }
			.rtr-tlbody { height: 200px; }
			.rtr-tlbody .vis-timeline { height: 200px !important; min-height: 200px; max-height: 200px; }
			/* Narrow-screen details: the tooltip must not overflow the right edge, the
			   replay bar may wrap, and the key column of the kv grid gets narrower. */
			.rtr-tip { max-width: min(320px, calc(100vw - 32px)); }
			.rtr-replaybar { flex-wrap: wrap; row-gap: 6px; }
			.rtr-kv { grid-template-columns: 72px 1fr; }
		}
		/* Coarse pointers (touch): enlarge the click target of a timeline block by
		   another ring, still pure CSS. */
		@media (hover: none) {
			.rtr-tlbody .vis-item::after { left: -8px; right: -8px; top: -10px; bottom: -10px; }
		}
	</style>
	<div class="rtr-hd">
		<h2>🧭 <span class="t-title"></span></h2>
		<span class="rtr-live"></span>
		<span class="sp"></span>
		<input type="search" class="q" />
		<button class="rtr-btn act-replay"></button>
		<button class="rtr-btn danger act-clear"></button>
	</div>
	<div class="rtr-convs"></div>
	<div class="rtr-ruler"><div class="rtr-rulerbar"><span class="hint"></span><span class="sp"></span><button class="rtr-btn act-follow"></button><button class="rtr-btn act-fit"></button></div><div class="rtr-legend"></div><div class="rtr-tlbody"></div></div>
	<div class="rtr-replaybar" hidden></div>
	<div class="rtr-bd">
		<div class="rtr-list"></div>
		<div class="rtr-detail"></div>
	</div>
</div>`,
		);

		const $ = <T extends Element = HTMLElement>(selector: string): T => at<T>(container, selector);
		const hdTitle = $<HTMLElement>(".t-title");
		const hdLive = $<HTMLElement>(".rtr-live");
		const qEl = $<HTMLInputElement>(".q");
		const replayBtn = $<HTMLButtonElement>(".act-replay");
		const clearBtn = $<HTMLButtonElement>(".act-clear");
		const convsEl = $<HTMLElement>(".rtr-convs");
		const rulerEl = $<HTMLElement>(".rtr-ruler");
		const replayBar = $<HTMLElement>(".rtr-replaybar");
		const listEl = $<HTMLElement>(".rtr-list");
		const detailEl = $<HTMLElement>(".rtr-detail");

		/** Write the label set into the chrome around the timeline. */
		function applyLang(): void {
			const L = t();
			hdTitle.textContent = L.title;
			hdLive.textContent = `● ${L.live}`;
			qEl.placeholder = L.search;
			replayBtn.textContent = replay.on ? `⏹ ${L.exitReplay}` : `▶ ${L.replay}`;
			replayBtn.classList.toggle("on", replay.on);
			clearBtn.textContent = `🗑 ${L.clear}`;
		}

		function convOf(id: string): TraceConvSummary | undefined {
			return convs.find((c) => c.id === id);
		}
		function allSegs(): TraceSeg[] {
			return segsCache.get(selectedConvId ?? "") ?? [];
		}
		function visibleSegs(): TraceSeg[] {
			const q = search.trim().toLowerCase();
			return allSegs().filter((s) => {
				if (!filters[s.lane]) return false;
				if (q && !`${s.title}\n${s.summary}\n${s.source}\n${s.meta?.tool ?? ""}`.toLowerCase().includes(q))
					return false;
				return true;
			});
		}

		function renderConvs(): void {
			const L = t();
			if (!convs.length) {
				setMarkup(convsEl, `<span style="opacity:.55;font-size:12px">${esc(L.emptyHint)}</span>`);
				return;
			}
			setMarkup(
				convsEl,
				convs
					.map(
						(c) =>
							`<button class="rtr-conv${c.id === selectedConvId ? " sel" : ""}" data-id="${esc(c.id)}">${c.id === activeId ? `<span class="cur">●</span> ` : ""}${esc(c.title || L.empty)}${c.isStreaming ? " ⏳" : ""}</button>`,
					)
					.join(""),
			);
		}

		function renderRuler(): void {
			const L = t();
			const hintEl = rulerEl.querySelector(".hint");
			const fitBtn = rulerEl.querySelector(".act-fit");
			const followBtn = rulerEl.querySelector(".act-follow");
			if (hintEl) hintEl.textContent = flowing ? L.flowHint : L.zoomHint;
			if (fitBtn) fitBtn.textContent = L.fit;
			if (followBtn) {
				followBtn.textContent = L.follow;
				followBtn.classList.toggle("on", followEnabled);
			}
			const body = rulerEl.querySelector<HTMLElement>(".rtr-tlbody");
			const all = visibleSegs();
			void ensureVis(); // Load the timeline engine in the background; it re-renders when ready.
			// When the container is not visible (zero width or height, e.g. the view is
			// switched away or the panel is collapsed) no timeline is built: vis would
			// measure a zero height and draw a squashed axis. The hand-written placeholder
			// is drawn instead, and the ResizeObserver rebuilds it once it becomes visible.
			const sized = !!body && body.clientWidth > 0 && body.clientHeight > 0;
			if (!visApi || !selectedConvId || !all.length || !sized) {
				if (tl) destroyTl();
				if (body) renderRulerFallback(body, all);
				return;
			}
			if (body && body.firstChild !== tlDom()) {
				body.replaceChildren();
				body.appendChild(tlDom());
			}
			const groups: VisGroup[] = [
				{ id: "input", content: esc(L.lanes.input) },
				{ id: "model", content: esc(L.lanes.model) },
				{ id: "tools", content: esc(L.lanes.tools) },
			];
			if (!tl || tlConv !== selectedConvId) {
				destroyTl();
				tlItems = new visApi.DataSet(visItems(all));
				tl = new visApi.Timeline(tlDom(), tlItems, groups, {
					stack: true,
					orientation: "top",
					showMajorLabels: true,
					showMinorLabels: true,
					zoomable: true,
					moveable: true,
					selectable: true,
					multiselect: false,
					zoomMin: 10,
					zoomMax: 1000 * 60 * 60 * 24 * 30,
					margin: { item: 3, axis: 6 },
					tooltip: { followMouse: true, overflowMethod: "cap" },
					height: "252px",
				});
				tl.on("select", (props) => {
					if (suppressSelect) return;
					const id = props.items?.[0];
					if (id === undefined) {
						// Clicked empty space: drop the selection and go back to the
						// whole-conversation analysis.
						if (selectedKey) {
							selectedKey = null;
							scheduleRender(false);
						}
						return;
					}
					selectSeg(String(id), { scroll: true });
				});
				tl.on("rangechange", (props) => {
					// Zoom or pan in progress: recompute the minimum visible width against
					// the new window (throttled by rAF) so blocks stay glued to the ruler.
					scheduleEpsSync();
					if (!props?.byUser) return;
					// Tell a user zoom (the span changed -> keep following, re-anchored to
					// "now" at the new zoom level) from a drag pan (the span did not change
					// -> pause following, otherwise every frame would drag the view back to
					// the right edge, which feels worse).
					const w = flowWin();
					if (!w) return;
					const zoomed = flowSpanSeen > 0 && Math.abs(w.span - flowSpanSeen) > Math.max(1, flowSpanSeen * 0.002);
					flowSpanSeen = w.span;
					if (!zoomed && followEnabled) {
						followEnabled = false;
						rulerEl.querySelector(".act-follow")?.classList.remove("on");
						flowSync();
					}
				});
				tl.on("rangechanged", () => {
					hideTip();
					scheduleEpsSync();
					if (replay.on) refreshPlayhead(false); // Re-align the playhead with the new window after a zoom or pan.
				});
				tl.on("itemover", (props) => {
					if (props.item !== undefined && props.event) showTip(String(props.item), props.event);
				});
				tl.on("itemout", () => hideTip());
				tlConv = selectedConvId;
				followEnabled = true;
				try {
					// The initial overview focuses the active stretch automatically: the long
					// idle gaps between turns are cut so the time actually spent working fills
					// the viewport. Scattered activity falls back to the full range, and the
					// Fit button still means "show everything".
					const aw = activeWindow(all);
					if (aw) {
						const pad = Math.max(0, (aw.end - aw.start) * 0.02);
						tl.setWindow(aw.start - pad, aw.end + pad, { animation: false });
					} else {
						tl.fit({ animation: false });
					}
				} catch {
					try {
						tl.fit({ animation: false });
					} catch {
						/* the axis is not usable yet */
					}
				}
				// Compute the minimum visible width for the current window as soon as the
				// axis exists, so instantaneous slivers line up with the ruler on the very
				// first frame (no more 1.5s of fake width).
				scheduleEpsSync();
				flowMeasure();
				flowSpanSeen = flowWin()?.span ?? 0;
				// A running conversation enters flow mode ("now" is anchored 40px from the
				// right edge of the drawing area, then flows smoothly left as time passes).
				flowSync();
				// If the layout is still settling at the moment the axis is built (it has
				// just become visible, say), reflow once more on the next frame.
				requestAnimationFrame(() => {
					try {
						if (tl && tlConv === selectedConvId) tl.redraw();
					} catch {
						/* ignore */
					}
				});
			} else {
				try {
					tl.setGroups(groups);
					tlItems?.clear();
					tlItems?.add(visItems(all));
				} catch {
					/* the axis is mid-update */
				}
				// Live increments: enter or stay in flow mode when needed (the per-frame
				// loop advances the window). When the user is reading history (following
				// off) the window is left alone, so even a millisecond-level zoom is not
				// dragged back.
				flowSync();
			}
			try {
				suppressSelect = true;
				tl.setSelection(selectedKey ? [selectedKey] : []);
			} catch {
				/* the axis is mid-update */
			} finally {
				suppressSelect = false;
			}
		}

		/** Instant tooltip: shown in the same frame as itemover, with none of the delay
		 *  of a native title, and hidden on leave or zoom. */
		function showTip(key: string, ev: MouseEvent): void {
			const s = allSegs().find((x) => x.key === key);
			if (!s) return;
			let tip = container.querySelector<HTMLElement>(".rtr-tip");
			if (!tip) {
				tip = document.createElement("div");
				tip.className = "rtr-tip";
				container.appendChild(tip);
			}
			setMarkup(
				tip,
				`<div class="tt">${esc(s.title)}</div><div class="tm">${esc(s.source ?? "")}</div><div class="tm">${esc(fmtClock(s.t))}${s.dur !== undefined ? ` · ${esc(fmtDur(s.dur))}` : ""}${(s.end ?? s.t) > s.t ? ` → ${esc(fmtClock(s.end ?? s.t))}` : ""}</div>`,
			);
			tip.style.display = "block";
			const r = container.getBoundingClientRect();
			const x = Math.min(Math.max(8, (ev.clientX ?? 0) - r.left + 14), Math.max(8, r.width - 330));
			const y = Math.min(Math.max(8, (ev.clientY ?? 0) - r.top + 16), Math.max(8, r.height - 90));
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		}

		function hideTip(): void {
			container.querySelector(".rtr-tip")?.remove();
		}

		/** Minimum visible width in pixels. An event whose real duration is shorter than
		 *  this is widened in the display layer only, and the amount is derived from the
		 *  current zoom window - at most MIN_SLIVER_PX extra pixels on screen. Unlike the
		 *  old fixed 1.5s / 0.5% width, this does not lie about durations on the ruler. */
		const MIN_SLIVER_PX = 2;

		/** Width of the area the timeline actually draws items in (px), i.e. minus the
		 *  swimlane label column on the left. */
		function tlDrawWidth(): number {
			try {
				const w = tlDom().clientWidth || 800;
				const lab = tlDom().querySelector(".vis-labelset");
				return Math.max(50, w - (lab ? lab.getBoundingClientRect().width : 0));
			} catch {
				return 800;
			}
		}

		/** Milliseconds that MIN_SLIVER_PX pixels cover at the current zoom (0 = the
		 *  window is unknown and the caller falls back). */
		function currentEps(): number {
			try {
				if (!tl) return 0;
				const w = tl.getWindow?.();
				if (!w) return 0;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				const span = Math.max(1, (b || 0) - (a || 0));
				return (span * MIN_SLIVER_PX) / tlDrawWidth();
			} catch {
				return 0;
			}
		}

		/** When the data has not changed and only the zoom window or the clock has, sync
		 *  the right edge of every item: instantaneous slivers grow and shrink with the
		 *  zoom (converging back to their real duration when zoomed in) and a running
		 *  segment's right edge advances with now. */
		function syncDisplayEnds(): void {
			try {
				if (!tlItems || !tl) return;
				const eps = currentEps();
				const now = Date.now();
				// Jitter threshold: a difference below 0.25px is not worth a vis redraw
				// (called per frame, this saves a lot of reflow).
				const thr = Math.max(0.5, eps / 8);
				const upd: { id: string; end: Date }[] = [];
				for (const s of visibleSegs()) {
					const startMs = s.t;
					const realEnd = Math.max(s.end ?? startMs, startMs);
					const want = s.status === "running" ? Math.max(now, startMs + eps) : Math.max(realEnd, startMs + eps);
					const cur = tlItems.get(s.key)?.end;
					const curMs = cur instanceof Date ? cur.getTime() : Number(cur ?? realEnd);
					if (Math.abs(curMs - want) > thr) upd.push({ id: s.key, end: new Date(want) });
				}
				if (upd.length) tlItems.update(upd);
			} catch {
				/* mid-zoom fallback */
			}
		}

		let epsRaf = 0;
		function scheduleEpsSync(): void {
			if (epsRaf) return;
			epsRaf = requestAnimationFrame(() => {
				epsRaf = 0;
				syncDisplayEnds();
			});
		}

		/** Whether the selected conversation is running (streaming, or any segment is still
		 *  in progress). */
		function isLiveConv(): boolean {
			const c = convOf(selectedConvId ?? "");
			if (c?.isStreaming) return true;
			return visibleSegs().some((s) => s.status === "running");
		}

		/* ===================== Follow (live flow) mode =====================
		 * Goal: blocks flow smoothly from right to left while the time grid lines do
		 * not move at all.
		 *
		 * The timeline is anchored to "now" - now always sits FOLLOW_MARGIN_PX from
		 * the right edge of the drawing area. Advancing is split in two so the parts
		 * do not interfere:
		 *   (1) the vis window, committed: setWindow is called only once the
		 *       accumulated shift passes FLOW_COMMIT_PX (vis has to reposition items);
		 *   (2) a CSS transform, per frame: .vis-itemset is translated by -shift for
		 *       sub-pixel continuous movement. On a commit the transform resets to
		 *       zero and the window moves forward by the same amount of time - the two
		 *       cancel out, so the motion is perfectly continuous to the eye instead of
		 *       jumping once a second.
		 * The ruler is drawn by this plugin into .rtr-flowgrid (fixed on screen, its
		 * values scrolling with time); vis's own axis and grid are hidden while
		 * flowing, which is why the grid lines never move.
		 * A running block is pinned to the "now" line naturally, because
		 * syncDisplayEnds pushes its end to now every frame.
		 */
		const FOLLOW_MARGIN_PX = 40;
		const FLOW_COMMIT_PX = 90; // Commit the window once the shift passes this (bigger is cheaper, but must stay inside vis's visible band).
		const TICK_TARGET_PX = 110; // Target pixel spacing between two ticks.
		const TICK_LADDER = [
			1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 21600000,
			43200000, 86400000,
		];
		/** Geometry of the drawing area inside .rtr-tlbody. */
		interface FlowGeom {
			left: number;
			width: number;
			axisH: number;
		}
		interface FlowTick {
			line: HTMLElement;
			label: HTMLElement;
			x: number;
			/** True when the label would be clipped by the right edge (or collide with
			 *  the "now" badge), so no text is drawn for it. */
			tight?: boolean;
		}
		let flowing = false;
		let flowRaf = 0;
		let flowShift = 0; // Current CSS shift in px (> 0 = the content has moved left).
		let flowWrap: HTMLElement | null = null; // .vis-itemset, the only container that is transformed.
		let flowGrid: HTMLElement | null = null; // The hand-drawn ruler layer.
		let flowGeom: FlowGeom | null = null;
		let flowTicks: FlowTick[] = [];
		let flowStep = 0; // Current tick step in ms.
		let flowSig = ""; // Geometry signature of the ruler layer (rebuilt only when it changes).
		let flowPaintSec = -1; // Second at which the tick values were last repainted.
		let flowSpanSeen = 0; // Last window span seen, to tell a user zoom from a pan.

		/** The current time window in milliseconds, or null when it is not usable. */
		function flowWin(): FlowWindow | null {
			try {
				const w = tl?.getWindow?.();
				if (!w) return null;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
				return { a, b, span: b - a };
			} catch {
				return null;
			}
		}

		/** Whether the view should be in live-flow mode: following on, not replaying,
		 *  the selected conversation running, and the timeline built. */
		function flowLive(): boolean {
			return !!tl && followEnabled && !replay.on && tlConv === selectedConvId && isLiveConv();
		}

		/** Measure where the drawing area sits inside .rtr-tlbody and how big it is. Only
		 *  called when the axis is built or resized, to avoid forcing layout per frame. */
		function flowMeasure(): void {
			const tlbody = rulerEl.querySelector(".rtr-tlbody");
			const content = tlDom().querySelector(".vis-panel.vis-center .vis-content");
			if (!tlbody || !content) {
				flowGeom = null;
				return;
			}
			const br = tlbody.getBoundingClientRect();
			const cr = content.getBoundingClientRect();
			flowGeom = { left: cr.left - br.left, width: Math.max(80, cr.width), axisH: Math.max(0, cr.top - br.top) };
		}

		/** Rebuild the ruler DOM. Positions are fixed (they depend only on the window
		 *  span and the drawing area size); the values are left to flowPaint. */
		function flowBuild(win: FlowWindow, geom: FlowGeom): void {
			const tlbody = rulerEl.querySelector(".rtr-tlbody");
			if (!tlbody) return;
			if (!flowGrid || flowGrid.parentNode !== tlbody) {
				flowGrid = document.createElement("div");
				flowGrid.className = "rtr-flowgrid";
				setMarkup(
					flowGrid,
					'<div class="rtr-fgtop"></div><div class="rtr-fgcols"></div><div class="rtr-fgnow"><u></u></div>',
				);
				tlbody.appendChild(flowGrid);
			}
			const grid = flowGrid;
			const top = at<HTMLElement>(grid, ".rtr-fgtop");
			const cols = at<HTMLElement>(grid, ".rtr-fgcols");
			const nowEl = at<HTMLElement>(grid, ".rtr-fgnow");
			top.style.cssText = `left:${geom.left}px;width:${geom.width}px;height:${geom.axisH + 4}px`;
			cols.style.cssText = `left:${geom.left}px;width:${geom.width}px;top:${geom.axisH}px`;
			nowEl.style.left = `${geom.left + geom.width - FOLLOW_MARGIN_PX}px`;
			const want = (win.span * TICK_TARGET_PX) / geom.width;
			flowStep = TICK_LADDER.find((s) => s >= want) ?? (TICK_LADDER[TICK_LADDER.length - 1] as number);
			const stepPx = (flowStep / win.span) * geom.width;
			const n = Math.max(2, Math.floor(geom.width / stepPx) + 1);
			if (flowTicks.length !== n) {
				cols.replaceChildren();
				top.replaceChildren();
				flowTicks = [];
				for (let i = 0; i < n; i++) {
					const line = document.createElement("i");
					cols.appendChild(line);
					const label = document.createElement("b");
					top.appendChild(label);
					flowTicks.push({ line, label, x: 0 });
				}
			}
			for (let i = 0; i < n; i++) {
				const x = i * stepPx;
				const el = flowTicks[i];
				if (!el) continue;
				el.x = x;
				el.line.style.left = `${x.toFixed(2)}px`;
				el.label.style.left = `${(x + 4).toFixed(2)}px`;
				// The last label would be clipped by the right edge (and ghost into the
				// "now" badge), so it is simply left empty.
				el.tight = x > geom.width - 46;
			}
			flowPaintSec = -1; // The size or the step changed: force one repaint of the values.
		}

		/** Tick values: the lines do not move, the values scroll with time (repainting
		 *  once a second is enough). */
		function flowPaint(win: FlowWindow, geom: FlowGeom, now: number): void {
			const sec = Math.floor(now / 1000);
			if (sec === flowPaintSec) return;
			flowPaintSec = sec;
			const withSec = flowStep < 60000;
			for (const tk of flowTicks)
				tk.label.textContent = tk.tight ? "" : fmtTick(flowTimeAt(tk.x + flowShift, win, geom.width), withSec);
			const u = flowGrid?.querySelector(".rtr-fgnow u");
			if (u) u.textContent = fmtTick(now, true);
		}

		/** Commit the sub-pixel shift into the vis window: move the window forward by the
		 *  same amount of time and redraw synchronously, so the motion stays continuous.
		 *  vis only recomputes item X positions on a full redraw (a redraw triggered by
		 *  rangechange is throttled away, and in practice item positions lag by about a
		 *  second before jumping), so a complete redraw is triggered here to land "items
		 *  repositioned" and "transform reset to zero" in the same frame. */
		function flowAbsorb(win: FlowWindow, width: number, shift: number): FlowWindow {
			const timeline = tl;
			if (!timeline) return win;
			const a2 = win.a + (shift * win.span) / width;
			timeline.setWindow(a2, a2 + win.span, { animation: false });
			try {
				if (typeof timeline._origRedraw === "function") timeline._origRedraw();
				else timeline.redraw();
			} catch {
				/* Without the internal API this degrades to a redraw on the next frame
				 * (which may show as one small jump). */
			}
			return flowWin() ?? win;
		}

		/** One frame: shift (and commit the window when needed). */
		function flowTick(): void {
			flowRaf = 0;
			if (!flowing) return;
			flowRaf = requestAnimationFrame(flowTick);
			try {
				let win = flowWin();
				if (!win || !flowGeom) return;
				const geom = flowGeom;
				const now = Date.now();
				const nowX = geom.width - FOLLOW_MARGIN_PX;
				let shift = flowX(now, win, geom.width) - nowX;
				if (shift >= FLOW_COMMIT_PX || shift <= -FLOW_COMMIT_PX) {
					win = flowAbsorb(win, geom.width, shift);
					shift = flowX(now, win, geom.width) - nowX;
					flowSpanSeen = win.span;
				}
				flowShift = shift;
				if (flowWrap) flowWrap.style.transform = Math.abs(shift) < 0.01 ? "" : `translateX(${(-shift).toFixed(2)}px)`;
				// Running blocks: the data layer pushes their right edge to now (vis redraws
				// them itself), which together with the shift above pins them to the "now" line.
				syncDisplayEnds();
				const sig = `${geom.left}|${geom.width}|${geom.axisH}|${win.span}`;
				if (sig !== flowSig) {
					flowSig = sig;
					flowBuild(win, geom);
				}
				flowPaint(win, geom, now);
			} catch {
				/* mid-window fallback */
			}
		}

		/** Enter or leave flow mode (idempotent). */
		function flowSync(): void {
			const live = flowLive();
			if (live) flowMeasure();
			if (live && !flowing) {
				flowing = true;
				flowWrap = tlDom().querySelector<HTMLElement>(".vis-itemset");
				flowSig = "";
				flowSpanSeen = flowWin()?.span ?? 0;
				rulerEl.querySelector(".rtr-tlbody")?.classList.add("flowing");
				const hintEl = rulerEl.querySelector(".hint");
				if (hintEl) hintEl.textContent = t().flowHint;
				if (!flowRaf) flowRaf = requestAnimationFrame(flowTick);
			} else if (!live && flowing) {
				flowStop();
			} else if (live) {
				if (!flowRaf) flowRaf = requestAnimationFrame(flowTick);
			}
		}

		/** Leave flow mode: commit whatever shift is left into the window so the content
		 *  does not jump. */
		function flowStop(): void {
			try {
				if (tl && flowGeom && Math.abs(flowShift) > 0.5) {
					const win = flowWin();
					if (win) flowAbsorb(win, flowGeom.width, flowShift);
				}
			} catch {
				/* the axis is already destroyed */
			}
			flowing = false;
			if (flowRaf) cancelAnimationFrame(flowRaf);
			flowRaf = 0;
			flowShift = 0;
			if (flowWrap) flowWrap.style.transform = "";
			flowWrap = null;
			rulerEl.querySelector(".rtr-tlbody")?.classList.remove("flowing");
			flowGrid?.remove();
			flowGrid = null;
			flowTicks = [];
			flowStep = 0;
			flowSig = "";
			flowPaintSec = -1;
			const hintEl = rulerEl.querySelector(".hint");
			if (hintEl) hintEl.textContent = t().zoomHint;
		}

		/** vis-timeline items. Everything is a range: an instantaneous event is still
		 *  drawn as a sliver, because a box-type item is split by vis into dot/line/box
		 *  elements of which only the box carries the selection event - clicking the dot
		 *  often selects nothing or the wrong thing. With everything a range, what you
		 *  see is what you get. start/end line up exactly with the ruler: a real duration
		 *  at or above the minimum is drawn as-is (which also removes the overlapping
		 *  rows the old fake width caused for serial calls); only a duration below
		 *  MIN_SLIVER_PX at the current zoom is widened, in the display layer alone. */
		function visItems(all: TraceSeg[]): VisItem[] {
			const eps = currentEps() || Math.max(1, spanMs(all) * 0.0001);
			const now = Date.now();
			return all.map((s) => {
				const startMs = s.t;
				const realEnd = Math.max(s.end ?? startMs, startMs);
				// Display-layer right edge = max(real end, start + minimum width). A running
				// segment has no end yet, so it gets at least the minimum and grows to now.
				const endMs = s.status === "running" ? Math.max(now, startMs + eps) : Math.max(realEnd, startMs + eps);
				const err = s.status === "error";
				const cls = `lane-${s.lane}${err ? " st-error" : ""}${s.status === "running" ? " st-running" : ""}`;
				// Coloured by lane and type (a failure is still red); the inline style
				// overrides the lane's base colour.
				const color = laneColor(s);
				const style = color ? `background-color:${color};border-color:${color};` : undefined;
				return {
					id: s.key,
					group: s.lane,
					start: new Date(startMs),
					end: new Date(endMs),
					type: "range",
					content: "",
					className: cls,
					...(style ? { style } : {}),
				};
			});
		}

		/** The hand-written timeline used when the professional library is absent (offline
		 *  with no vendor files and no CDN reachability). */
		function renderRulerFallback(body: HTMLElement, all: TraceSeg[]): void {
			const L = t();
			if (tl) destroyTl();
			if (!selectedConvId || !all.length) {
				setMarkup(
					body,
					LANES.map(
						(ln) =>
							`<div class="rtr-lane"><span class="ln">${esc(L.lanes[ln])}</span><div class="rtr-track"></div></div>`,
					).join(""),
				);
				fallbackSegs.delete(body);
				return;
			}
			const minT = Math.min(...all.map((s) => s.t));
			const maxT = Math.max(...all.map((s) => Math.max(s.end ?? s.t, s.t)));
			const span = Math.max(1, maxT - minT);
			const total = all[all.length - 1] ? fmtDur(maxT - minT) : "";
			// The hand-written axis applies the same pixel floor (MIN_SLIVER_PX converted
			// through the container width) without distorting the ruler.
			const pxW = body.clientWidth;
			const minSpanMs = pxW > 0 ? span * (MIN_SLIVER_PX / pxW) : 0;
			setMarkup(
				body,
				`
<div class="rtr-axis"><span>${esc(fmtClock(minT))}</span><span>${esc(total)}</span><span>${esc(fmtClock(maxT))}</span></div>
${LANES.map((ln) => {
	const blocks = all.map((s, i) => ({ s, i })).filter(({ s }) => s.lane === ln);
	return `<div class="rtr-lane"><span class="ln">${esc(L.lanes[ln])}</span><div class="rtr-track">${blocks
		.map(({ s, i }) => {
			const left = ((s.t - minT) / span) * 100;
			const realEnd = Math.max(s.end ?? s.t, s.t);
			const end =
				s.status === "running" && minSpanMs > 0
					? Math.max(Date.now(), s.t + minSpanMs)
					: Math.max(realEnd, s.t + minSpanMs);
			const width = ((end - s.t) / span) * 100;
			const color = laneColor(s);
			return `<span class="rtr-blk lane-${ln}${s.status === "error" ? " st-error" : ""}${s.status === "running" ? " st-running" : ""}${s.key === selectedKey ? " sel" : ""}" data-i="${i}" title="${esc(s.title)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%${color ? `;background-color:${color};border-color:${color}` : ""}"></span>`;
		})
		.join("")}</div></div>`;
}).join("")}`,
			);
			fallbackSegs.set(body, all);
		}

		function renderList(): void {
			const L = t();
			const all = visibleSegs();
			if (!selectedConvId) {
				setMarkup(listEl, `<div class="rtr-empty">${esc(L.selectHint)}</div>`);
				return;
			}
			if (!all.length) {
				setMarkup(listEl, `<div class="rtr-empty">${esc(allSegs().length ? L.noMatch : L.emptyHint)}</div>`);
				return;
			}
			const shown = replay.on ? all.slice(0, replay.idx + 1) : all;
			setMarkup(
				listEl,
				shown
					.map((s) => {
						const tc =
							s.status === "error"
								? null
								: s.kind === "tool"
									? toolColor(s.meta?.tool ?? "tool")
									: s.kind === "thinking" || s.kind === "text"
										? MODEL_COLORS[s.kind]
										: null;
						return `<button class="rtr-row${s.key === selectedKey ? " sel" : ""}${s.status === "error" ? " err" : ""}" data-key="${esc(s.key)}">
<span class="rtr-chip"${tc ? ` style="border-color:${tc};color:${tc}"` : ""}>${esc(chipFor(s))}</span>
<span class="tt">${esc(s.title)}</span>
<time>${esc(fmtClock(s.t))}${s.dur !== undefined ? ` · ${esc(fmtDur(s.dur))}` : ""}</time>
</button>`;
					})
					.join(""),
			);
			renderReplayBar(all);
		}

		/** Tool legend: every tool present in the current view, in the same colour as its
		 *  timeline blocks. */
		function renderLegend(): void {
			const el = rulerEl.querySelector<HTMLElement>(".rtr-legend");
			if (!el) return;
			const vis = visibleSegs();
			const seen = new Map<string, string>();
			if (vis.some((s) => s.kind === "thinking")) seen.set("think", MODEL_COLORS.thinking);
			if (vis.some((s) => s.kind === "text")) seen.set("text", MODEL_COLORS.text);
			for (const s of vis) {
				if (s.lane !== "tools" || s.status === "error") continue;
				const name = s.meta?.tool ?? (s.kind === "file" ? "file" : null);
				if (!name || seen.has(name)) continue;
				seen.set(name, toolColor(name));
			}
			setMarkup(
				el,
				[...seen.entries()]
					.map(([n, c]) => `<span class="lg-item"><i style="background:${c}"></i>${esc(n)}</span>`)
					.join(""),
			);
			el.style.display = seen.size ? "" : "none";
		}

		function renderReplayBar(all: TraceSeg[]): void {
			const L = t();
			if (!replay.on || !all.length) {
				replayBar.hidden = true;
				replayBar.replaceChildren();
				return;
			}
			replayBar.hidden = false;
			const maxIdx = Math.max(0, all.length - 1);
			const idx = Math.min(replay.idx, maxIdx);
			setMarkup(
				replayBar,
				`
<button class="rtr-btn act-play">${replay.playing ? `⏸ ${esc(L.pause)}` : `▶ ${esc(L.play)}`}</button>
<input type="range" min="0" max="${maxIdx}" value="${idx}" />
<span>${idx + 1}/${all.length}</span>
<label>${esc(L.speed)} <select class="spd">${[0.5, 1, 2, 4]
					.map((x) => `<option value="${x}"${x === replay.speed ? " selected" : ""}>${x}x</option>`)
					.join("")}</select></label>
<label class="skip"><input type="checkbox" class="skipcb"${replay.skipIdle ? " checked" : ""} /> ${esc(L.skipIdle)}</label>`,
			);
		}

		function kvRow(k: string, v: string): string {
			return `<dt>${esc(k)}</dt><dd>${v}</dd>`;
		}

		function renderDetail(): void {
			const L = t();
			const F = L.f;
			const c = convOf(selectedConvId ?? "");
			const seg = allSegs().find((s) => s.key === selectedKey) ?? null;
			const cached = seg ? detailCache.get(`${selectedConvId}\n${seg.key}`) : null;

			// Nothing selected: show the conversation-level analysis.
			if (!seg || !c) {
				if (!c?.analysis) {
					setMarkup(detailEl, `<div class="rtr-empty">${esc(c ? L.selectHint : L.emptyHint)}</div>`);
					return;
				}
				const a = c.analysis;
				const maxMs = Math.max(1, ...a.tools.map((x) => x.ms));
				setMarkup(
					detailEl,
					`
<h3 style="margin:0 0 8px">📊 ${esc(c.title || L.title)}</h3>
<dl class="rtr-kv">
${kvRow(F.total, esc(fmtDur(a.totalMs)))}${kvRow(F.turns, esc(String(a.turns)))}${kvRow(F.segs, esc(String(c.segCount)))}
${kvRow(F.toolCalls, esc(`${a.toolCalls} (${F.toolErr} ${a.toolErrs})`))}${kvRow(F.toolTime, esc(fmtDur(a.toolMs)))}
${kvRow(F.files, esc(a.filesChanged.length ? `${a.filesChanged.length}` : "—"))}
</dl>
<div class="rtr-sec">${esc(F.phase)} · 💬${a.counts.text} 💭${a.counts.thinking} 🔧${a.counts.tool} 📝${a.counts.file} 👤${a.counts.user}</div>
<div class="rtr-sec">${esc(F.slowest)}</div>
${
	a.tools
		.slice(0, 5)
		.map(
			(x) =>
				`<div style="font-size:12px">${esc(x.name)} · ${x.calls}x · ${esc(fmtDur(x.ms))}${x.errs ? ` · ❌${x.errs}` : ""}</div><div class="rtr-bar"><i style="width:${((x.ms / maxMs) * 100).toFixed(1)}%"></i></div>`,
		)
		.join("") || `<div style="opacity:.6;font-size:12px">—</div>`
}</div>
${a.filesChanged.length ? `<div class="rtr-sec">${esc(F.files)}</div><pre>${esc(a.filesChanged.slice(0, 20).join("\n"))}</pre>` : ""}`,
				);
				return;
			}

			// Something selected: the four tabs.
			const tabs = (["overview", "preview", "raw", "source"] as const)
				.map(
					(k) => `<button class="rtr-dtab${detailTab === k ? " on" : ""}" data-tab="${k}">${esc(L.tabs[k])}</button>`,
				)
				.join("");
			let body = "";
			if (!cached) {
				body = `<div class="rtr-empty"><span class="rtr-spin">⏳</span> ${esc(L.loading)}</div>`;
			} else if (detailTab === "overview") {
				const an: Partial<TraceSegAnalysis> = cached.analysis ?? {};
				const st = L.status[seg.status] ?? seg.status;
				body = `<dl class="rtr-kv">
${kvRow(F.source, esc(seg.source ?? "—"))}${kvRow(F.status, esc(st))}${kvRow(F.dur, esc(fmtDur(seg.dur)))}
${kvRow(F.turn, esc(an.turnText ?? (seg.turn ? `Turn ${seg.turn}` : "—")))}${kvRow(F.len, esc(seg.meta?.chars ? `${seg.meta.chars} chars` : `${(cached.detail ?? "").length} chars`))}${kvRow(F.pos, esc(an.position ?? "—"))}
</dl>`;
				const stat = an.tool;
				if (stat) {
					const avg = stat.calls ? stat.ms / stat.calls : 0;
					const share = an.convToolMs ? (100 * (stat.ms / an.convToolMs)).toFixed(0) : "0";
					body += `<div class="rtr-sec">📈 ${esc(stat.name)}</div><dl class="rtr-kv">
${kvRow(F.calls, esc(`${stat.calls} (${F.toolErr} ${stat.errs}, ${F.errRate} ${stat.calls ? Math.round((100 * stat.errs) / stat.calls) : 0}%)`))}
${kvRow(F.toolTime, esc(`${fmtDur(stat.ms)} · ${F.avg} ${fmtDur(avg)} · ${F.share} ${share}%`))}
</dl>`;
				}
				body += `<div class="rtr-sec">${esc(L.tabs.preview)}</div><pre>${esc((cached.detail ?? "").slice(0, 800))}</pre>`;
			} else if (detailTab === "preview") {
				body = `<pre>${esc((cached.detail ?? "").slice(0, 2000))}</pre>`;
			} else if (detailTab === "raw") {
				body = `<pre>${esc(cached.detail ?? "")}</pre><div style="height:10px"></div><button class="rtr-btn act-copy">📋 ${esc(L.copy)}</button>`;
			} else {
				const an: Partial<TraceSegAnalysis> = cached.analysis ?? {};
				body = `<dl class="rtr-kv">
${kvRow(F.msgKey, esc(seg.key))}${seg.meta?.toolCallId ? kvRow(F.toolCall, esc(seg.meta.toolCallId)) : ""}
${kvRow(F.turn, esc(an.turnText ?? (seg.turn ? `Turn ${seg.turn} of ${an.convTurns ?? "?"}` : "—")))}
${kvRow(F.conv, esc(`${c.title ?? ""} · ${String(c.id).slice(0, 8)}`))}${kvRow(F.time, esc(fmtClock(seg.t)))}
</dl>`;
			}
			setMarkup(
				detailEl,
				`<h3 style="margin:0 0 8px">${esc(seg.title)}</h3><div class="rtr-dtabs">${tabs}</div>${body}`,
			);
		}

		function scheduleRender(stick = true): void {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const keep = stick && !replay.on && listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
				renderConvs();
				renderRuler();
				renderLegend();
				renderList();
				if (pendingScroll) {
					const k = pendingScroll;
					pendingScroll = null;
					const q = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(k) : k;
					const row = listEl.querySelector(`[data-key="${q}"]`);
					if (row) row.scrollIntoView({ block: "nearest" });
				}
				renderDetail();
				if (keep) listEl.scrollTop = listEl.scrollHeight;
			});
		}

		function selectConv(id: string | null): void {
			selectedConvId = id;
			selectedKey = null;
			replay.on = false;
			stopPlay();
			followEnabled = true;
			applyLang();
			if (id && !segsCache.has(id)) ctx.send({ action: "get_conv", convId: id });
			scheduleRender(false);
		}

		function selectSeg(key: string | null, opts: { scroll?: boolean; force?: boolean } = {}): void {
			hideTip();
			if (key === selectedKey && !opts.force) {
				// Clicking the same segment again deselects it and returns to the
				// whole-conversation analysis.
				selectedKey = null;
				scheduleRender(false);
				return;
			}
			selectedKey = key;
			if (replay.on) {
				const i = visibleSegs().findIndex((s) => s.key === key);
				if (i >= 0) replay.idx = i;
			}
			const ck = `${selectedConvId}\n${key}`;
			if (key && !detailCache.has(ck) && !pendingSeg.has(ck)) {
				pendingSeg.add(ck);
				ctx.send({ action: "get_seg", convId: selectedConvId, key });
			}
			if (opts.scroll) pendingScroll = key;
			scheduleRender();
		}

		// ---- Replay engine (advances by real time, not by switching blocks on a timer) ----
		const REPLAY_PREFETCH = 12; // Segments prefetched ahead during playback, so detail is ready before a short block ends.
		function replayTrack(): ReplayTrack {
			return buildReplayTrack(visibleSegs(), replay.skipIdle);
		}
		function currentPos(track: ReplayTrack): number {
			if (!replay.playing) return replay.basePos;
			return Math.min(track.totalLen, replay.basePos + (performance.now() - replay.baseClock) * replay.speed);
		}
		/** The playhead line, overlaid on the vis timeline and positioned through the
		 *  current window. */
		function playheadShow(realMs: number): void {
			try {
				if (!tl) return;
				let el = tlDom().querySelector<HTMLElement>(".rtr-playhead");
				if (!el) {
					tlDom().style.position = "relative";
					el = document.createElement("div");
					el.className = "rtr-playhead";
					tlDom().appendChild(el);
				}
				const w = tl.getWindow?.();
				if (!w) return;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				const span = Math.max(1, (b || 0) - (a || 0));
				const dw = tlDrawWidth();
				const left = (tlDom().clientWidth || dw) - dw; // Width of the label column on the left.
				el.style.left = `${left + ((realMs - a) / span) * dw}px`;
				el.style.display = "block";
			} catch {
				/* no axis to draw on */
			}
		}
		function playheadHide(): void {
			const el = tlDom().querySelector<HTMLElement>(".rtr-playhead");
			if (el) el.style.display = "none";
		}
		/** Move the window along when the playhead leaves it (moveTo keeps the zoom level
		 *  and only pans). */
		function ensurePlayheadVisible(realMs: number): void {
			try {
				if (!tl) return;
				const w = tl.getWindow?.();
				if (!w) return;
				const a = w.start instanceof Date ? w.start.getTime() : Number(w.start);
				const b = w.end instanceof Date ? w.end.getTime() : Number(w.end);
				const margin = (b - a) * 0.08;
				if (realMs < a + margin || realMs > b - margin) tl.moveTo(realMs, { animation: false });
			} catch {
				/* no axis to move */
			}
		}
		/** Refresh the playhead for the current playback position (when following, the
		 *  window moves with it once it goes out of view). */
		function refreshPlayhead(follow: boolean): void {
			const tr = replayTrack();
			if (!tr.segs.length) {
				playheadHide();
				return;
			}
			const pos = currentPos(tr);
			const idx = activeIndexAt(tr, pos);
			const rt = realTimeAt(tr, pos, idx);
			playheadShow(rt);
			if (follow) ensurePlayheadVisible(rt);
		}
		function stopPlay(): void {
			if (replay.playing) {
				// Remember where playback paused, so it resumes from there.
				const tr = replayTrack();
				if (tr.segs.length) replay.basePos = currentPos(tr);
			}
			replay.playing = false;
			if (replay.raf) cancelAnimationFrame(replay.raf);
			replay.raf = 0;
		}
		function startPlay(): void {
			stopPlay();
			const tr = replayTrack();
			if (!tr.segs.length) return;
			replay.basePos = Math.max(0, Math.min(tr.totalLen, replay.basePos));
			replay.baseClock = performance.now();
			replay.playing = true;
			replay.raf = requestAnimationFrame(replayTick);
		}
		function replayTick(): void {
			if (!replay.playing) return;
			const tr = replayTrack();
			if (!tr.segs.length) {
				stopPlay();
				return;
			}
			const pos = currentPos(tr);
			const idx = activeIndexAt(tr, pos);
			if (idx >= 0) {
				replay.idx = idx;
				const key = tr.segs[idx]?.seg.key ?? null;
				if (key !== selectedKey && key !== null) {
					selectedKey = key;
					pendingScroll = key; // The list follows the active row, so the bottom keeps moving during playback.
					scheduleRender();
				}
				// Prefetch the detail of the segments coming up, so even a block lasting a
				// few tens of milliseconds has its detail cached the moment it is entered
				// and the pane is not switched away from under the user.
				const end = Math.min(tr.segs.length, idx + REPLAY_PREFETCH);
				for (let k = idx; k < end; k++) {
					const kk = tr.segs[k]?.seg.key;
					const ck = `${selectedConvId}\n${kk}`;
					if (kk && !detailCache.has(ck) && !pendingSeg.has(ck)) {
						pendingSeg.add(ck);
						ctx.send({ action: "get_seg", convId: selectedConvId, key: kk });
					}
				}
			}
			const rt = realTimeAt(tr, pos, idx);
			playheadShow(rt);
			ensurePlayheadVisible(rt);
			if (pos >= tr.totalLen) {
				// Finished: stay on the last segment and keep the playhead where it is.
				stopPlay();
				scheduleRender();
				return;
			}
			replay.raf = requestAnimationFrame(replayTick);
		}

		// ---- Events ----
		convsEl.addEventListener("click", (e) => {
			const b = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
			if (b) selectConv(b.dataset.id ?? null);
		});
		rulerEl.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			const followBtn = target.closest<HTMLElement>(".act-follow");
			if (followBtn) {
				followEnabled = !followEnabled;
				followBtn.classList.toggle("on", followEnabled);
				flowSync(); // Turning it on enters flow mode at once: the window re-anchors "now" at the current span.
				return;
			}
			if (target.closest(".act-fit")) {
				try {
					flowStop();
					tl?.fit({ animation: true });
					flowSpanSeen = flowWin()?.span ?? 0;
					// "Show everything" is an explicit request for the overview, so following
					// is paused (press Follow to go back to it).
					followEnabled = false;
					rulerEl.querySelector(".act-follow")?.classList.remove("on");
				} catch {
					/* no axis to fit */
				}
				return;
			}
			if (tl) return; // The professional timeline handles selection itself.
			const body = rulerEl.querySelector(".rtr-tlbody");
			const b = target.closest<HTMLElement>("[data-i]");
			const drawn = body ? fallbackSegs.get(body) : undefined;
			if (b && drawn) {
				const s = drawn[Number(b.dataset.i)];
				if (s) selectSeg(s.key, { scroll: true });
			}
		});
		listEl.addEventListener("click", (e) => {
			const b = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
			if (b) selectSeg(b.dataset.key ?? null, { scroll: true });
		});
		detailEl.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			const tab = target.closest<HTMLElement>("[data-tab]");
			if (tab) {
				detailTab = tab.dataset.tab ?? "overview";
				scheduleRender();
				return;
			}
			if (target.closest(".act-copy")) {
				const cached = detailCache.get(`${selectedConvId}\n${selectedKey}`);
				const txt = cached ? `${cached.seg?.title ?? ""}\n${cached.detail}` : "";
				if (txt) {
					void navigator.clipboard?.writeText(txt).then(
						() => {
							target.textContent = `✅ ${t().copied}`;
							setTimeout(scheduleRender, 1200);
						},
						() => {},
					);
				}
			}
		});
		qEl.addEventListener("input", () => {
			search = qEl.value;
			scheduleRender();
		});
		replayBtn.addEventListener("click", () => {
			if (!selectedConvId) return;
			replay.on = !replay.on;
			stopPlay();
			if (replay.on) {
				replay.idx = 0;
				replay.basePos = 0;
				selectedKey = null;
				const tr = replayTrack();
				const first = tr.segs[0];
				if (first) {
					selectedKey = first.seg.key;
					playheadShow(first.seg.t);
					selectSeg(first.seg.key, { force: true });
				}
			} else {
				playheadHide();
				// After leaving replay, resume following if the conversation is still
				// running (the newest moment returns to 40px from the right edge).
				followEnabled = true;
			}
			applyLang();
			scheduleRender(false);
		});
		replayBar.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".act-play")) {
				if (replay.playing) stopPlay();
				else startPlay();
				scheduleRender();
			}
		});
		replayBar.addEventListener("input", (e) => {
			const target = e.target as HTMLInputElement;
			if (target.matches('input[type="range"]')) {
				stopPlay();
				const tr = replayTrack();
				const i = Number(target.value);
				replay.idx = i;
				const it = tr.segs[i];
				replay.basePos = it ? it.p0 : 0;
				selectedKey = it ? it.seg.key : null;
				if (it) playheadShow(it.seg.t);
				scheduleRender();
			}
		});
		replayBar.addEventListener("change", (e) => {
			const target = e.target as HTMLInputElement;
			if (target.matches(".spd")) {
				replay.speed = Number(target.value);
				if (replay.playing) startPlay();
			} else if (target.matches(".skipcb")) {
				replay.skipIdle = target.checked;
				// Toggling skip-idle changes the coordinate basis, so playback continues
				// from the currently active segment.
				const tr = replayTrack();
				const cur = selectedKey ? tr.segs.findIndex((x) => x.seg.key === selectedKey) : -1;
				if (cur >= 0) {
					replay.idx = cur;
					replay.basePos = tr.segs[cur]?.p0 ?? 0;
				}
				if (replay.playing) startPlay();
				refreshPlayhead(false);
				scheduleRender();
			}
		});
		clearBtn.addEventListener("click", () => {
			if (window.confirm(t().confirmClear)) ctx.send({ action: "clear" });
		});

		const off = ctx.onData((raw) => {
			if (!raw || typeof raw !== "object") return;
			const p = raw as TracePayload;
			switch (p.kind) {
				case "state": {
					convs = Array.isArray(p.conversations) ? p.conversations : [];
					const prevActive = lastActiveId;
					activeId = p.activeId ?? null;
					lastActiveId = activeId;
					// A change of active conversation (switching, a new one, the first load)
					// means follow it; when active has not changed, do nothing - the user may
					// be reading history, and being dragged away by a repeated state push is
					// annoying.
					if (
						activeId &&
						activeId !== selectedConvId &&
						(activeId !== prevActive || !convs.some((c) => c.id === selectedConvId))
					) {
						selectConv(activeId);
						return;
					}
					scheduleRender();
					break;
				}
				case "conv_new": {
					const conv = p.conv;
					if (conv && !convs.some((c) => c.id === conv.id)) convs.unshift(conv);
					if (!selectedConvId && conv) selectConv(conv.id);
					else scheduleRender();
					break;
				}
				case "conv_update": {
					const conv = p.conv;
					if (conv) {
						const i = convs.findIndex((c) => c.id === conv.id);
						if (i >= 0) convs[i] = conv;
						else convs.unshift(conv);
						// Self-healing for a missed state push: follow only when active moves
						// to a different conversation (the id is a new active one); a routine
						// update of the same active conversation is left alone, so reading
						// history is not disturbed.
						if (conv.active) {
							activeId = conv.id;
							if (conv.id !== selectedConvId && conv.id !== lastActiveId) {
								lastActiveId = conv.id;
								selectConv(conv.id);
								return;
							}
							lastActiveId = conv.id;
						}
					}
					scheduleRender();
					break;
				}
				case "segs": {
					const incoming = p.segs;
					if (!p.convId || !Array.isArray(incoming)) break;
					const known = segsCache.get(p.convId);
					if (p.reset || !known) segsCache.set(p.convId, [...incoming]);
					else known.push(...incoming);
					if (p.convId === selectedConvId && !selectedKey && incoming.length && !replay.on) {
						const last = incoming[incoming.length - 1];
						selectedKey = last?.key ?? null;
						selectSeg(selectedKey, { force: true });
						return;
					}
					scheduleRender();
					break;
				}
				case "seg_update": {
					const arr = segsCache.get(p.convId ?? "");
					const s = arr?.find((x) => x.key === p.key);
					if (s && p.patch) Object.assign(s, p.patch);
					scheduleRender();
					break;
				}
				case "seg_detail":
					if (p.key) {
						const ck = `${p.convId}\n${p.key}`;
						pendingSeg.delete(ck);
						detailCache.set(ck, { detail: String(p.detail ?? ""), seg: p.seg, analysis: p.analysis });
						if (p.convId === selectedConvId && p.key === selectedKey) scheduleRender(false);
					}
					break;
				case "cleared":
					convs = [];
					segsCache.clear();
					detailCache.clear();
					pendingSeg.clear();
					selectedConvId = null;
					selectedKey = null;
					activeId = null;
					lastActiveId = null;
					replay.on = false;
					stopPlay();
					playheadHide();
					applyLang();
					scheduleRender(false);
					break;
				default:
					break;
			}
		});

		// A resize of the container (the view being shown or hidden, a sidebar being
		// dragged, the window being resized) triggers a reflow, so an axis built while
		// hidden is rebuilt automatically.
		try {
			const roBody = rulerEl.querySelector(".rtr-tlbody");
			if (roBody && typeof ResizeObserver !== "undefined") {
				tlRO = new ResizeObserver(() => {
					if (roTimer) return;
					roTimer = setTimeout(() => {
						roTimer = 0;
						scheduleRender(false);
					}, 150);
				});
				tlRO.observe(roBody);
			}
		} catch {
			/* no ResizeObserver in this browser */
		}

		applyLang();
		scheduleRender(false);
		ctx.send({ action: "state" });

		// Flow mode is driven by the rAF loop (pushed to now every frame); when not
		// flowing, a 1s heartbeat stretches the running blocks.
		const liveTicker = setInterval(() => {
			try {
				if (!tl || replay.on) return;
				flowSync();
				if (!flowing && visibleSegs().some((s) => s.status === "running")) syncDisplayEnds();
			} catch {
				/* ignore */
			}
		}, 1000);

		return () => {
			stopPlay();
			flowStop();
			clearInterval(liveTicker);
			if (raf) cancelAnimationFrame(raf);
			if (epsRaf) cancelAnimationFrame(epsRaf);
			if (roTimer) clearTimeout(roTimer);
			try {
				tlRO?.disconnect();
			} catch {
				/* already disconnected */
			}
			tlRO = null;
			destroyTl();
			off();
			container.replaceChildren();
		};
	},
};

export default clientEntry;

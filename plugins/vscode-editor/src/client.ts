/**
 * vscode-editor client view - a lightweight VSCode-like editor plus Remote-SSH.
 *
 * Stack: CodeMirror 6 (editor) + xterm.js (remote terminal), bundled into this file by
 * esbuild, so there are no runtime external dependencies. Layout: multi-root file tree on
 * the left (local workspace + SSH hosts) + tabbed editor area on the right + draggable
 * terminal panel at the bottom; Ctrl+P quick open (local), Ctrl+S save (local/remote).
 *
 * Scope model: scope = "local" | connId. File tree nodes and tabs both carry a scope,
 * and every file operation (list/read/write/create/rename/delete) goes through req(),
 * which attaches connId automatically - the server uses it to route to the local fs or
 * to that connection's SFTP, so the client and the server share one code path.
 *
 * Protocol with the server (index.mjs): { action, reqId, ... } upstream,
 * { res:true, reqId, ok, ... } responses (reqId matches concurrent calls); shell_data /
 * shell_exit / conn_closed / sync_progress are pushed as targeted events; kind:"state"
 * broadcasts host state and kind:"workspace" broadcasts a workspace switch (the main
 * app's set_cwd).
 */
import {
	EditorView,
	keymap,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	drawSelection,
	rectangularSelection,
	crosshairCursor,
	dropCursor,
	highlightSpecialChars,
} from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
	syntaxHighlighting,
	defaultHighlightStyle,
} from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type {
	DirEntry,
	DropTarget,
	HostFormValues,
	HostInfo,
	HostSavePayload,
	MenuItem,
	PublicSyncConfig,
	SaveFilePickerWindow,
	SelNode,
	ServerMessage,
	SshState,
	SyncFormValues,
	SyncSavePayload,
	TabState,
	TermState,
	ViewContext,
} from "./client-types.ts";

/** HTML-escape a value that is about to be interpolated into a markup fragment. */
export function esc(s: unknown): string {
	const escapes: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	};
	return String(s ?? "").replace(/[&<>"']/g, (c) => escapes[c]);
}

let reqSeq = 0;

/** base64 helpers for the terminal's byte stream (the wire format is base64). */
export const b64 = {
	enc: (s: string): string => btoa(unescape(encodeURIComponent(s))),
	bytes: (b64s: string): Uint8Array => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0)),
};

/** POSIX shell single-quote escaping (for cd into a path containing spaces/quotes). */
export const shQuote = (s: unknown): string => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

// ---- Light theme support -------------------------------------------------------------
// After the main app switches theme it dispatches pi-web-ui:theme-change on window (see
// web/src/theme.ts); this plugin listens for it and switches CodeMirror and xterm to the
// matching light/dark look. Light vs dark is decided by reading color-scheme on
// documentElement - light theme files all declare `color-scheme: light`, while the dark
// default declares nothing (computed as normal) and is treated as dark.
export const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";
export function isLightTheme(): boolean {
	try {
		return getComputedStyle(document.documentElement).getPropertyValue("color-scheme").trim().startsWith("light");
	} catch {
		return false;
	}
}
/** --term-* palette -> xterm theme (same source as the main app's buildTermTheme, see web/src/theme.ts). */
export function buildTermTheme(): ITheme {
	let cs: CSSStyleDeclaration | null = null;
	try {
		cs = getComputedStyle(document.documentElement);
	} catch {
		cs = null;
	}
	const v = (name: string, fallback: string): string => {
		try {
			const val = cs?.getPropertyValue(name).trim();
			return val || fallback;
		} catch {
			return fallback;
		}
	};
	return {
		background: v("--term-bg", "#0b0d12"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", "#8b5cf6"),
		cursorAccent: v("--term-cursor-accent", "#0b0d12"),
		selectionBackground: v("--term-selection", "rgba(139, 92, 246, 0.35)"),
		black: v("--term-black", "#1a1d26"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}
/** Light CodeMirror shell: follows --bg/--text/--accent; syntax colours keep the bundled
 *  defaultHighlightStyle (designed for a light background, and always present in
 *  makeExtensions). */
const cmLight = EditorView.theme(
	{
		"&": { backgroundColor: "var(--bg, #ffffff)", color: "var(--text, #1f2328)" },
		".cm-content": { caretColor: "var(--accent, #0969da)" },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent, #0969da)" },
		".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 8%, transparent)" },
		".cm-activeLineGutter": { backgroundColor: "transparent" },
		".cm-gutters": {
			backgroundColor: "var(--bg, #ffffff)",
			color: "var(--text-faint, #818b98)",
			borderRight: "1px solid var(--border, #d0d7de)",
		},
		".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 18%, transparent)" },
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
			backgroundColor: "color-mix(in srgb, var(--accent, #0969da) 22%, transparent)",
		},
	},
	{ dark: false },
);

// ---- Language detection --------------------------------------------------------------

const LANGS: [RegExp, () => Extension][] = [
	[/\.(jsx?|mjs|cjs)$/, () => javascript()],
	[/\.tsx?$/, () => javascript({ typescript: true })],
	[/\.json5?$/, () => json()],
	[/\.css$/, () => css()],
	[/\.(html?|vue|svelte)$/, () => html()],
	[/\.(md|markdown)$/, () => markdown()],
	[/\.py$/, () => python()],
];

export function langFor(path: string): Extension | null {
	const p = path.toLowerCase();
	for (const [re, make] of LANGS) if (re.test(p)) return make();
	return null;
}

export function langName(path: string): string {
	if (/\.tsx?$/.test(path)) return "TypeScript";
	if (/\.(jsx?|mjs|cjs)$/.test(path)) return "JavaScript";
	if (/\.json5?$/.test(path)) return "JSON";
	if (path.endsWith(".css")) return "CSS";
	if (/\.(html?|vue|svelte)$/.test(path)) return "HTML";
	if (/\.(md|markdown)$/.test(path)) return "Markdown";
	if (path.endsWith(".py")) return "Python";
	return "Plain Text";
}

// ---- File icons ----------------------------------------------------------------------

export function iconFor(name: string, type: string): string {
	if (type === "dir") return "📁";
	const ext = ((name.match(/\.([^.]+)$/) ?? [, ""])[1] ?? "").toLowerCase();
	const map: Record<string, string> = {
		js: "🟨",
		mjs: "🟨",
		cjs: "🟨",
		jsx: "⚛️",
		ts: "🟦",
		tsx: "⚛️",
		json: "🔧",
		md: "📝",
		css: "🎨",
		html: "🌐",
		py: "🐍",
		png: "🖼",
		jpg: "🖼",
		jpeg: "🖼",
		gif: "🖼",
		webp: "🖼",
		svg: "🖼",
		lock: "🔒",
		yml: "⚙️",
		yaml: "⚙️",
		toml: "⚙️",
		sh: "💻",
		bat: "💻",
	};
	return map[ext] || "📄";
}

// ---- Fuzzy matching (for quick open, Ctrl+P): returns a score or -1 --------------------

export function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0,
		score = 0,
		streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			streak++;
			score += 1 + streak; // consecutive hits are weighted higher
			qi++;
		} else streak = 0;
	}
	if (qi < q.length) return -1;
	// Bonus for short file names / early hits
	score += Math.max(0, 40 - t.length) / 10;
	return score;
}

// ---- Tab keys and wire paths ------------------------------------------------------------

/** Key for a tab or a directory-cache entry: "scope:path". */
export function tkey(scope: string, p: string): string {
	return `${scope}:${p}`;
}

/** Inverse of tkey(): splits at the first colon, so a path may itself contain colons. */
export function parseTk(k: string): { scope: string; path: string } {
	const i = k.indexOf(":");
	return { scope: k.slice(0, i), path: k.slice(i + 1) };
}

/** Parent directory of a remote path, clamped at the filesystem root. */
export function parentOf(dir: string): string {
	if (!dir || dir === "/" || dir === ".") return "/";
	const s = dir.replace(/\/$/, "");
	const idx = s.lastIndexOf("/");
	return idx <= 0 ? "/" : s.slice(0, idx);
}

/** Parent directory of a local file (unlike parentOf: a root-level file returns "" instead of "/"). */
export function localParentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i <= 0 ? "" : p.slice(0, i);
}

/** Uint8Array -> base64 (btoa only accepts a latin1 string, so build it in batches to avoid blowing the stack). */
export function bufToB64(u8: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < u8.length; i += 0x8000) {
		bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}

/** The home directory a remote `pwd` reported, or null when its output is not an absolute path. */
export function homeFromPwdOutput(output: string | undefined): string | null {
	const home = (output ?? "").trim().split(/\r?\n/).pop()?.trim();
	return home && home.startsWith("/") ? home : null;
}

// ---- Modal form payloads -----------------------------------------------------------------

/** Parse the comma separated exclude field of the sync modal. */
export function parseExcludeList(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Build the hosts_save payload from the host modal's raw input values. */
export function hostPayloadFrom(v: HostFormValues): HostSavePayload {
	return {
		name: v.name.trim(),
		host: v.host.trim(),
		port: Number(v.port) || 22,
		username: v.username.trim() || "root",
		// A blank secret is sent as undefined so the server keeps the stored one.
		password: v.password || undefined,
		privateKey: v.privateKey.trim() || undefined,
		passphrase: v.passphrase || undefined,
		// Path and agent are not secrets: an empty string clears them.
		privateKeyPath: v.privateKeyPath.trim(),
		agent: v.agent.trim(),
	};
}

/** Build the sync_save payload from the sync modal's raw input values. */
export function syncPayloadFrom(v: SyncFormValues): SyncSavePayload {
	return {
		name: v.name.trim(),
		host: v.host.trim(),
		port: Number(v.port) || 22,
		username: v.username.trim() || "root",
		password: v.password || undefined,
		privateKey: v.privateKey.trim() || undefined,
		privateKeyPath: v.privateKeyPath.trim(),
		agent: v.agent.trim(),
		remoteRoot: v.remoteRoot.trim(),
		exclude: parseExcludeList(v.exclude),
		uploadOnSave: v.uploadOnSave,
	};
}

/** Return a matching element only when an event target can be an Element. */
export function closestFromEventTarget<T extends Element>(target: EventTarget | null, selector: string): T | null {
	return typeof Element !== "undefined" && target instanceof Element ? target.closest<T>(selector) : null;
}

function requiredQuery<T extends Element>(parent: ParentNode, selector: string): T {
	const element = parent.querySelector<T>(selector);
	if (!element) throw new Error(`Missing required element: ${selector}`);
	return element;
}

function setMarkup(element: Element, markup: string): void {
	if (typeof document.createRange !== "function" || typeof element.replaceChildren !== "function") {
		element.textContent = markup;
		return;
	}
	const range = document.createRange();
	range.selectNodeContents(element);
	element.replaceChildren(range.createContextualFragment(markup));
}

function reportUiError(err: unknown): void {
	console.debug("[plugin:vscode-editor] best-effort UI operation failed", err);
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		setMarkup(
			container,
			`
<div class="vsc">
	<style>${xtermCss}</style>
	<style>
		.vsc { position: relative; display: flex; height: 100%; min-height: 480px;
			overflow: hidden;
			background: var(--bg, #101016); color: var(--text, #e6e6ef); font-size: 13px; }
		/* ---- Multi-root file tree on the left ---- */
		.vsc-side { width: 240px; min-width: 160px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
		.vsc-side-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px 6px;
			font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.vsc-side-head b { flex: 1; font-weight: 600; }
		.vsc-side-head button { all: unset; cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
		.vsc-side-head button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- Two sidebar tabs: Files / SSH ---- */
		.vsc-stabs { display: flex; gap: 4px; padding: 6px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
		.vsc-stabs .stab { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12.5px; opacity: .65; }
		.vsc-stabs .stab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent);
			opacity: 1; font-weight: 600; }
		.vsc-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.vsc-hosts { flex-shrink: 0; max-height: 32%; overflow: auto; padding: 2px 0 6px; user-select: none; }
		.vsc-sshtree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 12px; user-select: none;
			border-top: 1px solid var(--border, #333); }
		.vsc-sect .cwd { opacity: .45; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; margin-left: 6px; direction: rtl; }
		.vsc-tree { flex: 1; overflow: auto; padding: 2px 0 12px; user-select: none; }
		.vsc-row { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			white-space: nowrap; line-height: 1.7; }
		.vsc-row:hover { background: var(--bg-elev2, #20202b); }
		.vsc-row.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		/* Selected state (distinct from the active open file): shows where a toolbar "new" lands */
		.vsc-row.sel { background: color-mix(in srgb, var(--accent, #7c5cff) 12%, transparent);
			box-shadow: inset 2px 0 0 var(--accent, #7c5cff); }
		.vsc-row.loading { opacity: .45; }
		/* Drag-and-drop upload target highlight */
		.vsc-row.drop-target { outline: 1px dashed var(--accent, #7c5cff); outline-offset: -2px;
			background: color-mix(in srgb, var(--accent, #7c5cff) 16%, transparent); }
		.vsc-tree.drop-root, .vsc-sshtree.drop-root { outline: 2px dashed var(--accent, #7c5cff); outline-offset: -2px; }
		.vsc-status .vsc-up { color: var(--amber, #fbbf24); }
		.vsc-row .caret { width: 12px; text-align: center; opacity: .55; font-size: 9px; flex-shrink: 0; }
		.vsc-row .nm { overflow: hidden; text-overflow: ellipsis; }
		.vsc-sect { display: flex; align-items: center; gap: 4px; padding: 8px 8px 3px;
			font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; opacity: .75; }
		.vsc-sect b { flex: 1; font-weight: 600; }
		.vsc-sect button { all: unset; cursor: pointer; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
		.vsc-sect button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-hrow .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
			background: var(--text-dim, #666); }
		.vsc-hrow .dot.on { background: var(--green, #4ade80); box-shadow: 0 0 6px var(--green, #4ade80); }
		.vsc-hrow .dot.busy { background: var(--amber, #fbbf24); animation: vscpulse 1s infinite alternate; }
		@keyframes vscpulse { from { opacity: .4 } to { opacity: 1 } }
		.vsc-hrow .ops { display: none; gap: 2px; margin-left: auto; }
		.vsc-hrow:hover .ops { display: flex; }
		.vsc-hrow .ops button { all: unset; cursor: pointer; padding: 0 4px; border-radius: 4px; font-size: 11px; opacity: .7; }
		.vsc-hrow .ops button:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
		.vsc-deps { padding: 4px 10px; }
		.vsc-deps button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 4px 8px; border-radius: 5px; font-size: 11.5px; color: var(--amber, #fbbf24); }
		.vsc-deps button:hover { background: var(--bg-elev2, #20202b); }
		/* ---- Main area on the right ---- */
		.vsc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
		.vsc-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev, #16161d); scrollbar-width: thin; }
		.vsc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px;
			cursor: pointer; border-right: 1px solid var(--border, #333); white-space: nowrap;
			color: var(--text-dim, #9a9ab0); max-width: 200px; }
		.vsc-tab.active { background: var(--bg, #101016); color: var(--text, #e6e6ef);
			box-shadow: inset 0 2px 0 var(--accent, #7c5cff); }
		.vsc-tab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-tab .dot { color: var(--amber, #fbbf24); }
		.vsc-tab .x { all: unset; cursor: pointer; padding: 0 3px; border-radius: 4px; opacity: .55; }
		.vsc-tab .x:hover { opacity: 1; background: var(--bg-elev2, #20202b); }
		.vsc-edwrap { flex: 1; min-height: 0; position: relative; }
		.vsc-empty { position: absolute; inset: 0; display: grid; place-items: center;
			opacity: .45; text-align: center; line-height: 2; }
		.vsc-editor { height: 100%; }
		.vsc-editor .cm-editor { height: 100%; }
		.vsc-editor .cm-scroller { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
		/* ---- Bottom terminal panel ---- */
		.vsc-termdrag { height: 4px; cursor: row-resize; flex-shrink: 0;
			background: var(--bg-elev, #16161d); border-top: 1px solid var(--border, #333); }
		.vsc-termdrag:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 35%, transparent); }
		.vsc-termpanel { height: 240px; min-height: 80px; display: flex; flex-direction: column;
			flex-shrink: 0; background: var(--term-bg, #101016); }
		.vsc-termbar { display: flex; align-items: center; gap: 4px; padding: 3px 8px;
			border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
			font-size: 11.5px; user-select: none; }
		.vsc-termbar .tt { opacity: .6; text-transform: uppercase; letter-spacing: .06em; font-size: 10.5px; margin-right: 4px; }
		.vsc-termbar .grow { flex: 1; }
		.vsc-termbar button { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 5px; font-size: 12px; }
		.vsc-termbar button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-ttab { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			border-radius: 5px; color: var(--text-dim, #9a9ab0); white-space: nowrap; max-width: 180px; }
		.vsc-ttab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); color: var(--text, #e6e6ef); }
		.vsc-ttab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-ttab .x { all: unset; cursor: pointer; opacity: .5; font-size: 10px; padding: 0 2px; }
		.vsc-ttab .x:hover { opacity: 1; }
		.vsc-termarea { flex: 1; min-height: 0; position: relative; padding: 4px 6px; }
		.vsc-term { position: absolute; inset: 4px 6px; }
		.vsc-term .xterm { height: 100%; }
		/* ---- Status bar ---- */
		.vsc-status { display: flex; align-items: center; gap: 14px; padding: 4px 12px;
			border-top: 1px solid var(--border, #333); background: var(--bg-elev, #16161d);
			font-size: 11.5px; color: var(--text-dim, #9a9ab0); }
		.vsc-status .grow { flex: 1; }
		.vsc-status .dirty { color: var(--amber, #fbbf24); }
		.vsc-status .remote { color: var(--green, #4ade80); }
		.vsc-err { color: var(--red, #f87171); }
		/* Quick open overlay */
		.vsc-quickopen { position: absolute; left: 50%; top: 40px; transform: translateX(-50%);
			width: min(520px, 80%); z-index: 30; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 10px;
			box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
		.vsc-quickopen input { width: 100%; box-sizing: border-box; background: transparent; color: inherit;
			border: 0; outline: 0; padding: 10px 14px; font: inherit; border-bottom: 1px solid var(--border, #333); }
		.vsc-quickopen ul { list-style: none; margin: 0; padding: 4px 0; max-height: 300px; overflow: auto; }
		.vsc-quickopen li { padding: 5px 14px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
		.vsc-quickopen li.sel, .vsc-quickopen li:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); }
		.vsc-quickopen li small { opacity: .5; margin-left: auto; direction: rtl; }
		.vsc-hidden { display: none !important; }
		/* Tree context menu / sync menu */
		.vsc-menu { position: absolute; z-index: 40; min-width: 150px; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 8px; padding: 4px;
			box-shadow: 0 10px 30px rgba(0,0,0,.4); }
		.vsc-menu button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 5px 10px; border-radius: 5px; font: inherit; }
		.vsc-menu button:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 30%, transparent); }
		.vsc-menu button.dim { opacity: .55; }
		/* Sync progress floating bar */
		.vsc-sync-status { position: absolute; right: 14px; bottom: 44px; z-index: 25; max-width: 70%;
			background: var(--bg-elev2, #20202b); border: 1px solid var(--accent, #7c5cff); border-radius: 8px;
			padding: 6px 12px; font-size: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
		/* Modal (shared styling for the host form and the sync configuration) */
		.vsc-modal-bg { position: absolute; inset: 0; z-index: 50; background: rgba(0,0,0,.45);
			display: grid; place-items: center; }
		.vsc-modal { width: min(430px, 90%); max-height: 94%; overflow: auto; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 12px; padding: 16px 18px; }
		.vsc-modal h3 { margin: 0 0 10px; }
		.vsc-modal label { display: block; font-size: 11.5px; opacity: .7; margin: 9px 0 3px; }
		.vsc-modal input, .vsc-modal textarea { width: 100%; box-sizing: border-box; background: var(--bg, #101016);
			color: inherit; border: 1px solid var(--border, #444); border-radius: 6px; padding: 6px 9px; font: inherit; }
		.vsc-modal textarea { font: 12px ui-monospace, monospace; resize: vertical; }
		.vsc-modal .grid2 { display: grid; grid-template-columns: 1fr 100px; gap: 8px; }
		.vsc-modal .hint { font-size: 11px; opacity: .5; margin-top: 8px; line-height: 1.6; }
		.vsc-modal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
		.vsc-modal .btns button { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 7px; font-size: 13px;
			border: 1px solid var(--border, #444); }
		.vsc-modal .btns button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.vsc-modal .btns button:hover { filter: brightness(1.15); }
		/* ---- Narrow phone screens (<=640px): no change on desktop ---- */
		.vsc-mobilebar { display: none; }
		.vsc-backdrop { display: none; }
		@media (max-width: 640px) {
			/* Main area top bar: narrow-screen toolbar (burger + title), hidden on desktop */
			.vsc-mobilebar { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
				border-bottom: 1px solid var(--border, #333); background: var(--bg-elev, #16161d); }
			.vsc-mobilebar .vsc-burger { all: unset; cursor: pointer; font-size: 18px;
				padding: 6px 10px; border-radius: 6px; line-height: 1; }
			.vsc-mobilebar .vsc-burger:hover { background: var(--bg-elev2, #20202b); }
			.vsc-mobilebar .vsc-mtitle { flex: 1; overflow: hidden; text-overflow: ellipsis;
				white-space: nowrap; font-size: 12px; opacity: .7; }
			/* The sidebar becomes an overlay drawer on the left */
			.vsc-side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 35;
				width: min(280px, 82vw); max-width: 82vw;
				transform: translateX(-105%); transition: transform .22s ease; }
			.vsc.drawer-open .vsc-side { transform: none;
				box-shadow: 8px 0 28px rgba(0,0,0,.5); }
			.vsc.drawer-open .vsc-backdrop { display: block; position: absolute; inset: 0; z-index: 30;
				background: rgba(0,0,0,.45); }
			/* Bottom terminal panel: full width, bounded height, never squeezes the editor away */
			.vsc-termpanel { width: 100%; max-height: 45dvh; }
			.vsc-termbar { min-height: 40px; }
			/* Tabs scroll sideways + larger touch targets */
			.vsc-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
			.vsc-tab { padding: 8px 8px 8px 12px; }
			.vsc-tab .x { padding: 6px 8px; font-size: 13px; }
			.vsc-hrow .ops button { padding: 6px 8px; font-size: 12px; }
			.vsc-side-head button, .vsc-sect button, .vsc-termbar button { padding: 5px 9px; }
			/* iOS focus zoom: bump form font-size to 16px (the CodeMirror editing area is untouched) */
			.vsc-quickopen input, .vsc-modal input, .vsc-modal select, .vsc-modal textarea { font-size: 16px; }
			.vsc-modal .grid2 { grid-template-columns: 1fr; }
			.vsc-modal { width: min(430px, 94%); }
			.vsc-quickopen { width: min(520px, 94%); }
			.vsc-status { gap: 8px; overflow-x: auto; white-space: nowrap; }
			.vsc-status .vsc-path { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
		}
		/* Touch screens have no hover: row action buttons stay visible */
		@media (hover: none) {
			.vsc-hrow .ops { display: flex; }
		}
	</style>
	<div class="vsc-side">
		<div class="vsc-stabs">
			<button class="stab active" data-pane="files">📁 Files</button>
			<button class="stab" data-pane="ssh">🖥 SSH</button>
		</div>
		<div class="vsc-pane" data-pane="files">
			<div class="vsc-side-head">
				<b>Explorer</b>
				<button data-act="new-file" title="New file (in the currently selected directory)">+📄</button>
				<button data-act="new-dir" title="New folder (in the currently selected directory)">+📁</button>
				<button data-act="upload" title="Upload files to the workspace root (or drag them onto the file tree)">⬆</button>
				<button data-act="sync-menu" title="Sync to server (SFTP)">☁</button>
				<button data-act="refresh" title="Refresh">⟳</button>
			</div>
			<div class="vsc-tree"></div>
		</div>
		<div class="vsc-pane vsc-hidden" data-pane="ssh">
			<div class="vsc-side-head">
				<b>SSH Hosts</b>
				<button data-act="add-host" title="Add host">+</button>
				<button data-act="deps" class="vsc-hidden" title="Install the ssh2 dependency">⚠ssh2</button>
				<button data-act="new-term" title="New remote terminal">🖥</button>
				<button data-act="r-new-file" title="New file (in the currently selected directory)">+📄</button>
				<button data-act="r-new-dir" title="New folder (in the currently selected directory)">+📁</button>
				<button data-act="r-upload" title="Upload files to the currently selected directory">⬆</button>
				<button data-act="r-refresh" title="Refresh the remote directory">⟳</button>
			</div>
			<div class="vsc-hosts"></div>
			<div class="vsc-sshtree"></div>
		</div>
	</div>
	<div class="vsc-backdrop"></div>
	<div class="vsc-main">
		<div class="vsc-mobilebar">
			<button class="vsc-burger" title="File tree">☰</button>
			<span class="vsc-mtitle">Files</span>
		</div>
		<div class="vsc-tabs"></div>
		<div class="vsc-edwrap">
			<div class="vsc-empty">Open a file from the left to start editing<br><small>Ctrl+P quick open · Ctrl+S save · add an SSH host with + on the left</small></div>
			<div class="vsc-editor vsc-hidden"></div>
		</div>
		<div class="vsc-termdrag vsc-hidden"></div>
		<div class="vsc-termpanel vsc-hidden">
			<div class="vsc-termbar">
				<span class="tt">Terminal</span>
				<span class="tts"></span>
				<button class="t-add" title="New terminal">+</button>
				<span class="grow"></span>
				<button class="t-hide" title="Collapse panel">▾</button>
			</div>
			<div class="vsc-termarea"></div>
		</div>
		<div class="vsc-status">
			<span class="vsc-scope"></span>
			<span class="vsc-path">—</span>
			<span class="grow"></span>
			<span class="vsc-lang"></span>
			<span class="vsc-pos"></span>
			<span class="vsc-up"></span>
			<span class="vsc-state"></span>
		</div>
	</div>
	<div class="vsc-quickopen vsc-hidden">
		<input placeholder="Type a file name to filter... (Esc to close)" />
		<ul></ul>
	</div>
	<input type="file" multiple class="vsc-filepick vsc-hidden" />
	<div class="vsc-menu vsc-hidden"></div>
	<div class="vsc-sync-status vsc-hidden"></div>
	<div class="vsc-modal-bg vsc-hidden">
		<div class="vsc-modal">
			<h3>Sync Configuration (SFTP)</h3>
			<label>Name (optional, used as a label only)</label><input name="s-name" placeholder="my-server" />
			<label>Host *</label><input name="s-host" placeholder="192.168.1.10" />
			<div class="grid2">
				<span><label>Username</label><input name="s-user" value="root" /></span>
				<span><label>Port</label><input name="s-port" value="22" /></span>
			</div>
			<label>Password (leave blank = keep unchanged)</label><input name="s-pass" type="password" autocomplete="off" />
			<label>Private key (PEM, optional)</label><textarea name="s-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<label>Private key path (optional, ~ expansion supported, e.g. ~/.ssh/id_rsa; takes precedence when set)</label><input name="s-keypath" placeholder="~/.ssh/id_rsa" />
			<label>SSH agent socket (optional, e.g. $SSH_AUTH_SOCK; use either this or a password/key)</label><input name="s-agent" placeholder="$SSH_AUTH_SOCK" />
			<label>Remote root directory * (which server directory the project syncs to)</label><input name="s-root" placeholder="/var/www/app" />
			<label>Excludes (vscode-sftp style globs, comma separated)</label><input name="s-exclude" placeholder="node_modules/**, dist, *.log" />
			<label style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="s-autosave" style="width:auto" /> Upload the current file automatically on save (vscode-sftp's uploadOnSave)</label>
			<div class="hint">The configuration is stored in the workspace at <b>.vscode/sftp.json</b> (format compatible with vscode-sftp / Natizyskunk.sftp); edit that file directly and Ctrl+S applies it. Supports name / passphrase / privateKeyPath (~ expansion) / agent ($SSH_AUTH_SOCK) / ignore glob / watcher.autoUpload.</div>
			<div class="btns"><button class="cancel">Cancel</button><button class="test">Test connection</button><button class="primary save-cfg">Save</button></div>
		</div>
	</div>
	<div class="vsc-modal-bg vsc-host-bg vsc-hidden">
		<div class="vsc-modal">
			<h3 class="h-title">New Host</h3>
			<label>Name (optional)</label><input name="h-name" placeholder="my-server" />
			<div class="grid2">
				<span><label>Host *</label><input name="h-host" placeholder="192.168.1.10" /></span>
				<span><label>Port</label><input name="h-port" value="22" /></span>
			</div>
			<label>Username</label><input name="h-user" value="root" />
			<label>Password (leave blank when editing = keep unchanged)</label><input name="h-pass" type="password" autocomplete="off" />
			<label>Private key (PEM, optional)</label><textarea name="h-key" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
			<label>Private key path (optional, ~ expansion supported, e.g. ~/.ssh/id_rsa; takes precedence, so the key itself need not be pasted)</label><input name="h-keypath" placeholder="~/.ssh/id_rsa" />
			<label>Private key passphrase (optional, for a passphrase-protected key)</label><input name="h-pp" type="password" autocomplete="off" />
			<label>SSH agent socket (optional, e.g. $SSH_AUTH_SOCK; use either this or a password/key)</label><input name="h-agent" placeholder="$SSH_AUTH_SOCK" />
			<div class="hint">Credentials are stored only in this machine's plugin directory (ssh-hosts.json) and are never uploaded. A password, a private key, a key path or an agent is enough. An existing ~/.ssh/config can be imported directly.</div>
			<div class="sshcfg-import vsc-hidden"></div>
			<div class="btns"><button class="cancel">Cancel</button><button class="import-cfg" title="Import hosts from ~/.ssh/config">Import from ssh config</button><button class="primary save-host">Save</button></div>
		</div>
	</div>
</div>`,
		);

		// The template above is fixed, so every selector in it always matches; the casts
		// only restate what lib.dom cannot know from a selector string.
		const root = container.querySelector(".vsc") as HTMLElement;
		const treeEl = root.querySelector(".vsc-tree") as HTMLElement;
		const hostsEl = root.querySelector(".vsc-hosts") as HTMLElement;
		const sshTreeEl = root.querySelector(".vsc-sshtree") as HTMLElement;
		const tabsEl = root.querySelector(".vsc-tabs") as HTMLElement;
		const edHost = root.querySelector(".vsc-editor") as HTMLElement;
		const emptyEl = root.querySelector(".vsc-empty") as HTMLElement;
		const stScope = root.querySelector(".vsc-scope") as HTMLElement;
		const stPath = root.querySelector(".vsc-path") as HTMLElement;
		const stLang = root.querySelector(".vsc-lang") as HTMLElement;
		const stPos = root.querySelector(".vsc-pos") as HTMLElement;
		const stState = root.querySelector(".vsc-state") as HTMLElement;
		const stUp = root.querySelector(".vsc-up") as HTMLElement;
		const quick = root.querySelector(".vsc-quickopen") as HTMLElement;
		const quickInput = quick.querySelector("input") as HTMLInputElement;
		const quickList = quick.querySelector("ul") as HTMLElement;
		const menuEl = root.querySelector(".vsc-menu") as HTMLElement;
		const filePick = root.querySelector(".vsc-filepick") as HTMLInputElement;
		const syncStatusEl = root.querySelector(".vsc-sync-status") as HTMLElement;
		const syncBg = root.querySelector(".vsc-modal-bg:not(.vsc-host-bg)") as HTMLElement;
		const hostBg = root.querySelector(".vsc-host-bg") as HTMLElement;
		const dragEl = root.querySelector(".vsc-termdrag") as HTMLElement;
		const panelEl = root.querySelector(".vsc-termpanel") as HTMLElement;
		const termTabsEl = root.querySelector(".vsc-termbar .tts") as HTMLElement;
		const termAreaEl = root.querySelector(".vsc-termarea") as HTMLElement;

		// ---- Phone drawer (narrow-screen burger toggle; no effect on desktop) ----
		const burger = root.querySelector(".vsc-burger");
		const backdrop = root.querySelector(".vsc-backdrop");
		function closeDrawer() {
			root.classList.remove("drawer-open");
		}
		if (burger) burger.addEventListener("click", () => root.classList.toggle("drawer-open"));
		if (backdrop) backdrop.addEventListener("click", closeDrawer);

		// ---- Request/response ----------------------------------------------------------------
		const pending = new Map<string, (res: ServerMessage) => void>(); // reqId → {resolve}
		function request(payload: Record<string, unknown>): Promise<ServerMessage> {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId });
				setTimeout(() => {
					if (pending.delete(reqId)) resolve({ ok: false, error: "Request timed out" });
				}, 60000);
			});
		}
		/** Scope routing: a remote scope (connId) gets connId attached automatically, everything else is sent as-is. */
		function req(scope: string, payload: Record<string, unknown>): Promise<ServerMessage> {
			return scope === "local" ? request(payload) : request({ connId: scope, ...payload });
		}

		function toast(text: string) {
			root.dispatchEvent(new CustomEvent("vsc-toast", { detail: text, bubbles: true }));
			stState.textContent = text;
			stState.classList.add("vsc-err");
			setTimeout(() => {
				stState.textContent = "";
				stState.classList.remove("vsc-err");
			}, 4000);
		}

		// ---- State ---------------------------------------------------------------------------
		let S: SshState = { depsReady: true, depsInstalling: false, hosts: [], conns: [] }; // broadcast by the server
		const conns = new Map<string, { label: string; cwd: string }>(); // connId → { label, cwd }
		const connecting = new Set<string>(); // hostIds that are currently connecting
		const expanded = new Set<string>(["local:"]); // expanded directories (scope:path)
		const dirCache = new Map<string, DirEntry[]>(); // `${scope}:${dir}` → entries
		const flatFiles = new Set<string>(); // local file paths (the Ctrl+P data source)
		const tabs = new Map<string, TabState>(); // tabKey → {scope, path, name, savedText, binary, dirty, crlf}
		let activeTk: string | null = null;
		let selNode: SelNode | null = null; // most recently clicked node {scope, path, type} - highlight + where "new file/folder" lands

		function connMeta(connId: string) {
			return S.conns.find((x) => x.connId === connId);
		}
		function connOfHost(hostId: string): string | null {
			for (const id of conns.keys()) {
				if (connMeta(id)?.hostId === hostId) return id;
			}
			return null;
		}
		function connLabel(connId: string): string {
			return conns.get(connId)?.label ?? connMeta(connId)?.label ?? connId;
		}

		/** Apply host state (initial fetch or broadcast); also adopts the connections the server
		 *  still holds, so after a page refresh the remote directory trees are visible at once
		 *  without connecting all over again. */
		function applyState(next?: SshState | null) {
			S = next ?? S;
			for (const c of S.conns) {
				if (c.status === "connected" && !conns.has(c.connId)) {
					conns.set(c.connId, { label: c.label, cwd: "/" });
				}
			}
			void renderTree();
			renderHosts();
		}

		// ---- Editor --------------------------------------------------------------------------
		const langComp = new Compartment();
		// Theme following: cmLight when light, oneDark when dark (hot-swapped through a Compartment, no editor rebuild)
		const themeComp = new Compartment();

		function makeExtensions(): Extension[] {
			return [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				foldGutter(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(),
				indentUnit.of("    "),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(),
				closeBrackets(),
				autocompletion(),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...historyKeymap,
					...foldKeymap,
					...completionKeymap,
					...lintKeymap,
					indentWithTab,
				]),
				langComp.of(langFor(parseTk(activeTk ?? "local:")?.path ?? "") ?? []),
				themeComp.of(isLightTheme() ? cmLight : oneDark),
				EditorView.updateListener.of((u) => {
					if (u.docChanged || u.selectionSet) updateStatus(u.state);
					if (u.docChanged) {
						// Event-driven dirty flag: only a real edit marks it dirty. "doc !== savedText" cannot be
						// used - CodeMirror normalises \r\n to \n internally, so a freshly opened CRLF file would
						// immediately be reported as unsaved.
						const t = tabs.get(activeTk ?? "");
						if (t && !t.binary && !t.dirty) {
							t.dirty = true;
							renderTabs();
						}
					}
				}),
			];
		}

		const view = new EditorView({ state: EditorState.create({ extensions: makeExtensions() }), parent: edHost });

		function currentDoc() {
			return view.state.doc.toString();
		}

		function updateStatus(state: EditorState) {
			const head = state.selection.main.head;
			const line = state.doc.lineAt(head);
			stPos.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
			if (activeTk) {
				const t = tabs.get(activeTk);
				stState.textContent = t?.binary ? "Binary (read-only)" : t?.dirty ? "Unsaved ●" : "Saved";
				stState.classList.toggle("dirty", !!t?.dirty);
			}
		}

		// ---- File tree rendering (local + remote multi-root) ----------------------------------
		async function ensureDir(scope: string, dirWire?: string): Promise<DirEntry[]> {
			const key = tkey(scope, dirWire ?? "");
			if (!dirCache.has(key)) {
				const r = await req(scope, { action: "list", dir: dirWire ?? "" });
				if (!r.ok) {
					toast(`Failed to read directory: ${r.error}`);
					return [];
				}
				const entries = r.entries ?? [];
				dirCache.set(key, entries);
				if (scope === "local") {
					// Ctrl+P only indexes local files
					for (const e of entries) {
						if (e.type === "file") flatFiles.add(dirWire ? `${dirWire}/${e.name}` : e.name);
					}
				}
			}
			return dirCache.get(key) ?? [];
		}

		/** Switch between the two sidebar tabs: Files / SSH. */
		function switchPane(name: string) {
			root
				.querySelectorAll<HTMLElement>(".vsc-stabs .stab")
				.forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
			root
				.querySelectorAll<HTMLElement>(".vsc-pane")
				.forEach((p) => p.classList.toggle("vsc-hidden", p.dataset.pane !== name));
		}
		(root.querySelector(".vsc-stabs") as HTMLElement).addEventListener("click", (ev) => {
			const b = (ev.target as Element).closest<HTMLElement>(".stab");
			if (b) switchPane(b.dataset.pane ?? "");
		});

		// Every whole-tree redraw is a two-step "clear -> fill asynchronously" operation, so
		// concurrent calls interleave: the second one clears the first one's half-finished work
		// and the first one's async append then lands in the second tree, ending up with the same
		// listing twice (exactly what happens when the initial renderTree at mount races the one a
		// state broadcast triggers - only clicking refresh fixes it). All whole-tree async redraws
		// therefore go through one serial queue, one at a time.
		let renderChain: Promise<void> = Promise.resolve();
		function enqueue(fn: () => Promise<void>): Promise<void> {
			renderChain = renderChain.then(fn, fn);
			return renderChain;
		}

		async function renderTree() {
			await enqueue(async () => {
				// Preserve the scroll position across the redraw - otherwise opening a file or a state
				// broadcast throws the tree back to the top and the user has to scroll down again.
				const st = treeEl.scrollTop;
				treeEl.replaceChildren();
				// The Files tab only covers the local workspace; remote directory trees belong to the SSH tab (renderRemoteTrees)
				const lh = document.createElement("div");
				lh.className = "vsc-sect";
				setMarkup(lh, `<b>📁 Local Workspace</b>`);
				treeEl.appendChild(lh);
				await renderDir("local", "", treeEl, 0);
				renderTreeHighlight();
				applySelHighlight();
				treeEl.scrollTop = st;
			});
		}

		/** SSH tab: host list (status dot / connect-disconnect / terminal / edit / delete). */
		function renderHosts() {
			const st = hostsEl.scrollTop;
			hostsEl.replaceChildren();
			const depsBtn = root.querySelector('.vsc-pane[data-pane="ssh"] button[data-act="deps"]') as HTMLElement;
			depsBtn.classList.toggle("vsc-hidden", Boolean(S.depsReady));
			depsBtn.title = S.depsInstalling ? "Installing dependency..." : "Install the ssh2 dependency";
			if (!S.depsReady && S.depsInstalling) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = "Installing dependency...";
				hostsEl.appendChild(d);
			}
			if (!S.hosts.length) {
				const d = document.createElement("div");
				d.className = "vsc-deps";
				d.textContent = "No hosts yet - click + above to add one";
				hostsEl.appendChild(d);
			}
			for (const h of S.hosts) renderHostRow(h);
			hostsEl.scrollTop = st;
			void renderRemoteTrees(); // lower half of the SSH tab: remote trees of the connected hosts
		}

		/** Lower half of the SSH tab: one remote directory tree per connected host (fully independent of the Files tab). */
		async function renderRemoteTrees() {
			// Same queue as renderTree: stops interleaved appends from duplicating remote trees under concurrency
			await enqueue(async () => {
				const st = sshTreeEl.scrollTop;
				sshTreeEl.replaceChildren();
				for (const [connId, c] of conns) {
					const sec = document.createElement("div");
					sec.className = "vsc-sect";
					setMarkup(sec, `<b>🖥 ${esc(c.label)}</b><span class="cwd" title="${esc(c.cwd)}">${esc(c.cwd)}</span>`);
					sshTreeEl.appendChild(sec);
					const sub = document.createElement("div");
					sshTreeEl.appendChild(sub);
					await renderConnTree(connId, sub);
				}
				if (!conns.size) {
					const d = document.createElement("div");
					d.className = "vsc-deps";
					d.textContent = "Once you connect to a host, its remote file list appears here";
					sshTreeEl.appendChild(d);
				}
				sshTreeEl.scrollTop = st;
				applySelHighlight();
			});
		}

		function renderHostRow(h: HostInfo) {
			const connId = connOfHost(h.id);
			const row = document.createElement("div");
			row.className = "vsc-row vsc-hrow";
			row.dataset.host = h.id;
			const busy = connecting.has(h.id) || connMeta(connId ?? "")?.status === "connecting";
			const dotCls = busy ? "busy" : connId ? "on" : "";
			setMarkup(
				row,
				`<span class="dot ${dotCls}"></span>` +
					`<span class="nm" title="${esc(h.username)}@${esc(h.host)}:${h.port}">${esc(h.name || h.host)}</span>` +
					`<span class="ops">` +
					(connId
						? '<button data-hop="term" title="New terminal">🖥</button><button data-hop="dis" title="Disconnect">⏏</button>'
						: '<button data-hop="conn" title="Connect">⇄</button>') +
					'<button data-hop="edit" title="Edit">✎</button>' +
					'<button data-hop="del" title="Delete">🗑</button></span>',
			);
			row.addEventListener("click", async (ev) => {
				const btn = (ev.target as Element).closest<HTMLElement>("button[data-hop]");
				if (btn) {
					ev.stopPropagation();
					if (btn.dataset.hop === "edit") openHostModal(h);
					else if (btn.dataset.hop === "del") {
						if (confirm(`Delete host "${h.name || h.host}"?`)) {
							const r = await request({ action: "hosts_delete", id: h.id });
							if (!r.ok) toast(`Delete failed: ${r.error}`);
							else renderHosts();
						}
					} else if (btn.dataset.hop === "term" && connId) {
						showTermPanel();
						void newTerm(connId);
					} else if (btn.dataset.hop === "dis" && connId) {
						void request({ action: "disconnect", connId }); // the conn_closed event does all the cleanup
					} else if (btn.dataset.hop === "conn") void connectHost(h);
					return;
				}
				// Clicking a host row: connect when not connected (its remote tree appears below), otherwise open a terminal
				if (!connId) {
					await connectHost(h);
					return;
				}
				showTermPanel();
				void newTerm(connId);
			});
			hostsEl.appendChild(row);
		}

		/** Connection subtree: root = the detected home (cwd); when cwd != "/" a ".." row is prepended to go up. */
		async function renderConnTree(connId: string, parentEl: HTMLElement) {
			const c = conns.get(connId);
			if (!c) return;
			if (c.cwd && c.cwd !== "/") {
				const up = document.createElement("div");
				up.className = "vsc-row";
				up.style.paddingLeft = "22px";
				setMarkup(up, `<span class="caret"></span><span>⬆</span><span class="nm">..</span>`);
				up.addEventListener("click", async () => {
					c.cwd = parentOf(c.cwd);
					// Only clear this connection's directory cache - not the other hosts' or the local one
					for (const key of [...dirCache.keys()]) {
						if (key.startsWith(`${connId}:`)) dirCache.delete(key);
					}
					renderHosts(); // redraw the SSH tab's remote trees
				});
				parentEl.appendChild(up);
			}
			await renderDir(connId, c.cwd, parentEl, 1);
		}

		async function renderDir(scope: string, dirWire: string, parentEl: HTMLElement, depth: number) {
			const entries = await ensureDir(scope, dirWire);
			await renderEntries(scope, entries, dirWire, parentEl, depth);
		}

		/** Render one level of directory entries as rows (shared by the full redraw and in-place expansion). */
		async function renderEntries(
			scope: string,
			entries: DirEntry[],
			dirWire: string,
			parentEl: HTMLElement,
			depth: number,
		) {
			for (const e of entries) {
				const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${e.name}` : e.name;
				const row = document.createElement("div");
				row.className = "vsc-row";
				row.style.paddingLeft = `${8 + depth * 14}px`;
				row.dataset.scope = scope;
				row.dataset.path = p;
				row.dataset.type = e.type;
				row.dataset.depth = String(depth);
				const ek = tkey(scope, p);
				const isOpen = expanded.has(ek);
				setMarkup(
					row,
					`<span class="caret">${e.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>` +
						`<span>${iconFor(e.name, e.type)}</span><span class="nm">${esc(e.name)}</span>`,
				);
				row.addEventListener("click", async () => {
					selectNode(scope, p, e.type);
					if (e.type !== "dir") {
						void openFile(scope, p);
						return;
					}
					// Expand/collapse in place: only touch the child container below this row instead of
					// redrawing the whole tree - clearing the tree plus a network round trip
					// would make every other directory blink out and back.
					const caret = row.querySelector(".caret");
					if (expanded.has(ek)) {
						expanded.delete(ek);
						if (caret) caret.textContent = "▸";
						const sub = row.nextElementSibling;
						if (sub instanceof Element && sub.classList.contains("vsc-sub")) sub.remove();
					} else {
						expanded.add(ek);
						if (caret) caret.textContent = "▾";
						await expandDirInPlace(scope, p, row);
					}
				});
				row.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					selectNode(scope, p, e.type); // right-click selects too: "new" in the menu lands here
					showMenu(ev.clientX, ev.clientY, scope, p, e.type);
				});
				parentEl.appendChild(row);
				if (e.type === "dir" && isOpen) {
					const sub = document.createElement("div");
					sub.className = "vsc-sub";
					sub.dataset.loaded = "1";
					parentEl.appendChild(sub);
					await renderDir(scope, p, sub, depth + 1);
				}
			}
		}

		/** Expand a directory in place: insert a .vsc-sub child container after that row and fill it, leaving the rest of the tree alone. */
		async function expandDirInPlace(scope: string, p: string, row: HTMLElement) {
			const ek = tkey(scope, p);
			const depth = Number(row.dataset.depth ?? 0);
			let sub = row.nextElementSibling as HTMLElement | null;
			if (!(sub instanceof HTMLElement && sub.classList.contains("vsc-sub"))) {
				sub = document.createElement("div");
				sub.className = "vsc-sub";
				sub.dataset.loaded = "0";
				row.insertAdjacentElement("afterend", sub);
			}
			setMarkup(
				sub,
				`<div class="vsc-row loading" style="padding-left:${8 + (depth + 1) * 14}px">` +
					`<span class="caret"></span><span>⏳</span><span class="nm">Loading...</span></div>`,
			);
			const entries = await ensureDir(scope, p);
			if (!expanded.has(ek)) {
				sub.remove();
				return;
			} // the user collapsed it again while we waited
			sub.replaceChildren();
			sub.dataset.loaded = "1";
			await renderEntries(scope, entries, p, sub, depth + 1);
			applySelHighlight(); // give the new rows their selected state
		}

		/** Click a node: highlight it and decide where the toolbar's "new file/folder" lands. */
		function selectNode(scope: string, pathW: string, type: "file" | "dir") {
			selNode = { scope, path: pathW, type };
			applySelHighlight();
		}

		/** Download to the user's computer (local or remote; base64 comes back over the WS and
		 *  is saved as a Blob; in a secure Chromium context showSaveFilePicker is preferred so
		 *  the user chooses the location). Remote folders are packed into a tar.gz on the remote
		 *  side by the server and sent back. */
		async function downloadToPC(scope: string, pathW: string, isDir = false) {
			const name = pathW.split("/").filter(Boolean).pop() || pathW;
			toast(`Downloading ${name}${isDir ? " (packing)" : ""}...`);
			const payload =
				scope === "local" ? { action: "download", path: pathW } : { action: "download", connId: scope, path: pathW };
			const r = await request(payload);
			if (!r.ok) {
				toast(`Download failed: ${r.error}`);
				return;
			}
			const bin = atob(r.b64 ?? "");
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			saveBlob(new Blob([bytes]), r.name || (isDir ? `${name}.tar.gz` : name));
		}

		function saveBlob(blob: Blob, suggestedName: string) {
			// Chromium's File System Access API is not in lib.dom.d.ts; see SaveFilePickerWindow.
			const pickerWindow = window as SaveFilePickerWindow;
			if (pickerWindow.showSaveFilePicker) {
				pickerWindow
					.showSaveFilePicker({ suggestedName })
					.then(async (fh) => {
						const w = await fh.createWritable();
						await w.write(blob);
						await w.close();
						stState.textContent = `${suggestedName} saved`;
						setTimeout(() => {
							stState.textContent = "";
						}, 3000);
					})
					.catch((e: { name?: string }) => {
						if (e?.name === "AbortError") return; // the user cancelling the save dialog is not an error
						fallbackAnchor();
					});
				return;
			}
			fallbackAnchor();
			function fallbackAnchor() {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = suggestedName;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
			}
		}

		function applySelHighlight() {
			root
				.querySelectorAll<HTMLElement>(".vsc-row[data-scope]")
				.forEach((el) =>
					el.classList.toggle(
						"sel",
						!!selNode && el.dataset.scope === selNode.scope && el.dataset.path === selNode.path,
					),
				);
		}

		function renderTreeHighlight() {
			treeEl
				.querySelectorAll<HTMLElement>(".vsc-row[data-path]")
				.forEach((el) =>
					el.classList.toggle(
						"active",
						activeTk === tkey(el.dataset.scope ?? "", el.dataset.path ?? "") && el.dataset.type === "file",
					),
				);
		}

		// ---- Tabs ----------------------------------------------------------------------------
		function renderTabs() {
			tabsEl.replaceChildren();
			for (const [k, t] of tabs.entries()) {
				const el = document.createElement("div");
				el.className = "vsc-tab" + (k === activeTk ? " active" : "");
				setMarkup(
					el,
					`<span>${t.scope !== "local" ? "🖥" : iconFor(t.name ?? "", "file")}</span>` +
						`<span class="tn">${esc(t.name)}</span>` +
						(t.dirty ? '<span class="dot">●</span>' : "") +
						`<button class="x" title="Close">✕</button>`,
				);
				el.addEventListener("click", (ev) => {
					if ((ev.target as Element).closest(".x")) return;
					void activateTab(k);
				});
				(el.querySelector(".x") as HTMLElement).addEventListener("click", () => void closeTab(k));
				tabsEl.appendChild(el);
			}
		}

		async function openFile(scope: string, p: string) {
			closeDrawer(); // narrow-screen drawer: collapse automatically once a file is picked
			const k = tkey(scope, p);
			if (!tabs.has(k)) {
				const r = await req(scope, { action: "read", path: p });
				if (!r.ok) {
					toast(`Open failed: ${r.error}`);
					return;
				}
				tabs.set(k, {
					scope,
					path: p,
					name: p.split("/").pop(),
					savedText: r.text ?? "",
					binary: !!r.binary,
					dirty: false,
					crlf: (r.text ?? "").includes("\r\n"), // keep the file's original line endings and write them back on save
				});
				if (r.binary) toast("Binary files cannot be edited yet");
			}
			await activateTab(k);
		}

		async function activateTab(k: string) {
			const t = tabs.get(k);
			if (!t) return;
			activeTk = k;
			emptyEl.classList.add("vsc-hidden");
			edHost.classList.remove("vsc-hidden");
			view.setState(
				EditorState.create({
					doc: t.binary ? "" : t.savedText,
					extensions: makeExtensions(),
				}),
			);
			t.dirty = false; // a freshly loaded document is always clean
			view.dispatch({ effects: langComp.reconfigure(langFor(t.path) ?? []) });
			stScope.textContent = t.scope !== "local" ? `🖥 ${connLabel(t.scope)}` : "Local";
			stScope.classList.toggle("remote", t.scope !== "local");
			stPath.textContent = t.path;
			stLang.textContent = langName(t.path);
			renderTabs();
			renderTreeHighlight();
			updateStatus(view.state);
			view.focus();
		}

		async function saveActive(): Promise<boolean> {
			const t = tabs.get(activeTk ?? "");
			if (!activeTk || !t || t.binary) return false;
			const text = currentDoc();
			// Write CRLF files back with their original line endings so the whole file is not rewritten as LF
			const wire = t.crlf ? text.replace(/\n/g, "\r\n") : text;
			const r = await req(t.scope, { action: "write", path: t.path, text: wire });
			if (!r.ok) {
				toast(`Save failed: ${r.error}`);
				return true;
			}
			t.savedText = text;
			t.dirty = false;
			renderTabs();
			updateStatus(view.state);
			// Refresh the cache after saving the sync config file (the server reads the file directly every time, so no reload is needed)
			if (t.path === syncCfgPath) void refreshSyncCfg();
			// Upload on save: when the config enables it and this is a local file, sync it to the remote automatically (vscode-sftp uploadOnSave)
			else if (syncCfgPub?.configured && syncCfgPub.uploadOnSave && t.scope === "local") {
				void runSync("up", "file", t.path);
			}
			return true;
		}

		async function closeTab(k: string) {
			const t = tabs.get(k);
			if (t && t.dirty && !confirm(`"${t.name}" has unsaved changes. Close anyway?`)) return;
			tabs.delete(k);
			if (activeTk === k) {
				activeTk = null;
				if (tabs.size) await activateTab([...tabs.keys()].pop() as string);
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—";
					stLang.textContent = "";
					stPos.textContent = "";
					stState.textContent = "";
					renderTabs();
				}
			} else renderTabs();
		}

		/** Close every tab of one scope (used when a connection drops; no confirmation prompt). */
		function closeTabsOfScope(scope: string) {
			for (const k of [...tabs.keys()]) {
				if (parseTk(k).scope === scope) tabs.delete(k);
			}
			if (activeTk && parseTk(activeTk).scope === scope) {
				activeTk = null;
				if (tabs.size) void activateTab([...tabs.keys()].pop() as string);
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stScope.textContent = "";
					stPath.textContent = "—";
					stLang.textContent = "";
					stPos.textContent = "";
					stState.textContent = "";
				}
			}
			renderTabs();
		}

		/** The workspace switched (main app set_cwd -> server broadcast): every local relative
		 *  path is now invalid - clear the directory cache and the Ctrl+P index, and close all
		 *  local tabs (reporting how many dirty ones were lost, so that old project content is
		 *  not saved into a same-named path in the new project); remote SSH tabs and connections
		 *  are unaffected. */
		async function applyWorkspace(newRoot?: string) {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const k of [...expanded]) {
				if (parseTk(k).scope === "local") expanded.delete(k); // the old project's expansion state is all invalid now
			}
			if (selNode?.scope === "local") selNode = null; // the "new file" target goes stale with the old project too
			let dirtyLost = 0;
			for (const [k, t] of tabs.entries()) {
				if (parseTk(k).scope === "local" && t.dirty) dirtyLost++;
			}
			closeTabsOfScope("local");
			await renderTree();
			toast(
				dirtyLost
					? `Workspace switched${newRoot ? `: ${newRoot}` : ""} (closed ${dirtyLost} unsaved local tabs)`
					: `Workspace switched${newRoot ? `: ${newRoot}` : ""}`,
			);
			void refreshSyncCfg(); // .vscode/sftp.json is per project, so re-read the sync config
		}

		// ---- Quick open (Ctrl+P, local only) --------------------------------------------------
		let flatLoaded = false;
		async function loadFlat() {
			if (flatLoaded) return;
			const r = await request({ action: "flatlist" });
			if (r.ok) {
				flatLoaded = true;
				for (const f of r.files ?? []) flatFiles.add(f);
				if (r.truncated) toast("Too many files - the list was truncated");
			}
		}

		let quickSel = 0;
		function quickMatches(): string[] {
			const q = quickInput.value.trim();
			const all = [...flatFiles];
			if (!q) return all.slice(0, 100);
			return all
				.map((f) => ({ f, s: fuzzyScore(q, f.split("/").pop() ?? "") + fuzzyScore(q, f) * 0.3 }))
				.filter((x) => x.s >= 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, 100)
				.map((x) => x.f);
		}

		function renderQuick() {
			const ms = quickMatches();
			quickSel = Math.min(quickSel, Math.max(0, ms.length - 1));
			setMarkup(
				quickList,
				ms
					.map(
						(f, i) =>
							`<li data-p="${esc(f)}" class="${i === quickSel ? "sel" : ""}">` +
							`${iconFor(f.split("/").pop() ?? "", "file")} ${esc(f.split("/").pop() ?? "")}<small>${esc(f)}</small></li>`,
					)
					.join("") || `<li style="opacity:.5;cursor:default">No matching files</li>`,
			);
		}

		function openQuickOpen() {
			void loadFlat().then(() => {
				quickSel = 0;
				renderQuick();
				quick.classList.remove("vsc-hidden");
				quickInput.focus();
				quickInput.select();
			});
		}

		function closeQuickOpen() {
			quick.classList.add("vsc-hidden");
		}

		quickInput.addEventListener("input", () => {
			quickSel = 0;
			renderQuick();
		});
		quickInput.addEventListener("keydown", (ev) => {
			const ms = quickMatches();
			if (ev.key === "Escape") {
				closeQuickOpen();
				view.focus();
			} else if (ev.key === "ArrowDown") {
				quickSel = Math.min(quickSel + 1, ms.length - 1);
				renderQuick();
				ev.preventDefault();
			} else if (ev.key === "ArrowUp") {
				quickSel = Math.max(quickSel - 1, 0);
				renderQuick();
				ev.preventDefault();
			} else if (ev.key === "Enter" && ms[quickSel]) {
				closeQuickOpen();
				void openFile("local", ms[quickSel]);
			}
		});
		quickList.addEventListener("click", (ev) => {
			const li = (ev.target as Element).closest<HTMLElement>("li[data-p]");
			if (li) {
				closeQuickOpen();
				void openFile("local", li.dataset.p ?? "");
			}
		});

		// ---- Context menu (scope aware) -------------------------------------------------------

		function showMenu(x: number, y: number, scope: string, pathW: string, type: string) {
			menuEl.replaceChildren();
			const items: MenuItem[] = [];
			if (type === "dir") {
				items.push(
					[
						"New file",
						async () => {
							await promptCreate(scope, pathW, "file");
						},
					],
					[
						"New folder",
						async () => {
							await promptCreate(scope, pathW, "dir");
						},
					],
					[
						"Upload files here...",
						async () => {
							const files = await pickFiles();
							if (files.length) void uploadFilesTo(scope, pathW, files);
						},
					],
				);
			}
			// Sync in the context menu (vscode-sftp style): local rows sync directly; remote rows resolve their relative path when clicked
			if (scope === "local") {
				if (type === "dir")
					items.push(
						["Upload this folder -> remote", () => void runSync("up", "tree", pathW)],
						["Download remote -> this folder", () => void runSync("down", "tree", pathW)],
					);
				else
					items.push(
						["Upload this file -> remote", () => void runSync("up", "file", pathW)],
						["Download to computer", () => void downloadToPC(scope, pathW)],
					);
			} else {
				// A remote row has nothing to do with the local workspace: only offer "download to computer" (folders are packed as tar.gz automatically)
				items.push([
					type === "dir" ? "Download to computer (archive)" : "Download to computer",
					() => void downloadToPC(scope, pathW, type === "dir"),
				]);
			}
			// A file row also offers "upload files here..." (target = its parent directory, the same rule as drag and drop)
			if (type !== "dir") {
				items.push([
					"Upload files here...",
					async () => {
						const files = await pickFiles();
						const dir = scope === "local" ? localParentOf(pathW) : parentOf(pathW);
						if (files.length) void uploadFilesTo(scope, dir, files);
					},
				]);
			}
			items.push(
				[
					"Rename",
					async () => {
						const nn = prompt("New name:", pathW.split("/").pop());
						if (!nn || nn === pathW.split("/").pop()) return;
						const r = await req(scope, { action: "rename", path: pathW, newName: nn });
						if (!r.ok) {
							toast(`Rename failed: ${r.error}`);
							return;
						}
						await invalidateScope(scope);
					},
				],
				[
					"Delete",
					async () => {
						if (
							!confirm(
								`Delete "${pathW}"?${scope !== "local" && type === "dir" ? " (the directory must be empty)" : " (this cannot be undone)"}`,
							)
						)
							return;
						const r = await req(scope, { action: "delete", path: pathW, isDir: type === "dir" });
						if (!r.ok) {
							toast(`Delete failed: ${r.error}`);
							return;
						}
						// Close the active tabs of the deleted file (or of anything under a deleted directory)
						for (const k of [...tabs.keys()]) {
							const { scope: s, path } = parseTk(k);
							if (s === scope && (path === pathW || path.startsWith(pathW + "/"))) void closeTab(k);
						}
						await invalidateScope(scope);
					},
				],
			);
			if (scope !== "local") {
				// A file opens the remote terminal in its parent directory, a folder opens it in itself
				items.push([
					type === "dir" ? "Open terminal here" : "Open terminal in containing folder",
					async () => {
						const dir = type === "dir" ? pathW : parentOf(pathW);
						const connection = conns.get(scope);
						if (!connection) return;
						connection.cwd = dir;
						showTermPanel();
						await newTerm(scope, dir);
					},
				]);
			}
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else {
					const run = fn;
					b.addEventListener("click", () => {
						hideMenu();
						void run();
					});
				}
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			// Keep the menu inside the container
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 170)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}
		function hideMenu() {
			menuEl.classList.add("vsc-hidden");
		}
		document.addEventListener("click", hideMenu);

		/** Clear the cache and re-fetch after a structural change; open tab content is left alone. */
		async function invalidateScope(scope: string) {
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${scope}:`)) dirCache.delete(key);
			}
			if (scope === "local") {
				flatFiles.clear();
				flatLoaded = false;
			}
			await renderTree();
			renderHosts(); // refresh the remote trees too (invalidateScope may have been triggered by a remote operation)
		}

		async function promptCreate(scope: string, dirWire: string, kind: "file" | "dir") {
			const name = prompt(
				kind === "dir" ? "New folder name:" : "New file name (may include a subpath such as a/b.js):",
			);
			if (!name) return;
			const p = dirWire ? `${dirWire.replace(/\/$/, "")}/${name.trim()}` : name.trim();
			const r = await req(scope, { action: "create", path: p, kind });
			if (!r.ok) {
				toast(`Create failed: ${r.error}`);
				return;
			}
			expanded.add(tkey(scope, dirWire));
			selNode = { scope, path: p, type: kind }; // the new entry becomes the selection, so the next "new" lands beside/inside it
			if (kind === "file") void openFile(scope, p);
			await invalidateScope(scope);
		}

		/** Full refresh: clear the cache and re-fetch; reload open tabs from what is on disk. */
		async function refreshAll() {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			for (const [_k, t] of tabs.entries()) {
				if (t.binary) continue;
				const r = await req(t.scope, { action: "read", path: t.path });
				if (r.ok && r.text != null) {
					t.savedText = r.text;
					t.crlf = r.text.includes("\r\n");
					t.dirty = false; // disk wins: unsaved edits are discarded
				}
			}
			if (activeTk && tabs.has(activeTk)) await activateTab(activeTk);
			await renderTree();
			renderTabs();
			renderHosts();
		}

		// ---- Uploads (toolbar button / context menu / drag onto the file tree; local and remote share this) ----
		const UPLOAD_CHUNK = 512 * 1024; // chunk size in bytes (base64 over the WS, avoids oversized single frames)
		let uploading = false; // re-entrancy guard: ignore new triggers while the previous batch is still going

		/** Open the system file picker (multiple) and resolve with File[]; cancelling resolves with []. */
		function pickFiles(): Promise<File[]> {
			return new Promise((resolve) => {
				filePick.onchange = () => {
					const files = [...(filePick.files ?? [])];
					filePick.value = ""; // reset so the same files can be picked again next time
					resolve(files);
				};
				filePick.click();
			});
		}

		function setUploadProgress(text: string) {
			stUp.textContent = text;
		}

		/** One file: begin (existence check + overwrite confirmation) -> upload chunk by chunk -> the last chunk commits it. Resolves with success. */
		async function uploadOne(scope: string, dir: string, file: File): Promise<boolean> {
			const name = file.name;
			if (file.size > 100 * 1024 * 1024) {
				toast(`"${name}" exceeds the 100MB limit and was skipped`);
				return false;
			}
			const begin = await req(scope, { action: "upload_begin", dir, name, size: file.size });
			if (!begin.ok) {
				toast(`Upload failed: ${begin.error}`);
				return false;
			}
			if (begin.exists && !confirm(`"${name}" already exists. Overwrite it?`)) {
				void request({ action: "upload_abort", uploadId: begin.uploadId });
				return false;
			}
			const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
			try {
				for (let i = 0; i < total; i++) {
					const slice = file.slice(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
					const u8 = new Uint8Array(await slice.arrayBuffer());
					const r = await req(scope, { action: "upload", uploadId: begin.uploadId, i, total, b64: bufToB64(u8) });
					if (!r.ok) throw new Error(r.error);
					setUploadProgress(`⬆ ${name} (${i + 1}/${total})`);
				}
				return true;
			} catch (err) {
				void request({ action: "upload_abort", uploadId: begin.uploadId });
				toast(`Uploading "${name}" failed: ${(err as { message?: string })?.message ?? String(err)}`);
				return false;
			}
		}

		/** Upload a batch into a directory (local or remote); refreshes that tree afterwards and reports a summary. */
		async function uploadFilesTo(scope: string, dir: string, files: File[]) {
			if (!files?.length) return;
			if (uploading) {
				toast("Upload in progress, please wait...");
				return;
			}
			uploading = true;
			let ok = 0;
			try {
				for (const f of files) if (await uploadOne(scope, dir, f)) ok++;
				if (ok) await invalidateScope(scope);
				setUploadProgress("");
				if (ok === files.length) toast(`Uploaded ${ok} files${dir ? ` to ${dir}` : " (workspace root)"}`);
				else toast(`Upload finished: ${ok}/${files.length} succeeded`);
			} finally {
				uploading = false;
			}
		}

		// ---- Drag and drop upload (VSCode style: folder row -> that folder; file row -> its parent; empty space -> root) ----
		function isFileDrag(ev: DragEvent): boolean {
			return Array.from(ev.dataTransfer?.types ?? []).includes("Files");
		}

		function clearDropTargets() {
			root.querySelectorAll(".vsc-row.drop-target").forEach((el) => el.classList.remove("drop-target"));
			treeEl.classList.remove("drop-root");
			sshTreeEl.classList.remove("drop-root");
		}

		/** Parent directory of a local file lives in localParentOf(), next to parentOf(). */

		/** Current drop target: {scope, dir}. Hitting a row -> that directory row, or the parent of a file row; empty space -> the local root or the first connected host's root. */
		function dropTargetFrom(ev: MouseEvent, containerScope: string | null): DropTarget | null {
			const row = closestFromEventTarget<HTMLElement>(ev.target, ".vsc-row");
			const rowScope = row?.dataset.scope;
			const rowPath = row?.dataset.path ?? "";
			if (row && rowScope) {
				return {
					scope: rowScope,
					dir: row.dataset.type === "dir" ? rowPath : rowScope === "local" ? localParentOf(rowPath) : parentOf(rowPath),
				};
			}
			if (containerScope === "local") return { scope: "local", dir: "" };
			const first = [...conns.keys()][0];
			return first ? { scope: first, dir: conns.get(first)!.cwd } : null;
		}

		function setDropHighlight(t: DropTarget | null) {
			clearDropTargets();
			if (!t) return;
			// A concrete directory target highlights that row; a root or remote-root target highlights the whole tree container
			if (t.dir && t.dir !== "/") {
				root
					.querySelector(`.vsc-row[data-scope="${CSS.escape(t.scope)}"][data-path="${CSS.escape(t.dir)}"]`)
					?.classList.add("drop-target");
			} else {
				(t.scope === "local" ? treeEl : sshTreeEl).classList.add("drop-root");
			}
		}

		/** The main app treats the whole window as a drop target (dropping a file means "attach
		 *  to the conversation"); the file tree's dragover already calls stopPropagation, and this
		 *  additionally clears the app's fullscreen paperclip hint so it does not hover over the
		 *  upload target and confuse things (purely visual cleanup, its behaviour is untouched). */
		function clearAppDropOverlay() {
			const appEl = container.ownerDocument.querySelector(".app");
			if (appEl) appEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
		}

		for (const [el, containerScope] of [
			[treeEl, "local"],
			[sshTreeEl, null],
		] as [HTMLElement, string | null][]) {
			el.addEventListener("dragover", (ev) => {
				if (!isFileDrag(ev)) return;
				ev.preventDefault(); // declare ourselves a valid drop target, otherwise the browser forbids the drop
				ev.stopPropagation(); // opt out of the main app's whole-window drop (the file is not attached to the conversation)
				clearAppDropOverlay();
				setDropHighlight(dropTargetFrom(ev, containerScope));
				ev.dataTransfer!.dropEffect = "copy";
			});
			el.addEventListener("dragleave", (ev) => {
				if (ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget)) return; // still moving inside the tree
				clearDropTargets();
			});
			el.addEventListener("drop", (ev) => {
				if (!isFileDrag(ev)) return;
				ev.preventDefault();
				ev.stopPropagation();
				clearDropTargets();
				clearAppDropOverlay();
				const files = [...(ev.dataTransfer?.files ?? [])];
				if (!files.length) {
					toast("Folder upload is not supported yet - please pick files");
					return;
				}
				const t = dropTargetFrom(ev, containerScope);
				if (!t) {
					toast("Connect an SSH host first");
					return;
				}
				void uploadFilesTo(t.scope, t.dir, files);
			});
		}

		// ---- Right-click on empty space (same targets as an empty drop: local -> workspace root; SSH tree -> the first connected host's root) ----
		for (const [el, containerScope] of [
			[treeEl, "local"],
			[sshTreeEl, null],
		] as [HTMLElement, string | null][]) {
			el.addEventListener("contextmenu", (ev) => {
				const tgt = ev.target instanceof Element ? ev.target : el;
				if (tgt.closest(".vsc-row")) return; // rows have their own menu (and already stopPropagation)
				ev.preventDefault();
				ev.stopPropagation();
				const t = dropTargetFrom(ev, containerScope); // reuse the drop target calculation; empty space -> root
				if (!t) {
					toast("Connect an SSH host first");
					return;
				}
				hideMenu();
				const items: MenuItem[] = [];
				items.push([
					"Upload files here...",
					async () => {
						const files = await pickFiles();
						if (files.length) void uploadFilesTo(t.scope, t.dir, files);
					},
				]);
				if (containerScope === "local" && t.dir === "") {
					items.push(["Refresh", () => void refreshAll()]);
				}
				menuEl.replaceChildren();
				for (const [label, fn] of items) {
					const b = document.createElement("button");
					b.textContent = label;
					if (fn) {
						const run = fn;
						b.addEventListener("click", () => {
							hideMenu();
							void run();
						});
					}
					menuEl.appendChild(b);
				}
				menuEl.classList.remove("vsc-hidden");
				const rect = root.getBoundingClientRect();
				menuEl.style.left = `${Math.min(ev.clientX - rect.left, rect.width - 170)}px`;
				menuEl.style.top = `${Math.min(ev.clientY - rect.top, rect.height - items.length * 32 - 20)}px`;
			});
		}
		// ---- Toolbar -------------------------------------------------------------------------
		requiredQuery<HTMLElement>(root, ".vsc-side-head").addEventListener("click", (ev: MouseEvent) => {
			const btn = closestFromEventTarget<HTMLButtonElement>(ev.target, "button[data-act]");
			if (!btn) return;
			ev.stopPropagation(); // stop bubbling: otherwise the document-level "click anywhere closes the menu" handler hides the sync menu we just opened
			const act = btn.dataset.act;
			if (act === "refresh") {
				void refreshAll();
			} else if (act === "new-file") {
				void promptCreate("local", pickLocalDir(), "file");
			} else if (act === "new-dir") {
				void promptCreate("local", pickLocalDir(), "dir");
			} else if (act === "upload") {
				void pickFiles().then((files) => uploadFilesTo("local", "", files));
			} else if (act === "sync-menu") {
				const rect = btn.getBoundingClientRect();
				showSyncMenu(rect.left, rect.bottom + 4);
			}
		});

		// ---- SSH host form -------------------------------------------------------------------
		let modalEditId: string | null = null;
		function openHostModal(h: HostInfo | null) {
			modalEditId = h?.id ?? null;
			requiredQuery<HTMLElement>(hostBg, ".h-title").textContent = h ? "Edit Host" : "New Host";
			const q = (n: string) => requiredQuery<HTMLInputElement | HTMLTextAreaElement>(hostBg, `[name="${n}"]`);
			q("h-name").value = h?.name ?? "";
			q("h-host").value = h?.host ?? "";
			q("h-port").value = String(h?.port ?? 22);
			q("h-user").value = h?.username ?? "root";
			q("h-pass").value = "";
			q("h-key").value = "";
			q("h-keypath").value = h?.privateKeyPath ?? "";
			q("h-pp").value = "";
			q("h-agent").value = h?.agent ?? "";
			q("h-pass").placeholder = h?.hasPass ? "Saved (leave blank to keep)" : "";
			q("h-key").placeholder = h?.hasKey ? "Saved (leave blank to keep)" : "-----BEGIN OPENSSH PRIVATE KEY-----";
			q("h-pp").placeholder = h?.hasPassphrase ? "Saved (leave blank to keep)" : "";
			const importPanel = requiredQuery<HTMLElement>(hostBg, ".sshcfg-import");
			importPanel.classList.add("vsc-hidden");
			importPanel.replaceChildren();
			hostBg.classList.remove("vsc-hidden");
			q("h-host").focus();
		}
		requiredQuery<HTMLElement>(hostBg, ".cancel").addEventListener("click", () => hostBg.classList.add("vsc-hidden"));
		hostBg.addEventListener("click", (ev: MouseEvent) => {
			if (ev.target === hostBg) hostBg.classList.add("vsc-hidden");
		});
		requiredQuery<HTMLElement>(hostBg, ".save-host").addEventListener("click", async () => {
			const q = (n: string) => requiredQuery<HTMLInputElement | HTMLTextAreaElement>(hostBg, `[name="${n}"]`);
			const body: HostSavePayload & { id?: string } = {
				...hostPayloadFrom({
					name: q("h-name").value,
					host: q("h-host").value,
					port: q("h-port").value,
					username: q("h-user").value,
					password: q("h-pass").value,
					privateKey: q("h-key").value,
					passphrase: q("h-pp").value,
					privateKeyPath: q("h-keypath").value,
					agent: q("h-agent").value,
				}),
				...(modalEditId ? { id: modalEditId } : {}),
			};
			const r = await request({ action: "hosts_save", host: body });
			if (!r.ok) {
				toast(`Save failed: ${r.error}`);
				return;
			}
			hostBg.classList.add("vsc-hidden");
		});

		// ---- Import hosts from ~/.ssh/config -------------------------------------------------
		requiredQuery<HTMLElement>(hostBg, ".import-cfg").addEventListener("click", async () => {
			const panel = requiredQuery<HTMLElement>(hostBg, ".sshcfg-import");
			const hint = (text: string) => {
				const div = document.createElement("div");
				div.className = "hint";
				div.textContent = text;
				panel.replaceChildren(div);
			};
			hint("Reading ~/.ssh/config...");
			panel.classList.remove("vsc-hidden");
			const r = await request({ action: "sshconfig_list" });
			if (!r.ok) {
				hint(`Read failed: ${r.error}`);
				return;
			}
			const all = r.hosts ?? [];
			const fresh = all.filter((x) => !x.imported);
			if (!fresh.length) {
				hint(`${all.length} host(s) found, all already imported.`);
				return;
			}
			panel.replaceChildren();
			for (const x of fresh) {
				const label = document.createElement("label");
				label.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:normal";
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.checked = true;
				cb.value = x.alias;
				cb.style.width = "auto";
				const span = document.createElement("span");
				span.textContent =
					`${x.alias} - ${x.username}@${x.host}:${x.port}` + (x.privateKeyPath ? ` (${x.privateKeyPath})` : "");
				label.append(cb, span);
				panel.appendChild(label);
			}
			const btn = document.createElement("button");
			btn.className = "primary";
			btn.textContent = "Import selected";
			btn.addEventListener("click", async () => {
				const aliases = [...panel.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")].map(
					(c) => c.value,
				);
				if (!aliases.length) {
					toast("Select at least one host to import");
					return;
				}
				const r2 = await request({ action: "sshconfig_import", aliases });
				if (!r2.ok) {
					toast(`Import failed: ${r2.error}`);
					return;
				}
				panel.classList.add("vsc-hidden");
				panel.replaceChildren();
				hostBg.classList.add("vsc-hidden");
				toast(`Imported ${r2.added} host(s)${r2.skipped ? ` (skipped ${r2.skipped})` : ""}`);
			});
			panel.appendChild(btn);
		});

		/** Connect to a host and expand its directory tree (probing home as the starting path). */
		async function connectHost(h: HostInfo) {
			if (connecting.has(h.id) || connOfHost(h.id)) return;
			connecting.add(h.id);
			renderTree();
			const r = await request({ action: "connect", id: h.id });
			connecting.delete(h.id);
			if (!r.ok || !r.connId || !r.label) {
				toast(`Connection failed: ${r.error ?? "invalid server response"}`);
				renderTree();
				return;
			}
			let cwd = "/";
			const pwd = await request({ action: "exec", connId: r.connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0) {
				const home = homeFromPwdOutput(pwd.output);
				if (home) cwd = home;
			}
			conns.set(r.connId, { label: r.label, cwd });
			lastConnId = r.connId;
			selNode = { scope: r.connId, path: cwd, type: "dir" }; // default target for the toolbar's new file/folder buttons
			renderHosts();
			await renderTree();
		}

		/** Connection dropped: clear the connection state plus that scope's tabs/terminals/caches. */
		function handleConnClosed(connId: string, reason?: string) {
			for (const [, t] of terms.entries()) {
				if (t.connId === connId) disposeTerm(t);
			}
			conns.delete(connId);
			closeTabsOfScope(connId);
			for (const key of [...dirCache.keys()]) {
				if (key.startsWith(`${connId}:`)) dirCache.delete(key);
			}
			if (lastConnId === connId) lastConnId = [...conns.keys()].pop() ?? null;
			if (selNode && selNode.scope === connId) selNode = null;
			renderTermTabs();
			syncPanelVisibility();
			void renderTree();
			renderHosts();
			if (reason) toast(`Connection closed: ${connLabel(connId)} ${reason}`);
		}

		// ---- Bottom terminal panel (each host may have several shells) ------------------------
		const terms = new Map<string, TermState>(); // termId → {id, connId, shellId, label, n, term, fit, el, opened, dead}
		let syncCfgPub: PublicSyncConfig | null = null; // redacted config from the last sync_get (used to decide uploadOnSave / remoteRoot)
		let syncCfgPath = ".vscode/sftp.json";

		/** Fetch the sync config into the cache (the server reads .vscode/sftp.json directly each time, so saving applies at once). */
		async function refreshSyncCfg() {
			const r = await request({ action: "sync_get" });
			if (r.ok) {
				syncCfgPub = r.config ?? null;
				syncCfgPath = r.configPath ?? syncCfgPath;
			}
			return r;
		}
		let termSeq = 0;
		let activeTermId: string | null = null;
		let lastConnId: string | null = null;
		let termH = 240;
		const inputQueue = new Map<string, string[]>(); // buffers input until the shellId is ready

		function pickConnId() {
			const t = activeTk ? tabs.get(activeTk) : undefined;
			if (t && t.scope !== "local" && conns.has(t.scope)) return t.scope;
			if (lastConnId && conns.has(lastConnId)) return lastConnId;
			return [...conns.keys()][0] ?? null;
		}

		function showTermPanel() {
			panelEl.classList.remove("vsc-hidden");
			dragEl.classList.remove("vsc-hidden");
			panelEl.style.height = `${termH}px`;
		}
		function hideTermPanel() {
			panelEl.classList.add("vsc-hidden");
			dragEl.classList.add("vsc-hidden");
		}
		function syncPanelVisibility() {
			if (terms.size) showTermPanel();
			else hideTermPanel();
		}
		// Theme following: switch the editor's light/dark plus every live terminal's palette together
		function onThemeChange() {
			try {
				view.dispatch({ effects: themeComp.reconfigure(isLightTheme() ? cmLight : oneDark) });
			} catch (err) {
				console.debug("[plugin:vscode-editor] best-effort UI operation failed", err);
			}
			const th = buildTermTheme();
			for (const [, t] of terms.entries()) {
				try {
					if (t.term) t.term.options.theme = th;
				} catch (err) {
					console.debug("[plugin:vscode-editor] best-effort UI operation failed", err);
				}
			}
		}
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		async function newTerm(connId?: string | null, startCwd?: string) {
			connId = connId ?? pickConnId();
			if (!connId || !conns.has(connId)) {
				toast("Connect an SSH host first (click a host name on the left)");
				return;
			}
			const sameConn = [...terms.values()].filter((t) => t.connId === connId).length;
			const t: TermState = {
				id: `t${++termSeq}`,
				connId,
				shellId: null,
				label: connLabel(connId),
				n: sameConn + 1,
				dead: false,
				term: null,
				fit: null,
				el: null,
				opened: false,
			};
			terms.set(t.id, t);
			showTermPanel();
			t.el = document.createElement("div");
			t.el.className = "vsc-term";
			termAreaEl.appendChild(t.el);
			const term = new Terminal({
				fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
				fontSize: 13,
				cursorBlink: true,
				theme: buildTermTheme(),
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			t.term = term;
			t.fit = fit;
			term.open(t.el);
			try {
				fit.fit();
			} catch (err) {
				console.debug("[plugin:vscode-editor] best-effort UI operation failed", err);
			}
			term.onData((d) => {
				if (t.dead) return;
				if (t.shellId) ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(d) });
				else {
					const queue = inputQueue.get(t.id) ?? [];
					queue.push(d);
					inputQueue.set(t.id, queue);
				}
			});
			setActiveTerm(t.id);
			const r = await request({
				action: "shell_open",
				connId: t.connId,
				cols: term.cols,
				rows: term.rows,
			});
			if (!r.ok || !r.shellId) {
				toast(`Failed to open the terminal: ${r.error ?? "invalid server response"}`);
				disposeTerm(t);
				renderTermTabs();
				syncPanelVisibility();
				return;
			}
			t.shellId = r.shellId;
			// Flush whatever was typed before the shell was ready
			const queued = inputQueue.get(t.id);
			if (queued?.length && !t.dead) {
				ctx.send({ action: "shell_input", connId: t.connId, shellId: t.shellId, b64: b64.enc(queued.join("")) });
			}
			inputQueue.delete(t.id);
			// Explicit start directory: send a cd once the shell is ready (equivalent to typing it by hand)
			if (startCwd && !t.dead) {
				ctx.send({
					action: "shell_input",
					connId: t.connId,
					shellId: t.shellId,
					b64: b64.enc(`cd ${shQuote(startCwd)}\n`),
				});
			}
			term.focus();
		}

		function setActiveTerm(id: string) {
			activeTermId = id;
			for (const [tid, t] of terms.entries()) {
				t.el?.classList.toggle("vsc-hidden", tid !== id);
				if (tid === id)
					requestAnimationFrame(() => {
						try {
							t.fit?.fit();
						} catch (err) {
							console.debug("[plugin:vscode-editor] best-effort UI operation failed", err);
						}
						t.term?.focus();
					});
			}
			renderTermTabs();
		}

		function renderTermTabs() {
			termTabsEl.replaceChildren();
			for (const [tid, t] of terms.entries()) {
				const el = document.createElement("span");
				el.className = "vsc-ttab" + (tid === activeTermId ? " active" : "");
				setMarkup(
					el,
					`<span class="tn">🖥 ${esc(t.label)}${t.n > 1 ? ` ${t.n}` : ""}</span><button class="x" title="Close">✕</button>`,
				);
				el.addEventListener("click", (ev: MouseEvent) => {
					if (closestFromEventTarget(ev.target, ".x")) {
						killTerm(t);
						return;
					}
					setActiveTerm(tid);
				});
				termTabsEl.appendChild(el);
			}
		}

		function killTerm(t: TermState) {
			if (t.shellId) void request({ action: "shell_close", connId: t.connId, shellId: t.shellId });
			disposeTerm(t);
			if (activeTermId === t.id) {
				activeTermId = null;
				const rest = [...terms.keys()];
				if (rest.length) setActiveTerm(rest[rest.length - 1]);
			}
			renderTermTabs();
			syncPanelVisibility();
		}

		function disposeTerm(t: TermState) {
			t.dead = true;
			try {
				t.ro?.disconnect();
			} catch (err) {
				reportUiError(err);
			}
			try {
				t.term?.dispose();
			} catch (err) {
				reportUiError(err);
			}
			try {
				t.el?.remove();
			} catch (err) {
				reportUiError(err);
			}
			terms.delete(t.id);
		}

		requiredQuery<HTMLElement>(root, ".vsc-termbar .t-add").addEventListener("click", () => void newTerm());
		requiredQuery<HTMLElement>(root, ".vsc-termbar .t-hide").addEventListener("click", hideTermPanel);

		// Drag to resize the panel height
		dragEl.addEventListener("mousedown", (ev: MouseEvent) => {
			ev.preventDefault();
			const startY = ev.clientY;
			const startH = panelEl.getBoundingClientRect().height;
			const maxH = Math.max(120, root.getBoundingClientRect().height * 0.7);
			const onMove = (e: MouseEvent) => {
				termH = Math.round(Math.min(Math.max(startH + (startY - e.clientY), 80), maxH));
				panelEl.style.height = `${termH}px`;
				for (const [, t] of terms.entries()) {
					try {
						t.fit?.fit();
					} catch (err) {
						reportUiError(err);
					}
				}
			};
			const onUp = () => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});

		// ---- SFTP sync (local workspace <-> remote directory, per-direction overwrite) --------
		function showSyncMenu(x: number, y: number) {
			menuEl.replaceChildren();
			const at = activeTk ? tabs.get(activeTk) : undefined;
			const items: MenuItem[] = [
				["Sync configuration...", () => void openSyncModal()],
				["Edit config file (.vscode/sftp.json)", () => void openConfigFile()],
				["Upload everything (local -> remote)", () => void runSync("up", "all", "")],
				["Download everything (remote -> local)", () => void runSync("down", "all", "")],
				[
					at && at.scope === "local" && !at.binary
						? `Upload current file (${at.name})`
						: "Upload current file (open a local file first)",
					at && at.scope === "local" && !at.binary ? () => void runSync("up", "file", at.path) : null,
				],
			];
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				if (!fn) b.className = "dim";
				else {
					const run = fn;
					b.addEventListener("click", () => {
						hideMenu();
						run();
					});
				}
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 200)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}

		function showSyncProgress(text: string) {
			syncStatusEl.textContent = text;
			syncStatusEl.classList.remove("vsc-hidden");
		}
		function hideSyncProgressSoon() {
			setTimeout(() => syncStatusEl.classList.add("vsc-hidden"), 2500);
		}

		/** Open .vscode/sftp.json: when it does not exist the server writes a template or migrates it first; edit it in the editor and Ctrl+S applies it. */
		async function openConfigFile() {
			const r = await request({ action: "sync_ensure" });
			if (!r.ok || !r.path) {
				toast(`Failed to open the config: ${r.error ?? "invalid server response"}`);
				return;
			}
			void refreshSyncCfg();
			void openFile("local", r.path);
		}

		async function runSync(dir: "up" | "down", scope: string, path: string) {
			showSyncProgress(dir === "up" ? "Uploading..." : "Downloading...");
			const r = await request({ action: "sync_run", dir, scope, path });
			if (!r.ok) {
				showSyncProgress(`Sync failed: ${r.error}`);
				hideSyncProgressSoon();
				return;
			}
			const bad = r.failed?.length ?? 0;
			const total = r.total ?? 0;
			showSyncProgress(
				`${dir === "up" ? "Upload" : "Download"} complete: ${total - bad}/${total}${bad ? ` (${bad} failed)` : ""}`,
			);
			hideSyncProgressSoon();
			if (dir === "down") void refreshAll();
		}

		async function openSyncModal() {
			const q = (n: string) => requiredQuery<HTMLInputElement | HTMLTextAreaElement>(syncBg, `[name="${n}"]`);
			const r = await request({ action: "sync_get" });
			const cfg: PublicSyncConfig = r.ok && r.config ? r.config : { configured: false };
			q("s-name").value = cfg.name ?? "";
			q("s-host").value = cfg.host ?? "";
			q("s-user").value = cfg.username ?? "root";
			q("s-port").value = String(cfg.port ?? 22);
			q("s-pass").value = "";
			q("s-key").value = "";
			q("s-keypath").value = cfg.privateKeyPath ?? "";
			q("s-agent").value = cfg.agent ?? "";
			q("s-root").value = cfg.remoteRoot ?? "";
			q("s-exclude").value = (cfg.exclude ?? []).join(", ");
			requiredQuery<HTMLInputElement>(syncBg, '[name="s-autosave"]').checked = Boolean(cfg.uploadOnSave);
			q("s-pass").placeholder = cfg.hasPass ? "Saved (leave blank to keep)" : "";
			q("s-keypath").placeholder = cfg.hasKey ? "Saved (leave blank to keep)" : "~/.ssh/id_rsa";
			syncBg.classList.remove("vsc-hidden");
		}
		requiredQuery<HTMLElement>(syncBg, ".cancel").addEventListener("click", () => syncBg.classList.add("vsc-hidden"));
		requiredQuery<HTMLElement>(syncBg, ".test").addEventListener("click", async () => {
			const r = await request({ action: "sync_test" });
			toast(r.ok ? "Connection succeeded ✓" : `Connection failed: ${r.error}`);
		});
		requiredQuery<HTMLElement>(syncBg, ".save-cfg").addEventListener("click", async () => {
			const q = (n: string) => requiredQuery<HTMLInputElement | HTMLTextAreaElement>(syncBg, `[name="${n}"]`);
			const body = syncPayloadFrom({
				name: q("s-name").value,
				host: q("s-host").value,
				port: q("s-port").value,
				username: q("s-user").value,
				password: q("s-pass").value,
				privateKey: q("s-key").value,
				privateKeyPath: q("s-keypath").value,
				agent: q("s-agent").value,
				remoteRoot: q("s-root").value,
				exclude: q("s-exclude").value,
				uploadOnSave: requiredQuery<HTMLInputElement>(syncBg, '[name="s-autosave"]').checked,
			});
			const r = await request({ action: "sync_save", config: body });
			if (!r.ok) {
				toast(`Save failed: ${r.error}`);
				return;
			}
			void refreshSyncCfg(); // refresh the cache so uploadOnSave and friends apply immediately
			syncBg.classList.add("vsc-hidden");
			toast("Saved to .vscode/sftp.json");
		});

		// ---- Server event dispatch -----------------------------------------------------------
		const offData = ctx.onData((payload) => {
			if (!payload) return;
			if (payload.res && payload.reqId) {
				const p = pending.get(payload.reqId);
				if (p) {
					pending.delete(payload.reqId);
					p(payload);
					return;
				}
			}
			// Guard: a response without a reqId is silently dropped by the match above - requests must go through request()
			if (payload.res && !payload.reqId) {
				console.warn(
					"[vscode-editor] received a response without a reqId (ignored); send requests through request():",
					payload.action,
				);
			}
			if (payload.kind === "workspace") {
				// server-side workspace switch (main app set_cwd): rebuild the tree + close local tabs
				void applyWorkspace(payload.root);
				return;
			}
			if (payload.kind === "state") {
				// host/connection list broadcast (credentials redacted)
				applyState(payload.state);
				return;
			}
			switch (payload.event) {
				case "shell_data": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write(b64.bytes(payload.b64 ?? ""));
							break;
						}
					}
					break;
				}
				case "shell_exit": {
					for (const [, t] of terms.entries()) {
						if (t.connId === payload.connId && t.shellId === payload.shellId) {
							t.term?.write("\r\n\x1b[90m[shell exited]\x1b[0m\r\n");
							break;
						}
					}
					break;
				}
				case "conn_closed":
					if (payload.connId) handleConnClosed(payload.connId, payload.reason);
					break;
				case "sync_progress":
					showSyncProgress(`Syncing ${payload.done ?? 0}/${payload.total ?? 0}: ${payload.name ?? ""}`);
					break;
			}
		});

		// ---- Global keyboard shortcuts -------------------------------------------------------
		function onGlobalKey(ev: KeyboardEvent) {
			if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "p") {
				ev.preventDefault();
				openQuickOpen();
			} else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveActive();
			} else if (ev.key === "Escape") {
				if (!quick.classList.contains("vsc-hidden")) closeQuickOpen();
				if (!menuEl.classList.contains("vsc-hidden")) hideMenu();
			}
		}
		container.ownerDocument.addEventListener("keydown", onGlobalKey, true);

		// ---- Startup -------------------------------------------------------------------------
		requiredQuery<HTMLElement>(root, '.vsc-pane[data-pane="ssh"] .vsc-side-head').addEventListener(
			"click",
			(ev: MouseEvent) => {
				const btn = closestFromEventTarget<HTMLButtonElement>(ev.target, "button[data-act]");
				if (!btn) return;
				ev.stopPropagation(); // same reason as above
				if (btn.dataset.act === "add-host") openHostModal(null);
				else if (btn.dataset.act === "deps") void request({ action: "deps_install" });
				else if (btn.dataset.act === "new-term") {
					showTermPanel();
					void newTerm();
				} else if (btn.dataset.act === "r-new-file" || btn.dataset.act === "r-new-dir") {
					const t = pickRemoteDir();
					if (t) void promptCreate(t.connId, t.dir, btn.dataset.act === "r-new-dir" ? "dir" : "file");
				} else if (btn.dataset.act === "r-upload") {
					const t = pickRemoteDir();
					if (t) void pickFiles().then((files) => uploadFilesTo(t.connId, t.dir, files));
				} else if (btn.dataset.act === "r-refresh") {
					void refreshAll();
				}
			},
		);
		/** Target for the local toolbar (new file/folder): the most recently clicked local node (a file uses its parent directory), otherwise the workspace root. */
		function pickLocalDir() {
			if (selNode?.scope === "local") return selNode.type === "dir" ? selNode.path : parentOf(selNode.path);
			return "";
		}

		/** Target for the SSH toolbar (new file/folder): the most recently clicked remote node (a file uses its parent directory), otherwise the first connected host's root. */
		function pickRemoteDir() {
			if (selNode && selNode.scope !== "local" && conns.has(selNode.scope)) {
				return { connId: selNode.scope, dir: selNode.type === "dir" ? selNode.path : parentOf(selNode.path) };
			}
			const first = [...conns.keys()][0];
			const connection = first ? conns.get(first) : undefined;
			if (!first || !connection) {
				toast("Connect an SSH host first");
				return null;
			}
			return { connId: first, dir: connection.cwd };
		}

		switchPane("files");
		// The initial fetch must carry a reqId and go through the response channel - a response
		// without one is dropped by the "no pending match" path, and it is not a kind:"state"
		// broadcast either, so nobody would ever handle it.
		void request({ action: "state" }).then((r) => {
			if (r.ok && r.state) applyState(r.state);
		});
		void refreshSyncCfg(); // cache the sync config (used for uploadOnSave / remote root mapping)
		void renderTree();
		renderHosts();

		return () => {
			container.ownerDocument.removeEventListener("keydown", onGlobalKey, true);
			document.removeEventListener("click", hideMenu);
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			for (const [, t] of terms.entries()) {
				try {
					t.ro?.disconnect();
				} catch (err) {
					reportUiError(err);
				}
				try {
					t.term?.dispose();
				} catch (err) {
					reportUiError(err);
				}
			}
			terms.clear();
			offData();
			view.destroy();
			root.remove();
		};
	},
};

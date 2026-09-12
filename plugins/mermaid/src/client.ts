/**
 * Mermaid fenced-code renderer plugin.
 *
 * The engine is loaded lazily from the bundled vendor module, with a CDN
 * fallback for partial plugin installations. Rendering stays entirely client
 * side and the host falls back to the raw code block if rendering fails.
 *
 * This file is the source of the compiled plugins/mermaid/client/entry.mjs the
 * browser loads; run `npm run build:mermaid` after changing it.
 */

/** CDN fallback used only when the bundled vendor module is unavailable. */
const CDN_URL = "https://esm.sh/mermaid@11";
/** Vendor engine, resolved relative to the compiled client/entry.mjs. */
const VENDOR_URL = "./vendor/mermaid.bundle.mjs";
/** Broadcast by the host (web/src/theme.ts) after the active theme changed. */
const THEME_CHANGE_EVENT = "pi-web-ui:theme-change";
/** Fallback diagram font size, mermaid's own default. */
const DEFAULT_FONT_SIZE = 12;

/**
 * The mermaid engine API this plugin calls. The engine is loaded at runtime from
 * a URL (the bundled vendor module, or the CDN), so its shape is declared here
 * rather than imported from the npm package: the module that actually runs is
 * whatever that URL serves, not the version in node_modules.
 */
interface MermaidEngine {
	initialize(config: Record<string, unknown>): void;
	render(id: string, code: string, container?: HTMLElement): Promise<{ svg: string }>;
}

/** The narrow channel the host hands a fence renderer alongside the code. */
export interface FenceRenderContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

/** Host contract for a fenced-code renderer (web/src/plugin-loader.ts). */
export type FenceRenderer = (code: string, ctx: FenceRenderContext) => HTMLElement | null | Promise<HTMLElement | null>;

let mermaidPromise: Promise<MermaidEngine> | null = null;

/** The module a URL serves, unwrapped to its default export when it has one. */
function importModule(url: string): Promise<MermaidEngine> {
	// The specifier is only known at runtime, so it cannot be typed any tighter;
	// the loaded module is the mermaid engine either way.
	return import(/* @vite-ignore */ url).then((mod) => (mod.default ?? mod) as MermaidEngine);
}

function loadMermaid(): Promise<MermaidEngine> {
	if (!mermaidPromise) {
		mermaidPromise = importModule(VENDOR_URL).catch(() => importModule(CDN_URL));
	}
	return mermaidPromise;
}

function cssVar(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Dark or light, from an explicit color-scheme first and the body background
 * luminance for legacy themes that do not set one. The background is a thunk so
 * it is only read - and only forces a style recalculation - when needed.
 */
export function isDarkAppearance(colorScheme: string, backgroundColor: () => string): boolean {
	if (colorScheme.split(/\s+/).includes("dark")) return true;
	if (colorScheme.split(/\s+/).includes("light")) return false;

	const rgb = backgroundColor()
		.match(/[\d.]+/g)
		?.slice(0, 3)
		.map(Number);
	if (!rgb || rgb.length < 3) return true;
	return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 128;
}

/** Prefer an explicit color-scheme; use background luminance for legacy themes. */
export function isDarkTheme(): boolean {
	return isDarkAppearance(
		getComputedStyle(document.documentElement).colorScheme,
		() => getComputedStyle(document.body).backgroundColor,
	);
}

/** A CSS length as a diagram font size, falling back to mermaid's default. */
export function parseFontSize(value: string): number {
	const size = Number.parseFloat(value);
	return Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT_SIZE;
}

export function diagramFontSize(): number {
	return parseFontSize(cssVar("--mermaid-font-size", "12px"));
}

export function themeVariables(dark: boolean, fontSize: number): Record<string, string> {
	return dark
		? {
				background: cssVar("--bg-elev2", "#1a1d26"),
				primaryColor: cssVar("--bg-elev", "#14161c"),
				primaryBorderColor: cssVar("--border", "#262a35"),
				lineColor: cssVar("--text-dim", "#9aa1b4"),
				textColor: cssVar("--text", "#e6e8ef"),
				primaryTextColor: cssVar("--text", "#e6e8ef"),
				nodeBorder: cssVar("--accent", "#8b5cf6"),
				labelBackground: cssVar("--bg", "#0d0e12"),
				fontFamily: cssVar("--mono", "monospace"),
				fontSize: `${fontSize}px`,
			}
		: {
				background: cssVar("--bg", "#ffffff"),
				primaryColor: cssVar("--bg-elev2", "#f6f8fa"),
				primaryBorderColor: cssVar("--border", "#d0d7de"),
				lineColor: cssVar("--text-dim", "#59636e"),
				textColor: cssVar("--text", "#1f2328"),
				primaryTextColor: cssVar("--text", "#1f2328"),
				nodeBorder: cssVar("--accent", "#0969da"),
				labelBackground: cssVar("--bg", "#ffffff"),
				fontFamily: cssVar("--mono", "monospace"),
				fontSize: `${fontSize}px`,
			};
}

let seq = 0;

/** Give the root SVG a concrete width so wide diagrams scroll instead of shrink. */
export function preserveSvgWidth(svg: string): string {
	const match = svg.match(/<svg\b([^>]*)>/i);
	if (!match) return svg;
	const attrs = match[1];
	const viewBox = attrs.match(/\bviewBox=(['"])([^'"]+)\1/i)?.[2];
	if (!viewBox) return svg;
	const values = viewBox
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const width = values.length === 4 ? values[2] : Number.NaN;
	if (!Number.isFinite(width) || width <= 0) return svg;
	const existingStyle = attrs.match(/\sstyle=(['"])(.*?)\1/i)?.[2] ?? "";
	const cleanStyle = existingStyle.replace(/(?:^|;)\s*(?:max-)?width\s*:[^;]*/gi, "").replace(/^\s*;|;\s*$/g, "");
	const sizedAttrs = attrs.replace(/\swidth=(['"])[^'"]*\1/i, "").replace(/\sstyle=(['"])(.*?)\1/i, "");
	const style = cleanStyle ? `${cleanStyle}; max-width:none` : "max-width:none";
	return svg.replace(match[0], `<svg${sizedAttrs} width="${width}" style="${style}">`);
}

/** Mermaid configuration is global, so initialize and render must be atomic. */
let renderQueue: Promise<unknown> = Promise.resolve();

interface RenderedDiagram {
	dark: boolean;
	svg: string;
}

function renderSvg(code: string): Promise<RenderedDiagram> {
	const result = renderQueue.then(async (): Promise<RenderedDiagram> => {
		const mermaid = await loadMermaid();
		const dark = isDarkTheme();
		const fontSize = diagramFontSize();
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: dark ? "dark" : "base",
			fontSize,
			sequence: {
				actorFontSize: fontSize,
				messageFontSize: fontSize,
				noteFontSize: fontSize,
			},
			gantt: {
				fontSize,
				sectionFontSize: fontSize,
			},
			themeVariables: themeVariables(dark, fontSize),
		});

		const renderId = `mermaid-fence-${++seq}-${Date.now().toString(36)}`;
		const holder = document.createElement("div");
		holder.style.position = "absolute";
		holder.style.left = "-99999px";
		holder.style.width = "1000px";
		holder.dataset.mermaidRender = renderId;
		document.body.appendChild(holder);
		try {
			const { svg } = await mermaid.render(renderId, code, holder);
			return { dark, svg: preserveSvgWidth(svg) };
		} finally {
			holder.remove();
		}
	});
	renderQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function applyRenderedSvg(el: HTMLElement, rendered: RenderedDiagram): void {
	if (rendered.dark) el.dataset.mermaidDark = "true";
	else delete el.dataset.mermaidDark;
	// Safe: the markup is mermaid's own output, produced with securityLevel
	// "strict", which sanitizes diagram labels before they reach the SVG.
	el.innerHTML = rendered.svg;
}

async function renderMermaid(code: string): Promise<HTMLElement> {
	const el = document.createElement("div");
	el.className = "mermaid-block mermaid-svg";
	applyRenderedSvg(el, await renderSvg(code));

	let themeRequest = 0;
	el.addEventListener(THEME_CHANGE_EVENT, () => {
		const request = ++themeRequest;
		renderSvg(code)
			.then((rendered) => {
				if (request !== themeRequest || !el.isConnected) return;
				// Replace the SVG synchronously only after its replacement is complete,
				// preserving the block height and reading position while rendering.
				applyRenderedSvg(el, rendered);
			})
			.catch((err) => console.error("[plugin:mermaid] theme re-render failed:", err));
	});
	return el;
}

const mermaidPlugin: { renderers: Record<string, FenceRenderer> } = {
	renderers: {
		mermaid: renderMermaid,
	},
};

export default mermaidPlugin;

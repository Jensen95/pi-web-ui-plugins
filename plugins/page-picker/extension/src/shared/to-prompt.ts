import type { DetailLevel, ElementSnapshot, PickPayload, PickSection, PickedElement } from "./contract.js";
import { sectionsForDepth } from "./contract.js";
import { collapse, code, truncate } from "./text.js";

function sectionsOf(payload: PickPayload): Set<PickSection> {
	const list = payload.sections ?? sectionsForDepth(payload.detail ?? "standard");
	return new Set(list);
}

const FRAMEWORK_LABEL: Record<string, string> = {
	react: "React",
	vue: "Vue",
	svelte: "Svelte",
	angular: "Angular",
	unknown: "",
};

export interface ToPromptOptions {
	maxElements?: number;

	maxText?: number;
}

export function toPrompt(payload: PickPayload, opts: ToPromptOptions = {}): string {
	const elements = (payload.elements ?? []).filter((e) => e?.snapshot);
	if (elements.length === 0) return "";
	const level: DetailLevel = payload.detail ?? "standard";
	const sections = sectionsOf(payload);
	const max = Math.max(1, opts.maxElements ?? 8);
	const shown = elements.slice(0, max);

	const lines: string[] = [];
	lines.push(`### Web element pick (${elements.length} element${elements.length === 1 ? "" : "s"})`);
	lines.push("");
	if (sections.has("page")) lines.push(...renderPage(payload));
	if (payload.note?.trim()) lines.push(`- Overall note: ${collapse(payload.note)}`);
	lines.push("");
	shown.forEach((el, i) => {
		lines.push(...renderElement(el, level, i + 1, sections, opts));
	});
	if (elements.length > shown.length) {
		lines.push(`(Another ${elements.length - shown.length} picked elements are not expanded)`);
	}
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

function renderPage(payload: PickPayload): string[] {
	const page = payload.page;
	const out: string[] = [];
	const title = page?.title?.trim();
	out.push(`- Page: ${code(page?.url ?? "")}${title ? ` — ${collapse(title)}` : ""}`);
	const vp = page?.viewport;
	if (vp) {
		const scheme = page.colorScheme === "dark" ? ", dark" : page.colorScheme === "light" ? ", light" : "";
		out.push(`- Viewport: ${round(vp.w)}x${round(vp.h)} @${vp.dpr}x${scheme}`);
	}
	const fw = page?.framework ? FRAMEWORK_LABEL[page.framework] : "";
	if (fw) out.push(`- Framework hint: ${fw}`);
	return out;
}

function renderElement(
	el: PickedElement,
	level: DetailLevel,
	index: number,
	sections: Set<PickSection>,
	opts: ToPromptOptions,
): string[] {
	const snap = el.snapshot;
	const maxText = Math.max(0, opts.maxText ?? (level === "compact" ? 160 : 400));
	const out: string[] = [];
	out.push(`#### Element ${index} · ${code(snap.tagSummary || `<${snap.tag}>`)}`);
	out.push("");
	if (sections.has("selector")) {
		out.push(`- Selector: ${code(snap.selector)}`);
		const source = sections.has("source") ? renderSource(snap) : "";
		if (source) out.push(`- Source: ${source}`);
		out.push(`- Size: ${renderRect(snap)}`);
	} else if (sections.has("source")) {
		const source = renderSource(snap);
		if (source) out.push(`- Source: ${source}`);
	}
	const text = sections.has("text") && snap.text ? collapse(snap.text) : "";
	if (text) out.push(`- Text: ${code(truncate(text, maxText))}`);
	if (el.shot) out.push("- Screenshot: see the attached image");
	if (sections.has("locator")) {
		if (snap.xpath) out.push(`- XPath: ${code(snap.xpath)}`);
		if (snap.domPath) out.push(`- DOM: ${code(snap.domPath)}`);
	}
	if (el.note?.trim()) out.push(`- Note: ${collapse(el.note)}`);

	const rules = sections.has("rules") ? renderRules(snap) : [];
	if (rules.length > 0) {
		out.push("", "Matched CSS:", "", "```css", ...rules, "```");
	}
	const styles = sections.has("styles") ? renderStyles(snap) : "";
	if (styles) out.push("", `Computed styles (only values differing from defaults or inherited): ${styles}`);
	const skeleton = sections.has("skeleton") ? snap.htmlSkeleton?.trim() : "";
	if (skeleton) out.push("", "HTML skeleton:", "", "```html", skeleton, "```");

	out.push("");
	return out;
}

function renderSource(snap: ElementSnapshot): string {
	const src = snap.source;
	if (!src) return "";
	const parts: string[] = [];
	const file = src.file?.trim();
	if (file) {
		const at = src.line ? `:${src.line}${src.column ? `:${src.column}` : ""}` : "";
		parts.push(code(`${file}${at}`));
	}
	const who: string[] = [];
	if (src.component) who.push(code(src.component));
	for (const up of src.chain ?? []) {
		if (up && up !== src.component) who.push(code(up));
	}
	if (who.length > 0) parts.push(`(${who.join(" <- ")})`);
	if (src.kind === "css") parts.push("(matched style location)");
	if (parts.length === 0) return "";
	return parts.join(" ");
}

function renderRect(snap: ElementSnapshot): string {
	const r = snap.rect;
	const px = `${round(r.w)}x${round(r.h)} px`;
	const pct = r.vwPct || r.vhPct ? `(Viewport ${round(r.vwPct, 1)}% x ${round(r.vhPct, 1)}%)` : "";
	return `${px}${pct}`;
}

function renderRules(snap: ElementSnapshot): string[] {
	const rules = snap.matchedRules ?? [];
	const out: string[] = [];
	for (const rule of rules) {
		if (!rule?.selector) continue;
		const where = rule.file ? `/* ${rule.file}${rule.line ? `:${rule.line}` : ""} */` : "";
		if (where) out.push(where);
		const decls = rule.declarations ? ` { ${rule.declarations} }` : " { … }";
		out.push(`${collapse(rule.selector)}${decls}`);
	}
	return out;
}

function renderStyles(snap: ElementSnapshot): string {
	const styles = snap.styles;
	if (!styles) return "";
	const entries = Object.entries(styles).filter(([, v]) => v !== "" && v != null);
	if (entries.length === 0) return "";
	return code(entries.map(([k, v]) => `${k}: ${v}`).join("; "));
}

function round(n: number, digits = 0): number {
	if (!Number.isFinite(n)) return 0;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

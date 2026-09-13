/// <reference lib="dom" />

export type DetailLevel = "compact" | "standard" | "full";

export const DETAIL_LEVELS: DetailLevel[] = ["compact", "standard", "full"];

export function isDetailLevel(v: unknown): v is DetailLevel {
	return typeof v === "string" && (DETAIL_LEVELS as readonly string[]).includes(v);
}

export const PICK_SECTIONS = ["page", "selector", "locator", "source", "text", "rules", "styles", "skeleton"] as const;

export type PickSection = (typeof PICK_SECTIONS)[number];

export function isPickSection(v: unknown): v is PickSection {
	return typeof v === "string" && (PICK_SECTIONS as readonly string[]).includes(v);
}

export const SECTION_INFO: Record<PickSection, { label: string; hint: string }> = {
	page: { label: "Page context", hint: "URL / title / viewport / framework hint" },
	selector: { label: "Locator", hint: "Selector + tag + dimensions (usually needed for code changes)" },
	locator: { label: "XPath and DOM path", hint: "Fallback when a selector is not unique or stops working" },
	source: { label: "Source location", hint: "React/Vue file, line, and component chain -- the key to a precise fix" },
	text: { label: "Text content", hint: "Element text (long text is truncated)" },
	rules: { label: "Matched CSS rules", hint: "Which rule matched it and its source file and line" },
	styles: {
		label: "Computed styles",
		hint: "Only values that differ from defaults or inherited values (usually 3-5 lines)",
	},
	skeleton: { label: "HTML skeleton", hint: "Structure with child nodes collapsed; much smaller than outerHTML" },
};

export interface SectionPreset {
	id: string;

	label: string;

	short: string;
	hint: string;
	depth: DetailLevel;
	sections: PickSection[];
}

export const SECTION_PRESETS: SectionPreset[] = [
	{
		id: "lean",
		label: "Lean (smallest context)",
		short: "Lean",
		hint: "Locator, source location, and short text: about 3-5 lines per element",
		depth: "compact",
		sections: ["page", "selector", "source", "text"],
	},
	{
		id: "standard",
		label: "Standard (recommended)",
		short: "Standard",
		hint: "Adds matched CSS, computed style differences, and the HTML skeleton",
		depth: "standard",
		sections: ["page", "selector", "source", "text", "rules", "styles", "skeleton"],
	},
	{
		id: "full",
		label: "Full",
		short: "Full",
		hint: "Everything, with deeper selectors and skeletons and longer text",
		depth: "full",
		sections: [...PICK_SECTIONS],
	},
	{
		id: "source",
		label: "Fix the right place",
		short: "Fix place",
		hint: "Selector and source location (React/Vue file and line), without styles",
		depth: "standard",
		sections: ["selector", "source"],
	},
	{
		id: "styles",
		label: "Styles only",
		short: "Styles",
		hint: "Selector, matched CSS, and computed style differences (spacing, color, and layout)",
		depth: "standard",
		sections: ["selector", "rules", "styles"],
	},
	{
		id: "text",
		label: "Text and structure",
		short: "Text",
		hint: "Selector, text, and HTML skeleton, without source or styles",
		depth: "compact",
		sections: ["selector", "text", "skeleton"],
	},
];

export function sectionsForDepth(depth: DetailLevel): PickSection[] {
	const id = depth === "compact" ? "lean" : depth === "full" ? "full" : "standard";
	const preset = SECTION_PRESETS.find((p) => p.id === id);
	return preset ? [...preset.sections] : [...SECTION_PRESETS[1].sections];
}

export function normalizeSections(raw: unknown): PickSection[] {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	const out: PickSection[] = [];
	for (const item of list) {
		const v = typeof item === "string" ? item.trim() : item;
		if (isPickSection(v) && !out.includes(v)) out.push(v);
	}
	return out.length > 0 ? out : sectionsForDepth("standard");
}

export function presetForSections(sections: PickSection[]): SectionPreset | undefined {
	const key = [...sections].sort().join(",");
	return SECTION_PRESETS.find((p) => [...p.sections].sort().join(",") === key);
}

export const DETAIL_LABELS: Record<DetailLevel, string> = {
	compact: "Lean",
	standard: "Standard",
	full: "Full",
};

export function presetShortLabel(sections: PickSection[]): string {
	return presetForSections(sections)?.short ?? "Custom";
}

export function applySectionToggle(sections: PickSection[], key: PickSection, on: boolean): PickSection[] {
	const set = new Set(sections);
	if (on) set.add(key);
	else set.delete(key);
	return PICK_SECTIONS.filter((k) => set.has(k));
}

export function presetHotkeyIndex(e: {
	key?: string;
	code?: string;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
}): number {
	if (!e.altKey || e.ctrlKey || e.metaKey) return 0;
	const byCode = /^Digit([1-9])$/.exec(e.code ?? "");
	const digit = byCode ? Number(byCode[1]) : /^[1-9]$/.test(e.key ?? "") ? Number(e.key) : 0;
	return digit >= 1 && digit <= SECTION_PRESETS.length ? digit : 0;
}

export function describeSections(sections: PickSection[]): string {
	const names = sections.map((k) => SECTION_INFO[k].label);
	const matched = presetForSections(sections);
	return (
		`Sending: ${names.length > 0 ? names.join(" / ") : "nothing selected -- using the standard set"} ` +
		`(${sections.length} items${matched ? `, preset: ${matched.label}` : ", custom"})`
	);
}

export interface SourceRef {
	kind: "react" | "vue" | "css" | "unknown";

	file?: string;
	line?: number;
	column?: number;

	component?: string;

	chain?: string[];
}

export interface MatchedRule {
	file?: string;

	line?: number;
	selector: string;

	declarations?: string;
}

export interface ElementRect {
	x: number;
	y: number;
	w: number;
	h: number;

	vwPct: number;
	vhPct: number;
}

export interface ElementSnapshot {
	tag: string;
	id?: string;
	classes: string[];

	selector: string;

	xpath?: string;

	domPath?: string;

	tagSummary?: string;

	text?: string;

	htmlSkeleton?: string;
	rect: ElementRect;

	styles?: Record<string, string>;
	matchedRules?: MatchedRule[];
	source?: SourceRef;
}

export interface PickedElement {
	snapshot: ElementSnapshot;

	note?: string;

	shot?: string;
}

export interface PageContext {
	url: string;
	title: string;
	viewport: { w: number; h: number; dpr: number };

	framework?: string;
	colorScheme?: "light" | "dark";
}

export interface PickPayload {
	id: string;
	pickedAt: string;
	page: PageContext;
	elements: PickedElement[];

	note?: string;
	detail: DetailLevel;

	sections?: PickSection[];
}

export function makePickId(now: number = Date.now(), rand: () => number = Math.random): string {
	return `pick-${now.toString(36)}-${Math.floor(rand() * 1e6)
		.toString(36)
		.padStart(4, "0")}`;
}

/// <reference lib="dom" />

import {
	DETAIL_LABELS,
	PICK_SECTIONS,
	SECTION_INFO,
	SECTION_PRESETS,
	describeSections,
	presetForSections,
	type DetailLevel,
	type PickSection,
} from "../shared/contract.js";

export interface PresetControlsState {
	detail: DetailLevel;

	sections: PickSection[];

	notice?: string;
}

export interface PresetControlsHandlers {
	onPreset: (id: string) => void;

	onToggleSection: (key: PickSection, on: boolean) => void;

	onRefuseEmpty?: (key: PickSection) => void;
}

export interface PresetControls {
	root: HTMLElement;

	setPanelOpen: (open: boolean) => void;
	render: (state: PresetControlsState) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k === "text") node.textContent = v;
		else node.setAttribute(k, v);
	}
	for (const child of children) node.append(child);
	return node;
}

export function createPresetControls(handlers: PresetControlsHandlers): PresetControls {
	let current: PresetControlsState = { detail: "standard", sections: [...PICK_SECTIONS] };
	let open = false;

	const row = el("div", { class: "presets" });
	row.append(el("span", { class: "plabel", text: "Presets" }));

	const chips = SECTION_PRESETS.map((preset, i) => {
		const chip = el("button", {
			class: "chip",
			type: "button",
			"data-preset": preset.id,

			title: `${preset.label} -- ${preset.hint} (Alt+${i + 1})`,
			text: preset.short,
		});
		chip.addEventListener("click", () => handlers.onPreset(preset.id));
		row.append(chip);
		return { preset, chip };
	});

	const customChip = el("span", {
		class: "chip custom",
		title: "Custom selection; click a preset chip to apply one.",
		text: "Custom",
	});

	const panelBtn = el("button", { class: "link", type: "button" });
	const setPanelOpen = (next: boolean): void => {
		open = next;
		panel.classList.toggle("hidden", !open);
		panelBtn.textContent = open ? "Collapse" : "Adjust sections";
		panelBtn.setAttribute("aria-expanded", String(open));
	};
	panelBtn.addEventListener("click", () => setPanelOpen(!open));
	row.append(el("span", { class: "grow" }), customChip, panelBtn);

	const panel = el("div", { class: "sections hidden" });
	const boxes = new Map<PickSection, HTMLInputElement>();
	for (const key of PICK_SECTIONS) {
		const info = SECTION_INFO[key];
		const box = el("input", { type: "checkbox", id: `pp-sec-${key}`, title: info.hint });
		box.addEventListener("change", () => {
			if (!box.checked && current.sections.length <= 1) {
				box.checked = true;
				handlers.onRefuseEmpty?.(key);
				return;
			}
			handlers.onToggleSection(key, box.checked);
		});
		boxes.set(key, box);
		const label = el("label", { class: "sec", title: info.hint }, [box, el("span", { text: info.label })]);
		panel.append(label);
	}

	const summary = el("div", { class: "sump" });
	const root = el("div", { class: "preset-box" }, [row, panel, summary]);

	const render = (state: PresetControlsState): void => {
		current = { detail: state.detail, sections: [...state.sections] };
		const matched = presetForSections(current.sections);
		for (const { preset, chip } of chips) {
			const active = matched?.id === preset.id;
			chip.classList.toggle("active", active);
			chip.setAttribute("aria-pressed", String(active));
		}
		customChip.classList.toggle("hidden", Boolean(matched));
		customChip.classList.toggle("active", !matched);
		for (const [key, box] of boxes) box.checked = current.sections.includes(key);

		const depth = `Collection depth: ${DETAIL_LABELS[current.detail]}`;

		const hotkey = `Alt+1-${SECTION_PRESETS.length} to switch`;
		const base = matched
			? `Preset: ${matched.label} | ${depth} | ${hotkey}`
			: `${describeSections(current.sections)} | ${depth} | ${hotkey}`;
		summary.textContent = state.notice ? `${base} | Warning: ${state.notice}` : base;
	};

	setPanelOpen(false);
	return { root, setPanelOpen, render };
}

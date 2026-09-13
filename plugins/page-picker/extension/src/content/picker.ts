import "../chrome.d.ts";
import "../compat.js";
/// <reference lib="dom" />

import {
	PICK_SECTIONS,
	SECTION_PRESETS,
	applySectionToggle,
	makePickId,
	presetHotkeyIndex,
	presetShortLabel,
	type DetailLevel,
	type PickPayload,
	type PickSection,
	type PickedElement,
} from "../shared/contract.js";
import { pageContext, snapshotElement } from "./element.js";
import { requestGrantHere, requestPairHere } from "./pair-here.js";
import { createPresetControls } from "./preset-controls.js";

const FLAG = "__piWebUiPagePicker";
const HOST_ID = "pi-page-picker-host";

interface PickerRuntime {
	start: (opts?: { detail?: DetailLevel; sections?: PickSection[] }) => void;
	destroy: () => void;
}

interface Picked {
	el: Element;
	snapshot: PickedElement["snapshot"];
	note: string;
}

type Phase = "picking" | "editing";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.hl, .pick { position: fixed; pointer-events: none; }
.hl { border: 2px solid #3b82f6; background: rgba(59,130,246,.14); }
.pick { border: 1px dashed #22c55e; background: rgba(34,197,94,.10); }
.n {
  position: absolute; top: -9px; left: -9px; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px; background: #22c55e; color: #fff; font-size: 11px; line-height: 18px;
  text-align: center; font-weight: 600;
}
.tag {
  position: absolute; left: -2px; bottom: -22px; max-width: 60vw; padding: 2px 6px;
  background: #3b82f6; color: #fff; font-size: 11px; line-height: 16px; border-radius: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pick .tag { background: #22c55e; }
.hud {
  position: fixed; top: 14px; left: 0; right: 0; z-index: 10;
  /* Width: fit-content with auto margins centers the bar without limiting it to half the viewport. */
  width: fit-content; max-width: 92vw; margin: 0 auto;
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px;
  background: rgba(17,24,39,.94); color: #e5e7eb; font-size: 13px;
  /* Information-only bar: never make it clickable, or it blocks page content. */
  pointer-events: none;
  /* Wrap the whole item when it does not fit. */
  flex-wrap: wrap; justify-content: center;
  box-shadow: 0 6px 24px rgba(0,0,0,.35);
}
.hud > * { white-space: nowrap; }
.hud b { color: #93c5fd; font-weight: 600; }
.hud .k { padding: 1px 5px; border: 1px solid #4b5563; border-radius: 4px; font-size: 11px; color: #9ca3af; }
.bar {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  width: min(680px, 92vw); padding: 12px; border-radius: 10px; pointer-events: auto;
  background: rgba(17,24,39,.97); color: #e5e7eb; font-size: 13px;
  box-shadow: 0 10px 34px rgba(0,0,0,.45);
}
.rows { max-height: 34vh; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 8px; }
.idx {
  flex: 0 0 20px; height: 20px; border-radius: 50%; background: #22c55e; color: #fff;
  font-size: 11px; line-height: 20px; text-align: center;
}
.sel {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #9ca3af; font-family: ui-monospace, Consolas, monospace; font-size: 12px;
}
input[type=text] {
  flex: 1 1 auto; min-width: 0; padding: 4px 8px; border-radius: 5px; font-size: 12px;
  border: 1px solid #374151; background: #111827; color: #e5e7eb;
}
input[type=text]:focus { outline: none; border-color: #3b82f6; }
.row input { flex: 0 0 44%; }
button { padding: 5px 10px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: #e5e7eb; font-size: 12px; cursor: pointer; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
button:hover { filter: brightness(1.15); }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.foot .grow { flex: 1 1 auto; }
.toast {
  position: fixed; bottom: 18px; left: 0; right: 0; margin: 0 auto;
  width: fit-content; max-width: 92vw;
  padding: 10px 14px; border-radius: 8px; background: rgba(17,24,39,.97); color: #e5e7eb;
  font-size: 13px; pointer-events: none; box-shadow: 0 8px 26px rgba(0,0,0,.4);
}
.toast.ok { border-left: 3px solid #22c55e; }
.toast.err { border-left: 3px solid #ef4444; }
/* Preset row: chips apply a group, and the right-side link expands individual sections. */
.preset-box { margin-top: 10px; border-top: 1px solid #1f2937; padding-top: 10px; }
.presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.presets .plabel { color: #94a3b8; font-size: 12px; }
.presets .grow { flex: 1 1 auto; }
.chip {
  padding: 3px 9px; border-radius: 999px; border: 1px solid #374151; background: #1f2937;
  color: #cbd5e1; font-size: 12px; cursor: pointer;
}
.chip.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
.chip.custom { cursor: default; border-style: dashed; }
.chip.custom.active { background: #374151; border-color: #4b5563; color: #e5e7eb; font-weight: 600; }
.link { padding: 3px 8px; border: none; background: none; color: #93c5fd; font-size: 12px; cursor: pointer; }
.link:hover { text-decoration: underline; filter: none; }
.sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 2px 10px; margin-top: 8px; }
.sections .sec { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #cbd5e1; }
.sump { color: #94a3b8; font-size: 11px; margin-top: 6px; }
.hidden { display: none !important; }
`;

function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	const tag = target.tagName.toLowerCase();
	return tag === "input" || tag === "textarea" || tag === "select" || (target as HTMLElement).isContentEditable;
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

function createPicker(): PickerRuntime {
	let phase: Phase = "picking";
	let picked: Picked[] = [];
	let hovered: Element | null = null;
	let detail: DetailLevel = "standard";
	let sections: PickSection[] | undefined;
	let note = "";
	let rafId = 0;
	let stopped = true;

	const host = el("div", { id: HOST_ID });
	host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
	const shadow = host.attachShadow({ mode: "closed" });
	const hl = el("div", { class: "hl hidden" });
	const picks = el("div");
	const hud = el("div", { class: "hud" });
	const bar = el("div", { class: "bar hidden" });
	const toast = el("div", { class: "toast hidden" });
	shadow.append(el("style", { text: CSS }), hl, picks, hud, bar, toast);

	const rows = el("div", { class: "rows" });

	let optionsNotice = "";
	const presets = createPresetControls({
		onPreset: (id) => applyPreset(id),
		onToggleSection: (key, on) => applyPickOptions(detail, applySectionToggle(effectiveSections(), key, on)),
		onRefuseEmpty: () =>
			showToast("Keep at least one section selected; an empty selection falls back to standard", "err"),
	});
	const noteInput = el("input", {
		type: "text",
		placeholder: 'Overall note (optional), for example: "these gaps are inconsistent"',
	});

	presets.root.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.stopPropagation();
		if (phase === "editing") setPhase("picking");
		else stop();
	});
	const sendBtn = el("button", { class: "primary", text: "Add to chat" });
	const moreBtn = el("button", { text: "Pick more" });
	const cancelBtn = el("button", { text: "Cancel" });

	const grantBtn = el("button", { text: "Let AI control this page..." });
	grantBtn.title =
		"After authorization, the model can use browser_page to read and edit this page; revoke it in the options at any time";
	grantBtn.addEventListener("click", () => {
		void (async () => {
			const ok = await requestGrantHere(location.href);
			showToast(
				ok
					? 'This page is filled in on the options page -- click "Authorize page" to activate it'
					: "Cannot open options; authorize the page manually in the extension options",
				ok ? "ok" : "err",
			);
		})();
	});
	const pairBtn = el("button", { text: "Pair with another page..." });
	pairBtn.title =
		"Use this page as one endpoint and choose the other in options; click the extension icon on both pages first";
	pairBtn.addEventListener("click", () => {
		void (async () => {
			const ok = await requestPairHere(location.href);
			showToast(
				ok
					? "This page is filled in on the options page -- choose the other endpoint; click the extension icon on that page first"
					: "Cannot open options; add the pair manually in the extension options",
				ok ? "ok" : "err",
			);
		})();
	});
	bar.append(
		rows,
		presets.root,
		noteInput,
		el("div", { class: "foot" }, [grantBtn, pairBtn, el("span", { class: "grow" }), moreBtn, cancelBtn, sendBtn]),
	);

	const place = (box: HTMLElement, node: Element, label: string, cls: string): void => {
		const r = node.getBoundingClientRect();
		box.style.left = `${r.left}px`;
		box.style.top = `${r.top}px`;
		box.style.width = `${r.width}px`;
		box.style.height = `${r.height}px`;
		box.className = cls;
		let tag = box.querySelector<HTMLElement>(".tag");
		if (!tag) {
			tag = el("div", { class: "tag" });
			box.append(tag);
		}
		tag.textContent = label;
	};

	const renderPicks = (): void => {
		while (picks.childElementCount > picked.length) picks.lastElementChild?.remove();
		picked.forEach((p, i) => {
			let box = picks.children[i] as HTMLElement | undefined;
			if (!box) {
				box = el("div", { class: "pick" });
				box.append(el("div", { class: "n", text: String(i + 1) }));
				picks.append(box);
			}
			const badge = box.querySelector<HTMLElement>(".n");
			if (badge) badge.textContent = String(i + 1);

			if (!p.el.isConnected) {
				box.className = "pick hidden";
				return;
			}
			place(box, p.el, p.snapshot.selector, "pick");
		});
	};

	const renderHover = (): void => {
		if (phase !== "picking" || !hovered || !hovered.isConnected) {
			hl.className = "hl hidden";
			return;
		}
		place(hl, hovered, hovered.tagName.toLowerCase(), "hl");
	};

	const renderHud = (): void => {
		const parts: (Node | string)[] = [];
		if (phase === "picking") {
			parts.push(
				el("span", { text: picked.length > 0 ? `Click more elements, or` : "Click an element to pick it" }),
				el("span", { class: "k", text: "Shift+click" }),
				el("span", { text: "multi-select" }),
				el("span", { class: "k", text: "Enter" }),
				el("span", { text: "Done" }),
				el("span", { class: "k", text: "Esc" }),
				el("span", { text: "Exit" }),
			);
			if (picked.length > 0) parts.unshift(el("b", { text: `Selected ${picked.length}` }));

			parts.push(el("span", { text: "Preset" }), el("b", { text: presetShortLabel(effectiveSections()) }));
		} else {
			parts.push(
				el("b", { text: `Selected ${picked.length} elements` }),
				el("span", { text: 'Click "Add to chat" when ready' }),
				el("span", { class: "k", text: "Ctrl+Enter" }),
				el("span", { text: "Send directly" }),
			);
		}
		hud.replaceChildren(...parts);
	};

	const renderBar = (): void => {
		bar.classList.toggle("hidden", phase !== "editing");
		if (phase !== "editing") return;
		const rowNodes: Node[] = picked.map((p, i) => {
			const idx = el("div", { class: "idx", text: String(i + 1) });
			const sel = el("div", { class: "sel", text: p.snapshot.selector });
			sel.title = p.snapshot.selector;
			const input = el("input", { type: "text", placeholder: "What is wrong with this element? (optional)" });
			input.value = p.note;
			input.addEventListener("input", () => {
				p.note = input.value;
			});
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") void send();
				if (e.key === "Escape") setPhase("picking");
			});
			const del = el("button", { text: "✕" });
			del.addEventListener("click", () => {
				picked.splice(i, 1);
				if (picked.length === 0) setPhase("picking");
				else {
					renderBar();
					renderHud();
				}
			});
			return el("div", { class: "row" }, [idx, sel, input, del]);
		});
		rows.replaceChildren(...rowNodes);
		noteInput.value = note;
		presets.render({
			detail,
			sections: effectiveSections(),
			...(optionsNotice ? { notice: optionsNotice } : {}),
		});
	};

	const effectiveSections = (): PickSection[] => sections ?? [...PICK_SECTIONS];

	const applyPickOptions = (nextDetail: DetailLevel, nextSections: PickSection[]): void => {
		detail = nextDetail;
		sections = nextSections;
		optionsNotice = "";
		resnapshotPicked();
		renderHud();
		renderBar();
		void persistPickOptions();
	};

	const applyPreset = (id: string): void => {
		const preset = SECTION_PRESETS.find((p) => p.id === id);
		if (!preset) return;
		applyPickOptions(preset.depth, [...preset.sections]);
	};

	const resnapshotPicked = (): void => {
		let failed = 0;
		for (const p of picked) {
			if (!p.el.isConnected) continue;
			try {
				p.snapshot = snapshotElement(p.el, { detail, sections });
			} catch {
				failed++;
			}
		}
		if (failed > 0) showToast(`${failed}  elements failed to refresh; the previous data was kept`, "err");
	};

	async function persistPickOptions(): Promise<void> {
		let res: { ok?: boolean; detail?: DetailLevel; sections?: PickSection[] } | undefined;
		try {
			res = (await chrome.runtime.sendMessage({ type: "page-picker:set-sections", detail, sections })) as
				{ ok?: boolean; detail?: DetailLevel; sections?: PickSection[] } | undefined;
		} catch (error) {
			void error;
		}
		if (!res?.ok) {
			optionsNotice = "The extension settings could not be updated; this choice applies only on this page";
			renderBar();
			return;
		}

		if (res.detail) detail = res.detail;
		if (res.sections) sections = res.sections;
		renderHud();
		renderBar();
	}

	const setPhase = (next: Phase): void => {
		phase = next;
		if (next === "picking") hovered = null;
		renderHover();
		renderHud();
		renderBar();
	};

	const showToast = (text: string, kind: "ok" | "err" = "ok"): void => {
		toast.textContent = text;
		toast.className = `toast ${kind}`;
		window.setTimeout(() => toast.classList.add("hidden"), 3600);
	};

	const tick = (): void => {
		if (stopped) return;
		renderHover();
		renderPicks();
		rafId = window.requestAnimationFrame(tick);
	};

	const swallow = (e: Event): void => {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
	};

	const onPointerMove = (e: PointerEvent): void => {
		if (phase !== "picking") return;
		const target = e.target;
		if (!(target instanceof Element) || host.contains(target)) return;
		hovered = target;
	};

	const onMouseDown = (e: MouseEvent): void => {
		if (phase !== "picking") return;
		if (e.target instanceof Node && host.contains(e.target)) return;
		swallow(e);
	};

	const onClick = (e: MouseEvent): void => {
		if (phase !== "picking") return;
		const target = e.target;
		if (!(target instanceof Element) || host.contains(target)) return;
		swallow(e);
		pick(target);
		if (!e.shiftKey) setPhase("editing");
	};

	const pick = (target: Element): void => {
		if (picked.some((p) => p.el === target)) {
			showToast("This element is already selected", "err");
			return;
		}
		try {
			picked.push({ el: target, snapshot: snapshotElement(target, { detail, sections }), note: "" });
			renderHud();
			renderBar();
		} catch (err) {
			showToast(`Pick failed: ${err instanceof Error ? err.message : String(err)}`, "err");
		}
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.target instanceof Node && host.contains(e.target)) return;
		if (e.key === "Escape") {
			swallow(e);
			if (phase === "editing") setPhase("picking");
			else stop();
			return;
		}

		const presetIndex = presetHotkeyIndex(e);
		if (presetIndex > 0 && !isEditable(e.target)) {
			swallow(e);
			applyPreset(SECTION_PRESETS[presetIndex - 1].id);
			return;
		}

		if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && picked.length > 0) {
			swallow(e);
			void send();
			return;
		}
		if (phase !== "picking") return;
		if (e.key === "Enter" && picked.length > 0) {
			swallow(e);
			setPhase("editing");
		} else if (e.key === "Backspace" && picked.length > 0) {
			swallow(e);
			picked.pop();
			renderHud();
		}
	};

	const onContextMenu = (e: MouseEvent): void => {
		if (phase === "picking") swallow(e);
	};

	const onPageHide = (): void => {
		stop();
	};

	const buildPayload = (): PickPayload => ({
		id: makePickId(),
		pickedAt: new Date().toISOString(),
		page: pageContext(),
		detail,

		...(sections ? { sections } : {}),
		elements: picked.map((p) => ({
			snapshot: p.snapshot,
			...(p.note.trim() ? { note: p.note.trim() } : {}),
		})),
		...(note.trim() ? { note: note.trim() } : {}),
	});

	async function send(): Promise<void> {
		if (picked.length === 0) return;
		sendBtn.disabled = true;
		sendBtn.textContent = "Sending...";
		try {
			const res = (await chrome.runtime.sendMessage({ type: "page-picker:picked", payload: buildPayload() })) as
				{ ok?: boolean; message?: string; copy?: string } | undefined;
			if (res?.copy) await copyText(res.copy);
			showToast(res?.message ?? (res?.ok ? "Added to chat" : "Send failed"), res?.ok ? "ok" : "err");
			if (res?.ok) {
				stop();
				return;
			}
		} catch (err) {
			showToast(`Send failed: ${err instanceof Error ? err.message : String(err)}`, "err");
		}
		sendBtn.disabled = false;
		sendBtn.textContent = "Add to chat";
	}

	async function copyText(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			/* fall through */
		}
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.cssText = "position:fixed;left:-9999px;top:0;";
		(document.body ?? document.documentElement).appendChild(ta);
		ta.select();
		try {
			document.execCommand("copy");
		} catch (error) {
			void error;
		}
		ta.remove();
	}

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		window.cancelAnimationFrame(rafId);
		window.removeEventListener("pointermove", onPointerMove, true);
		window.removeEventListener("mousedown", onMouseDown, true);
		window.removeEventListener("click", onClick, true);
		window.removeEventListener("keydown", onKeyDown, true);
		window.removeEventListener("contextmenu", onContextMenu, true);
		window.removeEventListener("pagehide", onPageHide);
		host.remove();
		// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
		const w = window as unknown as Record<string, unknown>;
		if (w[FLAG] === runtime) delete w[FLAG];
	};

	const runtime: PickerRuntime & { start: (o?: { detail?: DetailLevel; sections?: PickSection[] }) => void } = {
		start(opts): void {
			if (!stopped) {
				showToast("Already in picking mode");
				return;
			}
			stopped = false;
			phase = "picking";
			picked = [];
			note = "";
			hovered = null;
			if (opts?.detail) detail = opts.detail;
			if (opts?.sections) sections = opts.sections;
			noteInput.value = "";
			presets.setPanelOpen(false);
			sendBtn.disabled = false;
			sendBtn.textContent = "Add to chat";
			(document.body ?? document.documentElement).append(host);
			renderHud();
			renderBar();
			renderHover();
			window.addEventListener("pointermove", onPointerMove, true);
			window.addEventListener("mousedown", onMouseDown, true);
			window.addEventListener("click", onClick, true);
			window.addEventListener("keydown", onKeyDown, true);
			window.addEventListener("contextmenu", onContextMenu, true);
			window.addEventListener("pagehide", onPageHide);
			rafId = window.requestAnimationFrame(tick);
		},
		destroy: stop,
	};

	sendBtn.addEventListener("click", () => void send());
	moreBtn.addEventListener("click", () => setPhase("picking"));
	cancelBtn.addEventListener("click", stop);
	noteInput.addEventListener("input", () => {
		note = noteInput.value;
	});
	noteInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") void send();
		if (e.key === "Escape") setPhase("picking");
	});

	return runtime;
}

// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
const w = window as unknown as Record<string, unknown>;
const existing = w[FLAG] as PickerRuntime | undefined;
const runtime = existing ?? createPicker();
w[FLAG] = runtime;

void (async () => {
	let detail: DetailLevel | undefined;
	let sections: PickSection[] | undefined;
	try {
		const res = (await chrome.runtime.sendMessage({ type: "page-picker:settings" })) as
			{ detail?: DetailLevel; sections?: PickSection[] } | undefined;
		detail = res?.detail;
		sections = res?.sections;
	} catch (error) {
		void error;
	}
	const startOpts: { detail?: DetailLevel; sections?: PickSection[] } = {};
	if (detail) startOpts.detail = detail;
	if (sections) startOpts.sections = sections;
	runtime.start(startOpts);
})();

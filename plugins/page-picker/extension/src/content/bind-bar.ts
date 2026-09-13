import "../chrome.d.ts";
import "../compat.js";
/// <reference lib="dom" />

import { bindView, type BindResult, type BindView } from "../shared/bind.js";
import { DEFAULT_SERVER_URL } from "../shared/settings.js";

const FLAG = "__piWebUiBindBar";
const HOST_ID = "pi-page-picker-bind-host";

interface BarRuntime {
	destroy: () => void;
}

async function pageLooksLikePiWebUi(): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 1200);
		const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
		clearTimeout(timer);
		if (res.ok) {
			const info = (await res.json()) as { ok?: unknown; piVersion?: unknown; engine?: unknown } | null;
			if (info && info.ok === true && (typeof info.piVersion === "string" || typeof info.engine === "string"))
				return true;
		}
	} catch (error) {
		void error;
	}
	return /pi-web-ui/i.test(document.title ?? "") && Boolean(document.querySelector(".inputbox textarea"));
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.card {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 10;
  width: min(620px, 92vw); padding: 14px 16px; border-radius: 10px; pointer-events: auto;
  background: rgba(17,24,39,.97); color: #e5e7eb; font-size: 13px; line-height: 1.55;
  box-shadow: 0 10px 34px rgba(0,0,0,.45);
}
.t { font-weight: 600; color: #93c5fd; margin-bottom: 4px; }
.d { color: #cbd5e1; word-break: break-all; }
.s { margin-top: 8px; }
.s.ok { color: #4ade80; }
.s.err { color: #f87171; }
.s.warn { color: #fbbf24; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.grow { flex: 1 1 auto; }
button {
  padding: 6px 11px; border-radius: 6px; border: 1px solid #374151; background: #1f2937;
  color: #e5e7eb; font-size: 12px; cursor: pointer;
}
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
button:hover { filter: brightness(1.15); }
button:disabled { opacity: .6; cursor: default; }
.hidden { display: none !important; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k === "text") node.textContent = v;
		else node.setAttribute(k, v);
	}
	return node;
}

function createBar(): BarRuntime & { render: (view: BindView) => void } {
	const host = el("div", { id: HOST_ID });
	host.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:2147483647;pointer-events:none;";
	const shadow = host.attachShadow({ mode: "open" });

	const title = el("div", { class: "t" });
	const detail = el("div", { class: "d" });
	const status = el("div", { class: "s hidden" });
	const bindBtn = el("button", { class: "primary", text: "Use as service URL" });
	const pickBtn = el("button", { text: "Pick elements on this page" });
	const authBtn = el("button", { class: "hidden", text: "Open options to authorize" });
	const closeBtn = el("button", { text: "Close" });
	const card = el("div", { class: "card hidden" });
	const foot = el("div", { class: "row" });
	foot.append(pickBtn, authBtn, el("span", { class: "grow" }), closeBtn, bindBtn);
	card.append(title, detail, status, foot);
	shadow.append(el("style", { text: CSS }), card);
	(document.body ?? document.documentElement).append(host);

	let destroyed = false;
	const destroy = (): void => {
		if (destroyed) return;
		destroyed = true;
		window.removeEventListener("keydown", onKeyDown, true);
		host.remove();
		// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
		const w = window as unknown as Record<string, unknown>;
		if (w[FLAG] === runtime) delete w[FLAG];
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") destroy();
	};

	const say = (text: string, kind: "ok" | "err" | "warn" | "info"): void => {
		status.textContent = text;
		status.className = `s ${kind === "info" ? "" : kind}`.trim();
	};

	const render = (view: BindView): void => {
		card.classList.remove("hidden");
		title.textContent = view.title;
		detail.textContent = view.detail;

		bindBtn.classList.toggle("hidden", view.same);
		bindBtn.textContent = view.same ? "" : (view.bindLabel ?? "Use as service URL");
		if (view.same) say(`Bound ${view.base}`, "ok");
	};
	const onBind = async (): Promise<void> => {
		bindBtn.disabled = true;
		bindBtn.textContent = "Binding...";
		let res: BindResult | undefined;
		try {
			res = (await chrome.runtime.sendMessage({ type: "page-picker:bind", url: location.href })) as
				BindResult | undefined;
		} catch (error) {
			void error;
		}
		if (!res) {
			say("Binding failed: the background did not respond; refresh and try again", "err");
			bindBtn.disabled = false;
			bindBtn.textContent = "Use as service URL";
			return;
		}
		say(res.message, res.ok ? "ok" : res.needAuth ? "warn" : "err");
		if (res.ok) {
			bindBtn.disabled = false;
			bindBtn.textContent = "Bound";
			bindBtn.classList.add("hidden");
			window.setTimeout(destroy, 2600);
			return;
		}

		if (res.needAuth) authBtn.classList.remove("hidden");
		bindBtn.disabled = false;
		bindBtn.textContent = "Retry binding";
	};

	bindBtn.addEventListener("click", () => void onBind());
	authBtn.addEventListener("click", () => {
		void chrome.runtime.sendMessage({ type: "page-picker:open-options", url: location.href });
	});
	pickBtn.addEventListener("click", () => {
		void chrome.runtime.sendMessage({ type: "page-picker:pick-anyway" });
		destroy();
	});
	closeBtn.addEventListener("click", destroy);
	window.addEventListener("keydown", onKeyDown, true);

	const runtime: BarRuntime & { render: (view: BindView) => void } = { destroy, render };

	return runtime;
}

// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
const w = window as unknown as Record<string, unknown>;
(w[FLAG] as BarRuntime | undefined)?.destroy();
const runtime = createBar();
w[FLAG] = runtime;

void (async () => {
	if (!(await pageLooksLikePiWebUi())) {
		runtime.destroy();
		try {
			await chrome.runtime.sendMessage({ type: "page-picker:pick-anyway" });
		} catch (error) {
			void error;
		}
		return;
	}
	let bound = "";
	try {
		const res = (await chrome.runtime.sendMessage({ type: "page-picker:settings" })) as
			{ serverUrl?: string } | undefined;
		bound = res?.serverUrl ?? "";
	} catch (error) {
		void error;
	}
	runtime.render(bindView(location.href, bound || DEFAULT_SERVER_URL));
})();

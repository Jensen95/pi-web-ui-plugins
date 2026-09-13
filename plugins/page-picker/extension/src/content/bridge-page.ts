/// <reference lib="dom" />

export interface BridgePageApi {
	version: number;

	self: string;

	peers: string[];

	on(op: string, handler: (args: unknown, ctx: { from: string }) => unknown): () => void;

	off(op: string): void;

	call(req: { op: string; args?: unknown; to?: string; timeoutMs?: number }): Promise<unknown>;
}

interface BridgePageInternal extends BridgePageApi {
	token: string;

	__builtin?: Record<string, (args: Record<string, unknown>) => unknown>;
	__invoke(op: unknown, args: unknown, from: unknown, builtin?: unknown): Promise<Record<string, unknown>>;
	__destroy(): void;
}

export interface BridgePageInstallResult {
	ok: boolean;
	reason?: "no-token" | "no-window";
	version?: number;
}

export function installBridgePage(options?: {
	peers?: unknown;
	self?: unknown;
	control?: unknown;
}): BridgePageInstallResult {
	// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
	const g = globalThis as unknown as Record<string, unknown>;
	const doc = (g as { document?: { documentElement?: { getAttribute?(name: string): string | null } } }).document;
	const el = doc?.documentElement;
	if (!el || typeof el.getAttribute !== "function") return { ok: false, reason: "no-window" };
	const token = el.getAttribute("data-pi-bridge") ?? "";
	if (!token) return { ok: false, reason: "no-token" };

	const VERSION = 1;
	const location = (g as { location?: { origin?: string } }).location;
	const self = typeof options?.self === "string" ? options.self : (location?.origin ?? "");
	const targetOrigin = location?.origin || self;
	const peerInput = options?.peers;
	const peers = Array.isArray(peerInput) ? peerInput.filter((x): x is string => typeof x === "string") : [];

	const control = options?.control === true;

	const existing = g.__piBridge as Partial<BridgePageInternal> | undefined;
	if (
		existing &&
		existing.version === VERSION &&
		typeof existing.__destroy === "function" &&
		(existing.__builtin !== undefined) === control
	) {
		existing.token = token;
		existing.peers = peers.slice();
		existing.self = self;
		return { ok: true, version: VERSION };
	}

	if (existing && typeof existing.__destroy === "function") {
		try {
			existing.__destroy();
		} catch (error) {
			void error;
		}
	}

	const handlers = new Map<string, (args: unknown, ctx: { from: string }) => unknown>();

	//

	//

	//

	const docAny = (g as { document?: Document }).document;
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	const num = (v: unknown, dflt: number, min: number, max: number): number => {
		const n = typeof v === "number" && isFinite(v) ? Math.round(v) : dflt;
		return Math.min(max, Math.max(min, n));
	};

	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

	const cut = (text: string, max: number): string =>
		text.length > max ? `${text.slice(0, max)}\n...[truncated; original length ${text.length} characters]` : text;

	const textOf = (node: Element | null): string => {
		if (!node) return "";
		const raw = (node as HTMLElement).innerText ?? node.textContent ?? "";
		return String(raw).replace(/\r/g, "").trim();
	};

	const brief = (node: Element, index: number): Record<string, unknown> => {
		const rect = node.getBoundingClientRect();
		const classes = node.classList ? [...node.classList].slice(0, 6) : [];
		const tag = node.tagName.toLowerCase();
		return {
			index,
			tag,
			...(node.id ? { id: node.id } : {}),
			...(classes.length > 0 ? { classes } : {}),
			text: cut(textOf(node).replace(/\s+/g, " "), 160),
			...(tag === "a" ? { href: (node as HTMLAnchorElement).href } : {}),
			...(tag === "input" || tag === "textarea"
				? {
						...((node as HTMLInputElement).type ? { type: (node as HTMLInputElement).type } : {}),
						value: (node as HTMLInputElement).value,
						...((node as HTMLInputElement).placeholder ? { placeholder: (node as HTMLInputElement).placeholder } : {}),
					}
				: {}),
			rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
		};
	};

	const find = (args: Record<string, unknown>): Element | null => {
		const selector = str(args.selector);
		if (!selector || !docAny) return null;
		const all = [...docAny.querySelectorAll(selector)];
		const index = num(args.index, 0, 0, Math.max(0, all.length - 1));
		return all[index] ?? null;
	};

	const setValue = (node: Element, text: string): void => {
		const tag = node.tagName.toLowerCase();
		if (tag === "input" || tag === "textarea") {
			const target = node as HTMLInputElement | HTMLTextAreaElement;
			const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (setter) setter.call(target, text);
			else target.value = text;
		} else {
			(node as HTMLElement).textContent = text;
		}
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const actions: Record<string, (args: Record<string, unknown>) => unknown> = {};

	actions["pages"] = () => ({ pages: peers.slice(), self });

	actions["metrics"] = () => {
		// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
		const win = g as unknown as {
			devicePixelRatio?: number;
			innerWidth?: number;
			innerHeight?: number;
			scrollX?: number;
			scrollY?: number;
		};
		return {
			dpr: win.devicePixelRatio ?? 1,
			vw: win.innerWidth ?? 0,
			vh: win.innerHeight ?? 0,
			sx: win.scrollX ?? 0,
			sy: win.scrollY ?? 0,
		};
	};

	actions["read"] = (args) => {
		const what = str(args.what) || "text";
		if (what === "title") return { title: docAny?.title ?? "" };
		if (what === "url") return { url: String((g as { location?: { href?: string } }).location?.href ?? "") };
		const selector = str(args.selector);
		if (what === "query") {
			if (!selector) return { error: "read what=query requires selector" };
			const all = [...(docAny?.querySelectorAll(selector) ?? [])];
			const limit = num(args.limit, 20, 1, 100);
			const picked = (args.all === false ? all.slice(0, 1) : all).slice(0, limit);
			return {
				selector,
				count: all.length,
				shown: picked.length,
				items: picked.map((node, i) => brief(node, i)),
			};
		}
		if (what === "html") {
			const node = selector ? (docAny?.querySelector(selector) ?? null) : (docAny?.documentElement ?? null);
			if (selector && !node) return { error: `Selector matched no elements: ${selector}` };
			return { html: cut(node?.outerHTML ?? "", 20000), selector: selector || null };
		}
		const node = selector ? (docAny?.querySelector(selector) ?? null) : (docAny?.body ?? null);
		if (selector && !node) return { error: `Selector matched no elements: ${selector}` };
		return { text: cut(textOf(node), 12000), selector: selector || null };
	};

	actions["click"] = (args) => {
		const selector = str(args.selector);
		if (!selector) return { error: "click requires selector" };
		const node = find(args);
		if (!node) return { error: `Selector matched no elements: ${selector}` };
		try {
			node.scrollIntoView({ block: "center", inline: "center" });
		} catch (error) {
			void error;
		}
		const asButton = node as HTMLElement;
		if (typeof asButton.click === "function") asButton.click();
		else {
			// SAFETY: The page global is the Window used to construct this browser event.
			node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: g as unknown as Window }));
		}
		return { clicked: true, selector, ...brief(node, 0) };
	};

	actions["type"] = (args) => {
		const selector = str(args.selector);
		if (!selector) return { error: "type requires selector" };
		const node = find(args);
		if (!node) return { error: `Selector matched no elements: ${selector}` };
		const text = typeof args.text === "string" ? args.text : "";
		const asInput = node as HTMLElement;
		try {
			asInput.focus();
		} catch (error) {
			void error;
		}
		setValue(node, args.clear === false ? `${(node as HTMLInputElement).value ?? ""}${text}` : text);
		if (args.submit === true) {
			for (const type of ["keydown", "keypress", "keyup"]) {
				node.dispatchEvent(
					new KeyboardEvent(type, {
						key: "Enter",
						code: "Enter",
						keyCode: 13,
						which: 13,
						bubbles: true,
						cancelable: true,
					}),
				);
			}
		}
		return {
			typed: true,
			selector,
			value: (node as HTMLInputElement).value ?? textOf(node),
			submitted: args.submit === true,
		};
	};

	actions["scroll"] = (args) => {
		const selector = str(args.selector);
		// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
		const win = g as unknown as {
			scrollTo: (x: number, y: number) => void;
			scrollBy: (x: number, y: number) => void;
			scrollX: number;
			scrollY: number;
		};
		if (selector) {
			const node = docAny?.querySelector(selector) ?? null;
			if (!node) return { error: `Selector matched no elements: ${selector}` };
			try {
				node.scrollIntoView({ block: "center", inline: "nearest" });
			} catch (error) {
				void error;
			}
		} else if (args.to && typeof args.to === "object") {
			const to = args.to as { x?: unknown; y?: unknown };
			win.scrollTo(num(to.x, win.scrollX, -1e9, 1e9), num(to.y, win.scrollY, -1e9, 1e9));
		} else if (args.by && typeof args.by === "object") {
			const by = args.by as { x?: unknown; y?: unknown };
			win.scrollBy(num(by.x, 0, -1e9, 1e9), num(by.y, 0, -1e9, 1e9));
		} else {
			return { error: "scroll requires one of selector, to, or by" };
		}
		return { scrolled: true, x: Math.round(win.scrollX), y: Math.round(win.scrollY) };
	};

	actions["goto"] = (args) => {
		const url = str(args.url);
		if (!url) return { error: "goto requires url" };

		setTimeout(() => {
			try {
				(g as { location?: { href?: string } }).location!.href = url;
			} catch (error) {
				void error;
			}
		}, 80);
		return { navigating: true, url };
	};

	actions["wait"] = async (args) => {
		const selector = str(args.selector);
		const text = typeof args.text === "string" ? args.text : "";
		if (!selector && !text) return { error: "wait requires selector or text" };
		const timeout = num(args.timeoutMs, 5000, 1, 30000);
		const started = Date.now();
		for (;;) {
			if (selector && docAny?.querySelector(selector)) {
				return { found: "selector", selector, waitedMs: Date.now() - started };
			}
			if (text && (docAny?.body ? textOf(docAny.body) : "").includes(text)) {
				return { found: "text", text, waitedMs: Date.now() - started };
			}
			if (Date.now() - started >= timeout) {
				return {
					found: null,
					waitedMs: Date.now() - started,
					note: `Waited  ${timeout}ms but it did not appear (the selector or text may be wrong, or an earlier click or input is required)`,
				};
			}
			await sleep(100);
		}
	};

	actions["eval"] = async (args) => {
		const code = typeof args.code === "string" ? args.code : "";
		if (!code.trim()) return { error: "eval requires code" };
		try {
			// eslint-disable-next-line no-eval -- this path is disabled unless the user explicitly enables eval.
			const value = await (0, eval)(code);
			return { value: plain(value) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				error: `${message}${
					/eval|unsafe-eval|Content Security Policy/i.test(message)
						? "This page blocks eval with CSP; use read, click, and type instead."
						: ""
				}`,
			};
		}
	};

	type PlainValue = null | boolean | number | string | PlainValue[] | { [key: string]: PlainValue };
	const plain = (value: unknown): PlainValue | undefined => {
		if (value === undefined) return undefined;
		try {
			const serialized = JSON.stringify(value);
			if (serialized === undefined) return undefined;
			// SAFETY: JSON serialization reduces the eval result to JSON-compatible values.
			return JSON.parse(serialized) as PlainValue;
		} catch (error) {
			void error;
			return String(value);
		}
	};

	let badgeHost: HTMLElement | null = null;
	let badgeTimer: ReturnType<typeof setTimeout> | undefined;
	const flashAction = (label: string): void => {
		const root0 = docAny?.documentElement;
		if (!root0) return;
		try {
			if (!badgeHost || !badgeHost.isConnected) {
				docAny?.getElementById("pi-ai-control-badge")?.remove();
				badgeHost = docAny!.createElement("div");
				badgeHost.id = "pi-ai-control-badge";
				badgeHost.style.cssText =
					"position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;" +
					"opacity:0;transition:opacity .25s ease";
				const shadow = badgeHost.attachShadow({ mode: "open" });
				const style = docAny!.createElement("style");
				style.textContent =
					".box{font:12px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
					"background:rgba(17,24,39,.94);color:#e5e7eb;padding:7px 11px;border-radius:8px;" +
					"border-left:3px solid #6366f1;box-shadow:0 6px 20px rgba(0,0,0,.35);" +
					"max-width:min(360px,80vw);word-break:break-all}" +
					".t{color:#a5b4fc;font-weight:600;margin-right:6px}" +
					".d{color:#cbd5e1}";
				const box = docAny!.createElement("div");
				box.className = "box";
				const who = docAny!.createElement("span");
				who.className = "t";
				who.textContent = "AI is operating this page";
				const detail = docAny!.createElement("span");
				detail.className = "d";
				box.append(who, detail);
				shadow.append(style, box);
				root0.append(badgeHost);
			}
			const detail = badgeHost.shadowRoot?.querySelector<HTMLElement>(".d");
			if (detail) detail.textContent = label;
			badgeHost.style.opacity = "1";
			if (badgeTimer) clearTimeout(badgeTimer);
			badgeTimer = setTimeout(() => {
				if (badgeHost) badgeHost.style.opacity = "0";
			}, 2200);
		} catch (error) {
			void error;
		}
	};

	const builtinOps: Record<string, (args: Record<string, unknown>) => unknown> | undefined = control
		? actions
		: undefined;
	let pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	let seq = 0;

	let api: BridgePageInternal;
	const onMessage = (e: { data?: unknown }): void => {
		const data = e?.data;
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (!api || msg.__piBridge !== api.token) return;
		if (msg.kind !== "result") return;
		const id = String(msg.id);
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		if (msg.ok === true) entry.resolve(msg.value);
		else entry.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "Peer call failed"));
	};

	const listeners = g as {
		addEventListener?(type: string, cb: unknown): void;
		removeEventListener?(type: string, cb: unknown): void;
	};
	listeners.addEventListener?.call(g, "message", onMessage);

	const call = (req: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const r = (req && typeof req === "object" ? req : {}) as Record<string, unknown>;
			const op = typeof r.op === "string" ? r.op.trim() : "";
			if (!op) {
				reject(new Error("call({ op }) requires an operation name"));
				return;
			}
			const rawTimeout = typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) ? r.timeoutMs : 5000;
			const timeout = Math.min(30000, Math.max(1, Math.round(rawTimeout)));
			const id = `c${++seq}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`The peer did not respond within ${timeout}ms (op: ${op})`));
			}, timeout);
			pending.set(id, { resolve, reject, timer });
			try {
				const to = typeof r.to === "string" && r.to.trim() ? r.to.trim() : undefined;
				(g.postMessage as (message: unknown, targetOrigin: string) => void).call(
					g,
					{
						__piBridge: api.token,
						kind: "call",
						id,
						op,
						...(r.args === undefined ? {} : { args: r.args }),
						...(to ? { to } : {}),
						timeoutMs: timeout,
					},
					targetOrigin,
				);
			} catch (err) {
				pending.delete(id);
				clearTimeout(timer);
				reject(
					new Error(
						`Arguments cannot be sent: ${err instanceof Error ? err.message : String(err)} (only plain data can cross the page boundary)`,
					),
				);
			}
		});

	const invoke = async (
		op: unknown,
		args: unknown,
		from: unknown,
		builtin?: unknown,
	): Promise<Record<string, unknown>> => {
		const name = typeof op === "string" ? op.trim() : "";
		if (!name) return { ok: false, error: "Missing operation name (op)", code: "bad-op" };
		if (builtin === true) {
			const fn = builtinOps?.[name];
			if (!fn) {
				return {
					ok: false,
					code: "no-handler",
					error: `Unsupported action "${name}" (supported: ${Object.keys(actions).join(", ")})`,
				};
			}

			const a = (args ?? {}) as Record<string, unknown>;
			const hint = str(a.selector) || str(a.what) || str(a.url) || str(a.text);
			flashAction(hint ? `${name} · ${cut(hint, 60)}` : name);
			try {
				const out = await fn((args ?? {}) as Record<string, unknown>);
				if (out && typeof out === "object" && "error" in (out as Record<string, unknown>)) {
					const err = (out as Record<string, unknown>).error;
					return { ok: false, code: "op-failed", error: typeof err === "string" ? err : "Action failed" };
				}
				return out === undefined ? { ok: true } : { ok: true, value: plain(out) };
			} catch (err) {
				return {
					ok: false,
					code: "op-failed",
					error: `Action ${name}  threw: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		const handler = handlers.get(name);
		if (!handler) {
			const known = [...handlers.keys()];
			return {
				ok: false,
				code: "no-handler",
				error: `The peer page did not register "${name}"${known.length > 0 ? ` -- it registered: ${known.join(", ")}` : " -- it has no registered actions"}`,
			};
		}
		let value: unknown;
		try {
			value = await handler(args, { from: typeof from === "string" ? from : "" });
		} catch (err) {
			return { ok: false, error: `The peer's "${name}"  threw: ${err instanceof Error ? err.message : String(err)}` };
		}
		if (value !== undefined) {
			try {
				JSON.stringify(value);
			} catch (err) {
				return {
					ok: false,
					error: `The result of "${name}" cannot be transferred: ${err instanceof Error ? err.message : String(err)} (only plain data can cross the page boundary)`,
				};
			}
		}
		return value === undefined ? { ok: true } : { ok: true, value };
	};

	const destroy = (): void => {
		listeners.removeEventListener?.call(g, "message", onMessage);

		try {
			badgeHost?.remove();
			badgeHost = null;
		} catch (error) {
			void error;
		}
		const held = pending;
		pending = new Map();
		for (const entry of held.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("The page bridge was unloaded"));
		}
		handlers.clear();
		if (g.__piBridge === api) delete g.__piBridge;
	};

	api = {
		version: VERSION,
		self,
		peers: peers.slice(),
		token,
		...(builtinOps ? { __builtin: builtinOps } : {}),
		on(op, handler) {
			if (typeof op !== "string" || !op.trim() || typeof handler !== "function") {
				throw new Error("on(op, handler): op must be a non-empty string and handler must be a function");
			}
			const name = op.trim();
			handlers.set(name, handler);
			return () => {
				handlers.delete(name);
			};
		},
		off(op) {
			handlers.delete(String(op).trim());
		},
		call,
		__invoke: invoke,
		__destroy: destroy,
	};
	g.__piBridge = api;
	return { ok: true, version: VERSION };
}

export async function invokeBridgeHandler(req?: {
	op?: unknown;
	args?: unknown;
	from?: unknown;

	builtin?: unknown;
}): Promise<{ ok: boolean; value?: unknown; error?: string; code?: string }> {
	// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
	const g = globalThis as unknown as Record<string, unknown>;
	const api = g.__piBridge as Partial<BridgePageInternal> | undefined;
	if (!api || typeof api.__invoke !== "function") {
		return {
			ok: false,
			code: "no-bridge",
			error: "The peer page does not have a bridge yet (it may have just navigated); refresh it and try again",
		};
	}
	if (req?.builtin === true && !api.__builtin) {
		return {
			ok: false,
			code: "no-control",
			error:
				'This page is not authorized for AI control; authorize it under "AI page control" in the extension options',
		};
	}
	try {
		const res = (await api.__invoke(req?.op, req?.args, req?.from, req?.builtin)) as
			Record<string, unknown> | undefined;
		if (!res || typeof res !== "object") return { ok: false, error: "The peer bridge returned an unexpected result" };
		if (res.ok === true) return res.value === undefined ? { ok: true } : { ok: true, value: res.value };
		return {
			ok: false,
			error: typeof res.error === "string" && res.error ? res.error : "Peer call failed",
			...(typeof res.code === "string" ? { code: res.code } : {}),
		};
	} catch (err) {
		return { ok: false, error: `Peer bridge error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export function uninstallBridgePage(): { ok: boolean } {
	// SAFETY: Browser globals and framework metadata are dynamic at this checked boundary.
	const g = globalThis as unknown as Record<string, unknown>;
	const api = g.__piBridge as { __destroy?: () => void } | undefined;
	if (api && typeof api.__destroy === "function") {
		try {
			api.__destroy();
		} catch (error) {
			void error;
		}
	}
	const doc = (g as { document?: { documentElement?: { removeAttribute?(name: string): void } } }).document;
	try {
		doc?.documentElement?.removeAttribute?.call(doc.documentElement, "data-pi-bridge");
	} catch (error) {
		void error;
	}
	return { ok: true };
}

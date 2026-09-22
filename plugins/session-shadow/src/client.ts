import { normalizeIdentity, type Identity, type StatePayload } from "./protocol.js";

export const IDENTITY_KEY = "session-shadow.identity.v1";

interface ViewContext {
	send(payload: unknown): void;
	onData(handler: (payload: unknown) => void): () => void;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function readIdentity(storage: StorageLike | undefined): Identity | null {
	if (!storage) return null;
	try {
		return normalizeIdentity(JSON.parse(storage.getItem(IDENTITY_KEY) ?? "null"));
	} catch {
		return null;
	}
}

function storageFor(container: HTMLElement): StorageLike | undefined {
	try {
		return container.ownerDocument.defaultView?.localStorage;
	} catch {
		return undefined;
	}
}

function create(document: Document, tag: string, text?: string, className?: string): HTMLElement {
	const element = document.createElement(tag);
	if (text !== undefined) element.textContent = text;
	if (className) element.className = className;
	return element;
}

function style(document: Document): HTMLElement {
	return create(
		document,
		"style",
		`.session-shadow{display:grid;grid-template-rows:auto minmax(0,1fr) minmax(150px,.65fr);height:100%;gap:10px;padding:10px;box-sizing:border-box;color:inherit}.session-shadow h2,.session-shadow h3,.session-shadow p{margin:0}.session-shadow__head{display:grid;gap:7px}.session-shadow select,.session-shadow input,.session-shadow textarea,.session-shadow button{font:inherit}.session-shadow select,.session-shadow input,.session-shadow textarea{width:100%;box-sizing:border-box;padding:7px;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:7px;background:transparent;color:inherit}.session-shadow__scroll{overflow:auto;display:grid;align-content:start;gap:7px}.session-shadow__item{padding:7px 9px;border-radius:7px;background:color-mix(in srgb,currentColor 6%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}.session-shadow__meta{font-size:.78rem;opacity:.7}.session-shadow__chat{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-height:0;gap:7px;border-top:1px solid color-mix(in srgb,currentColor 18%,transparent);padding-top:9px}.session-shadow__form{display:grid;grid-template-columns:1fr auto;gap:6px}.session-shadow__form textarea{min-height:54px;resize:vertical}.session-shadow__form button{padding:6px 10px}.session-shadow__notice{font-size:.82rem;opacity:.75}.session-shadow__error{color:#c9372c}.session-shadow__settings{display:grid;gap:12px;max-width:560px}.session-shadow__settings label{display:grid;gap:5px}.session-shadow__settings button{width:max-content;padding:7px 12px}`,
	);
}

function isSettingsSurface(container: HTMLElement): boolean {
	return typeof container.closest === "function" && container.closest(".plugin-page") !== null;
}

function mountSettings(container: HTMLElement): () => void {
	const document = container.ownerDocument;
	const storage = storageFor(container);
	const identity = readIdentity(storage);
	const root = create(document, "section", undefined, "session-shadow__settings");
	const title = create(document, "h1", "Session Shadow identity");
	const hint = create(document, "p", "This identity is stored in this browser and attached to window-chat messages.");
	const form = create(document, "form");
	form.className = "session-shadow__settings";
	const nameLabel = create(document, "label");
	nameLabel.append(create(document, "span", "Display name"));
	const name = document.createElement("input");
	name.type = "text";
	name.value = identity?.name ?? "";
	name.dataset.field = "name";
	const emailLabel = create(document, "label");
	emailLabel.append(create(document, "span", "Email"));
	const email = document.createElement("input");
	email.type = "email";
	email.value = identity?.email ?? "";
	email.dataset.field = "email";
	nameLabel.append(name);
	emailLabel.append(email);
	const save = create(document, "button", "Save identity") as HTMLButtonElement;
	save.type = "submit";
	const status = create(document, "p", "", "session-shadow__notice");
	status.setAttribute("aria-live", "polite");
	form.append(nameLabel, emailLabel, save, status);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const next = normalizeIdentity({ name: name.value, email: email.value });
		if (!next) {
			status.className = "session-shadow__error";
			status.textContent = "Enter a display name and a valid email address.";
			return;
		}
		try {
			storage?.setItem(IDENTITY_KEY, JSON.stringify(next));
			if (!storage) throw new Error("Browser storage unavailable");
			status.className = "session-shadow__notice";
			status.textContent = "Identity saved in this browser.";
		} catch (error) {
			status.className = "session-shadow__error";
			status.textContent = error instanceof Error ? error.message : String(error);
		}
	});
	root.append(style(document), title, hint, form);
	container.replaceChildren(root);
	return () => container.replaceChildren();
}

function mountPanel(container: HTMLElement, ctx: ViewContext): () => void {
	const document = container.ownerDocument;
	const storage = storageFor(container);
	let state: StatePayload = { kind: "state", activeSessionId: null, sessions: [], session: null };
	let error = "";

	const render = (): void => {
		const identity = readIdentity(storage);
		const root = create(document, "section", undefined, "session-shadow");
		const head = create(document, "header", undefined, "session-shadow__head");
		head.append(create(document, "h2", "Session Shadow"));
		const select = document.createElement("select");
		select.dataset.field = "session";
		if (!state.sessions.length) {
			const option = document.createElement("option");
			option.textContent = "No session observed";
			option.value = "";
			select.append(option);
			select.disabled = true;
		} else {
			for (const session of state.sessions) {
				const option = document.createElement("option");
				option.value = session.id;
				option.textContent = `${session.isStreaming ? "● " : ""}${session.title}`;
				select.append(option);
			}
			select.value = state.session?.id ?? state.activeSessionId ?? state.sessions[0]?.id ?? "";
		}
		select.addEventListener("change", () => {
			if (select.value) ctx.send({ action: "get_session", sessionId: select.value });
		});
		head.append(select);
		if (error) head.append(create(document, "p", error, "session-shadow__error"));

		const activity = create(document, "div", undefined, "session-shadow__scroll");
		activity.append(create(document, "h3", state.session?.isStreaming ? "Activity · Live" : "Activity"));
		if (!state.session?.activity.length) activity.append(create(document, "p", "No observed activity yet."));
		for (const item of state.session?.activity ?? []) {
			const row = create(document, "article", undefined, "session-shadow__item");
			row.append(create(document, "div", item.kind.replace("-", " "), "session-shadow__meta"));
			row.append(create(document, "div", item.text));
			activity.append(row);
		}

		const chat = create(document, "section", undefined, "session-shadow__chat");
		chat.append(create(document, "h3", "Window chat"));
		const chatLog = create(document, "div", undefined, "session-shadow__scroll");
		chatLog.setAttribute("aria-live", "polite");
		if (!state.session?.chat.length) chatLog.append(create(document, "p", "No window-chat messages yet."));
		for (const item of state.session?.chat ?? []) {
			const row = create(document, "article", undefined, "session-shadow__item");
			row.append(create(document, "div", `${item.name} · ${item.email}`, "session-shadow__meta"));
			row.append(create(document, "div", item.text));
			chatLog.append(row);
		}
		chat.append(chatLog);

		const form = create(document, "form", undefined, "session-shadow__form");
		const input = document.createElement("textarea");
		input.dataset.field = "chat";
		input.disabled = !identity || !state.session;
		const send = create(document, "button", "Send") as HTMLButtonElement;
		send.type = "submit";
		send.disabled = input.disabled;
		form.append(input, send);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const currentIdentity = readIdentity(storage);
			if (!currentIdentity || !state.session || !input.value.trim()) return;
			ctx.send({
				action: "post_chat",
				sessionId: state.session.id,
				identity: currentIdentity,
				text: input.value.trim(),
			});
			input.value = "";
		});
		chat.append(form);
		if (!identity) {
			chat.append(
				create(
					document,
					"p",
					"Open Session Shadow settings and save your name and email to chat.",
					"session-shadow__notice",
				),
			);
		}

		root.append(style(document), head, activity, chat);
		container.replaceChildren(root);
	};

	const off = ctx.onData((payload) => {
		if (!payload || typeof payload !== "object") return;
		const message = payload as Record<string, unknown>;
		if (message.kind === "state") {
			// SAFETY: plugin data reaches this branch only for the server's StatePayload discriminator.
			state = message as unknown as StatePayload;
			error = "";
			render();
		} else if (message.kind === "result" && message.ok === false) {
			error = typeof message.error === "string" ? message.error : "The request failed.";
			render();
		}
	});
	render();
	ctx.send({ action: "state" });
	return () => {
		off();
		container.replaceChildren();
	};
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		return isSettingsSurface(container) ? mountSettings(container) : mountPanel(container, ctx);
	},
};

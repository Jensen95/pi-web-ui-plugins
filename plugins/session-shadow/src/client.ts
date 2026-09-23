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
	const css = `
		.session-shadow {
			display: grid;
			grid-template-rows: auto minmax(120px, 1fr) minmax(170px, .75fr);
			height: 100%;
			min-height: 0;
			gap: 9px;
			padding: 10px;
			box-sizing: border-box;
			color: inherit;
		}
		.session-shadow h2, .session-shadow h3, .session-shadow p { margin: 0; }
		.session-shadow__head { display: grid; gap: 7px; }
		.session-shadow__title { font-size: 1.05rem; letter-spacing: .01em; }
		.session-shadow__intro, .session-shadow__notice { font-size: .8rem; opacity: .78; }
		.session-shadow__session-label { display: grid; gap: 4px; font-size: .78rem; font-weight: 600; }
		.session-shadow select, .session-shadow input, .session-shadow textarea, .session-shadow button { font: inherit; }
		.session-shadow select, .session-shadow input, .session-shadow textarea {
			width: 100%; box-sizing: border-box; padding: 8px;
			border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
			border-radius: 8px; background: transparent; color: inherit;
		}
		.session-shadow select option { color: CanvasText; background: Canvas; }
		.session-shadow :is(select, input, textarea, button):focus-visible {
			position: relative; z-index: 1; outline: 2px solid currentColor; outline-offset: 2px;
		}
		.session-shadow__activity {
			display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; gap: 8px; padding: 10px;
			border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 12px;
			background: color-mix(in srgb, currentColor 4%, transparent);
		}
		.session-shadow__activity-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.session-shadow__activity h3 { font-size: .95rem; }
		.session-shadow__status { display: inline-flex; align-items: center; gap: 6px; font-size: .76rem; font-weight: 650; }
		.session-shadow__status::before { width: 8px; height: 8px; border-radius: 50%; background: #858b96; content: ""; }
		.session-shadow__status[data-status=live]::before { background: #18864b; }
		.session-shadow__scroll { display: grid; align-content: start; gap: 7px; min-height: 0; overflow: auto; }
		.session-shadow__item {
			padding: 8px 9px; border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
			border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent);
			white-space: pre-wrap; overflow-wrap: anywhere;
		}
		.session-shadow__meta { margin-bottom: 3px; font-size: .74rem; font-weight: 650; opacity: .78; }
		.session-shadow__chat {
			display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; min-height: 0; gap: 7px;
			border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding-top: 9px;
		}
		.session-shadow__chat-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
		.session-shadow__chat h3 { font-size: .88rem; }
		.session-shadow__chat-hint { font-size: .73rem; opacity: .72; }
		.session-shadow__chat-log { padding: 2px 0; }
		.session-shadow__chat .session-shadow__item { background: color-mix(in srgb, currentColor 3%, transparent); }
		.session-shadow__form { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 6px; }
		.session-shadow__form textarea { min-height: 48px; max-height: 120px; resize: vertical; }
		.session-shadow__count { grid-column: 1 / -1; justify-self: end; font-size: .72rem; opacity: .72; }
		.session-shadow__form button, .session-shadow__settings button {
			padding: 7px 11px; border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
			border-radius: 8px; background: color-mix(in srgb, currentColor 10%, transparent);
			color: inherit; font-weight: 650; cursor: pointer;
		}
		.session-shadow__form button:hover, .session-shadow__settings button:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
		.session-shadow button:disabled { opacity: .55; cursor: not-allowed; }
		.session-shadow__feedback {
			padding: 5px 8px; border-inline-start: 3px solid color-mix(in srgb, currentColor 55%, transparent);
			font-size: .8rem;
		}
		.session-shadow__feedback[data-tone=error] { border-inline-start-color: #c9372c; font-weight: 600; }
		.session-shadow__feedback[data-tone=success] { border-inline-start-color: #18864b; }
		.session-shadow__settings { display: grid; gap: 12px; max-width: 560px; }
		.session-shadow__settings label { display: grid; gap: 5px; }
		.session-shadow__settings button { width: max-content; }
		.session-shadow__error { color: inherit; border-inline-start: 3px solid #c9372c; padding-inline-start: 8px; }
		@media (max-width: 520px) {
			.session-shadow { grid-template-rows: auto minmax(150px, 1fr) minmax(185px, .85fr); gap: 8px; padding: 8px; }
			.session-shadow__activity { padding: 8px; }
			.session-shadow__form { grid-template-columns: minmax(0, 1fr) auto; }
			.session-shadow__form button { padding-inline: 9px; }
		}
		@media (max-width: 340px) {
			.session-shadow__chat-head { align-items: flex-start; flex-direction: column; gap: 2px; }
			.session-shadow__form { grid-template-columns: 1fr; }
			.session-shadow__form button { justify-self: end; }
		}
	`;
	return create(document, "style", css);
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
	let selectedSessionId: string | null = null;
	let previousActiveSessionId: string | null = null;
	let draft = "";
	let requestSequence = 0;
	const pendingSubmissions = new Map<string, string>();
	let feedback: { tone: "pending" | "success" | "error"; text: string } | null = null;
	let currentInput: HTMLTextAreaElement | null = null;
	let currentActivityLog: HTMLElement | null = null;
	let currentChatLog: HTMLElement | null = null;
	let renderedSessionId: string | null = null;

	const render = (): void => {
		const identity = readIdentity(storage);
		const session = state.session?.id === selectedSessionId ? state.session : null;
		const isLive = Boolean(session && session.id === state.activeSessionId && session.isStreaming);
		const restoreFocus = currentInput !== null && document.activeElement === currentInput;
		const selection = restoreFocus ? [currentInput?.selectionStart, currentInput?.selectionEnd] : [];
		const sameRoom = renderedSessionId === session?.id;
		const activityScroll = sameRoom ? currentActivityLog?.scrollTop : 0;
		const chatScroll = sameRoom ? currentChatLog?.scrollTop : 0;
		const root = create(document, "section", undefined, "session-shadow");
		root.setAttribute("aria-label", "Session Shadow observer");

		const head = create(document, "header", undefined, "session-shadow__head");
		head.append(create(document, "h2", "Session Shadow", "session-shadow__title"));
		head.append(create(document, "p", "Read-only agent activity and human observer chat.", "session-shadow__intro"));
		const sessionLabel = create(document, "label", undefined, "session-shadow__session-label");
		sessionLabel.append(create(document, "span", "Browse observed sessions"));
		const select = document.createElement("select");
		select.dataset.field = "session";
		if (!state.sessions.length) {
			const option = document.createElement("option");
			option.textContent = "No session observed";
			option.value = "";
			select.append(option);
			select.disabled = true;
		} else {
			for (const item of state.sessions) {
				const option = document.createElement("option");
				option.value = item.id;
				option.textContent = item.title;
				select.append(option);
			}
			select.value = selectedSessionId ?? state.activeSessionId ?? state.sessions[0]?.id ?? "";
		}
		sessionLabel.append(select);
		select.addEventListener("change", () => {
			selectedSessionId = select.value || null;
			if (state.session?.id !== selectedSessionId) state = { ...state, session: null };
			render();
			if (selectedSessionId) ctx.send({ action: "get_session", sessionId: selectedSessionId });
		});
		head.append(sessionLabel);

		const activity = create(document, "section", undefined, "session-shadow__activity");
		activity.setAttribute("aria-label", "Observed agent activity");
		const activityHead = create(document, "div", undefined, "session-shadow__activity-head");
		activityHead.append(create(document, "h3", "Agent activity"));
		const status = create(
			document,
			"span",
			!session
				? selectedSessionId
					? "Loading room"
					: "Waiting for a session"
				: isLive
					? "Live · Agent responding"
					: "Paused · No active response",
			"session-shadow__status",
		);
		status.dataset.status = !session ? "waiting" : isLive ? "live" : "paused";
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		activityHead.append(status);
		activity.append(activityHead);
		const activityLog = create(document, "div", undefined, "session-shadow__scroll");
		if (!session?.activity.length) {
			activityLog.append(
				create(document, "p", session ? "No observed activity yet." : "Choose a session to view its activity."),
			);
		}
		for (const item of session?.activity ?? []) {
			const row = create(document, "article", undefined, "session-shadow__item");
			row.append(create(document, "div", item.kind.replace("-", " "), "session-shadow__meta"));
			row.append(create(document, "div", item.text));
			activityLog.append(row);
		}
		activity.append(activityLog);

		const chat = create(document, "section", undefined, "session-shadow__chat");
		chat.setAttribute("aria-label", "Observer chat");
		const chatHead = create(document, "div", undefined, "session-shadow__chat-head");
		chatHead.append(create(document, "h3", "Observer chat"));
		chatHead.append(create(document, "span", "Human-to-human only", "session-shadow__chat-hint"));
		const chatLog = create(document, "div", undefined, "session-shadow__scroll session-shadow__chat-log");
		chatLog.setAttribute("role", "log");
		chatLog.setAttribute("aria-label", "Observer chat messages");
		chatLog.setAttribute("aria-live", "polite");
		chatLog.setAttribute("aria-relevant", "additions text");
		if (!session?.chat.length) chatLog.append(create(document, "p", "No observer messages yet."));
		for (const item of session?.chat ?? []) {
			const row = create(document, "article", undefined, "session-shadow__item");
			row.append(create(document, "div", `${item.name} · ${item.email}`, "session-shadow__meta"));
			row.append(create(document, "div", item.text));
			chatLog.append(row);
		}
		chat.append(chatHead, chatLog);

		if (feedback) {
			const message = create(
				document,
				"p",
				feedback.text,
				`session-shadow__feedback session-shadow__feedback--${feedback.tone}`,
			);
			message.dataset.tone = feedback.tone;
			message.setAttribute("role", feedback.tone === "error" ? "alert" : "status");
			message.setAttribute("aria-live", feedback.tone === "error" ? "assertive" : "polite");
			chat.append(message);
		}
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

		const form = create(document, "form", undefined, "session-shadow__form");
		form.setAttribute("aria-label", "Send a message to observers");
		const input = document.createElement("textarea");
		input.dataset.field = "chat";
		input.setAttribute("aria-label", "Message to observers");
		input.setAttribute("placeholder", "Write a message…");
		input.setAttribute("maxlength", "2000");
		input.value = draft;
		input.disabled = !identity || !session;
		const count = create(document, "span", `${draft.length} / 2,000`, "session-shadow__count");
		input.addEventListener("input", () => {
			draft = input.value;
			count.textContent = `${draft.length} / 2,000`;
		});
		const send = create(document, "button", "Send") as HTMLButtonElement;
		send.type = "submit";
		send.setAttribute("aria-label", "Send observer message");
		send.disabled = input.disabled;
		form.append(input, send, count);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const currentIdentity = readIdentity(storage);
			const currentSession = state.session?.id === selectedSessionId ? state.session : null;
			const submittedDraft = input.value;
			const text = submittedDraft.trim();
			if (!currentIdentity || !currentSession || !text) return;
			draft = submittedDraft;
			const requestId = `session-shadow-${++requestSequence}`;
			pendingSubmissions.set(requestId, submittedDraft);
			feedback = { tone: "pending", text: "Sending message…" };
			render();
			ctx.send({
				action: "post_chat",
				requestId,
				sessionId: currentSession.id,
				identity: currentIdentity,
				text,
			});
		});
		chat.append(form);

		root.append(style(document), head, activity, chat);
		container.replaceChildren(root);
		currentInput = input;
		currentActivityLog = activityLog;
		currentChatLog = chatLog;
		renderedSessionId = session?.id ?? null;
		activityLog.scrollTop = activityScroll ?? 0;
		chatLog.scrollTop = chatScroll ?? 0;
		if (restoreFocus && !input.disabled) {
			input.focus();
			if (typeof selection[0] === "number" && typeof selection[1] === "number") {
				input.setSelectionRange?.(selection[0], selection[1]);
			}
		}
	};

	const off = ctx.onData((payload) => {
		if (!payload || typeof payload !== "object") return;
		const message = payload as Record<string, unknown>;
		if (message.kind === "state") {
			// SAFETY: plugin data reaches this branch only for the server's StatePayload discriminator.
			const incoming = message as unknown as StatePayload;
			const followsActive = selectedSessionId === null || selectedSessionId === previousActiveSessionId;
			if (followsActive) selectedSessionId = incoming.activeSessionId;
			if (selectedSessionId && !incoming.sessions.some((item) => item.id === selectedSessionId)) {
				selectedSessionId = incoming.activeSessionId ?? incoming.sessions[0]?.id ?? null;
			}
			const selectedRoom =
				incoming.session?.id === selectedSessionId
					? incoming.session
					: state.session?.id === selectedSessionId
						? state.session
						: null;
			state = { ...incoming, session: selectedRoom };
			previousActiveSessionId = incoming.activeSessionId;
			if (feedback?.tone === "pending") feedback = null;
			render();
		} else if (message.kind === "result") {
			const requestId = typeof message.requestId === "string" ? message.requestId : "";
			const submittedDraft = pendingSubmissions.get(requestId);
			if (submittedDraft !== undefined) {
				pendingSubmissions.delete(requestId);
				if (message.ok === true) {
					if (draft === submittedDraft) draft = "";
					feedback = { tone: "success", text: "Message sent." };
				} else {
					feedback = {
						tone: "error",
						text: `Could not send message: ${typeof message.error === "string" ? message.error : "The request failed."}`,
					};
				}
			} else if (message.ok === false) {
				feedback = {
					tone: "error",
					text: typeof message.error === "string" ? message.error : "The request failed.",
				};
			} else {
				return;
			}
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

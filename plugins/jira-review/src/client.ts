import type { JiraReview, JiraTicket } from "./index";

const DEFAULT_READY_JQL = 'assignee IS EMPTY AND statusCategory = "To Do"';

interface StartChatHost {
	startChat?: (options: { prompt: string; newChat?: boolean }) => boolean;
}

interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

interface ReviewState {
	configured?: boolean;
	config?: { siteUrl?: string; email?: string; boardId?: string; readyJql?: string };
	folders?: string[];
	tickets?: JiraTicket[];
	reviews?: Record<string, JiraReview>;
	activeSprint?: { id: number; name: string; state: string } | null;
	error?: string;
	notice?: string;
}

export function buildReviewPrompt(ticket: JiraTicket, folders: readonly string[] = []): string {
	const scope = folders.length ? folders.join(", ") : "the workspace";
	const details = JSON.stringify(
		{
			key: ticket.key,
			summary: ticket.summary,
			status: ticket.status,
			description: ticket.description,
			assignee: ticket.assignee ?? null,
			labels: ticket.labels ?? [],
		},
		null,
		2,
	);
	return [
		"Review this Jira ticket for implementation readiness.",
		"Do not post anything to Jira. Save the completed review with the jira_review_save tool.",
		"",
		details,
		`Inspect relevant files in: ${scope}.`,
		"Return every required review field: ready (boolean), difficulty (easy|medium|hard), confidence (high|medium|low), rationale, missingInfo, implementationPlan, draftComment, and confidenceSuggestions.",
	].join("\n");
}

export function startTicketReviews(
	host: StartChatHost | null | undefined,
	tickets: readonly JiraTicket[],
	folders: readonly string[] = [],
	ticketFolders: Record<string, readonly string[]> = {},
): number {
	if (!host || typeof host.startChat !== "function") return 0;
	let started = 0;
	for (const ticket of tickets) {
		try {
			const selected = ticketFolders[ticket.key] ?? folders;
			if (host.startChat({ prompt: buildReviewPrompt(ticket, selected), newChat: true }) !== false) started += 1;
		} catch {
			// A missing browser bridge should not break the Jira view.
		}
	}
	return started;
}

function makeElement(document: Document, tag: string, text?: string): HTMLElement {
	const element = document.createElement(tag);
	if (text !== undefined) element.textContent = text;
	return element;
}

function field(document: Document, name: string, value = "", type = "text"): HTMLInputElement {
	const input = document.createElement("input");
	input.type = type;
	input.dataset.field = name;
	input.value = value;
	return input;
}

function textArea(document: Document, name: string, value = ""): HTMLTextAreaElement {
	const input = document.createElement("textarea");
	input.dataset.field = name;
	input.value = value;
	return input;
}

function textList(value: readonly string[] | undefined): string {
	return value?.length ? value.join("; ") : "none";
}

function renderReview(document: Document, key: string, review: JiraReview): HTMLElement {
	const panel = makeElement(document, "div");
	panel.dataset.review = key;
	panel.dataset.confidence = review.confidence;
	panel.className = "jira-review__saved";
	panel.append(
		makeElement(document, "p", `Ready: ${review.ready ? "yes" : "no"}`),
		makeElement(document, "p", `Difficulty: ${review.difficulty}`),
		makeElement(document, "p", `Confidence: ${review.confidence}`),
		makeElement(document, "p", `Rationale: ${review.rationale}`),
		makeElement(document, "p", `Missing information: ${textList(review.missingInfo)}`),
		makeElement(document, "p", `Implementation plan: ${textList(review.implementationPlan)}`),
		makeElement(document, "p", `Confidence suggestions: ${textList(review.confidenceSuggestions)}`),
	);
	return panel;
}

function parseFolderOverride(value: string): string[] | undefined {
	const folders = value
		.split(",")
		.map((folder) => folder.trim())
		.filter(Boolean);
	return folders.length ? folders : undefined;
}

const VIEW_STYLE = `
.jira-review { display: grid; gap: 16px; width: min(100%, 1200px); }
.jira-review__header { display: grid; gap: 5px; }
.jira-review__header h1 { margin: 0; font-size: 1.35rem; }
.jira-review__header p { margin: 0; opacity: .72; }
.jira-review__toolbar { display: grid; grid-template-columns: 1fr repeat(3, max-content); gap: 8px; align-items: center; }
.jira-review__sprint { display: grid; gap: 3px; }
.jira-review__sprint strong { font-size: 1.05rem; }
.jira-review__settings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.jira-review__field { display: grid; gap: 6px; }
.jira-review__field--wide { grid-column: 1 / -1; }
.jira-review__field span { font-weight: 600; font-size: .9em; }
.jira-review__field input, .jira-review__field textarea { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; }
.jira-review__field textarea { min-height: 88px; resize: vertical; }
.jira-review__actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.jira-review__folders { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; }
.jira-review__folder { display: flex; gap: 7px; align-items: center; }
.jira-review__tickets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.jira-review__ticket { display: grid; gap: 10px; align-content: start; padding: 14px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 10px; }
.jira-review__ticket-header { display: grid; grid-template-columns: max-content 1fr; gap: 5px 9px; }
.jira-review__ticket-key { font-weight: 700; }
.jira-review__ticket-summary { grid-column: 1 / -1; font-size: 1.05rem; font-weight: 650; }
.jira-review__ticket-meta { display: flex; flex-wrap: wrap; gap: 8px; opacity: .72; font-size: .9em; }
.jira-review__ticket-folders { width: 100%; box-sizing: border-box; padding: 7px; font: inherit; }
.jira-review__saved { display: grid; gap: 4px; padding: 10px; border-radius: 7px; background: color-mix(in srgb, currentColor 8%, transparent); }
.jira-review__saved p { margin: 0; }
.jira-review__error { margin: 0; color: #b42318; }
@media (max-width: 900px) {
  .jira-review__toolbar { grid-template-columns: 1fr 1fr; }
  .jira-review__sprint { grid-column: 1 / -1; }
  .jira-review__tickets { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .jira-review__settings { grid-template-columns: 1fr; }
  .jira-review__field--wide { grid-column: auto; }
  .jira-review__toolbar { grid-template-columns: 1fr; }
}
`;

type Page = "dashboard" | "settings";
type SettingsField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Which host surface this mount is: the settings page, or the top-bar tab.
 *
 * The host calls `mount(container, ctx)` identically on both paths - the ctx is
 * `{pluginId, send, onData}` either way - so the DOM is the only signal. A
 * settings page is rendered into `div.plugin-page-host` inside `div.plugin-page`
 * (PluginPage); a tab is rendered into `div.plugin-view`.
 *
 * If upstream ever renames those classes this returns false and the plugin falls
 * back to the dashboard, which is the safe half: credentials are never shown on
 * a surface that did not ask for them.
 */
export function isSettingsSurface(container: HTMLElement): boolean {
	return typeof container.closest === "function" && container.closest(".plugin-page") !== null;
}

function appendSettingsField(
	document: Document,
	form: HTMLFormElement,
	fields: Map<string, SettingsField>,
	name: string,
	labelText: string,
	value: string,
	type: "text" | "password" | "textarea" = "text",
	wide = false,
): void {
	const label = makeElement(document, "label");
	label.className = `jira-review__field${wide ? " jira-review__field--wide" : ""}`;
	label.append(makeElement(document, "span", labelText));
	const input = type === "textarea" ? textArea(document, name, value) : field(document, name, value, type);
	fields.set(name, input);
	label.append(input);
	form.append(label);
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const document = container.ownerDocument;
		let state: ReviewState = {};
		const page: Page = isSettingsSurface(container) ? "settings" : "dashboard";
		/**
		 * Set by a confirmed save, so the form renders empty instead of echoing the
		 * credentials back.
		 *
		 * It stays set for the life of this mount on purpose: the server sends
		 * `result ok:true` and then a `state` carrying the saved config, so resetting
		 * on `state` would re-fill the form a moment after clearing it. Leaving and
		 * reopening the settings page remounts and prefills again, which is the way
		 * back to editing a saved value.
		 */
		let savedAndCleared = false;
		let selectedFolders: string[] = [];
		let ticketFolderInputs = new Map<string, HTMLInputElement>();
		const bridge =
			document.defaultView && (document.defaultView as Window & { __piWebUiHost?: StartChatHost }).__piWebUiHost;

		const style = (): HTMLStyleElement => {
			const element = document.createElement("style");
			element.textContent = VIEW_STYLE;
			return element;
		};

		const renderSettings = (): HTMLElement => {
			const root = makeElement(document, "section");
			root.className = "jira-review";
			const header = makeElement(document, "header");
			header.className = "jira-review__header";
			header.append(
				makeElement(document, "h1", "Jira settings"),
				makeElement(document, "p", "Credentials are stored by the plugin server, not in browser storage."),
			);

			const form = makeElement(document, "form") as HTMLFormElement;
			form.dataset.ui = "jira-settings";
			form.className = "jira-review__settings";
			const fields = new Map<string, SettingsField>();
			// Blank after a confirmed save: the values live in the plugin's server-side
			// storage and secret store, so leaving them on screen only re-exposes
			// credentials nobody needs to read back.
			const config = savedAndCleared ? {} : (state.config ?? {});
			appendSettingsField(document, form, fields, "siteUrl", "Jira Cloud site URL", config.siteUrl ?? "");
			appendSettingsField(document, form, fields, "email", "Account email", config.email ?? "");
			appendSettingsField(document, form, fields, "apiToken", "API token", "", "password");
			const token = fields.get("apiToken");
			if (token && "placeholder" in token) token.placeholder = "Leave blank to keep the saved token";
			appendSettingsField(document, form, fields, "boardId", "Board ID", config.boardId ?? "");
			appendSettingsField(
				document,
				form,
				fields,
				"readyJql",
				"Ready-ticket JQL",
				savedAndCleared ? "" : config.readyJql || DEFAULT_READY_JQL,
				"textarea",
				true,
			);

			const actions = makeElement(document, "div");
			actions.className = "jira-review__actions jira-review__field--wide";
			const save = makeElement(document, "button", "Save settings") as HTMLButtonElement;
			save.type = "submit";
			save.dataset.action = "save-settings";
			actions.append(save);
			form.append(actions);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				const value = (name: string): string => fields.get(name)?.value ?? "";
				ctx.send({
					action: "save_config",
					config: {
						siteUrl: value("siteUrl"),
						email: value("email"),
						boardId: value("boardId"),
						readyJql: value("readyJql"),
					},
					token: value("apiToken"),
				});
				// Not cleared here: only the server's ok:true result means it landed.
			});

			root.append(style(), header, form);
			if (state.error) {
				const error = makeElement(document, "p", state.error);
				error.className = "jira-review__error";
				root.append(error);
			}
			return root;
		};

		const renderDashboard = (): HTMLElement => {
			const root = makeElement(document, "section");
			root.className = "jira-review";
			root.dataset.ui = "jira-dashboard";
			const config = state.config ?? {};
			const header = makeElement(document, "header");
			header.className = "jira-review__header";
			header.append(
				makeElement(document, "h1", "Jira review"),
				makeElement(document, "p", config.siteUrl ?? "Jira Cloud"),
			);

			const toolbar = makeElement(document, "div");
			toolbar.className = "jira-review__toolbar";
			const sprint = makeElement(document, "div");
			sprint.className = "jira-review__sprint";
			sprint.append(
				makeElement(document, "span", "Active sprint"),
				makeElement(document, "strong", state.activeSprint?.name ?? "None loaded"),
			);
			const refresh = makeElement(document, "button", "Refresh tickets") as HTMLButtonElement;
			refresh.type = "button";
			refresh.dataset.action = "refresh";
			refresh.addEventListener("click", () => ctx.send({ action: "refresh" }));
			const start = makeElement(document, "button", "Start reviews") as HTMLButtonElement;
			start.type = "button";
			start.dataset.action = "start-reviews";
			start.addEventListener("click", () => {
				const overrides: Record<string, string[]> = {};
				for (const [key, input] of ticketFolderInputs) {
					const selected = parseFolderOverride(input.value);
					if (selected) overrides[key] = selected;
				}
				startTicketReviews(bridge, state.tickets ?? [], selectedFolders, overrides);
			});
			toolbar.append(sprint, refresh, start);

			const foldersPanel = makeElement(document, "section");
			foldersPanel.dataset.ui = "folders";
			foldersPanel.append(makeElement(document, "h2", "Workspace scope"));
			const folderGrid = makeElement(document, "div");
			folderGrid.className = "jira-review__folders";
			for (const folder of state.folders ?? []) {
				const label = makeElement(document, "label");
				label.className = "jira-review__folder";
				const checkbox = field(document, "folder", folder, "checkbox");
				checkbox.dataset.folder = folder;
				checkbox.checked = selectedFolders.includes(folder);
				checkbox.addEventListener("change", () => {
					selectedFolders = [...folderGrid.children].flatMap((child) => {
						const input = child.children[0] as HTMLInputElement | undefined;
						return input?.checked ? [input.value] : [];
					});
				});
				label.append(checkbox, makeElement(document, "span", folder));
				folderGrid.append(label);
			}
			foldersPanel.append(folderGrid);

			const ticketsPanel = makeElement(document, "section");
			ticketsPanel.dataset.ui = "tickets";
			ticketsPanel.append(makeElement(document, "h2", `Ready tickets (${state.tickets?.length ?? 0})`));
			const ticketGrid = makeElement(document, "div");
			ticketGrid.className = "jira-review__tickets";
			ticketFolderInputs = new Map();
			for (const ticket of state.tickets ?? []) {
				const row = makeElement(document, "article");
				row.className = "jira-review__ticket";
				row.dataset.key = ticket.key;
				const ticketHeader = makeElement(document, "div");
				ticketHeader.className = "jira-review__ticket-header";
				ticketHeader.append(
					Object.assign(makeElement(document, "span", ticket.key), { className: "jira-review__ticket-key" }),
					makeElement(document, "span", ticket.status || "No status"),
					Object.assign(makeElement(document, "strong", ticket.summary), { className: "jira-review__ticket-summary" }),
				);
				const meta = makeElement(document, "div");
				meta.className = "jira-review__ticket-meta";
				meta.append(makeElement(document, "span", ticket.assignee ? `Assigned to ${ticket.assignee}` : "Unassigned"));
				const folders = field(document, "ticket-folders");
				folders.className = "jira-review__ticket-folders";
				folders.dataset.key = ticket.key;
				folders.placeholder = "Optional folder override, comma-separated";
				ticketFolderInputs.set(ticket.key, folders);
				row.append(ticketHeader, meta, folders);
				const review = state.reviews?.[ticket.key];
				if (review) row.append(renderReview(document, ticket.key, review));
				const post = makeElement(document, "button", "Post review") as HTMLButtonElement;
				post.type = "button";
				post.dataset.action = "post-review";
				post.dataset.key = ticket.key;
				post.disabled = !review?.draftComment?.trim();
				post.addEventListener("click", () => {
					if (review?.draftComment.trim())
						ctx.send({ action: "post_review", key: ticket.key, comment: review.draftComment });
				});
				row.append(post);
				ticketGrid.append(row);
			}
			ticketsPanel.append(ticketGrid);

			root.append(style(), header, toolbar, foldersPanel, ticketsPanel);
			if (state.error) {
				const error = makeElement(document, "p", state.error);
				error.className = "jira-review__error";
				root.append(error);
			}
			if (state.notice) root.append(makeElement(document, "p", state.notice));
			return root;
		};

		/** Shown in the tab before any credentials exist: the form lives in Settings
		 *  now, and this plugin cannot navigate the user there itself. */
		const renderUnconfigured = (): HTMLElement => {
			const root = makeElement(document, "section");
			root.className = "jira-review";
			root.dataset.ui = "jira-unconfigured";
			const heading = makeElement(document, "h1", "Jira Review");
			const hint = makeElement(
				document,
				"p",
				"No Jira credentials saved yet. Open Settings and choose Jira Review to add your site URL, email, " +
					"API token and board.",
			);
			root.append(style(), heading, hint);
			if (state.error) {
				const error = makeElement(document, "p", state.error);
				error.className = "jira-review__error";
				root.append(error);
			}
			return root;
		};

		const render = (): void => {
			if (page === "settings") {
				container.replaceChildren(renderSettings());
				return;
			}
			container.replaceChildren(state.configured ? renderDashboard() : renderUnconfigured());
		};

		const off = ctx.onData((payload) => {
			if (!payload || typeof payload !== "object") return;
			const message = payload as {
				kind?: unknown;
				state?: ReviewState;
				error?: unknown;
				ok?: unknown;
				action?: unknown;
			};
			if (message.kind === "state") {
				state = message.state ?? {};
				render();
			} else if (message.kind === "result" && typeof message.error === "string") {
				state = { ...state, error: message.error };
				render();
			} else if (message.kind === "result" && message.ok === true && message.action === "save_config") {
				// The one unambiguous "your save landed" signal: it is sent to the saving
				// client only, while a state broadcast also fires on refresh and attach.
				savedAndCleared = true;
				state = { ...state, error: undefined };
				render();
			}
		});
		render();
		ctx.send({ action: "get_state" });
		return () => {
			off();
			container.replaceChildren();
		};
	},
};

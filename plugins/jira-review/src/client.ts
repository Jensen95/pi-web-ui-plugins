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

function textList(value: readonly string[] | undefined): string {
	return value?.length ? value.join("; ") : "none";
}

function renderReview(document: Document, key: string, review: JiraReview): HTMLElement {
	const panel = makeElement(document, "div");
	panel.dataset.review = key;
	panel.dataset.confidence = review.confidence;
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

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const document = container.ownerDocument;
		let state: ReviewState = {};
		let selectedFolders: string[] = [];
		let ticketFolderInputs = new Map<string, HTMLInputElement>();
		const bridge =
			document.defaultView && (document.defaultView as Window & { __piWebUiHost?: StartChatHost }).__piWebUiHost;

		const render = (): void => {
			const config = state.config ?? {};
			const root = makeElement(document, "section");
			root.dataset.ui = "jira-review";
			root.append(makeElement(document, "h2", "Jira review"));

			const configForm = makeElement(document, "form");
			configForm.dataset.ui = "jira-config";
			configForm.append(
				field(document, "siteUrl", config.siteUrl),
				field(document, "email", config.email),
				field(document, "apiToken", "", "password"),
				field(document, "boardId", config.boardId),
				field(document, "readyJql", config.readyJql || DEFAULT_READY_JQL),
			);
			const save = makeElement(document, "button", "Save configuration");
			(save as HTMLButtonElement).type = "submit";
			configForm.append(save);
			configForm.addEventListener("submit", (event) => {
				event?.preventDefault?.();
				const inputs = ([...configForm.children] as HTMLElement[]).filter((child) => child.dataset.field);
				const values = Object.fromEntries(
					inputs.map((input) => [input.dataset.field, (input as HTMLInputElement).value]),
				);
				ctx.send({
					action: "save_config",
					config: { siteUrl: values.siteUrl, email: values.email, boardId: values.boardId, readyJql: values.readyJql },
					token: values.apiToken,
				});
			});
			root.append(configForm);

			const sprint = makeElement(
				document,
				"p",
				state.activeSprint ? `Current sprint: ${state.activeSprint.name}` : "Current sprint: none",
			);
			root.append(sprint);

			const refresh = makeElement(document, "button", "Refresh active sprint");
			(refresh as HTMLButtonElement).type = "button";
			refresh.dataset.action = "refresh";
			refresh.addEventListener("click", () => ctx.send({ action: "refresh" }));
			const start = makeElement(document, "button", "Start reviews");
			(start as HTMLButtonElement).type = "button";
			start.dataset.action = "start-reviews";
			start.addEventListener("click", () => {
				const overrides: Record<string, string[]> = {};
				for (const [key, input] of ticketFolderInputs) {
					const selected = parseFolderOverride(input.value);
					if (selected) overrides[key] = selected;
				}
				startTicketReviews(bridge, state.tickets ?? [], selectedFolders, overrides);
			});
			root.append(refresh, start);

			const folderPanel = makeElement(document, "div");
			folderPanel.dataset.ui = "folders";
			for (const folder of state.folders ?? []) {
				const checkbox = field(document, "folder", folder, "checkbox");
				checkbox.dataset.folder = folder;
				checkbox.checked = selectedFolders.includes(folder);
				checkbox.addEventListener("change", () => {
					selectedFolders = [...folderPanel.children]
						.filter((child) => (child as HTMLInputElement).checked)
						.map((child) => (child as HTMLInputElement).value);
				});
				folderPanel.append(checkbox, makeElement(document, "span", folder));
			}
			root.append(folderPanel);

			const ticketPanel = makeElement(document, "div");
			ticketFolderInputs = new Map();
			for (const ticket of state.tickets ?? []) {
				const row = makeElement(document, "article");
				row.dataset.key = ticket.key;
				row.append(makeElement(document, "strong", `${ticket.key}: ${ticket.summary}`));
				row.append(makeElement(document, "p", ticket.status));
				const folders = field(document, "ticket-folders");
				folders.dataset.key = ticket.key;
				folders.placeholder = "Optional folder override, comma-separated";
				ticketFolderInputs.set(ticket.key, folders);
				row.append(folders);
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
				ticketPanel.append(row);
			}
			root.append(ticketPanel);
			if (state.error) root.append(makeElement(document, "p", state.error));
			if (state.notice) root.append(makeElement(document, "p", state.notice));
			container.replaceChildren(root);
		};

		const off = ctx.onData((payload) => {
			if (!payload || typeof payload !== "object") return;
			const message = payload as { kind?: unknown; state?: ReviewState; error?: unknown };
			if (message.kind === "state") {
				state = message.state ?? {};
				render();
			} else if (message.kind === "result" && typeof message.error === "string") {
				state = { ...state, error: message.error };
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

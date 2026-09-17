import { describe, expect, it, vi } from "vitest";
import { createMockHost, createMockViewContext } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import jiraClient, { buildReviewPrompt, startTicketReviews } from "../../plugins/jira-review/src/client";
import jiraServer, {
	CONFIG_KEY,
	DEFAULT_READY_JQL,
	REVIEWS_KEY,
	TAG,
	validateReview,
} from "../../plugins/jira-review/src/index";
import { createJiraApi, normalizeSiteUrl } from "../../plugins/jira-review/src/jira-api";

const TOKEN = "jira-api-token-do-not-leak";
const CONFIG = {
	siteUrl: "https://example.atlassian.net",
	email: "agent@example.com",
	boardId: "42",
	readyJql: 'assignee IS EMPTY AND statusCategory = "To Do"',
};

interface RequestCall {
	url: string;
	init?: RequestInit;
}

function reply(body: unknown, status = 200, statusText = "OK"): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response;
}

function requestStub(responses: (Response | (() => Response))[]): { request: typeof fetch; calls: RequestCall[] } {
	const calls: RequestCall[] = [];
	const request = vi.fn(async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		const next = responses.shift();
		if (!next) throw new Error("unexpected request");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { request, calls };
}

function statePayloads(host: MockHost): Record<string, unknown>[] {
	return host.recorded.broadcasts.filter((payload): payload is Record<string, unknown> => {
		return Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).kind === "state");
	});
}

function lastState(host: MockHost): Record<string, unknown> {
	const payload = statePayloads(host).at(-1);
	expect(payload).toBeDefined();
	return (payload?.state ?? {}) as Record<string, unknown>;
}

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ready: true,
		difficulty: "medium",
		confidence: "high",
		rationale: "The acceptance criteria are actionable.",
		missingInfo: [],
		implementationPlan: ["Implement the requested change.", "Add a regression test."],
		draftComment: "The ticket is ready for pickup.",
		confidenceSuggestions: [],
		...overrides,
	};
}

describe("Jira API", () => {
	it("normalizes the site URL and fetches the active sprint with Basic auth", async () => {
		expect(normalizeSiteUrl("https://example.atlassian.net/")).toBe("https://example.atlassian.net");
		const { request, calls } = requestStub([reply({ values: [{ id: 7, name: "Sprint 12", state: "active" }] })]);
		const api = createJiraApi("https://example.atlassian.net/", CONFIG.email, TOKEN, request);

		expect(await api.activeSprint(CONFIG.boardId)).toEqual({ id: 7, name: "Sprint 12", state: "active" });
		expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/board/42/sprint?state=active");
		expect(calls[0]?.init?.headers).toMatchObject({
			Authorization: `Basic ${Buffer.from(`${CONFIG.email}:${TOKEN}`).toString("base64")}`,
			Accept: "application/json",
		});
	});

	it("returns no sprint when Jira reports none and rejects invalid site or board values", async () => {
		expect(() => normalizeSiteUrl("javascript:alert(1)")).toThrow(/HTTPS/);
		expect(() => normalizeSiteUrl("https://evil.example")).toThrow(/Atlassian/i);
		expect(() => normalizeSiteUrl("https://example.atlassian.net/?token=secret")).toThrow(/query/i);
		const { request } = requestStub([reply({ values: [] })]);
		const api = createJiraApi(CONFIG.siteUrl, CONFIG.email, TOKEN, request);

		expect(await api.activeSprint("42")).toBeNull();
		await expect(api.activeSprint("not-a-number")).rejects.toThrow(/board/i);
	});

	it("turns Jira HTTP failures into safe errors without exposing the token", async () => {
		const { request } = requestStub([reply({ errorMessages: ["Forbidden"] }, 403, "Forbidden")]);
		const api = createJiraApi(CONFIG.siteUrl, CONFIG.email, TOKEN, request);

		await expect(api.activeSprint("42")).rejects.toThrow(/403/);
		await expect(api.activeSprint("42")).rejects.not.toThrow(TOKEN);
	});

	it("follows Jira search pagination so a large sprint is not silently truncated", async () => {
		const { request, calls } = requestStub([
			reply({
				issues: [
					{ key: "ABC-1", fields: { summary: "First" } },
					{ key: "ABC-2", fields: { summary: "Second" } },
				],
				nextPageToken: "next-page",
			}),
			reply({ issues: [{ key: "ABC-3", fields: { summary: "Third" } }], isLast: true }),
		]);
		const api = createJiraApi(CONFIG.siteUrl, CONFIG.email, TOKEN, request);

		expect(await api.searchIssues(7, CONFIG.readyJql)).toHaveLength(3);
		expect(calls[0]?.url).toContain("/rest/api/3/search/jql?");
		expect(new URL(calls[1]!.url).searchParams.get("nextPageToken")).toBe("next-page");
	});

	it("searches the active sprint and posts an ADF comment followed by the label update", async () => {
		const { request, calls } = requestStub([
			reply({ issues: [{ id: "1", key: "ABC-1", fields: { summary: "Ready ticket" } }] }),
			reply({}, 201, "Created"),
			reply({}, 204, "No Content"),
		]);
		const api = createJiraApi(CONFIG.siteUrl, CONFIG.email, TOKEN, request);

		expect(await api.searchIssues(7, CONFIG.readyJql)).toEqual([
			{ id: "1", key: "ABC-1", fields: { summary: "Ready ticket" } },
		]);
		await api.postComment("ABC-1", "The ticket is ready.");
		await api.addLabel("ABC-1", TAG);
		expect(new URL(calls[0]!.url).searchParams.get("jql")).toBe(`sprint = 7 AND (${CONFIG.readyJql})`);
		expect(calls[1]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ body: { type: "doc", version: 1 } });
		expect(calls[2]?.init?.method).toBe("PUT");
		expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ update: { labels: [{ add: TAG }] } });
	});
});

describe("Jira review server", () => {
	it("saves non-secret config, refreshes the current sprint, and never posts during refresh", async () => {
		const { request, calls } = requestStub([
			reply({ values: [{ id: 7, name: "Sprint 12", state: "active" }] }),
			reply({
				issues: [
					{
						id: "1",
						key: "ABC-1",
						fields: {
							summary: "Ready ticket",
							status: { name: "To Do" },
							assignee: null,
							labels: [],
							description: "Add the missing behavior.",
						},
					},
				],
			}),
		]);
		vi.stubGlobal("fetch", request);
		const host = createMockHost({ permissions: ["http", "tools", "fs"] });
		const deactivate = jiraServer.activate(host);

		await host.emit.message({ action: "save_config", config: CONFIG, token: TOKEN }, "client-1");
		await host.emit.message({ action: "refresh" }, "client-1");

		expect(host.recorded.secrets.get("jira_api_token")).toBe(TOKEN);
		expect(host.recorded.storage.get(CONFIG_KEY)).toEqual(CONFIG);
		expect(JSON.stringify(host.recorded.broadcasts)).not.toContain(TOKEN);
		expect(calls).toHaveLength(2);
		expect(new URL(calls[1]!.url).searchParams.get("jql")).toBe(`sprint = 7 AND (${CONFIG.readyJql})`);
		expect(lastState(host)).toMatchObject({
			activeSprint: { id: 7, name: "Sprint 12" },
			tickets: [{ key: "ABC-1", summary: "Ready ticket", status: "To Do" }],
		});
		expect(lastState(host).config).not.toHaveProperty("apiToken");
		expect(lastState(host).config).not.toHaveProperty("token");
		expect(calls.every((call) => call.init?.method !== "POST" && call.init?.method !== "PUT")).toBe(true);
		deactivate?.();
		vi.unstubAllGlobals();
	});

	it("persists valid reviews, rejects invalid confidence values, and exposes the same result to the agent tool", async () => {
		const host = createMockHost({
			permissions: ["http", "tools", "fs"],
			storage: { [CONFIG_KEY]: CONFIG },
		});
		const deactivate = jiraServer.activate(host);
		const valid = review();

		await host.emit.message({ action: "save_review", key: "ABC-1", review: valid }, "client-1");
		expect(host.recorded.storage.get(REVIEWS_KEY)).toMatchObject({ [CONFIG.siteUrl]: { "ABC-1": valid } });
		expect(host.agentTool("jira_review_save")).toBeDefined();
		const toolResult = await host.agentTool("jira_review_save")!.execute("call-1", { key: "ABC-2", review: valid });
		expect(toolResult).toMatchObject({ ok: true, key: "ABC-2" });
		expect(host.recorded.storage.get(REVIEWS_KEY)).toMatchObject({ [CONFIG.siteUrl]: { "ABC-2": valid } });
		expect(lastState(host)).toMatchObject({ reviews: { "ABC-2": valid } });

		await host.emit.message(
			{ action: "save_review", key: "ABC-3", review: review({ confidence: "certain" }) },
			"client-1",
		);
		expect(lastState(host)).toMatchObject({ error: expect.stringMatching(/confidence/i) });
		expect(host.recorded.storage.get(REVIEWS_KEY)).not.toHaveProperty(`${CONFIG.siteUrl}.ABC-3`);
		deactivate?.();
	});

	it("refuses to report success when the secret store does not persist a new token", async () => {
		const host = createMockHost({ permissions: ["http", "tools", "fs"] });
		host.secrets.set = () => {};
		const deactivate = jiraServer.activate(host);
		await host.emit.message({ action: "save_config", config: CONFIG, token: TOKEN }, "client-1");
		expect(lastState(host)).toMatchObject({ error: expect.stringMatching(/secret|secure/i) });
		expect(host.recorded.storage.get(CONFIG_KEY)).toBeUndefined();
		deactivate?.();
	});

	it("retains an existing token when saving a later configuration change and exposes the default JQL", async () => {
		const host = createMockHost({
			permissions: ["http", "tools", "fs"],
			storage: { [CONFIG_KEY]: CONFIG },
			secrets: { jira_api_token: TOKEN },
		});
		const deactivate = jiraServer.activate(host);
		await host.emit.message(
			{ action: "save_config", config: { ...CONFIG, readyJql: "labels IS EMPTY" }, token: "" },
			"client-1",
		);
		expect(host.recorded.secrets.get("jira_api_token")).toBe(TOKEN);
		expect(host.recorded.storage.get(CONFIG_KEY)).toMatchObject({ readyJql: "labels IS EMPTY" });
		deactivate?.();
	});

	it("posts only after an explicit action, adds the required label, and reports label failure separately", async () => {
		const { request, calls } = requestStub([reply({}, 201, "Created"), reply({}, 204, "No Content")]);
		vi.stubGlobal("fetch", request);
		const host = createMockHost({
			permissions: ["http", "tools", "fs"],
			storage: { [CONFIG_KEY]: CONFIG },
			secrets: { jira_api_token: TOKEN },
		});
		const deactivate = jiraServer.activate(host);

		await host.emit.message({ action: "post_review", key: "ABC-1", comment: "Draft comment" }, "client-1");
		expect(calls.map((call) => call.init?.method)).toEqual(["POST", "PUT"]);
		expect(host.recorded.notifications.some(({ level, text }) => level === "info" && /posted/i.test(text))).toBe(true);

		const failed = requestStub([
			reply({}, 201, "Created"),
			reply({ errorMessages: ["No permission"] }, 403, "Forbidden"),
		]);
		vi.stubGlobal("fetch", failed.request);
		await host.emit.message({ action: "post_review", key: "ABC-1", comment: "Second draft" }, "client-1");
		expect(host.recorded.notifications.some(({ level, text }) => level === "warning" && /label/i.test(text))).toBe(
			true,
		);
		deactivate?.();
		vi.unstubAllGlobals();
	});

	it("validates the complete review shape instead of accepting tautological values", () => {
		expect(validateReview(review())).toBeNull();
		expect(validateReview(review({ ready: "yes" }))).toMatch(/ready/i);
		expect(validateReview(review({ difficulty: "unknown" }))).toMatch(/difficulty/i);
		expect(validateReview({})).toMatch(/rationale|confidence/i);
		expect(DEFAULT_READY_JQL).toContain("assignee");
	});
});

describe("Jira review client", () => {
	it("starts exactly one new chat per ticket, includes selected folders and review fields, and never posts automatically", () => {
		const startChat = vi.fn<(options: { prompt: string; newChat?: boolean }) => boolean>(() => true);
		const host = { startChat };
		const tickets = [
			{ key: "ABC-1", summary: "First ticket", description: "Do first", status: "To Do" },
			{ key: "ABC-2", summary: "Second ticket", description: "Do second", status: "To Do" },
		];
		const started = startTicketReviews(host, tickets, ["src", "tests"], { "ABC-2": ["docs"] });

		expect(started).toBe(2);
		expect(startChat).toHaveBeenCalledTimes(2);
		expect(startChat.mock.calls[0]?.[0]).toMatchObject({ newChat: true });
		expect(startChat.mock.calls[0]?.[0].prompt).toContain("ABC-1");
		expect(startChat.mock.calls[0]?.[0].prompt).toContain("src");
		expect(startChat.mock.calls[1]?.[0].prompt).toContain("docs");
		expect(startChat.mock.calls[1]?.[0].prompt).toContain("confidence");
		expect(startChat.mock.calls[1]?.[0].prompt).not.toContain(TOKEN);
		expect(startChat.mock.calls.every(([options]) => !String(options.prompt).includes("post_review"))).toBe(true);
	});

	it("builds a safe prompt and tolerates a missing or broken host bridge", () => {
		const prompt = buildReviewPrompt(
			{ key: "ABC-1", summary: "A ticket", description: "A description", status: "To Do" },
			["src"],
		);
		expect(prompt).toContain("Do not post anything to Jira");
		expect(prompt).toContain("jira_review_save");
		expect(() =>
			startTicketReviews(undefined, [{ key: "ABC-1", summary: "A", description: "", status: "" }], [], {}),
		).not.toThrow();
		expect(() =>
			startTicketReviews(
				{
					startChat: () => {
						throw new Error("bridge down");
					},
				},
				[],
				[],
				{},
			),
		).not.toThrow();
	});

	/** A container the host would hand a settings page: it sits inside .plugin-page
	 *  (see PluginPage in the host bundle). A tab's container has no such ancestor. */
	const settingsContainer = (document: FakeDocument): FakeElement => {
		const container = document.createElement("div");
		container.ancestorClasses = ["plugin-page", "set-plugin-page"];
		return container;
	};

	it("renders the credentials form only on the settings surface, and saves from there", () => {
		const { ctx, sent } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = settingsContainer(document);
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);

		expect(descendants(container).some((element) => element.dataset.ui === "jira-settings")).toBe(true);
		const token = descendants(container).find((element) => element.dataset.field === "apiToken");
		expect(token?.type).toBe("password");
		const form = descendants(container).find((element) => element.dataset.ui === "jira-settings");
		expect(form).toBeDefined();
		const values: Record<string, string> = {
			siteUrl: CONFIG.siteUrl,
			email: CONFIG.email,
			apiToken: TOKEN,
			boardId: CONFIG.boardId,
			readyJql: CONFIG.readyJql,
		};
		for (const input of descendants(form!).filter((element) => element.dataset.field)) {
			input.value = values[input.dataset.field];
		}
		form!.dispatch("submit", { preventDefault: vi.fn() });

		expect(sent).toContainEqual({ action: "get_state" });
		expect(sent).toContainEqual({ action: "save_config", config: CONFIG, token: TOKEN });
	});

	it("shows the dashboard on the tab surface and uses responsive grids", () => {
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = document.createElement("div");
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({
			kind: "state",
			state: {
				configured: true,
				config: CONFIG,
				folders: [],
				tickets: [{ key: "ABC-1", summary: "Ticket", description: "Description", status: "To Do" }],
				reviews: {},
				activeSprint: { id: 7, name: "Sprint 12", state: "active" },
			},
		});

		expect(descendants(container).some((element) => element.dataset.ui === "jira-dashboard")).toBe(true);
		// Credentials live in the settings page now: the tab neither shows the form
		// nor a button that would navigate to one it cannot reach.
		expect(descendants(container).some((element) => element.dataset.ui === "jira-settings")).toBe(false);
		expect(descendants(container).some((element) => element.dataset.action === "settings")).toBe(false);
		const style = descendants(container).find((element) => element.tagName === "style")?.textContent ?? "";
		expect(style).toContain(".jira-review__tickets { display: grid; grid-template-columns: 1fr;");
		expect(style).toContain(".jira-review__settings { display: grid;");
	});

	it("points an unconfigured tab at the settings page instead of duplicating the form", () => {
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = document.createElement("div");
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { configured: false } });

		const text = descendants(container)
			.map((element) => element.textContent)
			.join(" ");
		expect(text).toMatch(/Settings/);
		expect(text).toMatch(/Jira Review/);
		expect(descendants(container).some((element) => element.dataset.ui === "jira-settings")).toBe(false);
	});

	it("imports the site URL and board ID from a Jira board link", () => {
		const { ctx } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = settingsContainer(document);
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);

		const link = descendants(container).find((element) => element.dataset.field === "boardUrl");
		const importButton = descendants(container).find((element) => element.dataset.action === "import-board-url");
		link!.value = "https://example.atlassian.net/jira/software/c/projects/ABC/boards/42/backlog";
		importButton!.click();

		expect(descendants(container).find((element) => element.dataset.field === "siteUrl")?.value).toBe(
			"https://example.atlassian.net",
		);
		expect(descendants(container).find((element) => element.dataset.field === "boardId")?.value).toBe("42");
	});

	it("clears the form once the server confirms the save", () => {
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = settingsContainer(document);
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { configured: true, config: CONFIG } });

		// Saved values are prefilled while editing...
		const before = descendants(container).filter((element) => element.dataset.field);
		expect(before.find((element) => element.dataset.field === "siteUrl")?.value).toBe(CONFIG.siteUrl);

		// ...and gone once the server says the save landed. `result ok:true` is the
		// only unambiguous per-client success signal: a `state` broadcast also
		// arrives on refresh, on attach, and from other clients.
		push({ kind: "result", ok: true, action: "save_config" });

		const after = descendants(container).filter((element) => element.dataset.field);
		expect(after.length, "the form stays on screen").toBeGreaterThan(0);
		for (const input of after) {
			expect(input.value, `${input.dataset.field} must be cleared after saving`).toBe("");
		}
	});

	it("keeps what you typed when the save fails, so nothing has to be retyped", () => {
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = settingsContainer(document);
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { configured: true, config: CONFIG } });

		const form = descendants(container).find((element) => element.dataset.ui === "jira-settings");
		const values = { ...CONFIG, apiToken: TOKEN, boardUrl: "" };
		for (const input of descendants(form!).filter((element) => element.dataset.field)) {
			input.value = values[input.dataset.field as keyof typeof values];
		}
		form!.dispatch("submit", { preventDefault: vi.fn() });
		push({ kind: "result", ok: false, action: "save_config", error: "Jira API token is required" });

		const fields = descendants(container).filter((element) => element.dataset.field);
		for (const input of fields) {
			expect(input.value, `${input.dataset.field} must be kept after a failed save`).toBe(
				values[input.dataset.field as keyof typeof values],
			);
		}
		const text = descendants(container)
			.map((element) => element.textContent)
			.join(" ");
		expect(text).toContain("Jira API token is required");
	});

	it("does not clear the form for someone else's state broadcast", () => {
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = settingsContainer(document);
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { configured: true, config: CONFIG } });
		// A refresh, an attach, or another browser saving would all look like this.
		push({ kind: "state", state: { configured: true, config: CONFIG, tickets: [] } });

		const siteUrl = descendants(container).find((element) => element.dataset.field === "siteUrl");
		expect(siteUrl?.value).toBe(CONFIG.siteUrl);
	});

	it("keeps the settings surface on the form even once configured", () => {
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = settingsContainer(document);
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { configured: true, config: CONFIG, folders: [], tickets: [], reviews: {} } });

		expect(descendants(container).some((element) => element.dataset.ui === "jira-settings")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.ui === "jira-dashboard")).toBe(false);
		// "Back to reviews" had nowhere to go from inside the settings modal.
		expect(descendants(container).some((element) => element.dataset.action === "dashboard")).toBe(false);
	});

	it("mounts a view that sends state requests and exposes explicit review/post controls", () => {
		const { ctx, sent, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		const container = document.createElement("div");
		const cleanup = jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({
			kind: "state",
			state: {
				configured: true,
				config: CONFIG,
				folders: ["src"],
				tickets: [{ key: "ABC-1", summary: "Ticket", description: "Description", status: "To Do" }],
				reviews: {},
				activeSprint: { id: 7, name: "Sprint 12", state: "active" },
			},
		});
		expect(sent).toContainEqual({ action: "get_state" });
		expect(descendants(container).some((element) => element.dataset.action === "start-reviews")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.action === "start-review")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.action === "post-review")).toBe(true);
		cleanup?.();
		expect(container.children).toEqual([]);
	});

	it("lets each ticket override the selected folders and renders saved confidence details", () => {
		const startChat = vi.fn<(options: { prompt: string; newChat?: boolean }) => boolean>(() => true);
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		document.defaultView.__piWebUiHost = { startChat };
		const container = document.createElement("div");
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({
			kind: "state",
			state: {
				configured: true,
				config: CONFIG,
				folders: ["src", "docs"],
				tickets: [
					{ key: "ABC-1", summary: "First", description: "One", status: "To Do" },
					{ key: "ABC-2", summary: "Second", description: "Two", status: "To Do" },
				],
				reviews: { "ABC-1": review({ confidence: "medium", confidenceSuggestions: ["Confirm the API contract."] }) },
				activeSprint: { id: 7, name: "Sprint 12", state: "active" },
			},
		});
		const src = descendants(container).find((element) => element.dataset.field === "folder" && element.value === "src");
		expect(src).toBeDefined();
		src!.checked = true;
		src!.dispatch("change");
		const override = descendants(container).find(
			(element) => element.dataset.field === "ticket-folders" && element.dataset.key === "ABC-2",
		);
		expect(override).toBeDefined();
		override!.value = "docs";
		vi.useFakeTimers();
		descendants(container)
			.find((element) => element.dataset.action === "start-reviews")!
			.click();
		expect(descendants(container).some((element) => element.textContent === "Review in progress")).toBe(true);
		vi.advanceTimersByTime(100);
		expect(startChat).toHaveBeenCalledTimes(1);
		expect(startChat.mock.calls[0]![0].prompt).toContain("docs");
		const reviewPanel = descendants(container).find((element) => element.dataset.review === "ABC-1");
		expect(reviewPanel).toBeDefined();
		expect(descendants(reviewPanel!).some((element) => element.textContent.includes("Confidence: medium"))).toBe(true);
		expect(descendants(container).some((element) => element.textContent.includes("Confirm the API contract."))).toBe(
			true,
		);
		vi.useRealTimers();
	});

	it("starts one ticket on demand and marks it as in progress", () => {
		const startChat = vi.fn<(options: { prompt: string; newChat?: boolean; model?: string }) => boolean>(() => true);
		const { ctx, push } = createMockViewContext("jira-review");
		const document = createFakeDocument();
		document.defaultView.__piWebUiHost = {
			startChat,
			models: { list: () => [{ id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 mini" }] },
		};
		const container = document.createElement("div");
		jiraClient.mount?.(container as unknown as HTMLElement, ctx);
		push({
			kind: "state",
			state: {
				configured: true,
				config: CONFIG,
				folders: ["src"],
				tickets: [{ key: "ABC-1", summary: "First", description: "One", status: "To Do" }],
				reviews: {},
			},
		});
		const model = descendants(container).find((element) => element.dataset.field === "review-model");
		expect(model?.disabled).toBe(false);
		model!.value = "openai/gpt-5-mini";

		descendants(container)
			.find((element) => element.dataset.action === "start-review")!
			.click();

		expect(startChat).toHaveBeenCalledTimes(1);
		expect(startChat.mock.calls[0]![0].prompt).toContain("ABC-1");
		expect(startChat.mock.calls[0]![0].model).toBe("openai/gpt-5-mini");
		expect(descendants(container).some((element) => element.textContent === "Review in progress")).toBe(true);
		expect(descendants(container).find((element) => element.dataset.action === "start-review")?.disabled).toBe(true);
	});
});

interface FakeElement {
	tagName: string;
	textContent: string;
	value: string;
	type: string;
	checked: boolean;
	disabled: boolean;
	dataset: Record<string, string>;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	/** Ancestor class names, so closest() can answer which host surface this is. */
	ancestorClasses: string[];
	closest(selector: string): FakeElement | null;
	addEventListener(type: string, listener: (event?: any) => void): void;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	click(): void;
	dispatch(type: string, event?: any): void;
	setAttribute(name: string, value: string): void;
}

interface FakeDocument {
	defaultView: {
		__piWebUiHost?: {
			startChat?: (options: { prompt: string; newChat?: boolean; model?: string }) => boolean;
			models?: { list?: () => readonly { id: string; provider: string; name?: string }[] };
		};
	};
	createElement(tagName: string): FakeElement;
}

function createFakeDocument(): FakeDocument {
	const document = {} as FakeDocument;
	const make = (tagName: string): FakeElement => {
		const listeners = new Map<string, Set<(event?: any) => void>>();
		const element: FakeElement = {
			tagName,
			textContent: "",
			value: "",
			type: "",
			checked: false,
			disabled: false,
			dataset: {},
			children: [],
			ownerDocument: document,
			ancestorClasses: [],
			closest(selector) {
				return element.ancestorClasses.includes(selector.replace(".", "")) ? element : null;
			},
			addEventListener(type, listener) {
				let handlers = listeners.get(type);
				if (!handlers) listeners.set(type, (handlers = new Set()));
				handlers.add(listener);
			},
			append(...children) {
				element.children.push(...children);
			},
			replaceChildren(...children) {
				element.children = children;
			},
			click() {
				if (!element.disabled) for (const listener of listeners.get("click") ?? []) listener();
			},
			dispatch(type, event) {
				for (const listener of listeners.get(type) ?? []) listener(event);
			},
			setAttribute(name, value) {
				if (name.startsWith("data-")) element.dataset[name.slice(5)] = value;
			},
		};
		return element;
	};
	document.defaultView = {};
	document.createElement = (tagName) => make(tagName);
	return document;
}

function descendants(root: FakeElement): FakeElement[] {
	return root.children.flatMap((child) => [child, ...descendants(child)]);
}

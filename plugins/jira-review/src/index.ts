import { createJiraApi, normalizeSiteUrl, type JiraIssue, type JiraSprint } from "./jira-api";

export const CONFIG_KEY = "jira-review.config";
export const REVIEWS_KEY = "jira-review.reviews";
export const RUNS_KEY = "jira-review.runs";
export const FOLDER_SELECTIONS_KEY = "jira-review.folder-selections";
export const TAG = "dogits-dans-le-nez";
export const DEFAULT_READY_JQL = 'assignee IS EMPTY AND statusCategory = "To Do"';
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;

export interface JiraConfig {
	siteUrl: string;
	email: string;
	boardId: string;
	readyJql: string;
}

export interface JiraReview {
	ready: boolean;
	difficulty: "easy" | "medium" | "hard";
	confidence: "high" | "medium" | "low";
	rationale: string;
	missingInfo: string[];
	implementationPlan: string[];
	draftComment: string;
	confidenceSuggestions: string[];
}

export interface JiraTicket {
	id?: string;
	key: string;
	summary: string;
	description: string;
	status: string;
	assignee?: string | null;
	labels?: string[];
}

interface Host {
	readonly cwd?: string;
	onCwdChange?(handler: (cwd: string) => void): () => void;
	broadcast(payload: unknown): void;
	sendTo(clientId: string, payload: unknown): void;
	notify(level: "info" | "warning" | "error", text: string): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onAttach?(handler: (clientId: string) => void): () => void;
	registerAgentTool(tool: {
		name: string;
		description: string;
		parameters?: Record<string, unknown>;
		execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
	}): () => void;
	storage: { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void };
	secrets: { get(name: string): string | undefined; set(name: string, value: string): void };
	fs: { list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]> };
}

function textFromDescription(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const item = value as { text?: unknown; content?: unknown };
	if (typeof item.text === "string") return item.text;
	if (!Array.isArray(item.content)) return "";
	return item.content.map(textFromDescription).filter(Boolean).join(" ");
}

export function normalizeIssue(issue: JiraIssue): JiraTicket | null {
	if (!issue || typeof issue.key !== "string" || !issue.key.trim()) return null;
	const fields = issue.fields ?? {};
	const status = fields.status;
	const assignee = fields.assignee;
	const assigneeName =
		assignee && typeof assignee === "object"
			? ((assignee as { displayName?: unknown; emailAddress?: unknown }).displayName ??
				(assignee as { emailAddress?: unknown }).emailAddress)
			: null;
	const labels = Array.isArray(fields.labels)
		? fields.labels.filter((label): label is string => typeof label === "string")
		: [];
	return {
		...(typeof issue.id === "string" ? { id: issue.id } : {}),
		key: issue.key.trim(),
		summary: typeof fields.summary === "string" ? fields.summary : "",
		description: textFromDescription(fields.description),
		status:
			status && typeof status === "object" && typeof (status as { name?: unknown }).name === "string"
				? (status as { name: string }).name
				: "",
		assignee: typeof assigneeName === "string" ? assigneeName : null,
		labels,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(value: unknown): JiraConfig {
	if (!isRecord(value)) throw new Error("Jira configuration is required");
	const siteUrl = normalizeSiteUrl(String(value.siteUrl ?? ""));
	const email = String(value.email ?? "").trim();
	const boardId = String(value.boardId ?? "").trim();
	const readyJql = String(value.readyJql ?? "").trim() || DEFAULT_READY_JQL;
	if (!email || !email.includes("@") || email.length > 320) throw new Error("Jira email is invalid");
	if (!/^\d+$/.test(boardId)) throw new Error("Board ID must be a number");
	if (!readyJql || readyJql.length > 4000 || readyJql.includes("\0")) throw new Error("Ready JQL is invalid");
	return { siteUrl, email, boardId, readyJql };
}

function validateStringList(value: unknown, name: string): string | null {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		return `${name} must be a list of strings`;
	return null;
}

export function validateReview(value: unknown): string | null {
	if (!isRecord(value)) return "Review must be an object";
	for (const field of ["rationale", "draftComment"]) {
		if (typeof value[field] !== "string" || !value[field].trim()) return `${field} is required`;
	}
	if (typeof value.ready !== "boolean") return "ready must be boolean";
	if (value.difficulty !== "easy" && value.difficulty !== "medium" && value.difficulty !== "hard") {
		return "difficulty must be easy, medium, or hard";
	}
	if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low") {
		return "confidence must be high, medium, or low";
	}
	for (const field of ["missingInfo", "implementationPlan", "confidenceSuggestions"]) {
		const error = validateStringList(value[field], field);
		if (error) return error;
	}
	return null;
}

function asReview(value: unknown): JiraReview {
	return value as JiraReview;
}

type ReviewStore = Record<string, Record<string, JiraReview>>;
type ReviewRuns = Record<string, Record<string, number>>;

function reviewScope(config: JiraConfig | null): string {
	return config?.siteUrl ?? "_unconfigured";
}

function loadReviewStore(value: unknown): ReviewStore {
	if (!isRecord(value)) return {};
	const entries = Object.entries(value);
	const legacy = entries.filter(([key, review]) => ISSUE_KEY_RE.test(key) && validateReview(review) === null);
	if (entries.length > 0 && legacy.length === entries.length) {
		return { _unconfigured: Object.fromEntries(legacy) as Record<string, JiraReview> };
	}
	const store: ReviewStore = {};
	for (const [scope, raw] of entries) {
		if (!isRecord(raw)) continue;
		const valid = Object.fromEntries(
			Object.entries(raw).filter(([key, review]) => ISSUE_KEY_RE.test(key) && validateReview(review) === null),
		) as Record<string, JiraReview>;
		if (Object.keys(valid).length > 0) store[scope] = valid;
	}
	return store;
}

function publicState(
	config: JiraConfig | null,
	activeSprint: JiraSprint | null,
	tickets: JiraTicket[],
	reviews: Record<string, JiraReview>,
	reviewing: Record<string, number>,
	workspaceCwd: string,
	folders: string[],
	selectedFolders: string[],
	error?: string,
): Record<string, unknown> {
	return {
		configured: !!config,
		config,
		activeSprint,
		tickets,
		reviews,
		reviewing,
		workspaceCwd,
		folders,
		selectedFolders,
		...(error ? { error } : {}),
	};
}

function errorText(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "Jira operation failed";
}

export default {
	activate(host: Host): () => void {
		let config = (() => {
			try {
				const stored = host.storage.get<unknown>(CONFIG_KEY);
				return stored ? validateConfig(stored) : null;
			} catch {
				return null;
			}
		})();
		let activeSprint: JiraSprint | null = null;
		let tickets: JiraTicket[] = [];
		let folders: string[] = [];
		let workspaceCwd = host.cwd ?? "";
		let error: string | undefined;
		let reviewStore = loadReviewStore(host.storage.get<unknown>(REVIEWS_KEY, {}));
		let reviewRuns = (host.storage.get<ReviewRuns>(RUNS_KEY, {}) ?? {}) as ReviewRuns;
		let folderSelections = (host.storage.get<Record<string, string[]>>(FOLDER_SELECTIONS_KEY, {}) ?? {}) as Record<
			string,
			string[]
		>;
		const currentReviews = (): Record<string, JiraReview> => reviewStore[reviewScope(config)] ?? {};
		const currentRuns = (): Record<string, number> => reviewRuns[reviewScope(config)] ?? {};
		const currentFolderSelection = (): string[] => folderSelections[workspaceCwd] ?? [];

		const sendState = (clientId?: string): void => {
			const payload = {
				kind: "state",
				state: publicState(
					config,
					activeSprint,
					tickets,
					currentReviews(),
					currentRuns(),
					workspaceCwd,
					folders,
					currentFolderSelection(),
					error,
				),
			};
			host.broadcast(payload);
			if (clientId) host.sendTo(clientId, payload);
		};
		const sendResult = (clientId: string | undefined, result: Record<string, unknown>): void => {
			if (clientId) host.sendTo(clientId, { kind: "result", ...result });
		};
		const getToken = (): string => {
			const token = host.secrets.get("jira_api_token");
			if (!token?.trim()) throw new Error("Jira API token is not configured");
			return token;
		};
		const storeToken = (token: string): void => {
			try {
				host.secrets.set("jira_api_token", token);
			} catch {
				throw new Error("Jira API token could not be stored securely");
			}
			if (host.secrets.get("jira_api_token") !== token) throw new Error("Jira API token could not be stored securely");
		};
		const getApi = () => {
			if (!config) throw new Error("Jira is not configured");
			return createJiraApi(config.siteUrl, config.email, getToken());
		};

		const refresh = async (clientId?: string): Promise<void> => {
			try {
				if (!config) throw new Error("Jira is not configured");
				const api = getApi();
				activeSprint = await api.activeSprint(config.boardId);
				tickets = activeSprint
					? (await api.searchIssues(activeSprint.id, config.readyJql))
							.map(normalizeIssue)
							.filter((ticket): ticket is JiraTicket => !!ticket)
					: [];
				try {
					folders = (await host.fs.list()).filter((entry) => entry.type === "dir").map((entry) => entry.name);
				} catch {
					folders = [];
				}
				error = undefined;
			} catch (err) {
				error = errorText(err);
			}
			sendState(clientId);
		};

		const saveReview = (key: unknown, value: unknown): Record<string, unknown> => {
			if (typeof key !== "string" || !ISSUE_KEY_RE.test(key.trim())) throw new Error("Issue key is invalid");
			const reviewError = validateReview(value);
			if (reviewError) throw new Error(reviewError);
			const normalizedKey = key.trim();
			const scope = reviewScope(config);
			reviewStore = { ...reviewStore, [scope]: { ...currentReviews(), [normalizedKey]: asReview(value) } };
			const { [normalizedKey]: _completed, ...remainingRuns } = currentRuns();
			reviewRuns = { ...reviewRuns, [scope]: remainingRuns };
			host.storage.set(REVIEWS_KEY, reviewStore);
			host.storage.set(RUNS_KEY, reviewRuns);
			return { ok: true, key: normalizedKey };
		};

		const offMessage = host.onMessage(async (payload, from) => {
			const message = isRecord(payload) ? payload : {};
			try {
				switch (message.action) {
					case "get_state":
						sendState(from);
						break;
					case "save_config": {
						const next = validateConfig(message.config);
						const token = typeof message.token === "string" ? message.token.trim() : "";
						if (token) storeToken(token);
						else if (!host.secrets.get("jira_api_token")?.trim()) throw new Error("Jira API token is required");
						host.storage.set(CONFIG_KEY, next);
						config = next;
						error = undefined;
						sendResult(from, { ok: true, action: "save_config" });
						sendState(from);
						break;
					}
					case "start_review": {
						const key = String(message.key ?? "").trim();
						if (!ISSUE_KEY_RE.test(key)) throw new Error("Issue key is invalid");
						const scope = reviewScope(config);
						reviewRuns = { ...reviewRuns, [scope]: { ...currentRuns(), [key]: Date.now() } };
						host.storage.set(RUNS_KEY, reviewRuns);
						sendState(from);
						break;
					}
					case "cancel_review": {
						const key = String(message.key ?? "").trim();
						if (!ISSUE_KEY_RE.test(key)) throw new Error("Issue key is invalid");
						const scope = reviewScope(config);
						const { [key]: _cancelled, ...remainingRuns } = currentRuns();
						reviewRuns = { ...reviewRuns, [scope]: remainingRuns };
						host.storage.set(RUNS_KEY, reviewRuns);
						sendState(from);
						break;
					}
					case "save_folders": {
						const selected = Array.isArray(message.folders)
							? message.folders.filter(
									(folder): folder is string => typeof folder === "string" && folders.includes(folder),
								)
							: [];
						folderSelections = { ...folderSelections, [workspaceCwd]: [...new Set(selected)] };
						host.storage.set(FOLDER_SELECTIONS_KEY, folderSelections);
						sendState(from);
						break;
					}
					case "refresh":
						await refresh(from);
						break;
					case "save_review":
						sendResult(from, { action: "save_review", ...saveReview(message.key, message.review) });
						sendState(from);
						break;
					case "post_review": {
						const api = getApi();
						await api.postComment(String(message.key ?? ""), String(message.comment ?? ""));
						try {
							await api.addLabel(String(message.key ?? ""), TAG);
							host.notify("info", "Jira review posted and labeled");
							sendResult(from, { ok: true, action: "post_review", key: message.key });
						} catch (labelError) {
							host.notify("warning", `Jira review posted, but label update failed: ${errorText(labelError)}`);
							sendResult(from, {
								ok: true,
								action: "post_review",
								key: message.key,
								labelOk: false,
								labelError: errorText(labelError),
							});
						}
						break;
					}
				}
			} catch (err) {
				error = errorText(err);
				sendResult(from, { ok: false, action: message.action, error });
				sendState(from);
			}
		});

		const offAttach = host.onAttach?.((clientId) => sendState(clientId));
		const offCwdChange = host.onCwdChange?.((cwd) => {
			workspaceCwd = cwd;
			void host.fs
				.list()
				.then((entries) => {
					folders = entries.filter((entry) => entry.type === "dir").map((entry) => entry.name);
					sendState();
				})
				.catch(() => {
					folders = [];
					sendState();
				});
		});
		const offTool = host.registerAgentTool({
			name: "jira_review_save",
			description: "Save a complete Jira ticket review without posting to Jira.",
			parameters: {
				type: "object",
				properties: {
					key: { type: "string" },
					review: {
						type: "object",
						properties: {
							ready: { type: "boolean" },
							difficulty: { enum: ["easy", "medium", "hard"] },
							confidence: { enum: ["high", "medium", "low"] },
							rationale: { type: "string" },
							missingInfo: { type: "array", items: { type: "string" } },
							implementationPlan: { type: "array", items: { type: "string" } },
							draftComment: { type: "string" },
							confidenceSuggestions: { type: "array", items: { type: "string" } },
						},
					},
				},
				required: ["key", "review"],
			},
			execute: async (_id, params) => {
				const result = saveReview(params.key, params.review);
				sendState();
				return result;
			},
		});

		return () => {
			offMessage();
			offAttach?.();
			offCwdChange?.();
			offTool();
		};
	},
};

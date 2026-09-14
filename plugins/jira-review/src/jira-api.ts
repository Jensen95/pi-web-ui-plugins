export interface JiraIssue {
	id?: string;
	key?: string;
	fields?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface JiraSprint {
	id: number;
	name: string;
	state: string;
}

type Requester = (url: string, init?: RequestInit) => Promise<Response>;

const BOARD_ID_RE = /^\d+$/;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;

export function normalizeSiteUrl(value: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Site URL is required");
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Site URL must be a valid HTTPS URL");
	}
	if (url.protocol !== "https:") throw new Error("Site URL must use HTTPS");
	if (!url.hostname.toLowerCase().endsWith(".atlassian.net"))
		throw new Error("Site URL must be an Atlassian Cloud site");
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("Site URL must not contain credentials, a path, a query, or a fragment");
	}
	return url.origin;
}

function requireBoardId(value: unknown): string {
	const id = String(value ?? "").trim();
	if (!BOARD_ID_RE.test(id)) throw new Error("Board ID must be a number");
	return id;
}

function requireIssueKey(value: unknown): string {
	const key = String(value ?? "").trim();
	if (!ISSUE_KEY_RE.test(key)) throw new Error("Issue key is invalid");
	return key;
}

function requireJql(value: unknown): string {
	const jql = String(value ?? "").trim();
	if (!jql || jql.length > 4000 || jql.includes("\0")) throw new Error("Ready JQL is invalid");
	return jql;
}

function requestError(status: number, statusText: string): Error {
	const suffix = statusText && /^[\w .-]{1,80}$/.test(statusText) ? ` ${statusText}` : "";
	return new Error(`Jira request failed (${status}${suffix})`);
}

async function requestJson<T>(request: Requester, url: string, init: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await request(url, init);
	} catch {
		throw new Error("Jira request failed (network error)");
	}
	if (!response.ok) throw requestError(response.status, response.statusText);
	if (response.status === 204) return {} as T;
	try {
		return (await response.json()) as T;
	} catch {
		throw new Error("Jira returned an invalid response");
	}
}

export interface JiraApi {
	activeSprint(boardId: string): Promise<JiraSprint | null>;
	searchIssues(sprintId: number, readyJql: string): Promise<JiraIssue[]>;
	postComment(issueKey: string, comment: string): Promise<void>;
	addLabel(issueKey: string, label: string): Promise<void>;
}

export function createJiraApi(siteUrl: string, email: string, token: string, request: Requester = fetch): JiraApi {
	const base = normalizeSiteUrl(siteUrl);
	if (!email.trim() || !email.includes("@")) throw new Error("Jira email is invalid");
	if (!token.trim()) throw new Error("Jira API token is required");
	const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
	const headers = { Authorization: auth, Accept: "application/json" };
	const json = (path: string, init: RequestInit = {}) =>
		requestJson(request, `${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });

	return {
		async activeSprint(boardId) {
			const body = await json(`/rest/agile/1.0/board/${requireBoardId(boardId)}/sprint?state=active`);
			const values = (body as { values?: unknown }).values;
			if (!Array.isArray(values)) return null;
			const sprint = values.find((item): item is Record<string, unknown> => {
				return !!item && typeof item === "object" && Number.isInteger(Number((item as Record<string, unknown>).id));
			});
			if (!sprint) return null;
			return {
				id: Number(sprint.id),
				name: typeof sprint.name === "string" ? sprint.name : `Sprint ${sprint.id}`,
				state: typeof sprint.state === "string" ? sprint.state : "active",
			};
		},
		async searchIssues(sprintId, readyJql) {
			if (!Number.isInteger(sprintId) || sprintId < 0) throw new Error("Sprint ID is invalid");
			const jql = `sprint = ${sprintId} AND (${requireJql(readyJql)})`;
			const issues: JiraIssue[] = [];
			const pageSize = 100;
			let nextPageToken: string | undefined;
			for (;;) {
				const params = new URLSearchParams({
					jql,
					fields: "summary,status,assignee,labels,description",
					maxResults: String(pageSize),
				});
				if (nextPageToken) params.set("nextPageToken", nextPageToken);
				const body = await json(`/rest/api/3/search/jql?${params}`);
				const page = Array.isArray((body as { issues?: unknown }).issues)
					? ((body as { issues: JiraIssue[] }).issues ?? [])
					: [];
				issues.push(...page);
				const next = (body as { nextPageToken?: unknown }).nextPageToken;
				if (!page.length || (body as { isLast?: unknown }).isLast === true || typeof next !== "string" || !next)
					return issues;
				nextPageToken = next;
			}
		},
		async postComment(issueKey, comment) {
			const text = String(comment ?? "").trim();
			if (!text || text.length > 20000) throw new Error("Comment is invalid");
			await json(`/rest/api/3/issue/${encodeURIComponent(requireIssueKey(issueKey))}/comment`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
				}),
			});
		},
		async addLabel(issueKey, label) {
			const safeLabel = String(label ?? "").trim();
			if (!safeLabel || !/^[\w-]+$/.test(safeLabel)) throw new Error("Label is invalid");
			await json(`/rest/api/3/issue/${encodeURIComponent(requireIssueKey(issueKey))}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ update: { labels: [{ add: safeLabel }] } }),
			});
		},
	};
}

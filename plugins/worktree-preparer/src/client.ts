/**
 * The Worktree Preparer view.
 *
 * It assembles selected workspace folders into one fresh aggregate folder: a Git
 * repository gets a new branch as a `git worktree`, a plain folder is copied. The
 * view explains that in place, because the plugin is worthless if the reader has
 * to open the README to find out what "prepare" means.
 *
 * Everything the server sends is parsed through the tolerant helpers below: the
 * server contract grows per-folder Git info and per-entry errors, and an older or
 * newer payload must degrade into a readable view rather than throw inside a
 * render.
 */

interface ViewContext {
	send(payload: unknown): void;
	onData(callback: (payload: unknown) => void): () => void;
}

/** One selectable workspace folder. "unknown" means the Git probe is still running. */
export interface Folder {
	name: string;
	status: "git" | "plain" | "unknown";
	defaultBranch: string | null;
}

/** One prepared entry inside the aggregate. */
export interface PreparedEntry {
	source: string;
	name: string;
	destination: string;
	kind: "worktree" | "copy" | "skipped";
	baseBranch: string | null;
	error: string | null;
}

export interface PreparedResult {
	root: string;
	branch: string;
	outsideWorkspace: boolean;
	entries: PreparedEntry[];
	/** Failures the server could not attribute to a single entry. */
	errors: string[];
	/** The server's own verdict; null on an older payload that did not carry one. */
	ok: boolean | null;
}

export interface State {
	cwd: string;
	/** Absolute parent directory a relative output name is created under. */
	defaultBase: string;
	folders: Folder[];
	/** The Git probe has not finished, so some folders still say "unknown". */
	probing: boolean;
	/** A prepare run is in flight on the server. */
	busy: boolean;
	result: PreparedResult | null;
	error: string | null;
}

interface SessionHost {
	version?: number;
	openSession?(options: { folders: string[]; newChat?: boolean }): Promise<{ ok: boolean; error?: string }>;
}

const UPGRADE_HINT = "Opening a session here needs pi-web-ui 0.86 or newer.";
const DEFAULT_BRANCH = "agent/";
const DEFAULT_OUTPUT = "new-workspace";
const HOW_TO: string[] = [
	"Pick the folders you want in the session. A Git repository gets a new branch checked out as a worktree; anything else is copied.",
	"Name the branch and the workspace folder. The resolved path is shown under the field.",
	"Press Prepare and wait for the per-folder report.",
	"Press Open session here to work in the result.",
];
const OPEN_EXPLAINER =
	"This makes the prepared folder the working directory and clears the other workspace roots, so the file tree shows only these projects. The agent can still read elsewhere on disk.";

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Folders arrive either as bare names (old server) or as records with Git info. */
export function parseFolders(value: unknown): Folder[] {
	if (!Array.isArray(value)) return [];
	const folders: Folder[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			if (entry !== "") folders.push({ name: entry, status: "unknown", defaultBranch: null });
			continue;
		}
		const row = record(entry);
		const name = text(row?.name);
		if (!name) continue;
		const git = row?.status === "git" || row?.isGit === true;
		const plain = row?.status === "plain" || (row?.isGit === false && row?.status === undefined);
		folders.push({
			name,
			status: git ? "git" : plain ? "plain" : "unknown",
			defaultBranch: text(row?.defaultBranch) ?? text(row?.baseBranch),
		});
	}
	return folders;
}

function parseEntry(value: unknown): PreparedEntry | null {
	const row = record(value);
	if (!row) return null;
	const source = text(row.source) ?? text(row.destination);
	if (!source) return null;
	const kind = row.kind === "worktree" || row.kind === "copy" ? row.kind : "skipped";
	return {
		source,
		name: text(row.name) ?? source.split("/").filter(Boolean).pop() ?? source,
		destination: text(row.destination) ?? "",
		kind,
		baseBranch: text(row.baseBranch),
		error: text(row.error),
	};
}

/** The result, in the one shape the view renders. Null when there is no run yet. */
export function parseResult(value: unknown): PreparedResult | null {
	const row = record(value);
	const root = text(row?.root);
	if (!root) return null;
	const entries = Array.isArray(row?.entries)
		? row.entries.map(parseEntry).filter((entry): entry is PreparedEntry => entry !== null)
		: [];
	const errors = Array.isArray(row?.errors)
		? row.errors.filter((error): error is string => typeof error === "string")
		: [];
	return {
		root,
		branch: text(row?.branch) ?? "",
		outsideWorkspace: row?.outsideWorkspace === true,
		entries,
		errors,
		ok: typeof row?.ok === "boolean" ? row.ok : null,
	};
}

/**
 * The aggregate, but only when it is safe to open.
 *
 * A partial run still returns a usable `root`, and opening that folder would look
 * like success while a repository is simply missing from it. So a half-built
 * aggregate - a top-level error or any failed entry - is not openable.
 */
export function openableAggregate(result: unknown): PreparedResult | null {
	const parsed = parseResult(result);
	if (!parsed) return null;
	if (parsed.ok === false) return null;
	if (parsed.errors.length > 0) return null;
	if (parsed.entries.some((entry) => entry.error || entry.kind === "skipped")) return null;
	return parsed;
}

/** Where the aggregate lands, spelled out before the user commits to it. */
export function resolveOutputPath(base: string, outputName: string): string {
	const name = outputName.trim();
	if (name === "") return "";
	if (name.startsWith("/") || name.startsWith("~")) return name;
	const parent = base.trim().replace(/\/+$/, "");
	return parent === "" ? name : `${parent}/${name}`;
}

/** What will happen to a folder, in words, before anything runs. */
export function describeFolder(folder: Folder): string {
	if (folder.status === "unknown") return "Checking whether this is a Git repository...";
	if (folder.status === "plain") return "Plain folder - copied without .git, node_modules, dist, build or coverage";
	return folder.defaultBranch
		? `Git repository - new branch from ${folder.defaultBranch}`
		: "Git repository - new branch from its default branch";
}

/** What happened to one entry, in words. */
export function describeEntry(entry: PreparedEntry): string {
	if (entry.kind === "copy") return "Copied";
	if (entry.kind === "worktree") return entry.baseBranch ? `Worktree from ${entry.baseBranch}` : "Worktree";
	return "Skipped";
}

/** The one-line verdict for a finished run. */
export function summarizeResult(result: PreparedResult): string {
	const failed = result.entries.filter((entry) => entry.error || entry.kind === "skipped").length;
	const done = result.entries.length - failed;
	const head = `${done} of ${result.entries.length} folders prepared in ${result.root}`;
	const problems = failed + result.errors.length;
	return problems === 0 ? `${head}.` : `${head}, ${problems} problem(s) below.`;
}

export function stateFrom(payload: unknown): State | null {
	const outer = record(payload);
	const value = record(outer?.state) ?? outer;
	if (!value || (value.kind !== undefined && value.kind !== "state")) return null;
	const cwd = typeof value.cwd === "string" ? value.cwd : "";
	return {
		cwd,
		defaultBase: text(value.defaultBase) ?? cwd,
		folders: parseFolders(value.folders),
		probing: value.probing === true,
		busy: value.busy === true,
		result: parseResult(value.result),
		error: typeof value.error === "string" && value.error !== "" ? value.error : null,
	};
}

const VIEW_STYLE = `
.worktree-preparer { display: grid; gap: 16px; width: min(100%, 780px); color: var(--text, #e6e8ef); }
.worktree-preparer h1 { margin: 0; font-size: 1.2rem; }
.worktree-preparer h2 { margin: 0; font-size: .95rem; font-weight: 600; }
.worktree-preparer p { margin: 0; }
.worktree-preparer code { overflow-wrap: anywhere; font-size: .85em; color: var(--text-dim, #9aa1b4); }
.worktree-preparer button { cursor: pointer; border-radius: 7px; border: 1px solid var(--border, #262a35); background: var(--bg-elev2, #1a1d26); color: inherit; padding: 6px 12px; font: inherit; }
.worktree-preparer button:disabled { cursor: default; opacity: .5; }
.worktree-preparer__head { display: grid; gap: 4px; }
.worktree-preparer__sub { color: var(--text-dim, #9aa1b4); font-size: .9em; }
.worktree-preparer__card { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--border, #262a35); border-radius: 10px; background: var(--bg-elev, #14161c); }
.worktree-preparer__help { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 38%, transparent); }
.worktree-preparer__steps { margin: 0; padding-left: 20px; display: grid; gap: 6px; font-size: .9em; }
.worktree-preparer__bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: space-between; }
.worktree-preparer__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.worktree-preparer__rows { display: grid; gap: 6px; }
.worktree-preparer__row { display: flex; gap: 10px; align-items: baseline; padding: 8px 10px; border: 1px solid var(--border-soft, #1e2230); border-radius: 8px; background: var(--bg-elev2, #1a1d26); }
.worktree-preparer__name { font-weight: 600; }
.worktree-preparer__kind { font-size: .85em; color: var(--text-dim, #9aa1b4); }
.worktree-preparer__path { font-size: .8em; color: var(--text-faint, #6b7284); overflow-wrap: anywhere; }
.worktree-preparer__field { display: grid; gap: 4px; }
.worktree-preparer__field input { font: inherit; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--border, #262a35); background: var(--bg, #0d0e12); color: inherit; }
.worktree-preparer__hint { font-size: .8em; color: var(--text-faint, #6b7284); overflow-wrap: anywhere; }
.worktree-preparer__grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
.worktree-preparer__status { font-size: .9em; color: var(--text-dim, #9aa1b4); }
.worktree-preparer__error { color: var(--red, #f87171); font-size: .9em; overflow-wrap: anywhere; }
.worktree-preparer__empty { color: var(--text-dim, #9aa1b4); font-size: .9em; }
.worktree-preparer__open { border-color: color-mix(in srgb, var(--green, #4ade80) 40%, transparent); }
@media (max-width: 640px) { .worktree-preparer__grid { grid-template-columns: 1fr; } }
`;

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const document = container?.ownerDocument;
		if (!document || typeof container.replaceChildren !== "function") return () => {};

		let current: State = {
			cwd: "",
			defaultBase: "",
			folders: [],
			probing: false,
			busy: false,
			result: null,
			error: null,
		};
		let sessionNotice = "";
		let status = "";
		// Optimistic: the server also reports `busy`, but the first render after a
		// click must already be disabled, before any broadcast comes back.
		let sent = false;
		let helpOpen = true;
		let disposed = false;
		let branchDraft = DEFAULT_BRANCH;
		let outputDraft = DEFAULT_OUTPUT;
		const selected = new Set<string>();

		const create = (tag: string, className?: string, content?: string): HTMLElement => {
			const element = document.createElement(tag);
			if (className) element.className = className;
			if (content !== undefined) element.textContent = content;
			return element;
		};

		const setNotice = (value: string): void => {
			sessionNotice = value;
			if (!disposed) render();
		};

		/** Hand the aggregate to the host. Only the root: its entries are inside it,
		 *  and the host dedupes workspace roots by exact string, so passing them
		 *  would render the same subtree twice for no extra access. */
		const openSession = (root: string): void => {
			const view = document.defaultView as (Window & { __piWebUiHost?: SessionHost }) | null;
			const host = view?.__piWebUiHost;
			if (typeof host?.openSession !== "function") {
				setNotice(UPGRADE_HINT);
				return;
			}
			setNotice(`Opening ${root}...`);
			void Promise.resolve(host.openSession({ folders: [root], newChat: true }))
				.then((receipt) =>
					receipt?.ok
						? `Opened a session in ${root}.`
						: `Could not open the session: ${receipt?.error ?? "the host reported no reason"}`,
				)
				.catch((error: unknown) => `Could not open the session: ${messageOf(error)}`)
				.then(setNotice);
		};

		const button = (action: string, label: string, disabled = false): HTMLElement => {
			const element = create("button", undefined, label) as HTMLButtonElement;
			element.type = "button";
			element.dataset.action = action;
			element.disabled = disabled;
			return element;
		};

		const helpCard = (): HTMLElement => {
			const card = create("section", "worktree-preparer__card worktree-preparer__help");
			const bar = create("div", "worktree-preparer__bar");
			const toggle = button("toggle-help", helpOpen ? "Hide" : "Show");
			toggle.addEventListener("click", () => {
				helpOpen = !helpOpen;
				render();
			});
			bar.append(create("h2", undefined, "How this works"), toggle);
			card.append(bar);
			if (!helpOpen) return card;
			card.append(
				create(
					"p",
					"worktree-preparer__sub",
					"Build one folder that holds every project this session should see, without disturbing the originals.",
				),
			);
			const steps = create("ol", "worktree-preparer__steps");
			steps.append(...HOW_TO.map((step) => create("li", undefined, step)));
			card.append(steps);
			return card;
		};

		const folderCard = (): HTMLElement => {
			const card = create("section", "worktree-preparer__card");
			const bar = create("div", "worktree-preparer__bar");
			const title = create("h2", undefined, `Folders in ${current.cwd || "this workspace"}`);
			const actions = create("div", "worktree-preparer__actions");
			const up = button("browse-up", "Up", !current.cwd || current.cwd === "/");
			up.addEventListener("click", () => ctx.send({ action: "browse_up" }));
			actions.append(up);
			const all = button("select-all", "Select all", current.folders.length === 0);
			all.addEventListener("click", () => {
				for (const folder of current.folders) selected.add(folder.name);
				render();
			});
			const none = button("select-none", "Select none", selected.size === 0);
			none.addEventListener("click", () => {
				selected.clear();
				render();
			});
			actions.append(all, none);
			bar.append(title, actions);
			card.append(bar);
			if (current.folders.length === 0) {
				card.append(
					create(
						"p",
						"worktree-preparer__empty",
						"No subfolders in this workspace yet. Open a workspace that contains your projects, then reload this view.",
					),
				);
				return card;
			}
			const rows = create("div", "worktree-preparer__rows");
			rows.append(
				...current.folders.map((folder) => {
					const row = create("div", "worktree-preparer__row");
					const box = document.createElement("input") as HTMLInputElement;
					box.type = "checkbox";
					box.dataset.field = "selection";
					box.value = folder.name;
					box.checked = selected.has(folder.name);
					box.addEventListener("click", () => {
						if (box.checked) selected.add(folder.name);
						else selected.delete(folder.name);
						render();
					});
					const open = button("browse-into", "Open");
					open.addEventListener("click", () => ctx.send({ action: "browse_into", name: folder.name }));
					row.append(
						box,
						create("span", "worktree-preparer__name", folder.name),
						create("span", "worktree-preparer__kind", describeFolder(folder)),
						open,
					);
					return row;
				}),
			);
			card.append(rows);
			if (current.probing) {
				card.append(create("p", "worktree-preparer__hint", "Still checking which folders are Git repositories..."));
			}
			return card;
		};

		const fieldCard = (): { card: HTMLElement; branch: HTMLInputElement; output: HTMLInputElement } => {
			const card = create("section", "worktree-preparer__card");
			card.append(create("h2", undefined, "Name the branch and the workspace folder"));
			const grid = create("div", "worktree-preparer__grid");

			const branchWrap = create("label", "worktree-preparer__field");
			const branch = document.createElement("input") as HTMLInputElement;
			branch.type = "text";
			branch.dataset.field = "branch";
			branch.value = branchDraft;
			branch.addEventListener("input", () => {
				branchDraft = branch.value;
			});
			branchWrap.append(
				create("span", undefined, "Branch name"),
				branch,
				create("span", "worktree-preparer__hint", "Created in every selected repository, for example agent/login-fix."),
			);

			const outputWrap = create("label", "worktree-preparer__field");
			const output = document.createElement("input") as HTMLInputElement;
			output.type = "text";
			output.dataset.field = "outputName";
			output.value = outputDraft;
			const resolved = create("span", "worktree-preparer__hint", "");
			resolved.dataset.field = "outputPath";
			const showPath = (): void => {
				const path = resolveOutputPath(current.defaultBase, outputDraft);
				resolved.textContent = path
					? `Lands in ${path}. An absolute path is used as written.`
					: "Give the folder a name, or an absolute path.";
			};
			output.addEventListener("input", () => {
				outputDraft = output.value;
				showPath();
			});
			showPath();
			outputWrap.append(create("span", undefined, "Workspace folder name"), output, resolved);

			grid.append(branchWrap, outputWrap);
			card.append(grid);
			return { card, branch, output };
		};

		const resultCard = (result: PreparedResult): HTMLElement => {
			const card = create("section", "worktree-preparer__card");
			card.append(create("h2", undefined, "Result"));
			const summary = create("p", "worktree-preparer__status", summarizeResult(result));
			summary.dataset.field = "result";
			card.append(summary);
			const rows = create("div", "worktree-preparer__rows");
			rows.append(
				...result.entries.map((entry) => {
					const row = create("div", "worktree-preparer__row");
					row.dataset.entry = entry.source;
					const lines = create("div", "worktree-preparer__field");
					lines.append(
						create("span", "worktree-preparer__name", entry.source),
						create("span", "worktree-preparer__kind", describeEntry(entry)),
						create("span", "worktree-preparer__path", entry.destination),
					);
					if (entry.error) {
						const failure = create("span", "worktree-preparer__error", entry.error);
						failure.dataset.field = "entry-error";
						lines.append(failure);
					}
					row.append(lines);
					return row;
				}),
			);
			card.append(rows);
			for (const problem of result.errors) {
				const failure = create("p", "worktree-preparer__error", problem);
				failure.dataset.field = "run-error";
				card.append(failure);
			}
			return card;
		};

		const openCard = (aggregate: PreparedResult): HTMLElement => {
			const card = create("section", "worktree-preparer__card worktree-preparer__open");
			const open = button("open-session", "Open session here");
			open.addEventListener("click", () => openSession(aggregate.root));
			card.append(create("h2", undefined, "Work in the prepared folder"), open);
			card.append(create("p", "worktree-preparer__hint", OPEN_EXPLAINER));
			return card;
		};

		const render = (): void => {
			const root = create("section", "worktree-preparer");
			const style = document.createElement("style");
			style.textContent = VIEW_STYLE;

			const head = create("div", "worktree-preparer__head");
			head.append(
				create("h1", undefined, "Worktree Preparer"),
				create(
					"p",
					"worktree-preparer__sub",
					"Assemble selected folders into one fresh folder: repositories as new branches, everything else copied.",
				),
			);

			const fields = fieldCard();
			const busy = sent || current.busy;
			const submit = (action: "prepare" | "add", label: string): HTMLElement => {
				const element = button(action, busy ? "Working..." : label, busy || selected.size === 0);
				element.addEventListener("click", () => {
					if (busy) return;
					sent = true;
					status = `${action === "add" ? "Adding" : "Preparing"} ${selected.size} folder(s)...`;
					ctx.send({
						action,
						branch: fields.branch.value,
						outputName: fields.output.value,
						selections: current.folders.map((folder) => folder.name).filter((name) => selected.has(name)),
					});
					render();
				});
				return element;
			};
			const prepare = submit("prepare", "Prepare");
			const add = current.result ? submit("add", "Add selected folders") : null;
			const run = create("section", "worktree-preparer__card");
			const bar = create("div", "worktree-preparer__bar");
			const statusLine = create(
				"p",
				"worktree-preparer__status",
				busy ? status : selected.size === 0 ? "Select at least one folder to enable Prepare." : status,
			);
			statusLine.dataset.field = "status";
			bar.append(prepare);
			if (add) bar.append(add);
			bar.append(statusLine);
			run.append(bar);
			const error = create("p", "worktree-preparer__error", current.error ?? "");
			error.dataset.field = "error";
			run.append(error);

			root.append(style, head, helpCard(), folderCard(), fields.card, run);
			if (current.result) root.append(resultCard(current.result));
			const aggregate = openableAggregate(current.result);
			if (aggregate) root.append(openCard(aggregate));
			if (sessionNotice) {
				const notice = create("p", "worktree-preparer__status", sessionNotice);
				notice.dataset.field = "session";
				root.append(notice);
			}

			container.replaceChildren(root);
		};

		render();
		const unsubscribe = ctx.onData((payload) => {
			const next = stateFrom(payload);
			if (!next) return;
			current = next;
			sent = false;
			status = current.busy ? "Preparing..." : "";
			// Drop selections the workspace no longer offers, so a stale tick cannot
			// be submitted invisibly.
			const names = new Set(current.folders.map((folder) => folder.name));
			for (const name of [...selected]) if (!names.has(name)) selected.delete(name);
			render();
		});
		ctx.send({ action: "get_state" });
		return () => {
			disposed = true;
			unsubscribe();
			container.replaceChildren();
		};
	},
};

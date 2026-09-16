interface ViewContext {
	send(payload: unknown): void;
	onData(callback: (payload: unknown) => void): () => void;
}

interface State {
	cwd: string;
	folders: string[];
	result: unknown;
	error: string | null;
}

/** What the host needs from a prepared aggregate to be openable. */
interface AggregateResult {
	root: string;
	errors: string[];
}

interface SessionHost {
	version?: number;
	openSession?(options: { folders: string[]; newChat?: boolean }): Promise<{ ok: boolean; error?: string }>;
}

const UPGRADE_HINT = "Opening a session here needs pi-web-ui 0.86 or newer.";

/**
 * The aggregate, but only when it is safe to open.
 *
 * A partial run still returns a usable `root` alongside a non-empty `errors`
 * array, and opening that folder would look like success while some repositories
 * are simply missing from it. So a half-built aggregate is not openable.
 */
function openableAggregate(result: unknown): AggregateResult | null {
	const value = record(result);
	if (!value || typeof value.root !== "string" || value.root.trim() === "") return null;
	const errors = Array.isArray(value.errors) ? value.errors : [];
	if (errors.length > 0) return null;
	return { root: value.root, errors: [] };
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stateFrom(payload: unknown): State | null {
	const outer = record(payload);
	const value = record(outer?.state) ?? outer;
	if (!value || (value.kind !== undefined && value.kind !== "state")) return null;
	return {
		cwd: typeof value.cwd === "string" ? value.cwd : "",
		folders: Array.isArray(value.folders)
			? value.folders.filter((folder): folder is string => typeof folder === "string")
			: [],
		result: value.result ?? null,
		error: typeof value.error === "string" ? value.error : null,
	};
}

function field(document: Document, name: string, type = "text"): HTMLInputElement {
	const input = document.createElement("input");
	input.type = type;
	input.dataset.field = name;
	return input;
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const document = container?.ownerDocument;
		if (!document || typeof container.replaceChildren !== "function") return () => {};

		let current: State = { cwd: "", folders: [], result: null, error: null };
		let sessionNotice = "";
		let disposed = false;

		const setNotice = (text: string): void => {
			sessionNotice = text;
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

		let branch: HTMLInputElement;
		let outputName: HTMLInputElement;
		let selections: HTMLInputElement[] = [];
		const render = (): void => {
			const heading = document.createElement("h3");
			heading.textContent = "Prepare worktrees";
			const cwd = document.createElement("p");
			cwd.textContent = current.cwd;

			branch = field(document, "branch");
			branch.value = "agent/";
			outputName = field(document, "outputName");
			outputName.value = ".pi/projects/new-project";
			selections = current.folders.map((folder) => {
				const input = field(document, "selection", "checkbox");
				input.value = folder;
				return input;
			});

			const prepare = document.createElement("button");
			prepare.type = "button";
			prepare.dataset.action = "prepare";
			prepare.textContent = "Prepare";
			prepare.addEventListener("click", () => {
				ctx.send({
					action: "prepare",
					branch: branch.value,
					outputName: outputName.value,
					selections: selections.filter((selection) => selection.checked).map((selection) => selection.value),
				});
			});

			const status = document.createElement("p");
			status.dataset.field = "result";
			status.textContent = current.result ? JSON.stringify(current.result) : "";
			const error = document.createElement("p");
			error.dataset.field = "error";
			error.textContent = current.error ?? "";
			const notice = document.createElement("p");
			notice.dataset.field = "session";
			notice.textContent = sessionNotice;

			const aggregate = openableAggregate(current.result);
			const extras: HTMLElement[] = [];
			if (aggregate) {
				const open = document.createElement("button");
				open.type = "button";
				open.dataset.action = "open-session";
				open.textContent = "Open session here";
				open.addEventListener("click", () => openSession(aggregate.root));
				extras.push(open);
			}
			container.replaceChildren(
				heading,
				cwd,
				branch,
				outputName,
				...selections,
				prepare,
				status,
				error,
				...extras,
				notice,
			);
		};

		render();
		const unsubscribe = ctx.onData((payload) => {
			const next = stateFrom(payload);
			if (next) {
				current = next;
				render();
			}
		});
		ctx.send({ action: "get_state" });
		return () => {
			disposed = true;
			unsubscribe();
			container.replaceChildren();
		};
	},
};

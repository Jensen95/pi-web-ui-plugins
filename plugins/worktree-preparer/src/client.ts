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

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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
			container.replaceChildren(heading, cwd, branch, outputName, ...selections, prepare, status, error);
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
			unsubscribe();
			container.replaceChildren();
		};
	},
};

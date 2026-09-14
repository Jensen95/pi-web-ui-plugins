import { prepareProject, type PrepareResult } from "./ops";

type Host = {
	cwd: string;
	broadcast(payload: unknown): void;
	sendTo(clientId: string, payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onAttach?(handler: (clientId: string) => void): () => void;
	onCwdChange?(handler: (cwd: string) => void): () => void;
	fs: {
		list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
	};
};

type State = {
	kind: "state";
	cwd: string;
	folders: string[];
	result: PrepareResult | null;
	error: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}

export default {
	activate(host: Host): () => void {
		let state: State = { kind: "state", cwd: host.cwd, folders: [], result: null, error: null };

		const publish = (clientId?: string): void => {
			host.broadcast(state);
			if (clientId) host.sendTo(clientId, state);
		};

		const refresh = async (clientId?: string): Promise<void> => {
			try {
				const entries = await host.fs.list();
				state = {
					...state,
					cwd: host.cwd,
					folders: entries
						.filter((entry) => entry.type === "dir")
						.map((entry) => entry.name)
						.sort(),
					error: null,
				};
			} catch (error) {
				state = { ...state, cwd: host.cwd, error: String(error) };
			}
			publish(clientId);
		};

		const unregister = host.onMessage(async (payload, from) => {
			if (!isRecord(payload) || typeof payload.action !== "string") return;
			if (payload.action === "get_state") {
				await refresh(from);
				return;
			}
			if (payload.action !== "prepare") return;

			try {
				const selections = Array.isArray(payload.selections)
					? payload.selections.filter((selection): selection is string => typeof selection === "string")
					: [];
				const result = await prepareProject({
					workspaceRoot: host.cwd,
					outputName: typeof payload.outputName === "string" ? payload.outputName : "",
					branch: typeof payload.branch === "string" ? payload.branch : "",
					selections,
				});
				state = { ...state, cwd: host.cwd, result, error: result.errors.length ? result.errors.join("; ") : null };
			} catch (error) {
				state = { ...state, cwd: host.cwd, result: null, error: String(error) };
			}
			publish(from);
			if (!from) publish();
		});

		const onAttach = host.onAttach?.((clientId) => void refresh(clientId));
		const onCwdChange = host.onCwdChange?.(() => void refresh());
		return () => {
			unregister();
			onAttach?.();
			onCwdChange?.();
		};
	},
};

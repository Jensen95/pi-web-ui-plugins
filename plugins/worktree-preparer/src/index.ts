import { resolve } from "node:path";
import {
	defaultOutputBase,
	defaultRunner,
	prepareProject,
	probeFolder,
	type CommandRunner,
	type PrepareResult,
} from "./ops";

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

export interface WorkspaceFolder {
	/** Folder name relative to the workspace root; this is what `prepare` expects back. */
	name: string;
	/** Absolute path. */
	path: string;
	/** "unknown" until the background Git probe for this cwd has finished. */
	status: "unknown" | "git" | "plain";
	/** Plain remote default branch name, e.g. "main"; null unless status is "git". */
	defaultBranch: string | null;
}

type State = {
	kind: "state";
	cwd: string;
	folders: WorkspaceFolder[];
	/** Absolute parent directory a relative output name is created under. */
	defaultBase: string;
	/** True while the Git probe is still running; folders may still say "unknown". */
	probing: boolean;
	/** True while a prepare run is in flight. */
	busy: boolean;
	result: PrepareResult | null;
	error: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}

export default {
	activate(host: Host, deps: { runner?: CommandRunner } = {}): () => void {
		const runner = deps.runner ?? defaultRunner;
		let state: State = {
			kind: "state",
			cwd: host.cwd,
			folders: [],
			defaultBase: defaultOutputBase(),
			probing: false,
			busy: false,
			result: null,
			error: null,
		};
		// Probing every folder costs a couple of git calls each, so attach must not
		// wait for it: results are cached per cwd and dropped when the cwd changes.
		let probes = new Map<string, WorkspaceFolder>();
		let probeToken = 0;

		const publish = (clientId?: string): void => {
			host.broadcast(state);
			if (clientId) host.sendTo(clientId, state);
		};

		const probeAll = async (cwd: string, token: number): Promise<void> => {
			for (const folder of state.folders) {
				if (token !== probeToken) return;
				if (probes.has(folder.path)) continue;
				const probe = await probeFolder(runner, folder.path, cwd);
				probes.set(folder.path, {
					name: folder.name,
					path: folder.path,
					status: probe.git ? "git" : "plain",
					defaultBranch: probe.defaultBranch,
				});
			}
			if (token !== probeToken) return;
			state = { ...state, probing: false, folders: state.folders.map((folder) => probes.get(folder.path) ?? folder) };
			publish();
		};

		const refresh = async (clientId?: string): Promise<void> => {
			const cwd = host.cwd;
			try {
				const entries = await host.fs.list();
				const folders = entries
					.filter((entry) => entry.type === "dir")
					.map((entry) => entry.name)
					.sort()
					.map((name) => {
						const path = resolve(cwd, name);
						return probes.get(path) ?? { name, path, status: "unknown" as const, defaultBranch: null };
					});
				state = { ...state, cwd, folders, probing: folders.some((f) => f.status === "unknown"), error: null };
			} catch (error) {
				state = { ...state, cwd, probing: false, error: String(error) };
			}
			publish(clientId);
			if (state.probing) void probeAll(cwd, ++probeToken);
		};

		const unregister = host.onMessage(async (payload, from) => {
			if (!isRecord(payload) || typeof payload.action !== "string") return;
			if (payload.action === "get_state") {
				await refresh(from);
				return;
			}
			if (payload.action !== "prepare") return;

			state = { ...state, busy: true, error: null };
			publish(from);
			try {
				const selections = Array.isArray(payload.selections)
					? payload.selections.filter((selection): selection is string => typeof selection === "string")
					: [];
				const result = await prepareProject({
					workspaceRoot: host.cwd,
					outputBase: typeof payload.outputBase === "string" && payload.outputBase ? payload.outputBase : undefined,
					outputName: typeof payload.outputName === "string" ? payload.outputName : "",
					branch: typeof payload.branch === "string" ? payload.branch : "",
					baseBranch: typeof payload.baseBranch === "string" && payload.baseBranch ? payload.baseBranch : undefined,
					selections,
				});
				state = {
					...state,
					cwd: host.cwd,
					busy: false,
					result,
					// Per-entry failures live in `result`, which the view renders per row;
					// mirroring them here too would print every message twice.
					error: null,
				};
			} catch (error) {
				state = { ...state, cwd: host.cwd, busy: false, result: null, error: String(error) };
			}
			publish(from);
			if (!from) publish();
		});

		const onAttach = host.onAttach?.((clientId) => void refresh(clientId));
		const onCwdChange = host.onCwdChange?.(() => {
			probeToken += 1;
			probes = new Map();
			void refresh();
		});
		return () => {
			probeToken += 1;
			unregister();
			onAttach?.();
			onCwdChange?.();
		};
	},
};

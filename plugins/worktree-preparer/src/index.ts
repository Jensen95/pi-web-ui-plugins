import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	addFolders,
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
		requestAccess?(dir: string, reason?: string): Promise<boolean>;
		listPath?(dir: string): Promise<{ name: string; type: "file" | "dir" }[]>;
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

		const isInside = (root: string, candidate: string): boolean => {
			const suffix = relative(resolve(root), resolve(candidate));
			return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
		};

		const refresh = async (clientId?: string, requestedCwd = host.cwd): Promise<void> => {
			const cwd = resolve(requestedCwd);
			try {
				let entries: { name: string; type: "file" | "dir" }[];
				if (cwd === resolve(host.cwd)) {
					entries = await host.fs.list();
				} else {
					if (!host.fs.requestAccess || !host.fs.listPath)
						throw new Error("This host cannot browse outside the workspace");
					const allowed = await host.fs.requestAccess(cwd, "Browse folders for Worktree Preparer");
					if (!allowed) throw new Error(`Access was not granted for ${cwd}`);
					entries = await host.fs.listPath(cwd);
				}
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
				await refresh(from, state.cwd);
				return;
			}
			if (payload.action === "browse_up") {
				const parent = dirname(state.cwd);
				if (parent !== state.cwd) await refresh(from, parent);
				return;
			}
			if (payload.action === "browse_into") {
				const name = typeof payload.name === "string" ? payload.name : "";
				const child = resolve(state.cwd, name);
				if (name && !name.includes("..") && isInside(state.cwd, child)) await refresh(from, child);
				return;
			}
			if (payload.action !== "prepare" && payload.action !== "add") return;

			state = { ...state, busy: true, error: null };
			publish(from);
			try {
				const selections = Array.isArray(payload.selections)
					? payload.selections.filter((selection): selection is string => typeof selection === "string")
					: [];
				if (payload.action === "prepare") {
					const result = await prepareProject({
						workspaceRoot: state.cwd,
						outputBase: typeof payload.outputBase === "string" && payload.outputBase ? payload.outputBase : undefined,
						outputName: typeof payload.outputName === "string" ? payload.outputName : "",
						branch: typeof payload.branch === "string" ? payload.branch : "",
						baseBranch: typeof payload.baseBranch === "string" && payload.baseBranch ? payload.baseBranch : undefined,
						selections,
					});
					state = { ...state, busy: false, result, error: null };
				} else if (state.result) {
					const additions = await addFolders(
						{
							workspaceRoot: state.cwd,
							outputRoot: state.result.root,
							branch: state.result.branch,
							selections,
							existingNames: state.result.entries.map((entry) => entry.name),
							existingSources: state.result.entries.map((entry) => entry.source),
						},
						{ runner },
					);
					const errors = [...state.result.errors, ...additions.errors];
					state = {
						...state,
						busy: false,
						result: {
							...state.result,
							entries: [...state.result.entries, ...additions.entries],
							errors,
							ok: errors.length === 0,
						},
						error: null,
					};
				} else {
					throw new Error("Prepare a workspace before adding folders");
				}
			} catch (error) {
				state = { ...state, busy: false, result: payload.action === "add" ? state.result : null, error: String(error) };
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

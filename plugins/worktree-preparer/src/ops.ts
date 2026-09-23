import { cp, mkdir as makeDirectory } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

export const DEFAULT_EXCLUDES = [
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".venv",
	"target",
] as const;

/** Last resort when a repository has no resolvable remote default branch. */
export const FALLBACK_BASE_BRANCH = "master";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandRunner {
	run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export interface FileOperations {
	mkdir(path: string, recursive?: boolean): Promise<void>;
	copyTree(source: string, destination: string, excludes: readonly string[]): Promise<void>;
}

export interface PrepareInput {
	/** Absolute path of the current workspace; every selection is resolved against it. */
	workspaceRoot: string;
	/** Absolute parent directory for a relative `outputName`. Defaults to `defaultOutputBase()`. */
	outputBase?: string;
	/** Aggregate folder: a relative name under `outputBase`, or an absolute path. */
	outputName: string;
	/** New branch created in every selected repository. */
	branch: string;
	/** Optional override of the per-repository remote default branch. */
	baseBranch?: string;
	/** Workspace-relative folder paths. */
	selections: string[];
}

export interface PrepareEntry {
	/** Absolute source folder (the repository root for a worktree). */
	source: string;
	/** Absolute destination inside the aggregate; empty when the entry failed before a destination was picked. */
	destination: string;
	/** Destination folder name inside the aggregate. */
	name: string;
	kind: "worktree" | "copy" | "skipped";
	/** Plain branch name the worktree started from; the worktree was created off `origin/<baseBranch>`. */
	baseBranch: string | null;
	/** Why this entry failed or was skipped; null when it succeeded. */
	error: string | null;
}

export interface PrepareResult {
	/** Absolute aggregate root. */
	root: string;
	/** Absolute parent directory the aggregate was created in. */
	base: string;
	/** Whether the aggregate sits outside the current workspace. */
	outsideWorkspace: boolean;
	/** The new branch name used for every worktree. */
	branch: string;
	entries: PrepareEntry[];
	/** Flat mirror of every entry error; empty when the whole run succeeded. */
	errors: string[];
	/** True when at least one entry was created and nothing failed. */
	ok: boolean;
}

export interface FolderProbe {
	/** Absolute folder path. */
	path: string;
	git: boolean;
	/** Absolute repository root when `git` is true. */
	repositoryRoot: string | null;
	/** Plain remote default branch name when `git` is true. */
	defaultBranch: string | null;
}

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const REMOTE_GIT_TIMEOUT_MS = 120_000;

export const defaultRunner: CommandRunner = {
	async run(command, args, cwd) {
		const timeout =
			command === "git" && (args[2] === "fetch" || args[2] === "ls-remote")
				? REMOTE_GIT_TIMEOUT_MS
				: DEFAULT_COMMAND_TIMEOUT_MS;
		try {
			const result = await execFileAsync(command, args, { cwd, maxBuffer: 1024 * 1024, timeout });
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as {
				code?: number | string | null;
				stdout?: string;
				stderr?: string;
				message?: string;
				killed?: boolean;
			};
			const timedOut = failure.code === "ETIMEDOUT" || (failure.killed && failure.code == null);
			return {
				code: typeof failure.code === "number" ? failure.code : 1,
				stdout: failure.stdout ?? "",
				stderr: timedOut
					? `${command} ${args.join(" ")} timed out after ${timeout / 1000} seconds; check the repository or remote connection, then retry.`
					: (failure.stderr ?? failure.message ?? String(error)),
			};
		}
	},
};

export const defaultFileOperations: FileOperations = {
	async mkdir(path, recursive = false) {
		await makeDirectory(path, { recursive });
	},
	async copyTree(source, destination, excludes) {
		const root = resolve(source);
		const excluded = new Set(excludes);
		await cp(source, destination, {
			recursive: true,
			filter: (entry) => resolve(entry) === root || !excluded.has(basename(entry)),
		});
	},
};

/**
 * Where aggregates go when the caller does not say.
 *
 * The host has no scratch-folder convention (`~/.pi-web` is host-internal state
 * only), so this picks a plainly user-owned directory instead of borrowing one.
 */
export function defaultOutputBase(): string {
	return join(homedir(), "pi-workspaces");
}

function inside(root: string, candidate: string): boolean {
	const suffix = relative(root, candidate);
	return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function workspacePath(workspaceRoot: string, value: string, label: string): string | null {
	if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot))
		return `${label} must use an absolute workspace path`;
	if (typeof value !== "string" || value.trim() === "") return `${label} must not be empty`;
	if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return `${label} must stay inside the workspace`;
	const normalized = value.replaceAll("\\", sep);
	if (normalized.split(sep).includes("..")) return `${label} escapes the workspace`;
	const candidate = resolve(workspaceRoot, normalized);
	return inside(resolve(workspaceRoot), candidate) ? null : `${label} escapes the workspace`;
}

export function validateSelection(workspaceRoot: string, selection: string): string | null {
	return workspacePath(workspaceRoot, selection, `selection "${String(selection)}"`);
}

/**
 * The aggregate is allowed to live outside the workspace - that is the whole
 * point, an aggregate nested inside a source project puts the session cwd back
 * inside that project and `../..` walks straight out of the scope the user asked
 * for. What stays enforced here is everything that is actually dangerous:
 *
 *  - no `..` segment and no null byte, so a caller cannot climb out of a base it
 *    was handed (the string is still attacker-shaped input from a view payload);
 *  - an absolute target must resolve at least two segments deep, so a typo or a
 *    hostile payload can never aim at `/`, `/home`, or `/tmp` itself;
 *  - a relative name must resolve inside its base after normalisation.
 *
 * Collision with a selected source folder, and the refusal to reuse an existing
 * directory, are enforced in `prepareProject` where the selections are known.
 */
/**
 * `~/name` is what a user types for "in my home directory", and the view shows it
 * back verbatim, so it has to mean the same thing on both sides. Without this it
 * silently became a literal `~` directory under the default base.
 */
function normalizeOutput(value: string): string {
	const normalized = value.replaceAll("\\", sep);
	// `..` is rejected on the raw value first, before this runs: `join` collapses
	// `..` segments, so expanding `~/../../etc/cron.d` here would hand the caller
	// an innocent-looking absolute path that the `..` guard never sees.
	return normalized === "~" || normalized.startsWith(`~${sep}`) ? join(homedir(), normalized.slice(1)) : normalized;
}

function hasParentSegment(value: string): boolean {
	return value.replaceAll("\\", sep).split(sep).includes("..");
}

export function validateOutput(base: string, value: string): string | null {
	if (typeof base !== "string" || !isAbsolute(base)) return "output base must use an absolute path";
	if (typeof value !== "string" || value.trim() === "") return "output name must not be empty";
	if (value.includes("\0")) return "output name must not contain a null byte";
	if (hasParentSegment(value)) return 'output path must not contain ".."';
	const normalized = normalizeOutput(value);
	if (isAbsolute(normalized)) {
		const candidate = resolve(normalized);
		if (candidate.split(sep).filter(Boolean).length < 2) return "output path must not be a top-level directory";
		return null;
	}
	return inside(resolve(base), resolve(base, normalized)) ? null : "output path escapes its base directory";
}

/** Absolute aggregate root for an already validated output value. */
export function outputRootFor(base: string, value: string): string {
	if (hasParentSegment(value)) throw new Error('output path must not contain ".."');
	const normalized = normalizeOutput(value);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized);
}

export function validateBranchName(branch: string): string | null {
	if (typeof branch !== "string" || branch.length === 0) return "branch name must not be empty";
	if (
		branch.startsWith("-") ||
		branch.startsWith("/") ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch === "@" ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("@{") ||
		branch
			.split("/")
			.some((part) => part === "" || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) ||
		/[\x00-\x20\x7f~^:?*[\\]/.test(branch)
	) {
		return `invalid branch name "${branch}"`;
	}
	return null;
}

/** Plain branch name out of `refs/remotes/origin/main` or `refs/heads/main`. */
export function branchFromRef(ref: string): string {
	const match = /^refs\/(?:remotes\/[^/]+|heads)\/(.+)$/.exec(String(ref ?? "").trim());
	const branch = match?.[1] ?? "";
	return branch && !validateBranchName(branch) ? branch : "";
}

/**
 * The remote's default branch, per repository. `origin/HEAD` is set for most
 * clones; when it is not, ask the remote directly; only then assume `master`.
 */
export async function resolveDefaultBranch(runner: CommandRunner, repository: string): Promise<string> {
	const symbolic = await runner.run(
		"git",
		["-C", repository, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
		repository,
	);
	const local = symbolic.code === 0 ? branchFromRef(symbolic.stdout) : "";
	if (local) return local;
	const remote = await runner.run("git", ["-C", repository, "ls-remote", "--symref", "origin", "HEAD"], repository);
	if (remote.code === 0) {
		const match = /^ref:\s+(\S+)\s+HEAD$/m.exec(remote.stdout);
		const branch = branchFromRef(match?.[1] ?? "");
		if (branch) return branch;
	}
	return FALLBACK_BASE_BRANCH;
}

/** Is this folder a Git repository, and what does its remote default to? */
export async function probeFolder(runner: CommandRunner, folder: string, cwd: string): Promise<FolderProbe> {
	let probe: CommandResult;
	try {
		probe = await runner.run("git", ["-C", folder, "rev-parse", "--show-toplevel"], cwd);
	} catch (error) {
		probe = { code: 1, stdout: "", stderr: String(error) };
	}
	const rootText = probe.code === 0 ? probe.stdout.trim() : "";
	if (!rootText) return { path: folder, git: false, repositoryRoot: null, defaultBranch: null };
	const repositoryRoot = resolve(rootText);
	let defaultBranch: string | null = null;
	try {
		defaultBranch = await resolveDefaultBranch(runner, repositoryRoot);
	} catch {
		defaultBranch = FALLBACK_BASE_BRANCH;
	}
	return { path: folder, git: true, repositoryRoot, defaultBranch };
}

function errorText(source: string, action: string, result: CommandResult): string {
	const detail = (result.stderr || result.stdout).trim();
	return `${source}: ${action}${detail ? ` (${detail})` : " failed"}`;
}

function isNotRepository(result: CommandResult): boolean {
	return /not a git repository|not a git repo|no git repository/i.test(result.stderr);
}

export async function prepareProject(
	input: PrepareInput,
	deps: { runner?: CommandRunner; fs?: unknown } = {},
): Promise<PrepareResult> {
	if (!isAbsolute(input.workspaceRoot ?? "")) throw new Error("workspaceRoot must use an absolute path");
	const workspaceRoot = resolve(input.workspaceRoot);
	const branchError = validateBranchName(input.branch);
	if (branchError) throw new Error(branchError);
	if (input.baseBranch !== undefined && input.baseBranch !== "") {
		const baseError = validateBranchName(input.baseBranch);
		if (baseError) throw new Error(`base ${baseError}`);
	}
	const base = resolve(input.outputBase ?? defaultOutputBase());
	const outputError = validateOutput(base, input.outputName);
	if (outputError) throw new Error(outputError);
	if (!Array.isArray(input.selections)) throw new Error("selections must be an array");
	// Before mkdir on purpose: an empty run would otherwise leave a stray empty
	// aggregate directory behind, which then blocks the retry with EEXIST.
	if (input.selections.length === 0) throw new Error("select at least one folder");

	const outputRoot = outputRootFor(base, input.outputName);
	const selectedPaths: string[] = [];
	for (const selection of input.selections) {
		const selectionError = validateSelection(workspaceRoot, selection);
		if (selectionError) throw new Error(selectionError);
		const selected = resolve(workspaceRoot, selection.replaceAll("\\", sep));
		if (inside(selected, outputRoot) || inside(outputRoot, selected)) {
			throw new Error(`selection "${selection}" conflicts with output path`);
		}
		if (!selectedPaths.includes(selected)) selectedPaths.push(selected);
	}

	const runner = deps.runner ?? defaultRunner;
	const fs = (deps.fs as FileOperations | undefined) ?? defaultFileOperations;
	await fs.mkdir(dirname(outputRoot), true);
	// Non-recursive on purpose: this throws EEXIST when the aggregate directory is
	// already there, which is the stricter form of "refuse a non-empty directory".
	await fs.mkdir(outputRoot);

	const result: PrepareResult = {
		root: outputRoot,
		base: dirname(outputRoot),
		outsideWorkspace: !inside(workspaceRoot, outputRoot),
		branch: input.branch,
		entries: [],
		errors: [],
		ok: false,
	};
	const fail = (entry: Omit<PrepareEntry, "error">, message: string): void => {
		result.entries.push({ ...entry, error: message });
		result.errors.push(message);
	};
	const handledRoots = new Set<string>();
	const handledSelections: string[] = [];
	const destinationNames = new Set<string>();

	for (const selected of selectedPaths) {
		if (handledSelections.some((parent) => inside(parent, selected))) continue;
		const name = basename(selected);
		const blank = { source: selected, destination: "", name, kind: "skipped" as const, baseBranch: null };

		let probe: CommandResult;
		try {
			probe = await runner.run("git", ["-C", selected, "rev-parse", "--show-toplevel"], workspaceRoot);
		} catch (error) {
			probe = { code: 1, stdout: "", stderr: String(error) };
		}

		if (probe.code === 0) {
			const rootText = probe.stdout.trim();
			if (!rootText) {
				fail(blank, `${selected}: Git discovery returned no repository root`);
				handledSelections.push(selected);
				continue;
			}
			const repository = resolve(rootText);
			if (!inside(workspaceRoot, repository)) {
				fail(blank, `${selected}: git repository is outside the workspace`);
				handledSelections.push(selected);
				continue;
			}
			if (handledRoots.has(repository)) {
				handledSelections.push(selected);
				continue;
			}
			handledRoots.add(repository);
			handledSelections.push(selected);
			if (destinationNames.has(name)) {
				fail({ ...blank, source: repository }, `${selected}: duplicate destination name "${name}"`);
				continue;
			}
			destinationNames.add(name);
			const destination = resolve(outputRoot, name);
			try {
				const baseBranch = input.baseBranch || (await resolveDefaultBranch(runner, repository));
				const entry = { source: repository, destination, name, kind: "worktree" as const, baseBranch };
				const fetched = await runner.run("git", ["-C", repository, "fetch", "origin", baseBranch], repository);
				if (fetched.code !== 0) {
					fail({ ...entry, kind: "skipped" }, errorText(repository, `fetch origin/${baseBranch}`, fetched));
					continue;
				}
				const added = await runner.run(
					"git",
					["-C", repository, "worktree", "add", "-b", input.branch, destination, `origin/${baseBranch}`],
					repository,
				);
				if (added.code !== 0) {
					fail({ ...entry, kind: "skipped" }, errorText(repository, "create worktree", added));
					continue;
				}
				result.entries.push({ ...entry, error: null });
			} catch (error) {
				fail({ ...blank, source: repository, destination }, `${repository}: ${String(error)}`);
			}
			continue;
		}

		if (!isNotRepository(probe)) {
			fail(blank, errorText(selected, "inspect Git repository", probe));
			handledSelections.push(selected);
			continue;
		}

		if (destinationNames.has(name)) {
			fail(blank, `${selected}: duplicate destination name "${name}"`);
			handledSelections.push(selected);
			continue;
		}
		destinationNames.add(name);
		const destination = resolve(outputRoot, name);
		try {
			await fs.copyTree(selected, destination, DEFAULT_EXCLUDES);
			result.entries.push({ source: selected, destination, name, kind: "copy", baseBranch: null, error: null });
		} catch (error) {
			fail({ ...blank, destination }, `${selected}: copy failed (${String(error)})`);
		}
		handledSelections.push(selected);
	}

	result.ok = result.errors.length === 0 && result.entries.length > 0;
	return result;
}

export interface AddFoldersInput {
	/** Absolute workspace root against which selections are resolved. */
	workspaceRoot: string;
	/** Existing aggregate root. */
	outputRoot: string;
	/** Branch used by the original preparation run. */
	branch: string;
	/** Workspace-relative folders to add. */
	selections: string[];
	/** Names already present in the aggregate. */
	existingNames?: string[];
	/** Repository roots already represented by worktrees in the aggregate. */
	existingSources?: string[];
}

/** Add folders to an existing aggregate without recreating or reusing it. */
export async function addFolders(
	input: AddFoldersInput,
	deps: { runner?: CommandRunner; fs?: unknown } = {},
): Promise<{ entries: PrepareEntry[]; errors: string[] }> {
	if (!isAbsolute(input.workspaceRoot ?? "")) throw new Error("workspaceRoot must use an absolute path");
	if (!isAbsolute(input.outputRoot ?? "")) throw new Error("output root must use an absolute path");
	const branchError = validateBranchName(input.branch);
	if (branchError) throw new Error(branchError);
	if (!Array.isArray(input.selections) || input.selections.length === 0) throw new Error("select at least one folder");

	const workspaceRoot = resolve(input.workspaceRoot);
	const outputRoot = resolve(input.outputRoot);
	const runner = deps.runner ?? defaultRunner;
	const fs = (deps.fs as FileOperations | undefined) ?? defaultFileOperations;
	const names = new Set(input.existingNames ?? []);
	const sources = new Set((input.existingSources ?? []).map((source) => resolve(source)));
	const entries: PrepareEntry[] = [];
	const errors: string[] = [];
	const selected = [...new Set(input.selections)];

	for (const selection of selected) {
		const selectionError = validateSelection(workspaceRoot, selection);
		if (selectionError) {
			errors.push(selectionError);
			continue;
		}
		const source = resolve(workspaceRoot, selection.replaceAll("\\", sep));
		if (inside(outputRoot, source) || inside(source, outputRoot)) {
			errors.push(`selection "${selection}" conflicts with output path`);
			continue;
		}
		const name = basename(source);
		const blank = { source, destination: "", name, kind: "skipped" as const, baseBranch: null };
		if (names.has(name)) {
			const message = `${selection}: duplicate destination name "${name}"`;
			errors.push(message);
			entries.push({ ...blank, error: message });
			continue;
		}
		names.add(name);
		const destination = resolve(outputRoot, name);
		let probe: CommandResult;
		try {
			probe = await runner.run("git", ["-C", source, "rev-parse", "--show-toplevel"], workspaceRoot);
		} catch (error) {
			probe = { code: 1, stdout: "", stderr: String(error) };
		}

		if (probe.code === 0) {
			const rootText = probe.stdout.trim();
			if (!rootText) {
				const message = `${source}: Git discovery returned no repository root`;
				errors.push(message);
				entries.push({ ...blank, error: message });
				continue;
			}
			const repository = resolve(rootText);
			if (!inside(workspaceRoot, repository)) {
				const message = `${source}: git repository is outside the workspace`;
				errors.push(message);
				entries.push({ ...blank, error: message });
				continue;
			}
			if (sources.has(repository)) {
				const message = `${source}: this repository is already in the aggregate`;
				errors.push(message);
				entries.push({ ...blank, source: repository, destination, error: message });
				continue;
			}
			try {
				const baseBranch = await resolveDefaultBranch(runner, repository);
				const branchExists = await runner.run(
					"git",
					["-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
					repository,
				);
				if (branchExists.code !== 0) {
					const fetched = await runner.run("git", ["-C", repository, "fetch", "origin", baseBranch], repository);
					if (fetched.code !== 0) throw new Error(errorText(repository, `fetch origin/${baseBranch}`, fetched));
				}
				const args =
					branchExists.code === 0
						? ["-C", repository, "worktree", "add", destination, input.branch]
						: ["-C", repository, "worktree", "add", "-b", input.branch, destination, `origin/${baseBranch}`];
				const added = await runner.run("git", args, repository);
				if (added.code !== 0) throw new Error(errorText(repository, "add worktree", added));
				entries.push({ source: repository, destination, name, kind: "worktree", baseBranch, error: null });
				sources.add(repository);
			} catch (error) {
				const message = `${repository}: ${String(error)}`;
				errors.push(message);
				entries.push({ ...blank, source: repository, destination, error: message });
			}
			continue;
		}
		if (!isNotRepository(probe)) {
			const message = errorText(source, "inspect Git repository", probe);
			errors.push(message);
			entries.push({ ...blank, error: message });
			continue;
		}
		try {
			await fs.copyTree(source, destination, DEFAULT_EXCLUDES);
			entries.push({ source, destination, name, kind: "copy", baseBranch: null, error: null });
		} catch (error) {
			const message = `${source}: copy failed (${String(error)})`;
			errors.push(message);
			entries.push({ ...blank, destination, error: message });
		}
	}
	return { entries, errors };
}

import { cp, mkdir as makeDirectory } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "build", "coverage"] as const;

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
	workspaceRoot: string;
	outputName: string;
	branch: string;
	selections: string[];
}

export interface PrepareEntry {
	source: string;
	destination: string;
	kind: "worktree" | "copy";
}

export interface PrepareResult {
	root: string;
	branch: string;
	entries: PrepareEntry[];
	errors: string[];
}

const execFileAsync = promisify(execFile);

export const defaultRunner: CommandRunner = {
	async run(command, args, cwd) {
		try {
			const result = await execFileAsync(command, args, { cwd, maxBuffer: 1024 * 1024 });
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
			return {
				code: typeof failure.code === "number" ? failure.code : 1,
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? failure.message ?? String(error),
			};
		}
	},
};

export const defaultFileOperations: FileOperations = {
	async mkdir(path, recursive = false) {
		await makeDirectory(path, { recursive });
	},
	async copyTree(source, destination, excludes) {
		const excluded = new Set(excludes);
		await cp(source, destination, {
			recursive: true,
			filter: (entry) => !excluded.has(basename(entry)),
		});
	},
};

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
	const workspaceRoot = resolve(input.workspaceRoot);
	const branchError = validateBranchName(input.branch);
	if (branchError) throw new Error(branchError);
	if (!isAbsolute(input.workspaceRoot)) throw new Error("workspaceRoot must use an absolute path");
	const outputError = workspacePath(workspaceRoot, input.outputName, "output");
	if (outputError) throw new Error(outputError);
	if (!Array.isArray(input.selections)) throw new Error("selections must be an array");

	const outputRoot = resolve(workspaceRoot, input.outputName.replaceAll("\\", sep));
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
	await fs.mkdir(outputRoot);

	const result: PrepareResult = { root: outputRoot, branch: input.branch, entries: [], errors: [] };
	const handledRoots = new Set<string>();
	const handledSelections: string[] = [];
	const destinationNames = new Set<string>();

	for (const selected of selectedPaths) {
		if (handledSelections.some((parent) => inside(parent, selected))) continue;

		let probe: CommandResult;
		try {
			probe = await runner.run("git", ["-C", selected, "rev-parse", "--show-toplevel"], workspaceRoot);
		} catch (error) {
			probe = { code: 1, stdout: "", stderr: String(error) };
		}

		if (probe.code === 0) {
			const rootText = probe.stdout.trim();
			if (!rootText) {
				result.errors.push(`${selected}: Git discovery returned no repository root`);
				handledSelections.push(selected);
				continue;
			}
			const repository = resolve(rootText);
			if (!inside(workspaceRoot, repository)) {
				result.errors.push(`${selected}: git repository is outside the workspace`);
				handledSelections.push(selected);
				continue;
			}
			if (handledRoots.has(repository)) {
				handledSelections.push(selected);
				continue;
			}
			handledRoots.add(repository);
			handledSelections.push(selected);
			const name = basename(selected);
			if (destinationNames.has(name)) {
				result.errors.push(`${selected}: duplicate destination name "${name}"`);
				continue;
			}
			destinationNames.add(name);
			const destination = resolve(outputRoot, name);
			try {
				const fetched = await runner.run("git", ["-C", repository, "fetch", "origin", "master"], repository);
				if (fetched.code !== 0) {
					result.errors.push(errorText(repository, "fetch origin/master", fetched));
					continue;
				}
				const added = await runner.run(
					"git",
					["-C", repository, "worktree", "add", "-b", input.branch, destination, "origin/master"],
					repository,
				);
				if (added.code !== 0) {
					result.errors.push(errorText(repository, "create worktree", added));
					continue;
				}
				result.entries.push({ source: repository, destination, kind: "worktree" });
			} catch (error) {
				result.errors.push(`${repository}: ${String(error)}`);
			}
			continue;
		}

		if (!isNotRepository(probe)) {
			result.errors.push(errorText(selected, "inspect Git repository", probe));
			handledSelections.push(selected);
			continue;
		}

		const name = basename(selected);
		if (destinationNames.has(name)) {
			result.errors.push(`${selected}: duplicate destination name "${name}"`);
			handledSelections.push(selected);
			continue;
		}
		destinationNames.add(name);
		const destination = resolve(outputRoot, name);
		try {
			await fs.copyTree(selected, destination, DEFAULT_EXCLUDES);
			result.entries.push({ source: selected, destination, kind: "copy" });
		} catch (error) {
			result.errors.push(`${selected}: copy failed (${String(error)})`);
		}
		handledSelections.push(selected);
	}

	return result;
}

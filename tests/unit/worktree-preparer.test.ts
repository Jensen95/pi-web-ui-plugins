import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockHost, createMockViewContext } from "../helpers/mock-host";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: execFileMock };
});
afterEach(() => execFileMock.mockReset());
import type { MockHost } from "../helpers/mock-host";
import worktreeClient, {
	describeEntry,
	describeFolder,
	openableAggregate,
	parseFolders,
	parseResult,
	resolveOutputPath,
	stateFrom,
	summarizeResult,
} from "../../plugins/worktree-preparer/src/client";
import worktreeServer from "../../plugins/worktree-preparer/src/index";
import {
	DEFAULT_EXCLUDES,
	defaultFileOperations,
	defaultRunner,
	addFolders,
	defaultOutputBase,
	prepareProject,
	resolveDefaultBranch,
	validateBranchName,
	outputRootFor,
	validateOutput,
	validateSelection,
} from "../../plugins/worktree-preparer/src/ops";
import { homedir } from "node:os";

interface CommandCall {
	command: string;
	args: string[];
	cwd: string;
}

interface FakeFileOps {
	mkdir: ReturnType<typeof vi.fn>;
	copyTree: ReturnType<typeof vi.fn>;
}

function fileOps(overrides: Partial<FakeFileOps> = {}): FakeFileOps {
	return {
		mkdir: vi.fn(async () => undefined),
		copyTree: vi.fn(async () => undefined),
		...overrides,
	};
}

function gitRunner(
	options: {
		repos?: Record<string, string>;
		heads?: Record<string, string>;
		fail?: (call: CommandCall) => string | undefined;
	} = {},
): {
	run: (command: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
	calls: CommandCall[];
} {
	const calls: CommandCall[] = [];
	const repos = options.repos ?? { "/workspace/repo-a": "/workspace/repo-a" };
	const heads = options.heads ?? {};
	return {
		calls,
		async run(command, args, cwd) {
			const call = { command, args, cwd };
			calls.push(call);
			const failure = options.fail?.(call);
			if (failure) return { code: 1, stdout: "", stderr: failure };
			if (args[2] === "symbolic-ref") {
				const head = heads[args[1]!];
				return head
					? { code: 0, stdout: `refs/remotes/origin/${head}\n`, stderr: "" }
					: { code: 1, stdout: "", stderr: "" };
			}
			if (args[2] === "ls-remote") return { code: 1, stdout: "", stderr: "no remote" };
			if (args[2] === "rev-parse") {
				const root = repos[args[1]!];
				return root
					? { code: 0, stdout: `${root}\n`, stderr: "" }
					: { code: 128, stdout: "", stderr: "not a git repository" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};
}

function statePayloads(host: MockHost): Record<string, unknown>[] {
	return host.recorded.broadcasts.filter((payload): payload is Record<string, unknown> => {
		return Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).kind === "state");
	});
}

function descendants(root: FakeElement): FakeElement[] {
	return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("worktree preparation operations", () => {
	it("bounds Git command timeouts and reports an actionable error", async () => {
		execFileMock.mockImplementation((_command, _args, _options, callback) => {
			callback(Object.assign(new Error("Command was killed"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }));
		});

		const fetch = await defaultRunner.run("git", ["-C", "/repo", "fetch", "origin", "main"], "/repo");
		const inspect = await defaultRunner.run("git", ["-C", "/repo", "rev-parse", "--show-toplevel"], "/repo");
		const remote = await defaultRunner.run("git", ["-C", "/repo", "ls-remote", "--symref", "origin", "HEAD"], "/repo");

		expect(execFileMock.mock.calls.map((call) => call[2].timeout)).toEqual([120_000, 30_000, 120_000]);
		expect(fetch.stderr).toMatch(/timed out after 120 seconds/i);
		expect(fetch.stderr).toMatch(/check.*repository.*remote.*retry/i);
		expect(inspect.stderr).toMatch(/timed out after 30 seconds/i);
		expect(remote.stderr).toMatch(/timed out after 120 seconds/i);

		execFileMock.mockImplementation((_command, _args, _options, callback) => {
			callback(
				Object.assign(new Error("stdout maxBuffer length exceeded"), {
					code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					killed: true,
				}),
			);
		});
		expect((await defaultRunner.run("git", ["-C", "/repo", "status"], "/repo")).stderr).toMatch(/maxBuffer/);
	});

	it("copies the selected root while excluding generated directories by name", async () => {
		const temporary = await mkdtemp(join(tmpdir(), "worktree-preparer-"));
		const source = join(temporary, ".next");
		const destination = join(temporary, "copy");
		try {
			await mkdir(join(source, "src", ".next"), { recursive: true });
			await mkdir(join(source, "src", ".venv"), { recursive: true });
			await mkdir(join(source, "src", "target"), { recursive: true });
			await writeFile(join(source, "src", "index.ts"), "source");
			await writeFile(join(source, "src", ".next", "cache"), "generated");
			await writeFile(join(source, "src", ".venv", "cache"), "generated");
			await writeFile(join(source, "src", "target", "cache"), "generated");

			await defaultFileOperations.copyTree(source, destination, DEFAULT_EXCLUDES);

			expect(await readFile(join(destination, "src", "index.ts"), "utf8")).toBe("source");
			const copiedSourceEntries = await readdir(join(destination, "src"));
			for (const excluded of [".next", ".venv", "target"]) expect(copiedSourceEntries).not.toContain(excluded);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	it("creates one branch worktree per repository off its own remote default while copying non-Git folders", async () => {
		const runner = gitRunner({
			repos: { "/workspace/repo-a": "/workspace/repo-a", "/workspace/repo-b": "/workspace/repo-b" },
			heads: { "/workspace/repo-a": "main" },
		});
		const fs = fileOps();
		const result = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputBase: "/aggregates",
				outputName: "demo",
				branch: "agent/demo",
				selections: ["repo-a", "repo-b", "docs"],
			},
			{ runner, fs },
		);

		expect(fs.mkdir).toHaveBeenCalledWith("/aggregates/demo");
		const fetches = runner.calls.filter(({ args }) => args[2] === "fetch").map(({ args }) => args.join(" "));
		expect(fetches).toEqual(["-C /workspace/repo-a fetch origin main", "-C /workspace/repo-b fetch origin master"]);
		expect(runner.calls.filter(({ args }) => args[2] === "worktree").map(({ args }) => args.at(-1))).toEqual([
			"origin/main",
			"origin/master",
		]);
		expect(fs.copyTree).toHaveBeenCalledWith("/workspace/docs", "/aggregates/demo/docs", DEFAULT_EXCLUDES);
		expect(result).toMatchObject({
			root: "/aggregates/demo",
			base: "/aggregates",
			branch: "agent/demo",
			outsideWorkspace: true,
			ok: true,
		});
		expect(result.entries).toEqual([
			{
				source: "/workspace/repo-a",
				destination: "/aggregates/demo/repo-a",
				name: "repo-a",
				kind: "worktree",
				baseBranch: "main",
				error: null,
			},
			{
				source: "/workspace/repo-b",
				destination: "/aggregates/demo/repo-b",
				name: "repo-b",
				kind: "worktree",
				baseBranch: "master",
				error: null,
			},
			{
				source: "/workspace/docs",
				destination: "/aggregates/demo/docs",
				name: "docs",
				kind: "copy",
				baseBranch: null,
				error: null,
			},
		]);
		expect(result.errors).toEqual([]);
	});

	it("adds a new repository worktree to an existing aggregate without reusing the branch setup", async () => {
		const runner = gitRunner({ repos: { "/workspace/repo-b": "/workspace/repo-b" } });
		const fs = fileOps();
		const result = await addFolders(
			{
				workspaceRoot: "/workspace",
				outputRoot: "/aggregates/demo",
				branch: "agent/demo",
				selections: ["repo-b"],
				existingNames: ["repo-a"],
				existingSources: ["/workspace/repo-a"],
			},
			{ runner, fs },
		);
		expect(result.errors).toEqual([]);
		expect(result.entries[0]).toMatchObject({
			source: "/workspace/repo-b",
			name: "repo-b",
			kind: "worktree",
			destination: "/aggregates/demo/repo-b",
		});
		expect(runner.calls.some(({ args }) => args[2] === "worktree")).toBe(true);
		expect(fs.copyTree).not.toHaveBeenCalled();
	});

	it("rejects adding a repository already represented in the aggregate", async () => {
		const result = await addFolders(
			{
				workspaceRoot: "/workspace",
				outputRoot: "/aggregates/demo",
				branch: "agent/demo",
				selections: ["repo-a/subfolder"],
				existingNames: [],
				existingSources: ["/workspace/repo-a"],
			},
			{
				runner: gitRunner({ repos: { "/workspace/repo-a/subfolder": "/workspace/repo-a" } }),
				fs: fileOps(),
			},
		);
		expect(result.errors[0]).toMatch(/already in the aggregate/i);
	});

	it("falls back through ls-remote to master, and lets the caller override the base branch", async () => {
		const calls: CommandCall[] = [];
		const runner = {
			calls,
			async run(command: string, args: string[], cwd: string) {
				calls.push({ command, args, cwd });
				if (args[2] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
				if (args[2] === "ls-remote")
					return { code: 0, stdout: "ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n", stderr: "" };
				if (args[2] === "rev-parse") return { code: 0, stdout: "/workspace/repo-a\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		expect(await resolveDefaultBranch(runner, "/workspace/repo-a")).toBe("trunk");

		const overridden = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputBase: "/aggregates",
				outputName: "demo",
				branch: "agent/demo",
				baseBranch: "release/1.x",
				selections: ["repo-a"],
			},
			{ runner, fs: fileOps() },
		);
		expect(overridden.entries[0]?.baseBranch).toBe("release/1.x");
		expect(calls.some(({ args }) => args[2] === "symbolic-ref" && args[1] === "/workspace/repo-a" && args[3])).toBe(
			true,
		);
		expect(
			calls
				.filter(({ args }) => args[2] === "fetch")
				.at(-1)
				?.args.at(-1),
		).toBe("release/1.x");
	});

	it("keeps the relaxed output path safe against hostile values", () => {
		expect(validateOutput("/base", "demo")).toBeNull();
		expect(validateOutput("/base", "/aggregates/demo"), "absolute aggregates are the point").toBeNull();
		expect(defaultOutputBase().startsWith("/") || /^[A-Za-z]:/.test(defaultOutputBase())).toBe(true);
		expect(validateOutput("/base", "")).toMatch(/empty/i);
		expect(validateOutput("/base", "   ")).toMatch(/empty/i);
		expect(validateOutput("/base", "../../etc")).toMatch(/\.\./);
		expect(validateOutput("/base", "a/../../../etc/cron.d")).toMatch(/\.\./);
		expect(validateOutput("/base", "demo\0/x")).toMatch(/null byte/i);
		expect(validateOutput("/base", "/")).toMatch(/top-level/i);
		expect(validateOutput("/base", "/tmp")).toMatch(/top-level/i);
		expect(validateOutput("relative-base", "demo")).toMatch(/absolute/i);
	});

	it("resolves a leading tilde to the home directory, as the view promises", () => {
		expect(outputRootFor("/base", "~/aggregates/demo")).toBe(`${homedir()}/aggregates/demo`);
		expect(outputRootFor("/base", "~/aggregates/demo")).not.toContain("~");
		expect(validateOutput("/base", "~/aggregates/demo")).toBeNull();
		expect(validateOutput("/base", "~/../../etc"), "tilde expansion must not launder a traversal").toMatch(/\.\./);
		expect(validateOutput("/base", "~/../../etc/cron.d")).toMatch(/\.\./);
		expect(() => outputRootFor("/base", "~/../../etc/cron.d")).toThrow(/\.\./);
		expect(outputRootFor("/base", "demo~x"), "a tilde inside a name is just a character").toBe("/base/demo~x");
	});

	it("refuses an empty selection instead of creating a stray aggregate directory", async () => {
		const mkdir = vi.fn(async () => {});
		await expect(
			prepareProject(
				{
					workspaceRoot: "/workspace",
					outputBase: "/aggregates",
					outputName: "demo",
					branch: "agent/demo",
					selections: [],
				},
				{ fs: { mkdir, copyTree: vi.fn(async () => {}) } },
			),
		).rejects.toThrow(/at least one folder/i);
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("refuses an aggregate that would sit inside or around a selected source folder", async () => {
		for (const outputName of ["/workspace/repo-a/nested", "/workspace", "/workspace/repo-a"]) {
			await expect(
				prepareProject(
					{
						workspaceRoot: "/workspace",
						outputBase: "/aggregates",
						outputName,
						branch: "agent/demo",
						selections: ["repo-a"],
					},
					{ runner: gitRunner(), fs: fileOps() },
				),
				`${outputName} must be refused`,
			).rejects.toThrow(/conflicts with output path|top-level directory/i);
		}
	});

	it("leaves dirty source repositories alone and reports a repository failure without hiding successful entries", async () => {
		const runner = gitRunner({
			repos: { "/workspace/dirty": "/workspace/dirty", "/workspace/other": "/workspace/other" },
			fail: ({ cwd, args }) => (cwd === "/workspace/dirty" && args[2] === "fetch" ? "network unavailable" : undefined),
		});
		const fs = fileOps();
		const result = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputBase: "/aggregates",
				outputName: "run-1",
				branch: "agent/run-1",
				selections: ["dirty", "other"],
			},
			{ runner, fs },
		);

		expect(runner.calls.some(({ args }) => args.includes("reset") || args.includes("checkout"))).toBe(false);
		expect(result.errors).toEqual([expect.stringMatching(/dirty|network unavailable/i)]);
		expect(result.ok).toBe(false);
		expect(result.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "/workspace/other", kind: "worktree", error: null }),
				expect.objectContaining({
					source: "/workspace/dirty",
					kind: "skipped",
					error: expect.stringMatching(/network unavailable/i),
				}),
			]),
		);
	});

	it("rejects traversal, invalid branch names, and an output collision before touching Git", async () => {
		expect(validateBranchName("agent/demo")).toBeNull();
		expect(validateBranchName("../escape")).toMatch(/branch/i);
		expect(validateSelection("/workspace", "../outside")).toMatch(/workspace|outside/i);
		expect(validateSelection("/workspace", "/etc")).toMatch(/workspace/i);
		const runner = gitRunner();
		const fs = fileOps({
			mkdir: vi.fn(async () => {
				throw new Error("EEXIST");
			}),
		});

		await expect(
			prepareProject(
				{
					workspaceRoot: "/workspace",
					outputBase: "/aggregates",
					outputName: "demo",
					branch: "agent/demo",
					selections: ["repo-a"],
				},
				{ runner, fs },
			),
		).rejects.toThrow(/EEXIST|already exists/i);
		expect(runner.calls).toEqual([]);
	});

	it("does not copy a folder when Git discovery fails for a reason other than not being a repository", async () => {
		const runner = gitRunner({
			fail: ({ args }) => (args[2] === "rev-parse" ? "permission denied" : undefined),
		});
		const fs = fileOps();
		const result = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputBase: "/aggregates",
				outputName: "demo",
				branch: "agent/demo",
				selections: ["private"],
			},
			{ runner, fs },
		);
		expect(result.errors).toEqual([expect.stringMatching(/permission denied|git/i)]);
		expect(result.entries).toEqual([
			expect.objectContaining({ kind: "skipped", error: expect.stringMatching(/permission denied/i) }),
		]);
		expect(fs.copyTree).not.toHaveBeenCalled();
	});

	it("rejects duplicate destination names instead of overwriting one repository", async () => {
		const runner = gitRunner({
			repos: { "/workspace/one/repo": "/workspace/one/repo", "/workspace/two/repo": "/workspace/two/repo" },
		});
		const fs = fileOps();
		const result = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputBase: "/aggregates",
				outputName: "demo",
				branch: "agent/demo",
				selections: ["one/repo", "two/repo"],
			},
			{ runner, fs },
		);
		expect(result.errors).toEqual([expect.stringMatching(/destination|duplicate|repo/i)]);
		expect(runner.calls.filter(({ args }) => args[2] === "worktree")).toHaveLength(1);
	});

	it("deduplicates two selected paths from the same repository and refuses unsafe output selections", async () => {
		const runner = gitRunner({ repos: { "/workspace/src": "/workspace/repo" } });
		const fs = fileOps();
		const result = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputBase: "/aggregates",
				outputName: "demo",
				branch: "agent/demo",
				selections: ["src", "src/lib"],
			},
			{ runner, fs },
		);
		expect(result.entries.filter((entry: { kind: string }) => entry.kind === "worktree")).toHaveLength(1);
		await expect(
			prepareProject(
				{
					workspaceRoot: "/workspace",
					outputBase: "/workspace",
					outputName: "projects/demo",
					branch: "agent/demo",
					selections: ["projects/demo"],
				},
				{ runner: gitRunner(), fs: fileOps() },
			),
		).rejects.toThrow(/output|selection/i);
	});
});

describe("worktree preparation server and client", () => {
	it("answers attach immediately, then fills in each folder's Git status in the background", async () => {
		const host = createMockHost({
			permissions: ["fs", "terminal"],
			files: { "repo-a/README.md": "a", "docs/guide.md": "guide" },
		});
		const runner = {
			async run(_command: string, args: string[]) {
				const target = args[1] ?? "";
				if (!target.endsWith("repo-a")) return { code: 128, stdout: "", stderr: "not a git repository" };
				if (args[2] === "symbolic-ref") return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
				return { code: 0, stdout: `${target}\n`, stderr: "" };
			},
		};
		const deactivate = worktreeServer.activate(host, { runner });
		await host.emit.message({ action: "get_state" }, "client-1");

		// The first answer must not wait for git; it says so with probing: true.
		expect(statePayloads(host).at(-1)).toMatchObject({
			probing: true,
			defaultBase: defaultOutputBase(),
			folders: [
				{ name: "docs", status: "unknown", defaultBranch: null },
				{ name: "repo-a", status: "unknown", defaultBranch: null },
			],
		});
		await vi.waitFor(() => expect(statePayloads(host).at(-1)).toMatchObject({ probing: false }));
		expect(statePayloads(host).at(-1)).toMatchObject({
			folders: [
				{ name: "docs", status: "plain", defaultBranch: null },
				{ name: "repo-a", status: "git", defaultBranch: "main" },
			],
		});
		deactivate?.();
	});

	it("mounts explicit fields and controls without starting a session automatically", () => {
		const { ctx, sent, push } = createMockViewContext("worktree-preparer");
		const document = createFakeDocument();
		const container = document.createElement("div");
		const cleanup = worktreeClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { cwd: "/workspace", folders: ["repo-a"], result: null, error: null } });
		expect(container.children.length, "a non-browser container must stay a no-op, a real one must render").toBe(1);
		expect(sent).toContainEqual({ action: "get_state" });
		expect(descendants(container).some((element) => element.dataset.action === "prepare")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.field === "branch")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.action === "open-session")).toBe(false);
		cleanup?.();
	});
});

/** A prepared aggregate: the root plus a worktree and a copied folder inside it. */
const RESULT = {
	root: "/workspace/.pi/projects/new-project",
	branch: "agent/x",
	entries: [
		{ source: "/workspace/repo-a", destination: "/workspace/.pi/projects/new-project/repo-a", kind: "worktree" },
		{ source: "/workspace/docs", destination: "/workspace/.pi/projects/new-project/docs", kind: "copy" },
	],
	errors: [] as string[],
};

function mountWithHost(host?: unknown): {
	container: FakeElement;
	push: (payload: unknown) => number;
	cleanup: (() => void) | undefined;
} {
	const { ctx, push } = createMockViewContext("worktree-preparer");
	const document = createFakeDocument();
	if (host !== undefined) document.defaultView.__piWebUiHost = host;
	const container = document.createElement("div");
	const cleanup = worktreeClient.mount?.(container as unknown as HTMLElement, ctx);
	return { container, push, cleanup };
}

function openButton(container: FakeElement): FakeElement | undefined {
	return descendants(container).find((element) => element.dataset.action === "open-session");
}

function viewText(container: FakeElement): string {
	return descendants(container)
		.map((element) => element.textContent)
		.join(" | ");
}

describe("opening a session on the prepared aggregate", () => {
	it("offers it once an aggregate exists, and opens the root alone", async () => {
		const openSession = vi.fn(async (_options: { folders?: string[]; newChat?: boolean }) => ({
			ok: true,
			sessionId: "s1",
		}));
		const { container, push, cleanup } = mountWithHost({ version: 6, openSession });
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: RESULT, error: null } });

		expect(openSession, "nothing may happen before the user asks").not.toHaveBeenCalled();
		expect(openButton(container), "no open-session control was rendered").toBeDefined();
		openButton(container)?.click();

		expect(openSession).toHaveBeenCalledTimes(1);
		// Only the root. The entries live INSIDE it, and the host dedupes workspace
		// roots by exact string, so passing them would render the same subtree twice
		// while granting no access the cwd does not already imply.
		expect(openSession.mock.calls[0]?.[0]?.folders).toEqual([RESULT.root]);
		cleanup?.();
	});

	it("refuses to open a half-built aggregate", () => {
		const openSession = vi.fn(async () => ({ ok: true }));
		const { container, push, cleanup } = mountWithHost({ version: 6, openSession });
		// A partial run still carries a usable root, so the button would look safe.
		push({
			kind: "state",
			state: {
				cwd: "/workspace",
				folders: [],
				result: { ...RESULT, errors: ["repo-b: fetch failed"] },
				error: "repo-b: fetch failed",
			},
		});

		expect(openButton(container)).toBeUndefined();
		expect(openSession).not.toHaveBeenCalled();
		cleanup?.();
	});

	it("explains itself on a host without openSession", () => {
		const { container, push, cleanup } = mountWithHost({ version: 3 });
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: RESULT, error: null } });

		openButton(container)?.click();
		expect(viewText(container)).toMatch(/0\.86/);
		cleanup?.();
	});

	it("survives a host that is not there at all", () => {
		const { container, push, cleanup } = mountWithHost();
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: RESULT, error: null } });
		expect(() => openButton(container)?.click()).not.toThrow();
		cleanup?.();
	});

	it("reports a declined directory grant instead of pretending it opened", async () => {
		// The host prompts for the folder even though it sits inside the workspace:
		// its grant check is exact-string membership, not a subtree test.
		const openSession = vi.fn(async () => ({ ok: false, error: "Directory access was declined" }));
		const { container, push, cleanup } = mountWithHost({ version: 6, openSession });
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: RESULT, error: null } });

		openButton(container)?.click();
		await vi.waitFor(() => expect(viewText(container)).toContain("declined"));
		cleanup?.();
	});

	it("reports a thrown call rather than going quiet", async () => {
		const openSession = vi.fn(async () => Promise.reject(new Error("socket hang up")));
		const { container, push, cleanup } = mountWithHost({ version: 6, openSession });
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: RESULT, error: null } });

		openButton(container)?.click();
		await vi.waitFor(() => expect(viewText(container)).toContain("socket hang up"));
		cleanup?.();
	});
});

describe("worktree preparer view helpers", () => {
	it("reads both the old bare-name folder list and the new per-folder Git records", () => {
		// A bare name carries no probe result, so it must not claim to be a plain folder.
		expect(parseFolders(["docs", "", 7])).toEqual([{ name: "docs", status: "unknown", defaultBranch: null }]);
		expect(
			parseFolders([
				{ name: "repo-a", path: "/w/repo-a", status: "git", defaultBranch: "main" },
				{ name: "docs", path: "/w/docs", status: "plain", defaultBranch: null },
				{ status: "git" },
				null,
			]),
		).toEqual([
			{ name: "repo-a", status: "git", defaultBranch: "main" },
			{ name: "docs", status: "plain", defaultBranch: null },
		]);
		expect(describeFolder({ name: "repo-a", status: "git", defaultBranch: "main" })).toMatch(/main/);
		expect(describeFolder({ name: "repo-a", status: "git", defaultBranch: null })).toMatch(/default branch/i);
		expect(describeFolder({ name: "docs", status: "plain", defaultBranch: null })).toMatch(/copied/i);
		expect(describeFolder({ name: "docs", status: "unknown", defaultBranch: null })).toMatch(/Checking/i);
	});

	it("keeps a malformed result from throwing and carries per-entry base branches and errors", () => {
		expect(parseResult(null)).toBeNull();
		expect(parseResult({ root: "   " })).toBeNull();
		expect(parseResult({ root: "/agg" })).toEqual({
			root: "/agg",
			branch: "",
			outsideWorkspace: false,
			entries: [],
			errors: [],
			ok: null,
		});
		const parsed = parseResult({
			root: "/agg",
			branch: "agent/x",
			entries: [
				{ source: "/w/a", destination: "/agg/a", kind: "worktree", baseBranch: "develop" },
				{ source: "/w/b", destination: "/agg/b", kind: "copy", error: "copy failed" },
				{ nonsense: true },
			],
			errors: ["detached", 9],
		});
		expect(parsed?.entries).toHaveLength(2);
		expect(parsed?.entries[0]).toMatchObject({ kind: "worktree", baseBranch: "develop", error: null });
		expect(parsed?.entries[1]).toMatchObject({ kind: "copy", error: "copy failed" });
		expect(parsed?.errors).toEqual(["detached"]);
		expect(describeEntry(parsed!.entries[0]!)).toMatch(/develop/);
		expect(describeEntry(parsed!.entries[1]!)).toBe("Copied");
		expect(describeEntry({ ...parsed!.entries[1]!, kind: "skipped" })).toBe("Skipped");
		expect(summarizeResult(parsed!)).toMatch(/1 of 2/);
	});

	it("refuses to call an aggregate openable when a single entry failed", () => {
		expect(openableAggregate(RESULT)?.root).toBe(RESULT.root);
		expect(openableAggregate({ ...RESULT, errors: ["boom"] })).toBeNull();
		expect(
			openableAggregate({
				...RESULT,
				entries: [{ source: "/w/a", destination: "/agg/a", kind: "copy", error: "permission denied" }],
			}),
			"an entry-level failure still leaves a usable root, and must not be openable",
		).toBeNull();
		expect(openableAggregate({ ...RESULT, ok: false }), "the server's own verdict wins").toBeNull();
		expect(
			openableAggregate({
				...RESULT,
				entries: [{ source: "/w/a", destination: "", kind: "skipped", error: null }],
			}),
		).toBeNull();
	});

	it("resolves the output path the user is about to create", () => {
		expect(resolveOutputPath("/workspace/", ".pi/projects/demo")).toBe("/workspace/.pi/projects/demo");
		expect(resolveOutputPath("/workspace", "  ")).toBe("");
		expect(resolveOutputPath("/workspace", "/tmp/agg")).toBe("/tmp/agg");
		expect(resolveOutputPath("", "agg")).toBe("agg");
	});

	it("tolerates a state payload whose fields are the wrong type", () => {
		expect(stateFrom({ kind: "other" })).toBeNull();
		expect(stateFrom({ kind: "state", cwd: 4, folders: "nope", result: "nope", error: "" })).toEqual({
			cwd: "",
			defaultBase: "",
			folders: [],
			probing: false,
			busy: false,
			result: null,
			error: null,
		});
		// No defaultBase yet (older server): the cwd is the honest stand-in.
		expect(stateFrom({ kind: "state", cwd: "/w" })?.defaultBase).toBe("/w");
	});
});

describe("worktree preparer view behaviour", () => {
	function find(container: FakeElement, key: "action" | "field", value: string): FakeElement | undefined {
		return descendants(container).find((element) => element.dataset[key] === value);
	}

	it("explains itself, lists folders with their kind, and only sends what is selected", () => {
		const { ctx, sent, push } = createMockViewContext("worktree-preparer");
		const document = createFakeDocument();
		const container = document.createElement("div");
		const cleanup = worktreeClient.mount?.(container as unknown as HTMLElement, ctx);
		push({
			kind: "state",
			state: {
				cwd: "/workspace",
				defaultBase: "/home/me/pi-workspaces",
				folders: [
					{ name: "repo-a", path: "/workspace/repo-a", status: "git", defaultBranch: "main" },
					{ name: "docs", path: "/workspace/docs", status: "plain", defaultBranch: null },
				],
				probing: false,
				busy: false,
				result: null,
				error: null,
			},
		});

		expect(viewText(container), "a first-time reader must see the steps").toMatch(/Pick the folders/);
		expect(viewText(container)).toMatch(/new branch from main/);
		expect(viewText(container), "the output path must be resolved against the server's base").toMatch(
			/\/home\/me\/pi-workspaces\/new-workspace/,
		);
		// Nothing selected: Prepare is dead, and a dead button sends nothing.
		find(container, "action", "prepare")?.click();
		expect(sent.filter((payload: any) => payload?.action === "prepare")).toHaveLength(0);

		const boxes = descendants(container).filter((element) => element.dataset.field === "selection");
		expect(boxes.map((box) => box.value)).toEqual(["repo-a", "docs"]);
		boxes[0]!.checked = true;
		boxes[0]!.click();
		const branch = find(container, "field", "branch")!;
		branch.value = "agent/demo";
		find(container, "action", "prepare")?.click();
		expect(sent.at(-1)).toEqual({
			action: "prepare",
			branch: "agent/demo",
			outputName: "new-workspace",
			selections: ["repo-a"],
		});
		expect(find(container, "action", "prepare")?.disabled, "a run in flight must not be startable twice").toBe(true);
		cleanup?.();
	});

	it("selects and clears every folder at once", () => {
		const { ctx, sent, push } = createMockViewContext("worktree-preparer");
		const document = createFakeDocument();
		const container = document.createElement("div");
		const cleanup = worktreeClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { cwd: "/w", folders: ["a", "b"], result: null, error: null } });

		find(container, "action", "select-all")?.click();
		find(container, "action", "prepare")?.click();
		expect((sent.at(-1) as any).selections).toEqual(["a", "b"]);
		push({ kind: "state", state: { cwd: "/w", folders: ["a", "b"], result: null, error: null } });
		find(container, "action", "select-none")?.click();
		expect(find(container, "action", "prepare")?.disabled).toBe(true);
		cleanup?.();
	});

	it("shows a failed entry against that entry and offers no session", () => {
		const { push, container, cleanup } = mountWithHost({ version: 6, openSession: vi.fn() });
		push({
			kind: "state",
			state: {
				cwd: "/workspace",
				folders: [],
				result: {
					...RESULT,
					entries: [
						{ ...RESULT.entries[0], baseBranch: "main" },
						{ ...RESULT.entries[1], error: "docs: permission denied" },
					],
				},
				error: null,
			},
		});
		const failed = descendants(container).find((element) => element.dataset.entry === "/workspace/docs");
		expect(failed && viewText(failed)).toContain("docs: permission denied");
		expect(openButton(container), "a half-built aggregate must not be openable").toBeUndefined();
		expect(viewText(container)).toMatch(/1 of 2/);
		cleanup?.();
	});

	it("says what opening the session will do", () => {
		const { push, container, cleanup } = mountWithHost({ version: 6, openSession: vi.fn() });
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: RESULT, error: null } });
		expect(viewText(container)).toMatch(/working directory/i);
		expect(viewText(container)).toMatch(/workspace roots/i);
		cleanup?.();
	});

	it("tells the user when the workspace has no subfolders", () => {
		const { push, container, cleanup } = mountWithHost();
		push({ kind: "state", state: { cwd: "/workspace", folders: [], result: null, error: null } });
		expect(viewText(container)).toMatch(/No subfolders/i);
		cleanup?.();
	});
});

interface FakeElement {
	tagName: string;
	textContent: string;
	value: string;
	type: string;
	checked: boolean;
	disabled: boolean;
	dataset: Record<string, string>;
	children: FakeElement[];
	ownerDocument: FakeDocument;
	addEventListener(type: string, listener: (event?: any) => void): void;
	append(...children: FakeElement[]): void;
	replaceChildren(...children: FakeElement[]): void;
	click(): void;
	dispatch(type: string, event?: any): void;
	setAttribute(name: string, value: string): void;
}

interface FakeDocument {
	defaultView: Record<string, unknown>;
	createElement(tagName: string): FakeElement;
}

function createFakeDocument(): FakeDocument {
	const document = {} as FakeDocument;
	const make = (tagName: string): FakeElement => {
		const listeners = new Map<string, Set<(event?: any) => void>>();
		const element: FakeElement = {
			tagName,
			textContent: "",
			value: "",
			type: "",
			checked: false,
			disabled: false,
			dataset: {},
			children: [],
			ownerDocument: document,
			addEventListener(type, listener) {
				let handlers = listeners.get(type);
				if (!handlers) listeners.set(type, (handlers = new Set()));
				handlers.add(listener);
			},
			append(...children) {
				element.children.push(...children);
			},
			replaceChildren(...children) {
				element.children = children;
			},
			click() {
				if (!element.disabled) for (const listener of listeners.get("click") ?? []) listener();
			},
			dispatch(type, event) {
				for (const listener of listeners.get(type) ?? []) listener(event);
			},
			setAttribute(name, value) {
				if (name.startsWith("data-")) element.dataset[name.slice(5)] = value;
			},
		};
		return element;
	};
	document.defaultView = {};
	document.createElement = (tagName) => make(tagName);
	return document;
}

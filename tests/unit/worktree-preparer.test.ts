import { describe, expect, it, vi } from "vitest";
import { createMockHost, createMockViewContext } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import worktreeClient from "../../plugins/worktree-preparer/src/client";
import worktreeServer from "../../plugins/worktree-preparer/src/index";
import {
	DEFAULT_EXCLUDES,
	prepareProject,
	validateBranchName,
	validateSelection,
} from "../../plugins/worktree-preparer/src/ops";

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
		fail?: (call: CommandCall) => string | undefined;
	} = {},
): {
	run: (command: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
	calls: CommandCall[];
} {
	const calls: CommandCall[] = [];
	const repos = options.repos ?? { "/workspace/repo-a": "/workspace/repo-a" };
	return {
		calls,
		async run(command, args, cwd) {
			const call = { command, args, cwd };
			calls.push(call);
			const failure = options.fail?.(call);
			if (failure) return { code: 1, stdout: "", stderr: failure };
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
	it("fetches origin/master and creates one branch worktree per repository while copying non-Git folders", async () => {
		const runner = gitRunner({
			repos: { "/workspace/repo-a": "/workspace/repo-a", "/workspace/repo-b": "/workspace/repo-b" },
		});
		const fs = fileOps();
		const result = await prepareProject(
			{
				workspaceRoot: "/workspace",
				outputName: ".pi/projects/demo",
				branch: "agent/demo",
				selections: ["repo-a", "repo-b", "docs"],
			},
			{ runner, fs },
		);

		expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.pi/projects/demo");
		expect(runner.calls).toEqual([
			{ command: "git", args: ["-C", "/workspace/repo-a", "rev-parse", "--show-toplevel"], cwd: "/workspace" },
			{ command: "git", args: ["-C", "/workspace/repo-a", "fetch", "origin", "master"], cwd: "/workspace/repo-a" },
			{
				command: "git",
				args: [
					"-C",
					"/workspace/repo-a",
					"worktree",
					"add",
					"-b",
					"agent/demo",
					"/workspace/.pi/projects/demo/repo-a",
					"origin/master",
				],
				cwd: "/workspace/repo-a",
			},
			{ command: "git", args: ["-C", "/workspace/repo-b", "rev-parse", "--show-toplevel"], cwd: "/workspace" },
			{ command: "git", args: ["-C", "/workspace/repo-b", "fetch", "origin", "master"], cwd: "/workspace/repo-b" },
			{
				command: "git",
				args: [
					"-C",
					"/workspace/repo-b",
					"worktree",
					"add",
					"-b",
					"agent/demo",
					"/workspace/.pi/projects/demo/repo-b",
					"origin/master",
				],
				cwd: "/workspace/repo-b",
			},
			{ command: "git", args: ["-C", "/workspace/docs", "rev-parse", "--show-toplevel"], cwd: "/workspace" },
		]);
		expect(fs.copyTree).toHaveBeenCalledWith("/workspace/docs", "/workspace/.pi/projects/demo/docs", DEFAULT_EXCLUDES);
		expect(result).toMatchObject({ root: "/workspace/.pi/projects/demo", branch: "agent/demo" });
		expect(result.errors).toEqual([]);
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
				outputName: "projects/run-1",
				branch: "agent/run-1",
				selections: ["dirty", "other"],
			},
			{ runner, fs },
		);

		expect(runner.calls.some(({ args }) => args.includes("reset") || args.includes("checkout"))).toBe(false);
		expect(result.errors).toEqual([expect.stringMatching(/dirty|network unavailable/i)]);
		expect(result.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "/workspace/other", kind: "worktree" })]),
		);
	});

	it("rejects traversal, invalid branch names, and an output collision before touching Git", async () => {
		expect(validateBranchName("agent/demo")).toBeNull();
		expect(validateBranchName("../escape")).toMatch(/branch/i);
		expect(validateSelection("/workspace", "../outside")).toMatch(/workspace|outside/i);
		const runner = gitRunner();
		const fs = fileOps({
			mkdir: vi.fn(async () => {
				throw new Error("EEXIST");
			}),
		});

		await expect(
			prepareProject(
				{ workspaceRoot: "/workspace", outputName: "projects/demo", branch: "agent/demo", selections: ["repo-a"] },
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
			{ workspaceRoot: "/workspace", outputName: "projects/demo", branch: "agent/demo", selections: ["private"] },
			{ runner, fs },
		);
		expect(result.errors).toEqual([expect.stringMatching(/permission denied|git/i)]);
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
				outputName: "projects/demo",
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
				outputName: "projects/demo",
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
	it("lists workspace folders and returns the created aggregate path through the plugin protocol", async () => {
		const host = createMockHost({
			permissions: ["fs", "terminal"],
			files: { "repo-a/README.md": "a", "docs/guide.md": "guide" },
		});
		const deactivate = worktreeServer.activate(host);
		await host.emit.message({ action: "get_state" }, "client-1");
		expect(statePayloads(host).at(-1)).toMatchObject({ folders: ["docs", "repo-a"] });
		deactivate?.();
	});

	it("mounts explicit fields and controls without starting a session automatically", () => {
		const { ctx, sent, push } = createMockViewContext("worktree-preparer");
		const document = createFakeDocument();
		const container = document.createElement("div");
		const cleanup = worktreeClient.mount?.(container as unknown as HTMLElement, ctx);
		push({ kind: "state", state: { cwd: "/workspace", folders: ["repo-a"], result: null, error: null } });
		expect(sent).toContainEqual({ action: "get_state" });
		expect(descendants(container).some((element) => element.dataset.action === "prepare")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.field === "branch")).toBe(true);
		expect(descendants(container).some((element) => element.dataset.action === "open-session")).toBe(false);
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

/**
 * The ssh2 bootstrap branch of the vscode-editor server entry.
 *
 * vscode-editor depends on ssh2, which is not bundled with the plugin: the entry
 * tries to import it and, when that fails, shells out to npm to install it into
 * the plugin directory. The main server suite mocks ssh2 as present, so this file
 * covers the other side - the module is absent, an installer is spawned, and the
 * outcome is reported back through host.notify and the public state.
 *
 * Both halves are doubles: `ssh2` is mocked to reject the import, and
 * node:child_process.spawn is mocked to hand back an inert EventEmitter. Nothing
 * here reaches the network, npm or a real SSH server, and no package is installed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockHost, type MockHost } from "../helpers/mock-host";

/** Make the plugin's `await import("ssh2")` reject, as an absent package would. */
vi.mock("ssh2", () => {
	throw new Error("Cannot find module 'ssh2'");
});

/** Spawn calls captured instead of executed, plus the inert children returned. */
const cp = vi.hoisted(() => ({
	calls: [] as unknown[][],
	children: [] as { emit(event: string, arg?: unknown): void }[],
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		spawn: (...args: unknown[]) => {
			const child = new EventEmitter();
			cp.calls.push(args);
			cp.children.push(child as unknown as { emit(event: string, arg?: unknown): void });
			return child;
		},
	};
});

const PERMISSIONS = ["fs:workspace+ssh", "net:ssh", "terminal"];

/** The npm arguments the plugin must always use, whatever the spawn shape. */
const INSTALL_ARGS = (pluginDir: string): string[] => [
	"--prefix",
	pluginDir,
	"install",
	"ssh2@latest",
	"--no-audit",
	"--no-fund",
];

interface Reply {
	[key: string]: unknown;
}

interface PublicState {
	depsReady: boolean;
	depsInstalling: boolean;
	hosts: unknown[];
	conns: unknown[];
}

let entry: { activate(host: MockHost): (() => void) | undefined };
const tempDirs: string[] = [];

/** Let queued microtasks and macrotasks drain. */
async function settle(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function cjkIn(text: string): string[] {
	return text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? [];
}

function expectEnglish(text: string): void {
	expect(cjkIn(text), `expected English, got: ${text}`).toEqual([]);
}

interface Harness {
	host: MockHost;
	root: string;
	pluginDir: string;
	deactivate: (() => void) | undefined;
	call(action: string, extra?: Record<string, unknown>): Promise<Reply>;
	state(): Promise<PublicState>;
	notifications(): { level: string; text: string }[];
}

async function startServer(): Promise<Harness> {
	const base = mkdtempSync(join(tmpdir(), "vsc-editor-deps-"));
	tempDirs.push(base);
	const root = join(base, "workspace");
	const pluginDir = join(base, "plugins", "vscode-editor");
	mkdirSync(root, { recursive: true });
	mkdirSync(pluginDir, { recursive: true });

	const host = createMockHost({ dir: pluginDir, dataDir: join(base, "plugins"), cwd: root, permissions: PERMISSIONS });
	let reqSeq = 0;
	const harness: Harness = {
		host,
		root,
		pluginDir,
		deactivate: undefined,
		async call(action, extra = {}) {
			const reqId = `deps-${(reqSeq += 1)}`;
			const before = host.recorded.sent.length;
			await host.emit.message({ action, reqId, ...extra }, "client-a");
			await settle();
			const matches = host.recorded.sent
				.slice(before)
				.filter((s) => s.clientId === "client-a" && (s.payload as Reply).reqId === reqId);
			expect(matches, `expected exactly one reply for ${action}`).toHaveLength(1);
			return matches[0]!.payload as Reply;
		},
		async state() {
			return (await harness.call("state")).state as PublicState;
		},
		notifications() {
			return host.recorded.notifications.map((n) => ({ level: n.level, text: n.text }));
		},
	};
	const deactivate = entry.activate(host);
	harness.deactivate = typeof deactivate === "function" ? deactivate : undefined;
	await settle();
	return harness;
}

/** The child process from the most recent spawn. */
function lastChild(): { emit(event: string, arg?: unknown): void } {
	const child = cp.children.at(-1);
	if (!child) throw new Error("the plugin never spawned an installer");
	return child;
}

beforeAll(async () => {
	entry = (await import("../../plugins/vscode-editor/src/index")).default as typeof entry;
});

beforeEach(() => {
	cp.calls.length = 0;
	cp.children.length = 0;
});

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("ssh2 dependency bootstrap", () => {
	it("spawns an install into the plugin directory when the import fails", async () => {
		const h = await startServer();
		expect(cp.calls).toHaveLength(1);
		const args = cp.calls[0]![1] as string[];
		expect(args.slice(-6)).toEqual(INSTALL_ARGS(h.pluginDir));
		h.deactivate?.();
	});

	it("announces the install with an English notice and reports it as in flight", async () => {
		const h = await startServer();
		const notices = h.notifications();
		expect(notices).toHaveLength(1);
		expect(notices[0]!.level).toBe("info");
		expect(notices[0]!.text.length).toBeGreaterThan(0);
		expectEnglish(notices[0]!.text);
		expect(await h.state()).toMatchObject({ depsReady: false, depsInstalling: true });
		h.deactivate?.();
	});

	it("answers deps_install immediately and does not spawn a second installer", async () => {
		const h = await startServer();
		expect(await h.call("deps_install")).toMatchObject({ ok: true, action: "deps_install" });
		await settle();
		expect(cp.calls).toHaveLength(1);
		h.deactivate?.();
	});

	it("reports failure and stays unready when the installer exits non-zero", async () => {
		const h = await startServer();
		lastChild().emit("exit", 1);
		await settle();
		const notices = h.notifications();
		expect(notices.at(-1)!.level).toBe("error");
		expectEnglish(notices.at(-1)!.text);
		expect(await h.state()).toMatchObject({ depsReady: false, depsInstalling: false });
		// The dependency state is broadcast so the UI can refresh its warning badge.
		expect(h.host.recorded.broadcasts.some((b) => (b as { kind?: string }).kind === "state")).toBe(true);
		h.deactivate?.();
	});

	it("reports failure when the installer exits cleanly but the module is still absent", async () => {
		const h = await startServer();
		lastChild().emit("exit", 0);
		await settle();
		expect(h.notifications().at(-1)!.level).toBe("error");
		expect(await h.state()).toMatchObject({ depsReady: false, depsInstalling: false });
		h.deactivate?.();
	});

	it("reports failure when the installer process cannot start at all", async () => {
		const h = await startServer();
		lastChild().emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
		await settle();
		expect(h.notifications().at(-1)!.level).toBe("error");
		expect(await h.state()).toMatchObject({ depsReady: false, depsInstalling: false });
		h.deactivate?.();
	});

	it("makes a caller that joined an in-flight install fail with an English error", async () => {
		const h = await startServer();
		mkdirSync(join(h.root, ".vscode"), { recursive: true });
		writeFileSync(
			join(h.root, ".vscode", "sftp.json"),
			JSON.stringify({ host: "sync.example.com", username: "tester", remotePath: "/srv" }),
		);

		const pending = h.call("sync_test");
		lastChild().emit("exit", 1);
		const reply = await pending;
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(await h.state()).toMatchObject({ depsReady: false });
		h.deactivate?.();
	});

	it("refuses a sync run while the dependency is missing", async () => {
		const h = await startServer();
		mkdirSync(join(h.root, ".vscode"), { recursive: true });
		writeFileSync(
			join(h.root, ".vscode", "sftp.json"),
			JSON.stringify({ host: "sync.example.com", username: "tester", remotePath: "/srv" }),
		);
		lastChild().emit("exit", 1);
		await settle();
		const reply = await h.call("sync_run", { dir: "up", scope: "all" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("survives the installer finishing after deactivate", async () => {
		const h = await startServer();
		h.deactivate?.();
		// The child outlives the plugin: its exit handler must not throw or hang.
		expect(() => lastChild().emit("exit", 1)).not.toThrow();
		await settle();
		expect(await h.host.emit.message({ action: "state" }, "client-a")).toBe(0);
		for (const notice of h.notifications()) expectEnglish(notice.text);
	});
});

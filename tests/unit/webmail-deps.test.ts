/**
 * webmail dependency bootstrap.
 *
 * imapflow / mailparser / nodemailer are not bundled: the plugin imports them at
 * runtime and, when they are missing, shells out to npm to install them into its
 * own directory. Nothing here is installed in this repo, so every test runs with
 * the drivers genuinely absent - which is exactly the branch under test - and npm
 * itself is stubbed at the module level so no process is spawned and no registry
 * is contacted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import webmail from "../../plugins/webmail/src/index";
import type { PublicState } from "../../plugins/webmail/src/index";

const proc = vi.hoisted(() => ({
	spawnCalls: [] as { command: string; args: string[] }[],
	exitCode: 1 as number | null,
	spawnError: null as string | null,
	/** Leave the child running so a test can observe deactivate killing it. */
	neverExit: false,
	killed: 0,
}));

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[]) => {
		proc.spawnCalls.push({ command, args });
		const handlers: Record<string, ((...values: unknown[]) => void)[]> = {};
		const child = {
			on(event: string, handler: (...values: unknown[]) => void) {
				(handlers[event] ??= []).push(handler);
			},
			kill() {
				proc.killed += 1;
			},
		};
		if (!proc.neverExit) {
			queueMicrotask(() => {
				if (proc.spawnError) for (const handler of handlers.error ?? []) handler(new Error(proc.spawnError));
				else for (const handler of handlers.exit ?? []) handler(proc.exitCode);
			});
		}
		return child;
	},
}));

/** The three packages the plugin installs, in the order it asks for them. */
const PACKAGES = ["imapflow@latest", "mailparser@latest", "nodemailer@latest"];

const dirs: string[] = [];
const started: (() => void)[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "webmail-deps-"));
	dirs.push(dir);
	return dir;
}

interface Harness {
	host: MockHost;
	dir: string;
	deactivate: () => void;
}

async function start(config?: Record<string, unknown>): Promise<Harness> {
	const dir = tempDir();
	const host = createMockHost({ dir, permissions: ["net:imap/smtp", "tools"] });
	const deactivate = webmail.activate(host);
	started.push(deactivate);
	await vi.waitFor(() => expect(host.recorded.broadcasts.length).toBeGreaterThan(0));
	if (config) {
		await host.emit.message({ action: "save_config", config }, "client-1");
		await settle();
	}
	return { host, dir, deactivate };
}

async function settle(rounds = 25): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function lastState(host: MockHost): PublicState {
	const states = [...host.recorded.broadcasts, ...host.recorded.sent.map((entry) => entry.payload)]
		.map((payload) => (typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}))
		.filter((payload) => payload.kind === "state")
		.map((payload) => payload.state as PublicState);
	if (states.length === 0) throw new Error("the plugin never reported a state payload");
	return states[states.length - 1]!;
}

function notificationTexts(host: MockHost): string[] {
	return host.recorded.notifications.map((entry) => entry.text);
}

/** Notifications that announce an install has started. */
function announcing(host: MockHost): string[] {
	return notificationTexts(host).filter((text) => /installing dependencies/i.test(text));
}

/** The npm arguments, with the leading `node <npm-cli.js>` pair removed when the
 *  plugin resolved npm's own cli instead of relying on PATH. */
function npmArgs(call: { command: string; args: string[] }): string[] {
	return call.command === process.execPath ? call.args.slice(1) : call.args;
}

beforeEach(() => {
	proc.spawnCalls = [];
	proc.exitCode = 1;
	proc.spawnError = null;
	proc.neverExit = false;
	proc.killed = 0;
});

afterEach(() => {
	while (started.length > 0) started.pop()!();
});

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("webmail dependency bootstrap", () => {
	it("reports the missing drivers to the view and installs them automatically", async () => {
		const { host, dir } = await start();
		await vi.waitFor(() => expect(proc.spawnCalls).toHaveLength(1));

		expect(lastState(host).depsOk).toBe(false);
		const call = proc.spawnCalls[0]!;
		expect([process.execPath, "npm"]).toContain(call.command);
		if (call.command === process.execPath) expect(call.args[0]).toMatch(/npm-cli\.js$/);
		expect(npmArgs(call)).toEqual(["--prefix", dir, "install", ...PACKAGES, "--no-audit", "--no-fund"]);

		// An automatic install announces itself once; the manual path adds a second.
		await settle();
		expect(announcing(host)).toHaveLength(1);
	});

	it("reports a failed npm run as an error notification", async () => {
		proc.exitCode = 1;
		const { host } = await start();
		await vi.waitFor(() => expect(host.recorded.notifications.some((entry) => entry.level === "error")).toBe(true));
		const failure = host.recorded.notifications.find((entry) => entry.level === "error")!;
		expect(failure.text).toMatch(/npm exit 1/);
		expect(failure.text).toMatch(/install/i);
		expect(lastState(host).depsOk).toBe(false);
		expect(lastState(host).depsInstalling).toBe(false);
	});

	it("reports a spawn failure without letting the error escape", async () => {
		proc.spawnError = "spawn npm ENOENT";
		const { host } = await start();
		await vi.waitFor(() => expect(host.recorded.notifications.some((entry) => entry.level === "error")).toBe(true));
		expect(host.recorded.notifications.find((entry) => entry.level === "error")!.text).toContain("spawn npm ENOENT");
		expect(lastState(host).depsInstalling).toBe(false);
	});

	it("reports success when npm exits zero even though the drivers are still absent", async () => {
		proc.exitCode = 0;
		const { host } = await start();
		// Upstream announces a finished install with level "success", which the host
		// contract does not list; the browser renders it with its default styling.
		const succeeded = () => host.recorded.notifications.filter((entry) => (entry.level as string) === "success");
		await vi.waitFor(() => expect(succeeded()).toHaveLength(1));
		expect(succeeded()[0]!.text).toMatch(/dependencies installed/i);
		// A successful npm run that did not actually provide the drivers must not
		// be reported as ready, or the view would hide its install button.
		expect(lastState(host).depsOk).toBe(false);
	});

	it("ignores a second install request while one is already running", async () => {
		proc.neverExit = true;
		const { host } = await start();
		await vi.waitFor(() => expect(proc.spawnCalls).toHaveLength(1));

		await host.emit.message({ action: "install_deps" }, "client-1");
		await settle();
		expect(proc.spawnCalls).toHaveLength(1);
		expect(lastState(host).depsInstalling).toBe(true);
	});

	it("announces a manual install twice, as the automatic one does not", async () => {
		const { host } = await start();
		await vi.waitFor(() => expect(proc.spawnCalls).toHaveLength(1));
		await settle();
		const before = announcing(host).length;
		expect(before).toBe(1);

		await host.emit.message({ action: "install_deps" }, "client-1");
		await vi.waitFor(() => expect(proc.spawnCalls).toHaveLength(2));
		await settle();
		// Upstream fires a short notice and then a detailed one for a manual run.
		expect(announcing(host).length).toBe(before + 2);
	});

	it("does not register the AI mail tools while the drivers are missing", async () => {
		const { host } = await start({
			imap: { host: "imap.example.com", user: "me@example.com" },
			smtp: { host: "smtp.example.com", user: "me@example.com" },
			aiEnabled: true,
		});
		await settle();
		expect(host.recorded.agentTools.size).toBe(0);
		expect(lastState(host).aiEnabled).toBe(true);
	});

	it("does not start the poller without the drivers", async () => {
		const { host } = await start({
			imap: { host: "imap.example.com", user: "me@example.com", pass: "x" },
			pollSec: 15,
		});
		await settle();
		expect(host.backgroundTask("mail-poll")).toBeUndefined();
		// The user asked for notifications, but nothing can poll yet.
		expect(lastState(host).notifyEnabled).toBe(true);
		expect(lastState(host).configured).toBe(true);
	});

	it("reports a mail operation as a dependency error rather than crashing", async () => {
		const { host } = await start();
		await vi.waitFor(() => expect(proc.spawnCalls).toHaveLength(1));
		await host.emit.message({ action: "list", folder: "INBOX" }, "client-1");
		await settle();
		expect(lastState(host).status).toMatch(/dependencies are not installed/i);
		expect(host.recorded.rejections).toEqual([]);
	});

	it("kills an in-flight install on deactivate", async () => {
		proc.neverExit = true;
		const { deactivate } = await start();
		await vi.waitFor(() => expect(proc.spawnCalls).toHaveLength(1));
		deactivate();
		expect(proc.killed).toBe(1);
	});
});

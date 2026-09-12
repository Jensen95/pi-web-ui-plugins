/**
 * db-client driver installation: the decision logic around the npm child process
 * the plugin spawns on first activation.
 *
 * node:child_process is mocked, so nothing is ever downloaded, extracted or
 * written into a real node_modules. What is asserted is the observable contract:
 * when a spawn happens, with what arguments, what the plugin tells the user
 * while it runs, and what it reports for each way the install can end.
 *
 * The mock lives in its own file on purpose - vi.mock is per module registry, and
 * the protocol tests in db-client.test.ts must run against the real spawn (which
 * they never reach, because PI_DB_CLIENT_NO_AUTOINSTALL is set there).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockHost, type MockHost } from "../helpers/mock-host";
import plugin, { DEPS, type PublicState } from "../../plugins/db-client/src/index";

/** Everything the hoisted mock factory needs, created before any import runs. */
const harness = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	interface FakeChild {
		/** Signals this fake was asked to send, in order. */
		kills: string[];
		on(event: string, listener: Listener): FakeChild;
		stderr: { on(event: string, listener: Listener): void };
		kill(signal?: string): boolean;
		/** Test-side trigger: fire an event at the plugin's listeners. */
		fire(event: string, ...args: unknown[]): void;
		/** Test-side trigger: feed a chunk to the stderr "data" listeners. */
		stderrData(text: string): void;
	}

	interface SpawnRecord {
		command: string;
		args: string[];
		child: FakeChild;
	}

	const spawned: SpawnRecord[] = [];

	function makeChild(): FakeChild {
		const listeners = new Map<string, Listener[]>();
		const stderrListeners: Listener[] = [];
		const child: FakeChild = {
			kills: [],
			on(event, listener) {
				const list = listeners.get(event) ?? [];
				list.push(listener);
				listeners.set(event, list);
				return child;
			},
			stderr: {
				on(_event, listener) {
					stderrListeners.push(listener);
				},
			},
			kill(signal) {
				child.kills.push(signal ?? "SIGTERM");
				return true;
			},
			fire(event, ...args) {
				for (const listener of listeners.get(event) ?? []) listener(...args);
			},
			stderrData(text) {
				for (const listener of stderrListeners) listener({ toString: () => text });
			},
		};
		return child;
	}

	return { spawned, makeChild };
});

vi.mock("node:child_process", () => ({
	spawn(command: unknown, args: unknown) {
		const child = harness.makeChild();
		harness.spawned.push({
			command: String(command),
			args: Array.isArray(args) ? args.map(String) : [],
			child,
		});
		return child;
	},
}));

const LOCK_FILE = ".deps-install.lock";
const dirs: string[] = [];

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "db-client-install-"));
	dirs.push(dir);
	return dir;
}

/** A host whose plugin directory really exists, so the lock file can be written. */
function hostFor(dir: string): MockHost {
	return createMockHost({ dir, permissions: ["net", "tools"] });
}

let seq = 0;

async function send(
	host: MockHost,
	message: Record<string, unknown>,
	clientId = "c1",
): Promise<Record<string, unknown>> {
	const reqId = `i${++seq}`;
	await host.emit.message({ ...message, reqId }, clientId);
	const replies = host.recorded.sent.filter((entry) => {
		const payload = entry.payload as Record<string, unknown> | null;
		return payload !== null && typeof payload === "object" && payload.res === true && payload.reqId === reqId;
	});
	expect(replies).toHaveLength(1);
	return replies[0].payload as Record<string, unknown>;
}

/** Flush the readiness gate: the message handler awaits ensureReady() first, so
 *  one round trip guarantees loadConfig(), the driver probe and any auto install
 *  have all run. */
async function ready(host: MockHost): Promise<PublicState> {
	const res = await send(host, { action: "state" });
	return res.state as PublicState;
}

function noticeTexts(host: MockHost): string[] {
	return host.recorded.notifications.map((n) => n.text);
}

/** The recorded level is typed as the documented three, while the plugin also
 *  sends "success" for a finished install - compare as a string. */
function lastNoticeLevel(host: MockHost): string {
	return String(host.recorded.notifications.at(-1)?.level ?? "");
}

/** Activate and let the auto install reach the spawn, then hand back the child. */
async function withRunningInstall(): Promise<{
	host: MockHost;
	dir: string;
	child: (typeof harness.spawned)[number]["child"];
	deactivate: (() => void) | undefined;
}> {
	const dir = freshDir();
	const host = hostFor(dir);
	const deactivate = await plugin.activate(host);
	await ready(host);
	expect(harness.spawned).toHaveLength(1);
	return { host, dir, child: harness.spawned[0].child, deactivate };
}

beforeEach(() => {
	harness.spawned.length = 0;
	delete process.env.PI_DB_CLIENT_NO_AUTOINSTALL;
	vi.useRealTimers();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("automatic install on activation", () => {
	it("spawns npm against the plugin directory with every driver spec", async () => {
		const dir = freshDir();
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		await ready(host);

		expect(harness.spawned).toHaveLength(1);
		const { command, args } = harness.spawned[0];
		// Either node runs npm-cli.js directly (no shell), or the whole command is
		// handed to a shell as one string. Both must carry the same arguments.
		const entry = command === process.execPath ? args[0] : command;
		expect(entry).toContain("npm");
		const argv = [command, ...args].join(" ");
		expect(argv).toContain(`--prefix ${dir}`);
		for (const spec of DEPS) expect(argv, `${spec} missing from ${argv}`).toContain(spec);
		expect(argv).toContain("--no-audit");
		expect(argv).toContain("--no-fund");

		// The lock is taken before npm starts, so a concurrent activation skips.
		expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
		const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as { at: number; pid: number };
		expect(lock.pid).toBe(process.pid);
		expect(typeof lock.at).toBe("number");

		expect(noticeTexts(host).join("\n")).toContain("installing driver dependencies");
		deactivate?.();
	});

	it("reports the install as running in the state it broadcasts", async () => {
		const dir = freshDir();
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		const installing = await ready(host);
		expect(installing.depsInstalling).toBe(true);
		expect(installing.depsOk).toBe(false);
		deactivate?.();
	});

	it("does nothing when the kill switch environment variable is set", async () => {
		process.env.PI_DB_CLIENT_NO_AUTOINSTALL = "1";
		const dir = freshDir();
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		const state = await ready(host);

		expect(harness.spawned).toEqual([]);
		expect(state.depsInstalling).toBe(false);
		expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
		expect(host.recorded.logs.flat().join(" ")).toContain("auto install disabled by PI_DB_CLIENT_NO_AUTOINSTALL");
		deactivate?.();
	});

	it("skips while another activation holds a fresh lock", async () => {
		const dir = freshDir();
		writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ at: Date.now(), pid: 999999 }), "utf8");
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		await ready(host);

		expect(harness.spawned).toEqual([]);
		expect(noticeTexts(host).join("\n")).toContain("a driver install is already running");
		// Somebody else's lock must survive: only the owner clears it.
		expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
		deactivate?.();
	});

	it("takes over a lock left behind by a crash", async () => {
		const dir = freshDir();
		writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ at: Date.now() - 31 * 60_000, pid: 1 }), "utf8");
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		await ready(host);

		expect(harness.spawned).toHaveLength(1);
		const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as { pid: number };
		expect(lock.pid).toBe(process.pid);
		deactivate?.();
	});

	it("ignores a corrupt lock file", async () => {
		const dir = freshDir();
		writeFileSync(join(dir, LOCK_FILE), "not json at all", "utf8");
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		await ready(host);
		expect(harness.spawned).toHaveLength(1);
		deactivate?.();
	});
});

describe("manual install", () => {
	it("ignores a second request while an install is already running", async () => {
		const dir = freshDir();
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		// Activation already started the auto install; a manual request must not
		// start a second npm in the same directory.
		await ready(host);
		expect(harness.spawned).toHaveLength(1);

		const res = await send(host, { action: "deps_install" });
		expect(res.ok).toBe(true);
		expect(harness.spawned).toHaveLength(1);
		deactivate?.();
	});

	it("starts an install on demand when auto install was disabled", async () => {
		process.env.PI_DB_CLIENT_NO_AUTOINSTALL = "1";
		const dir = freshDir();
		const host = hostFor(dir);
		const deactivate = await plugin.activate(host);
		await ready(host);
		expect(harness.spawned).toEqual([]);

		const res = await send(host, { action: "deps_install" });
		expect(res.ok).toBe(true);
		expect(harness.spawned).toHaveLength(1);
		deactivate?.();
	});
});

describe("install outcome", () => {
	it("reports success, clears the lock and re-probes the drivers", async () => {
		const { host, dir, child, deactivate } = await withRunningInstall();
		child.fire("exit", 0, null);
		await vi.waitFor(() => {
			expect(noticeTexts(host).join("\n")).toContain("driver install finished");
		});
		expect(lastNoticeLevel(host)).toBe("success");
		expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
		const state = await ready(host);
		expect(state.depsInstalling).toBe(false);
		// The npm drivers are still absent from this repo, so the probe still fails.
		expect(state.depsOk).toBe(false);
		deactivate?.();
	});

	it("reports a non-zero exit with the last stderr line and the manual command", async () => {
		const { host, dir, child, deactivate } = await withRunningInstall();
		child.stderrData("npm warn deprecated something\n");
		child.stderrData("npm error code E404\n");
		child.fire("exit", 1, null);
		await vi.waitFor(() => {
			expect(lastNoticeLevel(host)).toBe("error");
		});
		const text = noticeTexts(host).at(-1) ?? "";
		expect(text).toContain("driver install failed");
		expect(text).toContain("npm exit 1");
		expect(text).toContain("npm error code E404");
		expect(text).not.toContain("npm warn deprecated");
		expect(text).toContain(`npm install ${DEPS.join(" ")}`);
		expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
		expect((await ready(host)).depsInstalling).toBe(false);
		deactivate?.();
	});

	it("reports a signal as a killed install", async () => {
		const { host, child, deactivate } = await withRunningInstall();
		child.fire("exit", null, "SIGKILL");
		await vi.waitFor(() => {
			expect(noticeTexts(host).join("\n")).toContain("npm was killed (SIGKILL)");
		});
		expect(lastNoticeLevel(host)).toBe("error");
		deactivate?.();
	});

	it("reports a spawn failure", async () => {
		const { host, child, deactivate } = await withRunningInstall();
		child.fire("error", new Error("spawn npm ENOENT"));
		await vi.waitFor(() => {
			expect(noticeTexts(host).join("\n")).toContain("spawn npm ENOENT");
		});
		expect(lastNoticeLevel(host)).toBe("error");
		deactivate?.();
	});

	it("only reports the first outcome when npm exits twice", async () => {
		const { host, child, deactivate } = await withRunningInstall();
		child.fire("exit", 0, null);
		child.fire("exit", 1, null);
		await vi.waitFor(() => {
			expect(noticeTexts(host).join("\n")).toContain("driver install finished");
		});
		expect(noticeTexts(host).join("\n")).not.toContain("driver install failed");
		deactivate?.();
	});

	it("kills npm when the watchdog fires", async () => {
		// Fake timers must be installed before activate() so the watchdog itself is
		// fake; the manual path is used to keep this test independent of the env.
		process.env.PI_DB_CLIENT_NO_AUTOINSTALL = "1";
		vi.useFakeTimers();
		try {
			const dir = freshDir();
			const host = hostFor(dir);
			const deactivate = await plugin.activate(host);
			await ready(host);
			await send(host, { action: "deps_install" });
			expect(harness.spawned).toHaveLength(1);
			const child = harness.spawned[0].child;

			await vi.advanceTimersByTimeAsync(20 * 60_000 + 5_000);

			expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
			expect(noticeTexts(host).join("\n")).toContain("install timed out");
			expect(lastNoticeLevel(host)).toBe("error");
			expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
			deactivate?.();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("deactivate during an install", () => {
	it("kills the child process, clears the lock and ignores a late exit", async () => {
		const { host, dir, child, deactivate } = await withRunningInstall();
		expect(existsSync(join(dir, LOCK_FILE))).toBe(true);

		const noticesBefore = host.recorded.notifications.length;
		deactivate?.();

		expect(child.kills).toContain("SIGTERM");
		expect(existsSync(join(dir, LOCK_FILE))).toBe(false);

		// A child that reports back after shutdown must not talk to the host again.
		child.fire("exit", 0, null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.recorded.notifications).toHaveLength(noticesBefore);
	});

	it("is safe to call when no install ever started", () => {
		process.env.PI_DB_CLIENT_NO_AUTOINSTALL = "1";
		const dir = freshDir();
		const host = hostFor(dir);
		expect(() => {
			const ret = plugin.activate(host);
			if (typeof ret === "function") ret();
		}).not.toThrow();
		expect(harness.spawned).toEqual([]);
	});
});

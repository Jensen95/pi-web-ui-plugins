/**
 * webmail credential handling.
 *
 * The plugin keeps passwords in the host's encrypted secret store
 * (host.secrets, AES-256-GCM) and only falls back to plaintext config.json when
 * that store is missing or its write silently fails. These tests lock the
 * invariants that matter, because a regression here either leaks a password to
 * the browser or loses it entirely:
 *
 *   1. secrets available  -> password goes to host.secrets, config.json holds "",
 *      and nothing pushed to a client contains the password;
 *   2. secrets write fails -> the password stays in config.json (plaintext is
 *      better than losing it) and the user is warned exactly once;
 *   3. a re-save with a blank password field keeps the stored password;
 *   4. a restart rehydrates the password from the secret store alone.
 *
 * The mail drivers are deliberately NOT mocked here: with no imapflow the plugin
 * reports depsOk false, so no poller starts and no socket is opened. npm is
 * stubbed at the module level so the auto-install never spawns a real process.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import webmail from "../../plugins/webmail/src/index";
import type { PublicState } from "../../plugins/webmail/src/index";

// ---------------------------------------------------------------------------
// Inert npm
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The secret names are protocol values: renaming one orphans every saved
 *  credential, so they are spelled out here rather than read from the plugin. */
const IMAP_SECRET = "imap_pass";
const SMTP_SECRET = "smtp_pass";
const IMAP_PASS = "imap-hunter2";
const SMTP_PASS = "smtp-hunter2";
const CONFIG_FILE = "config.json";

const dirs: string[] = [];
const started: (() => void)[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "webmail-secrets-"));
	dirs.push(dir);
	return dir;
}

/** config.json as written on disk; only the fields these tests assert on. */
interface StoredConfig {
	imap?: { host?: string; user?: string; pass?: string };
	smtp?: { host?: string; user?: string; pass?: string; from?: string };
	pollSec?: number;
	notifyEnabled?: boolean;
	aiEnabled?: boolean;
}

function readConfig(dir: string): StoredConfig | null {
	const file = join(dir, CONFIG_FILE);
	try {
		return JSON.parse(readFileSync(file, "utf8")) as StoredConfig;
	} catch {
		return null;
	}
}

interface Harness {
	host: MockHost;
	dir: string;
	deactivate: () => void;
}

interface StartOptions {
	dir?: string;
	secrets?: Record<string, string>;
	/** Replace host.secrets entirely (undefined simulates an older host). */
	secretsOverride?: MockHost["secrets"] | undefined;
	config?: Record<string, unknown>;
}

/** Activate against a host whose secret store can be broken on purpose. */
async function start(options: StartOptions = {}): Promise<Harness> {
	const dir = options.dir ?? tempDir();
	if (options.config) writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(options.config), "utf8");
	const host = createMockHost({
		dir,
		permissions: ["net:imap/smtp", "tools"],
		secrets: options.secrets,
	});
	if ("secretsOverride" in options) {
		// A host build without an encrypted store, or one whose set() silently fails.
		(host as { secrets?: unknown }).secrets = options.secretsOverride;
	}
	const deactivate = webmail.activate(host);
	started.push(deactivate);
	await vi.waitFor(() => expect(host.recorded.broadcasts.length).toBeGreaterThan(0));
	return { host, dir, deactivate };
}

/** A secret store whose set() does nothing, mirroring a failed write to disk. */
function failingSecrets(host: MockHost): MockHost["secrets"] {
	return { ...host.secrets, set: () => {} };
}

async function settle(rounds = 25): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function saveConfig(host: MockHost, config: Record<string, unknown>, from = "client-1"): Promise<void> {
	await host.emit.message({ action: "save_config", config }, from);
	await settle();
}

function fullConfig(imapPass?: string, smtpPass?: string): Record<string, unknown> {
	const imap: Record<string, unknown> = { host: "imap.example.com", port: 993, tls: true, user: "me@example.com" };
	const smtp: Record<string, unknown> = {
		host: "smtp.example.com",
		port: 465,
		tls: true,
		user: "me@example.com",
		from: "me@example.com",
	};
	if (imapPass !== undefined) imap.pass = imapPass;
	if (smtpPass !== undefined) smtp.pass = smtpPass;
	return { imap, smtp, pollSec: 60, notifyEnabled: true, aiEnabled: false };
}

function lastState(host: MockHost): PublicState {
	const states = [...host.recorded.broadcasts, ...host.recorded.sent.map((entry) => entry.payload)]
		.map((payload) => (typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}))
		.filter((payload) => payload.kind === "state")
		.map((payload) => payload.state as PublicState);
	if (states.length === 0) throw new Error("the plugin never reported a state payload");
	return states[states.length - 1]!;
}

/** Everything the plugin ever pushed towards a browser, serialised. */
function wire(host: MockHost): string {
	return JSON.stringify([...host.recorded.broadcasts, ...host.recorded.sent, ...host.recorded.notifications]);
}

function warningNotifications(host: MockHost): string[] {
	return host.recorded.notifications.filter((entry) => entry.level === "warning").map((entry) => entry.text);
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

// ---------------------------------------------------------------------------

describe("webmail credentials go through host.secrets", () => {
	it("stores both passwords under the upstream secret names and strips them from disk", async () => {
		const { host, dir } = await start();
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS));

		expect(host.secrets.get(IMAP_SECRET)).toBe(IMAP_PASS);
		expect(host.secrets.get(SMTP_SECRET)).toBe(SMTP_PASS);
		expect(host.secrets.list().sort()).toEqual([IMAP_SECRET, SMTP_SECRET]);

		const stored = readConfig(dir);
		expect(stored, "config.json was never written").not.toBeNull();
		expect(stored!.imap!.pass).toBe("");
		expect(stored!.smtp!.pass).toBe("");
		// The non-secret fields still round-trip through the file.
		expect(stored!.imap).toMatchObject({ host: "imap.example.com", port: 993, tls: true, user: "me@example.com" });
		expect(stored).toMatchObject({ pollSec: 60, notifyEnabled: true, aiEnabled: false });

		expect(lastState(host).config.imap.hasPass).toBe(true);
		expect(lastState(host).config.smtp.hasPass).toBe(true);
		expect(warningNotifications(host)).toEqual([]);
	});

	it("migrates a legacy plaintext password out of config.json on activation", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(fullConfig(IMAP_PASS, SMTP_PASS)), "utf8");
		const { host } = await start({ dir });

		expect(host.secrets.get(IMAP_SECRET)).toBe(IMAP_PASS);
		expect(host.secrets.get(SMTP_SECRET)).toBe(SMTP_PASS);
		expect(readConfig(dir)!.imap!.pass).toBe("");
		expect(readConfig(dir)!.smtp!.pass).toBe("");
		// Memory keeps the real password, so a connection would still authenticate.
		expect(lastState(host).config.imap.hasPass).toBe(true);
	});

	it("never puts a password in anything sent to a client", async () => {
		const { host } = await start({ config: fullConfig(IMAP_PASS, SMTP_PASS) });
		await host.emit.message({ action: "get_state" }, "client-9");
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS), "client-9");
		await host.emit.message({ action: "get_state" }, "client-9");
		await settle();

		const leaked = wire(host);
		expect(leaked).not.toContain(IMAP_PASS);
		expect(leaked).not.toContain(SMTP_PASS);
		expect(Object.keys(lastState(host).config.imap)).not.toContain("pass");
		expect(Object.keys(lastState(host).config.smtp)).not.toContain("pass");
	});

	it("keeps the stored password when the user re-saves with a blank field", async () => {
		const { host } = await start();
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS));
		// The view deletes an empty password input rather than sending "".
		await saveConfig(host, fullConfig());

		expect(host.secrets.get(IMAP_SECRET)).toBe(IMAP_PASS);
		expect(host.secrets.get(SMTP_SECRET)).toBe(SMTP_PASS);
		expect(lastState(host).config.imap.hasPass).toBe(true);
		expect(lastState(host).config.smtp.hasPass).toBe(true);
	});

	it("treats an explicitly empty password field as 'keep what is stored'", async () => {
		const { host } = await start();
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS));
		await saveConfig(host, fullConfig("", ""));
		expect(host.secrets.get(IMAP_SECRET)).toBe(IMAP_PASS);
		expect(lastState(host).config.imap.hasPass).toBe(true);
	});

	it("rehydrates from the secret store alone after a restart", async () => {
		const dir = tempDir();
		const first = await start({ dir });
		await saveConfig(first.host, fullConfig(IMAP_PASS, SMTP_PASS));
		const secrets = {
			[IMAP_SECRET]: first.host.secrets.get(IMAP_SECRET)!,
			[SMTP_SECRET]: first.host.secrets.get(SMTP_SECRET)!,
		};
		first.deactivate();
		started.pop();
		expect(readConfig(dir)!.imap!.pass).toBe("");

		// A fresh process: only the encrypted store knows the password now.
		const second = await start({ dir, secrets });
		expect(lastState(second.host).config.imap.hasPass).toBe(true);
		expect(lastState(second.host).config.smtp.hasPass).toBe(true);
		expect(wire(second.host)).not.toContain(IMAP_PASS);
	});
});

describe("webmail falls back to plaintext rather than losing a password", () => {
	it("keeps the password in config.json when the secret write silently fails", async () => {
		const dir = tempDir();
		const probe = createMockHost({ dir });
		const { host } = await start({ dir, secretsOverride: failingSecrets(probe) });
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS));

		expect(host.secrets.get(IMAP_SECRET)).toBeUndefined();
		expect(readConfig(dir)!.imap!.pass).toBe(IMAP_PASS);
		expect(readConfig(dir)!.smtp!.pass).toBe(SMTP_PASS);
		expect(lastState(host).config.imap.hasPass).toBe(true);
	});

	it("warns about the degraded store exactly once", async () => {
		const dir = tempDir();
		const probe = createMockHost({ dir });
		const { host } = await start({ dir, secretsOverride: failingSecrets(probe) });
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS));
		await saveConfig(host, fullConfig("another", "another"));

		const warnings = warningNotifications(host);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/plain text/i);
		expect(warnings[0]).not.toContain("another");
	});

	it("still works on a host with no secret facility at all", async () => {
		const dir = tempDir();
		const { host } = await start({ dir, secretsOverride: undefined });
		await saveConfig(host, fullConfig(IMAP_PASS, SMTP_PASS));

		expect(readConfig(dir)!.imap!.pass).toBe(IMAP_PASS);
		expect(lastState(host).config.imap.hasPass).toBe(true);
		expect(warningNotifications(host)).toHaveLength(1);
	});

	it("does not strip a legacy password it failed to migrate", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(fullConfig(IMAP_PASS, SMTP_PASS)), "utf8");
		const probe = createMockHost({ dir });
		const { host } = await start({ dir, secretsOverride: failingSecrets(probe) });

		expect(readConfig(dir)!.imap!.pass).toBe(IMAP_PASS);
		expect(lastState(host).config.imap.hasPass).toBe(true);
		expect(warningNotifications(host)).toHaveLength(1);
	});

	it("restarts cleanly from a plaintext config when the store stays broken", async () => {
		const dir = tempDir();
		const probe = createMockHost({ dir });
		const first = await start({ dir, secretsOverride: failingSecrets(probe) });
		await saveConfig(first.host, fullConfig(IMAP_PASS, SMTP_PASS));
		first.deactivate();
		started.pop();

		const probe2 = createMockHost({ dir });
		const second = await start({ dir, secretsOverride: failingSecrets(probe2) });
		expect(lastState(second.host).config.imap.hasPass).toBe(true);
		expect(readConfig(dir)!.imap!.pass).toBe(IMAP_PASS);
	});
});

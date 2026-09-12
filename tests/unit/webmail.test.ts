/**
 * webmail server + client behaviour, exercised through public surfaces only:
 * the server default export's activate(host), the agent tools it registers, the
 * view message protocol it answers, and the client default export plus the pure
 * helpers it exports.
 *
 * The mail drivers are mocked at module level. The plugin resolves them with a
 * runtime `await import(name)` after auto-install, and vitest intercepts that,
 * so nothing here opens a socket, sends mail, or spawns npm.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import { findCjk, formatCjkHits, repoPath } from "../helpers/repo-files";
import webmailClient, { esc, fmtDate } from "../../plugins/webmail/src/client";
import webmailServer, { BODY_LIMIT, DEFAULT_CONFIG, loadConfig, summarize } from "../../plugins/webmail/src/index";
import type { MailSummary, PublicState, WebmailConfig } from "../../plugins/webmail/src/index";
import { STATUS_CONNECTED, STATUS_FAILED_PREFIX, STATUS_UNCONFIGURED } from "../../plugins/webmail/src/protocol";

// ---------------------------------------------------------------------------
// Fake mail drivers
// ---------------------------------------------------------------------------

/** One message in the fake mailbox. */
interface FakeMessage {
	uid: number;
	subject: string;
	from: string;
	fromName: string;
	to: string[];
	date: string;
	seen: boolean;
	size: number;
	text?: string;
	html?: string;
	attachments?: { filename: string }[];
}

/** The envelope-only projection a fetch() yields. */
interface FakeEnvelopeMessage {
	uid: number;
	size: number;
	flags: Set<string>;
	envelope: {
		subject: string;
		date: string;
		from: { name: string; address: string }[];
		to: { address: string }[];
	};
}

const fx = vi.hoisted(() => ({
	messages: new Map<number, FakeMessage>(),
	folders: [] as { path: string; specialUse?: string }[],
	/** When set, ImapFlow.connect() rejects with this message. */
	connectError: null as string | null,
	/** When set, the next flag operation returns false instead of true. */
	flagOpFails: false,
	connectCount: 0,
	closeCount: 0,
	lockedFolders: [] as string[],
	fetchRanges: [] as string[],
	fetchOneCalls: [] as { uid: string; opts: unknown }[],
	searchCalls: [] as { query: unknown; opts: unknown }[],
	flagCalls: [] as { op: string; uid: string; flags?: string[] }[],
	moveCalls: [] as { uid: string; target: string }[],
	deleteCalls: [] as string[],
	lastConnectOpts: null as Record<string, unknown> | null,
	transports: [] as Record<string, unknown>[],
	sentMail: [] as Record<string, unknown>[],
	sendError: null as string | null,
	parsedSources: [] as string[],
}));

function envelopeOf(msg: FakeMessage): FakeEnvelopeMessage {
	return {
		uid: msg.uid,
		size: msg.size,
		flags: new Set(msg.seen ? ["\\Seen"] : []),
		envelope: {
			subject: msg.subject,
			date: msg.date,
			from: [{ name: msg.fromName, address: msg.from }],
			to: msg.to.map((address) => ({ address })),
		},
	};
}

function applyFlag(uid: string, flags: string[], add: boolean): boolean {
	if (fx.flagOpFails) {
		fx.flagOpFails = false;
		return false;
	}
	const msg = fx.messages.get(Number(uid));
	if (!msg) return false;
	if (flags.includes("\\Seen")) msg.seen = add;
	return true;
}

vi.mock("imapflow", () => {
	class FakeImapFlow {
		usable = false;
		mailbox: { exists: number; path: string } | null = null;
		constructor(opts: Record<string, unknown>) {
			fx.lastConnectOpts = opts;
		}
		on(): void {
			/* the plugin only listens for "error"; no fake needs to emit one */
		}
		async connect(): Promise<void> {
			fx.connectCount += 1;
			if (fx.connectError) throw new Error(fx.connectError);
			this.usable = true;
		}
		close(): void {
			this.usable = false;
			fx.closeCount += 1;
		}
		async getMailboxLock(path: string): Promise<{ release(): void }> {
			fx.lockedFolders.push(path);
			this.mailbox = { exists: fx.messages.size, path };
			return { release() {} };
		}
		/** Honour the "<start>:*" range the plugin computes so the limit maths is
		 *  observable, and yield in ascending uid order like the real driver. */
		async *fetch(range: string, query: Record<string, unknown>): AsyncGenerator<FakeEnvelopeMessage> {
			fx.fetchRanges.push(range);
			void query;
			const start = Number(range.split(":")[0]) || 1;
			for (const msg of [...fx.messages.values()].sort((a, b) => a.uid - b.uid)) {
				if (msg.uid >= start) yield envelopeOf(msg);
			}
		}
		async fetchOne(
			uid: string,
			query: Record<string, unknown>,
			opts: { uid?: boolean },
		): Promise<(FakeEnvelopeMessage & { source: Buffer }) | null> {
			void query;
			fx.fetchOneCalls.push({ uid, opts });
			const ordered = [...fx.messages.values()].sort((a, b) => a.uid - b.uid);
			const msg = opts?.uid ? ordered.find((m) => m.uid === Number(uid)) : ordered[Number(uid) - 1];
			if (!msg) return null;
			return {
				...envelopeOf(msg),
				source: Buffer.from(
					JSON.stringify({ text: msg.text ?? "", html: msg.html ?? "", attachments: msg.attachments ?? [] }),
				),
			};
		}
		async search(query: Record<string, unknown>, opts: { uid?: boolean }): Promise<number[]> {
			fx.searchCalls.push({ query, opts });
			if (query.seen !== false) return [];
			return [...fx.messages.values()].filter((m) => !m.seen).map((m) => m.uid);
		}
		async *list(): AsyncGenerator<{ path: string; specialUse?: string }> {
			for (const folder of fx.folders) yield folder;
		}
		async messageFlagsAdd(uid: string, flags: string[]): Promise<boolean> {
			fx.flagCalls.push({ op: "add", uid, flags });
			return applyFlag(uid, flags, true);
		}
		async messageFlagsRemove(uid: string, flags: string[]): Promise<boolean> {
			fx.flagCalls.push({ op: "remove", uid, flags });
			return applyFlag(uid, flags, false);
		}
		async messageMove(uid: string, target: string): Promise<boolean> {
			fx.moveCalls.push({ uid, target });
			const existed = fx.messages.delete(Number(uid));
			return existed;
		}
		async messageDelete(uid: string): Promise<boolean> {
			fx.deleteCalls.push(uid);
			return fx.messages.delete(Number(uid));
		}
	}
	return { ImapFlow: FakeImapFlow };
});

vi.mock("mailparser", () => ({
	simpleParser: async (raw: Buffer) => {
		const text = String(raw);
		fx.parsedSources.push(text);
		return JSON.parse(text) as { text?: string; html?: string; attachments?: unknown[] };
	},
}));

vi.mock("nodemailer", () => ({
	createTransport: (opts: Record<string, unknown>) => {
		fx.transports.push(opts);
		return {
			sendMail: async (message: Record<string, unknown>) => {
				if (fx.sendError) throw new Error(fx.sendError);
				fx.sentMail.push(message);
				return { messageId: "<fake-message-id@example.com>", accepted: [message.to] };
			},
		};
	},
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The manifest's permissions, so the mock host enforces capability gating. */
const PERMISSIONS = ["net:imap/smtp", "tools"];
const IMAP_PASS = "imap-secret-PASSWORD";
const SMTP_PASS = "smtp-secret-PASSWORD";

const dirs: string[] = [];
const started: (() => void)[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "webmail-unit-"));
	dirs.push(dir);
	return dir;
}

/** Seed `count` messages; odd uids are unseen, even uids are already read. */
function seed(count: number): void {
	fx.messages.clear();
	for (let uid = 1; uid <= count; uid += 1) {
		const even = uid % 2 === 0;
		fx.messages.set(uid, {
			uid,
			subject: even ? `Invoice ${uid}` : `Hello ${uid}`,
			from: even ? "billing@example.com" : "alice@example.com",
			fromName: even ? "Billing" : "Alice",
			to: ["me@example.com"],
			date: new Date(Date.UTC(2024, 0, uid, 12, 0, 0)).toISOString(),
			seen: even,
			size: 1000 + uid,
			text: `Body of message ${uid}.`,
		});
	}
}

function resetFx(): void {
	fx.folders = [];
	fx.connectError = null;
	fx.flagOpFails = false;
	fx.connectCount = 0;
	fx.closeCount = 0;
	fx.lockedFolders = [];
	fx.fetchRanges = [];
	fx.fetchOneCalls = [];
	fx.searchCalls = [];
	fx.flagCalls = [];
	fx.moveCalls = [];
	fx.deleteCalls = [];
	fx.lastConnectOpts = null;
	fx.transports = [];
	fx.sentMail = [];
	fx.sendError = null;
	fx.parsedSources = [];
	seed(5);
}

function addMessage(msg: FakeMessage): void {
	fx.messages.set(msg.uid, msg);
}

function fullConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		imap: { host: "imap.example.com", port: 993, tls: true, user: "me@example.com", pass: IMAP_PASS },
		smtp: {
			host: "smtp.example.com",
			port: 465,
			tls: true,
			user: "me@example.com",
			pass: SMTP_PASS,
			from: "Me <me@example.com>",
		},
		pollSec: 60,
		notifyEnabled: true,
		aiEnabled: false,
		...overrides,
	};
}

interface Harness {
	host: MockHost;
	dir: string;
	deactivate: () => void;
}

/** Activate the plugin against a fresh mock host and wait for startup to settle. */
async function start(config?: Record<string, unknown>, dir = tempDir()): Promise<Harness> {
	if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
	const host = createMockHost({ dir, permissions: PERMISSIONS });
	const deactivate = webmailServer.activate(host);
	started.push(deactivate);
	await vi.waitFor(() => expect(host.recorded.broadcasts.length).toBeGreaterThan(0));
	return { host, dir, deactivate };
}

/** Let the plugin's unawaited message work finish (it dispatches, then returns). */
async function settle(rounds = 25): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function send(host: MockHost, message: Record<string, unknown>, from?: string): Promise<void> {
	await host.emit.message(message, from);
	await settle();
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Every payload the plugin pushed to clients, broadcast or targeted. */
function payloads(host: MockHost): Record<string, unknown>[] {
	return [...host.recorded.broadcasts.map(asRecord), ...host.recorded.sent.map((entry) => asRecord(entry.payload))];
}

function statePayloads(host: MockHost): PublicState[] {
	return payloads(host)
		.filter((payload) => payload.kind === "state")
		.map((payload) => payload.state as PublicState);
}

/** The most recent state the plugin reported. Throws if it never reported one. */
function lastState(host: MockHost): PublicState {
	const states = statePayloads(host);
	if (states.length === 0) throw new Error("the plugin never reported a state payload");
	return states[states.length - 1]!;
}

function mailsOf(host: MockHost): MailSummary[] | undefined {
	const found = payloads(host)
		.filter((payload) => payload.kind === "mails")
		.map((payload) => payload.mails as MailSummary[]);
	return found.length === 0 ? undefined : found[found.length - 1];
}

function mailOf(host: MockHost): Record<string, unknown> | undefined {
	const found = payloads(host).filter((payload) => payload.kind === "mail");
	return found.length === 0 ? undefined : asRecord(found[found.length - 1]!.mail);
}

function resultsOf(host: MockHost): Record<string, unknown>[] {
	return payloads(host).filter((payload) => payload.kind === "result");
}

function notificationsOf(host: MockHost): string[] {
	return host.recorded.notifications.map((entry) => entry.text);
}

/** Files this unit owns: the committed plugin tree plus its own tests. Generated
 *  artifacts are scanned by webmail-build.test.ts right after a real build. */
function ownedFiles(): string[] {
	const found: string[] = [];
	const generated = new Set(["index.mjs", "entry.mjs"]);
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "vendor" || entry.name === "node_modules") continue;
				walk(full);
			} else if (!generated.has(entry.name)) {
				found.push(full);
			}
		}
	};
	walk(repoPath("plugins", "webmail"));
	const unitDir = repoPath("tests", "unit");
	for (const name of readdirSync(unitDir)) {
		if (name.startsWith("webmail") && name.endsWith(".test.ts")) found.push(join(unitDir, name));
	}
	return found.sort();
}

beforeEach(() => {
	resetFx();
});

afterEach(() => {
	vi.useRealTimers();
	while (started.length > 0) started.pop()!();
});

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// English-only invariant
// ---------------------------------------------------------------------------

describe("webmail English-only invariant", () => {
	it("has no CJK character in any file this unit owns", () => {
		const files = ownedFiles();
		// Guard against a silently empty scan, which would make the rest vacuous.
		expect(files.length).toBeGreaterThanOrEqual(7);
		expect(files.some((file) => file.endsWith("src/index.ts"))).toBe(true);
		expect(files.some((file) => file.endsWith("src/client.ts"))).toBe(true);
		expect(files.some((file) => file.endsWith("manifest.json"))).toBe(true);
		const offending = files.flatMap((file) => formatCjkHits(file, findCjk(file)));
		expect(offending, `CJK found:\n${offending.join("\n")}`).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("webmail manifest", () => {
	const raw = JSON.parse(readFileSync(repoPath("plugins/webmail/manifest.json"), "utf8")) as Record<string, unknown>;

	it("is English and keeps the upstream version and permission families", () => {
		expect(raw.name).toBe("Webmail");
		expect(raw.version).toBe("0.2.0");
		expect(raw.permissions).toEqual(["net:imap/smtp", "tools"]);
		const description = String(raw.description);
		expect(description.length).toBeGreaterThan(20);
		expect(description).toMatch(/IMAP/);
		expect(description).toMatch(/SMTP/);
	});

	it("carries neither a descriptionEn key nor an id", () => {
		expect(raw.descriptionEn).toBeUndefined();
		expect(raw.id).toBeUndefined();
		expect(Object.keys(raw).sort()).toEqual(["description", "name", "permissions", "version"]);
	});
});

// ---------------------------------------------------------------------------
// Exported pure helpers
// ---------------------------------------------------------------------------

describe("summarize()", () => {
	const envelope = {
		from: [{ name: "Alice", address: "alice@example.com" }],
		to: [{ address: "me@example.com" }, { address: "other@example.com" }],
		subject: "Quarterly report",
		date: "2024-03-04T05:06:07.000Z",
	};

	it("flattens an envelope into the wire shape the view renders", () => {
		expect(summarize({ uid: 42, envelope, flags: new Set(["\\Seen"]), size: 900 })).toEqual({
			uid: 42,
			from: "alice@example.com",
			fromName: "Alice",
			to: "me@example.com, other@example.com",
			subject: "Quarterly report",
			date: "2024-03-04T05:06:07.000Z",
			seen: true,
			size: 900,
		});
	});

	it("survives a message with no envelope, no flags and no size", () => {
		expect(summarize({ uid: 7 })).toEqual({
			uid: 7,
			from: "",
			fromName: "",
			to: "",
			subject: "(no subject)",
			date: "",
			seen: false,
			size: 0,
		});
	});

	it("treats an empty subject as missing but keeps a falsy-looking real one", () => {
		expect(summarize({ uid: 1, envelope: { subject: "" } }).subject).toBe("(no subject)");
		expect(summarize({ uid: 1, envelope: { subject: "0" } }).subject).toBe("0");
	});

	it("reports unseen when only other flags are set", () => {
		expect(summarize({ uid: 1, flags: new Set(["\\Flagged", "\\Draft"]) }).seen).toBe(false);
		expect(summarize({ uid: 1, flags: new Set(["\\Seen"]) }).seen).toBe(true);
	});

	it("keeps a senderless envelope addressable", () => {
		expect(summarize({ uid: 1, envelope: { from: [] } }).from).toBe("");
		expect(summarize({ uid: 1, envelope: { from: [{ address: "a@b.c" }] } }).fromName).toBe("");
	});
});

describe("loadConfig()", () => {
	it("returns the defaults when config.json does not exist", async () => {
		await expect(loadConfig(tempDir())).resolves.toEqual(DEFAULT_CONFIG);
	});

	it("returns the defaults when config.json is not parseable", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), "{ this is not json", "utf8");
		await expect(loadConfig(dir)).resolves.toEqual(DEFAULT_CONFIG);
	});

	it("merges partial sections over the defaults without mutating them", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), JSON.stringify({ imap: { host: "h", user: "u" }, pollSec: 30 }), "utf8");
		const loaded = await loadConfig(dir);
		expect(loaded.imap).toEqual({ host: "h", port: 993, tls: true, user: "u", pass: "" });
		expect(loaded.pollSec).toBe(30);
		expect(loaded.smtp).toEqual(DEFAULT_CONFIG.smtp);
		expect(DEFAULT_CONFIG.imap.host).toBe("");
		expect(DEFAULT_CONFIG.pollSec).toBe(60);
	});

	it("keeps an unrelated top-level key the user added to the file", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), JSON.stringify({ aiEnabled: true }), "utf8");
		expect((await loadConfig(dir)).aiEnabled).toBe(true);
	});
});

describe("client helpers", () => {
	it("escapes every character that could break out of an attribute or element", () => {
		expect(esc(`<img src=x onerror="alert('1')">&`)).toBe(
			"&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
		);
	});

	it("renders null, undefined and empty values as an empty string but keeps 0", () => {
		expect(esc(null)).toBe("");
		expect(esc(undefined)).toBe("");
		expect(esc("")).toBe("");
		expect(esc(0)).toBe("0");
		expect(esc(false)).toBe("false");
	});

	it("formats today's messages as a time and older ones with a month and day", () => {
		expect(fmtDate("")).toBe("");
		expect(fmtDate("not-a-date")).toBe("Invalid Date");
		const now = new Date();
		expect(fmtDate(now.toISOString())).toBe(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
		const old = new Date(Date.UTC(2001, 1, 3, 4, 5, 6));
		expect(fmtDate(old.toISOString())).toBe(
			old.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
		);
	});

	it("exports the mount-only shape the frontend loader requires", () => {
		expect(Object.keys(webmailClient)).toEqual(["mount"]);
		expect(webmailClient.mount.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Activation and lifecycle
// ---------------------------------------------------------------------------

describe("activate()", () => {
	it("reports an unconfigured plugin and registers no poller or AI tool", async () => {
		const { host } = await start();
		const state = lastState(host);
		expect(state.configured).toBe(false);
		expect(state.status).toBe(STATUS_UNCONFIGURED);
		expect(state.depsOk).toBe(true);
		expect(state.aiEnabled).toBe(false);
		expect(state.notifyEnabled).toBe(false);
		expect(host.backgroundTask("mail-poll")).toBeUndefined();
		expect(host.recorded.agentTools.size).toBe(0);
		expect(host.recorded.handlers.message.size).toBe(1);
		expect(host.recorded.handlers.attach.size).toBe(1);
		expect(host.recorded.rejections).toEqual([]);
	});

	it("registers the polling background task once an account is configured", async () => {
		const { host } = await start(fullConfig());
		const task = host.backgroundTask("mail-poll");
		expect(task, "no mail-poll background task was registered").toBeDefined();
		expect(task!.label).toMatch(/mail/i);
		expect(task!.status).toMatch(/60/);
		expect(lastState(host).configured).toBe(true);
		expect(lastState(host).notifyEnabled).toBe(true);
		// The first poll connects asynchronously, so the status settles after startup.
		await vi.waitFor(() => expect(lastState(host).status).toBe(STATUS_CONNECTED));
	});

	it("pushes the full state to each client that attaches", async () => {
		const { host } = await start(fullConfig());
		const sentBefore = host.recorded.sent.length;
		await expect(host.emit.attach("client-42")).resolves.toBe(1);
		const targeted = host.recorded.sent.slice(sentBefore);
		expect(targeted).toHaveLength(1);
		expect(targeted[0]!.clientId).toBe("client-42");
		expect(asRecord(targeted[0]!.payload).kind).toBe("state");
	});

	it("connects IMAP with the configured credentials and drops the client on deactivate", async () => {
		const { host, deactivate } = await start(fullConfig());
		await vi.waitFor(() => expect(fx.connectCount).toBeGreaterThan(0));
		expect(fx.lastConnectOpts).toMatchObject({
			host: "imap.example.com",
			port: 993,
			secure: true,
			auth: { user: "me@example.com", pass: IMAP_PASS },
		});
		const closedBefore = fx.closeCount;
		deactivate();
		expect(fx.closeCount).toBe(closedBefore + 1);
		expect(host.recorded.handlers.message.size).toBe(0);
		expect(host.recorded.handlers.attach.size).toBe(0);
		expect(host.backgroundTask("mail-poll")).toBeUndefined();
	});

	it("stops polling when the background panel asks it to", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { host } = await start(fullConfig());
		await vi.waitFor(() => expect(host.backgroundTask("mail-poll")).toBeDefined());
		await settle();
		const searchesBefore = fx.searchCalls.length;
		host.backgroundTask("mail-poll")!.stop!();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(fx.searchCalls.length).toBe(searchesBefore);
	});

	it("surfaces a list failure in the state instead of throwing", async () => {
		fx.connectError = "connect EHOSTUNREACH 10.0.0.1:993";
		const { host } = await start(fullConfig());
		await send(host, { action: "list", folder: "INBOX" });
		expect(lastState(host).status).toBe("connect EHOSTUNREACH 10.0.0.1:993");
		expect(mailsOf(host)).toBeUndefined();
	});

	it("records a poller authentication failure with the failed-status prefix", async () => {
		fx.connectError = "Authentication failed";
		const { host } = await start(fullConfig());
		await vi.waitFor(() => expect(lastState(host).status).toBe(`${STATUS_FAILED_PREFIX}: Authentication failed`));
		expect(host.backgroundTask("mail-poll")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// AI tools
// ---------------------------------------------------------------------------

describe("AI mail tools", () => {
	it("registers all six tools with their upstream names when aiEnabled is on", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.recorded.agentTools.size).toBe(6));
		expect([...host.recorded.agentTools.keys()].sort()).toEqual([
			"mail_folders",
			"mail_list",
			"mail_manage",
			"mail_read",
			"mail_search",
			"mail_send",
		]);
		for (const tool of host.recorded.agentTools.values()) {
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.execute).toBeTypeOf("function");
		}
		expect(host.recorded.rejections).toEqual([]);
	});

	it("registers nothing while aiEnabled is off and follows the toggle both ways", async () => {
		const { host } = await start(fullConfig({ aiEnabled: false }));
		await settle();
		expect(host.recorded.agentTools.size).toBe(0);

		await send(host, { action: "save_config", config: fullConfig({ aiEnabled: true }) });
		await vi.waitFor(() => expect(host.recorded.agentTools.size).toBe(6));

		await send(host, { action: "save_config", config: fullConfig({ aiEnabled: false }) });
		await vi.waitFor(() => expect(host.recorded.agentTools.size).toBe(0));
	});

	it("keeps the mail_manage action enum and the unseen_only parameter name", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_manage")).toBeDefined());
		const manage = host.agentTool("mail_manage")!.parameters as {
			properties: { action: { enum: string[] } };
			required: string[];
		};
		expect(manage.properties.action.enum).toEqual(["seen", "unseen", "delete"]);
		expect(manage.required).toEqual(["action", "uids"]);
		const list = host.agentTool("mail_list")!.parameters as { properties: Record<string, unknown> };
		expect(Object.keys(list.properties).sort()).toEqual(["folder", "limit", "unseen_only"]);
		const send = host.agentTool("mail_send")!;
		expect((send.parameters as { required: string[] }).required).toEqual(["to", "body"]);
		expect(send.promptGuidelines).toHaveLength(1);
	});

	it("mail_list renders one line per message, newest first", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_list")).toBeDefined());
		const tool = host.agentTool("mail_list")!;

		const lines = String(await tool.execute("call-1", { folder: "INBOX", limit: 3 })).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("#5 [unread] 2024-01-05 12:00 Alice \u2014 Hello 5");
		expect(lines[1]).toBe("#4 2024-01-04 12:00 Billing \u2014 Invoice 4");

		const unread = String(await tool.execute("call-2", { unseen_only: true, limit: 10 })).split("\n");
		expect(unread).toHaveLength(3);
		expect(unread.every((line) => line.includes("[unread]"))).toBe(true);
	});

	it("mail_list says so when the mailbox is empty", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_list")).toBeDefined());
		fx.messages.clear();
		const empty = String(await host.agentTool("mail_list")!.execute("call-2", { folder: "INBOX" }));
		expect(empty).toMatch(/empty/i);
	});

	it("mail_read returns the body and rejects without a uid", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_read")).toBeDefined());
		const tool = host.agentTool("mail_read")!;
		const out = String(await tool.execute("call-1", { uid: 1 }));
		expect(out).toContain("Subject: Hello 1");
		expect(out).toContain("From: Alice <alice@example.com>");
		expect(out).toContain("Date: ");
		expect(out).toContain("Body of message 1.");
		expect(out).not.toContain("(has attachments)");
		await expect(tool.execute("call-2", {})).rejects.toThrow(/uid/);
	});

	it("mail_search reports a hit and echoes the query back on a miss", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_search")).toBeDefined());
		const tool = host.agentTool("mail_search")!;
		const hit = String(await tool.execute("call-1", { query: "invoice" })).split("\n");
		expect(hit).toHaveLength(2);
		expect(hit[0]).toContain("Billing");
		const miss = String(await tool.execute("call-2", { query: "zzzz" }));
		expect(miss).toContain("zzzz");
		expect(miss).toMatch(/no messages/i);
	});

	it("mail_send confirms the recipient and mail_manage reports its counts", async () => {
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_send")).toBeDefined());
		const sent = String(await host.agentTool("mail_send")!.execute("call-1", { to: "you@example.com", body: "hi" }));
		expect(sent).toContain("you@example.com");
		expect(fx.sentMail).toHaveLength(1);

		const marked = String(await host.agentTool("mail_manage")!.execute("call-2", { action: "seen", uids: [1, 3] }));
		expect(marked).toContain("2");
		const deleted = String(await host.agentTool("mail_manage")!.execute("call-3", { action: "delete", uids: [5] }));
		expect(deleted).toContain("1");
		expect(fx.messages.has(5)).toBe(false);
	});

	it("mail_folders lists every path with its special use", async () => {
		fx.folders = [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "Archive" }];
		const { host } = await start(fullConfig({ aiEnabled: true }));
		await vi.waitFor(() => expect(host.agentTool("mail_folders")).toBeDefined());
		const out = String(await host.agentTool("mail_folders")!.execute("call-1", {}));
		expect(out.split("\n")).toEqual(["INBOX (\\Inbox)", "Archive"]);
	});
});

// ---------------------------------------------------------------------------
// View message protocol
// ---------------------------------------------------------------------------

describe("view message protocol", () => {
	it("answers get_state with a targeted reply when a client id is present", async () => {
		const { host } = await start(fullConfig());
		const sentBefore = host.recorded.sent.length;
		const broadcastsBefore = host.recorded.broadcasts.length;
		await send(host, { action: "get_state" }, "client-7");
		expect(host.recorded.sent.length).toBe(sentBefore + 1);
		expect(host.recorded.sent[sentBefore]!.clientId).toBe("client-7");
		expect(host.recorded.broadcasts.length).toBe(broadcastsBefore);
	});

	it("broadcasts get_state when no client id is present", async () => {
		const { host } = await start(fullConfig());
		const broadcastsBefore = host.recorded.broadcasts.length;
		await send(host, { action: "get_state" });
		expect(host.recorded.broadcasts.length).toBe(broadcastsBefore + 1);
		expect(asRecord(host.recorded.broadcasts[broadcastsBefore]).kind).toBe("state");
	});

	it("lists the newest messages first, honouring the limit window", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "list", folder: "INBOX", limit: 2 });
		const mails = mailsOf(host);
		expect(mails, "no mails payload was broadcast").toBeDefined();
		expect(mails!.map((mail) => mail.uid)).toEqual([5, 4]);
		expect(fx.fetchRanges).toContain("4:*");
		expect(fx.lockedFolders).toContain("INBOX");
		expect(mails![0]).toMatchObject({ subject: "Hello 5", seen: false, fromName: "Alice", size: 1005 });
		expect(mails![1]).toMatchObject({ subject: "Invoice 4", seen: true, to: "me@example.com" });
	});

	it("defaults to INBOX when the view names no folder", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "list" });
		expect(fx.lockedFolders).toContain("INBOX");
		expect(mailsOf(host)).toHaveLength(5);
	});

	it("filters to unseen only and returns nothing for an empty mailbox", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "list", folder: "INBOX", unseenOnly: true });
		expect(mailsOf(host)!.map((mail) => mail.uid)).toEqual([5, 3, 1]);

		fx.messages.clear();
		fx.fetchRanges.length = 0;
		await send(host, { action: "list", folder: "INBOX" });
		expect(mailsOf(host)).toEqual([]);
		expect(fx.fetchRanges).toEqual([]);
	});

	it("searches subject, sender and recipient case-insensitively", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "search", query: "  BILLING@EXAMPLE.COM " });
		expect(mailsOf(host)!.map((mail) => mail.uid)).toEqual([4, 2]);
	});

	it("returns no results for a blank search instead of the whole mailbox", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "search", query: "   " });
		expect(mailsOf(host)).toEqual([]);
	});

	it("reads a message by uid, never by sequence number", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "read", folder: "INBOX", uid: 3 });
		const mail = mailOf(host);
		expect(mail, "no mail payload was broadcast").toBeDefined();
		expect(mail!.uid).toBe(3);
		expect(mail!.text).toBe("Body of message 3.");
		expect(mail!.truncated).toBe(false);
		expect(mail!.hasAttachments).toBe(false);
		expect(fx.fetchOneCalls.at(-1)).toEqual({ uid: "3", opts: { uid: true } });
	});

	it("finds a uid that is larger than the message count", async () => {
		// The regression the upstream comment warns about: without {uid:true} the
		// driver would treat 9 as a sequence number and report "not found".
		fx.messages.clear();
		addMessage({
			uid: 9,
			subject: "Only",
			from: "a@b.c",
			fromName: "",
			to: [],
			date: new Date(Date.UTC(2024, 0, 9)).toISOString(),
			seen: false,
			size: 1,
			text: "solo",
		});
		const { host } = await start(fullConfig());
		await send(host, { action: "read", uid: 9 });
		expect(mailOf(host)!.text).toBe("solo");
	});

	it("strips markup from an HTML-only message", async () => {
		fx.messages.get(1)!.text = "";
		fx.messages.get(1)!.html = "<style>p{color:red}</style><script>alert(1)</script><div>First</div><div>Second</div>";
		const { host } = await start(fullConfig());
		await send(host, { action: "read", uid: 1 });
		expect(mailOf(host)!.text).toBe("First Second");
	});

	it("truncates a body longer than the limit and flags attachments", async () => {
		fx.messages.get(1)!.text = "x".repeat(BODY_LIMIT + 500);
		fx.messages.get(1)!.attachments = [{ filename: "report.pdf" }];
		const { host } = await start(fullConfig());
		await send(host, { action: "read", uid: 1 });
		const mail = mailOf(host)!;
		expect(String(mail.text)).toHaveLength(BODY_LIMIT);
		expect(mail.truncated).toBe(true);
		expect(mail.hasAttachments).toBe(true);
	});

	it("notifies instead of broadcasting when a read targets a missing uid", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "read", uid: 9999 });
		expect(mailOf(host)).toBeUndefined();
		expect(notificationsOf(host).some((text) => /read failed/i.test(text) && text.includes("9999"))).toBe(true);
	});

	it("notifies when a read is requested without a uid", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "read", folder: "INBOX" });
		expect(mailOf(host)).toBeUndefined();
		expect(notificationsOf(host).some((text) => /read failed/i.test(text))).toBe(true);
	});

	it("marks messages read and unseen and counts only the ones the server accepted", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "mark", uids: [1, 3], seen: true });
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "mark", changed: 2 });
		expect(fx.messages.get(1)!.seen).toBe(true);
		expect(fx.messages.get(3)!.seen).toBe(true);

		// uid 999 does not exist, so the driver reports false and it is not counted.
		await send(host, { action: "mark", uids: [1, 999], seen: false });
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "mark", changed: 1 });
		expect(fx.messages.get(1)!.seen).toBe(false);
	});

	it("counts a rejected flag write as unchanged", async () => {
		const { host } = await start(fullConfig());
		fx.flagOpFails = true;
		await send(host, { action: "mark", uids: [4], seen: false });
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "mark", changed: 0 });
		expect(fx.messages.get(4)!.seen).toBe(true);
	});

	it("accepts a single uid that is not wrapped in an array", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "mark", uids: 1, seen: true });
		expect(resultsOf(host).at(-1)).toMatchObject({ changed: 1 });
		expect(fx.flagCalls.at(-1)).toMatchObject({ op: "add", uid: "1", flags: ["\\Seen"] });
	});

	it("short-circuits an empty uid list without touching the server", async () => {
		const { host } = await start(fullConfig());
		const callsBefore = fx.flagCalls.length;
		await send(host, { action: "mark", uids: [] });
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "mark", changed: 0 });
		expect(fx.flagCalls.length).toBe(callsBefore);
	});

	it("moves deleted mail to the trash folder when the server has one", async () => {
		fx.folders = [{ path: "INBOX" }, { path: "Trash", specialUse: "\\Trash" }];
		const { host } = await start(fullConfig());
		await send(host, { action: "delete", uids: [1, 2] });
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "delete", deleted: 2, trash: "Trash" });
		expect(fx.moveCalls).toEqual([
			{ uid: "1", target: "Trash" },
			{ uid: "2", target: "Trash" },
		]);
		expect(fx.deleteCalls).toEqual([]);
	});

	it("recognises a localised trash folder name that carries no special-use flag", async () => {
		// Providers for the Chinese market name this folder with these characters.
		// The plugin matches the escape sequence, so this source stays ASCII-only.
		const localised = "\u5df2\u5220\u9664";
		fx.folders = [{ path: "INBOX" }, { path: localised }];
		const { host } = await start(fullConfig());
		await send(host, { action: "delete", uids: [1] });
		expect(fx.moveCalls).toEqual([{ uid: "1", target: localised }]);
		expect(fx.deleteCalls).toEqual([]);
	});

	it("hard-deletes when the mailbox exposes no trash folder", async () => {
		fx.folders = [{ path: "INBOX" }, { path: "Archive" }];
		const { host } = await start(fullConfig());
		await send(host, { action: "delete", uids: [1] });
		expect(resultsOf(host).at(-1)).toMatchObject({ deleted: 1, trash: null });
		expect(fx.deleteCalls).toEqual(["1"]);
		expect(fx.moveCalls).toEqual([]);
	});

	it("sends mail through SMTP and confirms to the view", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "send", to: "you@example.com", cc: "boss@example.com", subject: "Hi", body: "There" });
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "send" });
		expect(notificationsOf(host).some((text) => text.includes("you@example.com"))).toBe(true);
		expect(fx.transports.at(-1)).toMatchObject({
			host: "smtp.example.com",
			port: 465,
			secure: true,
			auth: { user: "me@example.com", pass: SMTP_PASS },
		});
		expect(fx.sentMail.at(-1)).toMatchObject({
			from: "Me <me@example.com>",
			to: "you@example.com",
			cc: "boss@example.com",
			subject: "Hi",
			text: "There",
		});
	});

	it("omits cc when the view sends none", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "send", to: "you@example.com", body: "There" });
		expect(fx.sentMail.at(-1)).toMatchObject({ cc: undefined });
	});

	it("reports an SMTP failure as an error notification and sends no result", async () => {
		fx.sendError = "535 Authentication failed";
		const { host } = await start(fullConfig());
		await send(host, { action: "send", to: "you@example.com", body: "There" });
		expect(resultsOf(host)).toEqual([]);
		expect(notificationsOf(host).some((text) => /send failed/i.test(text) && text.includes("535"))).toBe(true);
		expect(host.recorded.notifications.at(-1)!.level).toBe("error");
	});

	it("refuses to send when no SMTP account is configured", async () => {
		const { host } = await start({ imap: { host: "imap.example.com", user: "me@example.com" } });
		await send(host, { action: "send", to: "you@example.com", body: "There" });
		expect(fx.sentMail).toEqual([]);
		expect(notificationsOf(host).some((text) => /send failed/i.test(text) && /SMTP/i.test(text))).toBe(true);
	});

	it("logs an unknown action without throwing or pushing anything", async () => {
		const { host } = await start(fullConfig());
		const before = payloads(host).length;
		await send(host, { action: "not-a-real-action" });
		expect(payloads(host).length).toBe(before);
		expect(host.recorded.logs.some((entry) => entry.includes("not-a-real-action"))).toBe(true);
	});

	it("tolerates a null payload", async () => {
		const { host } = await start(fullConfig());
		await expect(host.emit.message(null)).resolves.toBe(1);
		expect(host.recorded.logs.some((entry) => entry.includes("unknown action"))).toBe(true);
	});

	it("saves a new configuration, replies to the sender and restarts the poller", async () => {
		const { host, dir } = await start();
		await send(host, { action: "save_config", config: fullConfig({ pollSec: 90 }) }, "client-3");
		expect(resultsOf(host).at(-1)).toMatchObject({ ok: true, action: "save_config" });
		expect(host.recorded.sent.some((entry) => entry.clientId === "client-3")).toBe(true);
		expect(notificationsOf(host).some((text) => /saved/i.test(text))).toBe(true);
		expect(lastState(host).configured).toBe(true);
		expect(host.backgroundTask("mail-poll")!.status).toMatch(/90/);
		const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as WebmailConfig;
		expect(stored.pollSec).toBe(90);
		expect(stored.imap.host).toBe("imap.example.com");
	});

	it("clamps a poll interval below the minimum", async () => {
		const { host } = await start(fullConfig({ pollSec: 1 }));
		expect(host.backgroundTask("mail-poll")!.status).toMatch(/15/);
	});

	it("reports a config it cannot persist back to the sender as a failure", async () => {
		// host.dir does not exist, so writing config.json rejects with ENOENT.
		const { host } = await start(undefined, join(tempDir(), "missing-subdir"));
		await send(host, { action: "save_config", config: fullConfig() }, "client-3");
		const result = resultsOf(host).at(-1);
		expect(result).toMatchObject({ ok: false, action: "save_config" });
		expect(String(result!.error).length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// New-mail notifications
// ---------------------------------------------------------------------------

describe("new-mail polling", () => {
	it("does not notify on the first poll, then announces messages that appear", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		seed(0);
		addMessage({
			uid: 1,
			subject: "First",
			from: "alice@example.com",
			fromName: "Alice",
			to: ["me@example.com"],
			date: new Date(Date.UTC(2024, 0, 1, 9)).toISOString(),
			seen: false,
			size: 10,
			text: "one",
		});
		const { host } = await start(fullConfig({ pollSec: 15 }));
		await vi.waitFor(() => expect(lastState(host).unseen).toBe(1));
		expect(notificationsOf(host).filter((text) => /new message/i.test(text))).toEqual([]);
		expect(payloads(host).some((payload) => payload.kind === "new-mail")).toBe(false);

		addMessage({
			uid: 2,
			subject: "Second",
			from: "bob@example.com",
			fromName: "Bob",
			to: ["me@example.com"],
			date: new Date(Date.UTC(2024, 0, 2, 9)).toISOString(),
			seen: false,
			size: 10,
			text: "two",
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.waitFor(() => expect(payloads(host).some((payload) => payload.kind === "new-mail")));

		const push = payloads(host).find((payload) => payload.kind === "new-mail")!;
		expect(push).toMatchObject({ count: 1, unseen: 2, subjects: ["Bob: Second"] });
		expect(notificationsOf(host).some((text) => text.includes("1 new message") && text.includes("Bob: Second"))).toBe(
			true,
		);
	});

	it("does not re-announce mail it has already reported", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		seed(0);
		addMessage({
			uid: 1,
			subject: "First",
			from: "alice@example.com",
			fromName: "Alice",
			to: [],
			date: new Date(Date.UTC(2024, 0, 1, 9)).toISOString(),
			seen: false,
			size: 10,
			text: "one",
		});
		const { host } = await start(fullConfig({ pollSec: 15 }));
		await vi.waitFor(() => expect(lastState(host).unseen).toBe(1));

		addMessage({
			uid: 2,
			subject: "Second",
			from: "bob@example.com",
			fromName: "",
			to: [],
			date: new Date(Date.UTC(2024, 0, 2, 9)).toISOString(),
			seen: false,
			size: 10,
			text: "two",
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.waitFor(() => expect(payloads(host).filter((payload) => payload.kind === "new-mail")).toHaveLength(1));
		// The subject line falls back to the bare address when there is no display name.
		expect(payloads(host).find((payload) => payload.kind === "new-mail")!.subjects).toEqual([
			"bob@example.com: Second",
		]);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(payloads(host).filter((payload) => payload.kind === "new-mail")).toHaveLength(1);
		expect(notificationsOf(host).filter((text) => /new message/i.test(text))).toHaveLength(1);
	});

	it("stays silent about the toast when notifyEnabled is off but still pushes to the view", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { host } = await start(fullConfig({ pollSec: 15, notifyEnabled: false }));
		await vi.waitFor(() => expect(fx.searchCalls.length).toBeGreaterThan(0));
		addMessage({
			uid: 9,
			subject: "Quiet",
			from: "x@example.com",
			fromName: "",
			to: [],
			date: new Date(Date.UTC(2024, 5, 1)).toISOString(),
			seen: false,
			size: 1,
			text: "q",
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.waitFor(() => expect(payloads(host).some((payload) => payload.kind === "new-mail")));
		expect(notificationsOf(host).filter((text) => /new message/i.test(text))).toEqual([]);
		expect(lastState(host).unseen).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("credential redaction", () => {
	it("never puts a password in anything pushed to a client", async () => {
		const { host } = await start(fullConfig());
		await send(host, { action: "list" }, "client-1");
		await send(host, { action: "get_state" }, "client-1");
		const wire = JSON.stringify([...host.recorded.broadcasts, ...host.recorded.sent]);
		expect(wire).not.toContain(IMAP_PASS);
		expect(wire).not.toContain(SMTP_PASS);
		const state = lastState(host);
		expect(Object.keys(state.config.imap).sort()).toEqual(["hasPass", "host", "port", "tls", "user"]);
		expect(Object.keys(state.config.smtp).sort()).toEqual(["from", "hasPass", "host", "port", "tls", "user"]);
		expect(state.config.imap.hasPass).toBe(true);
		expect(state.config.smtp.hasPass).toBe(true);
	});
});

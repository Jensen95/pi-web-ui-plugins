/**
 * webmail server entry - a working IMAP/SMTP mail management plugin.
 *
 * Capabilities:
 *  - Receive: IMAP (imapflow) list / search / read / mark / delete messages
 *  - Send: SMTP (nodemailer)
 *  - New-mail notifications: periodically poll INBOX for unseen messages and,
 *    when something new turns up, host.notify plus a push to the plugin view
 *  - AI tools: when config.aiEnabled is on, host.registerAgentTool registers
 *    mail_list / mail_read / mail_search / mail_send / mail_manage / mail_folders;
 *    turning it off unregisters them, so "let the AI manage mail" can be switched
 *    on and off at any time.
 *
 * Passwords go to the host's encrypted secret store (host.secrets); the
 * non-sensitive settings live in <dataDir>/plugins/webmail/config.json, and a
 * password only ends up in that file when the secret store is unavailable. The
 * imapflow / mailparser / nodemailer dependencies are not bundled: the first
 * activation tries to npm install them automatically, and on failure the view
 * shows an "Install dependencies" button to trigger it by hand.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { STATUS_CONNECTED, STATUS_UNCONFIGURED, failedStatus } from "./protocol";

// ---------------------------------------------------------------------------
// Host contract (the slice of pi-web-ui's PluginHost this plugin uses)
// ---------------------------------------------------------------------------

/** Notice level. The host documents info/warning/error; this plugin also sends
 *  "success" for a finished dependency install, which the browser renders with
 *  its default notice style. */
type NoticeLevel = "info" | "warning" | "error" | "success";

/** A tool exposed to the AI, shaped like the host's PluginAgentTool. */
export interface AgentTool {
	name: string;
	label?: string;
	description: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** Handle returned by host.registerBackgroundTask. */
export interface BackgroundTaskHandle {
	update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
	unregister(): void;
}

/** The encrypted secret store. Optional, and its members optional, because a
 *  host build without one must still work (see loadConfigSecure). */
export interface SecretStore {
	set?(name: string, value: string): void;
	get?(name: string): string | undefined;
}

/** The part of the pi-web-ui plugin host this plugin touches. */
export interface WebmailHost {
	dir: string;
	broadcast(payload: unknown): void;
	notify(level: NoticeLevel, text: string): void;
	sendTo(clientId: string, payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	/** Absent on older host builds; the view's own get_state pull is the fallback. */
	onAttach?(handler: (clientId: string) => void): () => void;
	registerAgentTool(tool: AgentTool): () => void;
	registerBackgroundTask?(task: {
		id: string;
		label: string;
		status?: string;
		stop?: () => void;
	}): BackgroundTaskHandle;
	secrets?: SecretStore;
	log(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Mail driver shapes
// ---------------------------------------------------------------------------

/** One address inside an IMAP envelope. */
export interface MailAddress {
	name?: string;
	address?: string;
}

/** The envelope subset summarize() reads. */
export interface MailEnvelope {
	from?: MailAddress[];
	to?: MailAddress[];
	subject?: string;
	date?: string | Date;
}

/** A message as fetched from the server. */
export interface FetchedMessage {
	uid: number;
	envelope?: MailEnvelope;
	flags?: Set<string>;
	size?: number;
	/** Raw RFC822 source, only requested by readMail. */
	source?: Buffer;
}

/** A folder as reported by ImapFlow's list(). */
export interface ImapFolder {
	path: string;
	specialUse?: string;
}

/** The ImapFlow client methods this plugin calls. The driver is loaded at
 *  runtime after auto-install, so this interface is the whole typed surface. */
export interface ImapClient {
	usable?: boolean;
	mailbox?: { exists?: number } | null;
	connect(): Promise<void>;
	close(): void;
	on(event: "error", handler: (error: { message?: string }) => void): void;
	getMailboxLock(path: string): Promise<{ release(): void }>;
	fetch(range: string, query: Record<string, unknown>): AsyncIterable<FetchedMessage>;
	fetchOne(uid: string, query: Record<string, unknown>, options: { uid: boolean }): Promise<FetchedMessage | null>;
	search(query: Record<string, unknown>, options: { uid: boolean }): Promise<number[] | null>;
	list(): AsyncIterable<ImapFolder>;
	messageFlagsAdd(uid: string, flags: string[], options: { uid: boolean }): Promise<boolean>;
	messageFlagsRemove(uid: string, flags: string[], options: { uid: boolean }): Promise<boolean>;
	messageMove(uid: string, target: string, options: { uid: boolean }): Promise<boolean>;
	messageDelete(uid: string, options: { uid: boolean }): Promise<boolean>;
}

export interface ImapFlowModule {
	ImapFlow: new (options: Record<string, unknown>) => ImapClient;
}

/** The mailparser result subset readMail reads. */
export interface ParsedMail {
	text?: string;
	html?: string;
	attachments?: unknown[];
}

export interface MailParserModule {
	simpleParser(raw: Buffer): Promise<ParsedMail>;
}

/** What nodemailer resolves after sending. */
export interface SendInfo {
	messageId?: string;
	accepted?: unknown[];
}

export interface NodemailerModule {
	createTransport(options: Record<string, unknown>): {
		sendMail(message: Record<string, unknown>): Promise<SendInfo>;
	};
}

interface MailDeps {
	imapflow: ImapFlowModule | null;
	mailparser: MailParserModule | null;
	nodemailer: NodemailerModule | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ImapConfig {
	host: string;
	port: number;
	tls: boolean;
	user: string;
	pass: string;
}

export interface SmtpConfig {
	host: string;
	port: number;
	tls: boolean;
	user: string;
	pass: string;
	from: string;
}

export interface WebmailConfig {
	imap: ImapConfig;
	smtp: SmtpConfig;
	pollSec: number;
	notifyEnabled: boolean;
	aiEnabled: boolean;
}

/** config.json as it may exist on disk: user-editable, so anything can be
 *  missing. Extra keys are kept by the merge in loadConfig. */
interface StoredConfig {
	imap?: Partial<ImapConfig>;
	smtp?: Partial<SmtpConfig>;
	pollSec?: number;
	notifyEnabled?: boolean;
	aiEnabled?: boolean;
	[key: string]: unknown;
}

/** The redacted settings the view is allowed to see: passwords are replaced by
 *  a hasPass flag and never leave the server. */
export interface PublicConfig {
	imap: { host: string; port: number; tls: boolean; user: string; hasPass: boolean };
	smtp: { host: string; port: number; tls: boolean; user: string; from: string; hasPass: boolean };
	pollSec: number;
	notifyEnabled: boolean;
	aiEnabled: boolean;
}

/** The state payload broadcast to every client. */
export interface PublicState {
	configured: boolean;
	depsOk: boolean;
	depsInstalling: boolean;
	status: string;
	unseen: number;
	lastCheckAt: number;
	aiEnabled: boolean;
	notifyEnabled: boolean;
	config: PublicConfig;
}

/** One list/search entry as the view and the AI tools see it. */
export interface MailSummary {
	uid: number;
	from: string;
	fromName: string;
	to: string;
	subject: string;
	date: string;
	seen: boolean;
	size: number;
}

/** A read message: the summary plus its body. */
export interface ReadMail extends MailSummary {
	text: string;
	truncated: boolean;
	hasAttachments: boolean;
}

/** View -> server message. Only the fields the onMessage branches read. */
interface ViewMessage {
	action?: string;
	config?: StoredConfig;
	folder?: string;
	limit?: number;
	unseenOnly?: boolean;
	uid?: number | string;
	uids?: unknown;
	seen?: boolean;
	query?: unknown;
	to?: unknown;
	cc?: unknown;
	subject?: unknown;
	body?: unknown;
}

/** Agent tool arguments arrive as an untyped JSON object; these declare what
 *  each mail_* tool actually reads. */
interface ListArgs {
	folder?: string;
	limit?: number;
	unseen_only?: boolean;
}
interface ReadArgs {
	uid?: number | string;
	folder?: string;
}
interface SearchArgs {
	query?: unknown;
	folder?: string;
	limit?: number;
}
interface SendArgs {
	to?: unknown;
	cc?: unknown;
	subject?: unknown;
	body?: unknown;
}
interface ManageArgs {
	action?: string;
	uids?: unknown;
	folder?: string;
}

const CONFIG_FILE = "config.json";
/** Upper bound on a body handed to the AI, in characters, so a huge HTML mail
 *  cannot blow up the context window. */
export const BODY_LIMIT = 16000;
/** Maximum number of envelopes pulled while searching. */
const SEARCH_SCAN = 1000;
/** The drivers are resolved from a runtime string after auto-install. */
const DEP_NAMES: string[] = ["imapflow", "mailparser", "nodemailer"];

export const DEFAULT_CONFIG: WebmailConfig = {
	imap: { host: "", port: 993, tls: true, user: "", pass: "" },
	smtp: {
		host: "",
		port: 465,
		tls: true,
		user: "",
		pass: "",
		from: "",
	},
	pollSec: 60,
	notifyEnabled: true,
	aiEnabled: false,
};

/** Read config.json, falling back to the defaults when it is absent or corrupt. */
export async function loadConfig(dir: string): Promise<WebmailConfig> {
	const raw = join(dir, CONFIG_FILE);
	if (!existsSync(raw)) return structuredClone(DEFAULT_CONFIG);
	try {
		const parsed = JSON.parse(await readFile(raw, "utf8")) as StoredConfig;
		return {
			...structuredClone(DEFAULT_CONFIG),
			...parsed,
			imap: { ...DEFAULT_CONFIG.imap, ...parsed.imap },
			smtp: { ...DEFAULT_CONFIG.smtp, ...parsed.smtp },
		} as WebmailConfig;
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

/** Write config.json with the same tab indentation the plugin has always used. */
async function saveConfig(dir: string, cfg: WebmailConfig): Promise<void> {
	await writeFile(join(dir, CONFIG_FILE), JSON.stringify(cfg, null, "\t"), "utf8");
}

/** Find a usable npm CLI: prefer resolving npm's own cli.js (no shell needed),
 *  falling back to whatever is on PATH. */
function resolveNpmCli(): string | null {
	try {
		return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
	} catch {
		return null;
	}
}

/** Text form of an unknown thrown value, matching the `err?.message ?? err`
 *  shape this plugin has always logged and reported. */
function reasonText(err: unknown): string {
	const message = (err as { message?: unknown } | null | undefined)?.message;
	return message === undefined || message === null ? String(err) : String(message);
}

function envFrom(envelope?: MailEnvelope): string {
	const addr = envelope?.from?.[0];
	return addr ? (addr.address ?? "") : "";
}

function envName(envelope?: MailEnvelope): string {
	const addr = envelope?.from?.[0];
	return addr?.name || "";
}

/** Flatten a fetched message into the summary the view and the AI tools share. */
export function summarize(msg: FetchedMessage): MailSummary {
	return {
		uid: msg.uid,
		from: envFrom(msg.envelope),
		fromName: envName(msg.envelope),
		to: (msg.envelope?.to ?? []).map((a) => a.address ?? "").join(", "),
		subject: msg.envelope?.subject || "(no subject)",
		date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : "",
		seen: Boolean(msg.flags?.has("\\Seen")),
		size: msg.size ?? 0,
	};
}

export default {
	activate(host: WebmailHost): () => void {
		const st: {
			config: WebmailConfig | null;
			client: ImapClient | null;
			/** Mutex chain for IMAP work: operations on one ImapFlow connection
			 *  have to be serialised. */
			chain: Promise<void>;
			pollTimer: ReturnType<typeof setInterval> | null;
			pollBusy: boolean;
			lastUnseenUids: Set<number>;
			firstPollDone: boolean;
			deps: MailDeps;
			depsOk: boolean;
			depsInstalling: boolean;
			status: string;
			lastCheckAt: number;
			unseenTotal: number;
			toolUnregister: (() => void) | null;
			/** Handle from registerBackgroundTask (the mail poller in the panel). */
			bgTask: BackgroundTaskHandle | null;
			installChild: ChildProcess | null;
		} = {
			config: null,
			client: null,
			chain: Promise.resolve(),
			pollTimer: null,
			pollBusy: false,
			lastUnseenUids: new Set(),
			firstPollDone: false,
			deps: { imapflow: null, mailparser: null, nodemailer: null },
			depsOk: false,
			depsInstalling: false,
			status: STATUS_UNCONFIGURED,
			lastCheckAt: 0,
			unseenTotal: 0,
			toolUnregister: null,
			bgTask: null,
			installChild: null,
		};

		// ------------------------------------------------------------------
		// Configuration and state
		// ------------------------------------------------------------------
		// Secret storage: passwords go to the host's host.secrets (AES-256-GCM)
		// first. An older host without that facility, or a write that fails (a
		// read-only directory, a full disk), falls back to the old plaintext
		// config.json behaviour.
		// The invariant that matters: a password is never dropped from memory or
		// from the config file until it is confirmed stored as a secret - otherwise
		// you get "the password vanished after saving and IMAP says No password
		// configured".
		const sec = host.secrets;
		/** Whether secret writes degraded to plaintext (warned about once). */
		let secretsDegradedWarned = false;

		/** Write a secret and read it back to verify: the host's set() only logs
		 *  when writing to disk fails, so reading back the same value is the only
		 *  proof it was really stored. Returns false on failure, and the caller
		 *  then keeps the plaintext copy. */
		function storeSecret(name: string, value: unknown): boolean {
			if (!sec?.set || !value) return false;
			try {
				sec.set(name, String(value));
				return sec.get?.(name) === String(value);
			} catch (err) {
				host.log(`failed to write secret ${name}:`, reasonText(err));
				return false;
			}
		}

		/** Warn once that secrets are unavailable: the password is still saved,
		 *  but as plaintext in config.json. */
		function warnSecretsDegraded(): void {
			if (secretsDegradedWarned) return;
			secretsDegradedWarned = true;
			host.log("encrypted storage unavailable; the password was saved as plain text in config.json");
			host.notify(
				"warning",
				"📬 Webmail: encrypted storage unavailable - the password was saved as plain text in " +
					"config.json (functionality unaffected)",
			);
		}

		/** After reading the non-sensitive fields from config.json: migrate any
		 *  legacy plaintext password into the secret store (only stripping it from
		 *  the file once that is confirmed), then backfill the in-memory copy from
		 *  the store, because memory needs the real password to connect. */
		async function loadConfigSecure(): Promise<WebmailConfig> {
			const cfg = await loadConfig(host.dir);
			if (sec?.set) {
				let migrated = false;
				for (const [sect, secretName] of [
					["imap", "imap_pass"],
					["smtp", "smtp_pass"],
				] as const) {
					const legacy = cfg[sect].pass;
					if (!legacy) continue;
					// Only strip the plaintext once the secret verified, or the
					// migration would delete the only copy of the password.
					if (storeSecret(secretName, legacy)) {
						cfg[sect].pass = "";
						migrated = true;
					} else {
						warnSecretsDegraded();
					}
				}
				if (migrated) {
					// Write the stripped, clean configuration back.
					try {
						await saveConfig(host.dir, cfg);
					} catch {
						/* the in-memory copy still has everything it needs */
					}
					host.log("migrated plaintext passwords to encrypted storage");
				}
			}
			return rehydrate(cfg);
		}

		/** Backfill the in-memory copy from stored secrets, without touching a
		 *  value the user has just typed. */
		function rehydrate(cfg: WebmailConfig): WebmailConfig {
			if (!sec?.get || !cfg) return cfg;
			const ip = sec.get("imap_pass");
			const sp = sec.get("smtp_pass");
			if (ip !== undefined && !cfg.imap.pass) cfg.imap.pass = ip;
			if (sp !== undefined && !cfg.smtp.pass) cfg.smtp.pass = sp;
			return cfg;
		}

		function publicState(): PublicState {
			const c = st.config;
			return {
				configured: Boolean(c?.imap?.host && c?.imap?.user),
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				status: st.status,
				unseen: st.unseenTotal,
				lastCheckAt: st.lastCheckAt,
				aiEnabled: Boolean(c?.aiEnabled),
				notifyEnabled: c?.notifyEnabled !== false && Boolean(c?.imap?.host),
				// Redacted settings echo: passwords are not sent back, only whether
				// one exists.
				config: {
					imap: {
						host: c?.imap?.host ?? "",
						port: c?.imap?.port ?? 993,
						tls: c?.imap?.tls !== false,
						user: c?.imap?.user ?? "",
						hasPass: Boolean(c?.imap?.pass),
					},
					smtp: {
						host: c?.smtp?.host ?? "",
						port: c?.smtp?.port ?? 465,
						tls: c?.smtp?.tls !== false,
						user: c?.smtp?.user ?? "",
						from: c?.smtp?.from ?? "",
						hasPass: Boolean(c?.smtp?.pass),
					},
					pollSec: c?.pollSec ?? 60,
					notifyEnabled: c?.notifyEnabled !== false,
					aiEnabled: Boolean(c?.aiEnabled),
				},
			};
		}

		function broadcastState(): void {
			host.broadcast({ kind: "state", state: publicState() });
		}

		async function applyConfig(next: WebmailConfig): Promise<void> {
			// 1) Password semantics: blank (undefined / "") means "keep what is
			//    stored" (memory, then the secret store); a value means "update".
			next.imap.pass = next.imap.pass || st.config?.imap?.pass || sec?.get?.("imap_pass") || "";
			next.smtp.pass = next.smtp.pass || st.config?.smtp?.pass || sec?.get?.("smtp_pass") || "";
			// 2) The on-disk copy: only a password confirmed written to the secret
			//    store is stripped from config.json. When secrets are unavailable or
			//    the write failed, keep the plaintext (the old host behaviour) -
			//    plaintext is better than losing the password.
			const onDisk = structuredClone(next);
			let degraded = false;
			for (const [sect, secretName] of [
				["imap", "imap_pass"],
				["smtp", "smtp_pass"],
			] as const) {
				if (!next[sect].pass) continue;
				if (storeSecret(secretName, next[sect].pass)) onDisk[sect].pass = "";
				else degraded = true;
			}
			// Only warn when the host has a secret facility that failed; a host
			// without one at all is the documented plaintext fallback, not a fault.
			if (degraded && sec?.set) warnSecretsDegraded();
			// 3) The in-memory copy always holds the real password: IMAP/SMTP need it.
			st.config = next;
			await saveConfig(host.dir, onDisk);
			// An account was just configured but the drivers are missing: install them.
			if (!st.depsOk && next.imap?.host) installDeps(true);
			restartPoller();
			await refreshAiTools();
			broadcastState();
		}

		// ------------------------------------------------------------------
		// Dependency loading and auto-install
		// ------------------------------------------------------------------
		async function loadDeps(): Promise<boolean> {
			const loaded: Record<string, unknown> = {};
			for (const name of DEP_NAMES) {
				try {
					loaded[name] = await import(name);
				} catch (err) {
					host.log(`dependency ${name} is not ready:`, reasonText(err));
					loaded[name] = null;
				}
			}
			// SAFETY: the specifiers above are runtime strings, so `await import(name)`
			// is typed as a namespace object the compiler cannot relate to MailDeps.
			// Every key of DEP_NAMES is filled in this loop (module or null), which is
			// exactly the MailDeps contract; the interfaces above declare the members
			// the plugin actually calls.
			st.deps = loaded as unknown as MailDeps;
			st.depsOk = st.deps.imapflow !== null && st.deps.mailparser !== null;
			if (!st.depsOk || !st.deps.nodemailer) {
				host.log('hint: click "Install dependencies" in the settings panel to finish the installation');
			}
			return st.depsOk;
		}

		function installDeps(auto = false): void {
			if (st.depsInstalling) return;
			st.depsInstalling = true;
			host.log(`installing deps: imapflow / mailparser / nodemailer${auto ? " (auto)" : ""}`);
			if (!auto) host.notify("info", "📬 Webmail: installing dependencies…");
			host.notify("info", "📬 Webmail: installing dependencies (imapflow / mailparser / nodemailer)…");
			const pkgs = ["imapflow@latest", "mailparser@latest", "nodemailer@latest"];
			const npmCli = resolveNpmCli();
			const child = npmCli
				? spawn(process.execPath, [npmCli, "--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
						stdio: "ignore",
					})
				: spawn(
						process.platform === "win32" ? "npm.cmd" : "npm",
						["--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"],
						{ stdio: "ignore" },
					);
			st.installChild = child;
			child.on("error", (err) => void finish(false, err.message));
			child.on("exit", (code) => void finish(code === 0, `npm exit ${code}`));
			let done = false;
			async function finish(ok: boolean, why: string): Promise<void> {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (st.installChild === child) st.installChild = null;
				if (ok) {
					await loadDeps();
					// Dependencies are ready, so start polling.
					restartPoller();
					await refreshAiTools();
				}
				host.notify(
					ok ? "success" : "error",
					ok
						? "📬 Webmail dependencies installed"
						: `📬 Webmail dependency installation failed (${why}) - run npm install in the plugin ` +
								'directory by hand, or retry "Install dependencies" in the settings panel',
				);
				broadcastState();
			}
		}

		// ------------------------------------------------------------------
		// IMAP plumbing: serialised mutex plus a lazily opened connection
		// ------------------------------------------------------------------
		function serialized<T>(fn: () => T | Promise<T>): Promise<T> {
			const run = st.chain.then(
				() => fn(),
				() => fn(),
			);
			st.chain = run.then(
				() => {},
				() => {},
			);
			return run;
		}

		function dropClient(why?: string): void {
			const c = st.client;
			st.client = null;
			if (c) {
				try {
					c.close();
				} catch {
					/* already dead */
				}
			}
			if (why) host.log("connection dropped:", why);
		}

		async function ensureClient(): Promise<ImapClient> {
			const c = st.config?.imap;
			if (!st.deps.imapflow) {
				throw new Error('Dependencies are not installed: click "Install dependencies" in the settings panel');
			}
			if (!c?.host || !c?.user) throw new Error("No IMAP account configured yet");
			if (st.client?.usable) return st.client;
			dropClient();
			const { ImapFlow } = st.deps.imapflow;
			const client = new ImapFlow({
				host: c.host,
				port: Number(c.port) || 993,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
				logger: false,
			});
			client.on("error", (err) => dropClient(err?.message));
			await client.connect();
			st.client = client;
			st.status = STATUS_CONNECTED;
			return client;
		}

		/** Open `folder` and run fn (which may use the client's mailbox-level API),
		 *  releasing the lock afterwards. */
		async function withMailbox<T>(folder: string | undefined, fn: (client: ImapClient) => Promise<T>): Promise<T> {
			const client = await ensureClient();
			const lock = await client.getMailboxLock(folder || "INBOX");
			try {
				return await fn(client);
			} finally {
				lock.release();
			}
		}

		// ------------------------------------------------------------------
		// Mail operations (the UI and the AI tools share one implementation)
		// ------------------------------------------------------------------
		async function listMails(options: ListArgs = {}): Promise<MailSummary[]> {
			const { folder = "INBOX", limit = 30, unseen_only: unseenOnly = false } = options;
			return withMailbox(folder, async (client) => {
				const box = client.mailbox;
				const total = box?.exists ?? 0;
				if (total === 0) return [];
				const start = Math.max(1, total - Math.min(Number(limit) || 30, 200) + 1);
				const out: MailSummary[] = [];
				const range = `${start}:*`;
				for await (const msg of client.fetch(range, {
					envelope: true,
					flags: true,
					size: true,
				})) {
					if (unseenOnly && msg.flags?.has("\\Seen")) continue;
					out.push(summarize(msg));
				}
				out.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
				return out;
			});
		}

		async function searchMails(options: SearchArgs = {}): Promise<MailSummary[]> {
			const { query, folder = "INBOX", limit = 20 } = options;
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) return [];
			// Filter the envelopes (subject/from/to) client-side to sidestep the
			// dialect differences between IMAP SEARCH implementations.
			const pool = await listMails({ folder, limit: SEARCH_SCAN });
			return pool
				.filter((m) => [m.subject, m.from, m.fromName, m.to].some((s) => String(s).toLowerCase().includes(q)))
				.slice(0, Math.min(Number(limit) || 20, 50));
		}

		async function readMail(options: ReadArgs = {}): Promise<ReadMail> {
			const { folder = "INBOX", uid } = options;
			if (!uid) throw new Error("missing uid");
			return withMailbox(folder, async (client) => {
				// Note: the third argument {uid:true} is what makes this fetch by UID.
				// Passing it inside the query object instead would be read as a
				// sequence number, giving "the list shows it but opening it says not
				// found" (always reproducible once the UID exceeds the message count).
				const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
				if (!msg || !msg.source) throw new Error(`no message found for uid=${uid}`);
				const meta = summarize(msg);
				const raw = msg.source;
				const { simpleParser } = st.deps.mailparser!;
				const parsed = await simpleParser(raw);
				const text =
					parsed.text ||
					String(parsed.html ?? "")
						.replace(/<style[\s\S]*?<\/style>/gi, "")
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim();
				return {
					...meta,
					text: text.slice(0, BODY_LIMIT),
					truncated: text.length > BODY_LIMIT,
					hasAttachments: (parsed.attachments ?? []).length > 0,
				};
			});
		}

		async function markMails(
			options: { folder?: string; uids?: unknown; seen?: boolean } = {},
		): Promise<{ changed: number }> {
			const { folder = "INBOX", uids, seen = true } = options;
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { changed: 0 };
			return withMailbox(folder, async (client) => {
				let changed = 0;
				const flag = "\\Seen";
				for (const uid of list) {
					const ok = seen
						? await client.messageFlagsAdd(uid, [flag], { uid: true })
						: await client.messageFlagsRemove(uid, [flag], { uid: true });
					if (ok) changed++;
				}
				return { changed };
			});
		}

		async function deleteMails(
			options: { folder?: string; uids?: unknown } = {},
		): Promise<{ deleted: number; trash: string | null }> {
			const { folder = "INBOX", uids } = options;
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { deleted: 0, trash: null };
			return withMailbox(folder, async (client) => {
				// Move to the trash folder when there is one (recoverable); only
				// hard-delete when there is not.
				let trash: string | null = null;
				for await (const f of client.list()) {
					// The last alternative is the Chinese-localised folder name some
					// providers use; it is written as an escape so this source stays
					// ASCII-only.
					if (f.specialUse === "\\Trash" || /^(trash|deleted|deleted messages|\u5df2\u5220\u9664)/i.test(f.path)) {
						trash = f.path;
						break;
					}
				}
				let moved = 0;
				for (const uid of list) {
					const ok = trash
						? await client.messageMove(uid, trash, { uid: true })
						: await client.messageDelete(uid, { uid: true });
					if (ok) moved++;
				}
				return { deleted: moved, trash };
			});
		}

		async function sendMail(options: SendArgs = {}): Promise<SendInfo> {
			const { to, cc, subject, body } = options;
			const nd = st.deps.nodemailer;
			if (!nd) throw new Error('Dependencies are not installed: click "Install dependencies" in the settings panel');
			const c = st.config?.smtp;
			if (!c?.host || !c?.user) throw new Error("No SMTP account configured yet");
			const transport = nd.createTransport({
				host: c.host,
				port: Number(c.port) || 465,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
			});
			const info = await transport.sendMail({
				from: c.from || c.user,
				to: String(to ?? ""),
				cc: cc ? String(cc) : undefined,
				subject: String(subject ?? "(no subject)"),
				text: String(body ?? ""),
			});
			return { messageId: info.messageId, accepted: info.accepted };
		}

		async function countUnseen(): Promise<{ uids: number[] }> {
			return withMailbox("INBOX", async (client) => ({
				uids: (await client.search({ seen: false }, { uid: true })) ?? [],
			}));
		}

		// ------------------------------------------------------------------
		// New-mail polling
		// ------------------------------------------------------------------
		async function pollOnce(): Promise<void> {
			if (!st.config?.imap?.host || !st.depsOk || st.pollBusy) return;
			st.pollBusy = true;
			try {
				const { uids } = await countUnseen();
				st.lastCheckAt = Date.now();
				const fresh = uids.filter((u) => !st.lastUnseenUids.has(u));
				st.unseenTotal = uids.length;
				if (st.firstPollDone && fresh.length > 0) {
					let subjects: string[] = [];
					try {
						const summaries = await listMails({ folder: "INBOX", limit: 10 });
						subjects = summaries
							.filter((m) => fresh.includes(m.uid))
							.slice(0, 3)
							.map((m) => `${m.fromName || m.from}: ${m.subject}`);
					} catch {
						/* without subjects, report the count only */
					}
					if (st.config.notifyEnabled !== false) {
						host.notify(
							"info",
							`📬 ${fresh.length} new message${fresh.length === 1 ? "" : "s"}${
								subjects.length ? ` \u2014 ${subjects.join(" \u00b7 ")}` : ""
							}`,
						);
					}
					host.broadcast({
						kind: "new-mail",
						count: fresh.length,
						unseen: uids.length,
						subjects,
					});
				}
				st.firstPollDone = true;
				st.lastUnseenUids = new Set(uids);
				st.status = STATUS_CONNECTED;
			} catch (err) {
				st.status = failedStatus(reasonText(err));
				dropClient();
			} finally {
				st.pollBusy = false;
				broadcastState();
			}
		}

		function restartPoller(): void {
			if (st.pollTimer) clearInterval(st.pollTimer);
			st.pollTimer = null;
			st.lastUnseenUids.clear();
			st.firstPollDone = false;
			const secs = Math.max(15, Math.floor(Number(st.config?.pollSec) || 60));
			if (st.config?.imap?.host && st.depsOk) {
				st.pollTimer = setInterval(() => void serialized(pollOnce), secs * 1000);
				void serialized(pollOnce); // one round straight away
				// The resident task shows up in the background-task panel: visible,
				// and one click stops the polling.
				if (st.bgTask) st.bgTask.update({ label: "📬 Mail polling", status: `every ${secs}s` });
				else {
					st.bgTask =
						host.registerBackgroundTask?.({
							id: "mail-poll",
							label: "📬 Mail polling",
							status: `every ${secs}s`,
							stop: () => {
								if (st.pollTimer) clearInterval(st.pollTimer);
								st.pollTimer = null;
								host.log("polling stopped from background panel");
							},
						}) ?? null;
				}
			} else {
				// Not configured or drivers missing: do not poll, and take the task
				// out of the panel if it was there.
				st.bgTask?.unregister();
				st.bgTask = null;
				broadcastState();
			}
		}

		// ------------------------------------------------------------------
		// AI tool registration (driven by the config.aiEnabled switch)
		// ------------------------------------------------------------------
		const FOLDER_PARAM = {
			type: "string",
			description: "Mailbox folder path, defaults to INBOX",
		};

		/** Render the one-line-per-message listing the mail tools return. */
		function mailLines(mails: MailSummary[]): string {
			return mails
				.map(
					(m) =>
						`#${m.uid}${m.seen ? "" : " [unread]"} ${m.date.slice(0, 16).replace("T", " ")} ${
							m.fromName || m.from
						} \u2014 ${m.subject}`,
				)
				.join("\n");
		}

		function aiTools(): AgentTool[] {
			return [
				{
					name: "mail_list",
					label: "List new mail",
					description:
						"List summaries of the recent messages in a mailbox (sender, subject, date, read state). " +
						"Use it when the user asks you to check their mail or look at the inbox.",
					parameters: {
						type: "object",
						properties: {
							folder: FOLDER_PARAM,
							limit: { type: "number", description: "How many entries to return, default 30, maximum 200" },
							unseen_only: { type: "boolean", description: "Unread messages only, default false" },
						},
					},
					execute: async (_id, args) => {
						const mails = await listMails(args as ListArgs);
						if (mails.length === 0) return "The mailbox is empty (or has nothing unread).";
						return mailLines(mails);
					},
				},
				{
					name: "mail_read",
					label: "Read one message",
					description: "Read the full body of one message by uid (plain text, truncated when too long).",
					parameters: {
						type: "object",
						properties: {
							uid: { type: "number", description: "the #number returned by mail_list" },
							folder: FOLDER_PARAM,
						},
						required: ["uid"],
					},
					execute: async (_id, args) => {
						const m = await readMail(args as ReadArgs);
						return [
							`Subject: ${m.subject}`,
							`From: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`,
							`Date: ${m.date}`,
							m.hasAttachments ? "(has attachments)" : "",
							"",
							m.text + (m.truncated ? "\n\u2026(truncated)" : ""),
						]
							.filter(Boolean)
							.join("\n");
					},
				},
				{
					name: "mail_search",
					label: "Search mail",
					description: "Search the recent messages by keyword (matches the subject, the sender and the recipient).",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Keyword" },
							folder: FOLDER_PARAM,
							limit: { type: "number", description: "How many entries to return, default 20" },
						},
						required: ["query"],
					},
					execute: async (_id, args) => {
						const opts = args as SearchArgs;
						const mails = await searchMails(opts);
						if (mails.length === 0) return `No messages match \u201c${String(opts.query ?? "")}\u201d.`;
						return mailLines(mails);
					},
				},
				{
					name: "mail_send",
					label: "Send mail",
					description: "Send one plain-text message through the configured SMTP account.",
					promptGuidelines: [
						"Confirm the recipient, the subject and the body with the user once before calling this tool.",
					],
					parameters: {
						type: "object",
						properties: {
							to: { type: "string", description: "Recipient email address" },
							cc: { type: "string", description: "Carbon copy (optional)" },
							subject: { type: "string", description: "Subject" },
							body: { type: "string", description: "Body (plain text)" },
						},
						required: ["to", "body"],
					},
					execute: async (_id, args) => {
						const r = await sendMail(args as SendArgs);
						return `Sent to ${(r.accepted ?? []).join(", ")}`;
					},
				},
				{
					name: "mail_manage",
					label: "Manage message state",
					description:
						'Mark messages as read or unread in bulk, or delete them. action is "seen" | "unseen" | "delete".',
					parameters: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["seen", "unseen", "delete"],
								description: "Operation to perform",
							},
							uids: { type: "array", items: { type: "number" }, description: "List of message uids" },
							folder: FOLDER_PARAM,
						},
						required: ["action", "uids"],
					},
					execute: async (_id, args) => {
						const opts = args as ManageArgs;
						if (opts.action === "delete") {
							const r = await deleteMails({ folder: opts.folder, uids: opts.uids });
							return `Deleted ${r.deleted} message(s)${r.trash ? ` (moved to ${r.trash})` : ""}`;
						}
						const r = await markMails({
							folder: opts.folder,
							uids: opts.uids,
							seen: opts.action === "seen",
						});
						return `Updated the state of ${r.changed} message(s)`;
					},
				},
				{
					name: "mail_folders",
					label: "List folders",
					description: "List every folder path in the mailbox (inbox, archive, trash and so on).",
					parameters: { type: "object", properties: {} },
					execute: async () => {
						return withMailbox("INBOX", async (client) => {
							const out: string[] = [];
							for await (const f of client.list()) {
								out.push(`${f.path}${f.specialUse ? ` (${f.specialUse})` : ""}`);
							}
							return out.join("\n");
						});
					},
				},
			];
		}

		async function refreshAiTools(): Promise<void> {
			st.toolUnregister?.();
			st.toolUnregister = null;
			if (st.config?.aiEnabled && st.depsOk) {
				const offs = aiTools().map((t) => host.registerAgentTool(t));
				st.toolUnregister = () => offs.forEach((off) => off());
				host.log("AI mail tools enabled");
			}
		}

		// ------------------------------------------------------------------
		// View message protocol
		// ------------------------------------------------------------------
		const offMsg = host.onMessage((payload, from) => {
			const msg = (payload ?? {}) as ViewMessage;
			switch (msg.action) {
				case "get_state":
					if (from) host.sendTo(from, { kind: "state", state: publicState() });
					else broadcastState();
					break;
				case "save_config":
					void (async () => {
						try {
							await applyConfig({
								...structuredClone(DEFAULT_CONFIG),
								...msg.config,
								imap: { ...DEFAULT_CONFIG.imap, ...msg.config?.imap },
								smtp: { ...DEFAULT_CONFIG.smtp, ...msg.config?.smtp },
							} as WebmailConfig);
							host.sendTo(from as string, { kind: "result", ok: true, action: "save_config" });
							host.notify("info", "📬 Mail settings saved and applied");
						} catch (err) {
							host.sendTo(from as string, {
								kind: "result",
								ok: false,
								action: "save_config",
								error: reasonText(err),
							});
						}
					})();
					break;
				case "install_deps":
					installDeps();
					break;
				case "list":
					void serialized(() => listMails({ folder: msg.folder, limit: msg.limit, unseen_only: msg.unseenOnly }))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => {
							st.status = reasonText(err);
							broadcastState();
						});
					break;
				case "read":
					void serialized(() => readMail(msg as ReadArgs))
						.then((mail) => host.broadcast({ kind: "mail", mail }))
						.catch((err) => host.notify("error", `📬 Read failed: ${reasonText(err)}`));
					break;
				case "search":
					void serialized(() => searchMails(msg as SearchArgs))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => host.notify("error", `📬 Search failed: ${reasonText(err)}`));
					break;
				case "mark":
					void serialized(() => markMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "mark", ...r }))
						.catch((err) => host.notify("error", `📬 Mark failed: ${reasonText(err)}`));
					break;
				case "delete":
					void serialized(() => deleteMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "delete", ...r }))
						.catch((err) => host.notify("error", `📬 Delete failed: ${reasonText(err)}`));
					break;
				case "send":
					void sendMail(msg)
						.then(() => {
							host.notify("info", `📬 Sent to ${String(msg.to ?? "")}`);
							host.broadcast({ kind: "result", ok: true, action: "send" });
						})
						.catch((err) => host.notify("error", `📬 Send failed: ${reasonText(err)}`));
					break;
				default:
					host.log("unknown action", msg.action);
			}
		});

		// ------------------------------------------------------------------
		// Startup
		// ------------------------------------------------------------------
		void (async () => {
			try {
				st.config = await loadConfigSecure();
				await loadDeps();
				// Install missing drivers right away rather than waiting for a save.
				if (!st.depsOk) installDeps(true);
				await refreshAiTools();
				restartPoller();
				broadcastState();
				host.log("activated", st.depsOk ? "(dependencies ready)" : "(installing dependencies)");
			} catch (err) {
				host.log("activation failed:", err);
			}
		})();

		// Push the full state to each client as it attaches (the server is the only
		// source of truth). host.onAttach does not exist on older hosts, hence the
		// optional call; the client's own pull remains the fallback.
		const offAttach = host.onAttach?.((clientId) => {
			host.sendTo(clientId, { kind: "state", state: publicState() });
		});

		return () => {
			offMsg();
			try {
				offAttach?.();
			} catch {
				/* already detached */
			}
			st.toolUnregister?.();
			try {
				st.bgTask?.unregister();
			} catch {
				/* already gone */
			}
			if (st.pollTimer) clearInterval(st.pollTimer);
			try {
				// Terminate a dependency install that is still running so no writer
				// is left behind.
				st.installChild?.kill();
			} catch {
				/* already gone */
			}
			dropClient();
			host.log("deactivated");
		};
	},
};

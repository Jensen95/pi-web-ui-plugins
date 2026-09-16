/**
 * Server-side types for the vscode-editor plugin.
 *
 * The plugin talks to three loosely-shaped boundaries: the pi-web-ui plugin host,
 * the `plugin_message` payloads a browser sends it, and the ssh2 driver it loads
 * lazily. Each gets one small hand-written interface here rather than an `any`,
 * and the shapes mirror what the code actually reads.
 *
 * This file is deliberately server-only. The client entry has its own types; the
 * two sides share nothing but the wire protocol, which is documented by the
 * comments at each message case in index.ts.
 */
import type { FileHandle } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * Levels this plugin passes to host.notify.
 *
 * The host declares "info" | "warning" | "error", but it forwards the level
 * straight to the browser as a notice and upstream reports a finished dependency
 * install as "success". The string travels over the wire, so it is preserved
 * exactly rather than folded into "info".
 */
export type NoticeLevel = "info" | "warning" | "error" | "success";

/** Encrypted secret store (host.secrets). Optional: hosts without it fall back to
 *  the plaintext store file, which is what upstream does. */
export interface SecretStore {
	set(name: string, value: string): void;
	get(name: string): string | undefined;
	delete(name: string): void;
}

/**
 * The slice of the plugin host this entry point uses.
 *
 * Two members are widened on purpose, and both widenings are behaviour-preserving:
 *   - `sendTo` accepts `string | undefined` because the host types the second
 *     onMessage argument as `from?: string` and upstream passes it straight
 *     through. At runtime an unknown client id simply matches no socket.
 *   - `onAttach` / `onCwdChange` / `secrets` are optional because hosts older
 *     than 0.35 do not have them, which is why upstream calls them with `?.`.
 */
export interface EditorPluginHost {
	/** The plugin's own directory (<dataDir>/plugins/<id>). */
	dir: string;
	/** Live workspace root; it follows the host application's set_cwd. */
	cwd: string;
	broadcast(payload: unknown): void;
	notify(level: NoticeLevel, text: string, textEn?: string): void;
	sendTo(clientId: string | undefined, payload: unknown): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	onAttach?(handler: (clientId: string) => void): () => void;
	onCwdChange?(handler: (cwd: string) => void): () => void;
	secrets?: SecretStore;
	log(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/**
 * An inbound `plugin_message` payload.
 *
 * The browser owns this shape and nothing about it is trusted: path-like fields go
 * through safeResolve/safeRemotePath, sizes through Number.isFinite, and names
 * through an explicit separator check before they reach the filesystem.
 */
export interface WireMessage {
	action?: string;
	reqId?: string;
	/** Present on any file action that should route to a remote SFTP connection. */
	connId?: string;
	/** Directory for list, target directory for upload_begin. */
	dir?: string;
	path?: string;
	/** "dir" or "file" for create. */
	kind?: string;
	newName?: string;
	text?: string;
	isDir?: boolean;
	name?: string;
	size?: number;
	uploadId?: string;
	/** Zero-based chunk index. */
	i?: number;
	/** Total chunk count; the last chunk has i === total - 1. */
	total?: number;
	b64?: string;
	config?: SyncSavePayload;
	host?: HostSavePayload;
	id?: string;
	/** Sync scope: "file" | "tree" | "all"; anything else falls back to "file". */
	scope?: string;
	cmd?: string;
	cols?: number;
	rows?: number;
	shellId?: string;
}

/** The `config` object of a sync_save message. `null` on a credential means
 *  "clear it"; an omitted or empty credential means "keep the stored one". */
export interface SyncSavePayload {
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string | null;
	passphrase?: string | null;
	privateKey?: string | null;
	privateKeyPath?: string;
	agent?: string;
	remoteRoot?: string;
	exclude?: unknown;
	uploadOnSave?: boolean;
}

/** The `host` object of a hosts_save message. Without `id` it creates a host. */
export interface HostSavePayload {
	id?: string;
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string | null;
	privateKey?: string | null;
}

// ---------------------------------------------------------------------------
// Local file tree
// ---------------------------------------------------------------------------

/** One entry of a local directory listing. */
export interface TreeEntry {
	name: string;
	type: "dir" | "file";
}

/** One entry of a remote directory listing; SFTP also reports symlinks. */
export interface RemoteTreeEntry {
	name: string;
	type: "dir" | "file" | "link";
	size: number;
}

/** A successful read: either decoded text or a binary marker. */
export type ReadResult = { text: string; encoding: string; size: number } | { binary: true; size: number };

// ---------------------------------------------------------------------------
// SFTP sync configuration
// ---------------------------------------------------------------------------

/**
 * The normalized internal sync configuration.
 *
 * Every field is optional because readSyncCfg() returns `{}` when the workspace
 * has no `.vscode/sftp.json`; callers treat a missing `host` as "not configured".
 * Field names follow vscode-sftp so the file on disk stays interchangeable with
 * the VS Code extension's.
 */
export interface SyncConfig {
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	passphrase?: string;
	privateKey?: string;
	privateKeyPath?: string;
	uploadOnSave?: boolean;
	agent?: string;
	protocol?: string;
	remoteRoot?: string;
	exclude?: string[];
}

/** The sync-facing shape sent to the browser: flags instead of secret values. */
export type PublicSync =
	| { configured: false }
	| {
			configured: true;
			name: string;
			host: string;
			port: number;
			username: string;
			remoteRoot: string;
			exclude: string[];
			uploadOnSave: boolean;
			hasPass: boolean;
			hasKey: boolean;
			hasAgent: boolean;
			privateKeyPath: string;
			agent: string;
	  };

/** Sync direction: local to remote, or remote to local. */
export type SyncDirection = "up" | "down";

/** What a sync run covers. */
export type SyncScope = "file" | "tree" | "all";

/** One file that failed during a sync run. */
export interface SyncFailure {
	rel: string;
	error: string;
}

/** Summary returned by a sync run. */
export interface SyncSummary {
	total: number;
	failed: SyncFailure[];
}

// ---------------------------------------------------------------------------
// SSH hosts and connections
// ---------------------------------------------------------------------------

/** A saved SSH host. Credentials live here in memory only; on disk they are
 *  stripped and stored in host.secrets. */
export interface SshHostConfig {
	id?: string;
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	privateKey?: string;
	passphrase?: string;
	/** Path to a private key file; takes precedence over an inline PEM. Not a secret. */
	privateKeyPath?: string;
	/** ssh-agent socket, "$SSH_AUTH_SOCK" expanded at connect time. Not a secret. */
	agent?: string;
}

/** One importable host parsed out of `~/.ssh/config`. */
export interface SshConfigCandidate {
	alias: string;
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
	/** Set by readSshConfigCandidates: a host with this address or name is already saved. */
	imported?: boolean;
}

/** The `<pluginDir>/ssh-hosts.json` document. Unknown keys are preserved. */
export interface SshStore {
	hosts: SshHostConfig[];
	[key: string]: unknown;
}

/** A host as the browser may see it: no credential values, only presence flags. */
export interface PublicSshHost {
	id: string | undefined;
	name: string | undefined;
	host: string | undefined;
	port: number;
	username: string;
	hasPass: boolean;
	hasKey: boolean;
	hasPassphrase: boolean;
	/** Path and agent are not secrets, so they echo back as their real values. */
	privateKeyPath: string;
	agent: string;
}

/** A live connection as the browser may see it. */
export interface PublicSshConn {
	connId: string;
	hostId: string | undefined;
	label: string;
	status: string;
}

/** The `state` broadcast: everything the UI needs, nothing it must not have. */
export interface PublicSshState {
	depsReady: boolean;
	depsInstalling: boolean;
	hosts: PublicSshHost[];
	conns: PublicSshConn[];
}

/** A pooled Remote-SSH connection. */
export interface SshConn {
	connId: string;
	client: SshClient;
	/** Socket that currently receives this connection's terminal output. */
	ownerId: string | undefined;
	hostId: string | undefined;
	label: string;
	status: "connecting" | "connected";
	/**
	 * Open shells by id. The key type allows undefined because a client may omit
	 * shellId, and looking that up must miss rather than throw.
	 */
	streams: Map<string | undefined, SshStream>;
	nextShell: number;
	sftp: SftpSession | null;
}

/** The cached SFTP sync connection for the current workspace root. */
export interface SyncConn {
	client: SshClient;
	sftp: SftpSession;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * One in-flight chunked upload, keyed by `${clientId}:${uploadId}`.
 *
 * A local session appends straight to an open `.part` handle and renames it into
 * place on the last chunk; a remote session buffers chunks in memory and writes
 * them once over SFTP. The unused side stays empty, which is what abortUploadEntry
 * relies on when it clears both unconditionally.
 */
export interface UploadSession {
	key: string;
	uploadId: string;
	scope: "local" | "remote";
	bytes: number;
	total: number;
	/** Timestamp of the last chunk, for the stale-session sweep. */
	last: number;
	/** Index the next chunk must carry. */
	next: number;
	/** Local only. */
	tmp?: string;
	finalAbs?: string;
	fh?: FileHandle | null;
	/** Remote only. */
	connId?: string;
	rpath?: string;
	bufs?: Buffer[] | null;
}

// ---------------------------------------------------------------------------
// ssh2
// ---------------------------------------------------------------------------

/**
 * ssh2 has no bundled TypeScript declarations. Its ambient module declaration
 * lives in server-ssh2.d.ts; index.ts narrows the dynamic import with
 * asSsh2Module(), matching upstream's `mod?.Client` check.
 */

/** The subset of ssh2 this plugin uses. */
export interface Ssh2Module {
	Client: new () => SshClient;
}

/** An ssh2 error carries an optional `level` naming the failed phase. */
export interface SshError extends Error {
	level?: string;
}

/** Options passed to client.connect(). */
export interface SshConnectOptions {
	host: string;
	port: number;
	username: string;
	readyTimeout: number;
	keepaliveInterval: number;
	keepaliveCountMax?: number;
	password?: string;
	privateKey?: string;
	passphrase?: string;
	agent?: string;
}

/** An ssh2 channel (shell or exec). */
export interface SshStream {
	on(event: "data", listener: (chunk: Buffer) => void): void;
	on(event: "close", listener: (code?: number) => void): void;
	stderr: {
		on(event: "data", listener: (chunk: Buffer) => void): void;
	};
	write(data: Uint8Array): void;
	end(): void;
	close(): void;
	setWindow(rows: number, cols: number, height: number, width: number): void;
}

/** An ssh2 connection. */
export interface SshClient {
	on(event: "ready", listener: () => void): SshClient;
	on(event: "error", listener: (err: SshError) => void): SshClient;
	on(event: "close", listener: () => void): SshClient;
	connect(opts: SshConnectOptions): void;
	end(): void;
	sftp(cb: (err: Error | null, sftp: SftpSession) => void): void;
	shell(opts: { cols: number; rows: number; term: string }, cb: (err: Error | null, stream: SshStream) => void): void;
	exec(cmd: string, cb: (err: Error | null, stream: SshStream) => void): void;
}

/** SFTP file attributes, as reported by readdir and stat. */
export interface SftpAttrs {
	size: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

/** One entry of an SFTP readdir result. */
export interface SftpEntry {
	filename: string;
	attrs: SftpAttrs;
}

/** The callback-last SFTP methods sftpCall() promisifies. */
export interface SftpSession {
	on(event: "close", listener: () => void): void;
	readdir(dir: string, cb: (err: Error | null, list: SftpEntry[]) => void): void;
	stat(path: string, cb: (err: Error | null, attrs: SftpAttrs) => void): void;
	readFile(path: string, cb: (err: Error | null, data: Buffer) => void): void;
	writeFile(path: string, data: Buffer, cb: (err: Error | null) => void): void;
	mkdir(path: string, cb: (err: Error | null) => void): void;
	rename(from: string, to: string, cb: (err: Error | null) => void): void;
	unlink(path: string, cb: (err: Error | null) => void): void;
	rmdir(path: string, cb: (err: Error | null) => void): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read `message` off a thrown value, which strict mode types as unknown.
 * Mirrors upstream's `err?.message ?? String(err)` exactly.
 */
export function errorMessage(err: unknown): string {
	// One cast at the trust boundary: anything can be thrown in JavaScript.
	return (err as { message?: string } | null | undefined)?.message ?? String(err);
}

/** Narrow the dynamically imported ssh2 module, the way upstream checks `mod?.Client`. */
export function asSsh2Module(value: unknown): Ssh2Module | null {
	const client = (value as { Client?: unknown } | null | undefined)?.Client;
	return typeof client === "function" ? (value as Ssh2Module) : null;
}

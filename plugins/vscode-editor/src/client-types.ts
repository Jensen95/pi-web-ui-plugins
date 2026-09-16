/**
 * Shapes the vscode-editor client view works with: the wire protocol shared with
 * src/index.ts (server side) and the view's own bookkeeping records.
 *
 * Every protocol field is optional on purpose - these are messages that arrive
 * over a WebSocket from a server this bundle does not control, so the client
 * reads them defensively (`r.entries ?? []`, `r.text ?? ""`) rather than trusting
 * a response to be complete. The field names mirror server/plugins.ts payloads
 * exactly and must never be renamed: they are protocol keys, not prose.
 */
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** The narrow channel the frontend hands to a plugin view's mount(). */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: ServerMessage) => void): () => void;
}

/** One row of a directory listing. */
export interface DirEntry {
	name: string;
	type: "file" | "dir";
}

/** An SSH host as the server publishes it, with credentials redacted. */
export interface HostInfo {
	id: string;
	name?: string;
	host: string;
	port: number;
	username: string;
	hasPass: boolean;
	hasKey: boolean;
	hasPassphrase?: boolean;
	privateKeyPath?: string;
	agent?: string;
}

/** An importable host parsed out of the user's `~/.ssh/config`. */
export interface SshConfigCandidate {
	alias: string;
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
	imported?: boolean;
}

/** A live SSH connection as the server publishes it. */ export interface ConnInfo {
	connId: string;
	hostId: string;
	label: string;
	status: "connecting" | "connected";
}

/** Host/connection state, broadcast by the server as kind:"state". */
export interface SshState {
	depsReady: boolean;
	depsInstalling: boolean;
	hosts: HostInfo[];
	conns: ConnInfo[];
}

/** The sync configuration as the server publishes it, with secrets redacted. */
export interface PublicSyncConfig {
	configured: boolean;
	name?: string;
	host?: string;
	port?: number;
	username?: string;
	remoteRoot?: string;
	exclude?: string[];
	uploadOnSave?: boolean;
	hasPass?: boolean;
	hasKey?: boolean;
	hasAgent?: boolean;
	privateKeyPath?: string;
	agent?: string;
}

/**
 * Anything the server sends down: a response to request(), a kind:"state" or
 * kind:"workspace" broadcast, or a targeted shell_data / shell_exit /
 * conn_closed / sync_progress event.
 */
export interface ServerMessage {
	// Response envelope.
	res?: boolean;
	reqId?: string;
	ok?: boolean;
	action?: string;
	error?: string;
	// Broadcasts.
	kind?: "state" | "workspace";
	state?: SshState;
	root?: string;
	// Targeted events.
	event?: "shell_data" | "shell_exit" | "conn_closed" | "sync_progress";
	connId?: string;
	shellId?: string;
	b64?: string;
	reason?: string;
	// list / flatlist / read / download.
	dir?: string;
	entries?: DirEntry[];
	files?: string[];
	truncated?: boolean;
	path?: string;
	text?: string;
	encoding?: string;
	binary?: boolean;
	size?: number;
	name?: string;
	// upload_begin / upload.
	uploadId?: string;
	exists?: boolean;
	// connect / exec / shell_open.
	label?: string;
	exitCode?: number;
	output?: string;
	// sshconfig_list / sshconfig_import.
	hosts?: SshConfigCandidate[];
	added?: number;
	skipped?: number;
	// sync_get / sync_run.
	config?: PublicSyncConfig;
	configPath?: string;
	total?: number;
	failed?: { rel: string; error: string }[];
	done?: number;
}

/** Payload of the hosts_save action; id is attached only when editing a host. */
export interface HostSavePayload {
	id?: string;
	name: string;
	host: string;
	port: number;
	username: string;
	password: string | undefined;
	privateKey: string | undefined;
	passphrase: string | undefined;
	privateKeyPath: string;
	agent: string;
}

/** Payload of the sync_save action. */
export interface SyncSavePayload {
	name: string;
	host: string;
	port: number;
	username: string;
	password: string | undefined;
	privateKey: string | undefined;
	privateKeyPath: string;
	agent: string;
	remoteRoot: string;
	exclude: string[];
	uploadOnSave: boolean;
}

/** Raw input values read out of the host modal, before trimming and defaults. */
export interface HostFormValues {
	name: string;
	host: string;
	port: string;
	username: string;
	password: string;
	privateKey: string;
	passphrase: string;
	privateKeyPath: string;
	agent: string;
}

/** Raw input values read out of the sync modal, before trimming and defaults. */
export interface SyncFormValues {
	name: string;
	host: string;
	port: string;
	username: string;
	password: string;
	privateKey: string;
	privateKeyPath: string;
	agent: string;
	remoteRoot: string;
	exclude: string;
	uploadOnSave: boolean;
}

/** An open editor tab. */
export interface TabState {
	/** "local" or a connId. */
	scope: string;
	path: string;
	name?: string;
	savedText: string;
	binary: boolean;
	dirty: boolean;
	/** The file on disk used CRLF, so saving writes CRLF back. */
	crlf: boolean;
}

/** One terminal in the bottom panel. */
export interface TermState {
	id: string;
	connId: string;
	shellId: string | null;
	label: string;
	/** 1-based index among the terminals of the same connection, for the tab label. */
	n: number;
	dead: boolean;
	term: Terminal | null;
	fit: FitAddon | null;
	el: HTMLElement | null;
	opened: boolean;
	/** Never assigned today; disconnect is still attempted on dispose, as upstream does. */
	ro?: ResizeObserver;
}

/** The node the user last clicked: highlighted, and where "new file/folder" lands. */
export interface SelNode {
	scope: string;
	path: string;
	type: "file" | "dir";
}

/** Where a drag-and-drop (or an empty-space right click) would land. */
export interface DropTarget {
	scope: string;
	dir: string;
}

/** A context-menu row; a null handler renders the item disabled. */
export type MenuItem = [label: string, run: (() => void) | null];

/** Chromium's File System Access API, which lib.dom.d.ts does not declare. */
export interface SaveFilePickerWindow extends Window {
	showSaveFilePicker?(options: { suggestedName: string }): Promise<SaveFileHandle>;
}

/** The part of the File System Access API this view uses. */
export interface SaveFileHandle {
	createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

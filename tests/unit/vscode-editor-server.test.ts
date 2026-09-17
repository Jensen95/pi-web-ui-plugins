/**
 * Server-side tests for the vscode-editor plugin.
 *
 * Everything here drives the TypeScript SOURCE (plugins/vscode-editor/src/index.ts)
 * through the plugin's public surface only: the default export, activate(host), and the
 * plugin_message protocol the plugin answers with host.sendTo. No private helper is
 * reached into and no internal name, log line or call count is asserted.
 *
 * Two doubles keep this offline and deterministic:
 *   - The workspace and the plugin directory are real temporary directories, so the
 *     local file tree, path containment, atomic writes and the chunked upload protocol
 *     run against real node:fs rather than a stub.
 *   - ssh2 is replaced with an in-memory client (vi.mock below). Same idea as upstream's
 *     tests/lib/mock-ssh.mjs, but instead of an in-process SSH server it hands the plugin
 *     a fake Client/SFTP/stream triple: no port, no key exchange, no native build.
 *
 * Deliberately not covered here: the npm auto-install branch of the ssh2 bootstrap (it
 * would spawn a real installer) - that lives in vscode-editor-server-deps.test.ts.
 * Nothing in this file touches a browser, a real pty or a real network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockHost, type MockHost } from "../helpers/mock-host";
import { findCjk, formatCjkHits, repoPath } from "../helpers/repo-files";
import { loadPlugin } from "../helpers/plugin-contract";
import { buildPlugin } from "../helpers/plugin-build";

// ---------------------------------------------------------------------------
// In-memory ssh2 double
// ---------------------------------------------------------------------------

/** What a fake exec produces. */
interface ExecResult {
	stdout?: string | Uint8Array;
	stderr?: string | Uint8Array;
	code?: number;
	/** Emit nothing and never close, so a test can drive the stream by hand. */
	hang?: boolean;
}

/** An in-memory remote filesystem plus the streams and exec calls made against it. */
interface FakeRemote {
	dirs: Set<string>;
	files: Map<string, Buffer>;
	links: Set<string>;
	shells: FakeShell[];
	execs: string[];
	/** Window geometry the plugin asked for on each shell(), in order. */
	shellWindows: { cols: number; rows: number }[];
	/** Per-test exec behaviour; the default echoes the command with exit code 0. */
	execHandler: ((cmd: string) => ExecResult) | null;
	/** Make shell() fail instead of returning a stream. */
	breakShell: boolean;
	/** stat() size overrides, so a size guard can be tested without real bytes. */
	sizeOverride: Map<string, number>;
	/** Remote paths whose writeFile must fail. */
	writeErrors: Set<string>;
	sftp: unknown;
}

/** A PTY-ish stream: data in, data out, plus what the plugin pushed into it. */
interface FakeShell {
	on(event: string, listener: (arg?: unknown) => void): unknown;
	emit(event: string, arg?: unknown): void;
	stderr: { emit(event: string, arg?: unknown): void };
	/** Bytes the plugin wrote into this stream (shell_input). */
	written: Buffer[];
	/** Last setWindow(rows, cols, height, width) call. */
	window: number[] | null;
	ended: boolean;
	closed: boolean;
	write(data: Uint8Array): boolean;
	end(): void;
	close(): void;
	setWindow(rows: number, cols: number, height: number, width: number): void;
}

/** A connected client the double kept, so a test can simulate a dropped link. */
interface FakeClient {
	emit(event: string, arg?: unknown): void;
	opts: Record<string, unknown> | null;
	ended: boolean;
}

/** Connect opts the plugin passed to client.connect(), recorded for assertions. */
type ConnectAttempt = Record<string, unknown>;

function makeRemote(
	seed: { dirs?: string[]; files?: Record<string, string | Uint8Array>; links?: string[] } = {},
): FakeRemote {
	const remote: FakeRemote = {
		dirs: new Set(["/", ...(seed.dirs ?? [])]),
		files: new Map(),
		links: new Set(seed.links ?? []),
		shells: [],
		execs: [],
		shellWindows: [],
		execHandler: null,
		breakShell: false,
		sizeOverride: new Map(),
		writeErrors: new Set(),
		sftp: null,
	};
	for (const [path, content] of Object.entries(seed.files ?? {})) remote.files.set(path, Buffer.from(content));
	return remote;
}

function parentOf(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx <= 0 ? "/" : p.slice(0, idx);
}

function baseOf(p: string): string {
	return p.slice(p.lastIndexOf("/") + 1);
}

function notFound(p: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
}

interface FakeAttrs {
	size: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

function attrs(kind: "dir" | "file" | "link", size = 0): FakeAttrs {
	return {
		size,
		isDirectory: () => kind === "dir",
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "link",
	};
}

/** Callback-last SFTP wrapper: the exact shape sftpCall(sftp, method, ...args) drives. */
function makeSftp(remote: FakeRemote): void {
	const norm = (dir: string): string => dir.replace(/\/+$/, "") || "/";
	const children = (dir: string): { filename: string; attrs: FakeAttrs }[] => {
		const out: { filename: string; attrs: FakeAttrs }[] = [];
		for (const d of remote.dirs)
			if (d !== "/" && parentOf(d) === dir) out.push({ filename: baseOf(d), attrs: attrs("dir") });
		for (const [f, buf] of remote.files)
			if (parentOf(f) === dir) out.push({ filename: baseOf(f), attrs: attrs("file", buf.length) });
		for (const l of remote.links) if (parentOf(l) === dir) out.push({ filename: baseOf(l), attrs: attrs("link") });
		return out;
	};
	const mkdirParents = (p: string): void => {
		let cur = parentOf(p);
		while (cur !== "/" && !remote.dirs.has(cur)) {
			remote.dirs.add(cur);
			cur = parentOf(cur);
		}
	};
	const sizeOf = (p: string, real: number): number => remote.sizeOverride.get(p) ?? real;

	remote.sftp = {
		on: () => undefined,
		readdir(dir: string, cb: (err: Error | null, list?: unknown) => void): void {
			const d = norm(String(dir));
			queueMicrotask(() => (remote.dirs.has(d) ? cb(null, children(d)) : cb(notFound(d))));
		},
		stat(p: string, cb: (err: Error | null, st?: FakeAttrs) => void): void {
			queueMicrotask(() => {
				if (remote.dirs.has(p)) return void cb(null, attrs("dir", sizeOf(p, 0)));
				const buf = remote.files.get(p);
				if (buf) return void cb(null, attrs("file", sizeOf(p, buf.length)));
				cb(notFound(p));
			});
		},
		readFile(p: string, cb: (err: Error | null, buf?: Buffer) => void): void {
			queueMicrotask(() => {
				const buf = remote.files.get(p);
				if (buf) cb(null, buf);
				else cb(notFound(p));
			});
		},
		writeFile(p: string, data: Buffer, cb: (err: Error | null) => void): void {
			queueMicrotask(() => {
				if (remote.writeErrors.has(p)) return void cb(new Error(`EACCES: permission denied, open '${p}'`));
				mkdirParents(p);
				remote.files.set(p, Buffer.from(data));
				cb(null);
			});
		},
		mkdir(p: string, cb: (err: Error | null) => void): void {
			queueMicrotask(() => {
				if (remote.dirs.has(p)) return void cb(Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" }));
				mkdirParents(p);
				remote.dirs.add(p);
				cb(null);
			});
		},
		rename(from: string, to: string, cb: (err: Error | null) => void): void {
			queueMicrotask(() => {
				const buf = remote.files.get(from);
				if (buf) {
					remote.files.delete(from);
					mkdirParents(to);
					remote.files.set(to, buf);
					return void cb(null);
				}
				if (remote.dirs.has(from)) {
					remote.dirs.delete(from);
					remote.dirs.add(to);
					return void cb(null);
				}
				cb(notFound(from));
			});
		},
		unlink(p: string, cb: (err: Error | null) => void): void {
			queueMicrotask(() => (remote.files.delete(p) ? cb(null) : cb(notFound(p))));
		},
		rmdir(p: string, cb: (err: Error | null) => void): void {
			queueMicrotask(() => (remote.dirs.delete(p) ? cb(null) : cb(notFound(p))));
		},
	};
}

/**
 * The whole ssh2 double, hoisted so vi.mock's factory can close over it.
 * vitest hoists vi.mock above the imports, so the factory cannot see any binding
 * declared below - hence a self-contained emitter and a makeShell/makeClient pair
 * injected from the registry at connection time.
 */
const ssh = vi.hoisted(() => {
	type Listener = (arg?: unknown) => void;
	class Emitter {
		private readonly map = new Map<string, Listener[]>();
		on(event: string, listener: Listener): this {
			const list = this.map.get(event) ?? [];
			list.push(listener);
			this.map.set(event, list);
			return this;
		}
		emit(event: string, arg?: unknown): void {
			for (const listener of [...(this.map.get(event) ?? [])]) listener(arg);
		}
	}

	interface RemoteLike {
		shells: unknown[];
		shellWindows: { cols: number; rows: number }[];
		execs: string[];
		execHandler: ((cmd: string) => unknown) | null;
		breakShell: boolean;
		sftp: unknown;
		makeShell: () => unknown;
	}

	const state: { registry: Map<string, RemoteLike>; attempts: unknown[]; clients: unknown[] } = {
		registry: new Map(),
		attempts: [],
		clients: [],
	};

	class Stream extends Emitter {
		stderr = new Emitter();
		written: unknown[] = [];
		window: number[] | null = null;
		ended = false;
		closed = false;
		write(data: Uint8Array): boolean {
			this.written.push(data);
			return true;
		}
		end(): void {
			this.ended = true;
			queueMicrotask(() => this.emit("close"));
		}
		close(): void {
			this.closed = true;
			queueMicrotask(() => this.emit("close"));
		}
		setWindow(rows: number, cols: number, height: number, width: number): void {
			this.window = [rows, cols, height, width];
		}
	}

	class Client extends Emitter {
		remote: RemoteLike | null = null;
		opts: Record<string, unknown> | null = null;
		ended = false;
		connect(opts: Record<string, unknown>): void {
			this.opts = opts;
			state.attempts.push(opts);
			state.clients.push(this);
			const remote = state.registry.get(`${String(opts.host)}:${Number(opts.port)}`) ?? null;
			queueMicrotask(() => {
				if (!remote) {
					this.emit(
						"error",
						Object.assign(new Error("All configured authentication methods failed"), {
							level: "client-authentication",
						}),
					);
					return;
				}
				this.remote = remote;
				this.emit("ready");
			});
		}
		sftp(cb: (err: Error | null, sftp?: unknown) => void): void {
			queueMicrotask(() => cb(this.remote ? null : new Error("not connected"), this.remote?.sftp));
		}
		shell(opts: { cols?: number; rows?: number }, cb: (err: Error | null, stream?: unknown) => void): void {
			queueMicrotask(() => {
				const remote = this.remote;
				if (!remote) return void cb(new Error("not connected"));
				if (remote.breakShell) return void cb(new Error("Unable to open a shell"));
				remote.shellWindows.push({ cols: Number(opts?.cols ?? 0), rows: Number(opts?.rows ?? 0) });
				const stream = remote.makeShell();
				remote.shells.push(stream);
				cb(null, stream);
			});
		}
		exec(cmd: string, cb: (err: Error | null, stream?: unknown) => void): void {
			queueMicrotask(() => {
				const remote = this.remote;
				if (!remote) return void cb(new Error("not connected"));
				remote.execs.push(cmd);
				const stream = new Stream();
				cb(null, stream);
				const result = (remote.execHandler ? remote.execHandler(cmd) : { stdout: cmd, code: 0 }) as {
					stdout?: string | Uint8Array;
					stderr?: string | Uint8Array;
					code?: number;
					hang?: boolean;
				};
				if (result.hang) return;
				if (result.stdout !== undefined) stream.emit("data", Buffer.from(result.stdout as string));
				if (result.stderr !== undefined) stream.stderr.emit("data", Buffer.from(result.stderr as string));
				stream.emit("close", result.code ?? 0);
			});
		}
		end(): void {
			this.ended = true;
			queueMicrotask(() => this.emit("close"));
		}
	}

	return { state, Client, Stream };
});

vi.mock("ssh2", () => ({ default: { Client: ssh.Client }, Client: ssh.Client }));

/** Register a reachable host and hand back its in-memory remote. */
function addSshHost(host: string, port: number, seed?: Parameters<typeof makeRemote>[0]): FakeRemote {
	const remote = makeRemote(seed);
	makeSftp(remote);
	const wired = remote as unknown as Parameters<typeof ssh.state.registry.set>[1] & { makeShell: () => FakeShell };
	wired.makeShell = () => new ssh.Stream() as unknown as FakeShell;
	ssh.state.registry.set(`${host}:${port}`, wired);
	return remote;
}

function resetSsh(): void {
	ssh.state.registry.clear();
	ssh.state.attempts.length = 0;
	ssh.state.clients.length = 0;
}

/** The client behind the most recent connection, for simulating a dropped link. */
function lastClient(): FakeClient {
	const client = ssh.state.clients.at(-1) as unknown as FakeClient;
	if (!client) throw new Error("no ssh client has connected yet");
	return client;
}

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

/** A plugin_message reply or a pushed event, as recorded by host.sendTo. */
interface Reply {
	[key: string]: unknown;
}

const CLIENT = "client-a";
const OTHER_CLIENT = "client-b";

/** The plugin's protocol constants, mirrored so each size guard can be tested by value. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_EXEC_OUTPUT = 256 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SSH_HOSTS = 32;

/** The host's fs gate is exact string membership, not a family prefix: canUse only
 *  accepts "fs", "fs:read" or "fs:write", so the descriptive "fs:workspace+ssh" this
 *  plugin used to declare satisfied nothing and was denied in strict mode. The
 *  workspace + SSH scope it described is documented in the plugin README instead. */
const PERMISSIONS = ["fs", "net:ssh", "terminal"];

/** CJK scan for one runtime string, using the class repo-files.ts defines. */
function cjkIn(text: string): string[] {
	return text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? [];
}

/** Assert a string the plugin produced at runtime is English. */
function expectEnglish(text: string): void {
	expect(cjkIn(text), `expected English, got: ${text}`).toEqual([]);
}

interface Harness {
	host: MockHost;
	root: string;
	pluginDir: string;
	base: string;
	deactivate: (() => void) | undefined;
	/** Send one plugin_message and return the single reply carrying its reqId. */
	call(action: string, extra?: Record<string, unknown>, clientId?: string): Promise<Reply>;
	/** Send one plugin_message that must not produce a reply at all. */
	silent(action: string, extra?: Record<string, unknown>, clientId?: string): Promise<void>;
	/** Every payload sent to a client, oldest first. */
	sent(clientId?: string): Reply[];
	/** Pushed events (payloads carrying `event`), oldest first. */
	events(name: string, clientId?: string): Reply[];
	broadcasts(): Record<string, unknown>[];
}

/** Let queued microtasks and macrotasks drain, so async replies have landed. */
async function settle(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

let entry: { activate(host: MockHost): (() => void | Promise<void>) | undefined };
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function startServer(seedWorkspace: (root: string) => void = () => {}): Promise<Harness> {
	const base = makeTempDir("vsc-editor-base-");
	const root = join(base, "workspace");
	const pluginDir = join(base, "plugins", "vscode-editor");
	mkdirSync(root, { recursive: true });
	mkdirSync(pluginDir, { recursive: true });
	seedWorkspace(root);

	const host = createMockHost({ dir: pluginDir, dataDir: join(base, "plugins"), cwd: root, permissions: PERMISSIONS });
	let reqSeq = 0;
	const harness: Harness = {
		host,
		root,
		pluginDir,
		base,
		deactivate: undefined,
		sent(clientId = CLIENT) {
			return host.recorded.sent.filter((s) => s.clientId === clientId).map((s) => s.payload as Reply);
		},
		events(name, clientId = CLIENT) {
			return harness.sent(clientId).filter((p) => p.event === name);
		},
		broadcasts() {
			return host.recorded.broadcasts as Record<string, unknown>[];
		},
		async call(action, extra = {}, clientId = CLIENT) {
			const reqId = `req-${(reqSeq += 1)}`;
			const before = host.recorded.sent.length;
			await host.emit.message({ action, reqId, ...extra }, clientId);
			await settle();
			const matches = host.recorded.sent
				.slice(before)
				.filter((s) => s.clientId === clientId && (s.payload as Reply).reqId === reqId);
			expect(matches, `expected exactly one reply for reqId ${reqId} (${action})`).toHaveLength(1);
			return matches[0]!.payload as Reply;
		},
		async silent(action, extra = {}, clientId = CLIENT) {
			const before = host.recorded.sent.length;
			await host.emit.message({ action, ...extra }, clientId);
			await settle();
			expect(host.recorded.sent.slice(before), `${action} must not answer`).toHaveLength(0);
		},
	};
	const deactivate = entry.activate(host);
	harness.deactivate = typeof deactivate === "function" ? deactivate : undefined;
	await settle();
	return harness;
}

/** A workspace with real content, ignored noise, a symlink and an upload temp file. */
function seedTreeWorkspace(root: string): void {
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "README.md"), "# hello\n");
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "nested", "b.ts"), "export const b = 2;\n");
	writeFileSync(join(root, "docs", "guide.md"), "guide\n");
	writeFileSync(join(root, "node_modules", "dep", "index.js"), "noise\n");
	writeFileSync(join(root, ".git", "config"), "noise\n");
	writeFileSync(join(root, "dist", "bundle.js"), "noise\n");
	writeFileSync(join(root, ".vsc-upload-abc123.part"), "partial\n");
	symlinkSync(join(root, "src"), join(root, "src-link"));
}

/** Entry names from a `list` reply, in the order the plugin returned them. */
function names(reply: Reply): string[] {
	return (reply.entries as { name: string }[]).map((e) => e.name);
}

beforeAll(async () => {
	entry = (await import("../../plugins/vscode-editor/src/index")).default as typeof entry;
});

beforeEach(() => {
	resetSsh();
});

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Manifest contract
// ---------------------------------------------------------------------------

describe("vscode-editor manifest", () => {
	const plugin = loadPlugin("vscode-editor");

	it("keeps the upstream id and version", () => {
		expect(plugin.id).toBe("vscode-editor");
		expect(plugin.manifest.version).toBe("0.3.1");
	});

	it("carries an English display name and a description covering the features", () => {
		expect(plugin.manifest.name).toBe("Editor");
		const description = plugin.manifest.description ?? "";
		expect(description.length).toBeGreaterThan(30);
		for (const feature of ["file tree", "terminal", "Remote-SSH", "SFTP"]) {
			expect(description, `description should mention ${feature}`).toContain(feature);
		}
		expect(cjkIn(description)).toEqual([]);
		expect(cjkIn(String(plugin.manifest.name))).toEqual([]);
	});

	it("drops descriptionEn, which this English-only repo does not use", () => {
		expect(Object.keys(plugin.raw)).not.toContain("descriptionEn");
	});

	it("preserves the security-relevant permission strings exactly", () => {
		// Host-enforced capability declarations, not prose: any drift here silently
		// changes what the plugin is allowed to do at runtime.
		expect(plugin.manifest.permissions).toEqual(PERMISSIONS);
	});

	it("adds no manifest key the upstream plugin did not have", () => {
		expect(Object.keys(plugin.raw).sort()).toEqual(["build", "description", "id", "name", "permissions", "version"]);
	});
});

// ---------------------------------------------------------------------------
// English-only invariant for the files this unit owns
// ---------------------------------------------------------------------------

describe("vscode-editor server English-only invariant", () => {
	/** Everything this unit owns. src/client.* belongs to the client-side unit. */
	function ownedFiles(): string[] {
		const srcDir = repoPath("plugins/vscode-editor/src");
		const sources = existsSync(srcDir)
			? readdirSync(srcDir)
					.filter((name) => !name.startsWith("client"))
					.map((name) => `plugins/vscode-editor/src/${name}`)
			: [];
		return [
			...sources,
			"plugins/vscode-editor/manifest.json",
			"plugins/vscode-editor/README.md",
			"tests/unit/vscode-editor-server.test.ts",
			"tests/unit/vscode-editor-server-deps.test.ts",
		];
	}

	it("has TypeScript sources to scan", () => {
		expect(ownedFiles()).toContain("plugins/vscode-editor/src/index.ts");
	});

	it("contains no CJK character in any owned source", () => {
		const offenders: string[] = [];
		for (const rel of ownedFiles()) {
			if (!existsSync(repoPath(rel))) continue;
			offenders.push(...formatCjkHits(rel, findCjk(rel)));
		}
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	it("compiles to an index.mjs with no CJK character", () => {
		const artifact = "plugins/vscode-editor/index.mjs";
		const built = buildPlugin("vscode-editor");
		expect(built.ok, `build failed:\n${built.stderr}\n${built.stdout}`).toBe(true);
		expect(existsSync(repoPath(artifact)), "index.mjs was not produced").toBe(true);
		expect(formatCjkHits(artifact, findCjk(artifact)), "compiled server artifact still contains Chinese").toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Activation surface
// ---------------------------------------------------------------------------

describe("activate()", () => {
	it("exports the host contract shape and returns a deactivate function", async () => {
		const mod = await import("../../plugins/vscode-editor/src/index");
		expect(Object.keys(mod.default)).toEqual(["activate"]);
		const h = await startServer();
		expect(typeof h.deactivate).toBe("function");
		h.deactivate?.();
	});

	it("registers only its message, attach and cwd handlers, and trips no capability gate", async () => {
		const h = await startServer();
		expect(h.host.recorded.handlers.message.size).toBe(1);
		expect(h.host.recorded.handlers.attach.size).toBe(1);
		expect(h.host.recorded.handlers.cwdChange.size).toBe(1);
		// The manifest declares fs/net/terminal but the plugin serves everything over
		// the message channel: no http route, agent tool, slash command or background
		// task. Anything registered outside its permissions would land in rejections.
		expect(h.host.recorded.routes.size).toBe(0);
		expect(h.host.recorded.agentTools.size).toBe(0);
		expect(h.host.recorded.commands.size).toBe(0);
		expect(h.host.recorded.backgroundTasks.size).toBe(0);
		expect(h.host.recorded.rejections).toEqual([]);
		expect(h.host.recorded.legacyWarnings).toEqual([]);
		h.deactivate?.();
	});

	it("pushes the full redacted state to a newly attached client", async () => {
		const h = await startServer();
		await h.host.emit.attach(OTHER_CLIENT);
		await settle();
		const pushed = h.sent(OTHER_CLIENT).filter((p) => p.kind === "state");
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.state).toMatchObject({ hosts: [], conns: [], depsInstalling: false });
		h.deactivate?.();
	});

	it("answers an unknown action with an English error envelope", async () => {
		const h = await startServer();
		const reply = await h.call("no_such_action");
		expect(reply.res).toBe(true);
		expect(reply.ok).toBe(false);
		expect(typeof reply.error).toBe("string");
		expect((reply.error as string).length).toBeGreaterThan(0);
		expectEnglish(reply.error as string);
		h.deactivate?.();
	});

	it("survives a null payload and still answers", async () => {
		const h = await startServer();
		await h.host.emit.message(null, CLIENT);
		await settle();
		const failures = h.sent().filter((p) => p.ok === false);
		expect(failures).toHaveLength(1);
		expectEnglish(String(failures[0]!.error));
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// Local file tree
// ---------------------------------------------------------------------------

describe("list / flatlist", () => {
	it("lists one level, directories first, skipping noise, symlinks and upload temps", async () => {
		const h = await startServer(seedTreeWorkspace);
		const reply = await h.call("list", { dir: "" });
		expect(reply).toMatchObject({ ok: true, action: "list", dir: "" });
		expect(reply.entries).toEqual([
			{ name: "docs", type: "dir" },
			{ name: "src", type: "dir" },
			{ name: "README.md", type: "file" },
		]);
		h.deactivate?.();
	});

	it("omits every ignored name, the symlink and the in-flight upload temp", async () => {
		const h = await startServer(seedTreeWorkspace);
		const listed = names(await h.call("list", { dir: "" }));
		for (const hidden of ["node_modules", ".git", "dist", "src-link", ".vsc-upload-abc123.part"]) {
			expect(listed, `${hidden} must not be listed`).not.toContain(hidden);
		}
		expect(names(await h.call("list", { dir: "src" }))).toEqual(["nested", "a.ts"]);
		h.deactivate?.();
	});

	it("normalises the reported directory to forward slashes", async () => {
		const h = await startServer(seedTreeWorkspace);
		const reply = await h.call("list", { dir: join("src", "nested") });
		expect(reply.dir).toBe("src/nested");
		expect(names(reply)).toEqual(["b.ts"]);
		h.deactivate?.();
	});

	it("reports a missing directory as an error rather than an empty list", async () => {
		const h = await startServer(seedTreeWorkspace);
		const reply = await h.call("list", { dir: "docs/missing" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("flatlists the whole workspace as wire-relative posix paths", async () => {
		const h = await startServer(seedTreeWorkspace);
		const reply = await h.call("flatlist");
		expect(reply).toMatchObject({ ok: true, truncated: false });
		expect([...(reply.files as string[])].sort()).toEqual(
			["README.md", "docs/guide.md", "src/a.ts", "src/nested/b.ts"].sort(),
		);
		h.deactivate?.();
	});

	it("flatlists an empty workspace as an empty, non-truncated list", async () => {
		const h = await startServer();
		expect(await h.call("flatlist")).toMatchObject({ ok: true, files: [], truncated: false });
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// Path containment - the security boundary
// ---------------------------------------------------------------------------

/** Paths that resolve outside the workspace root on every platform: these must be
 *  refused outright, not merely reported as missing. */
const TRAVERSALS = [
	"../outside.txt",
	"../../outside.txt",
	"src/../../outside.txt",
	"/etc/passwd",
	"../../../../../../etc/shadow",
];

/** A wider set that also includes platform-specific and encoded forms. On POSIX the
 *  encoded ones are literal (nonexistent) names and the Windows absolute path is a
 *  literal name too, so they are refused by ENOENT rather than by containment - what
 *  must hold everywhere is that nothing outside the root is ever touched. */
const ESCAPES = [
	...TRAVERSALS,
	"C:\\Windows\\win.ini",
	"%2e%2e%2foutside.txt",
	"..%2foutside.txt",
	"src/a.ts\u0000.png",
];

describe("workspace-root containment", () => {
	it("refuses to read or download anything that leaves the workspace root", async () => {
		const h = await startServer(seedTreeWorkspace);
		writeFileSync(join(h.base, "outside.txt"), "TOP SECRET\n");
		for (const path of ESCAPES) {
			for (const action of ["read", "download"]) {
				const reply = await h.call(action, { path });
				expect(reply.ok, `${action} ${JSON.stringify(path)} must be refused`).toBe(false);
				expect(reply.text, `${action} must not leak content`).toBeUndefined();
				expect(reply.b64, `${action} must not leak bytes`).toBeUndefined();
				expectEnglish(String(reply.error));
			}
		}
		h.deactivate?.();
	});

	it("refuses every traversal outright for mutating actions", async () => {
		const h = await startServer(seedTreeWorkspace);
		writeFileSync(join(h.base, "outside.txt"), "TOP SECRET\n");
		for (const path of TRAVERSALS) {
			for (const [action, extra] of [
				["write", { path, text: "pwned" }],
				["create", { path, kind: "file" }],
				["rename", { path, newName: "x" }],
				["delete", { path }],
				["upload_begin", { dir: path, name: "payload.txt", size: 5 }],
			] as [string, Record<string, unknown>][]) {
				const reply = await h.call(action, extra);
				expect(reply.ok, `${action} must refuse ${JSON.stringify(path)}`).toBe(false);
				expectEnglish(String(reply.error));
			}
		}
		expect(readFileSync(join(h.base, "outside.txt"), "utf8")).toBe("TOP SECRET\n");
		expect(readdirSync(h.base).sort()).toEqual(["outside.txt", "plugins", "workspace"]);
		h.deactivate?.();
	});

	it("never creates, renames or deletes anything outside the root, for any escape form", async () => {
		const h = await startServer(seedTreeWorkspace);
		writeFileSync(join(h.base, "canary.txt"), "untouched\n");
		const before = readdirSync(h.base).sort();
		for (const path of ESCAPES) {
			await h.call("write", { path, text: "pwned" });
			await h.call("create", { path, kind: "file" });
			await h.call("create", { path, kind: "dir" });
			await h.call("rename", { path, newName: "renamed" });
			await h.call("delete", { path });
			await h.call("upload_begin", { dir: path, name: "payload.txt", size: 5 });
		}
		expect(readdirSync(h.base).sort()).toEqual(before);
		expect(readFileSync(join(h.base, "canary.txt"), "utf8")).toBe("untouched\n");
		expect(readdirSync(h.base).filter((n) => n.startsWith(".vsc-upload-"))).toEqual([]);
		h.deactivate?.();
	});

	it("refuses the workspace root itself for write, create, rename, delete and download", async () => {
		const h = await startServer(seedTreeWorkspace);
		for (const action of ["write", "create", "rename", "delete", "download"]) {
			const reply = await h.call(action, { path: "", newName: "x" });
			expect(reply.ok, `${action} on the root must be refused`).toBe(false);
			expectEnglish(String(reply.error));
		}
		expect(readdirSync(h.root)).toContain("README.md");
		h.deactivate?.();
	});

	it("still serves a path that contains a dot segment but stays inside the root", async () => {
		const h = await startServer(seedTreeWorkspace);
		const reply = await h.call("read", { path: "src/../README.md" });
		expect(reply).toMatchObject({ ok: true, text: "# hello\n" });
		h.deactivate?.();
	});

	it("re-anchors containment when the workspace root moves", async () => {
		const h = await startServer(seedTreeWorkspace);
		const next = join(h.base, "moved");
		mkdirSync(next, { recursive: true });
		writeFileSync(join(next, "inside.txt"), "in\n");
		await h.host.emit.notifyCwd(next);
		await settle();
		expect((await h.call("read", { path: "inside.txt" })).ok).toBe(true);
		// The old root is now outside the workspace.
		expect((await h.call("read", { path: "../workspace/README.md" })).ok).toBe(false);
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe("read", () => {
	it("reads a utf-8 text file", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "a.txt"), "line one\nline two\n"));
		const reply = await h.call("read", { path: "a.txt" });
		expect(reply).toMatchObject({ ok: true, action: "read", path: "a.txt", encoding: "utf-8", size: 18 });
		expect(reply.text).toBe("line one\nline two\n");
		expect(reply.binary).toBeUndefined();
		h.deactivate?.();
	});

	it("flags a file containing a NUL byte as binary and withholds the text", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "b.bin"), Buffer.from([0x61, 0x00, 0x62])));
		const reply = await h.call("read", { path: "b.bin" });
		expect(reply).toMatchObject({ ok: true, binary: true, size: 3 });
		expect(reply.text).toBeUndefined();
		h.deactivate?.();
	});

	it("flags a file whose control-character ratio is above the threshold as binary", async () => {
		// 3 control bytes out of 100 = 3% > 2%, and no NUL, so the ratio branch decides.
		const mostlyControl = Buffer.concat([Buffer.from([0x01, 0x02, 0x03]), Buffer.alloc(97, 0x61)]);
		const h = await startServer((root) => writeFileSync(join(root, "c.bin"), mostlyControl));
		expect(await h.call("read", { path: "c.bin" })).toMatchObject({ ok: true, binary: true, size: 100 });
		h.deactivate?.();
	});

	it("keeps a file just under the control-character ratio as text", async () => {
		// 1 control byte out of 100 = 1% < 2%.
		const mostlyText = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(99, 0x61)]);
		const h = await startServer((root) => writeFileSync(join(root, "d.txt"), mostlyText));
		const reply = await h.call("read", { path: "d.txt" });
		expect(reply.ok).toBe(true);
		expect(reply.binary).toBeUndefined();
		expect((reply.text as string).length).toBe(100);
		h.deactivate?.();
	});

	it("decodes strict-utf8-invalid bytes through the GBK fallback", async () => {
		// 0xD6D0 0xCEC4 is valid GBK (two characters) and invalid UTF-8. The result is
		// asserted by length so this test file itself stays free of CJK: the latin1
		// fallback would produce four characters instead of two.
		const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
		const h = await startServer((root) => writeFileSync(join(root, "gbk.txt"), gbk));
		const reply = await h.call("read", { path: "gbk.txt" });
		expect(reply.ok).toBe(true);
		expect((reply.text as string).length).toBe(2);
		expect(reply.size).toBe(4);
		h.deactivate?.();
	});

	it("falls back to latin1 when neither utf-8 nor gbk can decode the bytes", async () => {
		// A lone 0xC3 is an invalid UTF-8 lead byte and an invalid GBK sequence.
		const h = await startServer((root) => writeFileSync(join(root, "latin.txt"), Buffer.from([0xc3])));
		expect((await h.call("read", { path: "latin.txt" })).text).toBe("\u00c3");
		h.deactivate?.();
	});

	it("reads an empty file as empty text, not as binary", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "empty.txt"), ""));
		expect(await h.call("read", { path: "empty.txt" })).toMatchObject({ ok: true, text: "", size: 0 });
		h.deactivate?.();
	});

	it("refuses a directory, a missing file and a file above the read limit", async () => {
		const h = await startServer((root) => {
			mkdirSync(join(root, "nested"), { recursive: true });
			writeFileSync(join(root, "huge.bin"), "");
			// Sparse: the size guard fires before a single byte is read.
			truncateSync(join(root, "huge.bin"), MAX_READ_BYTES + 1);
		});
		expect((await h.call("read", { path: "nested" })).ok).toBe(false);
		const missing = await h.call("read", { path: "nope.txt" });
		expect(missing.ok).toBe(false);
		expectEnglish(String(missing.error));
		const huge = await h.call("read", { path: "huge.bin" });
		expect(huge.ok).toBe(false);
		expectEnglish(String(huge.error));
		h.deactivate?.();
	});

	it("refuses a path that is not a string", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "a.txt"), "x"));
		expect((await h.call("read", { path: 42 })).ok).toBe(false);
		expect((await h.call("read", {})).ok).toBe(false);
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// write / create / rename / delete
// ---------------------------------------------------------------------------

describe("write", () => {
	it("writes a file, creating missing parent directories", async () => {
		const h = await startServer();
		const reply = await h.call("write", { path: "deep/nested/new.txt", text: "content" });
		expect(reply).toMatchObject({ ok: true, action: "write", path: "deep/nested/new.txt" });
		expect(readFileSync(join(h.root, "deep/nested/new.txt"), "utf8")).toBe("content");
		h.deactivate?.();
	});

	it("overwrites an existing file", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "a.txt"), "old"));
		expect((await h.call("write", { path: "a.txt", text: "new" })).ok).toBe(true);
		expect(readFileSync(join(h.root, "a.txt"), "utf8")).toBe("new");
		h.deactivate?.();
	});

	it("coerces a missing text field to an empty file rather than failing", async () => {
		const h = await startServer();
		expect((await h.call("write", { path: "blank.txt" })).ok).toBe(true);
		expect(readFileSync(join(h.root, "blank.txt"), "utf8")).toBe("");
		h.deactivate?.();
	});

	it("leaves no temporary file behind after an atomic write", async () => {
		const h = await startServer();
		await h.call("write", { path: "atomic.txt", text: "data" });
		expect(readdirSync(h.root)).toEqual(["atomic.txt"]);
		h.deactivate?.();
	});
});

describe("create", () => {
	it("creates a directory and a file inside it", async () => {
		const h = await startServer();
		expect((await h.call("create", { path: "folder", kind: "dir" })).ok).toBe(true);
		expect((await h.call("create", { path: "folder/file.txt", kind: "file" })).ok).toBe(true);
		expect(readdirSync(join(h.root, "folder"))).toEqual(["file.txt"]);
		h.deactivate?.();
	});

	it("refuses to clobber an existing file", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "exists.txt"), "x"));
		const reply = await h.call("create", { path: "exists.txt", kind: "file" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(readFileSync(join(h.root, "exists.txt"), "utf8")).toBe("x");
		h.deactivate?.();
	});

	it("refuses a directory that already exists", async () => {
		const h = await startServer((root) => mkdirSync(join(root, "d")));
		expect((await h.call("create", { path: "d", kind: "dir" })).ok).toBe(false);
		h.deactivate?.();
	});
});

describe("rename", () => {
	it("renames within the same directory", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "old.txt"), "keep"));
		expect(await h.call("rename", { path: "old.txt", newName: "new.txt" })).toMatchObject({
			ok: true,
			action: "rename",
		});
		expect(existsSync(join(h.root, "old.txt"))).toBe(false);
		expect(readFileSync(join(h.root, "new.txt"), "utf8")).toBe("keep");
		h.deactivate?.();
	});

	it.each([
		["a slash", "sub/name.txt"],
		["a backslash", "sub\\name.txt"],
		["a parent hop", ".."],
		["an embedded parent hop", "a..b"],
		["an empty name", ""],
		["whitespace only", "   "],
	])("refuses a new name containing %s", async (_label, newName) => {
		const h = await startServer((root) => writeFileSync(join(root, "keep.txt"), "keep"));
		const reply = await h.call("rename", { path: "keep.txt", newName });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(readFileSync(join(h.root, "keep.txt"), "utf8")).toBe("keep");
		expect(existsSync(join(h.base, "keep.txt"))).toBe(false);
		h.deactivate?.();
	});

	it("refuses a non-string new name, a missing new name and a missing source", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "a.txt"), "x"));
		expect((await h.call("rename", { path: "a.txt", newName: 42 })).ok).toBe(false);
		expect((await h.call("rename", { path: "a.txt" })).ok).toBe(false);
		const missing = await h.call("rename", { path: "ghost.txt", newName: "x.txt" });
		expect(missing.ok).toBe(false);
		expectEnglish(String(missing.error));
		expect(readFileSync(join(h.root, "a.txt"), "utf8")).toBe("x");
		h.deactivate?.();
	});
});

describe("delete", () => {
	it("deletes a file and a whole directory tree", async () => {
		const h = await startServer((root) => {
			writeFileSync(join(root, "a.txt"), "x");
			mkdirSync(join(root, "tree", "deep"), { recursive: true });
			writeFileSync(join(root, "tree", "deep", "b.txt"), "y");
		});
		expect((await h.call("delete", { path: "a.txt" })).ok).toBe(true);
		expect((await h.call("delete", { path: "tree" })).ok).toBe(true);
		expect(existsSync(join(h.root, "a.txt"))).toBe(false);
		expect(existsSync(join(h.root, "tree"))).toBe(false);
		h.deactivate?.();
	});

	it("reports a missing entry as an error", async () => {
		const h = await startServer();
		const reply = await h.call("delete", { path: "ghost.txt" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// download (local half)
// ---------------------------------------------------------------------------

describe("local download", () => {
	it("returns base64 content and the exact size", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "f.txt"), "hello"));
		const reply = await h.call("download", { path: "f.txt" });
		expect(reply).toMatchObject({ ok: true, action: "download", size: 5 });
		expect(Buffer.from(String(reply.b64), "base64").toString("utf8")).toBe("hello");
		h.deactivate?.();
	});

	it("refuses a directory, a missing file and a file above the download limit", async () => {
		const h = await startServer((root) => {
			mkdirSync(join(root, "d"), { recursive: true });
			writeFileSync(join(root, "huge.bin"), "");
			truncateSync(join(root, "huge.bin"), MAX_UPLOAD_BYTES + 1);
		});
		expect((await h.call("download", { path: "d" })).ok).toBe(false);
		expect((await h.call("download", { path: "ghost" })).ok).toBe(false);
		const huge = await h.call("download", { path: "huge.bin" });
		expect(huge.ok).toBe(false);
		expect(huge.b64).toBeUndefined();
		expectEnglish(String(huge.error));
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// Upload protocol (local half)
// ---------------------------------------------------------------------------

describe("upload protocol", () => {
	const payload = Buffer.from("the quick brown fox jumps over the lazy dog");

	it("streams chunks into an atomic file and hides the temp part while in flight", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "keep.txt"), "x"));
		const begin = await h.call("upload_begin", { dir: "", name: "up.txt", size: payload.length });
		expect(begin).toMatchObject({ ok: true, exists: false });
		const uploadId = String(begin.uploadId);
		expect(typeof uploadId).toBe("string");
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toHaveLength(1);
		// The in-flight temp file must not show up in the tree.
		expect(names(await h.call("list", { dir: "" }))).toEqual(["keep.txt"]);

		const chunks = [payload.subarray(0, 10), payload.subarray(10, 20), payload.subarray(20)];
		for (let i = 0; i < chunks.length; i += 1) {
			const reply = await h.call("upload", { uploadId, i, total: chunks.length, b64: chunks[i]!.toString("base64") });
			expect(reply.ok).toBe(true);
			if (i < chunks.length - 1) expect(reply.received).toBe(i + 1);
			else expect(reply).toMatchObject({ done: true, size: payload.length });
		}
		expect(readFileSync(join(h.root, "up.txt"))).toEqual(payload);
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toEqual([]);
		h.deactivate?.();
	});

	it("reports exists:true for a target that is already there and overwrites it", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "dup.txt"), "old"));
		const begin = await h.call("upload_begin", { dir: "", name: "dup.txt", size: 3 });
		expect(begin).toMatchObject({ ok: true, exists: true });
		const reply = await h.call("upload", {
			uploadId: begin.uploadId,
			i: 0,
			total: 1,
			b64: Buffer.from("new").toString("base64"),
		});
		expect(reply).toMatchObject({ ok: true, done: true, size: 3 });
		expect(readFileSync(join(h.root, "dup.txt"), "utf8")).toBe("new");
		h.deactivate?.();
	});

	it("creates the target directory when it does not exist yet", async () => {
		const h = await startServer();
		const begin = await h.call("upload_begin", { dir: "fresh/deep", name: "f.txt", size: 2 });
		expect(begin.ok).toBe(true);
		await h.call("upload", { uploadId: begin.uploadId, i: 0, total: 1, b64: Buffer.from("hi").toString("base64") });
		expect(readFileSync(join(h.root, "fresh/deep/f.txt"), "utf8")).toBe("hi");
		h.deactivate?.();
	});

	it.each([
		["an empty name", { name: "", size: 4 }],
		["a name with a slash", { name: "a/b.txt", size: 4 }],
		["a name with a backslash", { name: "a\\b.txt", size: 4 }],
		["a name with a parent hop", { name: "..", size: 4 }],
		["a zero size", { name: "a.txt", size: 0 }],
		["a negative size", { name: "a.txt", size: -1 }],
		["a non-numeric size", { name: "a.txt", size: "big" }],
		["a size above the limit", { name: "a.txt", size: MAX_UPLOAD_BYTES + 1 }],
	])("refuses upload_begin with %s", async (_label, extra) => {
		const h = await startServer();
		const reply = await h.call("upload_begin", { dir: "", ...extra });
		expect(reply.ok).toBe(false);
		expect(reply.uploadId).toBeUndefined();
		expectEnglish(String(reply.error));
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toEqual([]);
		h.deactivate?.();
	});

	it("refuses out-of-order, empty and unknown-session chunks", async () => {
		const h = await startServer();
		const begin = await h.call("upload_begin", { dir: "", name: "seq.txt", size: 6 });
		const uploadId = String(begin.uploadId);
		const b64 = Buffer.from("abc").toString("base64");

		const outOfOrder = await h.call("upload", { uploadId, i: 1, total: 2, b64 });
		expect(outOfOrder.ok).toBe(false);
		expectEnglish(String(outOfOrder.error));

		expect((await h.call("upload", { uploadId, i: 0, total: 2, b64: "" })).ok).toBe(false);

		const unknown = await h.call("upload", { uploadId: "u-does-not-exist", i: 0, total: 1, b64 });
		expect(unknown.ok).toBe(false);
		expectEnglish(String(unknown.error));

		expect(existsSync(join(h.root, "seq.txt"))).toBe(false);
		h.deactivate?.();
	});

	it("isolates upload sessions per client", async () => {
		const h = await startServer();
		const begin = await h.call("upload_begin", { dir: "", name: "iso.txt", size: 3 }, CLIENT);
		const stolen = await h.call(
			"upload",
			{ uploadId: begin.uploadId, i: 0, total: 1, b64: Buffer.from("abc").toString("base64") },
			OTHER_CLIENT,
		);
		expect(stolen.ok).toBe(false);
		expect(existsSync(join(h.root, "iso.txt"))).toBe(false);
		h.deactivate?.();
	});

	it("upload_abort removes the temp file and ends the session", async () => {
		const h = await startServer();
		const begin = await h.call("upload_begin", { dir: "", name: "abort.txt", size: 3 });
		const uploadId = String(begin.uploadId);
		await h.call("upload", { uploadId, i: 0, total: 2, b64: Buffer.from("ab").toString("base64") });
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toHaveLength(1);

		expect((await h.call("upload_abort", { uploadId })).ok).toBe(true);
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toEqual([]);
		expect(existsSync(join(h.root, "abort.txt"))).toBe(false);
		expect((await h.call("upload", { uploadId, i: 1, total: 2, b64: Buffer.from("c").toString("base64") })).ok).toBe(
			false,
		);
		h.deactivate?.();
	});

	it("upload_abort for an unknown session still answers ok", async () => {
		const h = await startServer();
		expect((await h.call("upload_abort", { uploadId: "nope" })).ok).toBe(true);
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// SFTP sync configuration
// ---------------------------------------------------------------------------

const SYNC_PATH = ".vscode/sftp.json";

function writeSyncConfig(root: string, config: unknown): void {
	mkdirSync(join(root, ".vscode"), { recursive: true });
	writeFileSync(join(root, ".vscode", "sftp.json"), JSON.stringify(config));
}

describe("SFTP sync configuration", () => {
	it("reports an unconfigured workspace", async () => {
		const h = await startServer();
		const reply = await h.call("sync_get");
		expect(reply).toMatchObject({ ok: true, action: "sync_get", configPath: SYNC_PATH });
		expect(reply.config).toEqual({ configured: false });
		h.deactivate?.();
	});

	it("rejects a blank host and a relative remote root", async () => {
		const h = await startServer();
		const blank = await h.call("sync_save", { config: { host: "  ", remoteRoot: "/var/www" } });
		expect(blank.ok).toBe(false);
		expectEnglish(String(blank.error));
		const relative = await h.call("sync_save", { config: { host: "sftp.example.com", remoteRoot: "var/www" } });
		expect(relative.ok).toBe(false);
		expectEnglish(String(relative.error));
		expect(existsSync(join(h.root, SYNC_PATH))).toBe(false);
		h.deactivate?.();
	});

	it("rejects a missing config object", async () => {
		const h = await startServer();
		expect((await h.call("sync_save", {})).ok).toBe(false);
		h.deactivate?.();
	});

	it("writes a vscode-sftp shaped config and never echoes the secret back", async () => {
		const h = await startServer();
		const reply = await h.call("sync_save", {
			config: {
				name: "staging",
				host: "sftp.example.com",
				port: 2222,
				username: "deploy",
				password: "sup3r-s3cret",
				remoteRoot: "/var/www",
				uploadOnSave: true,
				exclude: ["dist", "dist", "", "*.log"],
			},
		});
		expect(reply).toMatchObject({ ok: true, configPath: SYNC_PATH });
		expect(reply.config).toEqual({
			configured: true,
			name: "staging",
			host: "sftp.example.com",
			port: 2222,
			username: "deploy",
			remoteRoot: "/var/www",
			exclude: ["dist", "*.log"],
			uploadOnSave: true,
			hasPass: true,
			hasKey: false,
			hasAgent: false,
			privateKeyPath: "",
			agent: "",
		});
		// The response goes to a browser: the password must not travel in it.
		expect(JSON.stringify(reply)).not.toContain("sup3r-s3cret");
		expect(JSON.parse(readFileSync(join(h.root, SYNC_PATH), "utf8"))).toMatchObject({
			name: "staging",
			host: "sftp.example.com",
			port: 2222,
			username: "deploy",
			protocol: "sftp",
			remotePath: "/var/www",
			uploadOnSave: true,
			ignore: ["dist", "*.log"],
		});
		h.deactivate?.();
	});

	it("keeps a credential when the field is omitted and clears it on explicit null", async () => {
		const h = await startServer();
		const save = (extra: Record<string, unknown>) =>
			h.call("sync_save", { config: { host: "sftp.example.com", remoteRoot: "/var/www", ...extra } });
		await save({ password: "kept" });
		expect(((await save({})).config as { hasPass: boolean }).hasPass).toBe(true);
		const cleared = await save({ password: null });
		expect(cleared.ok).toBe(true);
		expect((cleared.config as { hasPass: boolean }).hasPass).toBe(false);
		h.deactivate?.();
	});

	it("reads a hand-written vscode-sftp config, including legacy watcher.autoUpload", async () => {
		const h = await startServer((root) =>
			writeSyncConfig(root, {
				host: "hand.example.com",
				port: 22,
				username: "ubuntu",
				remotePath: "/srv/app",
				privateKeyPath: "~/.ssh/id_rsa",
				ignore: [".git", "node_modules"],
				watcher: { autoUpload: true },
			}),
		);
		expect((await h.call("sync_get")).config).toMatchObject({
			configured: true,
			host: "hand.example.com",
			username: "ubuntu",
			remoteRoot: "/srv/app",
			exclude: [".git", "node_modules"],
			uploadOnSave: true,
			hasKey: true,
			privateKeyPath: "~/.ssh/id_rsa",
		});
		h.deactivate?.();
	});

	it("defaults the port, username and remote root when the config omits them", async () => {
		const h = await startServer((root) => writeSyncConfig(root, { host: "bare.example.com" }));
		expect((await h.call("sync_get")).config).toMatchObject({
			port: 22,
			username: "root",
			remoteRoot: "/",
			exclude: [],
			uploadOnSave: false,
		});
		h.deactivate?.();
	});

	it("treats an unparseable config file as unconfigured instead of crashing", async () => {
		const h = await startServer((root) => {
			mkdirSync(join(root, ".vscode"), { recursive: true });
			writeFileSync(join(root, ".vscode", "sftp.json"), "{ not json");
		});
		expect(await h.call("sync_get")).toMatchObject({ ok: true, config: { configured: false } });
		h.deactivate?.();
	});

	it("migrates a legacy per-plugin sync-configs.json into the workspace once", async () => {
		const h = await startServer();
		writeFileSync(
			join(h.pluginDir, "sync-configs.json"),
			JSON.stringify({ [h.root]: { host: "legacy.example.com", username: "deploy", remotePath: "/var/legacy" } }),
		);
		expect((await h.call("sync_get")).config).toMatchObject({
			configured: true,
			host: "legacy.example.com",
			username: "deploy",
			remoteRoot: "/var/legacy",
		});
		expect(existsSync(join(h.root, SYNC_PATH))).toBe(true);
		h.deactivate?.();
	});

	it("ignores a legacy store that has no entry for this workspace", async () => {
		const h = await startServer();
		writeFileSync(join(h.pluginDir, "sync-configs.json"), JSON.stringify({ "/some/other/root": { host: "x" } }));
		expect(await h.call("sync_get")).toMatchObject({ ok: true, config: { configured: false } });
		expect(existsSync(join(h.root, SYNC_PATH))).toBe(false);
		h.deactivate?.();
	});

	it("sync_ensure writes a starter template only when no config exists", async () => {
		const h = await startServer();
		expect(await h.call("sync_ensure")).toMatchObject({ ok: true, path: SYNC_PATH, configPath: SYNC_PATH });
		expect(JSON.parse(readFileSync(join(h.root, SYNC_PATH), "utf8"))).toMatchObject({
			remotePath: "/",
			ignore: [".git", "node_modules"],
		});

		writeSyncConfig(h.root, { host: "mine.example.com", remotePath: "/srv" });
		expect((await h.call("sync_ensure")).ok).toBe(true);
		expect(readFileSync(join(h.root, SYNC_PATH), "utf8")).toContain("mine.example.com");
		h.deactivate?.();
	});

	it("sync_test fails with an English message when sync is not configured", async () => {
		const h = await startServer();
		const reply = await h.call("sync_test");
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("sync_run fails with an English message when sync is not configured", async () => {
		const h = await startServer();
		const reply = await h.call("sync_run", { dir: "up", scope: "all", path: "" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// SSH host management and secret storage
// ---------------------------------------------------------------------------

interface PublicState {
	depsReady: boolean;
	depsInstalling: boolean;
	hosts: Record<string, unknown>[];
	conns: Record<string, unknown>[];
}

function stateOf(reply: Reply): PublicState {
	return reply.state as PublicState;
}

function firstHostId(reply: Reply): string {
	const hosts = stateOf(reply).hosts as { id: string }[];
	if (hosts.length === 0) throw new Error("no host was saved");
	return String(hosts[0]!.id);
}

describe("SSH host management", () => {
	it("starts with no hosts and no connections", async () => {
		const h = await startServer();
		const reply = await h.call("state");
		expect(reply).toMatchObject({ ok: true, action: "state" });
		expect(stateOf(reply)).toMatchObject({ hosts: [], conns: [], depsInstalling: false });
		h.deactivate?.();
	});

	it("reports the ssh2 dependency as ready once it has loaded", async () => {
		const h = await startServer();
		await vi.waitFor(() => expect(stateOf2(h)).resolves.toMatchObject({ depsReady: true }));
		h.deactivate?.();
	});

	it("stores the password as an encrypted secret and strips it from the JSON file", async () => {
		const h = await startServer();
		expect(
			(
				await h.call("hosts_save", {
					host: { name: "prod", host: "prod.example.com", port: 22, username: "deploy", password: "hunter2" },
				})
			).ok,
		).toBe(true);

		const file = readFileSync(join(h.pluginDir, "ssh-hosts.json"), "utf8");
		const saved = JSON.parse(file) as { hosts: Record<string, unknown>[] };
		expect(saved.hosts).toHaveLength(1);
		expect(saved.hosts[0]).toMatchObject({ name: "prod", host: "prod.example.com", port: 22, username: "deploy" });
		expect(file).not.toContain("hunter2");

		const id = String(saved.hosts[0]!.id);
		expect(h.host.secrets.get(`ssh:${id}:pass`)).toBe("hunter2");
		expect(h.host.secrets.list()).toEqual([`ssh:${id}:pass`]);

		const host = stateOf(await h.call("state")).hosts[0];
		expect(host).toEqual({
			id,
			name: "prod",
			host: "prod.example.com",
			port: 22,
			username: "deploy",
			hasPass: true,
			hasKey: false,
			hasPassphrase: false,
			privateKeyPath: "",
			agent: "",
		});
		expect(JSON.stringify(host)).not.toContain("hunter2");
		h.deactivate?.();
	});

	it("broadcasts a redacted state change after saving a host", async () => {
		const h = await startServer();
		await h.call("hosts_save", { host: { host: "b.example.com", password: "pw" } });
		const states = h.broadcasts().filter((b) => b.kind === "state");
		expect(states.length).toBeGreaterThan(0);
		expect(JSON.stringify(states)).not.toContain("pw");
		expect((states.at(-1)!.state as PublicState).hosts).toHaveLength(1);
		h.deactivate?.();
	});

	it("refuses a host without any credential", async () => {
		const h = await startServer();
		const reply = await h.call("hosts_save", { host: { host: "a.example.com" } });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(existsSync(join(h.pluginDir, "ssh-hosts.json"))).toBe(false);
		h.deactivate?.();
	});

	it("refuses a blank host address", async () => {
		const h = await startServer();
		const reply = await h.call("hosts_save", { host: { host: "   ", password: "pw" } });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("defaults the name, port and username on save", async () => {
		const h = await startServer();
		await h.call("hosts_save", { host: { host: "defaults.example.com", privateKey: "PEM" } });
		expect(stateOf(await h.call("state")).hosts[0]).toMatchObject({
			name: "defaults.example.com",
			port: 22,
			username: "root",
			hasKey: true,
			hasPass: false,
		});
		h.deactivate?.();
	});

	it("updates an existing host and keeps a credential that is left blank", async () => {
		const h = await startServer();
		await h.call("hosts_save", { host: { name: "old", host: "u.example.com", password: "first" } });
		const id = firstHostId(await h.call("state"));

		expect((await h.call("hosts_save", { host: { id, name: "new", host: "u.example.com", port: 2222 } })).ok).toBe(
			true,
		);
		expect(h.host.secrets.get(`ssh:${id}:pass`)).toBe("first");
		const hosts = stateOf(await h.call("state")).hosts;
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({ id, name: "new", port: 2222, hasPass: true });

		expect((await h.call("hosts_save", { host: { id, host: "u.example.com", password: null } })).ok).toBe(true);
		expect(h.host.secrets.get(`ssh:${id}:pass`)).toBeUndefined();
		expect(stateOf(await h.call("state")).hosts[0]).toMatchObject({ hasPass: false });
		h.deactivate?.();
	});

	it("refuses to update a host id that does not exist", async () => {
		const h = await startServer();
		const reply = await h.call("hosts_save", { host: { id: "h-ghost", host: "x.example.com" } });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("enforces the maximum number of saved hosts", async () => {
		const h = await startServer();
		for (let i = 0; i < MAX_SSH_HOSTS; i += 1) {
			expect((await h.call("hosts_save", { host: { host: `h${i}.example.com`, password: "pw" } })).ok).toBe(true);
		}
		const overflow = await h.call("hosts_save", { host: { host: "overflow.example.com", password: "pw" } });
		expect(overflow.ok).toBe(false);
		expectEnglish(String(overflow.error));
		expect(stateOf(await h.call("state")).hosts).toHaveLength(MAX_SSH_HOSTS);
		h.deactivate?.();
	});

	it("deletes a host together with all three secret fields", async () => {
		const h = await startServer();
		await h.call("hosts_save", { host: { host: "del.example.com", password: "pw", privateKey: "PEM" } });
		const id = firstHostId(await h.call("state"));
		h.host.secrets.set(`ssh:${id}:pp`, "passphrase");
		expect(h.host.secrets.list().sort()).toEqual([`ssh:${id}:key`, `ssh:${id}:pass`, `ssh:${id}:pp`].sort());

		expect((await h.call("hosts_delete", { id })).ok).toBe(true);
		expect(h.host.secrets.list()).toEqual([]);
		expect(stateOf(await h.call("state")).hosts).toEqual([]);
		expect(readFileSync(join(h.pluginDir, "ssh-hosts.json"), "utf8")).not.toContain("del.example.com");
		h.deactivate?.();
	});

	it("refuses to delete an unknown host", async () => {
		const h = await startServer();
		const reply = await h.call("hosts_delete", { id: "h-nope" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("drops the live connections of a deleted host", async () => {
		const h = await startServer();
		const { connId } = await connected(h);
		const id = firstHostId(await h.call("state"));
		expect((await h.call("hosts_delete", { id })).ok).toBe(true);
		expect(h.events("conn_closed").map((e) => e.connId)).toContain(connId);
		expect(stateOf(await h.call("state")).conns).toEqual([]);
		h.deactivate?.();
	});

	it("migrates the host list from the standalone ssh plugin directory", async () => {
		const h = await startServer();
		const legacyDir = join(h.pluginDir, "..", "ssh");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(
			join(legacyDir, "ssh-hosts.json"),
			JSON.stringify({
				hosts: [{ id: "legacy1", name: "Legacy", host: "legacy.example.com", port: 22, username: "root" }],
			}),
		);
		expect(stateOf(await h.call("state")).hosts).toEqual([
			{
				id: "legacy1",
				name: "Legacy",
				host: "legacy.example.com",
				port: 22,
				username: "root",
				hasPass: false,
				hasKey: false,
				hasPassphrase: false,
				privateKeyPath: "",
				agent: "",
			},
		]);
		h.deactivate?.();
	});

	it("moves plaintext credentials out of the store file into encrypted secrets", async () => {
		const h = await startServer();
		writeFileSync(
			join(h.pluginDir, "ssh-hosts.json"),
			JSON.stringify({
				hosts: [
					{ id: "plain1", name: "Plain", host: "plain.example.com", password: "cleartext-pw", privateKey: "PEM-BODY" },
				],
			}),
		);
		expect(stateOf(await h.call("state")).hosts[0]).toMatchObject({ id: "plain1", hasPass: true, hasKey: true });
		expect(h.host.secrets.get("ssh:plain1:pass")).toBe("cleartext-pw");
		expect(h.host.secrets.get("ssh:plain1:key")).toBe("PEM-BODY");
		const file = readFileSync(join(h.pluginDir, "ssh-hosts.json"), "utf8");
		expect(file).not.toContain("cleartext-pw");
		expect(file).not.toContain("PEM-BODY");
		h.deactivate?.();
	});

	it("rehydrates credentials from secrets when connecting", async () => {
		const h = await startServer();
		writeFileSync(
			join(h.pluginDir, "ssh-hosts.json"),
			JSON.stringify({ hosts: [{ id: "sec1", host: "sec.example.com", username: "u" }] }),
		);
		h.host.secrets.set("ssh:sec1:pass", "from-vault");
		addSshHost("sec.example.com", 22);
		expect((await h.call("connect", { id: "sec1" })).ok).toBe(true);
		expect(ssh.state.attempts).toHaveLength(1);
		expect(ssh.state.attempts[0]).toMatchObject({
			host: "sec.example.com",
			port: 22,
			username: "u",
			password: "from-vault",
			readyTimeout: 15000,
		});
		h.deactivate?.();
	});

	it("tolerates a corrupt host store file", async () => {
		const h = await startServer();
		writeFileSync(join(h.pluginDir, "ssh-hosts.json"), "]not json[");
		const reply = await h.call("state");
		expect(reply.ok).toBe(true);
		expect(stateOf(reply).hosts).toEqual([]);
		h.deactivate?.();
	});
});

/** Awaitable companion for vi.waitFor, which needs a promise-returning check. */
async function stateOf2(h: Harness): Promise<PublicState> {
	return stateOf(await h.call("state"));
}

// ---------------------------------------------------------------------------
// Connections and remote file operations
// ---------------------------------------------------------------------------

async function connected(
	h: Harness,
	seed?: Parameters<typeof makeRemote>[0],
): Promise<{ connId: string; remote: FakeRemote }> {
	const remote = addSshHost("remote.example.com", 22, seed);
	await h.call("hosts_save", {
		host: { name: "Remote", host: "remote.example.com", username: "tester", password: "pw" },
	});
	const reply = await h.call("connect", { id: firstHostId(await h.call("state")) });
	expect(reply.ok, `connect failed: ${String(reply.error)}`).toBe(true);
	expect(reply.action).toBe("connect");
	return { connId: String(reply.connId), remote };
}

describe("SSH connections", () => {
	it("connects and reports the connection in the public state", async () => {
		const h = await startServer();
		const { connId } = await connected(h);
		expect(connId).toMatch(/^c\d+$/);
		const state = stateOf(await h.call("state"));
		expect(state.conns).toHaveLength(1);
		expect(state.conns[0]).toMatchObject({ connId, label: "Remote", status: "connected" });
		expect(JSON.stringify(state)).not.toContain("pw");
		h.deactivate?.();
	});

	it("falls back to username@host for the label when no name is set", async () => {
		const h = await startServer();
		addSshHost("bare.example.com", 22);
		await h.call("hosts_save", { host: { host: "bare.example.com", username: "tester", password: "pw" } });
		const reply = await h.call("connect", { id: firstHostId(await h.call("state")) });
		expect(reply).toMatchObject({ ok: true, label: "tester@bare.example.com" });
		h.deactivate?.();
	});

	it("refuses to connect to an unknown host id", async () => {
		const h = await startServer();
		const reply = await h.call("connect", { id: "h-ghost" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("reports an authentication failure and leaves no half-open connection", async () => {
		const h = await startServer();
		// No host is registered in the double, so connect() rejects with a level.
		await h.call("hosts_save", { host: { name: "Bad", host: "unreachable.example.com", password: "pw" } });
		const reply = await h.call("connect", { id: firstHostId(await h.call("state")) });
		expect(reply).toMatchObject({ res: true, ok: false, action: "connect" });
		expectEnglish(String(reply.error));
		// The ssh2 error level is surfaced, which is how the UI tells auth from network.
		expect(String(reply.error)).toContain("client-authentication");
		expect(stateOf(await h.call("state")).conns).toEqual([]);
		h.deactivate?.();
	});

	it("disconnects on request, notifying the owner and clearing the state", async () => {
		const h = await startServer();
		const { connId } = await connected(h);
		expect((await h.call("disconnect", { connId })).ok).toBe(true);
		const closed = h.events("conn_closed");
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({ connId });
		expectEnglish(String(closed[0]!.reason));
		expect(stateOf(await h.call("state")).conns).toEqual([]);
		h.deactivate?.();
	});

	it("notifies the owner and clears the state when the remote hangs up", async () => {
		const h = await startServer();
		const { connId } = await connected(h);
		lastClient().emit("close");
		await settle();
		expect(h.events("conn_closed").map((e) => e.connId)).toEqual([connId]);
		expect(stateOf(await h.call("state")).conns).toEqual([]);
		h.deactivate?.();
	});

	it("notifies the owner when an established connection errors out", async () => {
		const h = await startServer();
		const { connId } = await connected(h);
		lastClient().emit("error", Object.assign(new Error("Connection lost"), { level: "client-timeout" }));
		await settle();
		const closed = h.events("conn_closed");
		expect(closed.map((e) => e.connId)).toEqual([connId]);
		expect(String(closed[0]!.reason)).toContain("Connection lost");
		h.deactivate?.();
	});

	it("refuses every remote action for an unknown connection id", async () => {
		const h = await startServer();
		const connId = "c-ghost";
		const attempts: [string, Record<string, unknown>][] = [
			["list", { connId, dir: "/" }],
			["read", { connId, path: "/etc/hosts" }],
			["write", { connId, path: "/tmp/x", text: "y" }],
			["create", { connId, path: "/tmp/x", kind: "file" }],
			["rename", { connId, path: "/tmp/x", newName: "y" }],
			["delete", { connId, path: "/tmp/x" }],
			["download", { connId, path: "/tmp/x" }],
			["disconnect", { connId }],
			["shell_close", { connId, shellId: "s1" }],
			["exec", { connId, cmd: "true" }],
			["upload_begin", { connId, dir: "/tmp", name: "x", size: 1 }],
		];
		for (const [action, extra] of attempts) {
			const reply = await h.call(action, extra);
			expect(reply.ok, `${action} must refuse a dead connection`).toBe(false);
			expectEnglish(String(reply.error));
		}
		h.deactivate?.();
	});

	it("ignores shell_input and shell_resize for a dead connection instead of answering", async () => {
		const h = await startServer();
		await h.silent("shell_input", { connId: "c-ghost", shellId: "s1", b64: Buffer.from("x").toString("base64") });
		await h.silent("shell_resize", { connId: "c-ghost", shellId: "s1", rows: 10, cols: 10 });
		h.deactivate?.();
	});
});

describe("remote file operations over SFTP", () => {
	const seed = {
		dirs: ["/home", "/home/tester", "/home/tester/sub"],
		files: { "/home/tester/a.txt": "hello remote\n", "/home/tester/sub/b.txt": "nested\n" },
		links: ["/home/tester/lnk"],
	};

	it("lists a remote directory, directories first, with sizes and link types", async () => {
		const h = await startServer();
		const { connId } = await connected(h, seed);
		const reply = await h.call("list", { connId, dir: "/home/tester" });
		expect(reply).toMatchObject({ ok: true, action: "list", dir: "/home/tester" });
		expect(reply.entries).toEqual([
			{ name: "sub", type: "dir", size: 0 },
			{ name: "lnk", type: "link", size: 0 },
			{ name: "a.txt", type: "file", size: 13 },
		]);
		h.deactivate?.();
	});

	it("defaults the remote directory to /", async () => {
		const h = await startServer();
		const { connId } = await connected(h, seed);
		const reply = await h.call("list", { connId });
		expect(reply.dir).toBe("/");
		expect(names(reply)).toEqual(["home"]);
		h.deactivate?.();
	});

	it("reports a missing remote directory as an error", async () => {
		const h = await startServer();
		const { connId } = await connected(h, seed);
		const reply = await h.call("list", { connId, dir: "/nowhere" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("reads a remote text file and flags a remote binary file", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, seed);
		remote.files.set("/home/tester/blob.bin", Buffer.from([0x00, 0x01, 0x02]));
		expect(await h.call("read", { connId, path: "/home/tester/a.txt" })).toMatchObject({
			ok: true,
			text: "hello remote\n",
			encoding: "utf-8",
			size: 13,
		});
		const binary = await h.call("read", { connId, path: "/home/tester/blob.bin" });
		expect(binary).toMatchObject({ ok: true, binary: true, size: 3 });
		expect(binary.text).toBeUndefined();
		h.deactivate?.();
	});

	it("refuses a remote file above the shared read limit", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, seed);
		remote.files.set("/home/tester/huge.bin", Buffer.alloc(8));
		remote.sizeOverride.set("/home/tester/huge.bin", MAX_READ_BYTES + 1);
		const reply = await h.call("read", { connId, path: "/home/tester/huge.bin" });
		expect(reply.ok).toBe(false);
		expect(reply.text).toBeUndefined();
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("writes, creates, renames and deletes remote entries", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, seed);

		expect((await h.call("write", { connId, path: "/home/tester/new.txt", text: "written" })).ok).toBe(true);
		expect(remote.files.get("/home/tester/new.txt")?.toString("utf8")).toBe("written");

		expect((await h.call("create", { connId, path: "/home/tester/made", kind: "dir" })).ok).toBe(true);
		expect(remote.dirs.has("/home/tester/made")).toBe(true);
		expect((await h.call("create", { connId, path: "/home/tester/blank.txt", kind: "file" })).ok).toBe(true);
		expect(remote.files.get("/home/tester/blank.txt")).toEqual(Buffer.alloc(0));

		expect((await h.call("rename", { connId, path: "/home/tester/new.txt", newName: "renamed.txt" })).ok).toBe(true);
		expect(remote.files.has("/home/tester/new.txt")).toBe(false);
		expect(remote.files.get("/home/tester/renamed.txt")?.toString("utf8")).toBe("written");

		expect((await h.call("delete", { connId, path: "/home/tester/renamed.txt" })).ok).toBe(true);
		expect(remote.files.has("/home/tester/renamed.txt")).toBe(false);
		expect((await h.call("delete", { connId, path: "/home/tester/sub", isDir: true })).ok).toBe(true);
		expect(remote.dirs.has("/home/tester/sub")).toBe(false);
		h.deactivate?.();
	});

	it("refuses an unsafe remote rename target", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, seed);
		for (const newName of ["a/b", "a\\b", "..", "a..b", "", "   ", 42]) {
			const reply = await h.call("rename", { connId, path: "/home/tester/a.txt", newName });
			expect(reply.ok, `rename to ${JSON.stringify(newName)} must be refused`).toBe(false);
			expectEnglish(String(reply.error));
		}
		expect(remote.files.has("/home/tester/a.txt")).toBe(true);
		h.deactivate?.();
	});

	it("renames inside the same remote directory, not into its parent", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, seed);
		await h.call("rename", { connId, path: "/home/tester/sub/b.txt", newName: "c.txt" });
		expect(remote.files.has("/home/tester/sub/c.txt")).toBe(true);
		expect(remote.files.has("/home/tester/c.txt")).toBe(false);
		h.deactivate?.();
	});

	it("reports remote failures as English errors", async () => {
		const h = await startServer();
		const { connId } = await connected(h, seed);
		const missing = await h.call("read", { connId, path: "/home/tester/ghost.txt" });
		expect(missing.ok).toBe(false);
		expectEnglish(String(missing.error));
		expect((await h.call("delete", { connId, path: "/home/tester/ghost.txt" })).ok).toBe(false);
		h.deactivate?.();
	});
});

describe("remote download", () => {
	it("downloads a remote file under its base name", async () => {
		const h = await startServer();
		const { connId } = await connected(h, { files: { "/srv/payload.txt": "remote body" } });
		const reply = await h.call("download", { connId, path: "/srv/payload.txt" });
		expect(reply).toMatchObject({ ok: true, action: "download", size: 11, name: "payload.txt" });
		expect(Buffer.from(String(reply.b64), "base64").toString("utf8")).toBe("remote body");
		h.deactivate?.();
	});

	it("packs a remote directory with a shell-quoted tar command", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"], files: { "/srv/inner.txt": "x" } });
		remote.execHandler = () => ({ stdout: Buffer.from([0x1f, 0x8b, 0x08, 0x00]), code: 0 });
		const reply = await h.call("download", { connId, path: "/srv/" });
		expect(reply).toMatchObject({ ok: true, size: 4, name: "srv.tar.gz" });
		expect(Buffer.from(String(reply.b64), "base64")).toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
		expect(remote.execs).toEqual(["cd '/' && tar -czf - 'srv'"]);
		h.deactivate?.();
	});

	it("shell-quotes a remote name containing a space and a single quote", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"] });
		remote.dirs.add("/srv/it's a dir");
		remote.files.set("/srv/it's a dir/f.txt", Buffer.from("y"));
		remote.execHandler = () => ({ stdout: Buffer.from("archive"), code: 0 });
		const reply = await h.call("download", { connId, path: "/srv/it's a dir" });
		expect(reply).toMatchObject({ ok: true, name: "it's a dir.tar.gz" });
		expect(remote.execs).toEqual(["cd '/srv' && tar -czf - 'it'\\''s a dir'"]);
		h.deactivate?.();
	});

	it("fails when the remote produces an empty archive", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"] });
		remote.execHandler = () => ({ stdout: "", code: 0 });
		const reply = await h.call("download", { connId, path: "/srv" });
		expect(reply.ok).toBe(false);
		expect(reply.b64).toBeUndefined();
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("fails when the remote path does not exist", async () => {
		const h = await startServer();
		const { connId } = await connected(h, { dirs: ["/srv"] });
		const reply = await h.call("download", { connId, path: "/srv/ghost" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("rejects a relative or traversing remote path before running anything", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { files: { "/srv/a.txt": "x" } });
		for (const path of ["srv/a.txt", "/srv/../etc/passwd", "/srv/../../etc/passwd", ""]) {
			const reply = await h.call("download", { connId, path });
			expect(reply.ok, `${JSON.stringify(path)} must be refused`).toBe(false);
			expectEnglish(String(reply.error));
		}
		expect(remote.execs).toEqual([]);
		h.deactivate?.();
	});

	it("refuses a remote file above the download limit", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { files: { "/srv/big.bin": "x" } });
		remote.sizeOverride.set("/srv/big.bin", MAX_UPLOAD_BYTES + 1);
		const reply = await h.call("download", { connId, path: "/srv/big.bin" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("refuses a remote archive above the download limit and closes the stream", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"] });
		remote.execHandler = () => ({ stdout: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61), code: 0 });
		const reply = await h.call("download", { connId, path: "/srv" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});
});

describe("remote upload", () => {
	it("streams chunks to the remote and creates missing directories", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"] });
		const body = Buffer.from("remote upload body");
		const begin = await h.call("upload_begin", { connId, dir: "/srv/deep", name: "u.txt", size: body.length });
		expect(begin).toMatchObject({ ok: true, exists: false });
		const reply = await h.call("upload", { uploadId: begin.uploadId, i: 0, total: 1, b64: body.toString("base64") });
		expect(reply).toMatchObject({ ok: true, done: true, size: body.length });
		expect(remote.files.get("/srv/deep/u.txt")).toEqual(body);
		h.deactivate?.();
	});

	it("reports exists:true for a remote file that is already there", async () => {
		const h = await startServer();
		const { connId } = await connected(h, { files: { "/srv/dup.txt": "old" } });
		expect(await h.call("upload_begin", { connId, dir: "/srv", name: "dup.txt", size: 3 })).toMatchObject({
			ok: true,
			exists: true,
		});
		h.deactivate?.();
	});

	it("rejects a remote upload whose name or directory is not safe", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"] });
		for (const extra of [
			{ dir: "/srv", name: "../escape.txt", size: 1 },
			{ dir: "srv", name: "a.txt", size: 1 },
			{ dir: "/srv/..", name: "a.txt", size: 1 },
			{ dir: "/srv", name: "a/b.txt", size: 1 },
			{ dir: "/srv", name: "", size: 1 },
			{ dir: "/srv", name: "a.txt", size: 0 },
		]) {
			const reply = await h.call("upload_begin", { connId, ...extra });
			expect(reply.ok, `${JSON.stringify(extra)} must be refused`).toBe(false);
			expectEnglish(String(reply.error));
		}
		expect(remote.files.size).toBe(0);
		h.deactivate?.();
	});

	it("defaults a missing remote directory to /", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h, { dirs: ["/srv"] });
		const begin = await h.call("upload_begin", { connId, name: "rooted.txt", size: 2 });
		expect(begin.ok).toBe(true);
		await h.call("upload", { uploadId: begin.uploadId, i: 0, total: 1, b64: Buffer.from("hi").toString("base64") });
		expect(remote.files.get("/rooted.txt")?.toString("utf8")).toBe("hi");
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// Sync transfer
// ---------------------------------------------------------------------------

describe("SFTP sync transfer", () => {
	async function configured(h: Harness, extra: Record<string, unknown> = {}): Promise<void> {
		const reply = await h.call("sync_save", {
			config: {
				host: "remote.example.com",
				username: "tester",
				password: "pw",
				remoteRoot: "/srv",
				exclude: [".git", "*.log"],
				...extra,
			},
		});
		expect(reply.ok, `sync_save failed: ${String(reply.error)}`).toBe(true);
	}

	it("sync_test probes the remote root and reports success", async () => {
		const h = await startServer();
		addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		expect((await h.call("sync_test")).ok).toBe(true);
		h.deactivate?.();
	});

	it("sync_test surfaces an unreachable remote as an English error", async () => {
		const h = await startServer();
		await configured(h);
		const reply = await h.call("sync_test");
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		h.deactivate?.();
	});

	it("uploads the whole workspace, honouring the exclude globs at every depth", async () => {
		const h = await startServer((root) => {
			mkdirSync(join(root, ".git"), { recursive: true });
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "app.ts"), "code");
			writeFileSync(join(root, "index.html"), "<html>");
			writeFileSync(join(root, ".git", "config"), "secret-ref");
			writeFileSync(join(root, "debug.log"), "noise");
			writeFileSync(join(root, "src", "trace.log"), "noise");
		});
		const remote = addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);

		const reply = await h.call("sync_run", { dir: "up", scope: "all" });
		expect(reply).toMatchObject({ ok: true, action: "sync_run", total: 2, dir: "up", scope: "all", failed: [] });
		expect(remote.files.get("/srv/src/app.ts")?.toString("utf8")).toBe("code");
		expect(remote.files.get("/srv/index.html")?.toString("utf8")).toBe("<html>");
		// "*.log" matches at any depth; ".git" covers everything beneath it.
		expect(remote.files.has("/srv/.git/config")).toBe(false);
		expect(remote.files.has("/srv/debug.log")).toBe(false);
		expect(remote.files.has("/srv/src/trace.log")).toBe(false);

		const progress = h.events("sync_progress");
		expect(progress).toHaveLength(2);
		expect(progress.map((p) => p.done)).toEqual([1, 2]);
		expect(progress.every((p) => p.total === 2)).toBe(true);
		h.deactivate?.();
	});

	it("downloads a remote tree into the workspace", async () => {
		const h = await startServer();
		addSshHost("remote.example.com", 22, {
			dirs: ["/srv", "/srv/pkg"],
			files: { "/srv/pkg/index.js": "module.exports = 1;", "/srv/readme.md": "# remote" },
		});
		await configured(h);
		expect(await h.call("sync_run", { dir: "down", scope: "all" })).toMatchObject({
			ok: true,
			total: 2,
			dir: "down",
			scope: "all",
			failed: [],
		});
		expect(readFileSync(join(h.root, "pkg/index.js"), "utf8")).toBe("module.exports = 1;");
		expect(readFileSync(join(h.root, "readme.md"), "utf8")).toBe("# remote");
		h.deactivate?.();
	});

	it("downloads nothing from a remote root that does not exist", async () => {
		const h = await startServer();
		addSshHost("remote.example.com", 22, { dirs: ["/other"] });
		await configured(h);
		expect(await h.call("sync_run", { dir: "down", scope: "all" })).toMatchObject({ ok: true, total: 0, failed: [] });
		expect(readdirSync(h.root)).toEqual([".vscode"]);
		h.deactivate?.();
	});

	it("limits a tree-scoped sync to the chosen subtree", async () => {
		const h = await startServer((root) => {
			mkdirSync(join(root, "app"), { recursive: true });
			mkdirSync(join(root, "vendor"), { recursive: true });
			writeFileSync(join(root, "app", "main.js"), "main");
			writeFileSync(join(root, "vendor", "lib.js"), "lib");
		});
		const remote = addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		expect(await h.call("sync_run", { dir: "up", scope: "tree", path: "app" })).toMatchObject({
			ok: true,
			scope: "tree",
			total: 1,
		});
		expect(remote.files.has("/srv/app/main.js")).toBe(true);
		expect(remote.files.has("/srv/vendor/lib.js")).toBe(false);
		h.deactivate?.();
	});

	it("uploads a single file", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "one.txt"), "1"));
		const remote = addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		expect(await h.call("sync_run", { dir: "up", scope: "file", path: "one.txt" })).toMatchObject({
			ok: true,
			scope: "file",
			total: 1,
		});
		expect(remote.files.get("/srv/one.txt")?.toString("utf8")).toBe("1");
		h.deactivate?.();
	});

	it("refuses a single-file sync whose target matches an exclude rule", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "build.log"), "noise"));
		const remote = addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		const reply = await h.call("sync_run", { dir: "up", scope: "file", path: "build.log" });
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(remote.files.size).toBe(0);
		h.deactivate?.();
	});

	it("refuses a single-file sync of the workspace root or of an escaping path", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "one.txt"), "1"));
		const remote = addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		expect((await h.call("sync_run", { dir: "up", scope: "file", path: "" })).ok).toBe(false);
		expect((await h.call("sync_run", { dir: "up", scope: "file", path: "../escape.txt" })).ok).toBe(false);
		expect(remote.files.size).toBe(0);
		h.deactivate?.();
	});

	it("defaults an unknown direction to up and an unknown scope to file", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "one.txt"), "1"));
		addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		expect(await h.call("sync_run", { dir: "sideways", scope: "everything", path: "one.txt" })).toMatchObject({
			ok: true,
			dir: "up",
			scope: "file",
		});
		h.deactivate?.();
	});

	it("collects per-file failures instead of aborting the whole transfer", async () => {
		const h = await startServer((root) => {
			writeFileSync(join(root, "good.txt"), "good");
			writeFileSync(join(root, "bad.txt"), "bad");
		});
		const remote = addSshHost("remote.example.com", 22, { dirs: ["/srv"] });
		await configured(h);
		remote.writeErrors.add("/srv/bad.txt");

		const reply = await h.call("sync_run", { dir: "up", scope: "all" });
		expect(reply).toMatchObject({ ok: true, total: 2 });
		const failed = reply.failed as { rel: string; error: string }[];
		expect(failed).toHaveLength(1);
		expect(failed[0]!.rel).toBe("bad.txt");
		expectEnglish(failed[0]!.error);
		expect(remote.files.get("/srv/good.txt")?.toString("utf8")).toBe("good");
		expect(h.events("sync_progress")).toHaveLength(2);
		h.deactivate?.();
	});

	it("reconnects after the saved config changes", async () => {
		const h = await startServer();
		addSshHost("first.example.com", 22, { dirs: ["/srv"] });
		addSshHost("second.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", {
			config: { host: "first.example.com", username: "tester", password: "pw", remoteRoot: "/srv" },
		});
		expect((await h.call("sync_test")).ok).toBe(true);
		await h.call("sync_save", {
			config: { host: "second.example.com", username: "tester", password: "pw", remoteRoot: "/srv" },
		});
		expect((await h.call("sync_test")).ok).toBe(true);
		expect(ssh.state.attempts.map((a) => String((a as ConnectAttempt).host))).toEqual([
			"first.example.com",
			"second.example.com",
		]);
		h.deactivate?.();
	});

	it("reuses one connection while the config is unchanged", async () => {
		const h = await startServer();
		addSshHost("reuse.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", {
			config: { host: "reuse.example.com", username: "tester", password: "pw", remoteRoot: "/srv" },
		});
		expect((await h.call("sync_test")).ok).toBe(true);
		expect((await h.call("sync_test")).ok).toBe(true);
		expect(ssh.state.attempts).toHaveLength(1);
		h.deactivate?.();
	});

	it("expands the $SSH_AUTH_SOCK placeholder and sends no password", async () => {
		const h = await startServer();
		addSshHost("agent.example.com", 22, { dirs: ["/srv"] });
		const previous = process.env.SSH_AUTH_SOCK;
		process.env.SSH_AUTH_SOCK = "/tmp/test-agent.sock";
		try {
			await h.call("sync_save", {
				config: { host: "agent.example.com", username: "tester", remoteRoot: "/srv", agent: "$SSH_AUTH_SOCK" },
			});
			expect((await h.call("sync_test")).ok).toBe(true);
			expect(ssh.state.attempts[0]).toMatchObject({ host: "agent.example.com", agent: "/tmp/test-agent.sock" });
			expect(ssh.state.attempts[0]).not.toHaveProperty("password");
			expect(ssh.state.attempts[0]).not.toHaveProperty("privateKey");
		} finally {
			if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
			else process.env.SSH_AUTH_SOCK = previous;
		}
		h.deactivate?.();
	});

	it("refuses to connect with no password, key or agent configured", async () => {
		const h = await startServer();
		addSshHost("nocred.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", { config: { host: "nocred.example.com", username: "tester", remoteRoot: "/srv" } });
		const reply = await h.call("sync_test");
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(ssh.state.attempts).toEqual([]);
		h.deactivate?.();
	});

	it("reports a missing private key file as an English error", async () => {
		const h = await startServer();
		addSshHost("keyed.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", {
			config: { host: "keyed.example.com", username: "tester", remoteRoot: "/srv", privateKeyPath: "missing-key.pem" },
		});
		const reply = await h.call("sync_test");
		expect(reply.ok).toBe(false);
		expectEnglish(String(reply.error));
		expect(ssh.state.attempts).toEqual([]);
		h.deactivate?.();
	});

	it("reads a private key from a workspace-relative path", async () => {
		const h = await startServer((root) => writeFileSync(join(root, "id_test"), "-----BEGIN OPENSSH PRIVATE KEY-----"));
		addSshHost("keyfile.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", {
			config: { host: "keyfile.example.com", username: "tester", remoteRoot: "/srv", privateKeyPath: "id_test" },
		});
		expect((await h.call("sync_test")).ok).toBe(true);
		expect(ssh.state.attempts[0]).toMatchObject({ privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" });
		h.deactivate?.();
	});

	it("prefers an inline private key when no key path is configured", async () => {
		const h = await startServer();
		addSshHost("inline.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", {
			config: { host: "inline.example.com", username: "tester", remoteRoot: "/srv", privateKey: "INLINE-PEM" },
		});
		expect((await h.call("sync_test")).ok).toBe(true);
		expect(ssh.state.attempts[0]).toMatchObject({ privateKey: "INLINE-PEM" });
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// Terminal shell and exec
// ---------------------------------------------------------------------------

describe("terminal shell", () => {
	it("opens a shell, forwards stdout and stderr as base64, and reports the exit", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		expect(await h.call("shell_open", { connId, cols: 120, rows: 40 })).toMatchObject({
			ok: true,
			action: "shell_open",
			shellId: "s1",
		});
		expect(remote.shellWindows).toEqual([{ cols: 120, rows: 40 }]);
		const shell = remote.shells[0]!;

		shell.emit("data", Buffer.from("stdout chunk"));
		shell.stderr.emit("data", Buffer.from("stderr chunk"));
		await settle();
		const data = h.events("shell_data");
		expect(data).toHaveLength(2);
		expect(data.map((d) => Buffer.from(String(d.b64), "base64").toString("utf8"))).toEqual([
			"stdout chunk",
			"stderr chunk",
		]);
		expect(data.every((d) => d.connId === connId && d.shellId === "s1")).toBe(true);

		shell.emit("close");
		await settle();
		expect(h.events("shell_exit")).toEqual([{ event: "shell_exit", connId, shellId: "s1" }]);
		h.deactivate?.();
	});

	it("defaults the terminal geometry when the client sends none", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		expect((await h.call("shell_open", { connId })).ok).toBe(true);
		expect(remote.shellWindows).toEqual([{ cols: 80, rows: 24 }]);
		h.deactivate?.();
	});

	it("reports a shell open failure", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		remote.breakShell = true;
		const reply = await h.call("shell_open", { connId });
		expect(reply).toMatchObject({ res: true, ok: false, action: "shell_open" });
		expectEnglish(String(reply.error));
		expect(remote.shells).toEqual([]);
		h.deactivate?.();
	});

	it("numbers shells per connection and hands output to the most recent requester", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		expect((await h.call("shell_open", { connId }, CLIENT)).shellId).toBe("s1");
		expect((await h.call("shell_open", { connId }, OTHER_CLIENT)).shellId).toBe("s2");

		// The second requester takes over the connection's terminal output stream,
		// so data from the first shell is delivered to the newest client only.
		remote.shells[0]!.emit("data", Buffer.from("after takeover"));
		await settle();
		expect(h.events("shell_data", CLIENT)).toEqual([]);
		expect(h.events("shell_data", OTHER_CLIENT).map((d) => d.shellId)).toEqual(["s1"]);
		h.deactivate?.();
	});

	it("writes shell_input to the stream and never answers", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		const shellId = String((await h.call("shell_open", { connId })).shellId);
		await h.silent("shell_input", { connId, shellId, b64: Buffer.from("ls -la\r").toString("base64") });
		expect(remote.shells[0]!.written.map((b) => Buffer.from(b as Uint8Array).toString("utf8"))).toEqual(["ls -la\r"]);
		h.deactivate?.();
	});

	it("ignores shell_input for an unknown shell or a missing payload without answering", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		await h.call("shell_open", { connId });
		await h.silent("shell_input", { connId, shellId: "s99", b64: Buffer.from("x").toString("base64") });
		await h.silent("shell_input", { connId, shellId: "s1" });
		expect(remote.shells[0]!.written).toHaveLength(0);
		h.deactivate?.();
	});

	it("resizes the remote window and never answers", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		await h.call("shell_open", { connId });
		await h.silent("shell_resize", { connId, shellId: "s1", rows: 50, cols: 200 });
		expect(remote.shells[0]!.window).toEqual([50, 200, 0, 0]);
		await h.silent("shell_resize", { connId, shellId: "s1" });
		expect(remote.shells[0]!.window).toEqual([24, 80, 0, 0]);
		h.deactivate?.();
	});

	it("closes a shell on request and stops forwarding its output", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		await h.call("shell_open", { connId });
		expect((await h.call("shell_close", { connId, shellId: "s1" })).ok).toBe(true);
		expect(remote.shells[0]!.ended).toBe(true);
		await settle();
		expect(h.events("shell_data")).toEqual([]);
		h.deactivate?.();
	});

	it("closes an unknown shell id without failing", async () => {
		const h = await startServer();
		const { connId } = await connected(h);
		expect((await h.call("shell_close", { connId, shellId: "s404" })).ok).toBe(true);
		h.deactivate?.();
	});

	it("ends open shells when the connection drops", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		await h.call("shell_open", { connId });
		lastClient().emit("close");
		await settle();
		expect(remote.shells[0]!.ended).toBe(true);
		expect(h.events("conn_closed").map((e) => e.connId)).toEqual([connId]);
		h.deactivate?.();
	});
});

describe("exec", () => {
	it("returns merged stdout and stderr with the exit code", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		remote.execHandler = () => ({ stdout: "out\n", stderr: "err\n", code: 3 });
		expect(await h.call("exec", { connId, cmd: "make test" })).toMatchObject({
			ok: true,
			action: "exec",
			exitCode: 3,
			output: "out\nerr\n",
		});
		expect(remote.execs).toEqual(["make test"]);
		h.deactivate?.();
	});

	it("defaults a missing exit code to zero", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		remote.execHandler = () => ({ stdout: "fine" });
		expect((await h.call("exec", { connId, cmd: "true" })).exitCode).toBe(0);
		h.deactivate?.();
	});

	it("truncates output above the limit and keeps the marker English", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		const huge = "x".repeat(MAX_EXEC_OUTPUT + 4096);
		remote.execHandler = () => ({ stdout: huge, code: 0 });
		const output = String((await h.call("exec", { connId, cmd: "cat big" })).output);
		expect(output.length).toBeLessThan(huge.length);
		expect(output.startsWith("x".repeat(MAX_EXEC_OUTPUT))).toBe(true);
		const marker = output.slice(MAX_EXEC_OUTPUT);
		expect(marker.length).toBeGreaterThan(0);
		expectEnglish(marker);
		h.deactivate?.();
	});

	it("leaves output below the limit untouched", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		remote.execHandler = () => ({ stdout: "short", code: 0 });
		expect((await h.call("exec", { connId, cmd: "echo short" })).output).toBe("short");
		h.deactivate?.();
	});

	it("coerces a missing command to an empty string", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		expect((await h.call("exec", { connId })).ok).toBe(true);
		expect(remote.execs).toEqual([""]);
		h.deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// Workspace switching and teardown
// ---------------------------------------------------------------------------

describe("workspace lifecycle", () => {
	it("follows a workspace switch and announces it", async () => {
		const h = await startServer(seedTreeWorkspace);
		const next = join(h.base, "other-workspace");
		mkdirSync(next, { recursive: true });
		writeFileSync(join(next, "other.txt"), "other\n");

		await h.host.emit.notifyCwd(next);
		await settle();
		expect(h.broadcasts().filter((b) => b.kind === "workspace")).toEqual([
			{ kind: "workspace", root: next.split(/[\\/]/).join("/") },
		]);

		expect(names(await h.call("list", { dir: "" }))).toEqual(["other.txt"]);
		expect((await h.call("flatlist")).files).toEqual(["other.txt"]);
		h.deactivate?.();
	});

	it("drops the cached sync connection and per-workspace config when the root moves", async () => {
		const h = await startServer();
		addSshHost("switch.example.com", 22, { dirs: ["/srv"] });
		await h.call("sync_save", {
			config: { host: "switch.example.com", username: "tester", password: "pw", remoteRoot: "/srv" },
		});
		expect((await h.call("sync_test")).ok).toBe(true);
		expect(ssh.state.attempts).toHaveLength(1);

		const next = join(h.base, "third-workspace");
		mkdirSync(next, { recursive: true });
		await h.host.emit.notifyCwd(next);
		await settle();
		// .vscode/sftp.json is per workspace, so the new root reads as unconfigured.
		expect(await h.call("sync_get")).toMatchObject({ ok: true, config: { configured: false } });
		h.deactivate?.();
	});

	it("unregisters every handler and clears in-flight uploads on deactivate", async () => {
		const h = await startServer();
		await h.call("upload_begin", { dir: "", name: "leftover.txt", size: 10 });
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toHaveLength(1);

		await h.deactivate?.();
		await settle();
		expect(await h.host.emit.message({ action: "state" }, CLIENT)).toBe(0);
		expect(await h.host.emit.attach(OTHER_CLIENT)).toBe(0);
		expect(await h.host.emit.notifyCwd(h.root)).toBe(0);
		expect(h.host.recorded.handlers.message.size).toBe(0);
		expect(readdirSync(h.root).filter((n) => n.endsWith(".part"))).toEqual([]);
		expect(existsSync(join(h.root, "leftover.txt"))).toBe(false);
	});

	it("deactivate is safe to call twice", async () => {
		const h = await startServer();
		h.deactivate?.();
		expect(() => h.deactivate?.()).not.toThrow();
	});

	it("ends established SSH connections and their shells on deactivate", async () => {
		const h = await startServer();
		const { connId, remote } = await connected(h);
		await h.call("shell_open", { connId });
		expect(stateOf(await h.call("state")).conns).toHaveLength(1);
		h.deactivate?.();
		await settle();
		expect(remote.shells[0]!.ended).toBe(true);
		expect(lastClient().ended).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Build smoke test: the compiled server artifact must be loadable by the host
// ---------------------------------------------------------------------------

describe("compiled server artifact", () => {
	it("builds, imports as ESM and answers the protocol against the host contract", async () => {
		const built = buildPlugin("vscode-editor");
		expect(built.ok, `npm run build:vscode-editor failed:\n${built.stderr}\n${built.stdout}`).toBe(true);
		expect(built.serverEntry, "plugins/vscode-editor/index.mjs was not produced").toBeTruthy();

		const { importServerArtifact, isServerEntry } = await import("../helpers/plugin-contract");
		const mod = await importServerArtifact("vscode-editor");
		expect(isServerEntry(mod), "index.mjs must default-export { activate(host) }").toBe(true);
		if (!isServerEntry(mod)) return;

		const base = makeTempDir("vsc-editor-artifact-");
		const root = join(base, "workspace");
		const pluginDir = join(base, "plugins", "vscode-editor");
		mkdirSync(root, { recursive: true });
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(join(root, "artifact.txt"), "from the bundle\n");

		const host = createMockHost({ dir: pluginDir, cwd: root, permissions: PERMISSIONS });
		const deactivate = await mod.default.activate(host);
		await settle();
		await host.emit.message({ action: "read", reqId: "artifact-1", path: "artifact.txt" }, CLIENT);
		await settle();
		const reply = host.recorded.sent.find((s) => (s.payload as Reply).reqId === "artifact-1");
		expect(reply?.payload).toMatchObject({ ok: true, text: "from the bundle\n" });
		expect(host.recorded.rejections).toEqual([]);
		expect(typeof deactivate).toBe("function");
		if (typeof deactivate === "function") deactivate();
	});

	it("keeps ssh2 external so the host can auto-install it at activation time", () => {
		const source = readFileSync(repoPath("plugins/vscode-editor/index.mjs"), "utf8");
		expect(source).toContain('"ssh2"');
		// The bundle must not have inlined the driver: the artifact stays small and
		// resolves ssh2 from the plugin directory the host installs into.
		expect(source.length).toBeLessThan(200_000);
	});
});

/**
 * parseSshConfig is a pure module-level export, so it is tested directly: no
 * host, no ssh2 double, no temporary workspace.
 */
describe("vscode-editor: ~/.ssh/config parsing", () => {
	it("reads alias, hostname, user, port and the first IdentityFile", async () => {
		const { parseSshConfig } = await import("../../plugins/vscode-editor/src/index");
		const out = parseSshConfig(
			[
				"Host prod",
				"  HostName 10.0.0.5",
				"  User deploy",
				"  Port 2222",
				"  IdentityFile ~/.ssh/id_ed25519 ~/.ssh/other",
			].join("\n"),
		);
		expect(out).toEqual([
			{ alias: "prod", host: "10.0.0.5", port: 2222, username: "deploy", privateKeyPath: "~/.ssh/id_ed25519" },
		]);
	});

	it("inherits a wildcard block as defaults without emitting it as a candidate", () =>
		import("../../plugins/vscode-editor/src/index").then(({ parseSshConfig }) => {
			const out = parseSshConfig(["Host *", "  User root", "  IdentityFile ~/.ssh/id_rsa", "", "Host box"].join("\n"));
			expect(out).toEqual([{ alias: "box", host: "box", port: 22, username: "root", privateKeyPath: "~/.ssh/id_rsa" }]);
		}));

	it("skips comments and wildcard aliases, honours = separators and quotes, and keeps the first value", async () => {
		const { parseSshConfig } = await import("../../plugins/vscode-editor/src/index");
		const out = parseSshConfig(
			[
				"# a comment",
				'Host web "*.internal"',
				"  HostName=web1.example.com",
				"  HostName web2.example.com",
				"  User = ci",
				"",
				"Host gw jump",
				"  HostName gateway",
			].join("\n"),
		);
		expect(out.map((h) => h.alias)).toEqual(["web", "gw", "jump"]);
		expect(out[0]).toMatchObject({ host: "web1.example.com", username: "ci", port: 22, privateKeyPath: "" });
		expect(out[1]).toMatchObject({ host: "gateway", username: "root" });
	});

	it("returns nothing for empty or credential-free input", async () => {
		const { parseSshConfig } = await import("../../plugins/vscode-editor/src/index");
		expect(parseSshConfig("")).toEqual([]);
		expect(parseSshConfig(undefined)).toEqual([]);
		expect(parseSshConfig("Host *\n  User root\n")).toEqual([]);
	});
});

/**
 * vscode-editor server entry - the filesystem backend of the VSCode-like editor plugin.
 *
 * Contract: ESM default export { activate(host) → deactivate? }.
 * The client sends plugin_message: { action, reqId, ... }; this plugin replies with
 * host.sendTo straight back to the requesting socket (reqId matches concurrent
 * requests), never by broadcast.
 *
 * Security:
 * - every path must be relative to host.cwd (the workspace the server started in)
 *   and must still resolve inside root; anything escaping is rejected;
 * - directory walks skip noise dirs like node_modules/.git and symlinks (loop guard);
 * - reads are capped at 2MB; writes land atomically via tmp + rename.
 */

// @ts-nocheck
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** Noise entry names skipped when listing directories */
const IGNORED = new Set([
	"node_modules",
	".git",
	".pi-web",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	"venv",
	".venv",
	"__pycache__",
	"coverage",
	".cache",
	".DS_Store",
	"Thumbs.db",
]);

const MAX_LIST_ENTRIES = 8000; // flatlist total entry cap
const MAX_DEPTH = 12; // flatlist max depth
const MAX_READ_BYTES = 2 * 1024 * 1024; // per-file read cap (shared by local and remote SFTP)
const MAX_SSH_HOSTS = 32;
const CONN_TIMEOUT_MS = 15000;
const MAX_EXEC_OUTPUT = 256 * 1024; // remote exec output truncation cap
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // download-to-browser size cap (base64 over WS)
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // upload size cap (base64 chunks over WS)
const UPLOAD_STALE_MS = 30 * 60 * 1000; // stale upload session timeout (swept after a client drops mid-transfer)

function toWire(p) {
	return p.split(path.sep).join("/");
}

/**
 * Parse `~/.ssh/config` into importable candidates
 * `[{ alias, host, port, username, privateKeyPath }]`.
 *
 * OpenSSH semantics: within a block the first occurrence of a key wins; a pure
 * wildcard `Host *` block only supplies defaults (a global IdentityFile becomes
 * each host's default key path) and yields no candidate of its own; an alias
 * containing a wildcard yields nothing. Only the first IdentityFile is taken and
 * `~` is left as written - resolveKeyFile expands it at connect time.
 *
 * Pure function, exported on its own so it can be unit tested.
 */
export function parseSshConfig(text) {
	const blocks = []; // { patterns, hostname, user, port, identityfile }
	let cur = null;
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const sp = line.search(/[\s=]/);
		if (sp < 0) continue;
		const key = line.slice(0, sp).trim().toLowerCase();
		let val = line.slice(sp).trim().replace(/^=\s*/, "").trim();
		const quoted =
			val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")));
		if (quoted) val = val.slice(1, -1);
		if (key === "host") {
			cur = {
				patterns: val.split(/\s+/).filter(Boolean),
				hostname: null,
				user: null,
				port: null,
				identityfile: null,
			};
			blocks.push(cur);
		} else if (cur) {
			if (key === "hostname" && cur.hostname === null && val) cur.hostname = val;
			else if (key === "user" && cur.user === null && val) cur.user = val;
			else if (key === "port" && cur.port === null && val) cur.port = val;
			else if (key === "identityfile" && cur.identityfile === null && val) {
				cur.identityfile = quoted ? val : val.split(/\s+/)[0];
			}
		}
	}
	// Global defaults: blocks whose patterns are exactly ["*"]. Several such blocks
	// inherit in order and an already-set value is never overwritten.
	const defaults = { user: null, port: null, identityfile: null };
	for (const b of blocks) {
		if (b.patterns.length === 1 && b.patterns[0] === "*") {
			if (defaults.user === null) defaults.user = b.user;
			if (defaults.port === null) defaults.port = b.port;
			if (defaults.identityfile === null) defaults.identityfile = b.identityfile;
		}
	}
	const out = [];
	for (const b of blocks) {
		if (b.patterns.length === 1 && b.patterns[0] === "*") continue; // defaults-only block
		for (const alias of b.patterns) {
			if (!alias || alias === "*" || /[*?!]/.test(alias)) continue;
			out.push({
				alias,
				host: b.hostname ?? alias,
				port: Number(b.port ?? defaults.port) || 22,
				username: b.user ?? defaults.user ?? "root",
				privateKeyPath: b.identityfile ?? defaults.identityfile ?? "",
			});
		}
	}
	return out;
}

export default {
	activate(host) {
		// Mutable: follows the main app's set_cwd live (host.onCwdChange, see end of activate)
		let root = path.resolve(host.cwd);

		/** Relative path → validated absolute path; null when illegal */
		function safeResolve(rel) {
			if (typeof rel !== "string") return null;
			const abs = path.resolve(root, rel); // "" = the workspace root itself, legal
			if (abs !== root && !abs.startsWith(root + path.sep)) return null;
			return abs;
		}

		function fail(reqId, error) {
			return { res: true, reqId, ok: false, error };
		}

		/** Single-level directory listing (used by the tree, expanded lazily) */
		async function listDir(relDir) {
			const abs = safeResolve(relDir ?? "");
			if (!abs) throw new Error("path escapes workspace");
			const dirents = await fs.readdir(abs === root ? root : abs, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (IGNORED.has(d.name)) continue;
				// Symlinks/junctions are never followed (loop and escape guard)
				if (d.isSymbolicLink()) continue;
				// In-flight upload temp files (.vsc-upload-*.part) stay out of the tree
				if (d.name.startsWith(".vsc-upload-")) continue;
				entries.push({
					name: d.name,
					type: d.isDirectory() ? "dir" : "file",
				});
			}
			entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
			return entries;
		}

		/** Flat whole-repo file list (for Ctrl+P quick open), BFS with depth/count caps */
		async function flatList() {
			const files = [];
			let truncated = false;
			const queue = [root];
			while (queue.length && files.length < MAX_LIST_ENTRIES) {
				const dir = queue.shift();
				const depth = dir.slice(root.length).split(path.sep).filter(Boolean).length;
				if (depth >= MAX_DEPTH) continue;
				let dirents;
				try {
					dirents = await fs.readdir(dir, { withFileTypes: true });
				} catch {
					continue; // skip dirs we cannot read (permissions etc.)
				}
				for (const d of dirents) {
					if (files.length >= MAX_LIST_ENTRIES) {
						truncated = true;
						break;
					}
					if (IGNORED.has(d.name) || d.name.startsWith(".vsc-upload-")) continue;
					if (d.isSymbolicLink()) continue;
					const full = path.join(dir, d.name);
					if (d.isDirectory()) queue.push(full);
					else if (d.isFile()) files.push(toWire(path.relative(root, full)));
				}
			}
			return { files, truncated };
		}

		/** Content sniff: no NUL and <2% control characters counts as text */
		function looksLikeText(buf) {
			const n = Math.min(buf.length, 8000);
			let ctrl = 0;
			for (let i = 0; i < n; i++) {
				const b = buf[i];
				if (b === 0) return false;
				if (b < 9 || (b > 13 && b < 32)) ctrl++;
			}
			return n === 0 || ctrl / n < 0.02;
		}

		/** Decode: strict UTF-8 → GBK → latin1 (same semantics as the main app's decodeText) */
		function decodeBuf(buf) {
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(buf);
			} catch {}
			try {
				return new TextDecoder("gbk", { fatal: true }).decode(buf);
			} catch {}
			return new TextDecoder("latin1").decode(buf);
		}

		async function readFile(rel) {
			const abs = safeResolve(rel);
			if (!abs) throw new Error("path escapes workspace");
			const stat = await fs.stat(abs);
			if (!stat.isFile()) throw new Error("not a regular file");
			if (stat.size > MAX_READ_BYTES) throw new Error(`file exceeds ${MAX_READ_BYTES / 1024 / 1024}MB limit`);
			const buf = await fs.readFile(abs);
			if (!looksLikeText(buf)) return { binary: true, size: stat.size };
			return { text: decodeBuf(buf), encoding: "utf-8", size: stat.size };
		}

		async function writeFile(rel, text) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("invalid path");
			await fs.mkdir(path.dirname(abs), { recursive: true });
			// Atomic write: tmp + rename, so no half-written content is ever visible
			const tmp = abs + ".vsc-tmp-" + process.pid;
			await fs.writeFile(tmp, String(text ?? ""), "utf-8");
			await fs.rename(tmp, abs);
		}

		async function createEntry(rel, kind) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("invalid path");
			try {
				if (kind === "dir") await fs.mkdir(abs);
				else {
					await fs.mkdir(path.dirname(abs), { recursive: true });
					await fs.writeFile(abs, "", { flag: "wx" }); // throws when it already exists
				}
			} catch (err) {
				if (err.code === "EEXIST") throw new Error("an entry with this name already exists");
				throw err;
			}
		}

		async function renameEntry(rel, newName) {
			if (
				typeof newName !== "string" ||
				!newName.trim() ||
				newName.includes("/") ||
				newName.includes("\\") ||
				newName.includes("..")
			) {
				throw new Error("invalid new name");
			}
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("invalid path");
			await fs.access(abs); // throw straight away when the source does not exist
			await fs.rename(abs, path.join(path.dirname(abs), newName));
		}

		async function deleteEntry(rel) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("refusing to delete workspace root");
			await fs.rm(abs, { recursive: true, force: false });
		}

		// ------------------------------------------------------------------
		// SFTP sync: transfer between the local workspace and a remote directory.
		//
		// The config lives in the workspace at <root>/.vscode/sftp.json (vscode-sftp
		// compatible field names, so the file can be edited directly and takes effect
		// on Ctrl+S; on first use it is migrated once from the old plugin-dir
		// sync-configs.json). The ssh2 dependency is not bundled - it is npm-installed
		// into the plugin dir on first use. Direction: up = local→remote, down =
		// remote→local. Scope: file = single file / tree = subtree / all = whole repo.
		// Exclude rules are vscode-sftp style globs.
		// ------------------------------------------------------------------
		const sftpCfgDir = () => path.join(root, ".vscode");
		const sftpCfgFile = () => path.join(sftpCfgDir(), "sftp.json"); // path vscode-sftp expects (follows the current workspace)
		const LEGACY_SYNC_STORE = path.join(host.dir, "sync-configs.json"); // old store (migration source)
		const syncConns = new Map(); // workspaceRoot → {client,sftp}
		let syncConnFp = ""; // config fingerprint of the live connection (edits to the file force a reconnect)
		const syncDeps = { mod: null, ok: false, failed: false, installing: false, waiters: [] };

		function posixJoin(base, rel) {
			if (!rel) return base;
			return `${String(base).replace(/\/+$/, "")}/${String(rel).replace(/^\/+/g, "")}`;
		}

		/** One internal shape; accepts vscode-sftp field names (name/host/remotePath/
		 *  privateKeyPath/passphrase/ignore/agent plus the legacy watcher.autoUpload).
		 *  vscode-sftp's privateKeyPath is usually written as ~/.ssh/id_rsa, so `~` is
		 *  expanded when the key is read (see resolveKeyFile). */
		function normalizeCfg(c) {
			c = c && typeof c === "object" ? c : {};
			const watcher = c.watcher && typeof c.watcher === "object" ? c.watcher : {};
			return {
				name: String(c.name ?? ""),
				host: String(c.host ?? "").trim(),
				port: Number(c.port) || 22,
				username: String(c.username ?? "root"),
				password: String(c.password ?? ""),
				passphrase: String(c.passphrase ?? ""),
				privateKey: String(c.privateKey ?? ""),
				privateKeyPath: String(c.privateKeyPath ?? ""),
				// vscode-sftp honours both top-level uploadOnSave and legacy watcher.autoUpload
				uploadOnSave: Boolean(c.uploadOnSave ?? watcher.autoUpload),
				// ssh-agent socket (vscode-sftp writes "$SSH_AUTH_SOCK"); kept verbatim in the
				// config and only expanded at connect time (see getSyncSftp)
				agent: String(c.agent ?? ""),
				protocol: String(c.protocol ?? "sftp").toLowerCase(),
				remoteRoot: String(c.remotePath ?? c.remoteRoot ?? "").trim() || "/",
				exclude: Array.isArray(c.ignore ?? c.exclude)
					? [...new Set((c.ignore ?? c.exclude).map(String))].filter(Boolean)
					: [],
			};
		}

		/** Resolve a private key path: `~` is expanded (vscode-sftp writes ~/.ssh/id_rsa),
		 *  absolute paths are used as-is, anything else falls back to the workspace. */
		function resolveKeyFile(p) {
			if (!p) return p;
			if (p === "~") return os.homedir();
			if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
			if (path.isAbsolute(p)) return p;
			return path.resolve(root, p);
		}

		/** Read the small file every time - saving .vscode/sftp.json takes effect with no
		 *  reload; when it is missing, migrate once from the old plugin-dir store. */
		async function readSyncCfg() {
			try {
				return normalizeCfg(JSON.parse(await fs.readFile(sftpCfgFile(), "utf8")));
			} catch {}
			try {
				const legacy = JSON.parse(await fs.readFile(LEGACY_SYNC_STORE, "utf8"));
				const old = normalizeCfg(legacy?.[root]);
				if (old.host) {
					await saveSyncCfg(old);
					return old; // migration succeeded
				}
			} catch {}
			return {};
		}

		/** Write vscode-sftp style JSON (atomic tmp+rename); the user can open and edit it */
		async function saveSyncCfg(cfg) {
			await fs.mkdir(sftpCfgDir(), { recursive: true });
			const file = {
				host: cfg.host,
				port: cfg.port || 22,
				username: cfg.username || "root",
				protocol: "sftp",
				password: cfg.password || "",
				passphrase: cfg.passphrase || "",
				remotePath: cfg.remoteRoot || "/",
				uploadOnSave: !!cfg.uploadOnSave,
				ignore: cfg.exclude ?? [],
			};
			if (cfg.name) file.name = cfg.name;
			if (cfg.privateKeyPath) file.privateKeyPath = cfg.privateKeyPath;
			if (cfg.privateKey) file.privateKey = cfg.privateKey;
			// Keep the value as written (including the $SSH_AUTH_SOCK placeholder) so the config ports across machines
			if (cfg.agent) file.agent = cfg.agent;
			const tmp = `${sftpCfgFile()}.tmp-${process.pid}`;
			await fs.writeFile(tmp, JSON.stringify(file, null, 4) + "\n", "utf8");
			await fs.rename(tmp, sftpCfgFile());
		}

		/** Run a remote command and collect raw stdout as a Buffer (for archive download;
		 *  unlike sshExec it does no UTF8 decoding) */
		function sshExecBuffer(c, cmd) {
			return new Promise((resolve, reject) => {
				c.client.exec(cmd, (err, stream) => {
					if (err) return void reject(err);
					const chunks = [];
					let size = 0;
					stream.on("data", (d) => {
						size += d.length;
						if (size > MAX_DOWNLOAD_BYTES) {
							try {
								stream.close();
							} catch {}
							return void reject(new Error(`archive exceeds ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB limit`));
						}
						chunks.push(d);
					});
					stream.stderr.on("data", () => {});
					stream.on("close", () => resolve(Buffer.concat(chunks)));
				});
			});
		}

		/** POSIX shell single-quote escaping */
		const shQuote = (s) => `'${String(s ?? "").replace(/'/g, "'\\''")}'`;

		/** Remote path check: must be absolute and contain no .. segment */
		function safeRemotePath(p) {
			p = String(p ?? "");
			if (!p.startsWith("/") || p.split("/").includes("..")) throw new Error("invalid path");
			return p;
		}

		function publicSync(cfg) {
			if (!cfg?.host) return { configured: false };
			return {
				configured: true,
				name: cfg.name ?? "",
				host: cfg.host,
				port: cfg.port ?? 22,
				username: cfg.username ?? "root",
				remoteRoot: cfg.remoteRoot ?? "/",
				exclude: cfg.exclude ?? [],
				uploadOnSave: Boolean(cfg.uploadOnSave),
				hasPass: Boolean(cfg.password),
				hasKey: Boolean(cfg.privateKey || cfg.privateKeyPath),
				hasAgent: Boolean(cfg.agent),
				privateKeyPath: cfg.privateKeyPath ?? "",
				agent: cfg.agent ?? "",
			};
		}

		/** Lazily load ssh2; npm-install it on demand when missing (same pattern as the ssh plugin). */
		function ensureSshMod(force = false) {
			if (syncDeps.ok) return Promise.resolve(syncDeps.mod);
			if (syncDeps.failed && !force) return Promise.resolve(null);
			if (syncDeps.installing) return new Promise((res) => syncDeps.waiters.push(res));
			return new Promise((res) => {
				syncDeps.installing = true;
				void (async () => {
					try {
						const m = await import("ssh2");
						syncDeps.mod = m.default ?? m;
						syncDeps.ok = true;
						syncDeps.failed = false;
					} catch {
						host.notify("info", "📝 Editor sync: installing dependency (ssh2)...");
						let cli = null;
						try {
							cli = createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
						} catch {}
						const args = ["--prefix", host.dir, "install", "ssh2@latest", "--no-audit", "--no-fund"];
						const child = cli
							? spawn(process.execPath, [cli, ...args], { stdio: "ignore" })
							: spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "ignore" });
						child.on("error", () => finish(false));
						child.on("exit", (code) => finish(code === 0));
						return;
						async function finish(ok) {
							syncDeps.installing = false;
							syncDeps.failed = !ok;
							if (ok) {
								try {
									const m = await import("ssh2");
									syncDeps.mod = m.default ?? m;
									syncDeps.ok = true;
								} catch {}
							}
							host.notify(
								syncDeps.ok ? "success" : "error",
								syncDeps.ok
									? "📝 Editor sync dependency installation completed"
									: "📝 Editor sync dependency installation failed; run npm install ssh2 in the plugin directory",
							);
							for (const w of syncDeps.waiters.splice(0)) w(syncDeps.ok ? syncDeps.mod : null);
							broadcastSshState(); // dependency state changed → refresh the ⚠ssh2 button in the client host bar (hoisted declaration, safe)
							res(syncDeps.ok ? syncDeps.mod : null);
						}
					}
					syncDeps.installing = false;
					for (const w of syncDeps.waiters.splice(0)) w(syncDeps.ok ? syncDeps.mod : null);
					res(syncDeps.ok ? syncDeps.mod : null);
				})();
			});
		}

		function dropSyncConn(key) {
			const c = syncConns.get(key);
			if (!c) return;
			syncConns.delete(key);
			try {
				c.client.end();
			} catch {}
		}

		async function getSyncSftp(cfg) {
			const mod = await ensureSshMod();
			if (!mod?.Client) throw new Error("ssh2 dependency is not ready");
			if (!cfg?.host) throw new Error("sync is not configured; configure it or edit .vscode/sftp.json first");
			// Fingerprint changed (user edited .vscode/sftp.json) → drop the old connection and reconnect
			const fp = JSON.stringify([
				cfg.host,
				cfg.port,
				cfg.username,
				cfg.password,
				cfg.passphrase,
				cfg.privateKey,
				cfg.privateKeyPath,
				cfg.agent,
			]);
			const entry = syncConns.get(root);
			if (entry && syncConnFp === fp) return entry.sftp;
			dropSyncConn(root);
			let privateKey = "";
			if (!cfg.password && !cfg.agent) {
				if (!cfg.privateKey && !cfg.privateKeyPath)
					throw new Error("provide a password, private key, or agent in .vscode/sftp.json");
				try {
					privateKey = cfg.privateKeyPath
						? await fs.readFile(resolveKeyFile(cfg.privateKeyPath), "utf8")
						: cfg.privateKey;
				} catch {
					throw new Error(`failed to read private key file: ${cfg.privateKeyPath}`);
				}
				if (!privateKey) throw new Error("provide a password, private key, or agent in .vscode/sftp.json");
			}
			const opened = await new Promise((resolve, reject) => {
				const client = new mod.Client();
				const opts = {
					host: cfg.host,
					port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: 15000,
					keepaliveInterval: 10000,
				};
				if (cfg.password) opts.password = cfg.password;
				else if (cfg.agent) {
					// ssh-agent socket (vscode-sftp uses the "$SSH_AUTH_SOCK" placeholder)
					opts.agent = cfg.agent.replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
				} else {
					opts.privateKey = privateKey;
					if (cfg.passphrase) opts.passphrase = cfg.passphrase;
				}
				client.on("ready", () => {
					client.sftp((err, sftp) => {
						if (err) {
							try {
								client.end();
							} catch {}
							return reject(err);
						}
						syncConns.set(root, { client, sftp });
						resolve({ client, sftp });
					});
				});
				client.on("error", (e) => {
					try {
						client.end();
					} catch {}
					reject(e);
				});
				client.connect(opts);
			});
			syncConnFp = fp;
			return opened.sftp;
		}

		/** glob → RegExp (supports **, * and ?; vscode-sftp style).
		 *  Example: the rule "**" + slash + "*.map" matches both a.map and a/b/c.map */
		function globToRegExp(pattern) {
			let re = "";
			for (let i = 0; i < pattern.length; i++) {
				const c = pattern[i];
				if (c === "*") {
					if (pattern[i + 1] === "*") {
						i++;
						if (i >= pattern.length - 1)
							re += ".*"; // trailing **: matches everything left across levels (a/** matches nested files)
						else if (pattern[i + 1] === "/") {
							i++;
							re += "(?:[^/]*/)*";
						} // "**/" matches zero or more directory levels
						else re += ".*";
					} else re += "[^/]*";
				} else if (c === "?") re += "[^/]";
				else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
				else re += c;
			}
			return new RegExp(`^${re}$`);
		}

		/** Compile the ignore rule set: whole-path match + slash-free patterns apply at any
		 *  level + a directory rule covers everything under it */
		function makeIgnoreMatcher(patterns) {
			const rules = (patterns ?? [])
				.map(String)
				.filter(Boolean)
				.map((raw) => {
					const pat = raw.replace(/^\/+|\/+$/g, "");
					if (pat === "**") return [/.*/]; // ignore everything
					const list = [globToRegExp(pat)];
					if (!pat.includes("/")) {
						list.push(globToRegExp(`**/${pat}`)); // "dist", "*.log" match a segment at any level
						list.push(globToRegExp(`${pat}/**`)); // a bare dir name covers everything under it at top level
						list.push(globToRegExp(`**/${pat}/**`)); // and the contents of same-named dirs at any level
					}
					if (pat.endsWith("/**")) list.push(globToRegExp(pat.slice(0, -3))); // a/** ignores a itself too
					return list;
				});
			return (rel) => rules.some((list) => list.some((re) => re.test(rel)));
		}

		function isSyncExcluded(rel, cfg) {
			return rel === ".vscode" || rel.startsWith(".vscode/") || makeIgnoreMatcher(cfg.exclude)(rel);
		}

		/** Collect the relative file list to transfer (shared by both directions: rel paths only) */
		async function collectLocal(relBase, cfg) {
			const out = [];
			async function walk(absDir, relDir) {
				const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
				for (const d of dirents) {
					const rel = relDir ? `${relDir}/${d.name}` : d.name;
					if (isSyncExcluded(rel, cfg)) continue;
					if (d.isSymbolicLink()) continue;
					if (d.isDirectory()) await walk(path.join(absDir, d.name), rel);
					else if (d.isFile()) out.push(rel);
				}
			}
			await walk(path.resolve(root, relBase || ""), relBase || "");
			return out;
		}

		function sftpCall(sftp, method, ...args) {
			return new Promise((resolve, reject) => sftp[method](...args, (err, r) => (err ? reject(err) : resolve(r))));
		}

		async function collectRemote(sftp, remoteBase, relBase, cfg) {
			const out = [];
			async function walk(rdir, relDir) {
				let list;
				try {
					list = await sftpCall(sftp, "readdir", rdir);
				} catch {
					return;
				} // a missing directory counts as empty
				for (const f of list) {
					const rel = relDir ? `${relDir}/${f.filename}` : f.filename;
					if (isSyncExcluded(rel, cfg)) continue;
					if (f.attrs.isDirectory()) await walk(`${rdir}/${f.filename}`, rel);
					else if (f.attrs.isFile()) out.push(rel);
				}
			}
			await walk(remoteBase, relBase || "");
			return out;
		}

		async function mkdirpRemote(sftp, rpath) {
			const segs = rpath.split("/").filter(Boolean);
			let cur = rpath.startsWith("/") ? "" : ".";
			for (const s of segs) {
				cur = cur === "." ? s : `${cur}/${s}`;
				await sftpCall(sftp, "mkdir", cur).catch(() => {}); // already-exists is fine
			}
		}

		/** Run one sync task and return a summary; progress(onDone, name) reports progress. */
		async function runSyncTransfer(cfg, direction, scope, targetRel, onProgress) {
			const sftp = await getSyncSftp(cfg);
			let rels;
			if (scope === "file") {
				rels = [targetRel];
				if (isSyncExcluded(targetRel, cfg)) throw new Error(`${targetRel} is excluded by the sync rules`);
			} else {
				const baseRel = scope === "tree" ? String(targetRel || "") : "";
				rels =
					direction === "up"
						? await collectLocal(baseRel, cfg)
						: await collectRemote(sftp, posixJoin(cfg.remoteRoot || "/", baseRel), baseRel, cfg);
			}
			const failed = [];
			let done = 0;
			for (const rel of rels) {
				try {
					if (direction === "up") {
						const rp = posixJoin(cfg.remoteRoot || "/", rel);
						await mkdirpRemote(sftp, rp.split("/").slice(0, -1).join("/"));
						await sftpCall(sftp, "writeFile", rp, await fs.readFile(path.resolve(root, rel)));
					} else {
						const lp = path.resolve(root, rel);
						await fs.mkdir(path.dirname(lp), { recursive: true });
						await fs.writeFile(lp, await sftpCall(sftp, "readFile", posixJoin(cfg.remoteRoot || "/", rel)));
					}
				} catch (err) {
					failed.push({ rel, error: err?.message ?? String(err) });
				}
				done++;
				onProgress(done, rels.length, rel);
			}
			return { total: rels.length, failed };
		}

		// ------------------------------------------------------------------
		// SSH remote hosts (Remote-SSH mode)
		//
		// Host CRUD (<pluginDir>/ssh-hosts.json, local-only, redacted on echo; on first
		// run the list is migrated from the old standalone ssh plugin's file of the same
		// name) + a connection pool (kept alive with keepalive) + PTY shell (base64
		// streaming) + exec.
		// Remote file operations get no separate actions - the client passes connId on
		// list/read/write/create/rename/delete and the request routes to that
		// connection's SFTP, sharing one client-side code path with local files.
		// The ssh2 dependency reuses ensureSshMod above (auto-installed when missing).
		// Events: shell_data / shell_exit / conn_closed go only to the creating socket;
		// kind:"state" broadcasts host/connection list changes (credentials redacted).
		// ------------------------------------------------------------------
		const SSH_STORE = path.join(host.dir, "ssh-hosts.json");
		const LEGACY_SSH_STORE = path.join(host.dir, "..", "ssh", "ssh-hosts.json");
		// Secret storage: host password/private key/passphrase go to the host's
		// host.secrets (AES-256-GCM) keyed by host id; ssh-hosts.json no longer stores
		// plaintext credentials. Hosts without that facility fall back to the old behaviour.
		const sec = host.secrets;
		const SECRET_FIELDS = [
			["password", "pass"],
			["privateKey", "key"],
			["passphrase", "pp"],
		];

		function hostSecretName(hostId, fileField) {
			for (const [f, short] of SECRET_FIELDS) if (f === fileField) return `ssh:${hostId}:${short}`;
			return null;
		}

		let sshCfgs = null;
		const sshConns = new Map(); // connId → connection record
		let nextSshConn = 1;

		async function ensureSshCfgs() {
			if (sshCfgs) return sshCfgs;
			try {
				sshCfgs = JSON.parse(await fs.readFile(SSH_STORE, "utf8"));
			} catch {
				sshCfgs = {};
			}
			if (!Array.isArray(sshCfgs.hosts)) {
				try {
					// Migrate the host list from the old standalone ssh plugin (same format, copied as-is)
					const legacy = JSON.parse(await fs.readFile(LEGACY_SSH_STORE, "utf8"));
					if (Array.isArray(legacy.hosts) && legacy.hosts.length) sshCfgs.hosts = legacy.hosts;
				} catch {}
			}
			if (!Array.isArray(sshCfgs.hosts)) sshCfgs.hosts = [];
			if (sec?.set) {
				// One-time migration: legacy plaintext credentials → encrypted secrets + stripped from the file
				let migrated = false;
				for (const h of sshCfgs.hosts) {
					if (!h.id) continue;
					for (const [field] of SECRET_FIELDS) {
						const name = hostSecretName(h.id, field);
						if (h[field] && name) {
							try {
								sec.set(name, String(h[field]));
							} catch {
								continue;
							}
							delete h[field];
							migrated = true;
						}
					}
				}
				if (migrated) {
					try {
						await saveSshCfgs();
					} catch {}
					host.log("migrated SSH host credentials to encrypted storage");
				}
			}
			if (sec?.get) {
				// Refill the in-memory copy (connecting needs real credentials; redaction happens in publicSshHost)
				for (const h of sshCfgs.hosts) {
					if (!h.id) continue;
					for (const [field] of SECRET_FIELDS) {
						if (!h[field]) {
							const name = hostSecretName(h.id, field);
							const v = name ? sec.get(name) : undefined;
							if (v !== undefined) h[field] = v;
						}
					}
				}
			}
			return sshCfgs;
		}

		async function saveSshCfgs() {
			const hosts = sec
				? (sshCfgs?.hosts ?? []).map((h) => {
						const clean = { ...h };
						for (const [field] of SECRET_FIELDS) delete clean[field]; // credentials only ever live in the secret store
						return clean;
					})
				: (sshCfgs?.hosts ?? []);
			await fs.writeFile(SSH_STORE, JSON.stringify({ ...sshCfgs, hosts }, null, "\t"), "utf8");
		}

		/** Save/clear one credential field of one host (truthy value → write; explicit null → delete). */
		function storeHostSecret(hostId, field, value) {
			const name = hostSecretName(hostId, field);
			if (!sec || !name || !hostId) return;
			try {
				if (value === null) sec.delete(name);
				else if (value) sec.set(name, String(value));
			} catch {}
		}

		/** Redacted echo: passwords, keys and passphrases report presence only.
		 *  A key path and an agent socket are not secrets, so they echo verbatim. */
		function publicSshHost(h) {
			return {
				id: h.id,
				name: h.name,
				host: h.host,
				port: h.port ?? 22,
				username: h.username ?? "root",
				hasPass: Boolean(h.password),
				hasKey: Boolean(h.privateKey || h.privateKeyPath),
				hasPassphrase: Boolean(h.passphrase),
				privateKeyPath: h.privateKeyPath ?? "",
				agent: h.agent ?? "",
			};
		}

		function publicSshState() {
			return {
				depsReady: syncDeps.ok,
				depsInstalling: syncDeps.installing,
				hosts: (sshCfgs?.hosts ?? []).map(publicSshHost),
				conns: [...sshConns.values()].map((c) => ({
					connId: c.connId,
					hostId: c.hostId,
					label: c.label,
					status: c.status,
				})),
			};
		}

		function broadcastSshState() {
			host.broadcast({ kind: "state", state: publicSshState() });
		}

		function getSshConn(connId) {
			const c = sshConns.get(connId);
			if (!c) throw new Error("connection does not exist or is closed");
			return c;
		}

		function dropSshConn(c, reason) {
			if (!sshConns.has(c.connId)) return;
			sshConns.delete(c.connId);
			for (const [, stream] of c.streams) {
				try {
					stream.end();
				} catch {}
			}
			c.streams.clear();
			try {
				c.client.end();
			} catch {}
			host.sendTo(c.ownerId, { event: "conn_closed", connId: c.connId, reason: reason ?? "" });
			broadcastSshState();
		}

		/** Read ~/.ssh/config and mark the candidates that are already saved. */
		async function readSshConfigCandidates() {
			const file = path.join(os.homedir(), ".ssh", "config");
			let text;
			try {
				text = await fs.readFile(file, "utf8");
			} catch {
				throw new Error("~/.ssh/config not found");
			}
			const list = parseSshConfig(text);
			if (!list.length) throw new Error("~/.ssh/config contains no importable host");
			await ensureSshCfgs();
			const exists = new Set();
			for (const h of sshCfgs.hosts) {
				if (h.host) exists.add(`${h.host}:${h.port ?? 22}:${h.username ?? "root"}`);
				if (h.name) exists.add(`name:${h.name}`);
			}
			return list.map((c) => ({
				...c,
				imported: exists.has(`${c.host}:${c.port}:${c.username}`) || exists.has(`name:${c.alias}`),
			}));
		}

		async function connectSshHost(cfg, clientId, reqId) {
			try {
				const mod = await ensureSshMod();
				if (!mod?.Client) throw new Error("ssh2 dependency is not ready; try again shortly");
				const connId = `c${nextSshConn++}`;
				const c = {
					connId,
					client: new mod.Client(),
					ownerId: clientId,
					hostId: cfg.id,
					label: cfg.name && cfg.name !== cfg.host ? cfg.name : `${cfg.username}@${cfg.host}`,
					status: "connecting",
					streams: new Map(),
					nextShell: 1,
					sftp: null,
				};
				sshConns.set(connId, c);
				broadcastSshState();
				const opts = {
					host: cfg.host,
					port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: CONN_TIMEOUT_MS,
					keepaliveInterval: 10000,
					keepaliveCountMax: 3,
				};
				if (cfg.agent) {
					// ssh-agent socket, same placeholder rule as the SFTP sync side.
					opts.agent = String(cfg.agent).replace(/\$SSH_AUTH_SOCK\b/g, () => process.env.SSH_AUTH_SOCK || "");
				} else {
					if (cfg.password) opts.password = cfg.password;
					// privateKeyPath wins over an inline PEM (same rule as the sync side);
					// the path supports ~ expansion through resolveKeyFile.
					const keyPath = cfg.privateKeyPath ? resolveKeyFile(String(cfg.privateKeyPath).trim()) : null;
					let key = null;
					if (keyPath) {
						try {
							key = await fs.readFile(keyPath, "utf8");
						} catch {
							throw new Error(`failed to read private key file: ${cfg.privateKeyPath}`);
						}
					} else if (cfg.privateKey) key = cfg.privateKey;
					if (key) opts.privateKey = key;
					if (cfg.passphrase) opts.passphrase = cfg.passphrase;
					if (!opts.password && !opts.privateKey && !opts.agent) {
						// Not enough to authenticate: drop the entry instead of leaving a
						// half-open connection behind (same handling as a failed first connect).
						sshConns.delete(connId);
						broadcastSshState();
						throw new Error("provide a password, private key, key path or agent in the host editor");
					}
				}
				c.client
					.on("ready", () => {
						c.status = "connected";
						host.sendTo(clientId, { res: true, reqId, ok: true, action: "connect", connId, label: c.label });
						broadcastSshState();
					})
					.on("error", (err) => {
						const m = err?.level ? `[${err.level}] ${err.message}` : (err?.message ?? String(err));
						if (c.status === "connecting") {
							// A failed first connect leaves no half-open connection behind
							sshConns.delete(connId);
							broadcastSshState();
							host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: m });
						} else dropSshConn(c, m);
					})
					.on("close", () => dropSshConn(c, "connection closed"));
				c.client.connect(opts);
			} catch (err) {
				host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: err?.message ?? String(err) });
			}
		}

		function getSftp(c) {
			if (c.sftp) return Promise.resolve(c.sftp);
			return new Promise((resolve, reject) => {
				c.client.sftp((err, sftp) => {
					if (err) return reject(err);
					c.sftp = sftp;
					sftp.on("close", () => {
						if (c.sftp === sftp) c.sftp = null;
					});
					resolve(sftp);
				});
			});
		}

		// ---- Remote file operations (over the connection's SFTP; errors bubble to the router catch) ----
		async function remoteList(c, dirPath) {
			const list = await sftpCall(await getSftp(c), "readdir", dirPath || "/");
			const entries = list.map((f) => ({
				name: f.filename,
				type: f.attrs.isDirectory() ? "dir" : f.attrs.isSymbolicLink() ? "link" : "file",
				size: Number(f.attrs.size ?? 0),
			}));
			const rank = (type) => (type === "dir" ? 0 : type === "link" ? 1 : 2);
			entries.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name));
			return entries;
		}

		async function remoteRead(c, p) {
			const sftp = await getSftp(c);
			const stat = await sftpCall(sftp, "stat", p);
			if (stat.size > MAX_READ_BYTES) throw new Error(`file exceeds ${MAX_READ_BYTES / 1024 / 1024}MB limit`);
			const buf = await sftpCall(sftp, "readFile", p);
			if (buf.includes(0)) return { binary: true, size: buf.length };
			return { text: decodeBuf(buf), encoding: "utf-8", size: buf.length };
		}

		async function remoteWrite(c, p, text) {
			await sftpCall(await getSftp(c), "writeFile", p, Buffer.from(String(text ?? ""), "utf8"));
		}

		async function remoteCreate(c, p, kind) {
			const sftp = await getSftp(c);
			if (kind === "dir") await sftpCall(sftp, "mkdir", p);
			else await sftpCall(sftp, "writeFile", p, Buffer.alloc(0));
		}

		async function remoteRename(c, p, newName) {
			if (
				typeof newName !== "string" ||
				!newName.trim() ||
				newName.includes("/") ||
				newName.includes("\\") ||
				newName.includes("..")
			) {
				throw new Error("invalid new name");
			}
			const idx = p.lastIndexOf("/");
			const parent = idx >= 0 ? p.slice(0, idx) : "";
			await sftpCall(await getSftp(c), "rename", p, parent ? `${parent}/${newName}` : newName);
		}

		async function remoteDelete(c, p, isDir) {
			const sftp = await getSftp(c);
			if (isDir) await sftpCall(sftp, "rmdir", p);
			else await sftpCall(sftp, "unlink", p);
		}

		// ---- PTY shell and exec ---------------------------------------------------
		function sshOpenShell(c, msg, reqId, clientId) {
			c.ownerId = clientId; // after a reconnect or in a second tab the newest requester takes over this connection's terminal stream
			c.client.shell({ cols: msg.cols ?? 80, rows: msg.rows ?? 24, term: "xterm-256color" }, (err, stream) => {
				if (err)
					return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "shell_open", error: err.message });
				const shellId = `s${c.nextShell++}`;
				c.streams.set(shellId, stream);
				const onData = (d) =>
					host.sendTo(c.ownerId, {
						event: "shell_data",
						connId: c.connId,
						shellId,
						b64: d.toString("base64"),
					});
				stream.on("data", onData);
				stream.stderr.on("data", onData);
				stream.on("close", () => {
					c.streams.delete(shellId);
					host.sendTo(c.ownerId, { event: "shell_exit", connId: c.connId, shellId });
				});
				host.sendTo(clientId, { res: true, reqId, ok: true, action: "shell_open", shellId });
			});
		}

		function sshExec(c, cmd, reqId, clientId) {
			c.client.exec(cmd, (err, stream) => {
				if (err) return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "exec", error: err.message });
				const chunks = [];
				stream.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.stderr.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.on("close", (code) => {
					let out = chunks.join("");
					if (out.length > MAX_EXEC_OUTPUT) out = out.slice(0, MAX_EXEC_OUTPUT) + "\n…[truncated]";
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "exec", exitCode: code ?? 0, output: out });
				});
			});
		}

		// ------------------------------------------------------------------
		// Upload: the local workspace and remote SFTP share one chunk protocol.
		//
		// Protocol: upload_begin (validate the target + report exists so the client can
		// confirm an overwrite) → upload chunk by chunk (base64, order checked) → the last
		// chunk finishes the file. Local chunks append to a temp file in the target dir and
		// the last chunk renames it into place (same semantics as writeFile, no half-written
		// content); remote chunks buffer in memory and the last chunk does a single
		// sftp.writeFile (same size cap as download).
		// Sessions are isolated by clientId:uploadId; client errors and timeouts are cleaned
		// up by upload_abort plus the periodic sweep. Files upload one at a time, ordered by
		// the client.
		// ------------------------------------------------------------------
		const uploads = new Map(); // `${clientId}:${uploadId}` → upload session

		function sweepUploads() {
			const now = Date.now();
			for (const [, u] of uploads) {
				if (now - u.last > UPLOAD_STALE_MS) void abortUploadEntry(u);
			}
		}

		/** Abort and clean up one upload session (close the handle / drop the temp file /
		 *  discard buffered chunks).
		 *  Returns a Promise: on Windows unlinking before the handle is closed gives
		 *  EBUSY/EPERM, and the old void close() + immediate swallowed unlink left `.part`
		 *  files behind (the client re-checks the directory right after upload_abort, so the
		 *  file must be gone before the response goes out). */
		async function abortUploadEntry(u) {
			if (!u) return;
			uploads.delete(u.key);
			const fh = u.fh;
			u.fh = null;
			u.bufs = [];
			if (fh) {
				try {
					await fh.close();
				} catch {}
			}
			if (u.tmp) {
				try {
					await fs.unlink(u.tmp);
				} catch {}
			}
		}

		/** Start: validate target dir/file name/size and probe whether the target exists (so
		 *  the client can confirm an overwrite); local opens the temp file handle up front
		 *  (chunks append in order), remote only validates the path. */
		async function beginUpload(clientId, msg) {
			const name = String(msg.name ?? "");
			if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
				throw new Error("invalid file name");
			}
			const size = Number(msg.size);
			if (!Number.isFinite(size) || size <= 0) throw new Error("invalid file size");
			if (size > MAX_UPLOAD_BYTES)
				throw new Error(`file exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`);
			sweepUploads();
			const uploadId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
			const key = `${clientId}:${uploadId}`;
			const last = Date.now();
			if (msg.connId) {
				const c = getSshConn(msg.connId);
				const rpath = safeRemotePath(posixJoin(String(msg.dir ?? "/"), name));
				let exists = false;
				try {
					exists = (await sftpCall(await getSftp(c), "stat", rpath)).isFile();
				} catch {}
				uploads.set(key, {
					key,
					uploadId,
					scope: "remote",
					connId: msg.connId,
					rpath,
					bufs: [],
					bytes: 0,
					total: size,
					last,
					next: 0,
				});
				return { uploadId, exists };
			}
			const absDir = safeResolve(String(msg.dir ?? ""));
			if (!absDir) throw new Error("path escapes workspace");
			const finalAbs = path.join(absDir, name);
			let exists = false;
			try {
				exists = (await fs.stat(finalAbs)).isFile();
			} catch {}
			await fs.mkdir(absDir, { recursive: true });
			const tmp = path.join(absDir, `.vsc-upload-${uploadId}.part`);
			const fh = await fs.open(tmp, "w"); // handle stays open, chunks append in order
			uploads.set(key, {
				key,
				uploadId,
				scope: "local",
				tmp,
				finalAbs,
				fh,
				bufs: null,
				bytes: 0,
				total: size,
				last,
				next: 0,
			});
			return { uploadId, exists };
		}

		/** Take one chunk; non-final chunks return {received}, the final chunk finishes the
		 *  transfer, ends the session and returns {done, size} */
		async function chunkUpload(clientId, msg) {
			const u = uploads.get(`${clientId}:${msg.uploadId}`);
			if (!u) throw new Error("upload session does not exist or timed out; upload again");
			if (Number(msg.i) !== u.next) throw new Error("upload chunks are out of order");
			u.last = Date.now();
			sweepUploads();
			const buf = Buffer.from(String(msg.b64 ?? ""), "base64");
			if (!buf.length) throw new Error("empty upload chunk");
			u.bytes += buf.length;
			if (u.bytes > MAX_UPLOAD_BYTES)
				throw new Error(`file exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`);
			if (u.scope === "local") await u.fh.write(buf, 0, buf.length, null);
			else u.bufs.push(buf);
			if (Number(msg.i) !== Number(msg.total) - 1) {
				u.next++;
				return { received: u.next };
			}
			// Final chunk: finish writing, session over
			if (u.scope === "local") {
				await u.fh.close().catch(() => {});
				u.fh = null;
				await fs.rename(u.tmp, u.finalAbs); // atomic replace (overwrites an existing file)
			} else {
				const sftp = await getSftp(getSshConn(u.connId));
				await mkdirpRemote(sftp, u.rpath.split("/").slice(0, -1).join("/")); // create the target dir when missing (same semantics as local)
				await sftpCall(sftp, "writeFile", u.rpath, Buffer.concat(u.bufs, u.bytes));
			}
			uploads.delete(u.key);
			return { done: true, size: u.bytes };
		}

		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;
			try {
				switch (action) {
					case "list": // single directory level (lazy tree expansion); with connId = remote directory
						if (msg.connId) {
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								dir: String(msg.dir ?? "/"),
								entries: await remoteList(getSshConn(msg.connId), msg.dir),
							});
							break;
						}
						host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							dir: toWire(msg.dir ?? ""),
							entries: await listDir(msg.dir),
						});
						break;
					case "flatlist":
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...(await flatList()) });
						break;
					case "download": {
						// Download to the user's machine: local reads directly; with connId it goes over remote SFTP, folders are packed as tar.gz
						if (!msg.connId) {
							const abs = safeResolve(String(msg.path ?? ""));
							if (!abs || abs === root) throw new Error("invalid path");
							const st = await fs.stat(abs);
							if (!st.isFile()) throw new Error("not a regular file");
							if (st.size > MAX_DOWNLOAD_BYTES)
								throw new Error(`file exceeds ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB limit`);
							const buf = await fs.readFile(abs);
							host.sendTo(clientId, { res: true, reqId, ok: true, action, b64: buf.toString("base64"), size: st.size });
							break;
						}
						// Remote branch
						const c = getSshConn(msg.connId);
						const p = safeRemotePath(msg.path).replace(/\/+$/, "") || "/";
						const sftp = await getSftp(c);
						let st;
						try {
							st = await sftpCall(sftp, "stat", p);
						} catch {
							throw new Error("path does not exist");
						}
						if (st.isDirectory()) {
							// Folder: pack it remotely (tar.gz) instead of transferring file by file
							const clean = p.replace(/\/+$/, "");
							const name = clean.split("/").pop();
							const parent = clean.split("/").slice(0, -1).join("/") || "/";
							const buf = await sshExecBuffer(c, `cd ${shQuote(parent)} && tar -czf - ${shQuote(name)}`);
							if (!buf.length)
								throw new Error("archive failed because remote tar is unavailable or the directory is unreadable");
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								b64: buf.toString("base64"),
								size: buf.length,
								name: `${name}.tar.gz`,
							});
						} else {
							if (Number(st.size) > MAX_DOWNLOAD_BYTES)
								throw new Error(`file exceeds ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB limit`);
							const buf = await sftpCall(sftp, "readFile", p);
							host.sendTo(clientId, {
								res: true,
								reqId,
								ok: true,
								action,
								b64: buf.toString("base64"),
								size: buf.length,
								name: p.split("/").pop(),
							});
						}
						break;
					}
					case "read": {
						const r = msg.connId
							? await remoteRead(getSshConn(msg.connId), String(msg.path ?? ""))
							: await readFile(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...r });
						break;
					}
					case "write":
						if (msg.connId) await remoteWrite(getSshConn(msg.connId), String(msg.path ?? ""), msg.text);
						else await writeFile(msg.path, msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path });
						break;
					case "create":
						if (msg.connId) await remoteCreate(getSshConn(msg.connId), String(msg.path ?? ""), msg.kind);
						else await createEntry(msg.path, msg.kind);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "rename":
						if (msg.connId) await remoteRename(getSshConn(msg.connId), String(msg.path ?? ""), msg.newName);
						else await renameEntry(msg.path, msg.newName);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "delete":
						if (msg.connId) await remoteDelete(getSshConn(msg.connId), String(msg.path ?? ""), Boolean(msg.isDir));
						else await deleteEntry(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "upload_begin": {
						// Start: report exists (for overwrite confirmation) + create the session
						const st = await beginUpload(clientId, msg);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...st });
						break;
					}
					case "upload": {
						// One chunk; the last one (i === total-1) finishes the transfer and ends the session
						const st = await chunkUpload(clientId, msg);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...st });
						break;
					}
					case "upload_abort": {
						// Abort the session (clean up the temp file when the client errors or the user cancels an overwrite)
						const u = uploads.get(`${clientId}:${msg.uploadId}`);
						if (u) await abortUploadEntry(u);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "sync_get": {
						// Note: not to be confused with remote SFTP operations (those go through list/read + connId)
						const cfg = await readSyncCfg();
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							config: publicSync(cfg),
							configPath: ".vscode/sftp.json", // the client's "edit config file" entry point
						});
					}
					case "sync_save": {
						const c = msg.config ?? {};
						if (!c.host || !String(c.host).trim()) throw new Error("host address is required");
						if (
							!String(c.remoteRoot ?? "")
								.trim()
								.startsWith("/")
						)
							throw new Error("remote root must be an absolute path starting with /");
						const old = await readSyncCfg();
						const next = normalizeCfg({
							...old,
							host: String(c.host).trim(),
							port: Number(c.port) || 22,
							username: c.username ?? old.username ?? "root",
							name: c.name !== undefined ? String(c.name || "") : (old.name ?? ""),
							// Blank credential = keep the old value; explicit null = clear it
							password: c.password === null ? "" : c.password || old.password,
							passphrase: c.passphrase === null ? "" : c.passphrase || old.passphrase,
							privateKey: c.privateKey === null ? "" : c.privateKey || old.privateKey,
							privateKeyPath:
								c.privateKeyPath !== undefined ? String(c.privateKeyPath || "").trim() : (old.privateKeyPath ?? ""),
							agent: c.agent !== undefined ? String(c.agent || "") : (old.agent ?? ""),
							remoteRoot: String(c.remoteRoot).trim(),
							exclude: Array.isArray(c.exclude) ? c.exclude.map(String) : [],
							uploadOnSave: Boolean(c.uploadOnSave),
						});
						await saveSyncCfg(next);
						dropSyncConn(root); // config changed, the old connection is stale
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							config: publicSync(next),
							configPath: ".vscode/sftp.json",
						});
					}
					case "sync_ensure": {
						// "Edit config file": make sure it exists (write a template or migrate when needed), return the relative path
						let cfg = await readSyncCfg();
						if (!cfg.host) {
							cfg = normalizeCfg({ host: "", remoteRoot: "/", ignore: [".git", "node_modules"] });
							await saveSyncCfg(cfg);
						}
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							path: ".vscode/sftp.json",
							configPath: ".vscode/sftp.json",
						});
					}
					case "sync_test": {
						const cfg = await readSyncCfg();
						if (!cfg?.host) throw new Error("sync is not configured; configure it or edit .vscode/sftp.json first");
						const sftp = await getSyncSftp(cfg);
						// Probe that the remote root is reachable
						await sftpCall(sftp, "readdir", cfg.remoteRoot || "/");
						return void host.sendTo(clientId, { res: true, reqId, ok: true, action });
					}
					case "sync_run": {
						const cfg = await readSyncCfg();
						if (!cfg?.host) throw new Error("sync is not configured; configure it or edit .vscode/sftp.json first");
						const direction = msg.dir === "down" ? "down" : "up";
						const scope = ["file", "tree", "all"].includes(msg.scope) ? msg.scope : "file";
						if (scope === "file") {
							const abs = safeResolve(msg.path);
							if (!abs || abs === root) throw new Error("invalid path");
						}
						const summary = await runSyncTransfer(cfg, direction, scope, msg.path ?? "", (done, total, name) =>
							host.sendTo(clientId, { event: "sync_progress", done, total, name }),
						);
						return void host.sendTo(clientId, {
							res: true,
							reqId,
							ok: true,
							action,
							...summary,
							dir: direction,
							scope,
						});
					}
					// ----------------------------------------------------------------
					// SSH remote host management
					// ----------------------------------------------------------------
					case "state": // plugin state: host list / connection list / ssh2 dependency state (redacted)
						await ensureSshCfgs();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, state: publicSshState() });
						break;
					case "deps_install":
						ensureSshMod(true); // Explicit user request retries a previous failed installation.
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "hosts_save": {
						await ensureSshCfgs();
						const h = msg.host ?? {};
						if (!h.host || !String(h.host).trim()) throw new Error("host address is required");
						if (h.id) {
							const i = sshCfgs.hosts.findIndex((x) => x.id === h.id);
							if (i < 0) throw new Error("host does not exist");
							const old = sshCfgs.hosts[i];
							// Credentials go to the secret store: blank = keep the old value,
							// explicit null = clear (and delete the secret). The in-memory object
							// keeps the real credential for connecting; publicSshHost redacts it.
							storeHostSecret(h.id, "password", h.password === null ? null : h.password || undefined);
							storeHostSecret(h.id, "privateKey", h.privateKey === null ? null : h.privateKey || undefined);
							storeHostSecret(h.id, "passphrase", h.passphrase === null ? null : h.passphrase || undefined);
							sshCfgs.hosts[i] = {
								...old,
								name: h.name ?? old.name,
								host: String(h.host).trim() || old.host,
								port: Number(h.port) || old.port,
								username: h.username ?? old.username,
								// Blank = keep the old value, explicit null = clear.
								password: h.password === null ? undefined : h.password || old.password,
								privateKey: h.privateKey === null ? undefined : h.privateKey || old.privateKey,
								passphrase: h.passphrase === null ? undefined : h.passphrase || old.passphrase,
								// Path and agent are not secrets: an absent field keeps the old
								// value, an empty string clears it.
								privateKeyPath:
									h.privateKeyPath !== undefined
										? String(h.privateKeyPath || "").trim() || undefined
										: (old.privateKeyPath ?? undefined),
								agent: h.agent !== undefined ? String(h.agent || "") || undefined : (old.agent ?? undefined),
							};
						} else {
							if (!h.password && !h.privateKey && !h.privateKeyPath && !h.agent)
								throw new Error(
									"provide a password, private key, key path or agent; empty credentials cannot authenticate",
								);
							if (sshCfgs.hosts.length >= MAX_SSH_HOSTS) throw new Error(`at most ${MAX_SSH_HOSTS} hosts can be saved`);
							const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
							storeHostSecret(id, "password", h.password || undefined);
							storeHostSecret(id, "privateKey", h.privateKey || undefined);
							storeHostSecret(id, "passphrase", h.passphrase || undefined);
							sshCfgs.hosts.push({
								id,
								name: String(h.name || h.host),
								host: String(h.host).trim(),
								port: Number(h.port) || 22,
								username: String(h.username || "root"),
								password: h.password ? String(h.password) : undefined,
								privateKey: h.privateKey ? String(h.privateKey) : undefined,
								passphrase: h.passphrase ? String(h.passphrase) : undefined,
								privateKeyPath: h.privateKeyPath ? String(h.privateKeyPath).trim() : undefined,
								agent: h.agent ? String(h.agent) : undefined,
							});
						}
						await saveSshCfgs();
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "sshconfig_list": {
						// Parse ~/.ssh/config; candidates already saved are flagged as imported.
						const list = await readSshConfigCandidates();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, hosts: list });
						break;
					}
					case "sshconfig_import": {
						// Bulk import: only the key path is stored, never the key's contents.
						await ensureSshCfgs();
						const aliases = Array.isArray(msg.aliases) ? msg.aliases.map(String) : [];
						if (!aliases.length) throw new Error("select at least one host to import");
						const wanted = new Map((await readSshConfigCandidates()).map((c) => [c.alias, c]));
						let added = 0;
						let skipped = 0;
						for (const alias of aliases) {
							const c = wanted.get(alias);
							if (!c || c.imported) {
								skipped++;
								continue;
							}
							if (sshCfgs.hosts.length >= MAX_SSH_HOSTS)
								throw new Error(`at most ${MAX_SSH_HOSTS} hosts can be saved (${added} imported so far)`);
							const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}${added}`;
							sshCfgs.hosts.push({
								id,
								name: c.alias,
								host: c.host,
								port: c.port,
								username: c.username,
								privateKeyPath: c.privateKeyPath || undefined,
							});
							added++;
						}
						await saveSshCfgs();
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, added, skipped });
						break;
					}
					case "hosts_delete": {
						await ensureSshCfgs();
						const before = sshCfgs.hosts.length;
						for (const x of sshCfgs.hosts) {
							if (x.id === msg.id) for (const [field] of SECRET_FIELDS) storeHostSecret(x.id, field, null);
						}
						sshCfgs.hosts = sshCfgs.hosts.filter((x) => x.id !== msg.id);
						if (sshCfgs.hosts.length === before) throw new Error("host does not exist");
						await saveSshCfgs();
						for (const c of [...sshConns.values()]) if (c.hostId === msg.id) dropSshConn(c, "host deleted");
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "connect": {
						await ensureSshCfgs();
						const cfg = sshCfgs.hosts.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("host does not exist");
						void connectSshHost(cfg, clientId, reqId); // replies asynchronously on ready/error; it reports its own failures
						return;
					}
					case "disconnect":
						dropSshConn(getSshConn(msg.connId), "manually disconnected");
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "shell_open":
						return void sshOpenShell(getSshConn(msg.connId), msg, reqId, clientId);
					case "shell_close": {
						const c = getSshConn(msg.connId);
						c.streams.get(msg.shellId)?.end();
						c.streams.delete(msg.shellId);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "shell_input": // streaming channel with no reqId: failures stay silent, no response protocol
						if (typeof msg.b64 !== "string") return;
						try {
							getSshConn(msg.connId).streams.get(msg.shellId)?.write(Buffer.from(msg.b64, "base64"));
						} catch {}
						return;
					case "shell_resize":
						try {
							getSshConn(msg.connId)
								.streams.get(msg.shellId)
								?.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0);
						} catch {}
						return;
					case "exec":
						return void sshExec(getSshConn(msg.connId), String(msg.cmd ?? ""), reqId, clientId);
					default:
						host.log("unknown action:", action);
						host.sendTo(clientId, fail(reqId, `unknown action ${action}`));
				}
			} catch (err) {
				host.sendTo(clientId, fail(reqId, err?.message ?? String(err)));
			}
		});

		host.log(`activated; workspace root: ${toWire(root)}`);
		// Push the full state to a client as soon as it attaches (the server is the single
		// source of truth, matching the main app's snapshot architecture).
		// host.onAttach does not exist on old hosts (<0.35) - optional chaining keeps it
		// compatible, and the client still has its reqId-based pull as a fallback.
		const offAttach = host.onAttach?.(async (clientId) => {
			await ensureSshCfgs();
			host.sendTo(clientId, { kind: "state", state: publicSshState() });
		});
		// The workspace follows the main app's set_cwd live: root changed → the old project's
		// sync connections are stale (.vscode/sftp.json is per project), and the client is
		// told to drop its cache and rebuild the tree.
		const offCwd = host.onCwdChange?.((next) => {
			root = path.resolve(next);
			for (const [, c] of syncConns) {
				try {
					c.client.end();
				} catch {}
			}
			syncConns.clear();
			host.broadcast({ kind: "workspace", root: toWire(root) });
			host.log(`workspace root switched: ${toWire(root)}`);
		});
		void ensureSshMod(); // Preload or install ssh2; host configuration stays lazy so external updates are visible.
		return async () => {
			off();
			try {
				offAttach?.();
			} catch {}
			try {
				offCwd?.();
			} catch {}
			for (const [, c] of syncConns) {
				try {
					c.client.end();
				} catch {}
			}
			syncConns.clear();
			for (const c of [...sshConns.values()]) dropSshConn(c, "deactivated");
			await Promise.all([...uploads.values()].map((u) => abortUploadEntry(u)));
			uploads.clear();
			host.log("deactivated");
		};
	},
};

// Note: host.cwd is live (it follows the main app's set_cwd; on old hosts it is still a
// startup snapshot). The editor uses it as the workspace root - on onCwdChange it swaps
// roots, drops the stale sync connections and tells the client.

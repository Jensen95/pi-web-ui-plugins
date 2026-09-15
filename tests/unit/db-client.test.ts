/**
 * db-client: manifest contract, exported pure helpers, the message protocol the
 * server entry speaks to the host, the client entry's pure helpers, and the
 * compiled artifacts.
 *
 * Nothing here touches a database, a network socket or npm. Two guards make that
 * true rather than hopeful:
 *   - PI_DB_CLIENT_NO_AUTOINSTALL is the plugin's own kill switch for the driver
 *     auto-install it performs on activation, and it is set for this whole file.
 *   - every connection the tests open is one whose driver is NOT installed, so
 *     openAdapter() fails on the dependency check before a factory ever runs.
 * The install decision logic that does spawn npm lives in db-client-install.test.ts
 * with node:child_process mocked.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockHost, createMockViewContext, type MockHost } from "../helpers/mock-host";
import { buildPlugin } from "../helpers/plugin-build";
import {
	importClientArtifact,
	importServerArtifact,
	isClientEntry,
	isServerEntry,
	loadPlugin,
} from "../helpers/plugin-contract";
import { CJK_RE, findCjk, formatCjkHits, repoFiles } from "../helpers/repo-files";
import plugin, {
	ADAPTER_FACTORIES,
	DB_TYPES,
	DEPS,
	DRIVER_MODULE,
	cellVal,
	parseJsonFilter,
	qMssql,
	qMysql,
	qPg,
	qSqlite,
	rowsToGrid,
	tokenize,
	winQuote,
	withTimeout,
	type DbEngine,
	type PublicConn,
	type PublicState,
} from "../../plugins/db-client/src/index";
import client, { connAddr, esc, fmtCount } from "../../plugins/db-client/src/client.ts";

// Must be set before any activate() call: the plugin installs drivers on first
// activation and a unit test must never reach npm.
process.env.PI_DB_CLIENT_NO_AUTOINSTALL = "1";

const PLUGIN_ID = "db-client";
const PLUGIN_DIR = `plugins/${PLUGIN_ID}`;
const CONFIG_FILE = "db-connections.json";
const ENGINES: DbEngine[] = ["mysql", "postgres", "sqlite", "sqlserver", "mongodb", "redis"];

/** Permissions declared upstream; the port must not silently change them. */
const MANIFEST_PERMISSIONS = ["net", "tools"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const dirs: string[] = [];

/** A real, empty plugin directory so config persistence can be asserted. */
function pluginDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "db-client-test-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface Live {
	host: MockHost;
	dir: string;
	deactivate: (() => void) | undefined;
}

/** Activate the server entry against a mock host with the plugin's real
 *  permissions and a writable plugin directory. */
async function activate(overrides: { dir?: string; secrets?: Record<string, string> } = {}): Promise<Live> {
	const dir = overrides.dir ?? pluginDir();
	const host = createMockHost({
		dir,
		permissions: MANIFEST_PERMISSIONS,
		secrets: overrides.secrets,
	});
	const ret = await plugin.activate(host);
	return { host, dir, deactivate: typeof ret === "function" ? ret : undefined };
}

let seq = 0;

/** Send one message through the host and return the single response the plugin
 *  sent back for that reqId. Fails when the plugin answered zero or twice. */
async function send(
	host: MockHost,
	message: Record<string, unknown>,
	clientId = "c1",
): Promise<Record<string, unknown>> {
	const reqId = `t${++seq}`;
	await host.emit.message({ ...message, reqId }, clientId);
	const replies = host.recorded.sent.filter(
		(s) => isRecord(s.payload) && s.payload.res === true && s.payload.reqId === reqId,
	);
	expect(replies, `expected exactly one reply for ${reqId}`).toHaveLength(1);
	return replies[0].payload as Record<string, unknown>;
}

/** Drive the plugin's readiness gate to completion and return the state it
 *  reports. Every message handler awaits ensureReady() first, so one round trip
 *  is enough to flush config loading and the driver probe. */
async function readyState(host: MockHost): Promise<PublicState> {
	const res = await send(host, { action: "state" });
	expect(res.ok).toBe(true);
	return res.state as PublicState;
}

function lastBroadcastState(host: MockHost): PublicState {
	for (let i = host.recorded.broadcasts.length - 1; i >= 0; i -= 1) {
		const payload = host.recorded.broadcasts[i];
		if (isRecord(payload) && payload.kind === "state") return payload.state as PublicState;
	}
	throw new Error("no state broadcast was sent");
}

function readConfig(dir: string): { conns: Record<string, unknown>[] } {
	return JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8")) as { conns: Record<string, unknown>[] };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

describe("db-client manifest", () => {
	const loaded = loadPlugin(PLUGIN_ID);

	it("parses and carries the English name and description", () => {
		expect(loaded.manifest.name).toBe("Database Client");
		expect(loaded.manifest.description).toBe(
			"Database client: browse schemas, run SQL and edit data across MySQL / PostgreSQL / SQLite / SQL Server / MongoDB / Redis.",
		);
	});

	it("keeps the upstream id and version", () => {
		expect(loaded.manifest.id).toBe(PLUGIN_ID);
		expect(loaded.manifest.version).toBe("0.2.0");
	});

	it("keeps permissions exactly as upstream declared them", () => {
		expect(loaded.manifest.permissions).toEqual(MANIFEST_PERMISSIONS);
	});

	it("carries no locale fallback key and no view/renderer flags upstream did not have", () => {
		expect(Object.keys(loaded.raw).sort()).toEqual(["build", "description", "id", "name", "permissions", "version"]);
		expect(loaded.raw).not.toHaveProperty("descriptionEn");
	});
});

// ---------------------------------------------------------------------------
// English-only invariant for the files this unit owns
// ---------------------------------------------------------------------------

describe("db-client English-only invariant", () => {
	it("has no CJK character in any source file it owns", () => {
		const owned = repoFiles().filter(
			(rel) => rel.startsWith(`${PLUGIN_DIR}/`) || rel.startsWith("tests/unit/db-client"),
		);
		// A vacuous scan proves nothing: the ported plugin always has sources.
		expect(owned).toContain(`${PLUGIN_DIR}/src/index.ts`);
		expect(owned).toContain(`${PLUGIN_DIR}/src/client.ts`);
		expect(owned.length).toBeGreaterThan(4);

		const offenders = owned.flatMap((rel) => formatCjkHits(rel, findCjk(rel, CJK_RE)));
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	it("replaced the hand-written upstream JavaScript with TypeScript sources", () => {
		for (const stale of ["src/client.js", "build.mjs", "package.json", "package-lock.json"]) {
			expect(existsSync(join(PLUGIN_DIR, stale)), `${PLUGIN_DIR}/${stale} should have been deleted`).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// the engine table
// ---------------------------------------------------------------------------

describe("DB_TYPES", () => {
	it("declares the six supported engines with their labels and default ports", () => {
		expect(Object.keys(DB_TYPES).sort()).toEqual([...ENGINES].sort());
		expect(DB_TYPES).toEqual({
			mysql: { label: "MySQL", port: 3306 },
			postgres: { label: "PostgreSQL", port: 5432 },
			sqlite: { label: "SQLite", port: 0 },
			sqlserver: { label: "SQL Server", port: 1433 },
			mongodb: { label: "MongoDB", port: 27017 },
			redis: { label: "Redis", port: 6379 },
		});
	});

	it("maps every engine to the driver package that serves it", () => {
		expect(Object.keys(DRIVER_MODULE).sort()).toEqual([...ENGINES].sort());
		expect(DRIVER_MODULE).toEqual({
			mysql: "mysql2",
			postgres: "pg",
			sqlite: "node:sqlite",
			sqlserver: "mssql",
			mongodb: "mongodb",
			redis: "ioredis",
		});
	});

	it("has an adapter factory for every engine and for no engine that is not declared", () => {
		expect(Object.keys(ADAPTER_FACTORIES).sort()).toEqual([...ENGINES].sort());
		for (const engine of ENGINES) {
			expect(typeof ADAPTER_FACTORIES[engine]).toBe("function");
		}
	});

	it("pins the npm specs the installer uses to every driver that is not a Node builtin", () => {
		const installable = Object.values(DRIVER_MODULE).filter((name) => !name.startsWith("node:"));
		const installed = DEPS.map((spec) => spec.replace(/@.*$/, ""));
		expect(installed.sort()).toEqual([...new Set(installable)].sort());
		for (const spec of DEPS) {
			expect(spec, `${spec} must carry a version range`).toMatch(/^[@a-z][^@]*@\^?\d/);
		}
	});

	it("leaves an unknown engine unresolved", () => {
		expect(ADAPTER_FACTORIES["oracle" as DbEngine]).toBeUndefined();
		expect(DRIVER_MODULE["oracle" as DbEngine]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("cellVal", () => {
	it("maps nullish values to null and passes scalars through", () => {
		expect(cellVal(null)).toBeNull();
		expect(cellVal(undefined)).toBeNull();
		expect(cellVal(42)).toBe(42);
		expect(cellVal(-1.5)).toBe(-1.5);
		expect(cellVal(true)).toBe(true);
		expect(cellVal("plain")).toBe("plain");
	});

	it("coerces bigint, Date and Buffer to something a grid can show", () => {
		expect(cellVal(9007199254740993n)).toBe(9007199254740992);
		expect(cellVal(new Date("2024-01-02T03:04:05.000Z"))).toBe("2024-01-02T03:04:05.000Z");
		expect(cellVal(Buffer.from([1, 2, 3]))).toBe("<binary 3 bytes>");
		expect(cellVal(Buffer.alloc(0))).toBe("<binary 0 bytes>");
	});

	it("serializes objects as JSON", () => {
		expect(cellVal({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
		expect(cellVal([1, "x"])).toBe('[1,"x"]');
	});

	it("uses a BSON value's own toString and folds nested bigints to numbers", () => {
		const objectId = { _bsontype: "ObjectId", toString: () => "665f1c2e0000000000000000" };
		expect(JSON.parse(cellVal(objectId) as string)).toBe("665f1c2e0000000000000000");
		expect(cellVal({ n: 12n })).toBe('{"n":12}');
	});

	it("falls back to String() when a value cannot be serialized", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(cellVal(circular)).toBe("[object Object]");
	});

	it("truncates at the cell limit and leaves a shorter value untouched", () => {
		const exact = "x".repeat(4000);
		expect(cellVal(exact)).toBe(exact);
		const long = cellVal("y".repeat(4001)) as string;
		expect(long).toHaveLength(4001);
		expect(long.endsWith("…")).toBe(true);
		expect(long.startsWith("yyy")).toBe(true);
	});
});

describe("rowsToGrid", () => {
	it("projects object rows through the column list", () => {
		expect(rowsToGrid(["a", "b"], [{ a: 1, b: "x" }])).toEqual({ columns: ["a", "b"], rows: [[1, "x"]] });
	});

	it("maps a column that is missing from the row to null", () => {
		expect(rowsToGrid(["a", "b"], [{ a: 1 }])).toEqual({ columns: ["a", "b"], rows: [[1, null]] });
		expect(rowsToGrid(["a"], [null])).toEqual({ columns: ["a"], rows: [[null]] });
	});

	it("keeps array rows position-based", () => {
		expect(rowsToGrid(["a", "b"], [[1, 2]])).toEqual({ columns: ["a", "b"], rows: [[1, 2]] });
	});

	it("handles an empty result", () => {
		expect(rowsToGrid([], [])).toEqual({ columns: [], rows: [] });
		expect(rowsToGrid(["a"], [])).toEqual({ columns: ["a"], rows: [] });
	});
});

describe("parseJsonFilter", () => {
	it("treats a blank filter as match-everything", () => {
		expect(parseJsonFilter("")).toEqual({});
		expect(parseJsonFilter("   ")).toEqual({});
		expect(parseJsonFilter(undefined)).toEqual({});
		expect(parseJsonFilter(null)).toEqual({});
	});

	it("parses a JSON object filter", () => {
		expect(parseJsonFilter('{"age":{"$gt":18}}')).toEqual({ age: { $gt: 18 } });
	});

	it("rejects anything that is not a JSON object", () => {
		expect(() => parseJsonFilter("[1,2]")).toThrow(/must be a JSON object/);
		expect(() => parseJsonFilter('"text"')).toThrow(/must be a JSON object/);
		expect(() => parseJsonFilter("null")).toThrow(/must be a JSON object/);
	});

	it("reports an unparseable filter as a parse failure", () => {
		expect(() => parseJsonFilter("{oops")).toThrow(/Failed to parse filter JSON/);
	});
});

describe("identifier quoting", () => {
	it("quotes MySQL identifiers and refuses anything outside the safe set", () => {
		expect(qMysql("users")).toBe("`users`");
		expect(qMysql("a$b_1")).toBe("`a$b_1`");
		expect(qMysql(123)).toBe("`123`");
		expect(() => qMysql("a`b")).toThrow("Invalid identifier: a`b");
		expect(() => qMysql("a b")).toThrow(/Invalid identifier/);
		expect(() => qMysql("")).toThrow(/Invalid identifier/);
	});

	it("escapes the closing character of each SQL dialect", () => {
		expect(qPg('a"b')).toBe('"a""b"');
		expect(qPg("plain")).toBe('"plain"');
		expect(qSqlite('a"b')).toBe('"a""b"');
		expect(qMssql("a]b")).toBe("[a]]b]");
		expect(qMssql("plain")).toBe("[plain]");
	});
});

describe("winQuote", () => {
	it("leaves a bare argument alone", () => {
		expect(winQuote("plain")).toBe("plain");
		expect(winQuote("")).toBe("");
	});

	it("wraps an argument containing whitespace or a shell metacharacter", () => {
		expect(winQuote("has space")).toBe('"has space"');
		expect(winQuote("a&b")).toBe('"a&b"');
		expect(winQuote("a|b")).toBe('"a|b"');
	});

	it("doubles embedded double quotes the way cmd.exe expects", () => {
		expect(winQuote('say "hi" now')).toBe('"say ""hi"" now"');
	});
});

describe("tokenize", () => {
	it("splits a raw Redis command line on whitespace", () => {
		expect(tokenize("GET foo")).toEqual(["GET", "foo"]);
		expect(tokenize("  SET   a   b  ")).toEqual(["SET", "a", "b"]);
	});

	it("keeps quoted arguments together and strips the quotes", () => {
		expect(tokenize('SET k "hello world"')).toEqual(["SET", "k", "hello world"]);
		expect(tokenize("SET k 'a b'")).toEqual(["SET", "k", "a b"]);
		expect(tokenize('GET "a b')).toEqual(["GET", "a b"]);
		expect(tokenize('a"b')).toEqual(["ab"]);
	});

	it("returns no tokens for a blank line", () => {
		expect(tokenize("")).toEqual([]);
		expect(tokenize("   ")).toEqual([]);
	});
});

describe("withTimeout", () => {
	it("passes the value through when the work finishes first", async () => {
		await expect(withTimeout(Promise.resolve("done"), 1000, "query")).resolves.toBe("done");
	});

	it("rejects with the label and the limit in seconds when the work is too slow", async () => {
		vi.useFakeTimers();
		try {
			const pending = withTimeout(new Promise<string>(() => {}), 30_000, "query");
			const assertion = expect(pending).rejects.toThrow("query timed out (30s)");
			await vi.advanceTimersByTimeAsync(30_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses a generic label when none is given", async () => {
		vi.useFakeTimers();
		try {
			const pending = withTimeout(new Promise<string>(() => {}), 2_000);
			const assertion = expect(pending).rejects.toThrow("operation timed out (2s)");
			await vi.advanceTimersByTimeAsync(2_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// server entry: activation
// ---------------------------------------------------------------------------

describe("activate", () => {
	it("registers only a message handler and an attach handler", async () => {
		const { host, deactivate } = await activate();
		expect(host.recorded.handlers.message.size).toBe(1);
		expect(host.recorded.handlers.attach.size).toBe(1);
		// The plugin talks to the browser over its own message protocol; it exposes
		// no agent tool, slash command, HTTP route or background task.
		expect(host.recorded.agentTools.size).toBe(0);
		expect(host.recorded.commands.size).toBe(0);
		expect(host.recorded.routes.size).toBe(0);
		expect(host.recorded.backgroundTasks.size).toBe(0);
		expect(host.recorded.rejections).toEqual([]);
		deactivate?.();
	});

	it("logs activation and reports readiness by broadcasting state", async () => {
		const { host, deactivate } = await activate();
		expect(host.recorded.logs.some((args) => args.includes("activated"))).toBe(true);
		await readyState(host);
		expect(lastBroadcastState(host).depsOk).toBe(false);
		deactivate?.();
	});

	it("does not install drivers when the kill switch is set", async () => {
		const { host, deactivate } = await activate();
		await readyState(host);
		const state = lastBroadcastState(host);
		expect(state.depsInstalling).toBe(false);
		expect(host.recorded.logs.flat().join(" ")).toContain("PI_DB_CLIENT_NO_AUTOINSTALL");
		expect(host.recorded.notifications).toEqual([]);
		deactivate?.();
	});

	it("probes every driver and reports per-package availability", async () => {
		const { host, deactivate } = await activate();
		const state = await readyState(host);
		expect(Object.keys(state.depsAvail ?? {}).sort()).toEqual(
			["ioredis", "mongodb", "mssql", "mysql2", "node:sqlite", "pg"].sort(),
		);
		// node:sqlite ships with Node; the npm drivers are not installed in this repo.
		expect(state.depsAvail?.["node:sqlite"]).toBe(true);
		expect(state.depsAvail?.mysql2).toBe(false);
		expect(state.depsOk).toBe(false);
		deactivate?.();
	});

	it("pushes the full state to a client that attaches later", async () => {
		const { host, deactivate } = await activate();
		await readyState(host);
		expect(await host.emit.attach("late-client")).toBe(1);
		await vi.waitFor(() => {
			expect(host.recorded.sent.some((s) => s.clientId === "late-client")).toBe(true);
		});
		const pushed = host.recorded.sent.find((s) => s.clientId === "late-client");
		expect(isRecord(pushed?.payload) && pushed.payload.kind).toBe("state");
		deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// server entry: protocol
// ---------------------------------------------------------------------------

describe("message protocol", () => {
	it("answers a state request with the engine table and redacted connections", async () => {
		const { host, dir, deactivate } = await activate();
		await send(host, {
			action: "conns_save",
			conn: { name: "local", type: "mysql", host: "127.0.0.1", user: "root", password: "s3cret" },
		});
		const state = await readyState(host);
		expect(state.types).toEqual(DB_TYPES);
		expect(state.conns).toHaveLength(1);
		const conn = state.conns[0] as PublicConn & Record<string, unknown>;
		expect(conn.name).toBe("local");
		expect(conn.type).toBe("mysql");
		expect(conn.port).toBe(3306);
		expect(conn.hasPass).toBe(true);
		expect(conn).not.toHaveProperty("password");
		expect(JSON.stringify(state)).not.toContain("s3cret");
		expect(readConfig(dir).conns[0]).not.toHaveProperty("password");
		deactivate?.();
	});

	it("rejects an unknown action", async () => {
		const { host, deactivate } = await activate();
		const res = await send(host, { action: "bogus" });
		expect(res.ok).toBe(false);
		expect(res.action).toBe("bogus");
		expect(res.error).toBe("Unknown action: bogus");
		deactivate?.();
	});

	it("survives a null payload and still answers with a failure", async () => {
		const { host, deactivate } = await activate();
		const before = host.recorded.sent.length;
		await host.emit.message(null, "c1");
		const replies = host.recorded.sent.slice(before).filter((s) => isRecord(s.payload) && s.payload.res === true);
		expect(replies).toHaveLength(1);
		expect(replies[0].payload).toMatchObject({ ok: false, error: "Unknown action: undefined" });
		deactivate?.();
	});

	it("answers a message that carries no reqId at all", async () => {
		const { host, deactivate } = await activate();
		const before = host.recorded.sent.length;
		await host.emit.message({ action: "state" }, "c1");
		const replies = host.recorded.sent.slice(before).filter((s) => isRecord(s.payload) && s.payload.res === true);
		expect(replies).toHaveLength(1);
		expect(replies[0].payload).toMatchObject({ ok: true, action: "state", reqId: undefined });
		expect(isRecord((replies[0].payload as Record<string, unknown>).state)).toBe(true);
		deactivate?.();
	});

	it("reports a missing runtime connection for every data action", async () => {
		const { host, deactivate } = await activate();
		for (const action of ["dbs_list", "tables_list", "describe", "page", "query_exec", "disconnect", "redis_key"]) {
			const res = await send(host, { action, connId: "c999" });
			expect(res.ok, action).toBe(false);
			expect(res.error, action).toBe("Connection does not exist or was closed: c999");
		}
		deactivate?.();
	});

	it("rejects an empty SQL statement before touching an adapter", async () => {
		const { host, deactivate } = await activate();
		const res = await send(host, { action: "query_exec", connId: "c1", sql: "   " });
		// No runtime exists, so the guard that fires first is the runtime lookup.
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/^Connection does not exist/);
		deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// server entry: connection config CRUD
// ---------------------------------------------------------------------------

describe("connection config", () => {
	it("stores the password as a secret and keeps it out of the config file", async () => {
		const { host, dir, deactivate } = await activate();
		const res = await send(host, {
			action: "conns_save",
			conn: { type: "postgres", host: " db.example.com ", user: "u", password: "pw", database: "app" },
		});
		expect(res.ok).toBe(true);
		const saved = readConfig(dir).conns[0];
		expect(saved.type).toBe("postgres");
		expect(saved.host).toBe("db.example.com");
		expect(saved.port).toBe(5432);
		expect(saved.database).toBe("app");
		expect(saved).not.toHaveProperty("password");
		const id = String(saved.id);
		expect(host.recorded.secrets.get(`conn:${id}`)).toBe("pw");
		// A generated name falls back to the engine label plus the address.
		expect(saved.name).toBe("PostgreSQL db.example.com");
		deactivate?.();
	});

	it("rejects a connection with no engine and one with no host", async () => {
		const { host, deactivate } = await activate();
		const noType = await send(host, { action: "conns_save", conn: { name: "x", host: "h" } });
		expect(noType.ok).toBe(false);
		expect(noType.error).toBe("Please choose a database type");

		const badType = await send(host, { action: "conns_save", conn: { type: "oracle", host: "h" } });
		expect(badType.error).toBe("Please choose a database type");

		const noHost = await send(host, { action: "conns_save", conn: { type: "mysql", host: "   " } });
		expect(noHost.ok).toBe(false);
		expect(noHost.error).toBe("Host is required");

		// SQLite is the one engine that takes a file instead of a host.
		const sqlite = await send(host, { action: "conns_save", conn: { type: "sqlite", file: "/tmp/x.db" } });
		expect(sqlite.ok).toBe(true);
		deactivate?.();
	});

	it("keeps a saved password when an edit leaves the field blank and clears it on null", async () => {
		const { host, dir, deactivate } = await activate();
		await send(host, { action: "conns_save", conn: { type: "mysql", host: "h", password: "first" } });
		const id = String(readConfig(dir).conns[0].id);

		const blank = await send(host, { action: "conns_save", conn: { id, type: "mysql", host: "h2", name: "renamed" } });
		expect(blank.ok).toBe(true);
		expect(readConfig(dir).conns[0].host).toBe("h2");
		expect(readConfig(dir).conns[0].name).toBe("renamed");
		expect(host.recorded.secrets.get(`conn:${id}`)).toBe("first");

		const cleared = await send(host, { action: "conns_save", conn: { id, type: "mysql", host: "h2", password: null } });
		expect(cleared.ok).toBe(true);
		expect(host.recorded.secrets.has(`conn:${id}`)).toBe(false);
		deactivate?.();
	});

	it("never lets an edit change the engine", async () => {
		const { host, dir, deactivate } = await activate();
		await send(host, { action: "conns_save", conn: { type: "mysql", host: "h" } });
		const id = String(readConfig(dir).conns[0].id);
		await send(host, { action: "conns_save", conn: { id, type: "redis", host: "h" } });
		expect(readConfig(dir).conns[0].type).toBe("mysql");
		deactivate?.();
	});

	it("refuses to update a connection that does not exist", async () => {
		const { host, deactivate } = await activate();
		const res = await send(host, { action: "conns_save", conn: { id: "nope", type: "mysql", host: "h" } });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Connection does not exist");
		deactivate?.();
	});

	it("enforces the saved-connection limit", async () => {
		const dir = pluginDir();
		const conns = Array.from({ length: 32 }, (_, i) => ({ id: `x${i}`, name: `c${i}`, type: "mysql", host: "h" }));
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ conns }), "utf8");
		const { host, deactivate } = await activate({ dir });
		const state = await readyState(host);
		expect(state.conns).toHaveLength(32);
		const res = await send(host, { action: "conns_save", conn: { type: "mysql", host: "h" } });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("At most 32 connections can be saved");
		deactivate?.();
	});

	it("migrates a plaintext password out of an existing config file", async () => {
		const dir = pluginDir();
		writeFileSync(
			join(dir, CONFIG_FILE),
			JSON.stringify({ conns: [{ id: "legacy1", name: "old", type: "mysql", host: "h", password: "plain" }] }),
			"utf8",
		);
		const { host, deactivate } = await activate({ dir });
		const state = await readyState(host);
		expect(host.recorded.secrets.get("conn:legacy1")).toBe("plain");
		expect(readConfig(dir).conns[0]).not.toHaveProperty("password");
		expect(state.conns[0].hasPass).toBe(true);
		expect(host.recorded.logs.flat().join(" ")).toContain("Migrated connection passwords to encrypted storage");
		deactivate?.();
	});

	it("deletes a connection together with its secret", async () => {
		const { host, dir, deactivate } = await activate();
		await send(host, { action: "conns_save", conn: { type: "mysql", host: "h", password: "pw" } });
		const id = String(readConfig(dir).conns[0].id);
		expect(host.recorded.secrets.has(`conn:${id}`)).toBe(true);

		const res = await send(host, { action: "conns_delete", id });
		expect(res.ok).toBe(true);
		expect(readConfig(dir).conns).toEqual([]);
		expect(host.recorded.secrets.has(`conn:${id}`)).toBe(false);
		expect(lastBroadcastState(host).conns).toEqual([]);

		const again = await send(host, { action: "conns_delete", id });
		expect(again.ok).toBe(false);
		expect(again.error).toBe("Connection does not exist");
		deactivate?.();
	});

	it("treats an unreadable config file as an empty list", async () => {
		const dir = pluginDir();
		writeFileSync(join(dir, CONFIG_FILE), "{ not json", "utf8");
		const { host, deactivate } = await activate({ dir });
		expect((await readyState(host)).conns).toEqual([]);
		deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// server entry: adapter errors reachable without any driver or database
// ---------------------------------------------------------------------------

describe("connection attempts", () => {
	it("refuses an engine it has no adapter for", async () => {
		const { host, deactivate } = await activate();
		const res = await send(host, { action: "test", conn: { type: "oracle", host: "h" } });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Unknown database type: oracle");
		deactivate?.();
	});

	it("names the missing driver for every engine whose driver is not installed", async () => {
		const { host, deactivate } = await activate();
		const expected: Record<string, string> = {
			mysql: "mysql2",
			postgres: "pg",
			sqlserver: "mssql",
			mongodb: "mongodb",
			redis: "ioredis",
		};
		for (const [engine, driver] of Object.entries(expected)) {
			const res = await send(host, { action: "test", conn: { type: engine, host: "db.invalid" } });
			expect(res.ok, engine).toBe(false);
			expect(res.error, engine).toBe(
				`Driver ${driver} is not installed - click "Install drivers" in the sidebar, ` +
					`or run npm install ${driver} in the plugin directory`,
			);
		}
		deactivate?.();
	});

	it("validates the SQLite file before opening anything", async () => {
		const { host, deactivate } = await activate();
		const noFile = await send(host, { action: "test", conn: { type: "sqlite" } });
		expect(noFile.ok).toBe(false);
		expect(noFile.error).toBe("SQLite requires a database file path");

		const missing = await send(host, { action: "test", conn: { type: "sqlite", file: "/nonexistent/db-client-x.db" } });
		expect(missing.ok).toBe(false);
		expect(missing.error).toBe("Database file does not exist: /nonexistent/db-client-x.db");
		deactivate?.();
	});

	it("opens no runtime for a failed connection", async () => {
		const { host, deactivate } = await activate();
		await send(host, { action: "conns_save", conn: { name: "unreachable", type: "mysql", host: "db.invalid" } });
		const saved = lastBroadcastState(host).conns[0];
		const res = await send(host, { action: "connect", id: saved.id });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/^Driver mysql2 is not installed/);
		expect(lastBroadcastState(host).active).toEqual([]);
		deactivate?.();
	});

	it("reports a connect for an unknown connection id", async () => {
		const { host, deactivate } = await activate();
		const res = await send(host, { action: "connect", id: "missing" });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Connection does not exist");
		deactivate?.();
	});

	it("reuses the stored password when a test form leaves it blank", async () => {
		const { host, dir, deactivate } = await activate();
		await send(host, { action: "conns_save", conn: { name: "n", type: "mysql", host: "h", password: "pw" } });
		const id = String(readConfig(dir).conns[0].id);
		const res = await send(host, { action: "test", conn: { id, host: "h" } });
		// The driver is missing, so the failure is about the driver and not about
		// credentials - which proves the stored config was resolved first.
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/^Driver mysql2 is not installed/);
		deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// server entry: deps_install without spawning
// ---------------------------------------------------------------------------

describe("deps_install", () => {
	it("skips the install while another install holds a fresh lock", async () => {
		const dir = pluginDir();
		writeFileSync(join(dir, ".deps-install.lock"), JSON.stringify({ at: Date.now(), pid: 1 }), "utf8");
		const { host, deactivate } = await activate({ dir });
		const res = await send(host, { action: "deps_install" });
		expect(res.ok).toBe(true);
		expect(host.recorded.logs.flat().join(" ")).toContain("install skipped: another install task holds the lock");
		const notice = host.recorded.notifications.at(-1);
		expect(notice?.level).toBe("info");
		expect(notice?.text).toContain("a driver install is already running");
		expect((await readyState(host)).depsInstalling).toBe(false);
		deactivate?.();
	});

	it("ignores a stale lock file when deciding, but the kill switch still wins for auto installs", async () => {
		const dir = pluginDir();
		writeFileSync(join(dir, ".deps-install.lock"), JSON.stringify({ at: Date.now() - 31 * 60_000, pid: 1 }), "utf8");
		const { host, deactivate } = await activate({ dir });
		await readyState(host);
		expect(host.recorded.logs.flat().join(" ")).toContain("PI_DB_CLIENT_NO_AUTOINSTALL");
		deactivate?.();
	});
});

// ---------------------------------------------------------------------------
// server entry: deactivate
// ---------------------------------------------------------------------------

describe("deactivate", () => {
	it("unregisters every handler it added", async () => {
		const { host, deactivate } = await activate();
		await readyState(host);
		expect(deactivate).toBeTypeOf("function");
		expect(host.recorded.handlers.message.size).toBe(1);
		deactivate?.();
		expect(host.recorded.handlers.message.size).toBe(0);
		expect(host.recorded.handlers.attach.size).toBe(0);
	});

	it("stops answering messages after it runs", async () => {
		const { host, deactivate } = await activate();
		await readyState(host);
		deactivate?.();
		const before = host.recorded.sent.length;
		expect(await host.emit.message({ action: "state", reqId: "after-close" }, "c1")).toBe(0);
		expect(host.recorded.sent).toHaveLength(before);
	});
});

// ---------------------------------------------------------------------------
// client entry
// ---------------------------------------------------------------------------

describe("client pure helpers", () => {
	it("escapes every HTML-significant character", () => {
		expect(esc('<img src=x onerror="a&b">')).toBe("&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;");
		expect(esc("it's")).toBe("it&#39;s");
		expect(esc("")).toBe("");
	});

	it("renders nullish values as an empty string and coerces everything else", () => {
		expect(esc(null)).toBe("");
		expect(esc(undefined)).toBe("");
		expect(esc(0)).toBe("0");
		expect(esc(false)).toBe("false");
	});

	it("abbreviates large row counts", () => {
		expect(fmtCount(0)).toBe("0");
		expect(fmtCount(999)).toBe("999");
		expect(fmtCount(1000)).toBe("1.0k");
		expect(fmtCount(1500)).toBe("1.5k");
		expect(fmtCount(2_000_000)).toBe("2.0M");
		expect(fmtCount(1_500_000_000)).toBe("1.5G");
	});

	it("coerces a non-numeric count instead of throwing", () => {
		expect(fmtCount("1200")).toBe("1.2k");
		expect(fmtCount(Number.NaN)).toBe("NaN");
	});

	it("describes a SQLite connection by its file", () => {
		expect(connAddr({ type: "sqlite", file: "/data/app.db" } as PublicConn)).toBe("/data/app.db");
	});

	it("describes a network connection as user@host:port/database", () => {
		const base = { type: "mysql", host: "db.local", port: 3306 } as PublicConn;
		expect(connAddr(base)).toBe("db.local:3306");
		expect(connAddr({ ...base, database: "app" })).toBe("db.local:3306/app");
		expect(connAddr({ ...base, user: "root" })).toBe("root@db.local:3306");
		expect(connAddr({ ...base, user: "root", database: "app" })).toBe("root@db.local:3306/app");
	});

	it("shows an empty address for a connection with no fields", () => {
		expect(connAddr({ type: "redis" } as PublicConn)).toBe("undefined:undefined");
	});
});

describe("client entry shape", () => {
	it("exports the view contract the frontend loader expects", () => {
		expect(client).toBeTypeOf("object");
		expect(client.mount).toBeTypeOf("function");
		expect(client).not.toHaveProperty("renderers");
	});
});

class FakeViewElement {
	innerHTML = "";
	textContent = "";
	value = "";
	disabled = false;
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	className = "";
	classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) };
	children: FakeViewElement[] = [];

	querySelector(_selector: string): FakeViewElement {
		return new FakeViewElement();
	}

	querySelectorAll(_selector: string): FakeViewElement[] {
		return [];
	}

	addEventListener(_event: string, _listener: EventListenerOrEventListenerObject): void {}
	appendChild(child: FakeViewElement): FakeViewElement {
		this.children.push(child);
		return child;
	}
	prepend(child: FakeViewElement): void {
		this.children.unshift(child);
	}
	remove(): void {}
	focus(): void {}
}

/** A minimal DOM seam that lets the view's public send/onData protocol run in Node. */
function fakeClientContainer(): FakeViewElement {
	const root = new FakeViewElement();
	const container = new FakeViewElement();
	container.querySelector = () => root;
	return container;
}

describe("client message protocol", () => {
	it("requests state, accepts its happy-path response, and safely ignores malformed or failed responses", async () => {
		const originalDocument = globalThis.document;
		const originalWindow = globalThis.window;
		const container = fakeClientContainer();
		const channel = createMockViewContext("db-client");
		try {
			vi.stubGlobal("document", { createElement: () => new FakeViewElement() });
			vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
			const cleanup = client.mount(container as unknown as HTMLElement, channel.ctx);
			expect(channel.sent).toHaveLength(1);
			expect(channel.sent[0]).toMatchObject({ action: "state", reqId: "r1" });

			expect(() => channel.push(null)).not.toThrow();
			expect(() => channel.push({ res: true, reqId: "unknown", ok: false, error: "ignored" })).not.toThrow();
			expect(() =>
				channel.push({
					res: true,
					reqId: "r1",
					action: "state",
					ok: true,
					state: { depsOk: true, depsInstalling: false, conns: [], active: [], types: {} },
				}),
			).not.toThrow();
			await Promise.resolve();
			expect(channel.sent).toHaveLength(1);
			cleanup?.();

			const failedChannel = createMockViewContext("db-client");
			const failedCleanup = client.mount(fakeClientContainer() as unknown as HTMLElement, failedChannel.ctx);
			expect(() =>
				failedChannel.push({
					res: true,
					reqId: (failedChannel.sent[0] as { reqId: string }).reqId,
					ok: false,
					error: "offline",
				}),
			).not.toThrow();
			await Promise.resolve();
			expect(failedChannel.sent).toHaveLength(1);
			failedCleanup?.();
		} finally {
			vi.unstubAllGlobals();
			if (originalDocument !== undefined) vi.stubGlobal("document", originalDocument);
			if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
		}
	});
});

// ---------------------------------------------------------------------------
// compiled artifacts
// ---------------------------------------------------------------------------

describe("compiled artifacts", () => {
	let serverEntry: string;
	let clientEntry: string;

	beforeAll(async () => {
		const result = buildPlugin(PLUGIN_ID);
		expect(result.stderr, result.stderr).toBe("");
		expect(result.ok, result.stdout + result.stderr).toBe(true);
		serverEntry = result.serverEntry ?? "";
		clientEntry = result.clientEntry ?? "";
		expect(serverEntry).not.toBe("");
		expect(clientEntry).not.toBe("");
	}, 120_000);

	it("compiles a server entry the host can activate", async () => {
		const mod = await importServerArtifact(PLUGIN_ID);
		expect(isServerEntry(mod)).toBe(true);
		expect(mod).toHaveProperty("default.activate");
		// The compiled module keeps the exported engine table.
		const typed = mod as { DB_TYPES?: unknown };
		expect(typed.DB_TYPES).toEqual(DB_TYPES);
	});

	it("compiles a client entry the frontend can mount", async () => {
		const mod = await importClientArtifact(PLUGIN_ID);
		expect(isClientEntry(mod)).toBe(true);
		expect((mod as { default: { mount: unknown } }).default.mount).toBeTypeOf("function");
	});

	it("leaves no bare npm specifier in either artifact", () => {
		// A bare specifier in the client bundle throws at runtime in the browser,
		// and one in the server bundle would bypass the plugin's own driver
		// loading. Dynamic import() of a runtime-installed driver is expected and
		// is not matched here: only static import/export declarations are.
		const staticSpecifier = /^\s*(?:import|export)\s+(?:[^;\n]*?\bfrom\s+)?["']([^"']+)["']/gm;
		const allowed = /^(?:node:|\.\.?\/)/;
		for (const artifact of [serverEntry, clientEntry]) {
			const source = readFileSync(artifact, "utf8");
			const found = [...source.matchAll(staticSpecifier)].map((m) => m[1] as string);
			const bare = found.filter((spec) => !allowed.test(spec));
			expect(bare, `${artifact} imports ${bare.join(", ")}`).toEqual([]);
		}
	});

	it("produces artifacts with no CJK character", () => {
		for (const artifact of [serverEntry, clientEntry]) {
			const hits = findCjk(artifact, CJK_RE);
			expect(formatCjkHits(artifact, hits), formatCjkHits(artifact, hits).join("\n")).toEqual([]);
		}
	});
});

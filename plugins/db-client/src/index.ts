/**
 * db-client plugin, server side - database connection management and browsing
 * (modelled on the core experience of vscode-database-client).
 *
 * Driver packages are not bundled with the plugin: the first activation installs
 * mysql2 / pg / mssql / mongodb / ioredis into the plugin directory with a single
 * npm run (the same pattern the ssh and webmail plugins use). SQLite needs no
 * driver at all - it uses the node:sqlite builtin.
 *
 * Responsibilities:
 * - Connection config CRUD, persisted to conn.dir/db-connections.json. Passwords
 *   move into host.secrets when the host provides one; the state the browser sees
 *   is redacted down to a hasPass flag.
 * - A runtime pool keyed by connId, with events pushed only to the socket that
 *   created the connection.
 * - One adapter interface, split by engine:
 *     listDatabases() / listTables(db) / describeTable(db, table)
 *     selectPage(db, table, {offset, limit, orderBy, dir, filter}) / query(db, sql)
 *   The SQL engines (mysql/postgres/sqlserver/sqlite) go through SQL, mongodb uses
 *   find() with a JSON filter, and redis has its own set of actions (scan / key /
 *   delete / raw command).
 *
 * Protocol. Upstream (browser -> plugin): { action, reqId?, ... }.
 * Downstream there are three shapes:
 *   response  { res: true, reqId, ok, ... }      matched by reqId
 *   event     { event: "conn_closed", ... }      sent to the connection's owner
 *   broadcast { kind: "state", state }           connection list, live
 *                                                connections, dependency status
 */

import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile as rf, writeFile as wf } from "node:fs/promises";

const CONFIG_FILE = "db-connections.json";

/** npm specs installed on demand. node:sqlite is a builtin and is not listed. */
export const DEPS = ["mysql2@^3", "pg@^8", "mssql@^12", "mongodb@^7", "ioredis@^6"];

const MAX_CONNS = 32; // saved connection configs
const MAX_RUNTIME = 8; // connections open at the same time
const OP_TIMEOUT_MS = 30_000; // one query
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PAGE_ROWS = 500;
const MAX_QUERY_ROWS = 1000;
const MAX_CELL_LEN = 4000; // serialized cell truncation
const INSTALL_LOCK = ".deps-install.lock"; // install mutex across activations (see installDeps)
const INSTALL_TIMEOUT_MS = 20 * 60_000; // watchdog: a first mssql install takes minutes, so allow 20
const INSTALL_LOCK_STALE_MS = 30 * 60_000; // a lock left by a crash only blocks for 30 minutes

/** The engines this plugin can talk to. Declared as a union so a typo in any of
 *  the three tables below is a compile error rather than a runtime miss. */
export type DbEngine = "mysql" | "postgres" | "sqlite" | "sqlserver" | "mongodb" | "redis";

export interface DbTypeMeta {
	/** Engine name as shown in the UI and used to build a default connection name. */
	label: string;
	/** Default TCP port; 0 means "no port" (SQLite is a file). */
	port: number;
}

export const DB_TYPES: Record<DbEngine, DbTypeMeta> = {
	mysql: { label: "MySQL", port: 3306 },
	postgres: { label: "PostgreSQL", port: 5432 },
	sqlite: { label: "SQLite", port: 0 },
	sqlserver: { label: "SQL Server", port: 1433 },
	mongodb: { label: "MongoDB", port: 27017 },
	redis: { label: "Redis", port: 6379 },
};

/** The module each engine loads at runtime. These are package names, not prose. */
export const DRIVER_MODULE: Record<DbEngine, string> = {
	mysql: "mysql2",
	postgres: "pg",
	sqlite: "node:sqlite",
	sqlserver: "mssql",
	mongodb: "mongodb",
	redis: "ioredis",
};

/** True for one of the six declared engines. The config file is user-editable, so
 *  every engine id coming off the wire is checked with this before it indexes the
 *  tables above. */
export function isDbEngine(value: unknown): value is DbEngine {
	return typeof value === "string" && Object.hasOwn(DB_TYPES, value);
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** A value the data grid can render. */
export type CellValue = string | number | boolean | null;

/** A connection as shown to the browser: no password, no URI, just flags. */
export interface PublicConn {
	id?: string;
	name?: string;
	type?: string;
	host?: string;
	port?: number;
	user?: string;
	database?: string;
	file?: string;
	hasPass?: boolean;
	hasUri?: boolean;
	redisDb?: number;
}

/** The state broadcast to every client. */
export interface PublicState {
	depsOk: boolean;
	depsInstalling: boolean;
	depsAvail: Record<string, boolean> | null;
	types: Record<DbEngine, DbTypeMeta>;
	conns: PublicConn[];
	active: { connId: string; hostId?: string; label: string }[];
}

export interface Grid {
	total: number;
	columns: string[];
	rows: CellValue[][];
	/** MongoDB only: the documents behind `rows`, kept so an edit can be written back. */
	docs?: Record<string, unknown>[] | null;
	editable?: boolean;
	pkCol?: string | null;
}

export interface QueryResult extends Grid {
	affected: number;
	elapsedMs: number;
}

export interface TableColumn {
	name: string;
	type: string;
	nullable: boolean;
	/** Key marker as the engine reports it, e.g. "PRI"; empty when the column is unkeyed. */
	key: string;
	def: string | null;
	comment: string;
}

export interface TableIndex {
	name: string;
	unique: boolean;
	/** Column list, or the full index definition where the engine only exposes that. */
	columns: string;
}

export interface TableInfo {
	columns: TableColumn[];
	indexes: TableIndex[];
	ddl: string;
}

export interface TableEntry {
	name: string;
	/** "table", "view" or "collection". */
	kind: string;
	approxRows: number;
}

export interface PageOptions {
	offset?: unknown;
	limit?: unknown;
	orderBy?: string;
	dir?: string;
	/** MongoDB only: a JSON filter document. */
	filter?: unknown;
}

export interface WriteResult {
	affected: number;
	id?: unknown;
}

export interface RedisKeyEntry {
	key: string;
	type: string;
}

export interface RedisScanResult {
	cursor: string;
	keys: RedisKeyEntry[];
}

export interface RedisKeyDetail {
	type: string;
	ttl: number;
	size: number;
	value: string;
	truncated: boolean;
}

export interface RedisMeta {
	dbsize: number;
	usedMemory: string;
}

/** The uniform adapter every engine factory returns. Optional members are the
 *  per-engine extras; the message router reports a clear error when a client asks
 *  for one the connected engine does not have. */
export interface DbAdapter {
	kind: "sql" | "mongodb" | "redis";
	dialect: string;
	listDatabases(): Promise<string[]>;
	listTables(db?: string): Promise<TableEntry[]>;
	describeTable(db: string | undefined, table: string | undefined): Promise<TableInfo>;
	selectPage(db: string | undefined, table: string | undefined, options: PageOptions): Promise<Grid>;
	query(db: string | undefined, sql: string): Promise<QueryResult>;
	close(): Promise<void>;
	updateRow?(
		db: string | undefined,
		table: string | undefined,
		pkCol: string,
		pkVal: unknown,
		changes: Record<string, unknown>,
	): Promise<WriteResult>;
	insertRow?(db: string | undefined, table: string | undefined, values: Record<string, unknown>): Promise<WriteResult>;
	deleteRow?(db: string | undefined, table: string | undefined, pkCol: string, pkVal: unknown): Promise<WriteResult>;
	docSave?(db: string | undefined, table: string | undefined, id: unknown, docJson: unknown): Promise<WriteResult>;
	docInsert?(db: string | undefined, table: string | undefined, docJson: unknown): Promise<WriteResult>;
	docDelete?(db: string | undefined, table: string | undefined, id: unknown): Promise<WriteResult>;
	scanKeys?(pattern: unknown, cursor: unknown, want: unknown): Promise<RedisScanResult>;
	keyDetail?(key: string): Promise<RedisKeyDetail>;
	delKey?(key: string): Promise<number>;
	keySet?(key: string, value: string): Promise<WriteResult>;
	runCmd?(line: string): Promise<unknown>;
	meta?(): Promise<RedisMeta>;
}

export type AdapterFactory = (cfg: StoredConn) => Promise<DbAdapter>;

/** A connection as stored in db-connections.json. The file is user-editable, so
 *  every field stays optional and untrusted until openAdapter() has validated it. */
export interface StoredConn {
	id?: string;
	name?: string;
	type?: string;
	host?: string;
	port?: number;
	user?: string;
	/** In-memory only once the host has a secret store. */
	password?: string;
	database?: string;
	file?: string;
	uri?: string;
	redisDb?: number;
}

/** The `conn` object a conns_save or test message carries. A null (as opposed to
 *  an absent) password or uri means "clear the stored value". */
interface ConnInput {
	id?: string;
	name?: string;
	type?: string;
	host?: string;
	port?: unknown;
	user?: string;
	password?: string | null;
	database?: string;
	file?: string;
	uri?: string | null;
	redisDb?: unknown;
}

/** One inbound browser message. Everything is optional because the payload is raw
 *  JSON from a socket. */
interface DbMessage {
	action?: string;
	reqId?: string;
	conn?: ConnInput;
	id?: string;
	connId?: string;
	db?: string;
	table?: string;
	offset?: unknown;
	limit?: unknown;
	orderBy?: string;
	dir?: string;
	filter?: unknown;
	sql?: unknown;
	pk?: { col?: unknown; val?: unknown };
	changes?: Record<string, unknown>;
	values?: Record<string, unknown>;
	docJson?: unknown;
	key?: unknown;
	value?: unknown;
	pattern?: unknown;
	cursor?: unknown;
	count?: unknown;
	cmd?: unknown;
}

// ---------------------------------------------------------------------------
// The slice of the plugin host this plugin uses
// ---------------------------------------------------------------------------

/** Levels this plugin passes to host.notify. "success" is outside the three the
 *  host documents, but the host forwards the level to the browser verbatim and a
 *  finished driver install has always been reported that way. */
type NotifyLevel = "info" | "warning" | "error" | "success";

interface HostSecrets {
	set(name: string, value: string): void;
	get(name: string): string | undefined;
	delete(name: string): void;
}

interface PluginHost {
	/** The plugin's own directory; holds db-connections.json and node_modules. */
	dir: string;
	broadcast(payload: unknown): void;
	notify(level: NotifyLevel, text: string, textEn?: string): void;
	sendTo(clientId: string, payload: unknown): void;
	onMessage(handler: (payload: unknown, clientId?: string) => void): () => void;
	/** Optional: a host that predates attach notifications still works, the client
	 *  just has to ask for the state itself. */
	onAttach?(handler: (clientId: string) => void): () => void;
	/** Optional: without a secret store, passwords stay in the config file. */
	secrets?: HostSecrets;
	log(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error(`${label ?? "operation"} timed out (${ms / 1000}s)`)), ms),
		),
	]);
}

/** Identifier quoting per dialect (injection guard: every identifier goes through
 *  one of these). */
export function qMysql(value: unknown): string {
	const str = String(value);
	// An identifier (database, table or column name) may only contain safe
	// characters, so no escape sequence can smuggle SQL past the backticks.
	if (!/^[A-Za-z0-9_$]+$/.test(str)) throw new Error(`Invalid identifier: ${str}`);
	return "`" + str + "`";
}
export function qPg(value: unknown): string {
	return '"' + String(value).replace(/"/g, '""') + '"';
}
export function qMssql(value: unknown): string {
	return "[" + String(value).replace(/\]/g, "]]") + "]";
}
export function qSqlite(value: unknown): string {
	return '"' + String(value).replace(/"/g, '""') + '"';
}

/** cmd/sh quoting: wrap only when the argument holds whitespace or a shell
 *  metacharacter, and double the inner quotes (cmd's escape rule). */
export function winQuote(value: unknown): string {
	const t = String(value);
	return /[\s"&'()<>^|]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Serialize any driver value into something the grid can display. */
export function cellVal(value: unknown): CellValue {
	if (value === null || value === undefined) return null;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return Number(value);
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
	if (typeof value === "object") {
		let s: string;
		try {
			s = JSON.stringify(value, (key: string, item: unknown) => {
				// A BSON wrapper (ObjectId, Decimal128, ...) would serialize as an empty
				// object; its own toString() is the useful form.
				const candidate = item as { _bsontype?: unknown; toString?: () => string } | null;
				if (candidate && typeof candidate === "object" && candidate._bsontype) {
					if (typeof candidate.toString === "function" && candidate.toString !== Object.prototype.toString) {
						return candidate.toString();
					}
				}
				if (typeof item === "bigint") return Number(item);
				return item;
			});
		} catch {
			s = String(value);
		}
		if (s.length > MAX_CELL_LEN) s = s.slice(0, MAX_CELL_LEN) + "…";
		return s;
	}
	const s = String(value);
	return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + "…" : s;
}

export function rowsToGrid(columns: string[], rows: unknown[]): { columns: string[]; rows: CellValue[][] } {
	return {
		columns,
		rows: rows.map((row) =>
			Array.isArray(row)
				? (row as unknown[]).map(cellVal)
				: columns.map((column) => cellVal((row as Record<string, unknown> | undefined)?.[column])),
		),
	};
}

export function parseJsonFilter(text: unknown): Record<string, unknown> {
	const t = String(text ?? "").trim();
	if (!t) return {};
	try {
		const obj: unknown = JSON.parse(t);
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Filter must be a JSON object");
		return obj as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Failed to parse filter JSON: ${(err as Error).message}`);
	}
}

/** Quote-aware word splitting for the raw Redis command line. */
export function tokenize(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (const ch of String(line)) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (/\s/.test(ch)) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
		} else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

/**
 * Load a driver module.
 *
 * Drivers are installed into the plugin directory at runtime, so their specifiers
 * can never be resolved while this file is being type-checked; keeping the
 * specifier in a variable (instead of a literal) is what makes that true for the
 * compiler as well. Each call site narrows the result to the one interface it
 * actually uses, which is why this returns T rather than any.
 */
async function loadDriver<T>(specifier: string): Promise<T> {
	return (await import(specifier)) as T;
}

// ---------------------------------------------------------------------------
// Adapter factories - one async factory per engine, each returning the uniform
// interface plus a kind
// ---------------------------------------------------------------------------

/** mysql2 resolves query() to [rows, fields] for a SELECT and to [OkPacket, fields]
 *  for a statement with no result set. Both shapes are read at different call
 *  sites, so the row array also declares the DML counters and Array.isArray()
 *  tells the two apart where it matters. */
interface MysqlRows extends Array<Record<string, unknown>> {
	fields?: { name: string }[];
	affectedRows?: number;
	insertId?: number | string;
}

interface MysqlConnection {
	ping(): Promise<unknown>;
	query(sql: string, params?: unknown[]): Promise<[MysqlRows, unknown]>;
	end(): Promise<unknown>;
}

interface MysqlFactory {
	createConnection(options: Record<string, unknown>): Promise<MysqlConnection>;
}

type MysqlPromiseModule = MysqlFactory & { default?: MysqlFactory };

async function mysqlAdapter(cfg: StoredConn): Promise<DbAdapter> {
	const mod = await loadDriver<MysqlPromiseModule>("mysql2/promise");
	const mysql = mod.default ?? mod;
	const conn = await withTimeout(
		mysql.createConnection({
			host: cfg.host || "127.0.0.1",
			port: Number(cfg.port) || 3306,
			user: cfg.user || "root",
			password: cfg.password || undefined,
			connectTimeout: CONNECT_TIMEOUT_MS,
			dateStrings: true,
		}),
		CONNECT_TIMEOUT_MS + 3000,
		"connect",
	);
	await conn.ping();
	let curDb: string | null = null;
	async function useDb(db: string | undefined): Promise<void> {
		if (db && db !== curDb) {
			await conn.query("USE ??", [db]);
			curDb = db;
		}
	}
	return {
		kind: "sql",
		dialect: "mysql",
		async listDatabases() {
			const [rows] = await conn.query("SHOW DATABASES");
			return rows.map((r) => Object.values(r)[0]).filter((name): name is string => Boolean(name));
		},
		async listTables(db) {
			const [rows] = await conn.query(
				`SELECT table_name AS name, table_type AS kind, IFNULL(table_rows,0) AS approx_rows
				 FROM information_schema.tables WHERE table_schema=? ORDER BY table_name`,
				[db],
			);
			return rows.map((r) => ({
				name: String(r.name),
				kind: r.kind === "VIEW" ? "view" : "table",
				approxRows: Number(r.approx_rows) || 0,
			}));
		},
		async describeTable(db, t) {
			const [cols] = await conn.query(
				`SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
				        column_default AS def, column_key AS ckey, extra, column_comment AS comment
				 FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
				[db, t],
			);
			const [idx] = await conn.query(
				`SELECT index_name AS name, NON_UNIQUE AS non_unique,
				        GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
				 FROM information_schema.statistics WHERE table_schema=? AND table_name=?
				 GROUP BY index_name, NON_UNIQUE`,
				[db, t],
			);
			let ddl = "";
			try {
				const showSql = `SHOW CREATE TABLE ${qMysql(db)}.${qMysql(t)}`;
				const [[row]] = await conn.query(showSql);
				ddl = String(row["Create Table"] ?? row["Create View"] ?? "");
			} catch {
				/* a view and a few other cases have no CREATE statement; ignore */
			}
			return {
				columns: cols.map((c) => ({
					name: String(c.name),
					type: String(c.type),
					nullable: c.nullable === "YES",
					key: String(c.ckey || ""),
					def: c.def == null ? null : String(c.def),
					comment: String(c.comment || ""),
				})),
				indexes: idx.map((i) => ({
					name: String(i.name),
					unique: !Number(i.non_unique),
					columns: String(i.cols ?? ""),
				})),
				ddl,
			};
		},
		async selectPage(db, t, opt) {
			// A MySQL data page does not take a JSON filter (that is MongoDB only).
			// mysql2's ?? identifier placeholder carries the dynamic names, so they
			// are never concatenated into the SQL text.
			const totalRes = await conn.query("SELECT COUNT(*) AS n FROM ??.??", [db, t]);
			const total = Number(totalRes[0][0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ?? ${opt.dir === "desc" ? "DESC" : "ASC"}` : "";
			const pageParams = opt.orderBy ? [db, t, opt.orderBy] : [db, t];
			const [rows] = await conn.query(`SELECT * FROM ??.??${orderSql} LIMIT ? OFFSET ?`, [
				...pageParams,
				Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS),
				Math.max(Number(opt.offset) || 0, 0),
			]);
			const fields = rows.length
				? Object.keys(rows[0])
				: ((await conn.query("SELECT * FROM ??.?? LIMIT 1", [db, t]))[0]?.fields?.map((f) => f.name) ??
					(
						await conn.query(
							`SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
							[db, t],
						)
					)[0].map((r) => String(r.column_name)));
			const [pkRows] = await conn.query(
				`SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_key='PRI' ORDER BY ordinal_position LIMIT 1`,
				[db, t],
			);
			const pkCol = pkRows[0]?.column_name;
			return {
				total,
				...rowsToGrid(fields.length ? fields : ["*"], rows),
				editable: Boolean(pkCol),
				pkCol: pkCol == null ? null : String(pkCol),
			};
		},
		async query(db, sql) {
			await useDb(db);
			const started = Date.now();
			const [result] = await conn.query(sql);
			if (Array.isArray(result)) {
				// A SELECT result set.
				const fields = result.length ? Object.keys(result[0]) : [];
				return {
					total: result.length,
					affected: 0,
					elapsedMs: Date.now() - started,
					...rowsToGrid(fields, result),
				};
			}
			// A statement with no result set: mysql2 puts an OkPacket there instead.
			const ok = result as unknown as { affectedRows?: number };
			return {
				total: 0,
				affected: ok?.affectedRows ?? 0,
				elapsedMs: Date.now() - started,
				columns: [],
				rows: [],
			};
		},
		async updateRow(db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const updateSql = `UPDATE ${qMysql(db)}.${qMysql(t)} SET ${cols.map((c) => `${qMysql(c)}=?`).join(", ")} WHERE ${qMysql(pkCol)}=?`;
			const [r] = await conn.query(updateSql, [...Object.values(changes), pkVal]);
			return { affected: Number(r?.affectedRows ?? 0) };
		},
		async insertRow(db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const [r] = await conn.query(
				`INSERT INTO ${qMysql(db)}.${qMysql(t)} (${cols.map(qMysql).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
				Object.values(values),
			);
			return { affected: 1, id: r?.insertId ?? null };
		},
		async deleteRow(db, t, pkCol, pkVal) {
			const deleteSql = `DELETE FROM ${qMysql(db)}.${qMysql(t)} WHERE ${qMysql(pkCol)}=?`;
			const [r] = await conn.query(deleteSql, [pkVal]);
			return { affected: Number(r?.affectedRows ?? 0) };
		},
		async close() {
			try {
				await conn.end();
			} catch {
				/* ignore */
			}
		},
	};
}

interface PgField {
	name: string;
}

interface PgResult {
	rows: Record<string, unknown>[];
	fields: PgField[];
	rowCount?: number | null;
}

interface PgClient {
	connect(): Promise<unknown>;
	query(sql: string, params?: unknown[]): Promise<PgResult>;
	end(): Promise<unknown>;
}

type PgClientCtor = new (config: Record<string, unknown>) => PgClient;

interface PgModule {
	Client: PgClientCtor;
	default?: { Client: PgClientCtor };
}

async function postgresAdapter(cfg: StoredConn): Promise<DbAdapter> {
	const mod = await loadDriver<PgModule>("pg");
	const Client = mod.default?.Client ?? mod.Client;
	const base = {
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 5432,
		user: cfg.user || "postgres",
		password: cfg.password || undefined,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
	};
	const curName = cfg.database || "postgres";
	const clients = new Map<string, PgClient>();
	async function getCli(name: string | undefined): Promise<PgClient> {
		name = name || curName;
		let c = clients.get(name);
		if (c) return c;
		c = new Client({ ...base, database: name });
		await withTimeout(c.connect(), CONNECT_TIMEOUT_MS + 3000, "connect");
		clients.set(name, c);
		return c;
	}
	const main = await getCli(curName);
	return {
		kind: "sql",
		dialect: "postgres",
		async listDatabases() {
			const r = await main.query(
				"SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn=true ORDER BY datname",
			);
			return r.rows.map((x) => String(x.datname));
		},
		async listTables(db) {
			const c = await getCli(db);
			const r2 = await c.query(
				`SELECT c.relname AS name,
				        CASE WHEN c.relkind IN ('r','p') THEN 'table' ELSE 'view' END AS kind,
				        GREATEST(c.reltuples::bigint, 0)::text AS approx
				 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
				 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
				 ORDER BY c.relname`,
			);
			return r2.rows.map((x) => ({ name: String(x.name), kind: String(x.kind), approxRows: Number(x.approx) || 0 }));
		},
		async describeTable(db, t) {
			const c = await getCli(db);
			const cols = await c.query(
				`SELECT column_name, data_type, is_nullable, column_default, character_maximum_length AS max_len
				 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
				[t],
			);
			const pk = await c.query(
				`SELECT kcu.column_name FROM information_schema.table_constraints tc
				 JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
				 WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'`,
				[t],
			);
			const pkSet = new Set(pk.rows.map((x) => x.column_name));
			const idx = await c.query(
				`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1`,
				[t],
			);
			const ddlLines = cols.rows.map(
				(c2) =>
					`  ${qPg(c2.column_name)} ${c2.data_type}${c2.max_len ? `(${c2.max_len})` : ""}${c2.is_nullable === "NO" ? " NOT NULL" : ""}${c2.column_default ? ` DEFAULT ${c2.column_default}` : ""}`,
			);
			if (pkSet.size) ddlLines.push(`  PRIMARY KEY (${[...pkSet].map(qPg).join(", ")})`);
			return {
				columns: cols.rows.map((c2) => ({
					name: String(c2.column_name),
					type: String(c2.data_type) + (c2.max_len ? `(${c2.max_len})` : ""),
					nullable: c2.is_nullable === "YES",
					key: pkSet.has(c2.column_name) ? "PRI" : "",
					def: c2.column_default == null ? null : String(c2.column_default),
					comment: "",
				})),
				indexes: idx.rows.map((i) => ({
					name: String(i.indexname),
					unique: /CREATE UNIQUE/i.test(String(i.indexdef)),
					columns: String(i.indexdef),
				})),
				ddl: `CREATE TABLE ${qPg(t)} (\n${ddlLines.join(",\n")}\n);`,
			};
		},
		async selectPage(db, t, opt) {
			const c = await getCli(db);
			const cnt = await c.query(`SELECT COUNT(*)::bigint AS n FROM ${qPg("public")}.${qPg(t)}`);
			const total = Number(cnt.rows[0]?.n ?? 0);
			const orderSql = opt.orderBy
				? ` ORDER BY ${qPg(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`
				: " ORDER BY 1";
			const r = await c.query(`SELECT * FROM ${qPg("public")}.${qPg(t)}${orderSql} LIMIT $1 OFFSET $2`, [
				Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS),
				Math.max(Number(opt.offset) || 0, 0),
			]);
			const columns = r.fields.map((f) => f.name);
			const pkR = await c.query(
				`SELECT kcu.column_name FROM information_schema.table_constraints tc
				 JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
				 WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
				 ORDER BY kcu.ordinal_position LIMIT 1`,
				[t],
			);
			const pkCol = pkR.rows[0]?.column_name;
			return {
				total,
				...rowsToGrid(columns, r.rows),
				editable: Boolean(pkCol),
				pkCol: pkCol == null ? null : String(pkCol),
			};
		},
		async query(db, sql) {
			const c = await getCli(db || curName);
			const started = Date.now();
			const r = await c.query(sql);
			const columns = r.fields?.map((f) => f.name) ?? [];
			return {
				total: r.rows?.length ?? 0,
				affected: r.rowCount != null && !columns.length ? r.rowCount : 0,
				elapsedMs: Date.now() - started,
				...rowsToGrid(columns, r.rows ?? []),
			};
		},
		async updateRow(db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const c = await getCli(db);
			const sets = cols.map((col, i) => `${qPg(col)}=$${i + 1}`).join(", ");
			const r = await c.query(`UPDATE ${qPg("public")}.${qPg(t)} SET ${sets} WHERE ${qPg(pkCol)}=$${cols.length + 1}`, [
				...Object.values(changes),
				pkVal,
			]);
			return { affected: r.rowCount ?? 0 };
		},
		async insertRow(db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const c = await getCli(db);
			const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
			const r = await c.query(
				`INSERT INTO ${qPg("public")}.${qPg(t)} (${cols.map(qPg).join(", ")}) VALUES (${ph}) RETURNING 1 AS ok`,
				Object.values(values),
			);
			return { affected: r.rowCount ?? 1, id: null };
		},
		async deleteRow(db, t, pkCol, pkVal) {
			const c = await getCli(db);
			const r = await c.query(`DELETE FROM ${qPg("public")}.${qPg(t)} WHERE ${qPg(pkCol)}=$1`, [pkVal]);
			return { affected: r.rowCount ?? 0 };
		},
		async close() {
			for (const c of clients.values()) {
				try {
					await c.end();
				} catch {
					/* ignore */
				}
			}
		},
	};
}

interface SqliteStatement {
	all(...params: unknown[]): Record<string, unknown>[];
	run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
	columns(): { name: string }[];
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	close(): void;
}

interface SqliteModule {
	DatabaseSync?: new (path: string) => SqliteDatabase;
	default?: { DatabaseSync?: new (path: string) => SqliteDatabase };
}

async function sqliteAdapter(cfg: StoredConn): Promise<DbAdapter> {
	if (!cfg.file || !String(cfg.file).trim()) throw new Error("SQLite requires a database file path");
	if (!existsSync(String(cfg.file).trim())) throw new Error(`Database file does not exist: ${cfg.file}`);
	// Node's builtin node:sqlite (no flag needed since 22.13): zero native
	// dependencies, opened for writing so row editing works.
	const mod = await loadDriver<SqliteModule>("node:sqlite");
	const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
	if (!DatabaseSync) throw new Error("This Node build has no node:sqlite support (requires >= 22.13)");
	const db = new DatabaseSync(String(cfg.file).trim());
	function all(sql: string, ...args: unknown[]): Record<string, unknown>[] {
		return db.prepare(sql).all(...args);
	}
	// Primary-key probe cache: a single INTEGER or composite key is used when there
	// is one; a table without a primary key falls back to rowid, which the query
	// carries out as a __rid__ column.
	const pkCache = new Map<string, string | null>();
	function tablePk(t: string | undefined): string | null {
		const key = String(t);
		if (pkCache.has(key)) return pkCache.get(key) ?? null;
		const info = all(`PRAGMA table_info(${qSqlite(t)})`);
		const pks = info.filter((c) => Number(c.pk) > 0);
		// A composite primary key cannot locate a single row, so it is not used.
		const col = pks.length === 1 ? String(pks[0].name) : null;
		pkCache.set(key, col);
		return col;
	}
	return {
		kind: "sql",
		dialect: "sqlite",
		async listDatabases() {
			return ["main"];
		},
		async listTables() {
			return all(
				`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			).map((r) => ({ name: String(r.name), kind: r.type === "view" ? "view" : "table", approxRows: 0 }));
		},
		async describeTable(_db, t) {
			const info = all(`PRAGMA table_info(${qSqlite(t)})`);
			const idxList = all(`PRAGMA index_list(${qSqlite(t)})`);
			const indexes = idxList.map((i) => {
				const cols = all(`PRAGMA index_info(${qSqlite(i.name)})`).map((x) => x.name);
				return { name: String(i.name), unique: !Number(i.unique), columns: cols.join(", ") };
			});
			const master = all(`SELECT sql FROM sqlite_master WHERE name=?`, t)[0];
			return {
				columns: info.map((c) => ({
					name: String(c.name),
					type: String(c.type || ""),
					nullable: !Number(c.pk) ? c.notnull === 0 : false,
					key: Number(c.pk) ? "PRI" : "",
					def: c.dflt_value == null ? null : String(c.dflt_value),
					comment: "",
				})),
				indexes,
				ddl: master?.sql == null ? "" : String(master.sql),
			};
		},
		async selectPage(_db, t, opt) {
			const total = Number(all(`SELECT COUNT(*) AS n FROM ${qSqlite(t)}`)[0]?.n ?? 0);
			const orderSql = opt.orderBy ? ` ORDER BY ${qSqlite(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"}` : "";
			const useRid = !tablePk(t);
			const sel = useRid ? `rowid AS "__rid__", *` : "*";
			const rows = all(
				`SELECT ${sel} FROM ${qSqlite(t)}${orderSql} LIMIT ? OFFSET ?`,
				Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS),
				Math.max(Number(opt.offset) || 0, 0),
			);
			const colsRow = all(`PRAGMA table_info(${qSqlite(t)})`);
			const columns = [...(useRid ? ["__rid__"] : []), ...colsRow.map((c) => String(c.name))];
			return {
				total,
				...rowsToGrid(columns, rows),
				editable: true,
				pkCol: tablePk(t) ?? "__rid__",
			};
		},
		async query(_db, sql) {
			const started = Date.now();
			if (/^\s*(select|with|pragma|explain|values)\b/i.test(sql)) {
				const stmt = db.prepare(sql);
				const rows = stmt.all().slice(0, MAX_QUERY_ROWS);
				const columns = stmt.columns().map((c) => String(c.name));
				return {
					total: rows.length,
					affected: 0,
					elapsedMs: Date.now() - started,
					...rowsToGrid(columns, rows),
				};
			}
			const info = db.prepare(sql).run();
			return {
				total: 0,
				affected: Number(info?.changes ?? 0),
				elapsedMs: Date.now() - started,
				columns: [],
				rows: [],
			};
		},
		async updateRow(_db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const info = db
				.prepare(
					`UPDATE ${qSqlite(t)} SET ${cols
						.map(qSqlite)
						.map((c) => `${c}=?`)
						.join(", ")} WHERE ${qSqlite(pkCol)}=?`,
				)
				.run(...Object.values(changes), pkVal);
			return { affected: Number(info.changes ?? 0) };
		},
		async insertRow(_db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const info = db
				.prepare(
					`INSERT INTO ${qSqlite(t)} (${cols.map(qSqlite).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
				)
				.run(...Object.values(values));
			return { affected: 1, id: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
		},
		async deleteRow(_db, t, pkCol, pkVal) {
			const info = db.prepare(`DELETE FROM ${qSqlite(t)} WHERE ${qSqlite(pkCol)}=?`).run(pkVal);
			return { affected: Number(info.changes ?? 0) };
		},
		async close() {
			try {
				db.close();
			} catch {
				/* ignore */
			}
		},
	};
}

interface MssqlRequest {
	input(name: string, typeOrValue: unknown, value?: unknown): MssqlRequest;
	query(sql: string): Promise<MssqlQueryResult>;
}

interface MssqlRecordset extends Array<Record<string, unknown>> {
	columns?: Record<string, unknown>;
}

interface MssqlQueryResult {
	recordset: MssqlRecordset;
	rowsAffected?: number[];
}

interface MssqlPool {
	request(): MssqlRequest;
	connect(): Promise<unknown>;
	close(): Promise<unknown>;
}

interface MssqlModule {
	ConnectionPool: new (config: Record<string, unknown>) => MssqlPool;
	VarChar(size: number): unknown;
	Int: unknown;
	default?: MssqlModule;
}

async function mssqlAdapter(cfg: StoredConn): Promise<DbAdapter> {
	const ms = await loadDriver<MssqlModule>("mssql");
	const mssql = ms.default ?? ms;
	const baseCfg = {
		server: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 1433,
		user: cfg.user || "sa",
		password: cfg.password || "",
		database: cfg.database || "master",
		connectionTimeout: CONNECT_TIMEOUT_MS,
		requestTimeout: OP_TIMEOUT_MS,
		options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
	};
	const pools = new Map<string, MssqlPool>();
	async function getPool(name: string | undefined): Promise<MssqlPool> {
		name = name || baseCfg.database;
		let p = pools.get(name);
		if (p) return p;
		p = new mssql.ConnectionPool({ ...baseCfg, database: name });
		await withTimeout(p.connect(), CONNECT_TIMEOUT_MS + 5000, "connect");
		pools.set(name, p);
		return p;
	}
	const main = await getPool(baseCfg.database);
	async function qual(db: string | undefined, t: string | undefined): Promise<string> {
		// Look up the real schema instead of assuming dbo.
		const r = await (
			await getPool(db)
		)
			.request()
			.input("t", mssql.VarChar(256), t)
			.query(
				`SELECT TOP 1 OBJECT_SCHEMA_NAME(object_id) AS s FROM ${qMssql(db)}.sys.objects WHERE name=@t AND type IN ('U','V')`,
			);
		const found = r.recordset[0]?.s as string | undefined;
		const schema = found || "dbo";
		return `${qMssql(db)}.${qMssql(schema)}.${qMssql(t)}`;
	}
	return {
		kind: "sql",
		dialect: "mssql",
		async listDatabases() {
			const r = await main.request().query("SELECT name FROM sys.databases WHERE state=0 ORDER BY name");
			return r.recordset.map((x) => String(x.name));
		},
		async listTables(db) {
			const r = await (
				await getPool(db)
			)
				.request()
				.query(
					`SELECT name, CASE type WHEN 'U' THEN 'table' ELSE 'view' END AS kind FROM ${qMssql(db)}.sys.objects WHERE type IN ('U','V') ORDER BY name`,
				);
			return r.recordset.map((x) => ({ name: String(x.name), kind: String(x.kind), approxRows: 0 }));
		},
		async describeTable(db, t) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const cols = await pool
				.request()
				.input("t", mssql.VarChar(256), t)
				.query(
					`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
				        CHARACTER_MAXIMUM_LENGTH AS max_len
				 FROM ${qMssql(db)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=@t ORDER BY ORDINAL_POSITION`,
				);
			const pk = await pool
				.request()
				.input("t", mssql.VarChar(256), t)
				.query(
					`SELECT ku.COLUMN_NAME AS name FROM ${qMssql(db)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				 JOIN ${qMssql(db)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME
				 WHERE tc.TABLE_NAME=@t AND tc.CONSTRAINT_TYPE='PRIMARY KEY'`,
				);
			const pkSet = new Set(pk.recordset.map((x) => x.name));
			return {
				columns: cols.recordset.map((c) => {
					const maxLen = Number(c.max_len);
					return {
						name: String(c.name),
						type: String(c.type) + (c.max_len && maxLen > 0 && maxLen < 8000 ? `(${String(c.max_len)})` : ""),
						nullable: c.nullable === "YES",
						key: pkSet.has(c.name) ? "PRI" : "",
						def: c.def == null ? null : String(c.def),
						comment: "",
					};
				}),
				indexes: [],
				ddl:
					`-- ${fq}\n` +
					cols.recordset.map((c) => `  ${c.name} ${c.type} ${c.nullable === "YES" ? "NULL" : "NOT NULL"}`).join("\n"),
			};
		},
		async selectPage(db, t, opt) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const totalR = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${fq}`);
			const total = Number(totalR.recordset[0]?.n ?? 0);
			const orderSql = opt.orderBy
				? ` ORDER BY ${qMssql(opt.orderBy)} ${opt.dir === "desc" ? "DESC" : "ASC"} OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`
				: ` ORDER BY (SELECT NULL) OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`;
			const r = await pool
				.request()
				.input("off", mssql.Int, Math.max(Number(opt.offset) || 0, 0))
				.input("lim", mssql.Int, Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS))
				.query(`SELECT * FROM ${fq}${orderSql}`);
			const columns = r.recordset.columns
				? Object.keys(r.recordset.columns)
				: r.recordset[0]
					? Object.keys(r.recordset[0])
					: [];
			const pkR = await pool
				.request()
				.input("t", mssql.VarChar(256), t)
				.query(
					`SELECT TOP 1 ku.COLUMN_NAME AS name FROM ${qMssql(db)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				 JOIN ${qMssql(db)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME
				 WHERE tc.TABLE_NAME=@t AND tc.CONSTRAINT_TYPE='PRIMARY KEY'`,
				);
			const pkCol = pkR.recordset[0]?.name;
			return {
				total,
				...rowsToGrid(columns, r.recordset),
				editable: Boolean(pkCol),
				pkCol: pkCol == null ? null : String(pkCol),
			};
		},
		async query(db, sql) {
			const pool = await getPool(db || baseCfg.database);
			const started = Date.now();
			const r = await pool.request().query(sql);
			const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : [];
			return {
				total: r.recordset?.length ?? 0,
				affected: r.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0,
				elapsedMs: Date.now() - started,
				...rowsToGrid(columns, r.recordset ?? []),
			};
		},
		async updateRow(db, t, pkCol, pkVal, changes) {
			const cols = Object.keys(changes);
			if (!cols.length) throw new Error("No columns to update");
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const req = pool.request().input("pk", pkVal);
			cols.forEach((c, i) => req.input(`v${i}`, changes[c]));
			const sets = cols.map((c, i) => `${qMssql(c)}=@v${i}`).join(", ");
			const r = await req.query(`UPDATE ${fq} SET ${sets} WHERE ${qMssql(pkCol)}=@pk`);
			return { affected: r.rowsAffected?.[0] ?? 0 };
		},
		async insertRow(db, t, values) {
			const cols = Object.keys(values);
			if (!cols.length) throw new Error("No columns to insert (all left blank)");
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const req = pool.request();
			cols.forEach((c, i) => req.input(`v${i}`, values[c]));
			const r = await req.query(
				`INSERT INTO ${fq} (${cols.map(qMssql).join(", ")}) OUTPUT inserted.* VALUES (${cols.map((_, i) => `@v${i}`).join(", ")})`,
			);
			return { affected: 1, id: r.recordset?.[0] ?? null };
		},
		async deleteRow(db, t, pkCol, pkVal) {
			const pool = await getPool(db);
			const fq = await qual(db, t);
			const r = await pool
				.request()
				.input("pk", pkVal)
				.query(`DELETE FROM ${fq} WHERE ${qMssql(pkCol)}=@pk`);
			return { affected: r.rowsAffected?.[0] ?? 0 };
		},
		async close() {
			for (const p of pools.values()) {
				try {
					await p.close();
				} catch {
					/* ignore */
				}
			}
		},
	};
}

interface MongoCursor {
	skip(count: number): MongoCursor;
	limit(count: number): MongoCursor;
	toArray(): Promise<Record<string, unknown>[]>;
}

interface MongoCollection {
	countDocuments(filter: Record<string, unknown>): Promise<number>;
	find(filter: Record<string, unknown>): MongoCursor;
	replaceOne(filter: Record<string, unknown>, doc: Record<string, unknown>): Promise<{ modifiedCount?: number }>;
	insertOne(doc: Record<string, unknown>): Promise<{ insertedId?: { toString(): string } }>;
	deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
	listIndexes(): { toArray(): Promise<{ name?: unknown; unique?: unknown; key?: unknown }[]> };
}

interface MongoDb {
	collection(name?: string): MongoCollection;
	listCollections(): { toArray(): Promise<{ name: string; type?: string }[]> };
	admin(): { listDatabases(): Promise<{ databases: { name: string }[] }> };
}

interface MongoClientLike {
	connect(): Promise<unknown>;
	db(name?: string): MongoDb;
	close(): Promise<unknown>;
}

interface MongoModule {
	MongoClient: new (url: string, options: Record<string, unknown>) => MongoClientLike;
	ObjectId: new (hex: string) => unknown;
	default?: Partial<MongoModule>;
}

async function mongoAdapter(cfg: StoredConn): Promise<DbAdapter> {
	const mod = await loadDriver<MongoModule>("mongodb");
	const MongoClient = mod.MongoClient ?? mod.default?.MongoClient;
	// Resolved from the driver module: a 24-hex _id has to go back as an ObjectId
	// or the query matches nothing.
	const ObjectId = mod.ObjectId ?? mod.default?.ObjectId;
	let url = cfg.uri;
	if (!url) {
		const auth = cfg.user
			? `${encodeURIComponent(String(cfg.user))}:${encodeURIComponent(String(cfg.password || ""))}@`
			: "";
		url = `mongodb://${auth}${cfg.host || "127.0.0.1"}:${Number(cfg.port) || 27017}/${cfg.database ? encodeURIComponent(cfg.database) : ""}`;
	}
	const client = new MongoClient(url, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
	await withTimeout(client.connect(), CONNECT_TIMEOUT_MS + 3000, "connect");
	return {
		kind: "mongodb",
		dialect: "mongo",
		async listDatabases() {
			return (await client.db().admin().listDatabases()).databases.map((d) => d.name);
		},
		async listTables(db) {
			const colls = await client.db(db).listCollections().toArray();
			return colls.map((c) => ({
				name: c.name,
				kind: c.type === "view" ? "view" : "collection",
				approxRows: 0,
			}));
		},
		async describeTable(db, t) {
			const coll = client.db(db).collection(t);
			let indexes: TableIndex[] = [];
			try {
				indexes = (await coll.listIndexes().toArray()).map((i) => ({
					name: String(i.name),
					unique: Boolean(i.unique),
					columns: JSON.stringify(i.key),
				}));
			} catch {
				/* ignore */
			}
			return {
				columns: [],
				indexes,
				ddl: `Collection ${db}.${t} (documents have no fixed schema - browse them on the Data tab)`,
			};
		},
		async selectPage(db, t, opt) {
			const coll = client.db(db).collection(t);
			const filter = parseJsonFilter(opt.filter);
			const total = await coll.countDocuments(filter);
			const docsRaw = await coll
				.find(filter)
				.skip(Math.max(Number(opt.offset) || 0, 0))
				.limit(Math.min(Number(opt.limit) || 50, MAX_PAGE_ROWS))
				.toArray();
			// BSON -> plain JSON (_id, dates and friends become strings), while the
			// structured documents are kept alongside so an edit can be written back.
			const replacer = (_key: string, value: unknown): unknown => {
				const candidate = value as { _bsontype?: unknown; toString?: () => string } | null;
				if (candidate && typeof candidate === "object" && candidate._bsontype) {
					if (typeof candidate.toString === "function" && candidate.toString !== Object.prototype.toString) {
						return candidate.toString();
					}
				}
				if (typeof value === "bigint") return Number(value);
				return value;
			};
			const docs = JSON.parse(JSON.stringify(docsRaw, replacer)) as Record<string, unknown>[];
			return { total, columns: ["doc"], rows: docs.map((d) => [JSON.stringify(d)]), docs, editable: true };
		},
		async docSave(db, t, id, docJson) {
			let body: unknown;
			try {
				body = JSON.parse(String(docJson ?? ""));
			} catch (err) {
				throw new Error(`Failed to parse document JSON: ${(err as Error).message}`);
			}
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Document must be a JSON object");
			const toId = (v: unknown): unknown => (typeof v === "string" && /^[0-9a-f]{24}$/i.test(v) ? new ObjectId(v) : v);
			const coll = client.db(db).collection(t);
			const next = { ...(body as Record<string, unknown>), _id: toId(id) };
			const r = await coll.replaceOne({ _id: toId(id) }, next);
			return { affected: r.modifiedCount ?? 0 };
		},
		async docInsert(db, t, docJson) {
			let body: unknown;
			try {
				body = JSON.parse(String(docJson ?? ""));
			} catch (err) {
				throw new Error(`Failed to parse document JSON: ${(err as Error).message}`);
			}
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Document must be a JSON object");
			const doc = body as Record<string, unknown>;
			if (typeof doc._id === "string" && /^[0-9a-f]{24}$/i.test(doc._id)) doc._id = new ObjectId(doc._id);
			const r = await client.db(db).collection(t).insertOne(doc);
			return { affected: 1, id: r.insertedId?.toString?.() ?? null };
		},
		async docDelete(db, t, id) {
			const toId = (v: unknown): unknown => (typeof v === "string" && /^[0-9a-f]{24}$/i.test(v) ? new ObjectId(v) : v);
			const r = await client
				.db(db)
				.collection(t)
				.deleteOne({ _id: toId(id) });
			return { affected: r.deletedCount ?? 0 };
		},
		async query() {
			throw new Error("MongoDB does not support SQL - use a JSON filter on the Data tab instead");
		},
		async close() {
			try {
				await client.close();
			} catch {
				/* ignore */
			}
		},
	};
}

interface RedisPipeline {
	type(key: string): void;
	exec(): Promise<[Error | null, unknown][]>;
}

interface RedisClient {
	ping(): Promise<unknown>;
	on(event: string, listener: (...args: unknown[]) => void): void;
	scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
	pipeline(): RedisPipeline;
	type(key: string): Promise<string>;
	ttl(key: string): Promise<number>;
	get(key: string): Promise<string | null>;
	hgetall(key: string): Promise<Record<string, string>>;
	lrange(key: string, start: number, stop: number): Promise<string[]>;
	smembers(key: string): Promise<string[]>;
	zrange(key: string, start: number, stop: number, withScores: string): Promise<string[]>;
	xrange(key: string, start: string, end: string, countLabel: string, count: number): Promise<[string, unknown][]>;
	strlen(key: string): Promise<number>;
	hlen(key: string): Promise<number>;
	llen(key: string): Promise<number>;
	scard(key: string): Promise<number>;
	zcard(key: string): Promise<number>;
	xlen(key: string): Promise<number>;
	del(key: string): Promise<number>;
	set(key: string, value: string): Promise<unknown>;
	call(command: string, ...args: string[]): Promise<unknown>;
	dbsize(): Promise<number>;
	info(section: string): Promise<string>;
	disconnect(): void;
}

type RedisCtor = new (options: Record<string, unknown>) => RedisClient;

interface RedisModule {
	default?: RedisCtor;
	Redis?: RedisCtor;
}

async function redisAdapter(cfg: StoredConn): Promise<DbAdapter> {
	const mod = await loadDriver<RedisModule>("ioredis");
	// ioredis has shipped itself as the default export and as a named one; the
	// module object itself is the last shape older builds used.
	const Redis = mod.default ?? mod.Redis ?? (mod as unknown as RedisCtor);
	const cli = new Redis({
		host: cfg.host || "127.0.0.1",
		port: Number(cfg.port) || 6379,
		password: cfg.password || undefined,
		db: Number(cfg.redisDb) > 0 ? Number(cfg.redisDb) : 0,
		maxRetriesPerRequest: 1,
		connectTimeout: CONNECT_TIMEOUT_MS,
		retryStrategy: () => null,
		lazyConnect: false,
	});
	cli.on("error", () => {
		/* stay quiet here; the operation layer reports the failure */
	});
	await withTimeout(cli.ping(), CONNECT_TIMEOUT_MS + 2000, "connect");

	async function scanKeys(pattern: unknown, cursorIn: unknown, wantIn: unknown): Promise<RedisScanResult> {
		const want = Math.min(Number(wantIn) || 200, 1000);
		let cursor = String(cursorIn || "0");
		const keys: string[] = [];
		do {
			const [next, batch] = await cli.scan(cursor, "MATCH", String(pattern || "*"), "COUNT", 200);
			cursor = next;
			for (const k of batch) if (keys.length < want) keys.push(k);
		} while (cursor !== "0" && keys.length < want);
		const capped = keys.slice(0, want);
		let types: [Error | null, unknown][] = [];
		if (capped.length) {
			const pipe = cli.pipeline();
			for (const k of capped) pipe.type(k);
			types = await pipe.exec();
		}
		return {
			cursor,
			keys: capped.map((k, i) => ({ key: k, type: String(types[i]?.[1] ?? "none") })),
		};
	}

	async function keyDetail(key: string): Promise<RedisKeyDetail> {
		const type = await cli.type(key);
		const ttl = await cli.ttl(key);
		let value = "";
		if (type === "string") value = (await cli.get(key)) ?? "(nil)";
		else if (type === "hash") {
			const h = await cli.hgetall(key);
			value = Object.entries(h)
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n");
		} else if (type === "list") value = (await cli.lrange(key, 0, 199)).map((v, i) => `${i}: ${v}`).join("\n");
		else if (type === "set") value = [...(await cli.smembers(key))].slice(0, 200).join("\n");
		else if (type === "zset") {
			const z = await cli.zrange(key, 0, 199, "WITHSCORES");
			const lines: string[] = [];
			for (let i = 0; i < z.length; i += 2) lines.push(`${z[i]}  (score: ${z[i + 1]})`);
			value = lines.join("\n");
		} else if (type === "stream") {
			const r = await cli.xrange(key, "-", "+", "COUNT", 50);
			value = r.map(([id, fs]) => `${id} ${JSON.stringify(fs)}`).join("\n");
		} else value = `(type ${type} cannot be previewed)`;
		let truncated = false;
		if (value.length > 64_000) {
			value = value.slice(0, 64_000) + "\n...[truncated]";
			truncated = true;
		}
		const size =
			type === "string"
				? await cli.strlen(key)
				: type === "hash"
					? await cli.hlen(key)
					: type === "list"
						? await cli.llen(key)
						: type === "set"
							? await cli.scard(key)
							: type === "zset"
								? await cli.zcard(key)
								: type === "stream"
									? await cli.xlen(key)
									: 0;
		return { type, ttl, size, value, truncated };
	}

	return {
		kind: "redis",
		dialect: "redis",
		listDatabases: async () => [`db${Number(cfg.redisDb) || 0}`],
		listTables: async () => [],
		describeTable: async () => ({ columns: [], indexes: [], ddl: "" }),
		selectPage: async () => ({ total: 0, columns: [], rows: [] }),
		query: async () => {
			throw new Error("For Redis use the raw command input on the Keys tab");
		},
		scanKeys,
		keyDetail,
		delKey: async (key) => await cli.del(key),
		keySet: async (key, value) => {
			const type = await cli.type(key);
			if (type !== "string") {
				throw new Error(`Only string keys can be edited (this key is ${type}; use a raw command instead)`);
			}
			await cli.set(key, String(value ?? ""));
			return { affected: 1 };
		},
		runCmd: async (line) => {
			const args = tokenize(line);
			if (!args.length) throw new Error("Empty command");
			return await cli.call(args[0], ...args.slice(1));
		},
		meta: async () => {
			const dbsize = await cli.dbsize();
			const mem = await cli.info("memory");
			const line = mem.split(/\r?\n/).find((l) => l.startsWith("used_memory_human"));
			return { dbsize, usedMemory: line ? (line.split(":")[1]?.trim() ?? "?") : "?" };
		},
		async close() {
			try {
				cli.disconnect();
			} catch {
				/* ignore */
			}
		},
	};
}

export const ADAPTER_FACTORIES: Record<DbEngine, AdapterFactory> = {
	mysql: mysqlAdapter,
	postgres: postgresAdapter,
	sqlite: sqliteAdapter,
	sqlserver: mssqlAdapter,
	mongodb: mongoAdapter,
	redis: redisAdapter,
};

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

/** The action-specific half of a response. Most actions build an object literal; *  the row/document/redis-write actions forward the adapter's own result object. */
type ResponseExtra = Record<string, unknown> | WriteResult | RedisScanResult;

interface Runtime {
	connId: string;
	ownerId: string;
	hostId: string | undefined;
	label: string;
	adapter: DbAdapter;
}

interface State {
	conns: StoredConn[];
	runtime: Map<string, Runtime>;
	nextConnId: number;
	depsOk: boolean;
	depsInstalling: boolean;
	depsAvail: Record<string, boolean> | null;
	/** The npm child process that is currently running, killed on shutdown/reload. */
	installer: ChildProcess | null;
	/** Set on deactivate, so a late child callback stops touching the host. */
	dead: boolean;
}

const entry: { activate(host: PluginHost): () => void } = {
	activate(host) {
		const st: State = {
			conns: [], // [{id,name,type,host,port,user,password,database,file,uri,redisDb}]
			runtime: new Map(), // connId -> {connId, ownerId, hostId, label, adapter}
			nextConnId: 1,
			depsOk: false,
			depsInstalling: false,
			depsAvail: null,
			installer: null,
			dead: false,
		};

		// ---- config persistence ----------------------------------------------
		// Secrets: a connection password is stored per connection id through
		// host.secrets (AES-256-GCM), so db-connections.json no longer holds
		// plaintext. A host without that facility falls back to the old behaviour.
		// Credentials embedded in a uri cannot be split out reliably - they stay in
		// the file, and the UI says so.
		const sec = host.secrets;

		async function loadConfig(): Promise<void> {
			try {
				const cfg = JSON.parse(await rf(join(host.dir, CONFIG_FILE), "utf8")) as { conns?: unknown };
				st.conns = Array.isArray(cfg.conns) ? (cfg.conns as StoredConn[]) : [];
			} catch {
				st.conns = [];
			}
			if (sec?.set) {
				// One-off migration: historical plaintext passwords -> encrypted
				// secrets, stripped from the file.
				let migrated = false;
				for (const c of st.conns) {
					if (c.password && c.id) {
						try {
							sec.set(`conn:${c.id}`, String(c.password));
						} catch {
							/* ignore */
						}
						delete c.password;
						migrated = true;
					}
				}
				if (migrated) {
					try {
						await saveConfig();
					} catch {
						/* ignore */
					}
					host.log("Migrated connection passwords to encrypted storage");
				}
			}
			if (sec?.get) {
				// Backfill the in-memory copy: a driver connection needs the real password.
				for (const c of st.conns) if (!c.password && c.id) c.password = sec.get(`conn:${c.id}`);
			}
		}
		async function saveConfig(): Promise<void> {
			// Passwords are stripped before the file is written.
			const conns = sec ? st.conns.map((c) => ({ ...c, password: undefined })) : st.conns;
			await wf(join(host.dir, CONFIG_FILE), JSON.stringify({ conns }, null, "\t"), "utf8");
		}
		/** Store or clear one connection's password secret (truthy -> write, an
		 *  explicit null -> delete). */
		function storeConnSecret(id: string | undefined, pwd: string | null | undefined): void {
			if (!sec || !id) return;
			try {
				if (pwd === null) sec.delete(`conn:${id}`);
				else if (pwd) sec.set(`conn:${id}`, String(pwd));
			} catch {
				/* ignore */
			}
		}

		function publicConn(c: StoredConn): PublicConn {
			return {
				id: c.id,
				name: c.name,
				type: c.type,
				host: c.host,
				port: c.port,
				user: c.user,
				database: c.database ?? "",
				file: c.file ?? "",
				hasPass: Boolean(c.password),
				hasUri: Boolean(c.uri),
				redisDb: c.redisDb ?? 0,
			};
		}

		function publicState(): PublicState {
			return {
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				depsAvail: st.depsAvail,
				types: DB_TYPES,
				conns: st.conns.map(publicConn),
				active: [...st.runtime.values()].map((r) => ({ connId: r.connId, hostId: r.hostId, label: r.label })),
			};
		}

		function broadcastAll(): void {
			host.broadcast({ kind: "state", state: publicState() });
		}

		function respond(
			action: string | undefined,
			reqId: string | undefined,
			clientId: string | undefined,
			extra: ResponseExtra = {},
		): void {
			// A message with no origin has no socket to answer; the host drops it.
			host.sendTo(clientId ?? "", { res: true, reqId, ok: true, action, ...extra });
		}
		function fail(
			action: string | undefined,
			reqId: string | undefined,
			clientId: string | undefined,
			error: unknown,
		): void {
			const message = error instanceof Error ? error.message : String(error);
			host.sendTo(clientId ?? "", { res: true, reqId, ok: false, action, error: message });
		}

		// ---- dependency auto-install ------------------------------------------
		async function loadDeps(): Promise<boolean> {
			// Probe per driver, so a partial install still serves the engines it has.
			const results = await Promise.all(
				Object.entries(DRIVER_MODULE).map(async ([_type, name]): Promise<[string, boolean]> => {
					try {
						await import(name);
						return [name, true];
					} catch {
						return [name, false];
					}
				}),
			);
			st.depsAvail = Object.fromEntries(results);
			st.depsOk = Object.values(st.depsAvail).every(Boolean);
			if (!st.depsOk) host.log("driver availability:", JSON.stringify(st.depsAvail));
			return st.depsOk;
		}

		/** Lazy re-probe: after a manual npm install the drivers are picked up
		 *  without restarting the server (module imports are cached, so this is cheap). */
		async function refreshDeps(): Promise<void> {
			if (!st.depsOk && !st.depsInstalling) await loadDeps();
		}

		function resolveNpmCli(): string | null {
			try {
				return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
			} catch {
				/* the plugin does not depend on the npm package, so this usually misses */
			}
			// The npm that sits next to the node executable (standard Windows install,
			// fnm, nvm). Calling it directly avoids a shell: paths with spaces stay
			// safe and it works even when npm is not on the server's PATH.
			try {
				const cands = [
					join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
					join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
				];
				for (const c of cands) if (existsSync(c)) return c;
			} catch {
				/* ignore */
			}
			return null;
		}

		/** Install mutex that survives an activation: plugins_reload rebuilds the
		 *  activate closure, so `st` cannot guard it - a lock file stops two npm
		 *  processes trampling the same directory. True means the lock is fresh, so
		 *  do not install. */
		function installLocked(dir: string): boolean {
			try {
				const parsed = JSON.parse(readFileSync(join(dir, INSTALL_LOCK), "utf8")) as { at?: unknown } | null;
				const at = Number(parsed?.at ?? 0);
				if (Number.isFinite(at) && Date.now() - at < INSTALL_LOCK_STALE_MS) return true;
			} catch {
				/* no lock, or an expired/corrupt one */
			}
			return false;
		}

		function installDeps(auto = false): void {
			if (st.depsInstalling || st.depsOk || st.installer) return;
			if (auto && process.env.PI_DB_CLIENT_NO_AUTOINSTALL) {
				host.log("auto install disabled by PI_DB_CLIENT_NO_AUTOINSTALL");
				return;
			}
			if (installLocked(host.dir)) {
				host.log("install skipped: another install task holds the lock");
				host.notify("info", "🗄️ Database plugin: a driver install is already running - check back in a moment");
				return;
			}
			st.depsInstalling = true;
			broadcastAll();
			host.log(`installing deps: ${DEPS.join(" ")}${auto ? " (auto)" : ""}`);
			host.notify("info", "🗄️ Database plugin: installing driver dependencies (the first run takes a few minutes)");
			try {
				writeFileSync(join(host.dir, INSTALL_LOCK), JSON.stringify({ at: Date.now(), pid: process.pid }));
			} catch {
				/* a lock that cannot be written must not block the install */
			}
			const npmCli = resolveNpmCli();
			const args = ["--prefix", host.dir, "install", ...DEPS, "--no-audit", "--no-fund"];
			// On Windows npm is a .cmd, so node is pointed at npm-cli.js directly
			// wherever it can be found. Only when it cannot is a shell used, and then
			// the command is assembled into one quoted string: spawn(cmd, [...args],
			// {shell:true}) concatenates without escaping, so a directory containing a
			// space would install into the wrong place (Node reports this as
			// "arguments are not escaped, only concatenated").
			const child = npmCli
				? spawn(process.execPath, [npmCli, ...args], { stdio: ["ignore", "ignore", "pipe"] })
				: spawn(`npm ${args.map((a) => winQuote(a)).join(" ")}`, [], {
						stdio: ["ignore", "ignore", "pipe"],
						shell: true,
					});
			st.installer = child;
			// Watchdog: kill an install that never finishes, so the UI does not spin
			// on "installing drivers" forever.
			const timer = setTimeout(() => {
				host.log(`install timed out after ${INSTALL_TIMEOUT_MS / 60000}min, killing npm`);
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, 5000).unref?.();
				void finish(false, "install timed out");
			}, INSTALL_TIMEOUT_MS);
			timer.unref?.();
			let errTail = "";
			child.stderr?.on("data", (d: { toString(): string }) => {
				errTail = (errTail + d.toString()).slice(-1000);
			});
			let done = false;
			child.on("error", (err) => void finish(false, err.message));
			child.on(
				"exit",
				(code, signal) => void finish(code === 0, signal ? `npm was killed (${signal})` : `npm exit ${code}`),
			);
			async function finish(ok: boolean, why: string): Promise<void> {
				if (done || st.dead) return;
				done = true;
				clearTimeout(timer);
				if (st.installer === child) st.installer = null;
				try {
					rmSync(join(host.dir, INSTALL_LOCK), { force: true });
				} catch {
					/* ignore */
				}
				st.depsInstalling = false;
				if (ok) await loadDeps();
				// Take the last non-empty stderr line (usually the npm error summary)
				// instead of leaving the user with a bare exit code.
				const lastErr = errTail.split(/\r?\n/).filter(Boolean).pop() ?? "";
				host.notify(
					ok ? "success" : "error",
					ok
						? "🗄️ Database plugin: driver install finished"
						: `🗄️ Database plugin: driver install failed (${why}${lastErr ? `: ${lastErr}` : ""}) - run this manually in the plugin directory: npm install ${DEPS.join(" ")}`,
				);
				broadcastAll();
			}
		}

		// ---- connection management --------------------------------------------
		function getRuntime(connId: string | undefined): Runtime {
			const r = st.runtime.get(String(connId));
			if (!r) throw new Error(`Connection does not exist or was closed: ${String(connId)}`);
			return r;
		}

		function dropRuntime(r: Runtime, reason?: string): void {
			if (!st.runtime.has(r.connId)) return;
			st.runtime.delete(r.connId);
			void Promise.resolve(r.adapter?.close?.()).catch(() => {});
			host.sendTo(r.ownerId, { event: "conn_closed", connId: r.connId, reason: reason ?? "" });
			broadcastAll();
		}

		async function openAdapter(cfg: StoredConn): Promise<DbAdapter> {
			const engine = isDbEngine(cfg.type) ? cfg.type : undefined;
			const factory = engine === undefined ? undefined : ADAPTER_FACTORIES[engine];
			if (engine === undefined || !factory) throw new Error(`Unknown database type: ${String(cfg.type)}`);
			await refreshDeps();
			const driver = DRIVER_MODULE[engine];
			if (st.depsAvail?.[driver] === false) {
				throw new Error(
					`Driver ${driver} is not installed - click "Install drivers" in the sidebar, or run npm install ${driver} in the plugin directory`,
				);
			}
			try {
				return await factory(cfg);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/Cannot find|ERR_MODULE_NOT_FOUND/.test(message)) {
					throw new Error(
						`Driver ${driver} is not installed - click "Install drivers" in the sidebar, or run npm install ${driver} in the plugin directory`,
					);
				}
				throw err;
			}
		}

		/** Readiness gate: every message waits for the config read and the driver
		 *  probe, so a state request sent the moment the view mounts cannot read an
		 *  empty list, and a save cannot overwrite a config that was never loaded. */
		let readyPromise: Promise<void> | null = null;
		function ensureReady(): Promise<void> {
			if (!readyPromise) {
				readyPromise = (async () => {
					await loadConfig();
					const ok = await loadDeps();
					broadcastAll();
					if (!ok) installDeps(true);
				})();
			}
			return readyPromise;
		}

		// ------------------------------------------------------------------
		// message routing
		// ------------------------------------------------------------------
		const off = host.onMessage(async (payload, clientId) => {
			await ensureReady();
			const msg = (payload ?? {}) as DbMessage;
			const { action, reqId } = msg;

			try {
				switch (action) {
					case "state": {
						// Driver availability may have changed (a manual install), so
						// probe once more before answering.
						await refreshDeps();
						return void respond(action, reqId, clientId, { state: publicState() });
					}
					case "deps_install":
						installDeps(false);
						return void respond(action, reqId, clientId, {});

					case "conns_save": {
						const c: ConnInput = msg.conn ?? {};
						if (!isDbEngine(c.type)) throw new Error("Please choose a database type");
						if (c.type !== "sqlite" && !String(c.host ?? "").trim()) throw new Error("Host is required");
						if (c.id) {
							const i = st.conns.findIndex((x) => x.id === c.id);
							if (i < 0) throw new Error("Connection does not exist");
							const old = st.conns[i];
							// Password semantics are unchanged: blank keeps the old value, an
							// explicit null clears it (and deletes the secret).
							storeConnSecret(c.id, c.password === null ? null : c.password || undefined);
							st.conns[i] = {
								...old,
								name: c.name ?? old.name,
								type: old.type, // the engine cannot be changed (driver semantics differ too much)
								host: c.type !== "sqlite" ? String(c.host ?? "").trim() : old.host,
								port: Number(c.port) || old.port,
								user: c.user ?? old.user,
								// Blank credentials keep the stored value; an explicit null clears it.
								password: c.password === null ? undefined : c.password || old.password,
								database: c.database ?? old.database,
								file: c.file ?? old.file,
								uri: c.uri === null ? undefined : c.uri || old.uri,
								redisDb: Number.isFinite(Number(c.redisDb)) ? Number(c.redisDb) : old.redisDb,
							};
						} else {
							if (st.conns.length >= MAX_CONNS) throw new Error(`At most ${MAX_CONNS} connections can be saved`);
							const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
							storeConnSecret(id, c.password || undefined);
							st.conns.push({
								id,
								name: String(c.name || `${DB_TYPES[c.type].label} ${String(c.host || c.file || "").trim()}`).trim(),
								type: c.type,
								host: String(c.host ?? "").trim(),
								port: Number(c.port) || DB_TYPES[c.type].port,
								user: c.user ?? "",
								password: c.password ? String(c.password) : undefined,
								database: c.database ?? "",
								file: c.file ?? "",
								uri: c.uri ? String(c.uri).trim() : undefined,
								redisDb: Number(c.redisDb) || 0,
							});
						}
						await saveConfig();
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}

					case "conns_delete": {
						await loadConfig(); // load first when nothing is loaded yet, so no secret is orphaned
						const before = st.conns.length;
						st.conns = st.conns.filter((x) => x.id !== msg.id);
						if (st.conns.length === before) throw new Error("Connection does not exist");
						storeConnSecret(msg.id, null); // the secret goes with the connection
						await saveConfig();
						for (const r of [...st.runtime.values()]) {
							if (r.hostId === msg.id) dropRuntime(r, "connection config deleted");
						}
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}

					case "test": {
						// Form test: a whole conn object (an edit with a blank password
						// reuses the stored one). The form sends raw JSON, so the copy is
						// taken as-is and normalized by the two assignments below; anything
						// still loose is validated by openAdapter().
						const cfg = { ...msg.conn } as StoredConn;
						if (cfg.id) {
							const saved = st.conns.find((x) => x.id === cfg.id);
							if (saved && !cfg.password) cfg.password = saved.password;
							if (saved) cfg.type = saved.type; // the engine cannot be changed
						}
						cfg.port = Number(cfg.port) || (isDbEngine(cfg.type) ? DB_TYPES[cfg.type].port : 0) || 0;
						const adapter = await openAdapter(cfg);
						await adapter.close();
						return void respond(action, reqId, clientId, {});
					}

					case "connect": {
						const cfg = st.conns.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("Connection does not exist");
						for (const r of st.runtime.values()) {
							if (r.hostId === cfg.id) {
								// Already open: reuse it.
								return void respond(action, reqId, clientId, {
									connId: r.connId,
									label: r.label,
									kind: r.adapter.kind,
									dialect: r.adapter.dialect,
								});
							}
						}
						if (st.runtime.size >= MAX_RUNTIME) {
							throw new Error(`At most ${MAX_RUNTIME} connections can be open at once - disconnect one first`);
						}
						const adapter = await openAdapter(cfg);
						const connId = `c${st.nextConnId++}`;
						const r: Runtime = {
							connId,
							ownerId: clientId ?? "",
							hostId: cfg.id,
							label: cfg.name || cfg.host || cfg.file || cfg.type || "",
							adapter,
						};
						st.runtime.set(connId, r);
						broadcastAll();
						return void respond(action, reqId, clientId, {
							connId,
							label: r.label,
							kind: adapter.kind,
							dialect: adapter.dialect,
						});
					}

					case "disconnect": {
						dropRuntime(getRuntime(msg.connId), "disconnected by user");
						return void respond(action, reqId, clientId, {});
					}

					// ---- shared SQL / NoSQL browsing ----
					case "dbs_list": {
						const r = getRuntime(msg.connId);
						return void respond(action, reqId, clientId, {
							databases: await withTimeout(r.adapter.listDatabases(), OP_TIMEOUT_MS, "query"),
						});
					}
					case "tables_list": {
						const r = getRuntime(msg.connId);
						const tables = await withTimeout(r.adapter.listTables(msg.db), OP_TIMEOUT_MS, "query");
						tables.sort((a, b) => a.name.localeCompare(b.name));
						return void respond(action, reqId, clientId, { tables });
					}
					case "describe": {
						const r = getRuntime(msg.connId);
						const d = await withTimeout(r.adapter.describeTable(msg.db, msg.table), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { describe: d });
					}
					case "page": {
						const r = getRuntime(msg.connId);
						const grid = await withTimeout(
							r.adapter.selectPage(msg.db, msg.table, {
								offset: msg.offset,
								limit: msg.limit,
								orderBy: msg.orderBy,
								dir: msg.dir,
								filter: msg.filter,
							}),
							OP_TIMEOUT_MS,
							"query",
						);
						return void respond(action, reqId, clientId, { grid });
					}
					case "query_exec": {
						const r = getRuntime(msg.connId);
						const sql = String(msg.sql ?? "");
						if (!sql.trim()) throw new Error("SQL is empty");
						const grid = await withTimeout(r.adapter.query(msg.db, sql), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { grid });
					}

					// ---- row editing (SQL engines) ----
					case "row_update": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.updateRow) throw new Error("This data source does not support row editing");
						const out = await withTimeout(
							r.adapter.updateRow(msg.db, msg.table, String(msg.pk?.col ?? ""), msg.pk?.val, msg.changes ?? {}),
							OP_TIMEOUT_MS,
							"write",
						);
						return void respond(action, reqId, clientId, out);
					}
					case "row_insert": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.insertRow) throw new Error("This data source does not support inserting rows");
						const out = await withTimeout(
							r.adapter.insertRow(msg.db, msg.table, msg.values ?? {}),
							OP_TIMEOUT_MS,
							"write",
						);
						return void respond(action, reqId, clientId, out);
					}
					case "row_delete": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.deleteRow) throw new Error("This data source does not support deleting rows");
						const out = await withTimeout(
							r.adapter.deleteRow(msg.db, msg.table, String(msg.pk?.col ?? ""), msg.pk?.val),
							OP_TIMEOUT_MS,
							"write",
						);
						return void respond(action, reqId, clientId, out);
					}

					// ---- MongoDB document editing ----
					case "doc_save": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.docSave) throw new Error("This data source does not support document editing");
						const out = await withTimeout(
							r.adapter.docSave(msg.db, msg.table, msg.id, msg.docJson),
							OP_TIMEOUT_MS,
							"write",
						);
						return void respond(action, reqId, clientId, out);
					}
					case "doc_insert": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.docInsert) throw new Error("This data source does not support inserting documents");
						const out = await withTimeout(r.adapter.docInsert(msg.db, msg.table, msg.docJson), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}
					case "doc_delete": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.docDelete) throw new Error("This data source does not support deleting documents");
						const out = await withTimeout(r.adapter.docDelete(msg.db, msg.table, msg.id), OP_TIMEOUT_MS, "write");
						return void respond(action, reqId, clientId, out);
					}

					// ---- Redis only ----
					case "redis_scan": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.scanKeys) throw new Error("This connection is not Redis");
						const out = await withTimeout(
							r.adapter.scanKeys(msg.pattern, msg.cursor, msg.count),
							OP_TIMEOUT_MS,
							"query",
						);
						return void respond(action, reqId, clientId, out);
					}
					case "redis_key": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.keyDetail) throw new Error("This connection is not Redis");
						const detail = await withTimeout(r.adapter.keyDetail(String(msg.key ?? "")), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { detail });
					}
					case "redis_del": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.delKey) throw new Error("This connection is not Redis");
						const n = await withTimeout(r.adapter.delKey(String(msg.key ?? "")), OP_TIMEOUT_MS, "delete");
						return void respond(action, reqId, clientId, { deleted: Number(n) || 0 });
					}
					case "redis_key_set": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.keySet) throw new Error("This connection is not Redis or does not support key editing");
						const out = await withTimeout(
							r.adapter.keySet(String(msg.key ?? ""), String(msg.value ?? "")),
							OP_TIMEOUT_MS,
							"write",
						);
						return void respond(action, reqId, clientId, out);
					}
					case "redis_cmd": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.runCmd) throw new Error("This connection is not Redis");
						const out = await withTimeout(r.adapter.runCmd(String(msg.cmd ?? "")), OP_TIMEOUT_MS, "command");
						return void respond(action, reqId, clientId, { output: cellVal(out) });
					}
					case "redis_meta": {
						const r = getRuntime(msg.connId);
						if (!r.adapter.meta) throw new Error("This connection is not Redis");
						const meta = await withTimeout(r.adapter.meta(), OP_TIMEOUT_MS, "query");
						return void respond(action, reqId, clientId, { meta });
					}

					default:
						return void fail(action, reqId, clientId, `Unknown action: ${action}`);
				}
			} catch (err) {
				fail(action, reqId, clientId, err);
			}
		});

		void ensureReady();

		// Push the full state to a client as it attaches (the server is the only
		// source of truth). host.onAttach does not exist on older hosts, hence the
		// optional call - the client asking for the state remains the fallback.
		const offAttach = host.onAttach?.((clientId) => {
			void ensureReady().then(() => {
				host.sendTo(clientId, { kind: "state", state: publicState() });
			});
		});

		host.log("activated");
		return () => {
			st.dead = true;
			off();
			try {
				offAttach?.();
			} catch {
				/* ignore */
			}
			if (st.installer) {
				// Shutting down or reloading mid-install: kill the child and clear the
				// lock synchronously. Otherwise the leftover stderr pipe keeps the
				// event loop alive and hangs the shutdown, while a hard kill leaves a
				// half-written node_modules behind. With the lock cleared, the next
				// start simply installs again.
				try {
					st.installer.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				st.installer = null;
				st.depsInstalling = false;
				try {
					rmSync(join(host.dir, INSTALL_LOCK), { force: true });
				} catch {
					/* ignore */
				}
			}
			for (const r of st.runtime.values()) {
				try {
					void r.adapter?.close?.();
				} catch {
					/* ignore */
				}
			}
			st.runtime.clear();
		};
	},
};

export default entry;

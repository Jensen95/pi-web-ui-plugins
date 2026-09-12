/**
 * mcp-manager config layer: discovery, precedence, provenance and the write path.
 *
 * The plugin is a front-end over pi-mcp-adapter's config contract, so these tests
 * pin the parts of that contract it has to honour: the six layers in precedence
 * order, per-field merge with the adapter's transport-switch rule, `disabled`
 * resolution, and writes that touch ONLY the project Pi override (.pi/mcp.json).
 *
 * Every test runs against an injected temp root. Nothing here reads or writes the
 * real ~/.config, ~/.agents, ~/.pi or a real project directory.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addServer,
	configLayers,
	listServers,
	projectOverridePath,
	readLayers,
	redactEntry,
	removeServer,
	resolveServers,
	setServerDisabled,
	toClientState,
} from "../../plugins/mcp-manager/src/config.ts";
import type { McpLayerId, McpRoots, McpServerEntry, WriteResult } from "../../plugins/mcp-manager/src/config.ts";

/** Temp tree the injected roots point at, plus the files a test created in it. */
interface Fixture {
	dir: string;
	roots: McpRoots;
}

let fixture: Fixture;
/** Paths chmod-ed away from the owner so a cleanup can restore them. */
let chmodded: string[] = [];

function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "mcp-manager-config-"));
	const roots: McpRoots = {
		home: join(dir, "home"),
		agentDir: join(dir, "pi-agent"),
		projectDir: join(dir, "project"),
	};
	for (const path of [roots.home, roots.agentDir, roots.projectDir]) mkdirSync(path, { recursive: true });
	return { dir, roots };
}

function layerPath(id: McpLayerId): string {
	const layer = configLayers(fixture.roots).find((candidate) => candidate.id === id);
	if (!layer) throw new Error(`no such layer: ${id}`);
	return layer.path;
}

/** Write one config layer as JSON, creating its parent directory. */
function writeLayer(id: McpLayerId, value: unknown): string {
	const path = layerPath(id);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return path;
}

function readLayer(id: McpLayerId): string {
	return readFileSync(layerPath(id), "utf8");
}

/** Repo of every layer file that exists, as path -> bytes, for "unchanged" proofs. */
function snapshotLayers(): Record<string, string> {
	const snapshot: Record<string, string> = {};
	for (const layer of configLayers(fixture.roots)) {
		if (existsSync(layer.path)) snapshot[layer.id] = readFileSync(layer.path, "utf8");
	}
	return snapshot;
}

function lockPath(path: string, mode: number): void {
	chmodSync(path, mode);
	chmodded.push(path);
}

/** Assert a write both succeeded and actually rewrote the file. */
function expectChanged(result: WriteResult): void {
	expect(result, JSON.stringify(result)).toMatchObject({ ok: true, changed: true });
}

beforeEach(() => {
	fixture = makeFixture();
	chmodded = [];
});

afterEach(() => {
	for (const path of chmodded) {
		try {
			chmodSync(path, 0o700);
		} catch {
			// A path that vanished needs no restore.
		}
	}
	rmSync(fixture.dir, { recursive: true, force: true });
});

describe("config layer discovery", () => {
	it("derives the six pi-mcp-adapter layers, lowest precedence first", () => {
		const layers = configLayers(fixture.roots);
		expect(layers.map((layer) => layer.id)).toEqual([
			"shared-global",
			"agents-global",
			"agents-nested-global",
			"pi-global",
			"shared-project",
			"pi-project",
		]);
		expect(layers.map((layer) => layer.path)).toEqual([
			join(fixture.roots.home, ".config", "mcp", "mcp.json"),
			join(fixture.roots.home, ".agents", "mcp.json"),
			join(fixture.roots.home, ".agents", "mcp", "mcp.json"),
			join(fixture.roots.agentDir, "mcp.json"),
			join(fixture.roots.projectDir, ".mcp.json"),
			join(fixture.roots.projectDir, ".pi", "mcp.json"),
		]);
		expect(layers.map((layer) => layer.scope)).toEqual(["global", "global", "global", "global", "project", "project"]);
	});

	it("marks exactly the project Pi override as writable", () => {
		const layers = configLayers(fixture.roots);
		expect(layers.filter((layer) => layer.writable).map((layer) => layer.id)).toEqual(["pi-project"]);
		expect(layers.filter((layer) => layer.piOwned).map((layer) => layer.id)).toEqual(["pi-global", "pi-project"]);
		expect(projectOverridePath(fixture.roots)).toBe(layerPath("pi-project"));
	});

	it("reports a missing layer as absent rather than an error", () => {
		const states = readLayers(fixture.roots);
		expect(states).toHaveLength(6);
		for (const state of states) {
			expect(state.exists, `${state.layer.id} should not exist`).toBe(false);
			expect(state.servers).toEqual({});
			expect(state.error).toBeUndefined();
		}
	});

	it("resolves no servers at all when nothing is configured", () => {
		expect(listServers(fixture.roots)).toEqual([]);
	});
});

describe("precedence merge", () => {
	it("lets the highest layer that defines a server win", () => {
		writeLayer("shared-global", { mcpServers: { deep: { url: "https://global.example/mcp" } } });
		writeLayer("shared-project", { mcpServers: { deep: { url: "https://project.example/mcp" } } });

		const servers = listServers(fixture.roots);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("deep");
		expect(servers[0]?.entry.url).toBe("https://project.example/mcp");
		expect(servers[0]?.source.id).toBe("shared-project");
		expect(servers[0]?.layers).toEqual(["shared-global", "shared-project"]);
	});

	it("honours the full six-layer order, pi-project last", () => {
		const ids: McpLayerId[] = [
			"shared-global",
			"agents-global",
			"agents-nested-global",
			"pi-global",
			"shared-project",
			"pi-project",
		];
		ids.forEach((id, index) => writeLayer(id, { mcpServers: { shared: { url: `https://${index}.example/mcp` } } }));

		const servers = listServers(fixture.roots);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.entry.url).toBe("https://5.example/mcp");
		expect(servers[0]?.source.id).toBe("pi-project");
		expect(servers[0]?.layers).toEqual(ids);
	});

	it("merges per field, so a higher layer only replaces what it sets", () => {
		writeLayer("pi-global", {
			mcpServers: { local: { command: "node", args: ["server.js"], env: { LOG: "1" }, lifecycle: "lazy" } },
		});
		writeLayer("shared-project", { mcpServers: { local: { args: ["other.js"] } } });

		const entry = listServers(fixture.roots)[0]?.entry;
		expect(entry?.command).toBe("node");
		expect(entry?.args).toEqual(["other.js"]);
		expect(entry?.env).toEqual({ LOG: "1" });
		expect(entry?.lifecycle).toBe("lazy");
	});

	it("drops stdio fields when a higher layer repoints a server at a url", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "npx", args: ["-y", "svc"], env: { K: "v" } } } });
		writeLayer("shared-project", { mcpServers: { svc: { url: "https://svc.example/mcp" } } });

		const entry = listServers(fixture.roots)[0]?.entry;
		expect(entry).toEqual({ url: "https://svc.example/mcp" });
	});

	it("drops http fields when a higher layer turns a url server into a command", () => {
		writeLayer("shared-global", {
			mcpServers: { svc: { url: "https://svc.example/mcp", headers: { Authorization: "Bearer x" } } },
		});
		writeLayer("pi-project", { mcpServers: { svc: { command: "svc-mcp" } } });

		expect(listServers(fixture.roots)[0]?.entry).toEqual({ command: "svc-mcp" });
	});

	it("drops url-bound credentials when a higher layer changes the url", () => {
		writeLayer("shared-global", {
			mcpServers: { svc: { url: "https://old.example/mcp", headers: { "X-Key": "k" }, bearerToken: "t" } },
		});
		writeLayer("shared-project", { mcpServers: { svc: { url: "https://new.example/mcp" } } });

		expect(listServers(fixture.roots)[0]?.entry).toEqual({ url: "https://new.example/mcp" });
	});

	it("keeps servers that only exist in one layer", () => {
		writeLayer("agents-global", { mcpServers: { a: { command: "a" }, b: { command: "b" } } });
		writeLayer("shared-project", { mcpServers: { c: { url: "https://c.example/mcp" } } });

		const servers = listServers(fixture.roots);
		expect(servers.map((server) => server.name).sort()).toEqual(["a", "b", "c"]);
		expect(servers.find((server) => server.name === "a")?.source.id).toBe("agents-global");
		expect(servers.find((server) => server.name === "c")?.source.id).toBe("shared-project");
	});

	it("reads the mcp-servers spelling the adapter also accepts", () => {
		writeLayer("shared-global", { "mcp-servers": { legacy: { command: "legacy-mcp" } } });
		expect(listServers(fixture.roots).map((server) => server.name)).toEqual(["legacy"]);
	});
});

describe("disabled resolution", () => {
	it("treats a server with no disabled field as enabled", () => {
		writeLayer("shared-project", { mcpServers: { on: { command: "on" } } });
		expect(listServers(fixture.roots)[0]?.disabled).toBe(false);
	});

	it("treats only the literal true as disabled", () => {
		writeLayer("shared-project", {
			mcpServers: {
				off: { command: "off", disabled: true },
				zero: { command: "zero", disabled: "true" },
				nulled: { command: "nulled", disabled: null },
			},
		});
		const byName = Object.fromEntries(listServers(fixture.roots).map((server) => [server.name, server.disabled]));
		expect(byName).toEqual({ off: true, zero: false, nulled: false });
	});

	it("re-enables a lower layer's disabled server through the project override", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc", disabled: true } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: false } } });

		const server = listServers(fixture.roots)[0];
		expect(server?.disabled).toBe(false);
		expect(server?.entry.command).toBe("svc");
		expect(server?.source.id).toBe("pi-project");
	});

	it("lets a lower layer disable a server defined higher up", () => {
		writeLayer("shared-project", { mcpServers: { svc: { command: "svc" } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true } } });

		const server = listServers(fixture.roots)[0];
		expect(server?.disabled).toBe(true);
		expect(server?.entry.command).toBe("svc");
	});
});

describe("unusable config files", () => {
	it("skips a layer whose JSON is malformed and reports why", () => {
		writeLayer("shared-global", { mcpServers: { good: { command: "good" } } });
		writeLayer("shared-project", "{ this is not json");

		const states = readLayers(fixture.roots);
		const broken = states.find((state) => state.layer.id === "shared-project");
		expect(broken?.exists).toBe(true);
		expect(broken?.servers).toEqual({});
		expect(broken?.error?.message.length ?? 0).toBeGreaterThan(0);

		// The readable layers still resolve: one broken file must not blank the view.
		expect(listServers(fixture.roots).map((server) => server.name)).toEqual(["good"]);
	});

	it("reports an unreadable layer as an error without throwing", () => {
		const path = writeLayer("pi-global", { mcpServers: { locked: { command: "locked" } } });
		lockPath(path, 0o000);

		const state = readLayers(fixture.roots).find((candidate) => candidate.layer.id === "pi-global");
		expect(state?.exists).toBe(true);
		expect(state?.servers).toEqual({});
		expect(state?.error?.code).toBe("EACCES");
		expect(listServers(fixture.roots)).toEqual([]);
	});

	it("ignores an mcpServers value that is not an object", () => {
		writeLayer("shared-global", { mcpServers: ["not", "an", "object"] });
		writeLayer("agents-global", { mcpServers: "nope" });
		writeLayer("pi-global", {});
		expect(listServers(fixture.roots)).toEqual([]);
	});

	it("ignores a server entry that is not an object", () => {
		writeLayer("shared-global", { mcpServers: { bad: "command", good: { command: "good" } } });
		expect(listServers(fixture.roots).map((server) => server.name)).toEqual(["good"]);
	});

	it("treats a non-object document root as an empty config", () => {
		writeLayer("shared-global", "[1,2,3]");
		writeLayer("agents-global", { mcpServers: { kept: { command: "kept" } } });
		expect(listServers(fixture.roots).map((server) => server.name)).toEqual(["kept"]);
	});
});

describe("setServerDisabled write path", () => {
	it("creates .pi/mcp.json with only the disabled key", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc", env: { TOKEN: "secret" } } } });

		const result = setServerDisabled(fixture.roots, "svc", true);
		expect(result).toEqual({ ok: true, path: layerPath("pi-project"), changed: true });
		expect(JSON.parse(readLayer("pi-project"))).toEqual({ mcpServers: { svc: { disabled: true } } });
	});

	it("never rewrites the file a server came from", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" }, other: { url: "https://o.example" } } });
		writeLayer("agents-global", { mcpServers: { svc: { args: ["--x"] } } });
		writeLayer("pi-global", { mcpServers: { third: { command: "third" } } });
		writeLayer("shared-project", { mcpServers: { svc: { env: { A: "1" } } } });
		const before = snapshotLayers();

		expect(setServerDisabled(fixture.roots, "svc", true).ok).toBe(true);
		expect(setServerDisabled(fixture.roots, "third", true).ok).toBe(true);

		const after = snapshotLayers();
		for (const id of ["shared-global", "agents-global", "pi-global", "shared-project"]) {
			expect(after[id], `${id} must be byte-identical`).toBe(before[id]);
		}
		expect(JSON.parse(after["pi-project"] ?? "{}")).toEqual({
			mcpServers: { svc: { disabled: true }, third: { disabled: true } },
		});
	});

	it("preserves unrelated keys already in .pi/mcp.json", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc", disabled: true } } });
		writeLayer("pi-project", {
			imports: ["cursor"],
			settings: { toolPrefix: "auto" },
			mcpServers: { mine: { command: "mine-mcp", args: ["--flag"] }, svc: { directTools: true } },
		});
		const before = readLayer("pi-project");

		expectChanged(setServerDisabled(fixture.roots, "svc", true));
		const raw = JSON.parse(readLayer("pi-project")) as Record<string, unknown>;
		expect(raw.imports).toEqual(["cursor"]);
		expect(raw.settings).toEqual({ toolPrefix: "auto" });
		expect(raw.mcpServers).toEqual({
			mine: { command: "mine-mcp", args: ["--flag"] },
			svc: { directTools: true, disabled: true },
		});
		expect(readLayer("pi-project")).not.toBe(before);
	});

	it("writes an explicit false when a lower layer is disabled", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc", disabled: true } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true } } });

		expectChanged(setServerDisabled(fixture.roots, "svc", false));
		expect(JSON.parse(readLayer("pi-project"))).toEqual({ mcpServers: { svc: { disabled: false } } });
		expect(listServers(fixture.roots)[0]?.disabled).toBe(false);
	});

	it("removes the project flag entirely when no lower layer is disabled", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true } } });

		expectChanged(setServerDisabled(fixture.roots, "svc", false));
		expect(JSON.parse(readLayer("pi-project"))).toEqual({ mcpServers: {} });
		expect(listServers(fixture.roots)[0]?.disabled).toBe(false);
	});

	it("keeps the sibling fields of an override entry when the flag is removed", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true, directTools: ["search"] } } });

		expectChanged(setServerDisabled(fixture.roots, "svc", false));
		expect(JSON.parse(readLayer("pi-project"))).toEqual({ mcpServers: { svc: { directTools: ["search"] } } });
	});

	it("reports no change when the flag already matches", () => {
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true } } });
		const before = readLayer("pi-project");

		expect(setServerDisabled(fixture.roots, "svc", true)).toEqual({
			ok: true,
			path: layerPath("pi-project"),
			changed: false,
		});
		expect(readLayer("pi-project")).toBe(before);
	});

	it("does not create a file for a server nothing defines", () => {
		const result = setServerDisabled(fixture.roots, "ghost", false);
		expect(result).toEqual({ ok: true, path: layerPath("pi-project"), changed: false });
		expect(existsSync(layerPath("pi-project"))).toBe(false);
	});

	it("writes through the mcp-servers key when the file already uses it", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		writeLayer("pi-project", { "mcp-servers": { kept: { disabled: true } } });

		expectChanged(setServerDisabled(fixture.roots, "svc", true));
		const raw = JSON.parse(readLayer("pi-project")) as Record<string, unknown>;
		expect(Object.keys(raw)).toEqual(["mcp-servers"]);
		expect(raw["mcp-servers"]).toEqual({ kept: { disabled: true }, svc: { disabled: true } });
	});

	it("accepts awkward but legal server names", () => {
		writeLayer("shared-global", {
			mcpServers: { " spaced name ": { command: "a" }, "UPPER_case-1": { command: "b" }, "a.b/c": { command: "c" } },
		});

		for (const name of [" spaced name ", "UPPER_case-1", "a.b/c"]) {
			expectChanged(setServerDisabled(fixture.roots, name, true));
			expect(listServers(fixture.roots).find((server) => server.name === name)?.disabled, name).toBe(true);
		}
		expect(Object.keys((JSON.parse(readLayer("pi-project")) as { mcpServers: object }).mcpServers).sort()).toEqual(
			[" spaced name ", "UPPER_case-1", "a.b/c"].sort(),
		);
	});

	it("refuses prototype-polluting names instead of writing them", () => {
		for (const name of ["__proto__", "constructor", "prototype"]) {
			const result = setServerDisabled(fixture.roots, name, true);
			expect(result.ok, name).toBe(false);
			if (result.ok) continue;
			expect(result.code, name).toBe("invalid-name");
		}
		expect(existsSync(layerPath("pi-project"))).toBe(false);
		// A server literally named __proto__ in a lower layer is still listed, read-only.
		writeLayer("shared-global", JSON.parse('{"mcpServers":{"__proto__":{"command":"x"}}}'));
		expect(listServers(fixture.roots).map((server) => server.name)).toEqual(["__proto__"]);
	});

	it("refuses an empty or non-string name", () => {
		for (const name of ["", "   "]) {
			const result = setServerDisabled(fixture.roots, name, true);
			expect(result.ok, JSON.stringify(name)).toBe(false);
		}
		const result = setServerDisabled(fixture.roots, 42 as unknown as string, true);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid-name");
	});

	it("returns a typed error, and writes nothing, when .pi/mcp.json is malformed", () => {
		writeLayer("pi-project", "{ broken");
		const before = readLayer("pi-project");

		const result = setServerDisabled(fixture.roots, "svc", true);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("read-failed");
		expect(result.message).toContain(layerPath("pi-project"));
		expect(readLayer("pi-project")).toBe(before);
	});

	it("returns a typed error when .pi/mcp.json holds non-object junk", () => {
		for (const junk of ["[]", '"a string"', "42", "null"]) {
			writeLayer("pi-project", junk);
			const result = setServerDisabled(fixture.roots, "svc", true);
			expect(result.ok, junk).toBe(false);
			if (result.ok) continue;
			expect(result.code, junk).toBe("invalid-config");
			expect(readLayer("pi-project"), `${junk} must be left alone`).toBe(
				typeof junk === "string" && junk.startsWith("[") ? "[]" : junk,
			);
		}
	});

	it("returns a typed error when an existing server entry is not an object", () => {
		writeLayer("pi-project", { mcpServers: { svc: "command-string" } });
		const result = setServerDisabled(fixture.roots, "svc", true);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid-config");
	});

	it("reports a write failure when the project directory is read-only", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		lockPath(fixture.roots.projectDir, 0o500);

		const result = setServerDisabled(fixture.roots, "svc", true);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("write-failed");
		expect(result.message.length).toBeGreaterThan(0);
		expect(existsSync(layerPath("pi-project"))).toBe(false);
	});

	it("reports a write failure when the override directory is read-only", () => {
		const path = writeLayer("pi-project", { mcpServers: {} });
		const before = readLayer("pi-project");
		lockPath(dirname(path), 0o500);

		const result = setServerDisabled(fixture.roots, "svc", true);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("write-failed");
		expect(readLayer("pi-project")).toBe(before);
	});

	it("leaves no temporary file behind after a successful write", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		expect(setServerDisabled(fixture.roots, "svc", true).ok).toBe(true);
		expect(readdirSync(dirname(layerPath("pi-project")))).toEqual(["mcp.json"]);
	});
});

describe("addServer / removeServer round trip", () => {
	it("adds a command server and reads it back as effective", () => {
		const entry: McpServerEntry = { command: "npx", args: ["-y", "some-mcp"], env: { KEY: "value" } };
		const result = addServer(fixture.roots, "added", entry);
		expect(result).toEqual({ ok: true, path: layerPath("pi-project"), changed: true });

		const servers = listServers(fixture.roots);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("added");
		expect(servers[0]?.entry).toEqual(entry);
		expect(servers[0]?.source.id).toBe("pi-project");
		expect(servers[0]?.disabled).toBe(false);
	});

	it("adds a url server", () => {
		expect(addServer(fixture.roots, "remote", { url: "https://remote.example/mcp" }).ok).toBe(true);
		expect(listServers(fixture.roots)[0]?.entry).toEqual({ url: "https://remote.example/mcp" });
	});

	it("keeps the other servers and top-level keys when adding", () => {
		writeLayer("pi-project", { imports: ["cursor"], mcpServers: { first: { command: "first" } } });
		expectChanged(addServer(fixture.roots, "second", { command: "second" }));

		const raw = JSON.parse(readLayer("pi-project")) as { imports: string[]; mcpServers: object };
		expect(raw.imports).toEqual(["cursor"]);
		expect(raw.mcpServers).toEqual({ first: { command: "first" }, second: { command: "second" } });
	});

	it("replaces an existing server of the same name", () => {
		expect(addServer(fixture.roots, "svc", { command: "one" }).ok).toBe(true);
		expectChanged(addServer(fixture.roots, "svc", { command: "two", args: ["--x"] }));
		expect(listServers(fixture.roots)[0]?.entry).toEqual({ command: "two", args: ["--x"] });
	});

	it("rejects a definition with neither command nor url", () => {
		for (const entry of [{}, { args: ["x"] }, { command: "  " }, { env: { A: "1" } }]) {
			const result = addServer(fixture.roots, "svc", entry);
			expect(result.ok, JSON.stringify(entry)).toBe(false);
			if (result.ok) continue;
			expect(result.code, JSON.stringify(entry)).toBe("invalid-entry");
		}
		expect(existsSync(layerPath("pi-project"))).toBe(false);
	});

	it("rejects a non-string command or url", () => {
		const result = addServer(fixture.roots, "svc", { command: 12 as unknown as string });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid-entry");
	});

	it("rejects an invalid name the same way the toggle does", () => {
		expect(addServer(fixture.roots, "__proto__", { command: "x" }).ok).toBe(false);
		expect(addServer(fixture.roots, "", { command: "x" }).ok).toBe(false);
	});

	it("removes a server this plugin added", () => {
		expect(addServer(fixture.roots, "svc", { command: "svc" }).ok).toBe(true);
		expect(removeServer(fixture.roots, "svc")).toEqual({ ok: true, path: layerPath("pi-project"), changed: true });
		expect(listServers(fixture.roots)).toEqual([]);
		expect(JSON.parse(readLayer("pi-project"))).toEqual({ mcpServers: {} });
	});

	it("reports no change when the name is not in the project override", () => {
		writeLayer("shared-global", { mcpServers: { elsewhere: { command: "elsewhere" } } });
		expect(removeServer(fixture.roots, "elsewhere")).toEqual({
			ok: true,
			path: layerPath("pi-project"),
			changed: false,
		});
		// Removing must not reach into the layer the server actually came from.
		expect(JSON.parse(readLayer("shared-global"))).toEqual({ mcpServers: { elsewhere: { command: "elsewhere" } } });
		expect(listServers(fixture.roots).map((server) => server.name)).toEqual(["elsewhere"]);
	});

	it("keeps sibling servers when removing one", () => {
		writeLayer("pi-project", { mcpServers: { keep: { command: "keep" }, drop: { command: "drop" } } });
		expectChanged(removeServer(fixture.roots, "drop"));
		expect(JSON.parse(readLayer("pi-project"))).toEqual({ mcpServers: { keep: { command: "keep" } } });
	});

	it("survives an add -> disable -> enable -> remove cycle", () => {
		expect(addServer(fixture.roots, "svc", { command: "svc" }).ok).toBe(true);
		expect(setServerDisabled(fixture.roots, "svc", true).ok).toBe(true);
		expect(listServers(fixture.roots)[0]?.disabled).toBe(true);
		expect(setServerDisabled(fixture.roots, "svc", false).ok).toBe(true);
		expect(listServers(fixture.roots)[0]?.disabled).toBe(false);
		expect(removeServer(fixture.roots, "svc").ok).toBe(true);
		expect(listServers(fixture.roots)).toEqual([]);
	});
});

describe("resolveServers over pre-read states", () => {
	it("is pure: the same states always give the same servers", () => {
		writeLayer("shared-global", { mcpServers: { a: { command: "a" } } });
		writeLayer("pi-project", { mcpServers: { a: { disabled: true }, b: { url: "https://b.example" } } });
		const states = readLayers(fixture.roots);

		const first = resolveServers(states);
		const second = resolveServers(states);
		expect(second).toEqual(first);
		expect(first.map((server) => server.name)).toEqual(["a", "b"]);
		// The input states are not mutated by resolving.
		expect(states.find((state) => state.layer.id === "pi-project")?.servers).toEqual({
			a: { disabled: true },
			b: { url: "https://b.example" },
		});
	});
});

describe("redaction", () => {
	it("masks env values but keeps the variable names", () => {
		const redacted = redactEntry({ command: "svc", env: { API_KEY: "sk-live-123", EMPTY: "" } });
		expect(redacted.command).toBe("svc");
		expect(Object.keys(redacted.env ?? {})).toEqual(["API_KEY", "EMPTY"]);
		expect(Object.values(redacted.env ?? {})).toEqual(["***", "***"]);
	});

	it("masks header values, bearer tokens and oauth client secrets", () => {
		const redacted = redactEntry({
			url: "https://svc.example/mcp",
			headers: { Authorization: "Bearer abc123" },
			bearerToken: "abc123",
			bearerTokenEnv: "SVC_TOKEN",
			oauth: { clientId: "public-id", clientSecret: "shh" },
		});
		expect(redacted.url).toBe("https://svc.example/mcp");
		expect(redacted.headers).toEqual({ Authorization: "***" });
		expect(redacted.bearerToken).toBe("***");
		// A variable NAME is not a secret; only values are masked.
		expect(redacted.bearerTokenEnv).toBe("SVC_TOKEN");
		expect(redacted.oauth).toEqual({ clientId: "public-id", clientSecret: "***" });
	});

	it("leaves a definition without secrets untouched", () => {
		const entry: McpServerEntry = { command: "npx", args: ["-y", "mcp"], disabled: true };
		expect(redactEntry(entry)).toEqual(entry);
	});

	it("does not mutate the entry it was given", () => {
		const entry: McpServerEntry = { command: "svc", env: { K: "v" } };
		redactEntry(entry);
		expect(entry.env).toEqual({ K: "v" });
	});
});

describe("client state", () => {
	it("reports layers, provenance and masked definitions in one payload", () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc", env: { TOKEN: "super-secret" } } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true }, mine: { url: "https://mine.example" } } });

		const state = toClientState(fixture.roots);
		expect(state.projectOverridePath).toBe(layerPath("pi-project"));
		expect(state.layers).toHaveLength(6);
		expect(state.layers.map((layer) => layer.exists)).toEqual([true, false, false, false, false, true]);
		expect(state.layers.map((layer) => layer.serverCount)).toEqual([1, 0, 0, 0, 0, 2]);
		expect(state.layers.find((layer) => layer.id === "shared-project")?.error).toBeUndefined();

		expect(state.servers.map((server) => server.name).sort()).toEqual(["mine", "svc"]);
		const svc = state.servers.find((server) => server.name === "svc");
		expect(svc?.disabled).toBe(true);
		expect(svc?.source).toMatchObject({ id: "pi-project", writable: true });
		expect(svc?.layers).toEqual(["shared-global", "pi-project"]);
		expect(svc?.entry.command).toBe("svc");
		expect(JSON.stringify(state)).not.toContain("super-secret");
		expect(JSON.stringify(state)).toContain("TOKEN");

		const mine = state.servers.find((server) => server.name === "mine");
		expect(mine?.disabled).toBe(false);
		expect(mine?.source).toMatchObject({ id: "pi-project", writable: true });
	});

	it("carries a layer's parse error into the payload", () => {
		writeLayer("shared-project", "{ nope");
		const layer = toClientState(fixture.roots).layers.find((candidate) => candidate.id === "shared-project");
		expect(layer?.exists).toBe(true);
		expect(layer?.serverCount).toBe(0);
		expect(layer?.error?.message.length ?? 0).toBeGreaterThan(0);
	});
});

/**
 * mcp-manager as a pi-web-ui plugin: manifest contract, the activate(host)
 * message protocol, secret redaction on the wire, and the TypeScript -> .mjs
 * build the host actually loads.
 *
 * The message tests drive the plugin through the mock host's public surface
 * (emit.message -> recorded.sent) with an injected temp config root, so they
 * exercise the real handler without touching the developer's home directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activatePlugin, createMockHost } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import { buildPlugin } from "../helpers/plugin-build";
import {
	importClientArtifact,
	importServerArtifact,
	isClientEntry,
	isServerEntry,
	loadPlugin,
} from "../helpers/plugin-contract";
import { isGitIgnored, repoPath } from "../helpers/repo-files";
import { createEntry } from "../../plugins/mcp-manager/src/index.ts";
import defaultEntry from "../../plugins/mcp-manager/src/index.ts";
import type { McpRoots } from "../../plugins/mcp-manager/src/config.ts";

/** Downstream payload shapes the plugin promises its view. */
interface StatePayload {
	type: "state";
	state: {
		projectOverridePath: string;
		layers: { id: string; path: string; exists: boolean; serverCount: number }[];
		servers: {
			name: string;
			entry: Record<string, unknown>;
			disabled: boolean;
			source: { id: string; path: string; writable: boolean };
		}[];
	};
}

interface ErrorPayload {
	type: "error";
	action: string;
	code: string;
	message: string;
}

type Payload = StatePayload | ErrorPayload;

const PLUGIN_ID = "mcp-manager";

let dir: string;
let roots: McpRoots;

/** A fresh temp root per test: the message handlers write real files, so state
 *  must not leak from one case into the next. */
function freshRoots(): void {
	dir = mkdtempSync(join(tmpdir(), "mcp-manager-plugin-"));
	roots = { home: join(dir, "home"), agentDir: join(dir, "pi-agent"), projectDir: join(dir, "project") };
	for (const path of [roots.home, roots.agentDir, roots.projectDir]) mkdirSync(path, { recursive: true });
}

function writeLayer(id: "shared-global" | "shared-project" | "pi-project", value: unknown): string {
	const path =
		id === "shared-global"
			? join(roots.home, ".config", "mcp", "mcp.json")
			: id === "shared-project"
				? join(roots.projectDir, ".mcp.json")
				: join(roots.projectDir, ".pi", "mcp.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return path;
}

/** A mock host wired to the temp root, with the plugin already activated. The
 *  injected resolver still follows host.cwd, exactly like the real default. */
async function activated(): Promise<{ host: MockHost; deactivate: () => void }> {
	const entry = createEntry((host) => ({ ...roots, projectDir: host.cwd }));
	const { host, deactivate } = await activatePlugin(entry, { cwd: roots.projectDir, permissions: ["fs"] });
	return { host, deactivate: deactivate ?? (() => {}) };
}

/** Send one upstream message and collect everything the plugin sent back. */
async function dispatch(host: MockHost, payload: unknown, from = "client-1"): Promise<Payload[]> {
	host.recorded.sent.length = 0;
	host.recorded.broadcasts.length = 0;
	await host.emit.message(payload, from);
	return [...host.recorded.sent.map((sent) => sent.payload), ...host.recorded.broadcasts] as Payload[];
}

function onlyState(payloads: Payload[]): StatePayload {
	expect(payloads).toHaveLength(1);
	const payload = payloads[0];
	expect(payload?.type, JSON.stringify(payload)).toBe("state");
	return payload as StatePayload;
}

function onlyError(payloads: Payload[]): ErrorPayload {
	expect(payloads).toHaveLength(1);
	const payload = payloads[0];
	expect(payload?.type, JSON.stringify(payload)).toBe("error");
	return payload as ErrorPayload;
}

beforeEach(freshRoots);

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("manifest", () => {
	const plugin = loadPlugin(PLUGIN_ID);

	it("declares the id, name and version the host reads", () => {
		expect(plugin.id).toBe(PLUGIN_ID);
		expect(plugin.manifest.name.trim().length).toBeGreaterThan(0);
		expect(plugin.manifest.version).toBe("0.1.0");
		expect(plugin.manifest.description?.trim().length ?? 0).toBeGreaterThan(0);
		expect(plugin.manifest.icon?.trim().length ?? 0).toBeGreaterThan(0);
	});

	it("puts English in description and carries no descriptionEn key", () => {
		expect(Object.keys(plugin.raw)).not.toContain("descriptionEn");
		expect(plugin.manifest.description).toMatch(/[A-Za-z]{3}/);
	});

	it("declares the fs capability it needs and nothing it does not use", () => {
		expect(plugin.manifest.permissions).toContain("fs");
		// registerAgentTool needs "tools" and host.route needs "http"; this plugin
		// uses neither, and an undeclared family is denied at runtime.
		expect(plugin.manifest.permissions).not.toContain("tools");
		expect(plugin.manifest.permissions).not.toContain("http");
	});

	it("is a view plugin with no fence renderers", () => {
		expect(plugin.manifest.view ?? true).toBe(true);
		expect(plugin.manifest.renderers).toBeUndefined();
	});

	it("ships an English README that credits the adapter and warns about /reload", () => {
		const readme = readFileSync(repoPath("plugins", PLUGIN_ID, "README.md"), "utf8");
		expect(readme).toContain("pi-mcp-adapter");
		expect(readme).toContain("/reload");
		expect(readme).toContain(".pi/mcp.json");
	});
});

describe("activate(host)", () => {
	it("registers a message handler and removes it on deactivate", async () => {
		const { host, deactivate } = await activated();
		expect(host.recorded.handlers.message.size).toBe(1);
		deactivate();
		expect(host.recorded.handlers.message.size).toBe(0);
	});

	it("registers no agent tool, route or background task", async () => {
		const { host, deactivate } = await activated();
		expect(host.recorded.agentTools.size).toBe(0);
		expect(host.recorded.routes.size).toBe(0);
		expect(host.recorded.backgroundTasks.size).toBe(0);
		expect(host.recorded.ensureDepsCalls).toEqual([]);
		deactivate();
	});

	it("does not read or write any config file while activating", async () => {
		const { host, deactivate } = await activated();
		deactivate();
		expect(existsSync(join(roots.projectDir, ".pi"))).toBe(false);
		expect(host.recorded.rejections).toEqual([]);
	});
});

describe("list action", () => {
	it("returns the effective servers with provenance", async () => {
		writeLayer("shared-global", { mcpServers: { global: { command: "global-mcp" } } });
		writeLayer("pi-project", { mcpServers: { global: { disabled: true }, local: { url: "https://local.example" } } });
		const { host, deactivate } = await activated();

		const state = onlyState(await dispatch(host, { action: "list" })).state;
		expect(state.projectOverridePath).toBe(join(roots.projectDir, ".pi", "mcp.json"));
		expect(state.servers.map((server) => server.name).sort()).toEqual(["global", "local"]);

		const global = state.servers.find((server) => server.name === "global");
		expect(global?.disabled).toBe(true);
		expect(global?.entry.command).toBe("global-mcp");
		expect(global?.source.id).toBe("pi-project");
		expect(global?.source.writable).toBe(true);

		const local = state.servers.find((server) => server.name === "local");
		expect(local?.disabled).toBe(false);
		expect(local?.entry.url).toBe("https://local.example");
		deactivate();
	});

	it("reports an empty server list when nothing is configured", async () => {
		const { host, deactivate } = await activated();
		const state = onlyState(await dispatch(host, { action: "list" })).state;
		expect(state.servers).toEqual([]);
		expect(state.layers).toHaveLength(6);
		expect(state.layers.every((layer) => layer.exists)).toBe(false);
		deactivate();
	});

	it("answers the sender rather than broadcasting to every client", async () => {
		const { host, deactivate } = await activated();
		await host.emit.message({ action: "list" }, "client-42");
		expect(host.recorded.sent.map((sent) => sent.clientId)).toEqual(["client-42"]);
		expect(host.recorded.broadcasts).toEqual([]);
		deactivate();
	});

	it("broadcasts when the host gives no client id", async () => {
		const { host, deactivate } = await activated();
		await host.emit.message({ action: "list" });
		expect(host.recorded.sent).toEqual([]);
		expect(host.recorded.broadcasts).toHaveLength(1);
		deactivate();
	});

	it("follows the live workspace root", async () => {
		writeLayer("pi-project", { mcpServers: { here: { command: "here" } } });
		const entry = createEntry((host) => ({ ...roots, projectDir: host.cwd }));
		const host = createMockHost({ cwd: roots.projectDir, permissions: ["fs"] });
		await entry.activate(host);

		const moved = join(dir, "other-project");
		mkdirSync(moved, { recursive: true });
		await host.emit.notifyCwd(moved);
		const state = onlyState(await dispatch(host, { action: "list" })).state;
		expect(state.servers).toEqual([]);
		expect(state.projectOverridePath).toBe(join(moved, ".pi", "mcp.json"));
	});
});

describe("toggle action", () => {
	it("disables a server through the project override and returns fresh state", async () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		const { host, deactivate } = await activated();

		const state = onlyState(await dispatch(host, { action: "toggle", name: "svc", disabled: true })).state;
		expect(state.servers.find((server) => server.name === "svc")?.disabled).toBe(true);
		expect(JSON.parse(readFileSync(join(roots.projectDir, ".pi", "mcp.json"), "utf8"))).toEqual({
			mcpServers: { svc: { disabled: true } },
		});
		// The layer the definition came from is untouched.
		expect(JSON.parse(readFileSync(join(roots.home, ".config", "mcp", "mcp.json"), "utf8"))).toEqual({
			mcpServers: { svc: { command: "svc" } },
		});
		deactivate();
	});

	it("re-enables a server", async () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		writeLayer("pi-project", { mcpServers: { svc: { disabled: true } } });
		const { host, deactivate } = await activated();

		const state = onlyState(await dispatch(host, { action: "toggle", name: "svc", disabled: false })).state;
		expect(state.servers.find((server) => server.name === "svc")?.disabled).toBe(false);
		deactivate();
	});

	it("coerces a missing disabled flag to a disable, not an enable", async () => {
		writeLayer("shared-global", { mcpServers: { svc: { command: "svc" } } });
		const { host, deactivate } = await activated();

		onlyState(await dispatch(host, { action: "toggle", name: "svc" }));
		expect(JSON.parse(readFileSync(join(roots.projectDir, ".pi", "mcp.json"), "utf8"))).toEqual({
			mcpServers: { svc: { disabled: true } },
		});
		deactivate();
	});

	it("reports a write failure as an error payload instead of throwing", async () => {
		writeLayer("pi-project", "{ broken json");
		const { host, deactivate } = await activated();

		const error = onlyError(await dispatch(host, { action: "toggle", name: "svc", disabled: true }));
		expect(error.action).toBe("toggle");
		expect(error.code).toBe("read-failed");
		expect(error.message).toContain("mcp.json");
		deactivate();
	});

	it("rejects a toggle without a usable name", async () => {
		const { host, deactivate } = await activated();
		const error = onlyError(await dispatch(host, { action: "toggle", disabled: true }));
		expect(error.code).toBe("invalid-name");
		deactivate();
	});
});

describe("add and remove actions", () => {
	it("adds a server from a client payload", async () => {
		const { host, deactivate } = await activated();
		const state = onlyState(
			await dispatch(host, {
				action: "add",
				name: "added",
				entry: { command: "npx", args: ["-y", "some-mcp"], env: { KEY: "value" } },
			}),
		).state;

		expect(state.servers.map((server) => server.name)).toEqual(["added"]);
		expect(JSON.parse(readFileSync(join(roots.projectDir, ".pi", "mcp.json"), "utf8"))).toEqual({
			mcpServers: { added: { command: "npx", args: ["-y", "some-mcp"], env: { KEY: "value" } } },
		});
		deactivate();
	});

	it("adds a url server", async () => {
		const { host, deactivate } = await activated();
		const state = onlyState(
			await dispatch(host, { action: "add", name: "remote", entry: { url: "https://remote.example/mcp" } }),
		).state;
		expect(state.servers.find((server) => server.name === "remote")?.entry.url).toBe("https://remote.example/mcp");
		deactivate();
	});

	it("rejects an add with no definition", async () => {
		const { host, deactivate } = await activated();
		const error = onlyError(await dispatch(host, { action: "add", name: "empty" }));
		expect(error.code).toBe("invalid-entry");
		deactivate();
	});

	it("rejects an add whose entry is not an object", async () => {
		const { host, deactivate } = await activated();
		const error = onlyError(await dispatch(host, { action: "add", name: "bad", entry: "npx mcp" }));
		expect(error.code).toBe("invalid-entry");
		deactivate();
	});

	it("removes a server this plugin owns", async () => {
		writeLayer("pi-project", { mcpServers: { mine: { command: "mine" }, keep: { command: "keep" } } });
		const { host, deactivate } = await activated();

		const state = onlyState(await dispatch(host, { action: "remove", name: "mine" })).state;
		expect(state.servers.map((server) => server.name)).toEqual(["keep"]);
		deactivate();
	});

	it("reports no-op removal of a server from another layer without touching it", async () => {
		writeLayer("shared-global", { mcpServers: { elsewhere: { command: "elsewhere" } } });
		const { host, deactivate } = await activated();

		const state = onlyState(await dispatch(host, { action: "remove", name: "elsewhere" })).state;
		expect(state.servers.map((server) => server.name)).toEqual(["elsewhere"]);
		expect(existsSync(join(roots.projectDir, ".pi", "mcp.json"))).toBe(false);
		deactivate();
	});
});

describe("secret redaction on the wire", () => {
	it("never sends env, header or token values to the browser", async () => {
		writeLayer("shared-global", {
			mcpServers: {
				secretive: {
					command: "svc",
					env: { API_KEY: "sk-live-DO-NOT-LEAK" },
					headers: { Authorization: "Bearer DO-NOT-LEAK" },
					bearerToken: "DO-NOT-LEAK",
				},
			},
		});
		const { host, deactivate } = await activated();

		const replies = await dispatch(host, { action: "list" });
		const wire = JSON.stringify(replies);
		expect(wire).not.toContain("DO-NOT-LEAK");
		// The names stay, so the UI can show which variables are configured.
		expect(wire).toContain("API_KEY");
		expect(wire).toContain("Authorization");
		const server = onlyState(replies).state.servers[0];
		expect(server?.entry.env).toEqual({ API_KEY: "***" });
		deactivate();
	});

	it("keeps redacting after a write", async () => {
		writeLayer("shared-project", { mcpServers: { svc: { command: "svc", env: { T: "hidden-value" } } } });
		const { host, deactivate } = await activated();

		const wire = JSON.stringify(await dispatch(host, { action: "toggle", name: "svc", disabled: true }));
		expect(wire).not.toContain("hidden-value");
		deactivate();
	});
});

describe("unknown and malformed input", () => {
	it("answers an unknown action with an error payload", async () => {
		const { host, deactivate } = await activated();
		const error = onlyError(await dispatch(host, { action: "launch-the-servers" }));
		expect(error.code).toBe("unknown-action");
		expect(error.action).toBe("launch-the-servers");
		deactivate();
	});

	it.each([
		["undefined payload", undefined],
		["null payload", null],
		["a string", "list"],
		["a number", 7],
		["an array", ["list"]],
		["an empty object", {}],
		["a non-string action", { action: 42 }],
	])("handles %s without throwing", async (_label, payload) => {
		const { host, deactivate } = await activated();
		const error = onlyError(await dispatch(host, payload));
		expect(error.code).toBe("unknown-action");
		deactivate();
	});

	it("keeps serving after a malformed message", async () => {
		const { host, deactivate } = await activated();
		onlyError(await dispatch(host, { action: "nope" }));
		onlyState(await dispatch(host, { action: "list" }));
		deactivate();
	});
});

describe("the default export", () => {
	it("is a server entry the host can activate and deactivate", async () => {
		const host = createMockHost({ permissions: ["fs"] });
		const deactivate = await defaultEntry.activate(host);
		expect(host.recorded.handlers.message.size).toBe(1);
		deactivate();
		expect(host.recorded.handlers.message.size).toBe(0);
	});
});

describe("build artifacts", () => {
	const result = buildPlugin(PLUGIN_ID);

	it("builds both entries from TypeScript", () => {
		expect(result.ok, `build failed:\n${result.stderr}\n${result.stdout}`).toBe(true);
		expect(result.serverEntry).toBe(repoPath("plugins", PLUGIN_ID, "index.mjs"));
		expect(result.clientEntry).toBe(repoPath("plugins", PLUGIN_ID, "client", "entry.mjs"));
		for (const artifact of result.artifacts) expect(isGitIgnored(artifact), artifact).toBe(true);
	});

	it("compiles a server entry the host can activate", async () => {
		const mod = await importServerArtifact(PLUGIN_ID);
		expect(isServerEntry(mod), "index.mjs has no default { activate }").toBe(true);
		if (!isServerEntry(mod)) return;
		const host = createMockHost({ permissions: ["fs"] });
		const deactivate = await mod.default.activate(host);
		expect(host.recorded.handlers.message.size).toBe(1);
		if (typeof deactivate !== "function") throw new Error("activate() returned no cleanup function");
		deactivate();
		expect(host.recorded.handlers.message.size).toBe(0);
	});

	it("compiles a client entry the frontend can mount", async () => {
		const mod = await importClientArtifact(PLUGIN_ID);
		expect(isClientEntry(mod), "client/entry.mjs has no default { mount }").toBe(true);
		if (!isClientEntry(mod)) return;
		expect(typeof mod.default.mount).toBe("function");
	});

	it("leaves no bare npm specifier in the browser bundle", () => {
		const source = readFileSync(repoPath("plugins", PLUGIN_ID, "client", "entry.mjs"), "utf8");
		const bareImport = /(?:^|[\s;}])(?:import|export)[^;\n]*?from\s*["'](?!\.|\/|https?:)[^"']+["']/m;
		expect(bareImport.test(source), "client bundle still imports an npm package").toBe(false);
		expect(source).not.toMatch(/require\s*\(/);
	});

	it("builds a client bundle that carries the /reload caveat", () => {
		const source = readFileSync(repoPath("plugins", PLUGIN_ID, "client", "entry.mjs"), "utf8");
		expect(source).toContain("/reload");
	});
});

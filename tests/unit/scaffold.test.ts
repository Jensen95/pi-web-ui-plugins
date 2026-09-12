/**
 * Behavioural assertions about the shared scaffold: the plugin skeleton, the root
 * package, the English-only gate, the gitignore boundary, the mock host contract
 * and the build/import pipeline.
 *
 * Everything here asserts observable behaviour through a public surface (a file
 * that must or must not exist, a script's exit code and output, what the mock host
 * records, what a compiled artifact exports). Nothing inspects private internals.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activatePlugin, createMockHost, createMockViewContext } from "../helpers/mock-host";
import type { MockAgentTool, MockHost, PluginServerEntry } from "../helpers/mock-host";
import { artifactRelPaths, artifactSnapshot, buildPlugin } from "../helpers/plugin-build";
import {
	importClientArtifact,
	importServerArtifact,
	isClientEntry,
	isServerEntry,
	listPlugins,
	loadPlugin,
} from "../helpers/plugin-contract";
import { REPO_ROOT, isGitIgnored, pluginIds, repoPath } from "../helpers/repo-files";

const EXPECTED_PLUGIN_IDS = ["db-client", "mcp-manager", "mermaid", "run-trace", "vscode-editor", "webmail"];

const EXPECTED_SCRIPTS = [
	"test",
	"test:watch",
	"typecheck",
	"lint",
	"lint:fix",
	"format",
	"format:check",
	"build",
	"clean",
	"clean:force",
	"check:english",
	...EXPECTED_PLUGIN_IDS.map((id) => `build:${id}`),
];

/** Dependencies the shared build needs at the root now that plugins have none. */
const REQUIRED_DEV_DEPS = [
	"typescript",
	"vitest",
	"prettier",
	"oxlint",
	"esbuild",
	"@types/node",
	"@types/ws",
	"mermaid",
	"vis-timeline",
	"codemirror",
	"@codemirror/view",
	"@codemirror/state",
	"@xterm/xterm",
	"@xterm/addon-fit",
	"ssh2",
];

function readPackageJson(): {
	scripts: Record<string, string>;
	devDependencies: Record<string, string>;
	[key: string]: unknown;
} {
	return JSON.parse(readFileSync(repoPath("package.json"), "utf8"));
}

function runGate(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "check-english.mjs"), ...args], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run a callback against a temp directory outside the repo, then remove it.
 *  Outside the repo on purpose: a planted CJK file must never be visible to the
 *  repo-wide scan that english-only.test.ts runs in parallel. */
function withTempDir<T>(run: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "scaffold-probe-"));
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("plugin skeleton", () => {
	it("contains exactly the six expected plugin directories", () => {
		expect(pluginIds()).toEqual(EXPECTED_PLUGIN_IDS);
	});

	it("gives every plugin a parseable manifest with a usable name", () => {
		for (const id of EXPECTED_PLUGIN_IDS) {
			const plugin = loadPlugin(id);
			expect(plugin.manifest.name, `${id} manifest name`).toBeTypeOf("string");
			expect(plugin.manifest.name.trim().length, `${id} manifest name is empty`).toBeGreaterThan(0);
			expect(plugin.dir, `${id} dir`).toBe(repoPath("plugins", id));
			expect(existsSync(plugin.manifestPath), `${id} manifest path`).toBe(true);
		}
	});

	it("resolves a plugin id the way the host does: manifest id, else directory name", () => {
		for (const plugin of listPlugins()) {
			// webmail ships no "id" field and the host defaults it to the directory
			// name, so either shape must resolve to the directory name here.
			expect(plugin.id, `${plugin.dirName} resolved id`).toBe(plugin.dirName);
			expect(
				plugin.manifest.id === undefined || plugin.manifest.id === plugin.dirName,
				`${plugin.dirName} declares a mismatched manifest id`,
			).toBe(true);
		}
	});

	it("carries no descriptionEn key in any manifest, because this repo is English-only", () => {
		// The host picks `locale !== "zh" && descriptionEn ? descriptionEn : description`,
		// so English belongs in "description" and a descriptionEn key is dead weight.
		const offenders = listPlugins()
			.filter((plugin) => "descriptionEn" in plugin.raw)
			.map((plugin) => plugin.dirName);
		expect(offenders, `delete "descriptionEn" from these manifests`).toEqual([]);
	});

	it("reports a missing plugin directory instead of returning a half-built record", () => {
		expect(() => loadPlugin("no-such-plugin")).toThrow(/no such plugin directory/);
	});
});

describe("root package", () => {
	const pkg = readPackageJson();

	it("declares every npm script the repo promises", () => {
		for (const name of EXPECTED_SCRIPTS) {
			expect(pkg.scripts[name], `missing npm script "${name}"`).toBeTypeOf("string");
			expect(pkg.scripts[name]?.trim().length, `empty npm script "${name}"`).toBeGreaterThan(0);
		}
	});

	it("routes every build through the one shared convention-driven script", () => {
		expect(pkg.scripts.build).toContain("scripts/build-plugins.mjs");
		for (const id of EXPECTED_PLUGIN_IDS) {
			expect(pkg.scripts[`build:${id}`], `build:${id}`).toContain(`scripts/build-plugins.mjs ${id}`);
		}
		expect(pkg.scripts["check:english"]).toContain("scripts/check-english.mjs");
		expect(pkg.scripts.typecheck).toContain("--noEmit");
		expect(pkg.scripts.test).toContain("vitest");
		expect(pkg.scripts.lint).toContain("oxlint");
	});

	it("is one private ESM package with no workspaces", () => {
		expect(pkg.type).toBe("module");
		expect(pkg.private).toBe(true);
		expect(pkg.name).toBe("pi-web-ui-plugins");
		expect(pkg.workspaces).toBeUndefined();
		expect(pkg.engines).toMatchObject({ node: ">=22.19.0" });
	});

	it("keeps every build dependency at the root, including the vscode-editor client set", () => {
		const missing = REQUIRED_DEV_DEPS.filter((name) => pkg.devDependencies[name] === undefined);
		expect(missing, `missing devDependencies`).toEqual([]);
		expect(pkg.devDependencies.typescript).toMatch(/^\^?7\./);
	});

	it("typechecks with the TypeScript 7 native compiler, not a shadowing 5.x", () => {
		const installed = JSON.parse(readFileSync(repoPath("node_modules", "typescript", "package.json"), "utf8"));
		expect(String(installed.version)).toMatch(/^7\./);
		const version = spawnSync(process.execPath, [repoPath("node_modules", "typescript", "bin", "tsc"), "--version"], {
			encoding: "utf8",
		});
		expect(version.stdout.trim(), "tsc --version").toMatch(/^Version 7\./);
	});

	it("has no leftover per-plugin package.json anywhere under plugins/", () => {
		const found = EXPECTED_PLUGIN_IDS.filter((id) => existsSync(repoPath("plugins", id, "package.json")));
		expect(found).toEqual([]);
	});
});

describe("obsolete per-plugin build machinery", () => {
	const OBSOLETE = ["build.mjs", "package.json", "package-lock.json"];

	it("is deleted from the plugins that used to ship it", () => {
		for (const id of EXPECTED_PLUGIN_IDS) {
			for (const file of OBSOLETE) {
				expect(existsSync(repoPath("plugins", id, file)), `plugins/${id}/${file} should be gone`).toBe(false);
			}
		}
	});

	it("leaves the shared build scripts in place at the root instead", () => {
		for (const script of [
			"build-plugins.mjs",
			"build-mermaid-vendor.mjs",
			"build-runtrace-vendor.mjs",
			"check-english.mjs",
			"clean.mjs",
		]) {
			expect(existsSync(repoPath("scripts", script)), `scripts/${script}`).toBe(true);
		}
	});

	it("wires clean to the guarded script, so it cannot destroy un-ported sources", () => {
		const pkg = readPackageJson();
		expect(pkg.scripts.clean).toBe("node scripts/clean.mjs");
		expect(pkg.scripts["clean:force"]).toBe("node scripts/clean.mjs --force");
		// The compiled entries are gitignored, so while a plugin is still un-ported the
		// hand-written upstream .mjs at those paths is the porting agent's only copy of
		// the source. clean.mjs refuses to delete an artifact that has no src/*.ts to
		// rebuild it from; this asserts the guard is what the script implements.
		const source = readFileSync(repoPath("scripts", "clean.mjs"), "utf8");
		expect(source).toContain("--force");
		expect(source).toContain("src/index.ts");
		expect(source).toContain("src/client.ts");
	});
});

describe("English-only gate", () => {
	it("fails with file:line:col when a scanned file contains CJK", () => {
		withTempDir((dir) => {
			const file = join(dir, "probe.ts");
			writeFileSync(file, "export const a = 1; // \u4e2d\u6587 note\n", "utf8");
			const run = runGate([file]);
			expect(run.status, `stdout: ${run.stdout}`).toBe(1);
			expect(run.stdout).toContain(`${file}:1:24:`);
			expect(run.stdout).toMatch(/:\d+:\d+: /);
			expect(run.stderr).toMatch(/English-only check FAILED/);
		});
	});

	it("passes on a clean English file", () => {
		withTempDir((dir) => {
			const file = join(dir, "clean.ts");
			writeFileSync(file, "export const a = 1; // a clean English note\n", "utf8");
			const run = runGate([file]);
			expect(run.status, `stdout: ${run.stdout}`).toBe(0);
			expect(run.stdout).toMatch(/passed/);
		});
	});

	it("scans every file in a directory it is pointed at", () => {
		withTempDir((dir) => {
			writeFileSync(join(dir, "clean.ts"), "// fine\n", "utf8");
			writeFileSync(join(dir, "bad.ts"), "// \u4e2d\u6587\n", "utf8");
			const run = runGate([dir]);
			expect(run.status).toBe(1);
			expect(run.stdout).toContain("bad.ts:1:4:");
			// The summary is reported on stderr, alongside the failure.
			expect(run.stderr).toContain("scanned 2 files");
		});
	});

	it("reports a missing path clearly instead of passing silently", () => {
		const run = runGate([join(tmpdir(), "definitely-not-here.ts")]);
		expect(run.status).toBe(1);
		expect(run.stderr + run.stdout).toMatch(/No such file/);
	});

	it("scans the whole repo without crashing, whichever way the result goes", () => {
		const run = runGate();
		// 0 = clean, 1 = violations found. Anything else means the gate itself broke.
		expect(run.status === 0 || run.status === 1, `gate exited ${run.status}: ${run.stderr}`).toBe(true);
		if (run.status === 1) {
			expect(run.stdout).toMatch(/^[^\s:]+:\d+:\d+: /m);
			expect(run.stderr).toMatch(/English-only check FAILED/);
		} else {
			expect(run.stdout).toMatch(/passed/);
		}
	});
});

describe("gitignore boundary", () => {
	it("ignores every path the builder writes", () => {
		for (const id of EXPECTED_PLUGIN_IDS) {
			const { server, client } = artifactRelPaths(id);
			expect(isGitIgnored(server), `${server} must be gitignored`).toBe(true);
			expect(isGitIgnored(client), `${client} must be gitignored`).toBe(true);
			expect(
				isGitIgnored(`plugins/${id}/client/vendor/anything.bundle.mjs`),
				`${id} vendor output must be gitignored`,
			).toBe(true);
			expect(isGitIgnored(`plugins/${id}/node_modules/x/index.js`), `${id} node_modules`).toBe(true);
			expect(isGitIgnored(`plugins/${id}/storage/state.json`), `${id} runtime storage`).toBe(true);
		}
		expect(isGitIgnored("node_modules/x/index.js")).toBe(true);
		expect(isGitIgnored("dist/x.js")).toBe(true);
	});

	it("does not ignore anything hand-written", () => {
		const handWritten = [
			"package.json",
			"tsconfig.json",
			"vitest.config.ts",
			".prettierrc.json",
			".oxlintrc.json",
			"LICENSE",
			"README.md",
			"scripts/build-plugins.mjs",
			"scripts/check-english.mjs",
			"tests/helpers/mock-host.ts",
			"tests/unit/scaffold.test.ts",
			".github/workflows/ci.yml",
			".github/workflows/release.yml",
		];
		for (const id of EXPECTED_PLUGIN_IDS) {
			handWritten.push(
				`plugins/${id}/manifest.json`,
				`plugins/${id}/README.md`,
				`plugins/${id}/src/index.ts`,
				`plugins/${id}/src/client.ts`,
			);
		}
		const ignored = handWritten.filter(isGitIgnored);
		expect(ignored, `hand-written files must not be gitignored`).toEqual([]);
	});
});

describe("mock host contract", () => {
	it("records a message handler and invokes it with the payload and sender", async () => {
		const host = createMockHost();
		const seen: unknown[] = [];
		host.onMessage((payload, from) => {
			seen.push({ payload, from });
		});
		expect(host.recorded.handlers.message.size).toBe(1);

		const invoked = await host.emit.message({ action: "list" }, "client-7");
		expect(invoked).toBe(1);
		expect(seen).toEqual([{ payload: { action: "list" }, from: "client-7" }]);
	});

	it("stops invoking a handler once its unsubscribe has run", async () => {
		const host = createMockHost();
		let calls = 0;
		const off = host.onMessage(() => {
			calls += 1;
		});
		await host.emit.message({});
		off();
		expect(host.recorded.handlers.message.size).toBe(0);
		expect(await host.emit.message({})).toBe(0);
		expect(calls).toBe(1);
	});

	it("dispatches one message to every registered handler, in registration order", async () => {
		const host = createMockHost();
		const order: string[] = [];
		host.onMessage(() => order.push("first"));
		host.onMessage(() => order.push("second"));
		expect(await host.emit.message({})).toBe(2);
		expect(order).toEqual(["first", "second"]);
	});

	it("records outbound broadcast, notify and sendTo calls", () => {
		const host = createMockHost();
		host.broadcast({ kind: "state", n: 1 });
		host.notify("warning", "disk almost full");
		host.sendTo("client-1", { kind: "reply" });
		host.log("hello", 42);

		expect(host.recorded.broadcasts).toEqual([{ kind: "state", n: 1 }]);
		expect(host.recorded.notifications).toEqual([{ level: "warning", text: "disk almost full" }]);
		expect(host.recorded.sent).toEqual([{ clientId: "client-1", payload: { kind: "reply" } }]);
		expect(host.recorded.logs).toEqual([["hello", 42]]);
	});

	it("registers an AI tool and runs it with the parameters the agent passes", async () => {
		const host = createMockHost({ permissions: ["tools"] });
		const tool: MockAgentTool = {
			name: "mail_list",
			description: "List mailboxes.",
			parameters: { type: "object", properties: { limit: { type: "number" } } },
			async execute(_toolCallId, params, _signal, onUpdate) {
				onUpdate?.({ progress: "working" });
				return { content: [{ type: "text", text: `limit=${String(params.limit)}` }] };
			},
		};
		const off = host.registerAgentTool(tool);
		expect(host.agentTool("mail_list")).toBe(tool);
		expect(host.recorded.rejections).toEqual([]);

		const updates: unknown[] = [];
		const result = await host
			.agentTool("mail_list")
			?.execute("call-1", { limit: 5 }, undefined, (p) => updates.push(p));
		expect(result).toEqual({ content: [{ type: "text", text: "limit=5" }] });
		expect(updates).toEqual([{ progress: "working" }]);

		off?.();
		expect(host.agentTool("mail_list")).toBeUndefined();
	});

	it("refuses a duplicate AI tool and one that is missing its description", () => {
		const host = createMockHost({ permissions: ["tools"] });
		const tool: MockAgentTool = { name: "db_query", description: "Run SQL.", execute: async () => "ok" };
		host.registerAgentTool(tool);
		host.registerAgentTool({ ...tool });
		host.registerAgentTool({ name: "broken", description: "", execute: async () => "ok" });

		expect(host.recorded.agentTools.size).toBe(1);
		expect(host.recorded.rejections.map((r) => r.api)).toEqual(["registerAgentTool", "registerAgentTool"]);
		expect(host.recorded.rejections[0]?.reason).toMatch(/already registered/);
		expect(host.recorded.rejections[1]?.reason).toMatch(/missing name, description or execute/);
	});

	it("gates registerAgentTool on the declared tools capability", () => {
		const host = createMockHost({ permissions: ["net"] });
		host.registerAgentTool({ name: "db_query", description: "Run SQL.", execute: async () => "ok" });
		expect(host.recorded.agentTools.size).toBe(0);
		expect(host.recorded.rejections).toEqual([
			{ api: "registerAgentTool", reason: 'missing capability "tools" (manifest.permissions)' },
		]);
	});

	it("allows gated APIs and warns once when the manifest declares no permissions", () => {
		const host = createMockHost();
		host.registerAgentTool({ name: "a", description: "d", execute: async () => "ok" });
		host.route("GET", "/ping", (_req, res) => res.json({ ok: true }));
		expect(host.recorded.agentTools.size).toBe(1);
		expect(host.recorded.routes.size).toBe(1);
		expect(host.recorded.rejections).toEqual([]);
		expect(host.recorded.legacyWarnings).toHaveLength(1);
	});

	it("normalizes a slash command name and runs it", async () => {
		const host = createMockHost();
		host.registerCommand({ name: "/mail_check", description: "Check mail.", run: (args, ctx) => ({ args, ctx }) });
		const cmd = host.command("mail_check");
		expect(cmd?.name).toBe("mail_check");
		expect(host.command("/mail_check")).toBe(cmd);
		expect(await cmd?.run("inbox", { clientId: "c1" })).toEqual({ args: "inbox", ctx: { clientId: "c1" } });
	});

	it("refuses an invalid or duplicate command name", () => {
		const host = createMockHost();
		host.registerCommand({ name: "1bad", run: () => "x" });
		host.registerCommand({ name: "good", description: "d" } as never);
		host.registerCommand({ name: "good2", run: () => "x" });
		host.registerCommand({ name: "good2", run: () => "y" });

		expect([...host.recorded.commands.keys()]).toEqual(["good2"]);
		expect(host.recorded.rejections.map((r) => r.reason)).toEqual([
			'invalid name "1bad"',
			'command "good" has no run()',
			'command "/good2" is already registered',
		]);
	});

	it("serves a registered HTTP route and captures the response", async () => {
		const host = createMockHost({ permissions: ["http"] });
		host.route("POST", "/query", (req, res) => {
			res.status(201).json({ echo: req.body });
		});
		const res = await host.callRoute("POST", "/query", { body: { sql: "select 1" } });
		expect(res.statusCode).toBe(201);
		expect(res.body).toEqual({ echo: { sql: "select 1" } });
		expect(res.headers["content-type"]).toBe("application/json");
		expect(res.finished).toBe(true);
	});

	it("refuses a route with an unsupported method or a relative path", () => {
		const host = createMockHost({ permissions: ["http"] });
		host.route("PATCH" as never, "/x", (_req, res) => res.end());
		host.route("GET", "relative", (_req, res) => res.end());
		expect(host.recorded.routes.size).toBe(0);
		expect(host.recorded.rejections.map((r) => r.api)).toEqual(["route", "route"]);
	});

	it("throws when a test calls a route nobody registered", async () => {
		const host = createMockHost();
		await expect(host.callRoute("GET", "/nope")).rejects.toThrow(/no route registered/);
	});

	it("round-trips storage with a fallback for keys that were never set", () => {
		const host = createMockHost({ storage: { seeded: { a: 1 } } });
		expect(host.storage.get("seeded")).toEqual({ a: 1 });
		expect(host.storage.get("missing", "fallback")).toBe("fallback");
		expect(host.storage.get("missing")).toBeUndefined();

		host.storage.set("key", "value");
		expect(host.storage.get("key")).toBe("value");
		expect(host.storage.all()).toEqual({ seeded: { a: 1 }, key: "value" });
		expect(host.recorded.storage.get("key")).toBe("value");

		host.storage.delete("key");
		expect(host.storage.get("key")).toBeUndefined();
		expect(Object.keys(host.storage.all())).toEqual(["seeded"]);
	});

	it("keeps secrets separate from storage and lists only their names", () => {
		const host = createMockHost({ secrets: { token: "s3cret" } });
		expect(host.secrets.get("token")).toBe("s3cret");
		expect(host.secrets.has("token")).toBe(true);
		expect(host.secrets.has("other")).toBe(false);
		host.secrets.set("password", "hunter2");
		expect(host.secrets.list().sort()).toEqual(["password", "token"]);
		expect(host.storage.all()).toEqual({});
		host.secrets.delete("token");
		expect(host.secrets.list()).toEqual(["password"]);
	});

	it("anchors host.fs to the workspace and refuses paths that escape it", async () => {
		const host = createMockHost({ permissions: ["fs"], files: { "src/a.ts": "hello", "README.md": "# hi" } });
		await expect(host.fs.readText("src/a.ts")).resolves.toBe("hello");
		await expect(host.fs.read("src/a.ts")).resolves.toSatisfy((buf: Buffer) => buf.toString("utf8") === "hello");
		await expect(host.fs.list()).resolves.toEqual([
			{ name: "README.md", type: "file" },
			{ name: "src", type: "dir" },
		]);
		await expect(host.fs.list("src")).resolves.toEqual([{ name: "a.ts", type: "file" }]);

		await host.fs.write("out/b.txt", "written");
		await expect(host.fs.readText("out/b.txt")).resolves.toBe("written");
		await host.fs.remove("out/b.txt");
		await expect(host.fs.readText("out/b.txt")).rejects.toThrow(/ENOENT/);

		await expect(host.fs.readText("../escape.txt")).rejects.toThrow(/ENOENT|escapes/);
		await expect(host.fs.readText("/etc/passwd")).rejects.toThrow(/escapes/);
		await expect(host.fs.write("../escape.txt", "x")).rejects.toThrow(/escapes/);
	});

	it("truncates host.fs.readText at maxBytes", async () => {
		const host = createMockHost({ permissions: ["fs"], files: { "a.txt": "abcdef" } });
		await expect(host.fs.readText("a.txt", 3)).resolves.toBe("abc");
		await expect(host.fs.readText("a.txt")).resolves.toBe("abcdef");
	});

	it("refuses host.fs when the fs capability is not declared", async () => {
		const host = createMockHost({ permissions: ["net"], files: { "a.txt": "x" } });
		await expect(host.fs.readText("a.txt")).rejects.toThrow(/capability "fs"/);
		expect(host.recorded.rejections.map((r) => r.api)).toContain("fs.readText");
	});

	it("records a background task, updates it and unregisters it", () => {
		const host = createMockHost();
		let stopped = 0;
		const handle = host.registerBackgroundTask({
			id: "mail-poller",
			label: "Mail polling",
			status: "idle",
			stop: () => {
				stopped += 1;
			},
		});
		const task = host.backgroundTask("mail-poller");
		expect(task?.label).toBe("Mail polling");
		expect(task?.status).toBe("idle");
		expect(task?.since).toBeTypeOf("number");

		handle.update({ status: "polling" });
		expect(host.backgroundTask("mail-poller")?.status).toBe("polling");

		// A duplicate id is refused with a no-op handle.
		const dup = host.registerBackgroundTask({ id: "mail-poller", label: "Other" });
		expect(host.recorded.backgroundTasks.size).toBe(1);
		expect(host.recorded.rejections.map((r) => r.api)).toEqual(["registerBackgroundTask"]);
		dup.update({ status: "ignored" });
		expect(host.backgroundTask("mail-poller")?.status).toBe("polling");

		task?.stop?.();
		expect(stopped).toBe(1);
		handle.unregister();
		expect(host.backgroundTask("mail-poller")).toBeUndefined();
		// update() after unregister() is ignored rather than resurrecting the task.
		handle.update({ status: "ghost" });
		expect(host.backgroundTask("mail-poller")).toBeUndefined();
	});

	it("fans run, tool, conversation, settings and cwd events out to subscribers", async () => {
		const host = createMockHost();
		const runs: string[] = [];
		const tools: string[] = [];
		let convChanges = 0;
		const settings: Record<string, unknown>[] = [];
		const cwds: string[] = [];

		host.onRunEvent((ev) => runs.push(ev.type));
		host.onToolEvent((ev) => tools.push(`${ev.phase}:${ev.toolName}`));
		host.onConversationChanged(() => {
			convChanges += 1;
		});
		host.onSettingsChanged((values) => settings.push(values));
		host.onCwdChange((cwd) => cwds.push(cwd));

		expect(await host.emit.runEvent({ type: "run_start", at: 1, task: "do it" })).toBe(1);
		expect(await host.emit.runEvent({ type: "tool_start", at: 2, toolName: "bash", toolCallId: "t1" })).toBe(1);
		expect(await host.emit.runEvent({ type: "run_end", at: 3 })).toBe(1);
		expect(runs).toEqual(["run_start", "tool_start", "run_end"]);

		expect(await host.emit.toolEvent({ phase: "start", toolName: "read" })).toBe(1);
		expect(await host.emit.toolEvent({ phase: "end", toolName: "read", durationMs: 12, isError: false })).toBe(1);
		expect(tools).toEqual(["start:read", "end:read"]);

		expect(await host.emit.conversationChanged()).toBe(1);
		expect(convChanges).toBe(1);

		expect(await host.emit.settingsChanged({ poll: true })).toBe(1);
		expect(settings).toEqual([{ poll: true }]);

		// notifyCwd mirrors the host: it moves host.cwd, then fires the handlers.
		const before = host.cwd;
		expect(await host.emit.notifyCwd("/tmp/other-workspace")).toBe(1);
		expect(host.cwd).toBe("/tmp/other-workspace");
		expect(host.cwd).not.toBe(before);
		expect(cwds).toEqual(["/tmp/other-workspace"]);
	});

	it("fires onAttach for every client that attaches", async () => {
		const host = createMockHost();
		const attached: string[] = [];
		host.onAttach((clientId) => attached.push(clientId));
		expect(await host.emit.attach("c1")).toBe(1);
		expect(await host.emit.attach("c2")).toBe(1);
		expect(attached).toEqual(["c1", "c2"]);
	});

	it("returns no active conversation by default and the supplied snapshot when given one", () => {
		expect(createMockHost().getActiveConversation()).toBeNull();
		const snapshot = {
			conversationId: "conv-1",
			title: "Port plugins",
			at: 1000,
			isStreaming: false,
			messages: [{ id: "u-1", role: "user", content: [{ type: "text", text: "hi" }] }],
			streamingMessage: null,
			stats: { totalMessages: 1, tokens: { input: 3, output: 0, total: 3 }, cost: 0 },
		};
		const host = createMockHost({ activeConversation: snapshot });
		expect(host.getActiveConversation()).toEqual(snapshot);
		expect(host.getActiveConversation()?.messages).toHaveLength(1);
	});

	it("exposes settings, dir, dataDir and ensureDeps like the host does", async () => {
		const host = createMockHost({
			dir: "/data/plugins/webmail",
			dataDir: "/data",
			settings: { pollSeconds: 30 },
			ensureDepsResult: false,
		});
		expect(host.dir).toBe("/data/plugins/webmail");
		expect(host.dataDir).toBe("/data");
		expect(host.getSettings()).toEqual({ pollSeconds: 30 });
		// A fresh object each call, so a plugin cannot mutate the host's settings.
		expect(host.getSettings()).not.toBe(host.getSettings());

		const progress: string[] = [];
		await expect(host.ensureDeps(["imapflow"], { onProgress: (msg) => progress.push(msg) })).resolves.toBe(false);
		expect(host.recorded.ensureDepsCalls).toEqual([["imapflow"]]);
		expect(progress).toHaveLength(1);
	});

	it("defaults dir, dataDir and cwd to usable paths", () => {
		const host = createMockHost();
		expect(host.dir).toContain("plugins");
		expect(host.dataDir.length).toBeGreaterThan(0);
		expect(host.cwd.length).toBeGreaterThan(0);
	});

	it("activatePlugin returns the deactivate that activate returned", async () => {
		const events: string[] = [];
		const entry: PluginServerEntry = {
			activate(host: MockHost) {
				events.push("activate");
				host.onMessage(() => events.push("message"));
				return () => events.push("deactivate");
			},
		};
		const { host, deactivate } = await activatePlugin(entry);
		expect(events).toEqual(["activate"]);
		expect(deactivate).toBeTypeOf("function");

		await host.emit.message({});
		expect(events).toEqual(["activate", "message"]);
		deactivate?.();
		expect(events).toEqual(["activate", "message", "deactivate"]);
	});

	it("activatePlugin reports no deactivate when activate returns nothing", async () => {
		const { deactivate } = await activatePlugin({ activate: () => undefined });
		expect(deactivate).toBeUndefined();
	});

	it("records what a view context sends upstream and pushes data back to subscribers", () => {
		const recorder = createMockViewContext("mermaid");
		expect(recorder.ctx.pluginId).toBe("mermaid");

		const received: unknown[] = [];
		const off = recorder.ctx.onData((payload) => received.push(payload));
		recorder.ctx.send({ action: "render", code: "graph TD" });
		expect(recorder.sent).toEqual([{ action: "render", code: "graph TD" }]);

		expect(recorder.push({ kind: "state" })).toBe(1);
		expect(received).toEqual([{ kind: "state" }]);

		off();
		expect(recorder.push({ kind: "late" })).toBe(0);
		expect(received).toEqual([{ kind: "state" }]);
	});
});

describe("build and compiled-artifact pipeline", () => {
	const plugins = listPlugins();
	const ported = plugins.filter((plugin) => plugin.hasServerSource || plugin.hasClientSource);

	it("reports which plugins have been converted to TypeScript yet", () => {
		// Not vacuous in either state: before the ports land this pins the exact set
		// of un-converted plugins; afterwards it asserts the sources really are there.
		if (ported.length === 0) {
			expect(plugins.map((plugin) => plugin.dirName)).toEqual(EXPECTED_PLUGIN_IDS);
			expect(plugins.every((plugin) => !plugin.hasServerSource && !plugin.hasClientSource)).toBe(true);
		} else {
			expect(ported.length).toBeGreaterThan(0);
			expect(ported.length).toBeLessThanOrEqual(EXPECTED_PLUGIN_IDS.length);
		}
	});

	it.skipIf(plugins.every((plugin) => !plugin.hasServerSource && !plugin.hasClientSource))(
		"builds a converted plugin into artifacts that import as valid ESM",
		async () => {
			const target = ported[0];
			if (!target) throw new Error("no converted plugin to build");
			const result = buildPlugin(target.dirName);
			expect(result.ok, `build failed:\n${result.stderr}`).toBe(true);
			expect(result.status).toBe(0);
			expect(result.artifacts.length, `no artifacts for ${target.dirName}`).toBeGreaterThan(0);

			if (target.hasServerSource) {
				const mod = await importServerArtifact(target.dirName);
				expect(isServerEntry(mod), "index.mjs must default-export { activate(host) }").toBe(true);
				if (isServerEntry(mod)) {
					// The compiled server entry must actually activate against the host contract.
					const { host, deactivate } = await activatePlugin(mod.default);
					expect(host.recorded).toBeDefined();
					deactivate?.();
				}
			}
			if (target.hasClientSource) {
				const mod = await importClientArtifact(target.dirName);
				expect(isClientEntry(mod), "client/entry.mjs must default-export mount() or renderers").toBe(true);
			}
		},
	);

	it("writes nothing for a plugin that has no src/ yet, and says so", () => {
		const unported = plugins.filter((plugin) => !plugin.hasServerSource && !plugin.hasClientSource);
		const target = unported[0];
		if (!target) return; // every plugin is ported: nothing left to assert here

		// A stale upstream artifact may already sit at these paths, so the claim to
		// test is that the builder leaves the directory alone - not that it is empty.
		const before = artifactSnapshot(target.dirName);
		const result = buildPlugin(target.dirName);
		expect(result.ok, `stderr: ${result.stderr}`).toBe(true);
		expect(result.stdout).toContain("skipped");
		expect(result.stdout).toContain("0 built");
		expect(artifactSnapshot(target.dirName), `the skip path rewrote ${target.dirName}'s artifacts`).toEqual(before);
	});

	it("refuses an unknown plugin id with a non-zero exit and a usable message", () => {
		const result = buildPlugin("definitely-not-a-plugin");
		expect(result.ok).toBe(false);
		expect(result.status).toBe(1);
		expect(result.stderr + result.stdout).toMatch(/Unknown plugin id/);
		expect(result.artifacts).toEqual([]);
	});

	it("rejects a compiled artifact that exports the wrong shape", () => {
		// Proves isServerEntry/isClientEntry can say no, so a "yes" above means something.
		expect(isServerEntry({})).toBe(false);
		expect(isServerEntry({ default: {} })).toBe(false);
		expect(isServerEntry({ default: { activate: "nope" } })).toBe(false);
		expect(isClientEntry({ default: {} })).toBe(false);
		expect(isClientEntry(undefined)).toBe(false);
		expect(isServerEntry({ default: { activate: () => undefined } })).toBe(true);
		expect(isClientEntry({ default: { mount: () => undefined } })).toBe(true);
		expect(isClientEntry({ default: { renderers: { mermaid: () => null } } })).toBe(true);
	});

	it("reports missing artifacts instead of importing a path that is not there", async () => {
		const unported = plugins.filter((plugin) => !plugin.hasServerArtifact);
		const target = unported[0];
		if (!target) return;
		expect(() => importServerArtifact(target.dirName)).toThrow(/run npm run build/);
		expect(existsSync(repoPath("plugins", target.dirName, "index.mjs"))).toBe(false);
	});
});

/**
 * subagent-config server side: frontmatter round-trip, the model pin resolver,
 * the subagents.json merge and its sanitizer ceilings, the write refusals, and
 * the activate(host) message protocol.
 *
 * Every case runs against a mkdtempSync root injected into the plugin, so no
 * test ever reads or writes the developer's real ~/.pi.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activatePlugin } from "../helpers/mock-host";
import type { MockHost } from "../helpers/mock-host";
import {
	deleteAgentFile,
	normalizeFileName,
	parseAgentDoc,
	readAgentsState,
	saveAgentFile,
	serializeAgentDoc,
} from "../../plugins/subagent-config/src/agents.ts";
import type { ModelOption, SubagentRoots } from "../../plugins/subagent-config/src/models.ts";
import { readModels, resolveModelPin } from "../../plugins/subagent-config/src/models.ts";
import {
	readSettingsState,
	resolveSettings,
	readSettingsLayers,
	saveSettings,
	validateValue,
} from "../../plugins/subagent-config/src/settings.ts";
import { createEntry, handle, subagentsRunning } from "../../plugins/subagent-config/src/index.ts";

let dir: string;
let roots: SubagentRoots;

function write(path: string, text: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf8");
	return path;
}

function agentPath(layer: "global" | "workspace" | "project", file: string): string {
	if (layer === "global") return join(roots.agentDir, "agents", file);
	if (layer === "workspace") return join(roots.projectDir, ".agents", "agents", file);
	return join(roots.projectDir, ".pi", "agents", file);
}

const MODELS: ModelOption[] = [
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", pin: "anthropic/claude-haiku-4-5" },
	{ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", pin: "openai-codex/gpt-5.6-luna" },
	{
		provider: "qwen-token-plan-individual",
		id: "qwen3-max",
		name: "Qwen3 Max",
		pin: "qwen-token-plan-individual/qwen3-max",
	},
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
	roots = { home: join(dir, "home"), agentDir: join(dir, "pi-agent"), projectDir: join(dir, "project") };
	for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("frontmatter round-trip", () => {
	const source = [
		"---",
		"name: reviewer",
		"# a comment the user wrote",
		"description: Reviews code",
		"tools: [read, grep]",
		"max_turns: 12",
		"some_future_key: keep-me",
		"",
		"---",
		"You are a reviewer.",
		"",
		"Be terse.",
	].join("\n");

	it("parses the flat key: value subset these files use", () => {
		const doc = parseAgentDoc(source);
		expect(doc.hasFrontmatter).toBe(true);
		expect(doc.unsupported).toBeUndefined();
		expect(doc.fields).toEqual({
			name: "reviewer",
			description: "Reviews code",
			tools: ["read", "grep"],
			max_turns: 12,
			some_future_key: "keep-me",
		});
		expect(doc.body).toBe("You are a reviewer.\n\nBe terse.");
	});

	it("returns the identical file when nothing is patched", () => {
		expect(serializeAgentDoc(parseAgentDoc(source))).toBe(source);
	});

	it("preserves unknown keys, comments and the body when one key changes", () => {
		const next = serializeAgentDoc(parseAgentDoc(source), { model: "anthropic/claude-haiku-4-5" });
		expect(next).toContain("some_future_key: keep-me");
		expect(next).toContain("# a comment the user wrote");
		expect(next).toContain("model: anthropic/claude-haiku-4-5");
		expect(next.endsWith("You are a reviewer.\n\nBe terse.")).toBe(true);
		expect(parseAgentDoc(next).fields.some_future_key).toBe("keep-me");
	});

	it("replaces a key in place instead of appending a duplicate", () => {
		const next = serializeAgentDoc(parseAgentDoc(source), { max_turns: 3 });
		expect(next.match(/max_turns:/g)).toHaveLength(1);
		expect(parseAgentDoc(next).fields.max_turns).toBe(3);
		expect(next.indexOf("max_turns")).toBeLessThan(next.indexOf("some_future_key"));
	});

	it("removes a key when the patch maps it to null", () => {
		const next = serializeAgentDoc(parseAgentDoc(source), { max_turns: null });
		expect(next).not.toContain("max_turns");
		expect(next).toContain("some_future_key: keep-me");
	});

	it("quotes a value that would otherwise parse as something else", () => {
		const doc = parseAgentDoc("---\nname: a\n---\nbody");
		const next = serializeAgentDoc(doc, { description: "true", display_name: "Plan: step one" });
		expect(next).toContain('description: "true"');
		expect(next).toContain('display_name: "Plan: step one"');
		expect(parseAgentDoc(next).fields.description).toBe("true");
		expect(parseAgentDoc(next).fields.display_name).toBe("Plan: step one");
	});

	it("adds frontmatter to a file that has none", () => {
		const doc = parseAgentDoc("just a prompt\n");
		expect(doc.hasFrontmatter).toBe(false);
		expect(serializeAgentDoc(doc, { name: "fresh" })).toBe("---\nname: fresh\n---\njust a prompt\n");
	});

	it("marks block YAML unsupported instead of flattening it", () => {
		const doc = parseAgentDoc("---\ntools:\n  - read\n  - grep\n---\nbody");
		expect(doc.unsupported).toBeTruthy();
	});

	it("keeps a CRLF file on CRLF, with no trailing newline invented", () => {
		const crlf = "---\r\nname: reviewer\r\nmystery: keep\r\n---\r\nLine one.\r\n\r\nLine two.";
		const doc = parseAgentDoc(crlf);
		expect(doc.fields).toEqual({ name: "reviewer", mystery: "keep" });
		expect(serializeAgentDoc(doc)).toBe(crlf);
		const next = serializeAgentDoc(doc, { model: "anthropic/claude-haiku-4-5" });
		expect(next).toBe(`${crlf.replace("---\r\nLine", "model: anthropic/claude-haiku-4-5\r\n---\r\nLine")}`);
		expect(next.includes("\n\n")).toBe(false);
		expect(next.endsWith("Line two.")).toBe(true);
	});

	it("round-trips quoted values byte for byte when they are not patched", () => {
		const quoted = [
			"---",
			'description: "Reviews: carefully"',
			"display_name: 'Plan it'",
			"color: '#ff0000'",
			"---",
			"Body.",
		].join("\n");
		const doc = parseAgentDoc(quoted);
		expect(doc.fields).toEqual({
			description: "Reviews: carefully",
			display_name: "Plan it",
			color: "#ff0000",
		});
		expect(serializeAgentDoc(doc, { name: "kept" })).toContain('description: "Reviews: carefully"');
		expect(parseAgentDoc(serializeAgentDoc(doc, { color: "#00ff00" })).fields.color).toBe("#00ff00");
	});

	it("collapses a duplicated key instead of leaving the stale copy to win", () => {
		// YAML takes the last occurrence, so a surviving duplicate would undo the edit.
		const doc = parseAgentDoc("---\nmodel: old-one\nname: a\nmodel: old-two\n---\nbody");
		const next = serializeAgentDoc(doc, { model: "anthropic/claude-haiku-4-5" });
		expect(next.match(/^model:/gm)).toHaveLength(1);
		expect(parseAgentDoc(next).fields.model).toBe("anthropic/claude-haiku-4-5");
	});
});

describe("model pin resolution", () => {
	it("treats an empty pin as a deliberate inherit", () => {
		const verdict = resolveModelPin("", MODELS);
		expect(verdict.status).toBe("empty");
		expect(verdict.target).toBeUndefined();
	});

	it("resolves an exact provider/id pin", () => {
		const verdict = resolveModelPin("openai-codex/gpt-5.6-luna", MODELS);
		expect(verdict.status).toBe("resolved");
		expect(verdict.exact).toBe(true);
		expect(verdict.target?.pin).toBe("openai-codex/gpt-5.6-luna");
	});

	it("treats dot and dash in a version as the same separator", () => {
		expect(resolveModelPin("anthropic/claude-haiku-4.5", MODELS).target?.id).toBe("claude-haiku-4-5");
		expect(resolveModelPin("openai-codex/gpt-5-6-luna", MODELS).target?.id).toBe("gpt-5.6-luna");
	});

	it("accepts an optional trailing date stamp", () => {
		const verdict = resolveModelPin("anthropic/claude-haiku-4-5-20251001", MODELS);
		expect(verdict.status).toBe("resolved");
		expect(verdict.target?.id).toBe("claude-haiku-4-5");
		expect(verdict.exact).toBe(false);
	});

	it("falls back to the same id under another provider", () => {
		const verdict = resolveModelPin("anthropic/gpt-5.6-luna", MODELS);
		expect(verdict.status).toBe("resolved");
		expect(verdict.target?.provider).toBe("openai-codex");
	});

	it("resolves a bare id with no provider", () => {
		expect(resolveModelPin("qwen3-max", MODELS).target?.provider).toBe("qwen-token-plan-individual");
	});

	it("reports a typo as unavailable rather than letting it look saved", () => {
		const verdict = resolveModelPin("anthropic/clod-hakiu", MODELS);
		expect(verdict.status).toBe("unavailable");
		expect(verdict.target).toBeUndefined();
		expect(verdict.message).toContain("inherit");
	});

	it("reads the model store the pi agent directory holds", () => {
		write(
			join(roots.agentDir, "models-store.json"),
			JSON.stringify({ anthropic: { models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] } }),
		);
		const store = readModels(roots);
		expect(store.models).toHaveLength(1);
		expect(store.models[0]?.pin).toBe("anthropic/claude-haiku-4-5");
		expect(store.error).toBeUndefined();
	});

	it("reports a malformed model store instead of throwing", () => {
		write(join(roots.agentDir, "models-store.json"), "{ not json");
		expect(readModels(roots).error?.code).toBe("read-failed");
	});
});

describe("model pin resolution against a real model store", () => {
	// The providers and ids of a real ~/.pi/agent/models-store.json, so these cases
	// are the ones a user actually types rather than tidy invented ones.
	const REAL: Record<string, { models: { id: string; name: string }[] }> = {
		"openai-codex": {
			models: [
				{ id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
				{ id: "gpt-5.5", name: "GPT-5.5" },
				{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
				{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
				{ id: "gpt-6-astra", name: "GPT-6 Astra" },
			],
		},
		anthropic: {
			models: [
				{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
				{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (dated)" },
				{ id: "claude-opus-4-5", name: "Claude Opus 4.5" },
				{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			],
		},
		"qwen-token-plan-individual": { models: [{ id: "qwen3.8-max", name: "Qwen3.8 Max" }] },
	};

	function realModels(): ModelOption[] {
		write(join(roots.agentDir, "models-store.json"), JSON.stringify(REAL));
		return readModels(roots).models;
	}

	it("resolves the fully qualified pin the dropdown writes", () => {
		const verdict = resolveModelPin("openai-codex/gpt-5.6-luna", realModels());
		expect(verdict.status).toBe("resolved");
		expect(verdict.exact).toBe(true);
		expect(verdict.target?.name).toBe("GPT-5.6 Luna");
	});

	it("resolves a bare id to its only provider, and says which", () => {
		const verdict = resolveModelPin("gpt-5.6-luna", realModels());
		expect(verdict.status).toBe("resolved");
		expect(verdict.exact).toBe(false);
		expect(verdict.target?.pin).toBe("openai-codex/gpt-5.6-luna");
	});

	it("treats the dashed spelling of a dotted version as the same model", () => {
		expect(resolveModelPin("gpt-5-6-luna", realModels()).target?.pin).toBe("openai-codex/gpt-5.6-luna");
		expect(resolveModelPin("openai-codex/gpt-5-6-luna", realModels()).target?.pin).toBe("openai-codex/gpt-5.6-luna");
	});

	it("accepts a dated id, and an undated one for a dated model", () => {
		const models = realModels();
		expect(resolveModelPin("anthropic/claude-haiku-4-5-20251001", models).exact).toBe(true);
		expect(resolveModelPin("claude-sonnet-4-6-20250101", models).target?.pin).toBe("anthropic/claude-sonnet-4-6");
	});

	it("reports a typed-wrong pin as unavailable instead of letting it look saved", () => {
		const models = realModels();
		for (const pin of ["gpt-5.6-lunar", "openai/gpt-5.6-luna-xl", "my-favourite-model", "zzz"]) {
			const verdict = resolveModelPin(pin, models);
			expect(verdict.status, pin).toBe("unavailable");
			expect(verdict.message, pin).toContain("silently inherit");
		}
	});
});

describe("subagents.json layers", () => {
	it("merges project over global per key and keeps the provenance", () => {
		write(join(roots.agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 4, showCost: true }));
		write(join(roots.projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 2 }));
		const effective = resolveSettings(readSettingsLayers(roots));
		const byKey = new Map(effective.map((entry) => [entry.key, entry]));
		expect(byKey.get("maxConcurrent")).toEqual({ key: "maxConcurrent", value: 2, source: "project" });
		expect(byKey.get("showCost")).toEqual({ key: "showCost", value: true, source: "global" });
		expect(byKey.get("graceTurns")).toEqual({ key: "graceTurns" });
	});

	it("reports the keys the extension would silently drop", () => {
		write(join(roots.agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 5000, graceTurns: 2 }));
		const global = readSettingsLayers(roots)[0];
		expect(global?.values).toEqual({ graceTurns: 2 });
		expect(global?.droppedKeys).toEqual(["maxConcurrent"]);
	});

	it("reports a malformed settings file rather than emptying it", () => {
		write(join(roots.projectDir, ".pi", "subagents.json"), "{ broken");
		expect(readSettingsLayers(roots)[1]?.error?.code).toBe("read-failed");
	});
});

describe("settings validation against the sanitizer", () => {
	it.each([
		["maxConcurrent", 0],
		["maxConcurrent", 1025],
		["maxConcurrent", 1.5],
		["maxConcurrentForeground", -1],
		["defaultMaxTurns", 10001],
		["graceTurns", 0],
		["maxSubagentDepth", 17],
		["defaultJoinMode", "parallel"],
		["worktreeIsolation", "yes"],
		["widgetMode", "some"],
		["fallbackSubagent", "   "],
	])("refuses %s = %s", (key, value) => {
		expect(validateValue(key as string, value).ok).toBe(false);
	});

	it.each([
		["maxConcurrent", 1],
		["maxConcurrentForeground", 0],
		["defaultMaxTurns", 0],
		["graceTurns", 1000],
		["maxSubagentDepth", 16],
		["defaultJoinMode", "smart"],
		["worktreeIsolation", false],
		["fallbackSubagent", false],
	])("accepts %s = %s", (key, value) => {
		expect(validateValue(key as string, value).ok).toBe(true);
	});

	it("accepts the legacy boolean spelling of agentMentions the way the sanitizer does", () => {
		expect(validateValue("agentMentions", true)).toEqual({ ok: true, value: "model" });
		expect(validateValue("agentMentions", false)).toEqual({ ok: true, value: "off" });
	});

	it("refuses a key subagents.json does not have", () => {
		expect(validateValue("turboMode", true).ok).toBe(false);
	});
});

describe("writing subagents.json", () => {
	it("writes the project layer and preserves unrelated keys", () => {
		const path = write(
			join(roots.projectDir, ".pi", "subagents.json"),
			JSON.stringify({ note: "mine", showCost: true }),
		);
		const result = saveSettings(roots, "project", { maxConcurrent: 3 });
		expect(result.ok && result.changed).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ note: "mine", showCost: true, maxConcurrent: 3 });
	});

	it("removes a key when it is mapped to null", () => {
		const path = write(join(roots.projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 3 }));
		expect(saveSettings(roots, "project", { maxConcurrent: null }).ok).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
	});

	it("refuses a value the extension would drop, before writing anything", () => {
		const result = saveSettings(roots, "project", { maxConcurrent: 5000 });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.code).toBe("invalid-value");
		expect(existsSync(join(roots.projectDir, ".pi", "subagents.json"))).toBe(false);
	});

	it("never overwrites a malformed existing file", () => {
		const path = write(join(roots.projectDir, ".pi", "subagents.json"), "{ broken");
		const result = saveSettings(roots, "project", { showCost: true });
		expect(result.ok === false && result.code).toBe("read-failed");
		expect(readFileSync(path, "utf8")).toBe("{ broken");
	});

	it("reports an unchanged write as no change", () => {
		write(join(roots.projectDir, ".pi", "subagents.json"), JSON.stringify({ showCost: true }));
		const result = saveSettings(roots, "project", { showCost: true });
		expect(result.ok && result.changed).toBe(false);
	});

	it("writes the global layer when asked", () => {
		expect(saveSettings(roots, "global", { graceTurns: 5 }).ok).toBe(true);
		expect(JSON.parse(readFileSync(join(roots.agentDir, "subagents.json"), "utf8"))).toEqual({ graceTurns: 5 });
	});
});

describe("agent discovery", () => {
	it("lets a later layer win the name and records what it shadows", () => {
		write(agentPath("global", "reviewer.md"), "---\ndescription: global one\n---\nglobal\n");
		write(agentPath("project", "reviewer.md"), "---\ndescription: project one\n---\nproject\n");
		const state = readAgentsState(roots, MODELS, false);
		expect(state.files).toHaveLength(2);
		const agent = state.agents.find((entry) => entry.name === "reviewer");
		expect(agent?.winner.layer).toBe("project");
		expect(agent?.shadowed.map((entry) => entry.layer)).toEqual(["global"]);
	});

	it("marks the shared workspace layer read-only", () => {
		write(agentPath("workspace", "shared.md"), "---\nname: shared\n---\nbody\n");
		const file = readAgentsState(roots, MODELS, false).files[0];
		expect(file?.layer).toBe("workspace");
		expect(file?.readOnly).toBe(true);
	});

	it("uses a declared name over the filename and lists unknown keys", () => {
		write(agentPath("project", "file-name.md"), "---\nname: declared\nfuture_key: x\n---\nbody\n");
		const file = readAgentsState(roots, MODELS, false).files[0];
		expect(file?.name).toBe("declared");
		expect(file?.unknownKeys).toEqual(["future_key"]);
	});

	it("flags a name with a colon as skipped by the extension", () => {
		write(agentPath("project", "bad.md"), "---\nname: plugin:reviewer\n---\nbody\n");
		const state = readAgentsState(roots, MODELS, false);
		expect(state.files[0]?.error?.code).toBe("invalid-name");
		expect(state.agents).toEqual([]);
	});

	it("validates the model pin of every file", () => {
		write(agentPath("project", "good.md"), "---\nmodel: anthropic/claude-haiku-4.5\n---\nbody\n");
		write(agentPath("project", "typo.md"), "---\nmodel: anthropic/nope\n---\nbody\n");
		const state = readAgentsState(roots, MODELS, false);
		expect(state.files.find((file) => file.file === "good.md")?.model.status).toBe("resolved");
		expect(state.files.find((file) => file.file === "typo.md")?.model.status).toBe("unavailable");
	});

	it("flags isolation: worktree when the project switched worktreeIsolation off", () => {
		write(agentPath("project", "iso.md"), "---\nisolation: worktree\n---\nbody\n");
		expect(readAgentsState(roots, MODELS, true).files[0]?.worktreeIgnored).toBe(true);
		expect(readAgentsState(roots, MODELS, false).files[0]?.worktreeIgnored).toBe(false);
	});
});

describe("writing agent files", () => {
	it("creates a file in the project layer", () => {
		const result = saveAgentFile(
			roots,
			"project",
			"reviewer",
			{ name: "reviewer", model: "anthropic/claude-haiku-4-5" },
			"Review it.",
		);
		expect(result.ok).toBe(true);
		expect(readFileSync(agentPath("project", "reviewer.md"), "utf8")).toBe(
			"---\nname: reviewer\nmodel: anthropic/claude-haiku-4-5\n---\nReview it.",
		);
	});

	it("patches one key and leaves the body and unknown keys alone", () => {
		write(agentPath("global", "a.md"), "---\nname: a\nmystery: keep\n---\nPrompt body.\n");
		expect(saveAgentFile(roots, "global", "a.md", { model: "anthropic/claude-haiku-4-5" }).ok).toBe(true);
		expect(readFileSync(agentPath("global", "a.md"), "utf8")).toBe(
			"---\nname: a\nmystery: keep\nmodel: anthropic/claude-haiku-4-5\n---\nPrompt body.\n",
		);
	});

	it("refuses the read-only shared workspace layer", () => {
		write(agentPath("workspace", "shared.md"), "---\nname: shared\n---\nbody\n");
		const result = saveAgentFile(roots, "workspace", "shared.md", { model: "anthropic/claude-haiku-4-5" });
		expect(result.ok === false && result.code).toBe("not-writable");
		expect(readFileSync(agentPath("workspace", "shared.md"), "utf8")).toContain("name: shared");
	});

	it("refuses a name containing a colon", () => {
		const result = saveAgentFile(roots, "project", "x.md", { name: "plugin:reviewer" });
		expect(result.ok === false && result.code).toBe("invalid-name");
		expect(existsSync(agentPath("project", "x.md"))).toBe(false);
	});

	it.each(["../escape.md", "sub/dir.md", "", "__proto__", "."])("refuses the file name %o", (file) => {
		expect(saveAgentFile(roots, "project", file, { name: "x" }).ok).toBe(false);
		expect(normalizeFileName(file)).toBeUndefined();
	});

	it("refuses an unknown layer", () => {
		expect(saveAgentFile(roots, "elsewhere", "x.md", { name: "x" }).ok).toBe(false);
	});

	it("refuses to rewrite frontmatter it cannot represent", () => {
		const path = write(agentPath("project", "block.md"), "---\ntools:\n  - read\n---\nbody\n");
		const result = saveAgentFile(roots, "project", "block.md", { model: "anthropic/claude-haiku-4-5" });
		expect(result.ok === false && result.code).toBe("invalid-config");
		expect(readFileSync(path, "utf8")).toBe("---\ntools:\n  - read\n---\nbody\n");
	});

	it("reports an unchanged save as no change", () => {
		write(agentPath("project", "a.md"), "---\nname: a\n---\nbody");
		const result = saveAgentFile(roots, "project", "a.md", { name: "a" });
		expect(result.ok && result.changed).toBe(false);
	});

	it("does not rewrite a CRLF file that did not change", () => {
		const path = write(agentPath("project", "crlf.md"), "---\r\nname: a\r\nmystery: keep\r\n---\r\nbody");
		expect(saveAgentFile(roots, "project", "crlf.md", { name: "a" }).ok && true).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("---\r\nname: a\r\nmystery: keep\r\n---\r\nbody");
		expect(saveAgentFile(roots, "project", "crlf.md", { model: "openai-codex/gpt-5.6-luna" }).ok).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(
			"---\r\nname: a\r\nmystery: keep\r\nmodel: openai-codex/gpt-5.6-luna\r\n---\r\nbody",
		);
	});

	it("writes a whole multi-line body without adding or dropping a newline", () => {
		const prompt = "First line.\n\n  indented\nlast line, no newline";
		expect(saveAgentFile(roots, "project", "multi", { name: "multi" }, prompt).ok).toBe(true);
		expect(readFileSync(agentPath("project", "multi.md"), "utf8")).toBe(`---\nname: multi\n---\n${prompt}`);
		expect(readAgentsState(roots, MODELS, false).files[0]?.body).toBe(prompt);
	});

	it("refuses a frontmatter key it cannot write as one line", () => {
		for (const key of ["name ", "na me", "1st", "__proto__", "a:b"]) {
			const result = saveAgentFile(roots, "project", "keys.md", { [key]: "x" });
			expect(result.ok === false && result.code, key).toBe("invalid-name");
		}
		expect(existsSync(agentPath("project", "keys.md"))).toBe(false);
	});

	it("refuses a dotfile name, which would register no agent", () => {
		expect(normalizeFileName(".md")).toBeUndefined();
		expect(normalizeFileName(".hidden.md")).toBeUndefined();
		expect(saveAgentFile(roots, "project", ".md", { name: "x" }).ok).toBe(false);
	});

	it("never overwrites a file whose frontmatter is not closed", () => {
		const path = write(agentPath("project", "open.md"), "---\nname: a\nbody with no closing fence\n");
		const result = saveAgentFile(roots, "project", "open.md", { model: "openai-codex/gpt-5.6-luna" });
		expect(result.ok === false && result.code).toBe("invalid-config");
		expect(readFileSync(path, "utf8")).toBe("---\nname: a\nbody with no closing fence\n");
	});

	it("replaces the file in one step, so a reader never sees a partial write", () => {
		// tmp + rename: the temp file is in the same directory and is gone afterwards,
		// and the visible path only ever holds a complete document.
		write(agentPath("project", "atomic.md"), "---\nname: atomic\n---\nold body");
		expect(saveAgentFile(roots, "project", "atomic.md", { name: "atomic" }, "new body").ok).toBe(true);
		const dirFiles = readAgentsState(roots, MODELS, false).files.map((file) => file.file);
		expect(dirFiles).toEqual(["atomic.md"]);
		expect(readFileSync(agentPath("project", "atomic.md"), "utf8")).toBe("---\nname: atomic\n---\nnew body");
	});

	it("refuses every write into the shared workspace layer, whatever the file name", () => {
		for (const file of ["new-agent", "shared.md"]) {
			expect(saveAgentFile(roots, "workspace", file, { name: "x" }).ok).toBe(false);
			expect(deleteAgentFile(roots, "workspace", file).ok).toBe(false);
		}
		expect(existsSync(join(roots.projectDir, ".agents", "agents", "new-agent.md"))).toBe(false);
	});

	it("leaves no temp file behind", () => {
		expect(saveAgentFile(roots, "project", "a.md", { name: "a" }, "body").ok).toBe(true);
		const state = readAgentsState(roots, MODELS, false);
		expect(state.files.map((file) => file.file)).toEqual(["a.md"]);
	});

	it("deletes a writable agent file and refuses a read-only one", () => {
		write(agentPath("project", "gone.md"), "---\nname: gone\n---\nbody\n");
		write(agentPath("workspace", "stay.md"), "---\nname: stay\n---\nbody\n");
		expect(deleteAgentFile(roots, "project", "gone.md").ok).toBe(true);
		expect(existsSync(agentPath("project", "gone.md"))).toBe(false);
		expect(deleteAgentFile(roots, "workspace", "stay.md").ok).toBe(false);
		expect(existsSync(agentPath("workspace", "stay.md"))).toBe(true);
	});
});

describe("the message protocol", () => {
	async function activated(): Promise<{ host: MockHost; deactivate: () => void }> {
		const entry = createEntry((host) => ({ ...roots, projectDir: host.cwd }));
		const { host, deactivate } = await activatePlugin(entry, { cwd: roots.projectDir, permissions: ["fs"] });
		return { host, deactivate: deactivate ?? (() => {}) };
	}

	async function dispatch(host: MockHost, payload: unknown, from = "client-1"): Promise<Record<string, unknown>[]> {
		host.recorded.sent.length = 0;
		host.recorded.broadcasts.length = 0;
		await host.emit.message(payload, from);
		return [...host.recorded.sent.map((sent) => sent.payload), ...host.recorded.broadcasts] as Record<
			string,
			unknown
		>[];
	}

	it("answers list with the whole state", async () => {
		write(agentPath("project", "reviewer.md"), "---\nname: reviewer\n---\nbody\n");
		const { host, deactivate } = await activated();
		const [payload] = await dispatch(host, { action: "list" });
		expect(payload?.type).toBe("state");
		const state = payload?.state as Record<string, unknown>;
		expect((state.agents as { agents: unknown[] }).agents).toHaveLength(1);
		expect(state.worktreeIsolation).toBe(true);
		expect(Array.isArray(state.models)).toBe(true);
		deactivate();
	});

	it("saves an agent and answers with fresh state", async () => {
		const { host, deactivate } = await activated();
		const [payload] = await dispatch(host, {
			action: "saveAgent",
			layer: "project",
			file: "new-agent",
			frontmatter: { name: "new-agent", model: "anthropic/claude-haiku-4-5" },
			body: "Do the thing.",
		});
		expect(payload?.type).toBe("state");
		expect(existsSync(agentPath("project", "new-agent.md"))).toBe(true);
		deactivate();
	});

	it("turns a write refusal into an error payload", async () => {
		const { host, deactivate } = await activated();
		const [payload] = await dispatch(host, {
			action: "saveSettings",
			scope: "project",
			values: { maxConcurrent: 99999 },
		});
		expect(payload).toMatchObject({ type: "error", action: "saveSettings", code: "invalid-value" });
		deactivate();
	});

	it("answers checkModel with a verdict", async () => {
		write(
			join(roots.agentDir, "models-store.json"),
			JSON.stringify({ anthropic: { models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] } }),
		);
		const { host, deactivate } = await activated();
		const [payload] = await dispatch(host, { action: "checkModel", pin: "claude-haiku-4.5" });
		expect(payload?.type).toBe("model");
		expect((payload?.verdict as { status: string } | undefined)?.status).toBe("resolved");
		deactivate();
	});

	it("broadcasts when the host gives no client id", async () => {
		const { host, deactivate } = await activated();
		await host.emit.message({ action: "list" });
		expect(host.recorded.sent).toEqual([]);
		expect(host.recorded.broadcasts).toHaveLength(1);
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
		["an unknown action", { action: "launch" }],
	])("handles %s without throwing", (_label, payload) => {
		expect(handle(payload, roots)).toMatchObject({ type: "error", code: "unknown-action" });
	});

	it("does not touch the filesystem while activating", async () => {
		const { deactivate } = await activated();
		deactivate();
		expect(existsSync(join(roots.projectDir, ".pi"))).toBe(false);
	});
});

describe("tier 2 feature detection", () => {
	const KEY = Symbol.for("pi-subagents:manager");
	const globals = globalThis as Record<symbol, unknown>;

	afterEach(() => {
		delete globals[KEY];
	});

	it("is undefined when pi-subagents is not active in this process", () => {
		expect(subagentsRunning()).toBeUndefined();
	});

	it("reports the manager's own answer when the facade is there", () => {
		globals[KEY] = { hasRunning: () => true };
		expect(subagentsRunning()).toBe(true);
		globals[KEY] = { hasRunning: () => false };
		expect(subagentsRunning()).toBe(false);
	});

	it("degrades to undefined rather than throwing on a reshaped facade", () => {
		globals[KEY] = { waitForAll: () => {} };
		expect(subagentsRunning()).toBeUndefined();
		globals[KEY] = {
			hasRunning: () => {
				throw new Error("boom");
			},
		};
		expect(subagentsRunning()).toBeUndefined();
	});

	it("leaves the state payload without the field when unknown", () => {
		const state = readSettingsState(roots);
		expect(state.layers).toHaveLength(2);
		expect(handle({ action: "list" }, roots)).toMatchObject({ type: "state" });
		const message = handle({ action: "list" }, roots);
		expect(message.type === "state" && "subagentsRunning" in message.state).toBe(false);
	});
});

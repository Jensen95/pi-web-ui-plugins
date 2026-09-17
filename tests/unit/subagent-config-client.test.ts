/**
 * The pure helpers the subagent-config view uses to normalise the server
 * payload and validate a form. They are exported from src/client.ts so they can
 * run under the node environment; mount() needs a DOM and only its no-op guard
 * is asserted here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handle, toClientState } from "../../plugins/subagent-config/src/index.ts";
import view, {
	SETTING_SPECS,
	blankAgent,
	bool,
	buildAgentPatch,
	describeSetting,
	groupByScope,
	isolationWarning,
	modelOptions,
	modelWarning,
	normalizeState,
	parseSettingValue,
	record,
	shadowedIds,
	str,
	validateAgentName,
} from "../../plugins/subagent-config/src/client.ts";

describe("view entry shape", () => {
	it("exports a mount function the frontend loader requires", () => {
		expect(typeof view.mount).toBe("function");
	});

	it("is a no-op outside a browser instead of throwing", () => {
		const dispose = view.mount(undefined as unknown as HTMLElement, {
			pluginId: "subagent-config",
			send: () => {},
			onData: () => () => {},
		});
		expect(typeof dispose).toBe("function");
		expect(() => dispose()).not.toThrow();
	});
});

describe("tolerant parsing", () => {
	it("turns anything that is not a plain object into an empty record", () => {
		expect(record(null)).toEqual({});
		expect(record([1, 2])).toEqual({});
		expect(record("x")).toEqual({});
		expect(record({ a: 1 })).toEqual({ a: 1 });
	});

	it("renders scalars and lists as strings and falls back otherwise", () => {
		expect(str("a")).toBe("a");
		expect(str(7)).toBe("7");
		expect(str(true)).toBe("true");
		expect(str(["read", "write"])).toBe("read, write");
		expect(str(undefined, "-")).toBe("-");
	});

	it("reads booleans from strings and honours the fallback", () => {
		expect(bool(true)).toBe(true);
		expect(bool("false")).toBe(false);
		expect(bool(undefined, true)).toBe(true);
		expect(bool(3)).toBe(false);
	});
});

describe("normalizeState", () => {
	it("survives a missing or malformed payload", () => {
		const state = normalizeState(undefined);
		expect(state.agents).toEqual([]);
		expect(state.settings).toHaveLength(SETTING_SPECS.length);
		expect(state.running).toBeUndefined();
	});

	it("unwraps the state envelope and reads frontmatter fields", () => {
		const state = normalizeState({
			type: "state",
			state: {
				agents: [
					{
						id: "a",
						path: "/w/.pi/agents/reviewer.md",
						scope: "project",
						writable: true,
						frontmatter: { name: "reviewer", model: "anthropic/x", thinking: "high", isolation: "worktree" },
						modelResolves: false,
					},
				],
			},
		});
		expect(state.agents[0]).toMatchObject({
			name: "reviewer",
			scope: "project",
			model: "anthropic/x",
			thinking: "high",
			isolation: "worktree",
			modelResolves: false,
			enabled: true,
		});
	});

	it("falls back to the filename when no name is declared", () => {
		const state = normalizeState({ agents: [{ path: "/w/.pi/agents/explore.md" }] });
		expect(state.agents[0].name).toBe("explore");
	});

	it("accepts the models store both as a map and as a list", () => {
		const fromMap = normalizeState({ models: { anthropic: { models: [{ id: "opus", name: "Opus" }] } } });
		expect(fromMap.models).toEqual([{ provider: "anthropic", models: [{ value: "anthropic/opus", label: "Opus" }] }]);
		const fromList = normalizeState({ models: [{ provider: "openai-codex", models: [{ id: "gpt-5.6-luna" }] }] });
		expect(fromList.models[0].models[0]).toEqual({ value: "openai-codex/gpt-5.6-luna", label: "gpt-5.6-luna" });
	});

	it("fills every sanitized key even when the server sends a partial map", () => {
		const state = normalizeState({ settings: { maxConcurrent: { value: 4, source: "project" } } });
		expect(state.settings.map((setting) => setting.key)).toEqual(SETTING_SPECS.map((spec) => spec.key));
		expect(state.settings.find((setting) => setting.key === "maxConcurrent")).toMatchObject({
			value: 4,
			source: "project",
		});
		expect(state.settings.find((setting) => setting.key === "graceTurns")?.source).toBe("default");
	});

	it("reads the optional live flag from either shape and leaves it unknown otherwise", () => {
		expect(normalizeState({ running: true }).running).toBe(true);
		expect(normalizeState({ live: { hasRunning: false } }).running).toBe(false);
		expect(normalizeState({ live: {} }).running).toBeUndefined();
	});
});

describe("shadowing", () => {
	it("marks every duplicate name but the last load", () => {
		const state = normalizeState({
			agents: [
				{ id: "p", name: "reviewer", scope: "project" },
				{ id: "g", name: "reviewer", scope: "global" },
				{ id: "o", name: "other", scope: "global" },
			],
		});
		expect(state.agents.map((agent) => agent.shadowed)).toEqual([true, false, false]);
		expect([...shadowedIds(state.agents)]).toEqual(["p"]);
	});
});

describe("groupByScope", () => {
	it("orders scopes by load order and drops empty groups", () => {
		const state = normalizeState({
			agents: [
				{ id: "g", scope: "global" },
				{ id: "p", scope: "project" },
			],
		});
		expect(groupByScope(state.agents).map((group) => group.scope)).toEqual(["project", "global"]);
	});
});

describe("modelWarning", () => {
	it("says nothing when there is no pin or the pin resolves", () => {
		expect(modelWarning({ model: "", modelResolves: false })).toBe("");
		expect(modelWarning({ model: "anthropic/opus", modelResolves: true })).toBe("");
	});

	it("names the silent fallback when the pin does not resolve", () => {
		expect(modelWarning({ model: "anthropic/typo", modelResolves: false })).toContain(
			"silently inherit the parent model",
		);
	});
});

describe("isolationWarning", () => {
	it("warns only when worktree isolation is switched off project-wide", () => {
		expect(isolationWarning({ isolation: "worktree" }, false)).toContain("silently dropped");
		expect(isolationWarning({ isolation: "worktree" }, true)).toBe("");
		expect(isolationWarning({ isolation: "worktree" }, undefined)).toBe("");
		expect(isolationWarning({ isolation: "off" }, false)).toBe("");
	});
});

describe("validateAgentName", () => {
	it("accepts an ordinary name", () => {
		expect(validateAgentName(" reviewer ")).toBe("");
	});

	it("rejects a colon, because the extension skips such a file", () => {
		expect(validateAgentName("a:b")).toContain(":");
	});

	it("rejects empty, path-like and reserved names", () => {
		expect(validateAgentName("  ")).not.toBe("");
		expect(validateAgentName("a/b")).not.toBe("");
		expect(validateAgentName("__proto__")).not.toBe("");
	});
});

describe("parseSettingValue", () => {
	it("treats empty text as unset", () => {
		expect(parseSettingValue("maxConcurrent", "  ")).toEqual({ ok: true, value: undefined });
	});

	it("enforces the sanitizer ceilings the extension applies silently", () => {
		expect(parseSettingValue("maxConcurrent", "1")).toEqual({ ok: true, value: 1 });
		expect(parseSettingValue("maxConcurrent", "0").ok).toBe(false);
		expect(parseSettingValue("maxSubagentDepth", "17").ok).toBe(false);
		expect(parseSettingValue("maxSubagentDepth", "0")).toEqual({ ok: true, value: 0 });
		expect(parseSettingValue("graceTurns", "1.5").ok).toBe(false);
	});

	it("parses booleans and plain strings", () => {
		expect(parseSettingValue("worktreeIsolation", "false")).toEqual({ ok: true, value: false });
		expect(parseSettingValue("worktreeIsolation", "yes").ok).toBe(false);
		expect(parseSettingValue("fallbackSubagent", " Explore ")).toEqual({ ok: true, value: "Explore" });
	});

	it("refuses a key the extension does not sanitize", () => {
		expect(parseSettingValue("nope", "1").ok).toBe(false);
	});

	it("covers exactly the twenty-four documented keys", () => {
		expect(SETTING_SPECS).toHaveLength(24);
	});
});

describe("modelOptions", () => {
	const models = [{ provider: "anthropic", models: [{ value: "anthropic/opus", label: "Opus" }] }];

	it("labels each option with its provider-qualified id", () => {
		expect(modelOptions(models, "")).toEqual([
			{ group: "anthropic", options: [{ value: "anthropic/opus", label: "Opus (anthropic/opus)" }] },
		]);
	});

	it("keeps an unknown current pin selectable so saving does not erase it", () => {
		const groups = modelOptions(models, "anthropic/typo", false);
		expect(groups[0]).toEqual({
			group: "Current pin (unavailable)",
			options: [{ value: "anthropic/typo", label: "anthropic/typo" }],
		});
	});

	it("does not duplicate a pin that is already in the store", () => {
		expect(modelOptions(models, "anthropic/opus")).toHaveLength(1);
	});
});

describe("the server payload this view is wired to", () => {
	// Built by the real server module, so a field renamed on either side fails here
	// rather than in the browser.
	function serverState(): ReturnType<typeof toClientState> {
		const dir = mkdtempSync(join(tmpdir(), "subagent-config-view-"));
		try {
			const roots = { home: dir, agentDir: join(dir, "agent"), projectDir: join(dir, "project") };
			const write = (path: string, text: string): void => {
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, text, "utf8");
			};
			write(
				join(roots.agentDir, "models-store.json"),
				JSON.stringify({ "openai-codex": { models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] } }),
			);
			write(join(roots.agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 2 }));
			write(join(roots.projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 4 }));
			write(
				join(roots.projectDir, ".pi", "agents", "reviewer.md"),
				"---\nname: reviewer\nmodel: openai-codex/typo\nthinking: high\ntools: [read, grep]\nmystery: keep\n---\nPrompt.",
			);
			write(join(roots.projectDir, ".agents", "agents", "shared.md"), "---\nname: shared\n---\nPrompt.");
			return toClientState(roots);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("flattens agent files, their layers and their model verdicts", () => {
		const state = normalizeState({ type: "state", state: serverState() });
		const reviewer = state.agents.find((agent) => agent.name === "reviewer");
		expect(reviewer).toMatchObject({
			file: "reviewer.md",
			scope: "project",
			writable: true,
			thinking: "high",
			tools: "read, grep",
			model: "openai-codex/typo",
			modelResolves: false,
			blocked: false,
			body: "Prompt.",
		});
		expect(reviewer?.unknown).toEqual([{ key: "mystery", value: "keep" }]);
		expect(modelWarning(reviewer!)).toContain("silently inherit");
		expect(state.agents.find((agent) => agent.name === "shared")?.writable).toBe(false);
		expect(state.layers.map((layer) => layer.scope)).toEqual(["global", "workspace", "project"]);
		expect(state.layers.every((layer) => layer.path !== "")).toBe(true);
	});

	it("keeps the model store, the settings merge and both settings paths", () => {
		const state = normalizeState({ type: "state", state: serverState() });
		expect(state.models).toEqual([
			{ provider: "openai-codex", models: [{ value: "openai-codex/gpt-5.6-luna", label: "GPT-5.6 Luna" }] },
		]);
		expect(state.settings.find((setting) => setting.key === "maxConcurrent")).toMatchObject({
			value: 4,
			source: "project",
			globalValue: 2,
			projectValue: 4,
		});
		expect(state.settings.find((setting) => setting.key === "graceTurns")?.source).toBe("default");
		expect(state.settingsProjectPath).toContain(".pi/subagents.json");
		expect(state.settingsGlobalPath).toContain("subagents.json");
		expect(state.settings).toHaveLength(SETTING_SPECS.length);
	});
});

describe("the actions this view sends", () => {
	// The exact payloads mount() puts on the wire, answered by the real server
	// handler: an action renamed on either side fails here.
	it("are the ones the server implements", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-config-wire-"));
		try {
			const roots = { home: dir, agentDir: join(dir, "agent"), projectDir: join(dir, "project") };
			const built = buildAgentPatch({
				name: "reviewer",
				description: "Reviews code",
				model: "",
				thinking: "high",
				isolation: "",
				tools: "read, grep",
				maxTurns: "5",
				enabled: true,
			});
			expect(built.ok).toBe(true);
			const saved = handle(
				{
					action: "saveAgent",
					layer: "project",
					file: "reviewer.md",
					frontmatter: built.ok ? built.patch : {},
					body: "Prompt.",
				},
				roots,
			);
			expect(saved.type).toBe("state");
			const state = normalizeState(saved);
			const agent = state.agents.find((candidate) => candidate.name === "reviewer");
			expect(agent).toMatchObject({ file: "reviewer.md", scope: "project", thinking: "high", maxTurns: "5" });

			const parsed = parseSettingValue("maxConcurrent", "3");
			expect(parsed).toEqual({ ok: true, value: 3 });
			const settings = handle({ action: "saveSettings", scope: "project", values: { maxConcurrent: 3 } }, roots);
			expect(settings.type).toBe("state");
			expect(normalizeState(settings).settings.find((setting) => setting.key === "maxConcurrent")).toMatchObject({
				value: 3,
				source: "project",
			});

			// Clearing a key is the same action with a null value.
			expect(handle({ action: "saveSettings", scope: "project", values: { maxConcurrent: null } }, roots).type).toBe(
				"state",
			);
			expect(handle({ action: "deleteAgent", layer: "project", file: "reviewer.md" }, roots).type).toBe("state");
			expect(handle({ action: "list" }, roots).type).toBe("state");
			expect(normalizeState(handle({ action: "list" }, roots)).agents).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildAgentPatch", () => {
	const form = {
		name: "reviewer",
		description: "",
		model: "",
		thinking: "",
		isolation: "",
		tools: "",
		maxTurns: "",
		enabled: true,
	};

	it("deletes a cleared field instead of writing an empty value", () => {
		const built = buildAgentPatch(form);
		expect(built.ok && built.patch).toEqual({
			name: "reviewer",
			description: null,
			model: null,
			thinking: null,
			isolation: null,
			tools: null,
			max_turns: null,
			enabled: null,
		});
	});

	it("sends a list as a list and a turn budget as a number", () => {
		const built = buildAgentPatch({ ...form, tools: " read , grep ,", maxTurns: "12", enabled: false });
		expect(built.ok && built.patch).toMatchObject({ tools: ["read", "grep"], max_turns: 12, enabled: false });
	});

	it("refuses a colon in the name and a non-numeric turn budget", () => {
		expect(buildAgentPatch({ ...form, name: "a:b" }).ok).toBe(false);
		expect(buildAgentPatch({ ...form, maxTurns: "lots" }).ok).toBe(false);
	});
});

describe("blankAgent", () => {
	it("is a writable empty draft in the chosen layer", () => {
		expect(blankAgent("project")).toMatchObject({ scope: "project", writable: true, file: "", enabled: true });
	});
});

describe("describeSetting", () => {
	it("shows the effective value and the layer that set it", () => {
		expect(
			describeSetting({ key: "maxConcurrent", value: 4, source: "project", projectValue: 4, globalValue: 2 }),
		).toBe("4 - project");
		expect(
			describeSetting({
				key: "showCost",
				value: undefined,
				source: "default",
				projectValue: undefined,
				globalValue: undefined,
			}),
		).toBe("(unset - extension default) - default");
	});
});

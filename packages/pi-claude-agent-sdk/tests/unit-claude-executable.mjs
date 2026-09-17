/**
 * Fable 5.1 400s on the SDK's bundled 2.1.141 CLI. Resolution must pick a
 * current PATH claude when the bundle is too old, honor an explicit config
 * path, and fail with the version requirement instead of repeating CC's 400.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
	compareClaudeVersion,
	findExecutableOnPath,
	formatClaudeVersion,
	parseClaudeVersion,
	readBundledClaudeCodeVersion,
	readClaudeCliVersion,
	resolveClaudeCodeExecutable,
} from "../src/claude-executable.js";

const require = createRequire(import.meta.url);

const v = (text) => parseClaudeVersion(text);
const bundled141 = () => v("2.1.141");
const bundled257 = () => v("2.1.257");

function resolve(modelId, configured, deps) {
	return resolveClaudeCodeExecutable(modelId, configured, deps);
}

describe("parseClaudeVersion", () => {
	it("reads claude --version output", () => {
		assert.deepEqual(v("2.1.257 (Claude Code)"), { major: 2, minor: 1, patch: 257 });
	});

	it("returns undefined when no x.y.z is present", () => {
		assert.equal(v("not a version"), undefined);
	});
});

describe("compareClaudeVersion", () => {
	it("orders patch, then minor, then major", () => {
		assert.ok(compareClaudeVersion(v("2.1.251"), v("2.1.141")) > 0);
		assert.ok(compareClaudeVersion(v("2.1.141"), v("2.1.251")) < 0);
		assert.equal(compareClaudeVersion(v("2.1.251"), v("2.1.251")), 0);
		assert.ok(compareClaudeVersion(v("2.2.0"), v("2.1.251")) > 0);
	});
});

describe("readBundledClaudeCodeVersion", () => {
	it("reads claudeCodeVersion from the installed SDK", () => {
		const pkgPath = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		assert.equal(formatClaudeVersion(readBundledClaudeCodeVersion()), pkg.claudeCodeVersion);
	});
});

describe("findExecutableOnPath", () => {
	it("returns the first executable named on PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-path-"));
		try {
			const first = join(root, "first");
			const second = join(root, "second");
			mkdirSync(first);
			mkdirSync(second);
			const hit = join(first, "claude");
			writeFileSync(hit, "#!/bin/sh\n");
			writeFileSync(join(second, "claude"), "#!/bin/sh\n");
			chmodSync(hit, 0o755);
			chmodSync(join(second, "claude"), 0o755);
			assert.equal(findExecutableOnPath("claude", { PATH: `${first}${delimiter}${second}` }), hit);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("readClaudeCliVersion", () => {
	it("parses a fake claude --version script", () => {
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-ver-"));
		try {
			const bin = join(root, "claude");
			writeFileSync(bin, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n");
			chmodSync(bin, 0o755);
			assert.deepEqual(readClaudeCliVersion(bin), { major: 2, minor: 1, patch: 257 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveClaudeCodeExecutable", () => {
	it("uses bundled when it meets the model minimum", () => {
		const r = resolve("claude-fable-5-1", undefined, {
			bundledVersion: bundled257,
			findOnPath: () => { throw new Error("PATH should not be consulted"); },
			readVersion: () => { throw new Error("PATH version should not be read"); },
		});
		assert.equal(r.path, undefined);
		assert.equal(r.error, undefined);
		assert.equal(r.source, "bundled");
	});

	it("uses PATH claude when bundled is too old", () => {
		const r = resolve("claude-fable-5-1", undefined, {
			bundledVersion: bundled141,
			findOnPath: () => "/home/you/bin/claude",
			readVersion: (p) => p === "/home/you/bin/claude" ? v("2.1.257") : undefined,
		});
		assert.equal(r.path, "/home/you/bin/claude");
		assert.equal(r.source, "path");
		assert.equal(r.error, undefined);
	});

	it("uses PATH claude for the [1m] cli id", () => {
		const r = resolve("claude-fable-5-1[1m]", undefined, {
			bundledVersion: bundled141,
			findOnPath: () => "/usr/bin/claude",
			readVersion: () => v("2.1.251"),
		});
		assert.equal(r.path, "/usr/bin/claude");
		assert.equal(r.source, "path");
	});

	it("errors when bundled is too old and PATH is missing", () => {
		const r = resolve("claude-fable-5-1", undefined, {
			bundledVersion: bundled141,
			findOnPath: () => undefined,
			readVersion: () => undefined,
		});
		assert.match(r.error, /2\.1\.251/);
		assert.match(r.error, /bundled CLI is 2\.1\.141/);
		assert.match(r.error, /pathToClaudeCodeExecutable/);
		assert.equal(r.path, undefined);
	});

	it("errors when PATH claude is also too old", () => {
		const r = resolve("claude-fable-5-1", undefined, {
			bundledVersion: bundled141,
			findOnPath: () => "/usr/bin/claude",
			readVersion: () => v("2.1.200"),
		});
		assert.match(r.error, /2\.1\.251/);
		assert.match(r.error, /bundled CLI is 2\.1\.141/);
	});

	it("honors configured path even when bundled is new enough", () => {
		const r = resolve("claude-haiku-4-5", "/opt/claude", {
			bundledVersion: bundled257,
			findOnPath: () => "/usr/bin/claude",
			readVersion: () => v("2.1.257"),
		});
		assert.equal(r.path, "/opt/claude");
		assert.equal(r.source, "configured");
	});

	it("rejects a configured path that is too old for the model", () => {
		const r = resolve("claude-fable-5-1", "/old/claude", {
			bundledVersion: bundled141,
			findOnPath: () => "/new/claude",
			readVersion: (p) => p === "/old/claude" ? bundled141() : v("2.1.257"),
		});
		assert.match(r.error, /\/old\/claude/);
		assert.match(r.error, /2\.1\.141/);
		assert.equal(r.path, undefined);
		assert.equal(r.source, "configured");
	});

	it("uses a configured path whose version cannot be read", () => {
		const r = resolve("claude-fable-5-1", "/wrapper/claude", {
			bundledVersion: bundled141,
			findOnPath: () => undefined,
			readVersion: () => undefined,
		});
		assert.equal(r.path, "/wrapper/claude");
		assert.equal(r.error, undefined);
		assert.equal(r.source, "configured");
	});

	it("does not look at PATH for models with no minimum", () => {
		let looked = false;
		const r = resolve("claude-opus-5", undefined, {
			bundledVersion: bundled141,
			findOnPath: () => { looked = true; return "/usr/bin/claude"; },
			readVersion: () => v("2.1.257"),
		});
		assert.equal(looked, false);
		assert.equal(r.path, undefined);
		assert.equal(r.source, "bundled");
	});

	it("uses PATH when bundled version is unknown and PATH meets the minimum", () => {
		const r = resolve("claude-fable-5-1", undefined, {
			bundledVersion: () => undefined,
			findOnPath: () => "/usr/bin/claude",
			readVersion: () => v("2.1.257"),
		});
		assert.equal(r.path, "/usr/bin/claude");
		assert.equal(r.source, "path");
	});

	it("falls through to bundled when version is unknown and PATH is missing", () => {
		const r = resolve("claude-fable-5-1", undefined, {
			bundledVersion: () => undefined,
			findOnPath: () => undefined,
			readVersion: () => undefined,
		});
		assert.equal(r.path, undefined);
		assert.equal(r.error, undefined);
		assert.equal(r.source, "bundled");
	});
});

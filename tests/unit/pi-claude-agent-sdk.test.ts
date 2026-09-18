import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	profileProviderId,
	resolveProfiles,
	type ProfilesConfig,
} from "../../packages/pi-claude-agent-sdk/src/profiles.ts";
import { buildClaudeChildEnv } from "../../packages/pi-claude-agent-sdk/src/child-env.ts";

describe("Claude login profiles", () => {
	const config: ProfilesConfig = {
		profiles: {
			personal: { claudeDir: "~/.claude-personal" },
			work: { claudeDir: "~/.claude-work" },
		},
	};

	it("creates one stable picker provider per configured folder", () => {
		expect(resolveProfiles(config, "/home/alice")).toEqual([
			{ name: "personal", providerId: "claude-bridge-personal", claudeDir: "/home/alice/.claude-personal" },
			{ name: "work", providerId: "claude-bridge-work", claudeDir: "/home/alice/.claude-work" },
		]);
		expect(profileProviderId("default")).toBe("claude-bridge");
	});

	it("does not create a provider until a folder profile is configured", () => {
		expect(resolveProfiles({}, "/home/alice")).toEqual([]);
	});

	it("rejects unsafe names, relative folders, and shared folders", () => {
		expect(() => resolveProfiles({ profiles: { "Work Login": { claudeDir: "/one" } } }, "/home/alice")).toThrow(
			/profile name/i,
		);
		expect(() => resolveProfiles({ profiles: { work: { claudeDir: "relative" } } }, "/home/alice")).toThrow(
			/absolute/i,
		);
		expect(() =>
			resolveProfiles(
				{ profiles: { one: { claudeDir: "~/.claude" }, two: { claudeDir: "/home/alice/.claude" } } },
				"/home/alice",
			),
		).toThrow(/distinct/i);
	});

	it("rejects two paths to the same folder through a symlink", () => {
		const root = mkdtempSync(join(tmpdir(), "claude-profile-"));
		const real = join(root, "real");
		const alias = join(root, "alias");
		mkdirSync(real);
		symlinkSync(real, alias, "dir");
		try {
			expect(() =>
				resolveProfiles({
					profiles: { personal: { claudeDir: real }, work: { claudeDir: alias } },
				}),
			).toThrow(/distinct/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("folder-backed Claude child environment", () => {
	it("uses only the selected folder login and removes inherited credentials", () => {
		const env = buildClaudeChildEnv(
			{
				CLAUDE_CONFIG_DIR: "/wrong-folder",
				CLAUDE_CODE_OAUTH_TOKEN: "wrong-oauth",
				ANTHROPIC_API_KEY: "wrong-key",
				ANTHROPIC_AUTH_TOKEN: "wrong-bearer",
				ANTHROPIC_BASE_URL: "https://wrong.invalid",
			},
			"/home/alice/.claude-work",
		);
		expect(env.CLAUDE_CONFIG_DIR).toBe("/home/alice/.claude-work");
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
	});
});

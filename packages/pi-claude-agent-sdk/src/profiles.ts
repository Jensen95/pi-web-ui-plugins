import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PROVIDER_ID } from "./convert.js";

export interface ClaudeProfileConfig {
	claudeDir: string;
}

export interface ProfilesConfig {
	profiles?: Record<string, ClaudeProfileConfig>;
}

export interface ClaudeProfile {
	name: string;
	providerId: string;
	claudeDir: string;
}

const PROFILE_NAME = /^[a-z][a-z0-9-]*$/;

export function profileProviderId(name: string): string {
	if (!PROFILE_NAME.test(name))
		throw new Error(`profile name "${name}" must use lowercase letters, numbers, or hyphens`);
	return name === "default" ? PROVIDER_ID : `${PROVIDER_ID}-${name}`;
}

function profileDirectory(value: unknown, home: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("profile claudeDir must be a non-empty path");
	let expanded = value;
	if (value === "~") expanded = home;
	else if (value.startsWith("~/")) expanded = join(home, value.slice(2));
	if (!isAbsolute(expanded)) throw new Error(`profile claudeDir must be absolute: ${value}`);
	const absolute = resolve(expanded);
	// A configured, manually logged-in folder exists. Canonicalize it so a
	// symlink cannot register two providers for the same credentials and sessions.
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/** Resolve each explicitly configured Claude Code login folder into a picker provider. */
export function resolveProfiles(config: ProfilesConfig, home = homedir()): ClaudeProfile[] {
	const seenDirectories = new Set<string>();
	return Object.entries(config.profiles ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, profile]) => {
			const claudeDir = profileDirectory(profile?.claudeDir, home);
			if (seenDirectories.has(claudeDir)) throw new Error(`profile folders must be distinct: ${claudeDir}`);
			seenDirectories.add(claudeDir);
			return { name, providerId: profileProviderId(name), claudeDir };
		});
}

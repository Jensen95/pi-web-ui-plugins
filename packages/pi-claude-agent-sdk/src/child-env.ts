// Applied to every Claude Code subprocess the bridge spawns. Pi owns both its
// tool surface and context compaction, so Claude Code must not add either one.
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

const AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN",
	"ANTHROPIC_IDENTITY_TOKEN_FILE",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_CUSTOM_OAUTH_URL",
	"CLAUDE_CODE_OAUTH_CLIENT_ID",
	"CLAUDE_CODE_API_KEY_HELPER",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_VERTEX",
] as const;

/** Build a child environment that can authenticate only through one Claude Code folder. */
export function buildClaudeChildEnv(base: NodeJS.ProcessEnv, claudeDir: string): NodeJS.ProcessEnv {
	if (!claudeDir.trim()) throw new Error("Claude profile folder must not be blank");
	const env: NodeJS.ProcessEnv = { ...base, ...CC_CHILD_ENV };
	for (const key of AUTH_ENV_KEYS) delete env[key];
	env.CLAUDE_CONFIG_DIR = claudeDir;
	return env;
}

# pi-usage-aware-router

A small pi extension that adds `UsageAwareAgent`. It selects an available subscription-backed model, then calls `@tintinweb/pi-subagents` through its public event RPC. Install both extensions.

```sh
pi install "$PWD/packages/pi-usage-aware-router"
```

Optional global `~/.pi/agent/usage-router.json` settings are overridden key-by-key by `.pi/usage-router.json`:

```json
{
	"claudeProfiles": ["personal", "work"],
	"maxUtilization": 0.9,
	"openaiRefreshMs": 60000,
	"tiers": { "balanced": ["openai-codex/gpt-5.6-terra", "claude-bridge/claude-sonnet-5"] }
}
```

Use `model: "provider/model"` for an exact pin; it bypasses routing. Without a pin, use `tier` (`fast`, `balanced`, or `strong`; default `balanced`). Claude observations come from the installed Claude bridge event stream. OpenAI usage is a best-effort live request using the local Codex OAuth credential. Observations are memory-only, are not reservations, and unavailable/malformed telemetry is treated as unknown.

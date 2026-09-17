# Subagent Config (subagent-config)

A Settings page for the configuration of
[`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents),
none of which is editable anywhere else in pi-web-ui. It has no top-bar tab
(`"view": false`); it lives in **Settings -> Subagent Config**. That page entry
needs the `ui` permission: pi-web-ui drops a plugin's whole `ui` block when it
declares permissions without a `ui` family.

It manages the extension by editing the files the extension reads. It never
imports the package, never spawns an agent and never puts anything on pi's event
bus.

## The bug it exists for

A subagent's model is resolved as
`options.model ?? resolveDefaultModel(ctx.model, registry, agentConfig?.model)`,
and `agentConfig.model` comes **only** from an agent file's `model:`
frontmatter. With no agent files there is no pin, so every subagent inherits the
main session model - which is why a provider dashboard can show that the model
you meant to use was never called. Pinning `model:` in an agent file is the fix,
and this page is where you do it.

The same resolution is tolerant, and tolerant means silent: a pin that does not
resolve is not an error, it falls back to the parent model and looks exactly
like a pin that worked. So every pin shown here is checked against
`~/.pi/agent/models-store.json` first, and an unresolvable one is labelled
**"will silently inherit the parent model"** instead of being saved as if it
were fine.

## What it edits

**Agent files** - markdown with YAML frontmatter, loaded in this order (later
wins a name clash):

1. `<agent dir>/agents/*.md` - global, **editable**
2. `<cwd>/.agents/agents/*.md` - shared cross-tool workspace location,
   **read-only here** (shown with its contents, never written)
3. `<cwd>/.pi/agents/*.md` - project, **editable**, and where `/agents` writes

`<agent dir>` is `$PI_CODING_AGENT_DIR` when set, `~/.pi/agent` otherwise. The
frontmatter fields the extension parses are offered as form controls; the
markdown body after the frontmatter is the agent's system prompt. A file named
after a built-in type (`general-purpose`, `Explore`, `Plan`) overrides that
built-in, and `enabled: false` is how a built-in is hidden for one project.

**`subagents.json`** - the 24 keys the extension's `sanitize()` keeps, merged
`{...global, ...project}` per key:

- `<agent dir>/subagents.json` - global manual defaults
- `<cwd>/.pi/subagents.json` - project, what `/agents -> Settings` writes

Each key is shown with its effective value, the layer it came from, and both
layers' own values. The sanitizer's ceilings (`maxConcurrent` 1..1024,
`maxConcurrentForeground` 0..1024, `defaultMaxTurns` 0..10000, `graceTurns`
1..1000, `maxSubagentDepth` 0..16) are enforced in the form and again on the
server, because the extension drops an out-of-range value without a word.

## No restart, no `/reload`

pi-subagents reloads its agent files on activation **and on every `Agent` call**,
so an edit made here applies to the next subagent that starts. Nothing needs
restarting and `/reload` is not involved. The page says so.

`subagents.json` is read when the extension loads its settings, so a change
there follows the extension's own refresh, not this plugin's write.

## Silent failures it surfaces

- **An unresolvable `model:` pin** inherits the parent model without a warning.
  The pin is resolved the way the extension resolves it (exact `provider/id`,
  then fuzzy with `.` and `-` interchangeable and a trailing `-YYYYMMDD`
  optional, then the bare id under any provider) and reported as resolved,
  redirected or unavailable. One caveat: the extension scores only models whose
  provider has credentials, while `models-store.json` lists everything ever
  fetched, so this is "what the resolver would pick", not a promise about auth.
- **`isolation: worktree` is dropped project-wide** when `subagents.json`
  `worktreeIsolation` is off - no error, no note. That switch is shown next to
  the per-agent isolation field, and any agent it silences is flagged.
- **A `name:` containing `":"` makes the extension skip the whole file.** Such a
  file is flagged in the list, and a save with a colon is refused on both sides.
- **A value outside the sanitizer's range is discarded**, so it is rejected
  before it reaches disk.
- **A shadowed agent** (the same name in two layers) is marked, since only the
  last load registers.

## Writing

Agent files are patched line by line: a changed key replaces its own line, a
cleared one is removed, a new one is appended, and every other byte - keys this
plugin does not know, comments, blank lines, quoting, CRLF endings, the body,
the missing trailing newline - is preserved. Frontmatter this plugin cannot
represent as flat `key: value` lines (block sequences, nested mappings) is
served read-only rather than flattened through a lossy serializer, and a
malformed file is reported instead of overwritten. Every write is
tmp + rename in the target directory, so a reader never sees half a file.

## Tier 2: live status, and what it is not

pi-subagents publishes a small facade at
`globalThis[Symbol.for("pi-subagents:manager")]` in the same process pi-web-ui
loads plugins into. When it is there, the page shows one line: whether subagents
are running right now. When it is not - extension absent, disabled, or a version
that moved the symbol - the line is hidden and everything else works unchanged.

It does **not** list running agents, stop them, or spawn them. Those live on the
in-process `pi.events` RPC bus, which a pi-web-ui plugin cannot address, and the
manager facade exposes only `hasRunning()` safely. A missing symbol is never
treated as a fault and never throws; the package is never imported.

## Install

The compiled `index.mjs` and `client/entry.mjs` are build output and are not
committed, so a bare clone of this repo is not installable. Take the plugin from
a GitHub Release archive that CI built, or build it yourself and copy it in:

```sh
npm ci && npm run build:subagent-config
cp -r plugins/subagent-config "$HOME/.pi-web/plugins/subagent-config"
```

The manifest declares `fs`; the plugin reads and writes with Node's own `fs`,
because `host.fs` is anchored to the workspace and cannot reach the pi agent
directory.

## Layout

```text
manifest.json          committed metadata (English)
src/models.ts          models-store.json and the pin resolver
src/settings.ts        subagents.json layers, the sanitizer, the write path
src/agents.ts          agent file discovery, frontmatter round-trip, the write path
src/index.ts           server entry: message protocol -> the three modules
src/client.ts          browser view (plain DOM, no npm imports)
index.mjs              generated from src/index.ts   (gitignored)
client/entry.mjs       generated from src/client.ts  (gitignored)
```

Every path is derived from an injected `{home, agentDir, projectDir}` root,
which is what lets the unit tests run against a temp directory instead of the
developer's real `~/.pi`.

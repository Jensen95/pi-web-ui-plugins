# MCP Servers (mcp-manager)

A web front-end for the MCP servers that
[pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter) already runs in
[pi](https://github.com/badlogic/pi-mono). It **manages** the adapter, it does
not replace it: there is no MCP protocol client, no OAuth flow, no keyring and
no server launching in here. pi-mcp-adapter keeps doing the hard parts; this
plugin reads the same config files it reads and writes the one file it is
allowed to write.

## What it does

- **Lists the effective servers** across the whole precedence chain, each with
  its resolved definition (`command` + `args`, or `url`), whether it is
  currently disabled, and which file it came from.
- **Enables and disables** a server. Exactly like `/mcp enable|disable`, this
  persists only the `disabled` field into the project-local `.pi/mcp.json`:
  disabling writes `{"disabled": true}`, enabling removes the project flag, or
  writes `false` when a lower layer is itself disabled and has to be overridden.
  Unrelated keys in that file survive, and the file a definition came from is
  never rewritten.
- **Adds and removes** project-local servers, again in `.pi/mcp.json` only.
- **Shows every config layer** with its path, whether it exists, how many
  servers it defines, and why it could not be parsed if it could not.

Changes take effect after you run `/reload` in pi - the adapter refreshes its
tool surfaces on reload. The view says so at the top.

## Config precedence it honours

Lowest first, later layers win (pi-mcp-adapter's order):

1. `~/.config/mcp/mcp.json` - user-global standard MCP
2. `~/.agents/mcp.json` - user-global tool-agnostic MCP
3. `~/.agents/mcp/mcp.json` - user-global tool-agnostic MCP (nested)
4. `<pi agent dir>/mcp.json` - Pi global override (`~/.pi/agent` by default,
   `$PI_CODING_AGENT_DIR` when set)
5. `<project>/.mcp.json` - project standard MCP
6. `<project>/.pi/mcp.json` - project Pi override, **the only file this plugin
   writes**

A server is disabled when its merged definition has `disabled: true`; anything
else (a missing flag, `false`, `"true"`, `null`) counts as enabled. When a
higher layer switches a server from a command to a url, or changes its url, the
transport-specific and url-bound credential fields of the lower layer are
dropped from the definition shown here, so the view describes the server the
adapter would actually start.

## Secrets

Env values, HTTP header values, bearer tokens and OAuth client secrets are
masked (`***`) before anything is sent to the browser. Variable and header
_names_ stay visible so you can see what a server expects. This plugin never
copies a credential from one config layer into another, and never writes
anywhere except `.pi/mcp.json`.

## Install

The compiled `index.mjs` and `client/entry.mjs` are build output and are not
committed, so a bare clone of this repo is not installable. Take the plugin from
a GitHub Release archive that CI built, or build it yourself and copy it in:

```sh
npm ci && npm run build:mcp-manager
cp -r plugins/mcp-manager "$HOME/.pi-web/plugins/mcp-manager"
```

(`<dataDir>/plugins/mcp-manager/` is wherever your pi-web-ui keeps its data.)
The manifest declares the `fs` capability;
the plugin reads and writes config files with Node's own `fs`, because
`host.fs` is anchored to the workspace and cannot reach `~/.config`, `~/.agents`
or the pi agent directory.

## Deliberately not included

- No MCP handshake, no `tools/list`, no connection status. Showing "connected"
  would mean launching servers, which is the adapter's job and its `/mcp`
  panel's job.
- No `/mcp setup` equivalent: no host-config import (Cursor, Claude, Codex,
  VS Code, ...), no OAuth, no preset gallery, no tool allow-lists. Use
  `pi-mcp-adapter init` or `/mcp setup` in pi for those.
- No writes to `~/.config/mcp/mcp.json`, `~/.agents/*`, the Pi global override
  or `<project>/.mcp.json`. A server defined in one of those can be disabled
  from here, but not removed or edited - the Remove button only appears for
  servers that live in `.pi/mcp.json`.
- No agent tool. The adapter already exposes one low-token proxy tool; a second
  one would only compete with it.

## Layout

```
manifest.json          committed metadata (English)
src/config.ts          discovery, precedence, redaction and the write path
src/index.ts           server entry: message protocol -> config.ts
src/client.ts          browser view (plain DOM, no npm imports)
index.mjs              generated from src/index.ts   (gitignored)
client/entry.mjs       generated from src/client.ts  (gitignored)
```

`src/config.ts` is pure apart from the filesystem calls, and every path is
derived from an injected `{home, agentDir, projectDir}` root, which is what
makes the unit tests able to run against a temp directory.

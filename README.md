# pi-web-ui-plugins

Interface plugins for [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui), the web chat UI for the
[pi](https://github.com/badlogic/pi-mono) coding agent. Each plugin adds a tab, an agent tool, a shortcut,
or a fenced-code renderer to that UI.

These are English-only TypeScript ports of the upstream plugins. `legado-web` (Chinese web-novel sources), `wechat-ilink`
(China-only WeChat), and `demo-mailbox` (an upstream protocol sample, not in its catalog) are deliberate skips. See
[Acknowledgements](#acknowledgements) for where they came from.

This is also a monorepo: `packages/pi-claude-agent-sdk` is a separately installable pi provider package and is not part of the pi-web-ui catalog.

## Plugins

| id                  | icon | What it does                                                                                                                 | Permissions                 |
| ------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `topbar-fix`        | 🩹   | Stopgap stylesheet for pi-web-ui#162: the top-bar overflow menu is clipped and never visible. Temporary.                     | none                        |
| `catalog-sync`      | 🔄   | Settings page (no tab) that writes this repository's plugin list into the marketplace (`host.reloadCatalog`).                | none                        |
| `jira-review`       | 🎟️   | Reviews active Jira Cloud sprint tickets, saves agent-readiness scores, and manually posts approved notes.                   | `fs`, `net`, `tools`        |
| `webmail`           | 📬   | IMAP inbox, SMTP sending and new-mail notifications, with an optional switch that lets the agent manage the mailbox.         | `net:imap/smtp`, `tools`    |
| `db-client`         | 🗄️   | Schema browsing, SQL queries and row editing across MySQL, PostgreSQL, SQLite, SQL Server, MongoDB and Redis.                | `net`, `tools`              |
| `vscode-editor`     | 📝   | Multi-root file tree, tabbed CodeMirror editing, xterm.js terminals, Remote-SSH browsing and SFTP sync.                      | `fs`, `net:ssh`, `terminal` |
| `mermaid`           | 📊   | Renders `mermaid` fences in messages as SVG. Renderer plugin, so the engine loads only when such a fence appears.            | none                        |
| `run-trace`         | 🧭   | Aggregates a run into one replayable timeline: task, reasoning, tool calls, file changes, result.                            | none                        |
| `mcp-manager`       | 🔌   | Manages MCP servers through `pi-mcp-adapter`: inspect the effective config, enable or disable servers, add or remove them.   | `http`                      |
| `image-toolkit`     | 🖼    | Compresses, crops, resizes, converts, watermarks and inspects workspace images, with four AI tools.                          | `fs`, `http`, `tools`       |
| `ui-shortcuts`      | ⌨️   | Switches between the Terminal, Editor and Run Trace views, with a small UI for custom view, compose, and new-chat shortcuts. | none                        |
| `worktree-preparer` | 🌿   | Assembles selected workspace folders and Git repositories into a fresh multi-project worktree folder.                        | `fs`, `terminal`            |
| `subagent-config`   | 🧩   | Settings page that edits pi-subagents agent files and `subagents.json`, validating model pins against the model store.       | `fs`, `ui`                  |
| `voice-input`       | 🎤   | Dictates into the composer with browser speech recognition and remote or offline Whisper fallback.                           | `ui`, `http`                |

`plugins/catalog.json` is the machine-readable form of this table. pi-web-ui reads it as its built-in
plugin-marketplace list, so the two must not drift.

## Claude provider package

`packages/pi-claude-agent-sdk` registers Claude Code as a pi model provider. Install a published release with:

```sh
pi install npm:pi-claude-agent-sdk
```

Or install this checkout before it is published:

```sh
npm install
pi install "$PWD/packages/pi-claude-agent-sdk"
```

Use `pi install -l "$PWD/packages/pi-claude-agent-sdk"` for a project-local install.

Configure named Claude Code folder profiles; each appears as its own model-picker provider and uses its own manual Claude Code login. See [`packages/pi-claude-agent-sdk/README.md`](packages/pi-claude-agent-sdk/README.md) for profile configuration and authentication details.

## Browser extension

`plugins/page-picker/extension/` is the standalone **pi-web-ui Page Picker** Chrome/Edge/Firefox extension. It is not a
pi-web-ui plugin and is intentionally absent from the catalog. It picks development-page elements, sends focused
context to the composer, and optionally provides AI page control and an explicit page bridge.

```sh
npm run build:extension
npm run pack:extension
```

Load `plugins/page-picker/extension/` as an unpacked extension after building (or as a temporary add-on in Firefox), or install
`release/page-picker-extension.zip` from a tagged release. See
[`plugins/page-picker/README.md`](plugins/page-picker/README.md) for the full setup and permission model.

## Installing plugins

This repository is source-only: no build output is committed. pi-web-ui 0.86 builds a plugin during installation, in an
isolated temporary directory, from the `build` block in its `manifest.json`. Requires pi-web-ui 0.86 or newer.

```sh
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/<id> --build
```

In the browser the same thing is **Settings → UI plugins → Plugin marketplace**, with **Build from source** ticked.
Without `--build` (or that checkbox) the plugin installs with no compiled entries and does nothing.

To get every plugin listed in the marketplace at once, install `catalog-sync` and press **Sync catalog**:

```sh
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/catalog-sync --build
```

### Custom catalogs

Recent pi-web-ui versions support custom catalog entries. Open **Settings → UI plugins → Plugin marketplace →
Add plugin** and enter a source such as `Jensen95/pi-web-ui-plugins/plugins/image-toolkit`. Entries are stored
in `~/.pi-web/plugin-catalog.json` (or `<dataDir>/plugin-catalog.json`) and appear alongside the built-in catalog.

To load this repository's complete catalog as a custom catalog without the plugin:

```sh
mkdir -p ~/.pi-web
curl -fsSL https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json |
 jq '{entries: .}' > ~/.pi-web/plugin-catalog.json
```

Refresh pi-web-ui after writing the file. `catalog-sync` does the same thing from the UI, with validation and an atomic
write. The release workflow remains available for tagged archives, but a release is not required for installation.
Runtime packages for plugins that need them are installed by pi-web-ui on first activation via `ensureDeps`.

## Development

```sh
npm install              # once; installs the root project and workspace packages
npm run build            # compile every pi-web-ui plugin plus the two vendor bundles
npm run build:extension  # build the standalone Page Picker browser extension
npm run build:catalog-sync # compile the catalog sync plugin
npm run build:jira-review  # compile the Jira review plugin
npm run build:worktree-preparer # compile the worktree preparer plugin
npm run build:voice-input      # compile the voice input plugin
npm run build:subagent-config # compile the subagent config plugin
npm run build:mermaid    # compile one plugin (also available for every other id)
npm test                 # vitest plus the provider package's offline unit suite
npm run typecheck        # root TypeScript plus packages/pi-claude-agent-sdk/typecheck
npm run lint             # oxlint over packages/, plugins/, scripts/, tests/
npm run check:english    # fail on any CJK character in the repo or its artifacts
npm run format           # prettier --write (tabs, printWidth 120)
npm run clean            # remove generated plugin entries and vendor bundles
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs them in this order on every push to `main`
and every pull request: `npm ci`, `build`, `format:check`, `lint`, `typecheck`, `check:english`, `test`. The
build runs first on purpose - `check:english` also scans the compiled entries, and the artifact smoke tests
import them, so a gate that runs before the build would quietly enforce less than it claims to.

## Architecture: TypeScript in, fixed filenames out

Plugins are written in TypeScript and compiled to the exact filenames pi-web-ui hardcodes. This is not a
stylistic choice; the host will not import anything else:

| Host site                      | What it does                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `server/plugins.ts:918`        | skips activation entirely unless `<pluginDir>/index.mjs` exists                    |
| `server/plugins.ts:1256`       | `await import(pathToFileURL(join(dir, "index.mjs")).href + "?e=" + epoch)`         |
| `server/plugins.ts:1011`       | reports `hasClient` from `existsSync(join(dir, "client", "entry.mjs"))`            |
| `web/src/plugin-loader.ts:135` | browser `import(appUrl("/plugins/<id>/client/entry.mjs?e=" + epoch))`              |
| `web/src/plugin-fence.ts:129`  | same, for lazy-loaded fenced-code renderers                                        |
| `server/index.ts:485`          | serves only the `client/` subtree over HTTP - never `manifest.json` or `index.mjs` |
| `server/index.ts:871`          | reads the marketplace list from `<pkgRoot>/plugins/catalog.json`                   |

A browser cannot execute TypeScript and the host will not load a differently-named file, so `index.mjs` and
`client/entry.mjs` have to be generated. Hence:

```
plugins/<id>/
  manifest.json        committed  - metadata the host reads
  README.md            committed  - what the plugin does and how to install it
  src/
    index.ts           committed  - server entry source (only if it has server logic)
    client.ts          committed  - browser view or renderer source
    <anything>.ts      committed  - helper modules, inlined by the build
  index.mjs            GENERATED  - ignored, from src/index.ts
  client/entry.mjs     GENERATED  - ignored, from src/client.ts
  client/vendor/*      GENERATED  - ignored, third-party bundles
```

No artifact is committed. Each `manifest.json` carries a `build` block (`install` / `command` / `outputs`) that the host
runs during `install --build`; it is the same esbuild configuration as the repo builder, expressed as CLI flags, because
the host copies only the plugin directory and the repo root is not there. `tests/unit/source-install.test.ts` derives
that block from the conventions and fails when the two drift. The Page Picker extension is built separately from its
TypeScript sources.

`scripts/build-plugins.mjs` is convention-driven: one shared builder walks `plugins/*/`, and there are no
per-plugin build files or `package.json` files. Server bundles keep npm specifiers external
(`packages: "external"`), because a plugin resolves runtime dependencies through `createRequire` plus the
host's `ensureDeps` auto-install. Client bundles inline everything, because the browser loads
`client/entry.mjs` as bare ESM with no specifier resolution - so no bare npm import may survive in it.

## English-only

This repository accepts no non-English text: not in TypeScript source, comments, JSDoc, string literals,
test names, assertion messages, JSON, YAML, READMEs, workflows, build scripts, or the compiled output those
produce. Upstream keeps a Chinese `description` alongside an English `descriptionEn`, and the host picks
between them by locale. Here English lives in `description` and no `descriptionEn` key exists at all.

The rule is enforced twice, in CI, on every push:

- `npm run check:english` (`scripts/check-english.mjs`) exits non-zero and prints `path:line:col` for any
  character in `[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]`. It scans every file git
  tracks or would track, including compiled plugin entries. Third-party output under `client/vendor/` is the
  only exclusion.
- `tests/unit/english-only.test.ts` asserts the same invariant inside the test suite.

The class deliberately excludes U+2018-U+201F: those are legitimate English smart quotes. The one carve-out
is fullwidth forms (`\uff00-\uffef`) inside compiled `client/entry.mjs`, because that bundle inlines
`@codemirror/autocomplete`, whose bracket auto-closing table is a string of paired brackets ending in
fullwidth forms. Those are data, not prose, and cannot be translated away; CJK ideographs and punctuation
are still flagged there.

## Acknowledgements

These plugins are derivative works of [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui), used under the
MIT License. The upstream project is where the plugin host contract, the plugin architecture, the original
implementations of `webmail`, `db-client`, `vscode-editor`, `mermaid`, `run-trace`, and the Page Picker extension
come from. This repository ports them to English and converts the plugin and extension sources to TypeScript. The
Page Picker remains a separate browser-side deliverable rather than a catalog plugin.

`catalog-sync` and `mcp-manager` are original to this repository. `catalog-sync` is now a thin wrapper over the
supported `host.reloadCatalog` API; it exists only because the host has no user-facing field for a remote catalog URL.

The upstream copyright notice, which MIT requires be carried into derivative works:

> Copyright (c) xingshuyin
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction, including
> without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
> following conditions: the above copyright notice and this permission notice shall be included in all copies
> or substantial portions of the Software.

[`LICENSE`](LICENSE) keeps this repository MIT and records the derivative-work attribution.

`mcp-manager` is a front-end for [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) by Nico Bailon and
manages that adapter's configuration rather than replacing it.

## License

MIT - see [`LICENSE`](LICENSE).

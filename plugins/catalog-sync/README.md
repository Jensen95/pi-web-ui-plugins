# Plugin Catalog Sync

Writes this repository's plugin list into the pi-web-ui marketplace, from:

It has no top-bar tab (`"view": false`). It lives entirely in **Settings → Plugin catalog**, because one button does not deserve a view of its own.

```text
https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json
```

Requires pi-web-ui 0.86 or newer (host API 4+, which added `host.reloadCatalog`).

## Use

Open **Settings → Plugin catalog**. One button: **Sync catalog**. It calls `host.reloadCatalog(<catalog URL>, { replace: true })`. The server fetches the
document, validates every entry with the same rules the marketplace "Add plugin" form uses, writes
`<dataDir>/plugin-catalog.json` atomically, reloads plugins, and returns a receipt the view shows you. A failed fetch or
a malformed document writes nothing, so the previous catalog stays valid.

Nothing is installed. After syncing, install the plugins you want from **Settings -> UI plugins -> Plugin marketplace**
with **Build from source** ticked, or from a terminal:

```bash
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/<id> --build
```

## Update status

The page lists every installed plugin with one of three states:

| State            | Meaning                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| Update available | the source repository's HEAD moved since this plugin was installed                  |
| Up to date       | the installed sha matches the remote                                                |
| Unknown          | no `.pi-git-sha` marker, a local-directory install, or the remote could not be read |

The comparison is the host's own: `pi-web-ui install` writes `.pi-source.json` and `.pi-git-sha`
(`git ls-remote <remote> HEAD`, first 12 chars) into each plugin directory, and the CLI's
`checkPluginUpdates()` compares them. That check is never surfaced in the UI, so this plugin runs it and
shows the result. One `git ls-remote` per distinct remote — all twelve plugins here share one repository.

Because the sha is the repository HEAD rather than a per-plugin path sha, any commit to this repo marks
every plugin from it as updatable. That is the host's definition of outdated; inventing a second one would
disagree with `pi-web-ui check-updates`.

## Updating

Tick the plugins you want and choose **Send update command to terminal**. The stale ones start ticked; an
up-to-date plugin can be ticked too, to force a rebuild. The selection becomes one shell line, chained with
`&&`, and runs in a visible pi-web-ui terminal you can read and stop.

It does **not** install silently, and it does not use `host.reloadCatalog({ install: true })`: that path
never passes `--build` (`buildPluginJobArgs` adds the flag only when the job spec sets `build: true`, which
the catalog-sync path never does), so on a source-only repository it would replace working plugins with
unbuilt source. The terminal bridge (`pi-web-ui:plugin-run-command`) is undocumented and may change, but it
is the only build-capable path reachable from plugin code — and the command stays legible the whole way:

```sh
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/<id> --name <id> --build --force
```

Settings -> UI plugins -> Plugin marketplace with **Build from source** ticked does the same thing.

## What this plugin used to do

Before 0.86 it cloned this repository into a temporary directory, ran `npm ci` and the repository build, and installed
each plugin through the private `pi-web-ui:plugin-run-command` terminal event, because the host had no catalog-write API
and could not build a source-only plugin. Upstream now does both itself
([#148](https://github.com/xing-shuyin/pi-web-ui/issues/148), [#150](https://github.com/xing-shuyin/pi-web-ui/issues/150)),
so all of that is gone.

What remains missing upstream is a user-facing field for a remote catalog URL; that is the only reason this plugin still
exists. Install it once from source:

```bash
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/catalog-sync --build
```

## Development

```bash
npm run build:catalog-sync
npm run typecheck
npm test -- --run tests/unit/catalog-sync.test.ts
```

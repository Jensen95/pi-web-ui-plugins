# Plugin Catalog Sync

Writes this repository's plugin list into the pi-web-ui marketplace, from:

```text
https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json
```

Requires pi-web-ui 0.86 or newer (host API 4+, which added `host.reloadCatalog`).

## Use

One button: **Sync catalog**. It calls `host.reloadCatalog(<catalog URL>, { replace: true })`. The server fetches the
document, validates every entry with the same rules the marketplace "Add plugin" form uses, writes
`<dataDir>/plugin-catalog.json` atomically, reloads plugins, and returns a receipt the view shows you. A failed fetch or
a malformed document writes nothing, so the previous catalog stays valid.

Nothing is installed. After syncing, install the plugins you want from **Settings -> UI plugins -> Plugin marketplace**
with **Build from source** ticked, or from a terminal:

```bash
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/<id> --build
```

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

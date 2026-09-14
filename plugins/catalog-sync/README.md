# Plugin Catalog Sync

Reloads this repository's custom plugin sources from:

```text
https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json
```

## Use

Open the plugin view and choose **Reload custom plugins**. It opens the host's visible terminal and runs one command that:

1. updates this plugin itself, so the host's install watcher can reload plugins;
2. fetches and validates the remote catalog;
3. installs every other catalog source with `--force`;
4. writes `plugin-catalog.json` under `PI_WEB_DATA_DIR` or `~/.pi-web` only after every install succeeds.

The command uses Node's built-in `fetch` and `pi-web-ui`; it does not require `curl` or `jq`.

## Limitation

The pi-web-ui plugin API has no supported catalog-write or reload method yet. This plugin therefore uses the private host event `pi-web-ui:plugin-run-command`, the same event used by existing update buttons. The status only confirms that the request was dispatched; the browser cannot detect whether an older host handled the event.

Refresh the page after the command completes if the host does not automatically update its plugin list. The command uses `&&`, so a Windows host using legacy PowerShell should run the plugin from Git Bash or modern PowerShell.

## Development

```bash
npm run build:catalog-sync
npm run typecheck
npm test -- --run tests/unit/catalog-sync.test.ts
```

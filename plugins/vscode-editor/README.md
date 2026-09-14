# 📝 vscode-editor — pi-web-ui editor and SSH plugin (Remote-SSH)

Provides a VS Code-style workspace view in pi-web-ui:

- **Multi-root file tree:** The local workspace and saved SSH hosts share one tree and one set of tabs.
- **Workspace following:** When the main application changes project with `set_cwd`, the local tree root immediately changes to the new project. It clears directory caches and expanded state, closes local tabs after warning about unsaved changes, and leaves remote SSH tabs and connections untouched. Each project has its own `.vscode/sftp.json`, which is reread after a switch.
- **CodeMirror 6 multi-tab editor:** Opens local and remote files together with syntax highlighting, Ctrl+S save, remote writes through SFTP, CRLF preservation, and local Ctrl+P quick open.
- **Resizable bottom terminal panel:** Each connected host can open multiple xterm.js shells with synchronized dimensions and keepalive. Right-click a remote file or folder to open a terminal in its directory.
- **SFTP sync** (☁ menu): Upload or download an entire workspace, upload the current file, and upload on save with `uploadOnSave`. Configuration lives in workspace `.vscode/sftp.json` and is compatible with **vscode-sftp / Natizyskunk.sftp**, so an existing VS Code `sftp.json` can be copied directly and takes effect on Ctrl+S. Supported fields: `name`, `host`, `port`, `username`, `password`, `passphrase`, `privateKey`, `privateKeyPath` (including `~` expansion such as `~/.ssh/id_rsa`), `remotePath` (the remote root), `ignore` (glob exclusions), `uploadOnSave`, legacy `watcher.autoUpload`, and `agent` (for example, `$SSH_AUTH_SOCK` through ssh-agent). Use a password, private key, or agent.
- **Download to the computer** (context menu): Local files download directly. Remote files and folders bypass workspace mapping; folders are archived as tar.gz on the remote host, then the save location is selected.
- **Upload files:** The toolbar ⬆ uploads to the workspace root. The context menu’s Upload file here action targets a folder row, the containing folder of a file row, or, when used on blank tree space, the tree root or first connected SSH host root. Local and remote SFTP are supported. Dragging files onto the tree uses the same targets and a chunked protocol with overwrite confirmation and progress; tree drops are intercepted so they do not trigger the main application’s attach-to-conversation action.

The former standalone SSH plugin is merged here. The first activation automatically migrates host settings from the old `<pluginDir>/ssh-hosts.json`; no manual migration is needed.

## File-tree interaction

- **Inline expand and collapse:** Selecting a folder loads only that directory’s children and shows a loading placeholder without redrawing the full tree; collapse is immediate.
- **Selection highlighting:** Clicking or right-clicking any row selects it. The toolbar’s +📄 and +📁 actions use the selected directory, or the containing folder when a file is selected. A successfully created item becomes selected.
- **Context menu:** Create, rename, delete, upload a file here, sync both directions, or open a terminal with scope awareness.

## Unified scope model

The scope is `"local" | connId`. Every client file operation (`list`, `read`, `write`, `create`, `rename`, and `delete`) includes a scope; remote operations also include `connId`. The server routes the request to local fs or the matching connection’s SFTP, giving the client and server one shared path.

## Directory layout

```
vscode-editor/
├── manifest.json        # Plugin manifest (id/icon/name)
├── index.mjs            # Server entry: local CRUD, SFTP sync (.vscode/sftp.json),
│                        # SSH host management, connection pool, PTY shell, exec, and remote SFTP
├── src/client.js        # Client source (CodeMirror 6 and xterm.js)
├── build.mjs            # esbuild packaging script (inlines xterm CSS as text)
├── package.json         # Build dependencies; ssh2 is a devDependency and installs automatically at runtime
└── client/entry.mjs     # Generated self-contained browser bundle
```

## Install, uninstall, and update

```bash
# ── Install source-only catalog plugins ──
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/catalog-sync
# Open catalog-sync, select this plugin, and choose "Update selected plugins"
# Local development: build this plugin before installing its directory
npm run build:vscode-editor
pi-web-ui install plugins/vscode-editor
# Optional: --data-dir <dir> chooses the data directory; default: ~/.pi-web

# ── Inspect ──
pi-web-ui plugins                            # lists installed plugins and IDs

# ── Update ──
# Select vscode-editor in catalog-sync to rebuild and reinstall it.
# Back up ssh-hosts.json and the workspace .vscode/sftp.json first

# ── Uninstall ──
pi-web-ui uninstall vscode-editor            # removes the plugin directory and ssh-hosts.json
# Manual alternative: rm -rf ~/.pi-web/plugins/vscode-editor
```

Refresh the page to show the 📝 top-bar tab. The `ssh2` dependency is not distributed with the package; first activation installs it into the plugin directory automatically. If that fails, use the sidebar’s `⚠ssh2` action to try again.

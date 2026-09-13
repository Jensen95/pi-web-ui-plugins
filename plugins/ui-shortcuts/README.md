# UI Shortcuts (`ui-shortcuts`)

Adds global keyboard shortcuts for the pi-web-ui views:

| Shortcut                   | View                     |
| -------------------------- | ------------------------ |
| `Ctrl+Alt+T` / `Cmd+Alt+T` | Terminal                 |
| `Ctrl+Alt+E` / `Cmd+Alt+E` | Editor (`vscode-editor`) |
| `Ctrl+Alt+R` / `Cmd+Alt+R` | Run Trace                |

Press the shortcut for the active view again to return to Chat. Shortcuts are
ignored while typing in an input, textarea, select or contenteditable element.

The plugin uses pi-web-ui's browser host action bridge. Install it directly:

```sh
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/ui-shortcuts
```

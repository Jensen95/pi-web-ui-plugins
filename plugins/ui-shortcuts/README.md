# UI Shortcuts (`ui-shortcuts`)

Adds global keyboard shortcuts for the pi-web-ui views:

| Shortcut                   | View                     |
| -------------------------- | ------------------------ |
| `Ctrl+Alt+T` / `Cmd+Alt+T` | Terminal                 |
| `Ctrl+Alt+E` / `Cmd+Alt+E` | Editor (`vscode-editor`) |
| `Ctrl+Alt+R` / `Cmd+Alt+R` | Run Trace                |

Press the shortcut for the active view again to return to Chat. Shortcuts are
ignored while typing in an input, textarea, select or contenteditable element.

The **Custom shortcuts** panel stores additional bindings in browser local storage. Use a key plus modifiers
(for example `Ctrl+Alt+K`) and choose one of these host actions:

- **Switch view**: `chat`, `terminal`, `git`, or `plugin:<id>`;
- **Compose text**: put a draft in the composer without sending it;
- **Start a new chat**: create a new conversation and send a prompt.

The plugin uses pi-web-ui's browser host action bridge. Missing or failing bridge methods are ignored safely. Install it with
`pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/ui-shortcuts --build`, or build it locally first:

```sh
npm run build:ui-shortcuts
pi-web-ui install plugins/ui-shortcuts
```

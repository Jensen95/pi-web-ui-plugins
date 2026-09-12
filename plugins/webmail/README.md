# 📬 webmail — pi-web-ui email plugin

Provides a complete email-management view in pi-web-ui (the 📬 tab in the top bar): IMAP inbox access, SMTP sending, new-mail notifications, and optional direct AI management of the mailbox.

## Features

- **Inbox:** Browse, search by keyword (subject, sender, or recipient), read full messages, mark messages read or unread, and delete messages.
- **Send mail:** Plain-text SMTP email with CC support.
- **New-mail notifications:** Periodically polls the unread count in INBOX and sends a `host.notify` notification when new mail appears. The interval is configurable and defaults to 60s.
- **AI mailbox management** (off by default): Enable “Allow AI to manage email” in settings to register six AI tools: `mail_list`, `mail_read`, `mail_search`, `mail_send`, `mail_manage`, and `mail_folders`. Then a conversation can ask for recent mail directly; disabling the option unregisters the tools.

## Configuration

The settings panel stores `<dataDir>/plugins/webmail/config.json` as local plaintext, using the same security model as pi `auth.json`:

| Field                           | Meaning                                             |
| ------------------------------- | --------------------------------------------------- |
| IMAP host / port / TLS          | Incoming-mail server, for example `imap.qq.com:993` |
| SMTP host / port / TLS          | Outgoing-mail server, for example `smtp.qq.com:465` |
| Username / password             | Email account password or authorization code        |
| Polling interval `pollSec`      | Unread-mail check interval; 60s by default          |
| Allow AI management `aiEnabled` | Registers or unregisters the AI email tools         |

Configuration responses are redacted: they return only whether `hasPass` exists and never return the password to the browser.

Passwords are stored first in the host’s encrypted secret facility (`host.secrets`, AES-256-GCM to `<pluginDir>/secrets.bin`). After a successful write, `pass` in `config.json` is empty. If an older host has no secret facility or writing the secret fails, such as with a read-only directory or full disk, the password falls back to plaintext in `config.json` and the plugin warns once. Retaining the password is preferable to silently losing it after a save.

## Install, uninstall, and update

```bash
# ── Install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail
pi-web-ui install plugins/webmail        # or a local directory for development
# Optional: --data-dir <dir> chooses the data directory; default: ~/.pi-web

# ── Inspect ──
pi-web-ui plugins                            # lists installed plugins and IDs

# ── Update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force
                                             # --force reinstalls over the current copy
                                             # Back up config.json in the plugin directory first

cp -r plugins/webmail ~/.pi-web/plugins/ # local development: copy over the installed plugin
                                             # Windows: %USERPROFILE%\.pi-web\plugins\webmail

# ── Uninstall ──
pi-web-ui uninstall webmail                  # removes the plugin directory and config.json
# Manual alternative: rm -rf ~/.pi-web/plugins/webmail
```

Refresh the browser for changes to take effect. The `imapflow`, `mailparser`, and `nodemailer` dependencies are **not distributed with the package**. The first activation installs them automatically into the plugin directory; if that fails, the view exposes an Install dependencies action.

## Regression tests

- `tests/unit/plugin-tools.test.ts`: synchronous diff and registration lifecycle with Vitest.
- `tests/scratch/webmail-e2e-test.mjs`: protocol smoke test for manifest, state response, `save_config` persistence, and password redaction.
- `tests/scratch/webmail-crash-test.mjs`: a missing dependency does not crash the host process, and activation installs dependencies automatically.

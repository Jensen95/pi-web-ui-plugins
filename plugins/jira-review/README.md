# Jira Review (`jira-review`)

Shows the active sprint from Jira Cloud and filters it with a configurable ready-for-pickup JQL expression.

For each ticket, select workspace folders for the agent to inspect. A review run opens one new pi chat per ticket.
The agent saves a structured result through `jira_review_save`:

- ready for pickup;
- difficulty: easy, medium, or hard;
- confidence: high, medium, or low;
- rationale, missing information, and an implementation plan;
- a draft Jira comment and suggestions for increasing confidence.

Reviews are kept in system-scoped plugin storage, keyed by Jira site and issue key, so they remain available when the
board is opened from another workspace. Nothing is posted automatically. The **Post review** button first posts the
draft comment and then adds the `dogits-dans-le-nez` Jira label.

## Setup

Credentials live in **Settings → Jira Review** (site URL, email, API token, board, ready JQL); the top-bar tab is the
review workflow only. The token is sent once on save and kept in the host secret store — it is never broadcast back.

Install it with `pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/jira-review --build`, which builds this source-only
plugin on the host. For local development:

```sh
npm run build:jira-review
pi-web-ui install plugins/jira-review
```

Open the **Settings** page in the plugin view and enter the Jira Cloud site URL, account email, API token, board ID, and
ready-ticket JQL. The API token is sent to the plugin server only when settings are saved, then stored in the host secret
store; it is never returned in browser state or saved in normal plugin storage.

The current plugin contract exposes the browser bridge used to start chats, so review chats use the current workspace.
The top-bar organizer and automatic project-session switching are intentionally deferred to host support; see upstream
issue [#146](https://github.com/xing-shuyin/pi-web-ui/issues/146).

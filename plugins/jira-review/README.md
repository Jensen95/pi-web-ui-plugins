# Jira Review (`jira-review`)

Shows the active sprint from Jira Cloud and filters it with a configurable ready-for-pickup JQL expression.

For each ticket, select workspace folders for the agent to inspect. The shared folder selection is remembered separately
for each workspace, and the ticket list can be filtered before starting a batch. A review run opens one new pi chat per
ticket, pinned to the currently selected pi-web-ui project. The plugin follows later project switches and refreshes its
workspace folder choices. Each chat acts as a lead: it asks two read-only Explore (Luna) agents to inspect code and tests,
then proposes a concrete solution. Batch reviews never change files; a single-ticket review may attempt a small, localized
implementation and run a relevant check. If the `@tintinweb/pi-subagents` Agent tool is unavailable, the lead investigates
alone and reports that limitation. The folder selection guides inspection but does not sandbox agent access. The agent
saves a structured result through `jira_review_save`:

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

On pi-web-ui host API v11 or newer, the dashboard lists configured models and passes the selected model and current
workspace explicitly to every review chat. Older hosts keep using the active model. Review launch state is stored by the
plugin, so reloading the dashboard does not lose in-progress markers; a stale or cancelled run can be cleared with
**Mark review stopped**.

For visual development, run `node scripts/preview-plugins.mjs`. It builds the plugins and opens a dependency-free preview
server at `http://127.0.0.1:4173`; use `--no-build` when outputs are already current.

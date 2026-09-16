# Worktree Preparer (`worktree-preparer`)

Assembles a few folders from the current workspace into **one fresh folder**, so a session can treat exactly those
projects as the files it works on.

- A selected **Git repository** gets one new branch checked out as a `git worktree` inside the aggregate. The source
  repository is never reset or checked out, so uncommitted work stays where it is.
- A selected **plain folder** is copied, excluding `.git`, `node_modules`, `dist`, `build`, and `coverage`.
- One branch name is used for every repository in the run.

## Using it

1. **Pick the folders.** Each row says what will happen to it, once the background Git probe has finished.
2. **Name the branch and the folder.** The resolved absolute path is shown live under the field.
3. **Press Prepare** and read the per-folder report.
4. **Press Open session here** to work in the result.

## Where the aggregate lands

By default under `~/pi-workspaces/<name>` — **outside** the current workspace, deliberately. An aggregate nested inside
a source project would put the session's working directory back inside that project, where `../..` walks straight out of
the scope you asked for.

The field also accepts `~/somewhere/name` or an absolute path, used as written. Refused: an empty name, any `..`
segment, a NUL byte, an absolute path less than two segments deep (`/`, `/tmp`), a path inside or containing a selected
folder, and an aggregate directory that already exists (it is never reused or merged into).

## Default-branch detection

The base branch is resolved per repository: `refs/remotes/origin/HEAD` first, then `git ls-remote --symref origin HEAD`,
and only then the `master` fallback. The worktree is created off `origin/<default>` after fetching it, so `main`,
`master`, and `trunk` repositories all work in the same run without asking.

## What "Open session here" actually scopes

It calls `host.openSession({ folders: [root], newChat: true })` (pi-web-ui 0.86+). Only the aggregate root is passed, so
the host makes it the session's working directory and clears the other workspace roots — the file tree then shows the
aggregate and nothing else. The host asks you to confirm access to the folder first; nothing opens without that click.

**It does not sandbox the agent.** Workspace roots govern the file tree, not what a tool call may read: an agent with
shell or file access can still reach anything on disk the user can. This scopes attention, not permissions. The view
says so in place.

A partial run does not offer the button — a failed repository still leaves a usable `root`, and opening it would look
like success while a project is missing from it. On a host without `openSession`, the button says so instead of failing
silently.

## Setup

Install with `pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/worktree-preparer --build`, which builds this
source-only plugin on the host. For local development:

```sh
npm run build:worktree-preparer
pi-web-ui install plugins/worktree-preparer
```

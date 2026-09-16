# Worktree Preparer (`worktree-preparer`)

Creates a disposable aggregate project folder from selected folders in the current workspace.

- A selected Git repository is fetched from `origin/master` and receives one new branch/worktree.
- A selected non-Git folder is copied recursively.
- Source repositories are never reset or checked out, so existing uncommitted work stays in place.
- Copied folders exclude `.git`, `node_modules`, `dist`, `build`, and `coverage`.
- One branch name is used for every repository in the run.

The result includes the absolute aggregate-folder path, and a successful run offers **Open session here**, which calls
`host.openSession({ folders: [root], newChat: true })` (pi-web-ui 0.86+, the #146 API). The host asks you to confirm
access to the folder first — its grant check is exact-string membership, so it prompts even for a folder inside the
current workspace. Nothing opens without that click.

Only the aggregate root is passed, deliberately. Its entries live inside it, and the host dedupes workspace roots by
exact string with no nesting check, so passing them as extra roots would render the same subtree twice while granting
no access the cwd does not already imply. `set_workspace_roots` also replaces the persisted roots for a cwd, so extra
roots are not free.

A partial run does not offer the button: a failed repository still leaves a usable `root` with a non-empty `errors`
array, and opening that folder would look like success while repositories are missing from it. On a host without
`openSession`, the button says so instead of failing silently.

## Setup

Install it with `pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/worktree-preparer --build`, which builds this source-only
plugin on the host. For local development:

```sh
npm run build:worktree-preparer
pi-web-ui install plugins/worktree-preparer
```

Open the plugin in the current workspace, select folders, enter an output path inside that workspace and a branch name,
then click **Prepare**. Git repositories must have an `origin/master` remote branch. If one repository fails, successful
entries and the aggregate path remain visible so the result can be inspected manually.

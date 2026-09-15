# Worktree Preparer (`worktree-preparer`)

Creates a disposable aggregate project folder from selected folders in the current workspace.

- A selected Git repository is fetched from `origin/master` and receives one new branch/worktree.
- A selected non-Git folder is copied recursively.
- Source repositories are never reset or checked out, so existing uncommitted work stays in place.
- Copied folders exclude `.git`, `node_modules`, `dist`, `build`, and `coverage`.
- One branch name is used for every repository in the run.

The result includes the absolute aggregate-folder path. This standalone plugin does not change the host workspace or
open a new session automatically; use the returned path when starting the next session. The host API needed for direct
project-session switching is proposed in upstream issue [#146](https://github.com/xing-shuyin/pi-web-ui/issues/146).

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

# Git Branch Switcher

Claude Desk now exposes a Codex-style branch switcher in the header.

## UI behavior

- Header shows a branch button with the current branch name and chevron.
- Clicking it opens a popover with:
  - `Search branches` input
  - `Branches` section
  - Local branch rows
  - Checkmark on current branch
  - Current-branch status line: `Uncommitted: <N> files +<insertions> -<deletions>`
  - Footer action: `Create and checkout new branch...`
- Keyboard support:
  - `ArrowUp` / `ArrowDown` to move selection
  - `Enter` to checkout selected branch
  - `Esc` to close

## Backend commands

The popover uses four new Tauri commands:

- `git_list_branches(workspacePath)`
  - Runs:
    - `git rev-parse --abbrev-ref HEAD`
    - `git for-each-ref refs/heads/ --format="%(refname:short)\t%(committerdate:unix)" --sort=-committerdate`
  - Returns branch objects:
    - `name`
    - `isCurrent`
    - `lastCommitUnix`

- `git_workspace_status(workspacePath)`
  - Runs once when popover opens (not per row):
    - `git status --porcelain`
    - `git diff --numstat`
  - Returns:
    - `isDirty`
    - `uncommittedFiles`
    - `insertions`
    - `deletions`

- `git_checkout_branch(workspacePath, branchName)`
  - Runs `git checkout <branchName>`

- `git_create_and_checkout_branch(workspacePath, branchName)`
  - Runs `git checkout -b <branchName>`

## Running-session safety

If any PTY Claude session is active, switching branches prompts:

`Switching branches may affect the running session. Continue?`

If confirmed, Claude sessions receive `SIGINT`, then are terminated before checkout continues.

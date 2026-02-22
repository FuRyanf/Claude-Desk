# Claude Desk

Claude Desk is a native macOS Tauri app that wraps the local Claude Code CLI in an embedded terminal UI.

The app does not call Anthropic APIs directly. It launches your local `claude` binary in an interactive PTY and renders output in-app.

## Requirements

- macOS (desktop build target)
- Node.js + Yarn
- Rust toolchain (for Tauri build)
- Claude Code CLI installed (`claude` on PATH or configured in app settings)

## Install

```bash
yarn install --ignore-engines
```

## Run In Development

```bash
yarn tauri dev
```

Optional frontend-only dev server:

```bash
yarn dev
```

## Build

```bash
yarn build
yarn tauri build
```

Built app output:

- `/Users/rfu/Claude Desk/src-tauri/target/release/bundle/macos/Claude Desk.app`

## Data Storage

Claude Desk stores data under:

- `~/Library/Application Support/ClaudeDesk/`

Important files/directories:

- `workspaces.json`
- `settings.json`
- `threads/<workspaceId>/<threadId>/thread.json`
- `threads/<workspaceId>/<threadId>/runs/<runId>/output.log`
- `threads/<workspaceId>/<threadId>/runs/<runId>/metadata.json`

## Core Runtime Model

- Workspace and thread list state is driven by persisted thread metadata.
- Selecting/opening a thread starts or resumes a PTY session for that thread.
- Threads are first-class entities; runs are children under each thread.
- Thread actions (`Rename`, `Archive`, `Delete`) mutate thread metadata/persistence only.
- Per-thread `Full access` state is persisted and applied at session start.

## Resume Behavior (High Level)

- Each thread can persist a Claude session id in `thread.json`.
- On thread open/start:
  - With session id: launches `claude --resume <sessionId>`
  - Without session id: launches `claude`
- Startup uses login shell parity (`$SHELL -lic`, fallback `/bin/zsh`) so env/path behavior matches Terminal.
- If `Full access` is enabled for a thread, startup appends `--dangerously-skip-permissions`.

## Icons

Canonical source image:

- `/Users/rfu/Claude Desk/app icon.jpg`

Generated base icon:

- `/Users/rfu/Claude Desk/assets/icon.png`

Regenerate all icons:

```bash
yarn generate:icons
```

This updates platform icons under:

- `/Users/rfu/Claude Desk/src-tauri/icons`
- `/Users/rfu/Claude Desk/src-tauri/icons/macos`

## Verification

UI tests:

```bash
yarn test:ui
```

Full app build:

```bash
yarn tauri build
```

Optional local verification loop:

```bash
make verify
```

`make verify` runs frontend build, UI tests, Rust tests, and a Claude PTY smoke test, then writes logs under `artifacts/e2e/`.
It also writes a summary report to `artifacts/last_diagnosis.txt`.

## Troubleshooting

### Claude CLI path not detected

- Open app `Settings`.
- Set `Claude CLI Path` explicitly (for example `/usr/local/bin/claude` or your local install path).
- Re-open a thread to start a new PTY session.

### MCP works in Terminal but not in Claude Desk

- Confirm Claude Desk launches via login shell path (`$SHELL -lic`) by using the in-app diagnostics copy action.
- Compare PATH/env output between Claude Desk diagnostics and native Terminal.
- Ensure shell startup files that initialize MCP dependencies are valid (`~/.zprofile`, `~/.zshrc`, etc.).

### Permissions and Full Access mode

- Default behavior is standard Claude permission prompts.
- Enable `Full access` per-thread to launch with `--dangerously-skip-permissions`.
- Toggling `Full access` restarts the current thread session so the new mode takes effect immediately.

### Workspace add or picker issues

- Use `Add new project` and select a directory in the native folder picker.
- If picker fails/unavailable, use manual path entry in the fallback modal.

## Parity Checklist

Validated in this cleanup pass:

- [x] `yarn test:ui` passes.
- [x] `yarn tauri build` succeeds.
- [x] Thread/session model unchanged (create/select/rename/archive/delete).
- [x] Resume/new-session behavior unchanged.
- [x] Git branch switcher behavior unchanged.
- [x] Full access toggle behavior unchanged.

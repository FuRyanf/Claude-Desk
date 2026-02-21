# Claude Desk

Claude Desk is a native macOS Tauri app that wraps the local Claude Code CLI.

It does not call Anthropic APIs directly. It starts your local `claude` binary in an interactive PTY and renders terminal output in-app.

## Product Scope

This app is intentionally minimal:

- workspace groups
- threads per workspace
- git branch + dirty state in header
- running/idle status
- embedded interactive terminal panel

No skills or context-pack controls are required for normal use.

## Core Behavior

- `New thread` creates a distinct thread record (`thread.json`).
- Selecting/opening a thread auto-starts a PTY session so you can type immediately.
- Runs are stored under `runs/<runId>/` as children of a single thread.
- Thread list is always driven by thread metadata, not by run logs.
- Thread actions are available from right-click context menu: `Rename`, `Archive`, `Delete`.

## Interactive Terminal Mode

### How it works

- Backend starts `claude` in interactive mode inside a PTY (`portable-pty`).
- PTY startup uses the same login shell path as Terminal (`$SHELL -lic`) for environment parity (MCP reliability).
- Frontend uses `xterm.js` + fit addon for ANSI rendering and resize.
- Keystrokes/paste are forwarded to PTY.
- `Cmd+C` sends SIGINT to the PTY process.
- Terminal is the primary input surface (no separate composer input).

### Session controls

- `Esc`: send SIGINT once; press again quickly to hard kill.
- `Open`: open selected workspace in Finder.
- `Terminal`: open selected workspace in native macOS Terminal.

### Persistence

Data path:

- `~/Library/Application Support/ClaudeDesk/`

Important files:

- `workspaces.json`
- `settings.json`
- `threads/<workspaceId>/<threadId>/thread.json`
- `threads/<workspaceId>/<threadId>/runs/<runId>/output.log`
- `threads/<workspaceId>/<threadId>/runs/<runId>/metadata.json`

## Build and Run

```bash
yarn install --ignore-engines
yarn build
yarn tauri dev
```

## How to build a macOS `.app`

```bash
yarn build
yarn tauri build
```

Output:

- `/Users/rfu/Claude Desk/src-tauri/target/release/bundle/macos/Claude Desk.app`

## How to update the icon

Source icon:

- `/Users/rfu/Claude Desk/assets/icon.png`

Regenerate icon set:

```bash
yarn icons
```

Generated icons:

- `/Users/rfu/Claude Desk/src-tauri/icons`

Rebuild app bundle after icon updates:

```bash
yarn tauri build
```

## Verification Loop

Run all checks with one command:

```bash
make verify
```

This runs frontend build, UI tests, Rust tests, and a PTY smoke test.

Artifacts:

- `artifacts/e2e/*.log`
- `artifacts/last_diagnosis.md`

## Docs

- `/Users/rfu/Claude Desk/docs/debug-notes.md`
- `/Users/rfu/Claude Desk/docs/iteration-loop.md`
- `/Users/rfu/Claude Desk/docs/threads-model.md`
- `/Users/rfu/Claude Desk/docs/manual-left-rail.md`
- `/Users/rfu/Claude Desk/docs/manual-terminal.md`
- `/Users/rfu/Claude Desk/docs/mcp-debugging.md`
- `/Users/rfu/Claude Desk/docs/assumptions.md`

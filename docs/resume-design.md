# Resume Design

## Problem

Thread history was previously visual only. Opening an old thread started a fresh Claude terminal session, so Claude did not have prior conversation context.

## Target behavior

- Each Claude Desk thread maps to a real Claude Code session id.
- Opening a thread auto-starts terminal with:
  - `claude --resume <session_id>` when `thread.claudeSessionId` exists.
  - `claude` when missing.
- No transcript replay or prompt injection is used.

## Session id strategy

`claude --help` was checked for an interactive machine-readable session metadata flag.

- `--output-format` / `--json` are print-mode only (`--print`), not interactive PTY mode.
- No dedicated interactive `--print-session-id` style flag is available.

Because of that, Claude Desk uses native output parsing in PTY mode:

- Parse terminal output for `claude --resume <uuid>`.
- Accept only strict UUID pattern:
  - `8-4-4-4-12` hex groups.
- Store once per thread via `set_thread_claude_session_id_if_missing`.
- Never overwrite unless user explicitly uses **Start fresh session**.

## Thread metadata

`thread.json` now includes:

- `claudeSessionId: string | null`
- `lastResumeAt: timestamp | null`
- `lastNewSessionAt: timestamp | null`

These values are persisted in app storage and survive restart.

## PTY startup logic

- Session startup still uses login shell parity:
  - `$SHELL -lic "<command>"`, fallback `/bin/zsh`
- Command is built as:
  - new session: `claude [--dangerously-skip-permissions]`
  - resumed: `claude --resume <id> [--dangerously-skip-permissions]`

## UI behavior

- Header badge shows `Resumed` or `New session`.
- Thread context menu includes:
  - `Resume session`
  - `Start fresh session` (clears stored session id)
  - `Copy resume command`
- Resume failure handling:
  - On likely resume failure, modal prompts:
    - `Start fresh`
    - `Cancel`
    - `View logs`

## Reliability notes

- A `thread:updated` event is emitted when session id is captured from terminal output.
- Frontend applies this update immediately so resume actions are available without restart.

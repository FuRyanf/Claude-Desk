# Threads Model

## Goal
Prevent thread conflation by making `thread` and `run` separate first-class entities with explicit ownership.

## Storage Shape
Data lives under:

- `~/Library/Application Support/ClaudeDesk/workspaces.json`
- `~/Library/Application Support/ClaudeDesk/threads/<workspaceId>/<threadId>/thread.json`
- `~/Library/Application Support/ClaudeDesk/threads/<workspaceId>/<threadId>/runs/<runId>/`

`thread.json` fields:

- `id`
- `workspaceId`
- `title`
- `createdAt`
- `updatedAt`
- `isArchived`
- `lastRunStatus` (`Idle | Running | Succeeded | Failed | Canceled`)
- `lastRunStartedAt`
- `lastRunEndedAt`

Each run folder stores execution evidence:

- `input_manifest.json`
- `output.log`
- `metadata.json` (exit code, signal, timing, output path)

## Source Of Truth Rules

1. The left rail is always driven from `list_threads(workspaceId)` reading `thread.json` files.
2. Runs are children of one thread and never create or rename threads implicitly.
3. Selecting a thread changes only the active view/session target, not thread identity.
4. Starting a run updates that thread's run state; no other thread metadata is mutated.
5. Thread creation only happens through explicit `New thread` action.

## Frontend Store Split

- `ThreadStore` manages thread index and selection.
  - `listThreads(workspaceId)`
  - `createThread(workspaceId)`
  - `renameThread(workspaceId, threadId, title)`
  - `setSelectedWorkspace(workspaceId)`
  - `setSelectedThread(threadId)`
  - `setThreadRunState(threadId, status, startedAt, endedAt)`
- `RunStore` manages active runtime session bindings (`threadId -> sessionId`).

This split prevents deriving thread list from stream output/log events, which was the primary conflation risk.

## Title Behavior

- New thread title is `New thread`.
- After first user input is persisted, title auto-updates from the first non-empty user line (trimmed to 50 chars).
- Inline rename in left rail updates `thread.json` directly and does not touch runs.

## Relaunch Behavior

- Last selected workspace and thread IDs are restored from local storage.
- Last run status in `thread.json` keeps left rail/header informative across relaunches.

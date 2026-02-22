# Non-UI Code Health Sweep

## A. Executive summary

Top 5 highest impact issues:

1. **Path traversal risk in thread/workspace storage paths** (`high`)
   - Why it matters: unvalidated IDs could target paths outside app storage and break data integrity/safety boundaries.
   - Result: fixed with strict storage-segment validation before path joins.

2. **Non-atomic persistence and race-prone metadata updates** (`high`)
   - Why it matters: concurrent read-modify-write operations could overwrite each other (notably Claude session ID capture) and plain writes risk partial/corrupt JSON on crash.
   - Result: fixed with atomic write strategy and serialized metadata mutation lock.

3. **Git backend process calls had no timeout / could block on prompts** (`high`)
   - Why it matters: backend operations could hang indefinitely, degrading responsiveness and reliability.
   - Result: fixed with hard timeouts and `GIT_TERMINAL_PROMPT=0`.

4. **Diagnostics path leaked environment secrets and wrote outside app support root** (`high`)
   - Why it matters: diagnostics could persist credentials and violate storage boundary expectations.
   - Result: fixed by redacting sensitive env keys, adding timeout, and writing only under app support artifacts.

5. **PTY lifecycle allowed duplicate active sessions per thread** (`medium`)
   - Why it matters: stale session processes can survive restarts/restarts-for-same-thread and consume resources.
   - Result: fixed by evicting/killing existing sessions for the same workspace-thread before new session start and draining all sessions on shutdown.

## B. Findings table

| title | severity | impacted files | repro steps | likely root cause | proposed fix approach | estimated effort |
| --- | --- | --- | --- | --- | --- | --- |
| Path traversal through unvalidated IDs | high | `src-tauri/src/storage.rs` | Invoke storage commands with crafted `thread_id` like `../x` via Tauri command boundary | IDs were joined into filesystem paths without segment validation | Validate storage segments (`workspace_id`/`thread_id`) and reject separators/dot segments/NUL | S |
| Thread metadata race + partial-write risk | high | `src-tauri/src/storage.rs` | Concurrently call session capture/update paths; also crash during direct `fs::write` | Non-atomic writes and unsynchronized read-modify-write mutation | Atomic temp-file rename writes + global metadata mutation lock + CAS-safe capture | M |
| Git command hangs / prompt blocking | high | `src-tauri/src/git_tools.rs` | Run git operation in repo state that triggers interactive auth or long-running command | `Command::output()` without timeout and prompt suppression | Add timeout wrapper, poll/kill on timeout, disable terminal prompts (`GIT_TERMINAL_PROMPT=0`) | M |
| Diagnostics leaks secrets and writes to cwd artifacts | high | `src-tauri/src/runner.rs` | Run diagnostics in env with tokens; inspect saved file | Full `env` dump persisted raw; artifact path derived from process cwd | Redact sensitive env keys, add timeout, force artifact writes under app support dir | S |
| PTY session duplication per thread | medium | `src-tauri/src/runner.rs` | Start/restart terminal for same thread repeatedly; observe multiple background processes | Session manager keyed only by session id with no thread-level eviction | Remove+kill existing sessions for same workspace/thread before inserting new session | M |
| Branch switch safety while PTY active | medium | `src-tauri/src/main.rs` | Attempt branch checkout while terminal session still active in same workspace | Backend trusted frontend guard only | Add backend guard via runner state (`has_active_sessions_for_workspace`) before checkout/create-checkout | S |
| Resume capture path contains dead capture branch (`should_capture_session_id` defaults false) | medium | `src-tauri/src/runner.rs` | Inspect startup flow and observe capture branch never toggled on | Legacy capture path diverged from current startup strategy | Follow-up: either remove dead branch or re-enable explicit capture strategy with tests | S |

## C. Concrete fixes

Implemented fixes for highest-impact issues:

1. **Storage safety + consistency hardening**
   - Added storage segment validation to prevent path traversal in thread/workspace path construction.
   - Replaced direct JSON writes with atomic temp-file-rename writes for settings/workspaces/thread metadata/general JSON files.
   - Added serialized metadata mutation helper to avoid read-modify-write races.
   - Made `set_thread_claude_session_id_if_missing` atomic under lock to enforce "first write wins" semantics.
   - Added tests:
     - rejects invalid thread path segments
     - concurrent session-id capture remains single-winner

2. **Git backend reliability and safety**
   - Added timeout-based process wrapper for git commands.
   - Added `GIT_TERMINAL_PROMPT=0` to avoid blocking interactive prompts.
   - Added detached-HEAD branch display fallback (`(detached at <sha>)`).
   - Added branch-name validation and `git check-ref-format --branch` gate before checkout/create.
   - Added test for unsafe branch name rejection.

3. **Diagnostics security + timeout**
   - Added timeout wrapper for diagnostics command execution.
   - Redacted sensitive environment keys in diagnostics output.
   - Restricted diagnostics artifact writes to app support artifacts directory.
   - Added test verifying env key redaction behavior.

4. **PTY lifecycle cleanup**
   - Added thread-scoped eviction in terminal session manager to remove/kill stale sessions before starting a new session for the same thread.
   - Updated shutdown path to drain session map and terminate all remaining processes.

5. **Checkout safety while PTY active**
   - Added backend guard for branch checkout/create-checkout commands to reject switches while terminal sessions are active for that workspace.

## D. Regression checks

Commands run:

- `cargo test` (from `src-tauri/`): **pass** (15 tests)
- `yarn test`: **fail** (`Command "test" not found` in this repo)
- `yarn tauri build`: **pass** (app + dmg bundles produced)

`yarn test:ui` was **not** run because changes were backend-only and no UI correctness behavior was intentionally modified.

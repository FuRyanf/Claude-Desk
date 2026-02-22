# Debug Notes

## Bug A: App icon missing or incorrect in built `.app`

### Reproduction
1. Build with `yarn tauri build`.
2. Open `/Users/rfu/Claude Desk/src-tauri/target/release/bundle/macos/Claude Desk.app`.
3. Finder/Dock may show a generic or stale icon when icon metadata is incomplete or bundle icons are not explicitly configured.

### Root cause
- The project did not have a single canonical icon source under versioned assets.
- `src-tauri/tauri.conf.json` did not explicitly declare bundle icons, so icon generation and bundle metadata were easier to drift.
- Icon regeneration was not documented as a repeatable build step.

### Fix
- Added canonical source icon: `/Users/rfu/Claude Desk/assets/icon.png`.
- Regenerated all platform icons into `/Users/rfu/Claude Desk/src-tauri/icons` via `tauri icon`.
- Added explicit `bundle.icon` entries in `/Users/rfu/Claude Desk/src-tauri/tauri.conf.json`.
- Added `yarn icons` script to regenerate icons deterministically.
- Documented icon rebuild workflow in README.

## Bug B: Add Workspace failed or felt unreliable

### Reproduction (pre-fix behavior)
1. Click `Add` in the left rail.
2. App relied on prompt/manual text input flow and did not use a native folder picker.
3. Errors were not consistently surfaced as persistent UI feedback.

### Root cause
- Workspace add flow was tied to fragile prompt/manual input behavior.
- No native directory selection path using Tauri dialog.
- Error feedback relied on transient browser primitives instead of in-app notification UX.

### Fix
- Implemented native directory picker using `@tauri-apps/plugin-dialog` (`open({ directory: true })`).
- Added fallback manual path modal (`AddWorkspaceModal`) for automation and picker failures.
- Added visible toast notifications for errors.
- Selection cancel path now no-ops safely.
- Successful add updates workspace/thread UI immediately and persists through existing storage layer.

## Bug C: Freeze on open / thread switch with large terminal logs

### Reproduction (pre-fix behavior)
1. Open a thread with a large `output.log` (long Claude terminal history).
2. App loads full log snapshot and writes it into xterm in one blocking call.
3. UI becomes unresponsive or appears frozen during hydration.

### Root cause
- `terminal_get_last_log` and `terminal_read_output` returned the entire log file.
- Frontend hydrated xterm with a single `term.write(...)` for the whole snapshot.
- Large payloads blocked the renderer/main thread during startup and thread switches.

### Fix
- Backend now returns a bounded tail snapshot (last 512KB) instead of full log for UI hydration.
- Frontend now replays snapshot content in buffered chunks instead of a single synchronous write.
- Added Rust tests for snapshot truncation behavior.

## Bug D: Delete thread could freeze when run folder was large

### Reproduction (pre-fix behavior)
1. Delete a thread containing large run/output artifacts.
2. Backend performed synchronous recursive delete before returning.
3. UI waited for delete completion and could appear frozen.

### Root cause
- `delete_thread` used direct `fs::remove_dir_all(...)` on the active thread folder in command path.

### Fix
- Delete now fast-renames the thread directory into a workspace `.trash` folder.
- Actual recursive removal runs in a background thread.
- UI returns immediately while cleanup finishes asynchronously.

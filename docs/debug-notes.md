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

# Full Access Mode

Claude Desk now includes a per-thread `Full Access` toggle in the header for terminal mode.

## What it changes

When a terminal session starts:

- `Full Access OFF` -> launches `claude`
- `Full Access ON` -> launches `claude --dangerously-skip-permissions`

This is applied in the interactive PTY startup path (`$SHELL -lic ...`), so behavior stays aligned with terminal execution.

## Persistence model

- `thread.json` stores `fullAccess: boolean`.
- Each thread keeps its own setting.
- Switching threads updates the header toggle immediately.
- Restarting the app preserves the thread’s Full Access value.

## Safety UX

- First time a user enables Full Access, Claude Desk shows a confirmation modal:
  - `Full Access disables permission prompts. Continue?`
- After confirmation, a local flag is saved and the prompt is not repeated every toggle.

## Visual behavior

- Toggle label stays visible in header: `Full Access ON` / `Full Access OFF`.
- ON state uses warning styling so risk is obvious during active runs.
- Running badge continues to show `Running for Xm Ys` while session is active.

## Notes

- Full Access does not modify prompts or Claude input formatting.
- The app remains a terminal shell around local Claude Code CLI behavior.

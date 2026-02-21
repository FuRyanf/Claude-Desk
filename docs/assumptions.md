# Assumptions

1. Target platform is macOS for `.app` packaging and dock/Finder icon behavior.
2. The app must remain fully local and use only local Claude Code CLI subprocess execution.
3. When the native folder picker is canceled by the user, no toast is shown and no modal is forced open.
4. Fallback manual path entry is required both for automation and for picker failure scenarios.
5. `Cmd+K`, `Cmd+N`, `Cmd+Shift+F`, and `Esc` are primary shortcuts on macOS.
6. Transcript virtualization can be satisfied with `react-virtuoso` dynamic list rendering.
7. UI layout constraints are validated at DOM/CSS level in tests (header 44px, sidebar 280px, composer as bottom row).
8. Verification loop should be runnable with a single local command (`make verify`) and produce diagnosis artifacts automatically.
9. Browser screenshots for failed verification runs are best-effort; if Playwright browser binary is missing, verify attempts installation and logs failures.
10. Repository may not have a Git history available in this environment; "small commits" intent is treated as small incremental code changes that keep builds passing.
11. Interactive terminal mode should mirror native `claude` behavior, so composer input is written directly into PTY without additional prompt wrapping.
12. UI layer may focus on one active PTY session at a time while backend supports multiple concurrent sessions.
13. Opening/selecting a thread should auto-start a fresh PTY session so users can type immediately without a separate Resume step.
14. Codex-like simplification means left-rail threads/workspaces and header run status are prioritized; non-essential skill/context controls stay out of main flow.

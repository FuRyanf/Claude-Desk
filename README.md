# Claude Desk

Claude Desk is a native macOS desktop app (Tauri v2 + React + TypeScript) that wraps the local Claude Code CLI.

It does **not** call Anthropic APIs directly. All runs execute your local `claude` executable as a local subprocess.

## Features

- Native `.app` bundle via Tauri v2
- Codex-like shell layout:
  - fixed left rail (workspace selector, add, new thread, search, thread list)
  - compact 44px header (workspace, git branch/state, agent, Full Access, actions, status)
  - embedded interactive terminal panel for active Claude sessions
- PTY-backed Claude terminal mode (equivalent to running `claude` in Terminal):
  - ANSI rendering via `xterm.js`
  - interactive keyboard input, paste, arrows, prompts
  - terminal resize forwarding
  - `Cmd+C` -> SIGINT
- Global command palette (`Cmd+K`) with workspace switching
- Workspace skill discovery (`<workspace>/skills/*/SKILL.md`)
- Git integration:
  - branch + short hash
  - dirty indicator
  - ahead/behind counters when upstream exists
- Full Access mode (`--dangerously-skip-permissions`) with clear red UI indicators
- Local persistence under `~/Library/Application Support/ClaudeDesk/`

## Keyboard Shortcuts

- `Cmd+N` New thread
- `Cmd+K` Global command palette
- `Esc` on active terminal:
  - first press sends `SIGINT`
  - second press (within ~1.5s) kills session
- `Esc` otherwise closes topmost modal/palette
- `Cmd+Shift+F` Toggle Full Access

## Storage Model

Claude Desk stores data in:

`$HOME/Library/Application Support/ClaudeDesk/`

Layout:

- `workspaces.json`
- `settings.json`
- `threads/<workspaceId>/<threadId>/`
  - `thread.json`
  - `transcript.jsonl`
  - `runs/<runId>/`
    - `input_manifest.json`
    - `output.log`
    - `patch.diff`
    - `metadata.json`

## Prerequisites

- macOS 12+
- Node.js 16+
- Yarn
- Rust toolchain + Cargo

Install Rust if missing:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

## Development

```bash
yarn install --ignore-engines
yarn build
yarn tauri dev
```

## How To Build A macOS `.app`

```bash
yarn build
yarn tauri build
```

Output bundle:

- `/Users/rfu/Claude Desk/src-tauri/target/release/bundle/macos/Claude Desk.app`

DMG output:

- `/Users/rfu/Claude Desk/src-tauri/target/release/bundle/dmg/Claude Desk_0.1.0_aarch64.dmg`

## How To Update The Icon

Single source icon:

- `/Users/rfu/Claude Desk/assets/icon.png`

Regenerate Tauri icon set:

```bash
yarn icons
```

This rewrites generated assets under:

- `/Users/rfu/Claude Desk/src-tauri/icons`

Then rebuild:

```bash
yarn tauri build
```

If Finder/Dock still shows an old icon, remove previous app copies and open the newly built `.app` bundle again.

## Verification Loop

Run everything with one command:

```bash
make verify
```

`make verify` runs local build + UI tests + Rust tests + a Claude PTY smoke test, writes logs/screenshots to `artifacts/`, and emits `artifacts/last_diagnosis.md` on failures.

Details: `/Users/rfu/Claude Desk/docs/iteration-loop.md`

## Interactive Terminal Mode

### How it works

- The app starts a real PTY session and launches `claude` in interactive mode (no `-p` wrapper path).
- PTY output is streamed to frontend events:
  - `terminal:data` with `{ sessionId, data }`
  - `terminal:exit` with `{ sessionId, code, signal }`
- `xterm.js` renders raw ANSI output and forwards typed input back to PTY.
- Interaction behavior:
  - terminal input is the source of truth (direct PTY keystrokes)
  - no secondary chat composer is shown while interacting with a thread
  - opening an inactive thread shows read-only log + `Resume` to start a fresh PTY
- Per-thread run logs are persisted under `threads/<workspaceId>/<threadId>/runs/<sessionId>/output.log`.
- Opening a thread with no active session shows the last saved terminal log in read-only mode with a `Resume` button.

### Limitations

- UI currently targets one active interactive terminal session at a time.
- Stored log replay is raw terminal output; it is not a reconstructed semantic transcript.
- Signal API currently supports `SIGINT` explicitly; hard kill is available via `terminal_kill`.

### Troubleshooting

- If sessions do not start, check Settings and ensure the Claude CLI path is valid.
- If terminal appears blank, send a line from composer or click `Resume` and then type directly in the terminal.
- If Claude hangs on a command, use `Esc` once for interrupt, then `Esc` again for force kill.

## Phase 1 Validation Checklist

1. Click `Add` in left rail and select a folder from native dialog.
2. Cancel folder selection and confirm nothing changes.
3. Click `Path` and add a workspace manually; verify it appears immediately.
4. Build app and confirm icon shows correctly in Finder and Dock.
5. Confirm header shows git branch and dirty marker after editing a file.
6. Toggle Full Access and verify red badge appears in header and preflight.
7. Type `/` in composer and confirm grouped slash palette (`Commands`, `Skills`).
8. Select `/skill <name>` and confirm skill chip appears.
9. Run a prompt and verify streaming appears smoothly with no major layout shifts.
10. Use `Cmd+K`, `Cmd+N`, `Cmd+Shift+F`, and `Esc` to confirm shortcuts.

## Notes

- If Claude CLI is missing, the app blocks runs and prompts Settings.
- CLI detection checks common macOS locations and `which claude`.
- The app executes Claude in the selected workspace directory.

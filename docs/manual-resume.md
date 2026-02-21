# Manual Resume Checklist

## 1) Capture a new session id

1. Open Claude Desk and create a new thread.
2. Wait for Claude terminal startup.
3. Send at least one message.
4. Confirm thread eventually has a saved session id (context menu `Copy resume command` is enabled).

Expected:
- Header shows `New session`.
- `Copy resume command` copies `claude --resume <uuid>`.

## 2) Verify true resume after restart

1. Quit Claude Desk.
2. Re-open Claude Desk.
3. Open the same thread.

Expected:
- Terminal auto-starts with resume semantics.
- Header shows `Resumed`.
- Claude remembers prior conversation context.

## 3) Start fresh reset

1. Open thread context menu.
2. Click `Start fresh session`.
3. Wait for terminal to relaunch and continue chatting.

Expected:
- Stored session id is cleared, then a new one is captured from CLI output.
- Header shows `New session` after relaunch.

## 4) Full Access + resume compatibility

1. Turn `Full Access` ON for a thread.
2. Open/reopen that thread.

Expected:
- Resume/new startup still works.
- Claude launches with `--dangerously-skip-permissions` in both new and resumed paths.

## 5) MCP parity sanity check

1. In a resumed thread, run `/mcp`.
2. Confirm MCP connectivity behaves the same as Terminal.

Expected:
- Login-shell startup parity (`$SHELL -lic`) is maintained.
- MCP works in resumed and fresh sessions.

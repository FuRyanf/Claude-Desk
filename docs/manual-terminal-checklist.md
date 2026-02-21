# Manual Terminal Checklist

1. Start session
- Open a workspace and thread.
- Click `Resume`.
- Confirm terminal panel is interactive and status changes to `Running`.

2. Type a prompt
- Click inside terminal and type a follow-up prompt directly.
- Confirm interactive Claude output appears (not just final one-shot text).

3. Interrupt with `Cmd+C`
- While terminal is focused, press `Cmd+C`.
- Confirm in-flight Claude action is interrupted similarly to Terminal behavior.

4. Resize window
- Resize the app window larger/smaller.
- Confirm terminal reflows without broken rendering or severe lag.

5. Paste multiline
- Paste multiple lines into terminal input.
- Confirm text arrives in Claude session and executes correctly.

6. Toggle Full Access and confirm flag
- Toggle `Full Access ON` in header for the thread.
- Start/resume a new session.
- Confirm `--dangerously-skip-permissions` appears in that session run manifest:
  - `~/Library/Application Support/ClaudeDesk/threads/<workspaceId>/<threadId>/runs/<sessionId>/input_manifest.json`

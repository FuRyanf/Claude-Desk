# Manual Terminal Checklist

## 1. Launch path parity
1. Launch `Claude Desk.app` from Finder.
2. Open a workspace thread and run `/mcp`.
3. Quit app.
4. Launch from Terminal (for comparison) and run `/mcp` again.

Expected:
- MCP connectivity behavior matches between Finder launch and Terminal launch.

## 2. Rename thread
1. In left rail, right-click a thread.
2. Click `Rename`.
3. Type new name and press `Enter`.

Expected:
- Title updates immediately and persists after relaunch.

## 3. Archive thread
1. Right-click a thread.
2. Click `Archive`.

Expected:
- Thread disappears from default list.
- Thread data remains on disk in thread folder.

## 4. Delete thread
1. Right-click a thread.
2. Click `Delete`.
3. Confirm in modal.

Expected:
- Thread is removed from list and thread folder is deleted from disk.

## 5. Switch threads while running
1. Start work in thread A.
2. Switch to thread B.
3. Confirm terminal area shows thread B transcript and accepts input.
4. Return to thread A.

Expected:
- Threads remain isolated.
- Status/running badge reflects actual active work, not every open session.

## 6. Keyboard controls in terminal
1. Focus terminal and run a long command.
2. Press `Cmd+C` once.
3. Press `Esc` once, then twice quickly.

Expected:
- `Cmd+C` sends `SIGINT`.
- `Esc` sends `SIGINT`; second quick `Esc` kills session.

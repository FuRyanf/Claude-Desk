# Manual Left Rail Checklist

## 1. Workspace + thread grouping
1. Add two workspaces.
2. Select each workspace and confirm only that workspace's threads are shown.
3. Confirm thread rows show title + relative time.

Expected:
- No cross-workspace thread mixing.
- Selected workspace is visually highlighted.

## 2. New thread identity
1. Select a workspace.
2. Click `New thread` three times.
3. Reload app.

Expected:
- Exactly three distinct thread rows remain.
- Order is by most recently updated.

## 3. Inline rename
1. Double-click a thread title.
2. Type a new title and press `Enter`.
3. Repeat and press `Esc` instead.

Expected:
- `Enter` persists rename.
- `Esc` cancels rename.

## 4. Search behavior
1. Type a partial title into `Search threads`.
2. Clear search.

Expected:
- Filter only hides/shows existing rows.
- No duplicate rows appear.
- Clearing restores full list.

## 5. Running indicator
1. Open a thread and send input.
2. Observe header and thread row.

Expected:
- Header shows `Running for ...` while active.
- Active thread row shows spinner + elapsed time.
- After exit, status changes to `Succeeded`, `Failed`, or `Canceled`.

## 6. Thread isolation
1. Start a run in thread A.
2. Switch to thread B.
3. Send input in thread B.

Expected:
- Runs remain attached to their own thread IDs.
- Switching threads changes terminal target and does not merge logs/metadata.

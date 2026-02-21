import dayjs from 'dayjs';
import type { ThreadMetadata, Workspace } from '../types';

interface LeftRailProps {
  workspaces: Workspace[];
  threads: ThreadMetadata[];
  selectedWorkspaceId?: string;
  selectedThreadId?: string;
  threadSearch: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenWorkspacePicker: () => void;
  onOpenManualWorkspaceModal: () => void;
  onNewThread: () => void;
  onThreadSearchChange: (value: string) => void;
  onSelectThread: (threadId: string) => void;
}

export function LeftRail({
  workspaces,
  threads,
  selectedWorkspaceId,
  selectedThreadId,
  threadSearch,
  onSelectWorkspace,
  onOpenWorkspacePicker,
  onOpenManualWorkspaceModal,
  onNewThread,
  onThreadSearchChange,
  onSelectThread
}: LeftRailProps) {
  return (
    <aside className="left-rail" data-testid="sidebar" aria-label="Workspace sidebar" style={{ width: 280 }}>
      <div className="workspace-controls">
        <label htmlFor="workspace-select">Workspace</label>
        <div className="workspace-row">
          <select
            id="workspace-select"
            value={selectedWorkspaceId ?? ''}
            onChange={(event) => onSelectWorkspace(event.target.value)}
          >
            <option value="" disabled>
              Select workspace
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button type="button" className="ghost-button" onClick={onOpenWorkspacePicker}>
            Add
          </button>
          <button type="button" className="ghost-button" onClick={onOpenManualWorkspaceModal}>
            Path
          </button>
        </div>
      </div>

      <button type="button" className="primary-button" onClick={onNewThread} disabled={!selectedWorkspaceId}>
        New thread
      </button>

      <div className="thread-search">
        <input
          type="text"
          value={threadSearch}
          onChange={(event) => onThreadSearchChange(event.target.value)}
          placeholder="Search threads"
          aria-label="Search threads"
        />
      </div>

      <div className="thread-groups">
        {threads.length === 0 ? (
          <p className="muted">No threads yet.</p>
        ) : (
          <ul>
            {threads.map((thread) => {
              const active = thread.id === selectedThreadId;
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => onSelectThread(thread.id)}
                    className={active ? 'thread-button active' : 'thread-button'}
                  >
                    <span className="thread-title">{thread.title}</span>
                    <span className="thread-time">{dayjs(thread.updatedAt).format('MMM D HH:mm')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

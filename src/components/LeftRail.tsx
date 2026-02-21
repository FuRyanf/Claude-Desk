import * as React from 'react';
import type { ThreadMetadata, Workspace } from '../types';

interface ActiveRunInfo {
  startedAt: string;
}

interface LeftRailProps {
  workspaces: Workspace[];
  threadsByWorkspace: Record<string, ThreadMetadata[]>;
  selectedWorkspaceId?: string;
  selectedThreadId?: string;
  threadSearch: string;
  nowMs: number;
  activeRunsByThread: Record<string, ActiveRunInfo>;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenWorkspacePicker: () => void;
  onOpenManualWorkspaceModal: () => void;
  onNewThread: () => void;
  onThreadSearchChange: (value: string) => void;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (workspaceId: string, threadId: string, title: string) => Promise<void>;
  getSearchTextForThread?: (threadId: string) => string;
}

function formatDurationShort(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatRelativeShort(iso: string, nowMs: number): string {
  const sourceMs = Date.parse(iso);
  if (!Number.isFinite(sourceMs)) {
    return 'now';
  }

  const diffSeconds = Math.max(1, Math.floor((nowMs - sourceMs) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d`;
  }

  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w`;
}

export function LeftRail({
  workspaces,
  threadsByWorkspace,
  selectedWorkspaceId,
  selectedThreadId,
  threadSearch,
  nowMs,
  activeRunsByThread,
  onSelectWorkspace,
  onOpenWorkspacePicker,
  onOpenManualWorkspaceModal,
  onNewThread,
  onThreadSearchChange,
  onSelectThread,
  onRenameThread,
  getSearchTextForThread
}: LeftRailProps) {
  const [editingThreadId, setEditingThreadId] = React.useState<string | null>(null);
  const [editingValue, setEditingValue] = React.useState('');

  const query = threadSearch.trim().toLowerCase();

  return (
    <aside className="left-rail" data-testid="sidebar" aria-label="Workspace sidebar" style={{ width: 280 }}>
      <div className="workspace-controls">
        <label>Workspaces</label>
        <div className="workspace-row workspace-action-row">
          <button type="button" className="ghost-button" onClick={onOpenWorkspacePicker}>
            Add
          </button>
          <button type="button" className="ghost-button" onClick={onOpenManualWorkspaceModal}>
            Path
          </button>
          <button type="button" className="primary-button" onClick={onNewThread} disabled={!selectedWorkspaceId}>
            New thread
          </button>
        </div>
      </div>

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
        <ul className="workspace-groups">
          {workspaces.map((workspace) => {
            const isSelectedWorkspace = workspace.id === selectedWorkspaceId;
            const allThreads = threadsByWorkspace[workspace.id] ?? [];
            const visibleThreads = allThreads.filter((thread) => {
              if (!isSelectedWorkspace) {
                return false;
              }
              if (!query) {
                return true;
              }
              const titleMatch = thread.title.toLowerCase().includes(query);
              const contentMatch = (getSearchTextForThread?.(thread.id) ?? '').toLowerCase().includes(query);
              return titleMatch || contentMatch;
            });

            return (
              <li key={workspace.id} className={isSelectedWorkspace ? 'workspace-group selected' : 'workspace-group'}>
                <button
                  type="button"
                  className="workspace-group-button"
                  onClick={() => onSelectWorkspace(workspace.id)}
                  title={workspace.path}
                >
                  <span className="workspace-group-name">{workspace.name}</span>
                  <span className="workspace-group-count">{allThreads.length}</span>
                </button>

                {isSelectedWorkspace ? (
                  visibleThreads.length === 0 ? (
                    <p className="muted workspace-group-empty">No matching threads.</p>
                  ) : (
                    <ul className="workspace-thread-list">
                      {visibleThreads.map((thread) => {
                        const active = thread.id === selectedThreadId;
                        const activeRun = activeRunsByThread[thread.id];
                        const runningFor = activeRun
                          ? formatDurationShort((nowMs - Date.parse(activeRun.startedAt)) / 1000)
                          : null;
                        const lastRunStatus = thread.lastRunStatus ?? 'Idle';

                        return (
                          <li key={thread.id}>
                            <button
                              type="button"
                              onClick={() => onSelectThread(thread.id)}
                              className={active ? 'thread-button active' : 'thread-button'}
                            >
                              <span className="thread-main-row">
                                {editingThreadId === thread.id ? (
                                  <input
                                    className="thread-rename-input"
                                    value={editingValue}
                                    autoFocus
                                    onChange={(event) => setEditingValue(event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={async (event) => {
                                      if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setEditingThreadId(null);
                                        setEditingValue('');
                                      }
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                        const trimmed = editingValue.trim();
                                        if (!trimmed) {
                                          return;
                                        }
                                        await onRenameThread(thread.workspaceId, thread.id, trimmed);
                                        setEditingThreadId(null);
                                        setEditingValue('');
                                      }
                                    }}
                                    onBlur={async () => {
                                      const trimmed = editingValue.trim();
                                      if (trimmed) {
                                        await onRenameThread(thread.workspaceId, thread.id, trimmed);
                                      }
                                      setEditingThreadId(null);
                                      setEditingValue('');
                                    }}
                                  />
                                ) : (
                                  <span
                                    className="thread-title"
                                    onDoubleClick={(event) => {
                                      event.preventDefault();
                                      setEditingThreadId(thread.id);
                                      setEditingValue(thread.title);
                                    }}
                                  >
                                    {thread.title}
                                  </span>
                                )}
                                <span className="thread-time">{formatRelativeShort(thread.updatedAt, nowMs)}</span>
                              </span>

                              <span className="thread-status-row">
                                {activeRun ? (
                                  <span className="thread-running" title="Active run">
                                    <span className="spinner-dot" />
                                    <span>Running {runningFor}</span>
                                  </span>
                                ) : lastRunStatus !== 'Idle' ? (
                                  <span className="thread-last-status">{lastRunStatus.toLowerCase()}</span>
                                ) : null}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

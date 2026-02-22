import * as React from 'react';
import type { ThreadMetadata, Workspace } from '../types';

interface ActiveRunInfo {
  startedAt: string;
}

interface LeftRailProps {
  sidebarWidth: number;
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
  onOpenSettings: () => void;
  onNewThread: () => void;
  onNewThreadInWorkspace: (workspaceId: string) => Promise<void>;
  onThreadSearchChange: (value: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (workspaceId: string, threadId: string, title: string) => Promise<void>;
  onArchiveThread: (workspaceId: string, threadId: string) => Promise<void>;
  onDeleteThread: (workspaceId: string, threadId: string) => Promise<void>;
  onCopyResumeCommand: (thread: ThreadMetadata) => Promise<void>;
  getSearchTextForThread?: (threadId: string) => string;
}

interface ThreadContextMenuState {
  thread: ThreadMetadata;
  x: number;
  y: number;
}

interface WorkspaceContextMenuState {
  workspace: Workspace;
  x: number;
  y: number;
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 6.75A1.75 1.75 0 0 1 4.75 5h4.1c.56 0 1.08.27 1.41.72l.76 1.03c.14.2.37.31.61.31h7.67A1.75 1.75 0 0 1 21 8.8v8.45A1.75 1.75 0 0 1 19.25 19H4.75A1.75 1.75 0 0 1 3 17.25V6.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {expanded ? (
        <path d="M6 9.5 12 15l6-5.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      ) : (
        <path d="m9 6 5.5 6L9 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      )}
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function PathIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5.5 18.5 18.5 5.5M8.75 5.5h9.75v9.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThreadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 6v12M6 12h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
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
  sidebarWidth,
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
  onOpenSettings,
  onNewThread,
  onNewThreadInWorkspace,
  onThreadSearchChange,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
  onCopyResumeCommand,
  getSearchTextForThread
}: LeftRailProps) {
  const [editingThreadId, setEditingThreadId] = React.useState<string | null>(null);
  const [editingValue, setEditingValue] = React.useState('');
  const [editingOriginal, setEditingOriginal] = React.useState('');
  const [contextMenu, setContextMenu] = React.useState<ThreadContextMenuState | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = React.useState<WorkspaceContextMenuState | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState<Record<string, boolean>>({});
  const contextMenuRef = React.useRef<HTMLDivElement | null>(null);
  const workspaceContextMenuRef = React.useRef<HTMLDivElement | null>(null);

  const query = threadSearch.trim().toLowerCase();

  React.useEffect(() => {
    if (!contextMenu && !workspaceContextMenu) {
      return;
    }

    const closeMenu = (event: Event) => {
      if (
        contextMenuRef.current?.contains(event.target as Node) ||
        workspaceContextMenuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setContextMenu(null);
      setWorkspaceContextMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setWorkspaceContextMenu(null);
      }
    };

    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', onEscape);

    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, [contextMenu, workspaceContextMenu]);

  React.useEffect(() => {
    setExpandedWorkspaceIds((current) => {
      const next: Record<string, boolean> = {};
      for (const workspace of workspaces) {
        next[workspace.id] = current[workspace.id] ?? true;
      }
      return next;
    });
  }, [workspaces]);

  const commitRename = React.useCallback(
    async (thread: ThreadMetadata) => {
      const trimmed = editingValue.trim().slice(0, 80);
      if (!trimmed) {
        setEditingThreadId(null);
        setEditingValue('');
        setEditingOriginal('');
        return;
      }

      if (trimmed !== editingOriginal) {
        await onRenameThread(thread.workspaceId, thread.id, trimmed);
      }

      setEditingThreadId(null);
      setEditingValue('');
      setEditingOriginal('');
    },
    [editingOriginal, editingValue, onRenameThread]
  );

  const summarizeThreadStatus = React.useCallback(
    (thread: ThreadMetadata, runningFor: string | null) => {
      if (runningFor) {
        return `Running ${runningFor}`;
      }
      if (thread.lastRunStatus === 'Failed') {
        return 'Failed';
      }
      if (thread.lastRunStatus === 'Canceled') {
        return 'Canceled';
      }
      if (thread.lastRunStatus === 'Succeeded') {
        return 'Succeeded';
      }
      return null;
    },
    []
  );

  return (
    <aside className="left-rail" data-testid="sidebar" aria-label="Workspace sidebar" style={{ width: sidebarWidth }}>
      <div className="workspace-controls codex-rail-header">
        <div className="codex-rail-title-row">
          <label>Threads</label>
          <div className="codex-rail-toolbar">
            <button type="button" className="icon-ghost-button" onClick={onOpenWorkspacePicker} title="Add workspace">
              <span className="rail-icon" aria-hidden="true">
                <PlusIcon />
              </span>
              <span>Add</span>
            </button>
            <button
              type="button"
              className="icon-ghost-button"
              onClick={onOpenManualWorkspaceModal}
              title="Add workspace by path"
            >
              <span className="rail-icon" aria-hidden="true">
                <PathIcon />
              </span>
              <span>Path</span>
            </button>
            <button
              type="button"
              className="icon-primary-button"
              onClick={onNewThread}
              disabled={!selectedWorkspaceId}
              title="New thread"
            >
              <span className="rail-icon" aria-hidden="true">
                <ThreadIcon />
              </span>
              <span>New thread</span>
            </button>
          </div>
        </div>

        <div className="thread-search codex-thread-search">
          <span className="search-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16 16l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="text"
            value={threadSearch}
            onChange={(event) => onThreadSearchChange(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
          />
        </div>
      </div>

      <div className="thread-groups">
        <ul className="workspace-groups">
          {workspaces.map((workspace) => {
            const isSelectedWorkspace = workspace.id === selectedWorkspaceId;
            const allThreads = threadsByWorkspace[workspace.id] ?? [];
            const visibleThreads = allThreads.filter((thread) => {
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
                  onClick={() => {
                    onSelectWorkspace(workspace.id);
                    setExpandedWorkspaceIds((current) => ({
                      ...current,
                      [workspace.id]: true
                    }));
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const x = Math.min(event.clientX, window.innerWidth - 180);
                    const y = Math.min(event.clientY, window.innerHeight - 140);
                    setContextMenu(null);
                    setWorkspaceContextMenu({ workspace, x, y });
                  }}
                  title={workspace.path}
                >
                  <span className="workspace-group-leading">
                    <span
                      className="workspace-chevron workspace-chevron-button"
                      role="button"
                      tabIndex={0}
                      aria-label={expandedWorkspaceIds[workspace.id] === false ? 'Expand folder' : 'Collapse folder'}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setExpandedWorkspaceIds((current) => ({
                          ...current,
                          [workspace.id]: !(current[workspace.id] ?? true)
                        }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        setExpandedWorkspaceIds((current) => ({
                          ...current,
                          [workspace.id]: !(current[workspace.id] ?? true)
                        }));
                      }}
                    >
                      <ChevronIcon expanded={expandedWorkspaceIds[workspace.id] !== false} />
                    </span>
                    <span className="workspace-folder-icon" aria-hidden="true">
                      <FolderIcon />
                    </span>
                    <span className="workspace-group-name">{workspace.name}</span>
                  </span>
                  <span className="workspace-group-count">{allThreads.length}</span>
                </button>

                {expandedWorkspaceIds[workspace.id] === false ? null : visibleThreads.length === 0 ? (
                  <p className="muted workspace-group-empty">No matching threads.</p>
                ) : (
                  <ul className="workspace-thread-list">
                    {visibleThreads.map((thread) => {
                      const active = thread.id === selectedThreadId;
                      const activeRun = activeRunsByThread[thread.id];
                      const runningFor = activeRun
                        ? formatDurationShort((nowMs - Date.parse(activeRun.startedAt)) / 1000)
                        : null;
                      const statusLine = summarizeThreadStatus(thread, runningFor);

                      return (
                        <li
                          key={thread.id}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            const x = Math.min(event.clientX, window.innerWidth - 180);
                            const y = Math.min(event.clientY, window.innerHeight - 160);
                            setWorkspaceContextMenu(null);
                            setContextMenu({ thread, x, y });
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectThread(thread.workspaceId, thread.id)}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              setEditingThreadId(thread.id);
                              setEditingValue(thread.title);
                              setEditingOriginal(thread.title);
                            }}
                            className={active ? 'thread-button active' : 'thread-button'}
                          >
                            <span className="thread-main-row">
                              {editingThreadId === thread.id ? (
                                <input
                                  className="thread-rename-input"
                                  value={editingValue}
                                  maxLength={80}
                                  autoFocus
                                  onChange={(event) => setEditingValue(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={async (event) => {
                                    if (event.key === 'Escape') {
                                      event.preventDefault();
                                      setEditingThreadId(null);
                                      setEditingValue('');
                                      setEditingOriginal('');
                                    }
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      await commitRename(thread);
                                    }
                                  }}
                                  onBlur={async () => {
                                    await commitRename(thread);
                                  }}
                                />
                              ) : (
                                <span
                                  className="thread-title"
                                  onDoubleClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setEditingThreadId(thread.id);
                                    setEditingValue(thread.title);
                                    setEditingOriginal(thread.title);
                                  }}
                                >
                                  {thread.title}
                                </span>
                              )}
                              <span className="thread-time">{formatRelativeShort(thread.updatedAt, nowMs)}</span>
                            </span>

                            {statusLine ? (
                              <span className="thread-status-row">
                                {activeRun ? (
                                  <span className="thread-running" title="Claude is processing a response">
                                    <span className="spinner-dot" />
                                    <span>{statusLine}</span>
                                  </span>
                                ) : (
                                  <span className="thread-last-status">{statusLine}</span>
                                )}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="left-rail-footer">
        <button type="button" className="icon-ghost-button footer-settings-button" onClick={onOpenSettings}>
          Settings
        </button>
      </footer>

      {contextMenu ? (
        <div className="thread-context-menu" ref={contextMenuRef} style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            type="button"
            onClick={async () => {
              await onNewThreadInWorkspace(contextMenu.thread.workspaceId);
              setContextMenu(null);
            }}
          >
            New thread
          </button>
          <button
            type="button"
            disabled={!contextMenu.thread.claudeSessionId}
            onClick={async () => {
              await onCopyResumeCommand(contextMenu.thread);
              setContextMenu(null);
            }}
          >
            Copy resume command
          </button>
          <div className="thread-context-divider" />
          <button
            type="button"
            onClick={() => {
              setEditingThreadId(contextMenu.thread.id);
              setEditingValue(contextMenu.thread.title);
              setEditingOriginal(contextMenu.thread.title);
              setContextMenu(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={async () => {
              await onArchiveThread(contextMenu.thread.workspaceId, contextMenu.thread.id);
              setContextMenu(null);
            }}
          >
            Archive
          </button>
          <button
            type="button"
            className="danger"
            onClick={async () => {
              setContextMenu(null);
              await onDeleteThread(contextMenu.thread.workspaceId, contextMenu.thread.id);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}

      {workspaceContextMenu ? (
        <div
          className="thread-context-menu"
          ref={workspaceContextMenuRef}
          style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}
        >
          <button
            type="button"
            onClick={async () => {
              await onNewThreadInWorkspace(workspaceContextMenu.workspace.id);
              setWorkspaceContextMenu(null);
            }}
          >
            New thread
          </button>
        </div>
      ) : null}
    </aside>
  );
}

import * as React from 'react';
import type { ThreadMetadata, Workspace } from '../types';

interface LeftRailProps {
  sidebarWidth: number;
  workspaces: Workspace[];
  threadsByWorkspace: Record<string, ThreadMetadata[]>;
  selectedWorkspaceId?: string;
  selectedThreadId?: string;
  threadSearch: string;
  onOpenWorkspacePicker: () => void;
  onOpenSettings: () => void;
  onNewThreadInWorkspace: (workspaceId: string) => Promise<void>;
  onThreadSearchChange: (value: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (workspaceId: string, threadId: string, title: string) => Promise<void>;
  onDeleteThread: (workspaceId: string, threadId: string) => Promise<void>;
  onOpenWorkspaceInFinder: (workspacePath: string) => void;
  onOpenWorkspaceInTerminal: (workspacePath: string) => void;
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
    <svg viewBox="0 0 24 24" aria-hidden="true" className={expanded ? 'workspace-chevron-icon expanded' : 'workspace-chevron-icon'}>
      <path d="m9 6 5.5 6L9 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14.3 4.5h4.2c.55 0 1 .45 1 1v4.2M19 5 11 13M6.25 8h2.6M5.5 19h13c.55 0 1-.45 1-1V11M5.5 19a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.8 7.2h14.4M9.5 4.8h5M8.3 7.2l.7 10.4a1.2 1.2 0 0 0 1.2 1.1h3.6a1.2 1.2 0 0 0 1.2-1.1l.7-10.4M10.3 10.4v5.8M13.7 10.4v5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatRelativeShort(iso: string): string {
  const sourceMs = Date.parse(iso);
  if (!Number.isFinite(sourceMs)) {
    return 'now';
  }

  const nowMs = Date.now();
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

interface ThreadRowProps {
  thread: ThreadMetadata;
  active: boolean;
  relativeTime: string;
  isEditing: boolean;
  editingValue: string;
  onEditingValueChange: (value: string) => void;
  onStartRename: (thread: ThreadMetadata) => void;
  onCommitRename: (thread: ThreadMetadata) => Promise<void>;
  onCancelRename: () => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onOpenThreadContextMenu: (event: React.MouseEvent, thread: ThreadMetadata) => void;
  onDeleteThread: (workspaceId: string, threadId: string) => Promise<void>;
}

const ThreadRow = React.memo(function ThreadRow({
  thread,
  active,
  relativeTime,
  isEditing,
  editingValue,
  onEditingValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onSelectThread,
  onOpenThreadContextMenu,
  onDeleteThread
}: ThreadRowProps) {
  return (
    <li
      key={thread.id}
      className={active ? 'thread-item active' : 'thread-item'}
      onContextMenu={(event) => {
        onOpenThreadContextMenu(event, thread);
      }}
    >
      <button
        type="button"
        onClick={() => onSelectThread(thread.workspaceId, thread.id)}
        onDoubleClick={(event) => {
          event.preventDefault();
          onStartRename(thread);
        }}
        className={active ? 'thread-button active' : 'thread-button'}
      >
        <span className="thread-main-row">
          <span className="thread-main-leading">
            {isEditing ? (
              <input
                className="thread-rename-input"
                value={editingValue}
                maxLength={80}
                autoFocus
                onChange={(event) => onEditingValueChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={async (event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onCancelRename();
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    await onCommitRename(thread);
                  }
                }}
                onBlur={async () => {
                  await onCommitRename(thread);
                }}
              />
            ) : (
              <span
                className="thread-title"
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onStartRename(thread);
                }}
              >
                {thread.title}
              </span>
            )}
          </span>
          <span className="thread-main-trailing">
            <span className="thread-time">{relativeTime}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="thread-delete-button"
        aria-label="Delete thread"
        title={`Delete ${thread.title}`}
        tabIndex={-1}
        onClick={async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await onDeleteThread(thread.workspaceId, thread.id);
        }}
      >
        <TrashIcon />
      </button>
    </li>
  );
});

function LeftRailComponent({
  sidebarWidth,
  workspaces,
  threadsByWorkspace,
  selectedWorkspaceId,
  selectedThreadId,
  threadSearch,
  onOpenWorkspacePicker,
  onOpenSettings,
  onNewThreadInWorkspace,
  onThreadSearchChange,
  onSelectThread,
  onRenameThread,
  onDeleteThread,
  onOpenWorkspaceInFinder,
  onOpenWorkspaceInTerminal,
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
  const renderCountRef = React.useRef(0);
  renderCountRef.current += 1;

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

  const onOpenThreadContextMenu = React.useCallback((event: React.MouseEvent, thread: ThreadMetadata) => {
    event.preventDefault();
    const x = Math.min(event.clientX, window.innerWidth - 180);
    const y = Math.min(event.clientY, window.innerHeight - 160);
    setWorkspaceContextMenu(null);
    setContextMenu({ thread, x, y });
  }, []);

  const onStartRename = React.useCallback((thread: ThreadMetadata) => {
    setEditingThreadId(thread.id);
    setEditingValue(thread.title);
    setEditingOriginal(thread.title);
  }, []);

  const onCancelRename = React.useCallback(() => {
    setEditingThreadId(null);
    setEditingValue('');
    setEditingOriginal('');
  }, []);

  return (
    <aside
      className="left-rail"
      data-testid="sidebar"
      aria-label="Workspace sidebar"
      style={{ width: sidebarWidth }}
      data-render-count={import.meta.env.MODE === 'test' ? renderCountRef.current : undefined}
    >
      <div className="workspace-controls codex-rail-header">
        <div className="codex-rail-title-row">
          <label>Threads</label>
          <div className="codex-rail-toolbar">
            <button
              type="button"
              className="icon-ghost-button add-project-button"
              onClick={onOpenWorkspacePicker}
              title="Add new project"
            >
              <span className="rail-icon" aria-hidden="true">
                <PlusIcon />
              </span>
              <span>Add new project</span>
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
            const isExpanded = expandedWorkspaceIds[workspace.id] !== false;
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
              <li
                key={workspace.id}
                className={isSelectedWorkspace ? 'workspace-group selected' : 'workspace-group'}
                data-expanded={isExpanded ? 'true' : 'false'}
              >
                <div className="workspace-group-container">
                  <div className="workspace-group-row">
                    <button
                      type="button"
                      className="workspace-group-button"
                      onClick={() => {
                        setExpandedWorkspaceIds((current) => ({
                          ...current,
                          [workspace.id]: !(current[workspace.id] ?? true)
                        }));
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        const x = Math.min(event.clientX, window.innerWidth - 180);
                        const y = Math.min(event.clientY, window.innerHeight - 140);
                        setContextMenu(null);
                        setWorkspaceContextMenu({ workspace, x, y });
                      }}
                    >
                      <span className="workspace-group-leading">
                        <span
                          className="workspace-chevron workspace-chevron-button"
                          role="button"
                          tabIndex={0}
                          aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
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
                          <ChevronIcon expanded={isExpanded} />
                        </span>
                        <span className="workspace-folder-icon" aria-hidden="true">
                          <FolderIcon />
                        </span>
                        <span className="workspace-group-name">{workspace.name}</span>
                      </span>
                    </button>
                    <span className="workspace-group-actions">
                      <button
                        type="button"
                        className="workspace-action-button"
                        aria-label="Workspace actions"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          const x = Math.min(rect.left, window.innerWidth - 180);
                          const y = Math.min(rect.bottom + 8, window.innerHeight - 140);
                          setContextMenu(null);
                          setWorkspaceContextMenu({ workspace, x, y });
                        }}
                      >
                        <DotsIcon />
                      </button>
                      <button
                        type="button"
                        className="workspace-action-button"
                        aria-label="Create thread"
                        data-testid={`workspace-compose-${workspace.id}`}
                        tabIndex={-1}
                        onClick={async (event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          await onNewThreadInWorkspace(workspace.id);
                        }}
                      >
                        <ComposeIcon />
                      </button>
                    </span>
                  </div>

                  {!isExpanded ? null : (
                    <div className="workspace-group-children">
                      {visibleThreads.length === 0 ? (
                        <p className="muted workspace-group-empty">No matching threads.</p>
                      ) : (
                        <ul className="workspace-thread-list">
                          {visibleThreads.map((thread) => {
                            return (
                              <ThreadRow
                                key={thread.id}
                                thread={thread}
                                active={thread.id === selectedThreadId}
                                relativeTime={formatRelativeShort(thread.updatedAt)}
                                isEditing={editingThreadId === thread.id}
                                editingValue={editingValue}
                                onEditingValueChange={setEditingValue}
                                onStartRename={onStartRename}
                                onCommitRename={commitRename}
                                onCancelRename={onCancelRename}
                                onSelectThread={onSelectThread}
                                onOpenThreadContextMenu={onOpenThreadContextMenu}
                                onDeleteThread={onDeleteThread}
                              />
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
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
            onClick={() => {
              onStartRename(contextMenu.thread);
              setContextMenu(null);
            }}
          >
            Rename
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
            onClick={() => {
              onOpenWorkspaceInFinder(workspaceContextMenu.workspace.path);
              setWorkspaceContextMenu(null);
            }}
          >
            Open folder
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenWorkspaceInTerminal(workspaceContextMenu.workspace.path);
              setWorkspaceContextMenu(null);
            }}
          >
            Open terminal
          </button>
        </div>
      ) : null}
    </aside>
  );
}

export const LeftRail = React.memo(LeftRailComponent);

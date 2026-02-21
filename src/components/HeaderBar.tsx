import type { GitInfo, ThreadMetadata, Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  gitInfo: GitInfo | null;
  thread?: ThreadMetadata;
  status: 'Idle' | 'Running';
  onToggleFullAccess: () => void;
  onOpenWorkspace: () => void;
  onOpenCommit: () => void;
  onAgentChange: (agentId: string) => void;
}

function gitLabel(gitInfo: GitInfo): string {
  const dirty = gitInfo.isDirty ? ' *' : '';
  const ahead = gitInfo.ahead > 0 ? ` ↑${gitInfo.ahead}` : '';
  const behind = gitInfo.behind > 0 ? ` ↓${gitInfo.behind}` : '';
  return `${gitInfo.branch}${dirty}${ahead}${behind}`;
}

export function HeaderBar({
  workspace,
  gitInfo,
  thread,
  status,
  onToggleFullAccess,
  onOpenWorkspace,
  onOpenCommit,
  onAgentChange
}: HeaderBarProps) {
  return (
    <header className="header-bar" data-testid="header" style={{ height: 44 }}>
      <div className="workspace-summary">
        <strong>{workspace?.name ?? 'No workspace selected'}</strong>
        {gitInfo ? (
          <span className={gitInfo.isDirty ? 'branch-pill dirty' : 'branch-pill'} title={`Commit ${gitInfo.shortHash}`}>
            {gitLabel(gitInfo)}
          </span>
        ) : (
          <span className="branch-pill muted-pill">No git repo</span>
        )}
      </div>

      <div className="header-actions">
        <select
          value={thread?.agentId ?? 'claude-code'}
          onChange={(event) => onAgentChange(event.target.value)}
          disabled={!thread}
        >
          <option value="claude-code">Claude Code</option>
        </select>

        <button
          type="button"
          onClick={onToggleFullAccess}
          className={thread?.fullAccess ? 'danger-button' : 'ghost-button'}
          disabled={!thread}
        >
          Full Access {thread?.fullAccess ? 'ON' : 'OFF'}
        </button>

        {thread?.fullAccess ? <span className="warning-badge">Full Access Enabled</span> : null}

        <button type="button" onClick={onOpenWorkspace} className="ghost-button" disabled={!workspace}>
          Open
        </button>

        <button type="button" onClick={onOpenCommit} className="ghost-button" disabled={!workspace}>
          Commit
        </button>

        <span className={status === 'Running' ? 'status running' : 'status'}>{status}</span>
      </div>
    </header>
  );
}

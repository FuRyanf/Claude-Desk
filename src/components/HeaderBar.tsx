import type { GitInfo, Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  gitInfo: GitInfo | null;
  statusLabel: string;
  runningForLabel?: string;
  onOpenWorkspace: () => void;
  onOpenTerminal: () => void;
  onOpenSettings: () => void;
}

function gitLabel(gitInfo: GitInfo): string {
  const dirty = gitInfo.isDirty ? ' *' : '';
  return `${gitInfo.branch}${dirty}`;
}

export function HeaderBar({
  workspace,
  gitInfo,
  statusLabel,
  runningForLabel,
  onOpenWorkspace,
  onOpenTerminal,
  onOpenSettings
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
        <span className={runningForLabel ? 'status running' : 'status'}>
          {runningForLabel ? `Running for ${runningForLabel}` : statusLabel}
        </span>
        <button type="button" onClick={onOpenWorkspace} className="ghost-button" disabled={!workspace}>
          Open
        </button>
        <button type="button" onClick={onOpenTerminal} className="ghost-button" disabled={!workspace}>
          Terminal
        </button>
        <button type="button" onClick={onOpenSettings} className="ghost-button">
          Menu
        </button>
      </div>
    </header>
  );
}

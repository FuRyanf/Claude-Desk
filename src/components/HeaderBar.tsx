import type { Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  sessionModeLabel?: string;
  statusLabel: string;
  runningForLabel?: string;
  onOpenWorkspace: () => void;
  onOpenTerminal: () => void;
  onOpenSettings: () => void;
}

export function HeaderBar({
  workspace,
  sessionModeLabel,
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
      </div>

      <div className="header-actions">
        {sessionModeLabel ? (
          <span
            className={
              sessionModeLabel.toLowerCase().startsWith('resum') ? 'session-mode-pill resumed' : 'session-mode-pill'
            }
          >
            <span className="session-mode-dot" />
            {sessionModeLabel}
          </span>
        ) : null}
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

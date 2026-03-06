import * as React from 'react';
import type { GitInfo, ThreadMetadata, Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  selectedThread?: ThreadMetadata;
  gitInfo?: GitInfo | null;
  updateAvailable?: boolean;
  updateVersionLabel?: string;
  updating?: boolean;
  onInstallUpdate: () => void;
  onOpenWorkspace: () => void;
  onRepairDisplay?: () => void;
  onOpenTerminal: () => void;
  terminalOpen?: boolean;
}

const DISPLAY_ISSUE_TIP_MS = 10_000;

function DisplayIssueTip({ onRepairDisplay }: { onRepairDisplay?: () => void }) {
  const [showTip, setShowTip] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  const clearTipTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleClick = () => {
    onRepairDisplay?.();

    if (showTip) {
      clearTipTimer();
      setShowTip(false);
      return;
    }

    setShowTip(true);
    clearTipTimer();
    timerRef.current = window.setTimeout(() => {
      setShowTip(false);
      timerRef.current = null;
    }, DISPLAY_ISSUE_TIP_MS);
  };

  React.useEffect(() => {
    return () => {
      clearTipTimer();
    };
  }, [clearTipTimer]);

  return (
    <div className="display-issue-tip-wrapper">
      <button
        type="button"
        className="fix-display-button"
        data-testid="fix-display-button"
        onClick={handleClick}
        title="Having display issues? Click for a quick fix tip."
      >
        Display issue?
      </button>
      {showTip ? (
        <div className="display-issue-tip" role="status">
          Try slightly dragging a window edge to rerender the terminal.
        </div>
      ) : null}
    </div>
  );
}

export function HeaderBar({
  workspace,
  selectedThread,
  gitInfo = null,
  updateAvailable = false,
  updateVersionLabel,
  updating = false,
  onInstallUpdate,
  onOpenWorkspace,
  onRepairDisplay,
  onOpenTerminal,
  terminalOpen = false
}: HeaderBarProps) {
  return (
    <header className="header-bar" data-testid="header">
      <div className={selectedThread ? 'workspace-summary thread-context' : 'workspace-summary'}>
        <strong>{selectedThread?.title ?? workspace?.name ?? 'No workspace selected'}</strong>
        {workspace ? (
          <span className="workspace-summary-secondary">
            {selectedThread ? workspace.name : workspace.path}
            {gitInfo?.branch ? <span className="header-branch-pill">{gitInfo.branch}</span> : null}
          </span>
        ) : null}
      </div>

      <div className="header-actions">
        <button type="button" onClick={onOpenWorkspace} className="ghost-button" disabled={!workspace}>
          Open
        </button>
        <DisplayIssueTip onRepairDisplay={onRepairDisplay} />
        {updateAvailable ? (
          <button
            type="button"
            onClick={onInstallUpdate}
            className="update-button"
            disabled={updating}
            title={updateVersionLabel ? `Update to ${updateVersionLabel}` : 'Update available'}
          >
            {updating ? 'Updating…' : 'Update'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onOpenTerminal}
          className={terminalOpen ? 'ghost-button active' : 'ghost-button'}
          disabled={!workspace}
        >
          Terminal
        </button>
      </div>
    </header>
  );
}

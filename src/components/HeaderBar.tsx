import * as React from 'react';
import type { GitInfo, ThreadMetadata, Workspace } from '../types';

const REFRESH_DISPLAY_HINT =
  'If the terminal looks broken, try dragging the window edge slightly to force a reflow.';
const REFRESH_DISPLAY_HINT_LINGER_MS = 2200;

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
  repairDisplayDisabled?: boolean;
  onOpenTerminal: () => void;
  terminalOpen?: boolean;
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
  repairDisplayDisabled = false,
  onOpenTerminal,
  terminalOpen = false
}: HeaderBarProps) {
  const refreshHintId = React.useId();
  const [showRefreshHint, setShowRefreshHint] = React.useState(false);
  const refreshHintTimerRef = React.useRef<number | null>(null);

  const clearRefreshHintTimer = React.useCallback(() => {
    if (refreshHintTimerRef.current !== null) {
      window.clearTimeout(refreshHintTimerRef.current);
      refreshHintTimerRef.current = null;
    }
  }, []);

  const openRefreshHint = React.useCallback(() => {
    clearRefreshHintTimer();
    setShowRefreshHint(true);
  }, [clearRefreshHintTimer]);

  const scheduleRefreshHintHide = React.useCallback(() => {
    clearRefreshHintTimer();
    refreshHintTimerRef.current = window.setTimeout(() => {
      refreshHintTimerRef.current = null;
      setShowRefreshHint(false);
    }, REFRESH_DISPLAY_HINT_LINGER_MS);
  }, [clearRefreshHintTimer]);

  React.useEffect(() => () => clearRefreshHintTimer(), [clearRefreshHintTimer]);

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
        <div
          className="fix-display-button-wrapper"
          onMouseEnter={openRefreshHint}
          onMouseLeave={scheduleRefreshHintHide}
          onFocus={openRefreshHint}
          onBlur={scheduleRefreshHintHide}
        >
          <button
            type="button"
            className="fix-display-button"
            data-testid="fix-display-button"
            onClick={() => {
              openRefreshHint();
              scheduleRefreshHintHide();
              onRepairDisplay?.();
            }}
            disabled={repairDisplayDisabled}
            aria-describedby={refreshHintId}
          >
            Refresh Display
          </button>
          <span
            id={refreshHintId}
            role="tooltip"
            className={`header-hover-tip${showRefreshHint ? ' visible' : ''}`}
            aria-hidden={!showRefreshHint}
          >
            {REFRESH_DISPLAY_HINT}
          </span>
        </div>
        <button type="button" onClick={onOpenWorkspace} className="ghost-button" disabled={!workspace}>
          Open
        </button>
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

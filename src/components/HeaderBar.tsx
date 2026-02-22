import * as React from 'react';
import type { Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  onOpenWorkspace: () => void;
  onOpenTerminal: () => void;
}

export function HeaderBar({
  workspace,
  onOpenWorkspace,
  onOpenTerminal
}: HeaderBarProps) {
  return (
    <header className="header-bar" data-testid="header" style={{ height: 44 }}>
      <div className="workspace-summary">
        <strong>{workspace?.name ?? 'No workspace selected'}</strong>
      </div>

      <div className="header-actions">
        <button type="button" onClick={onOpenWorkspace} className="ghost-button" disabled={!workspace}>
          Open
        </button>
        <button type="button" onClick={onOpenTerminal} className="ghost-button" disabled={!workspace}>
          Terminal
        </button>
      </div>
    </header>
  );
}

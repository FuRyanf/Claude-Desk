import * as React from 'react';
import type { ThreadMetadata, Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  selectedThread?: ThreadMetadata;
  onOpenWorkspace: () => void;
  onOpenTerminal: () => void;
}

export function HeaderBar({
  workspace,
  selectedThread,
  onOpenWorkspace,
  onOpenTerminal
}: HeaderBarProps) {
  return (
    <header className="header-bar" data-testid="header" style={{ height: 44 }}>
      <div className={selectedThread ? 'workspace-summary thread-context' : 'workspace-summary'}>
        {selectedThread ? (
          <>
            <strong>{selectedThread.title}</strong>
            <span className="workspace-summary-secondary">{workspace?.name ?? ''}</span>
          </>
        ) : (
          <strong>{workspace?.name ?? 'No workspace selected'}</strong>
        )}
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

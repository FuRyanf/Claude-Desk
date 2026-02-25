import * as React from 'react';
import type { ThreadMetadata, Workspace } from '../types';

interface HeaderBarProps {
  workspace?: Workspace;
  selectedThread?: ThreadMetadata;
  updateAvailable?: boolean;
  updateVersionLabel?: string;
  updating?: boolean;
  onInstallUpdate: () => void;
  onOpenWorkspace: () => void;
  onOpenTerminal: () => void;
}

export function HeaderBar({
  workspace,
  selectedThread,
  updateAvailable = false,
  updateVersionLabel,
  updating = false,
  onInstallUpdate,
  onOpenWorkspace,
  onOpenTerminal
}: HeaderBarProps) {
  return (
    <header className="header-bar" data-testid="header">
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

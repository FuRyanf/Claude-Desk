import * as React from 'react';

import type { Workspace } from '../types';
import { TerminalPanel } from './TerminalPanel';

interface WorkspaceShellDrawerProps {
  open: boolean;
  workspace?: Workspace;
  sessionId?: string | null;
  content: string;
  starting?: boolean;
  focusRequestId?: number;
  repairRequestId?: number;
  onClose: () => void;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

export function WorkspaceShellDrawer({
  open,
  workspace,
  sessionId = null,
  content,
  starting = false,
  focusRequestId = 0,
  repairRequestId = 0,
  onClose,
  onData,
  onResize,
  onFocusChange
}: WorkspaceShellDrawerProps) {
  if (!open || !workspace) {
    return null;
  }

  return (
    <section className="workspace-shell-drawer" data-testid="workspace-shell-drawer">
      <div className="workspace-shell-drawer-header">
        <div className="workspace-shell-drawer-title-group">
          <strong>Terminal</strong>
          <span>{workspace.name}</span>
        </div>
        <button
          type="button"
          className="workspace-shell-drawer-close"
          aria-label="Close terminal drawer"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="workspace-shell-drawer-body">
        <TerminalPanel
          sessionId={sessionId}
          content={content}
          inputEnabled={Boolean(sessionId) && !starting}
          overlayMessage={
            starting
              ? 'Starting terminal...'
              : !sessionId
                ? 'Terminal ended. Use the Terminal button to reopen.'
                : undefined
          }
          focusRequestId={focusRequestId}
          repairRequestId={repairRequestId}
          onData={onData}
          onResize={onResize}
          onFocusChange={onFocusChange}
        />
      </div>
    </section>
  );
}

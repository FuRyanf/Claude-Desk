/**
 * Regression tests for the "Fix display" button.
 *
 * Root cause: on cold start the xterm FitAddon may not have run with the
 * final DOM dimensions, leaving a blank gap at the bottom of the terminal.
 * A window resize fixes it because ResizeObserver → fitAddon.fit() →
 * onResize(cols, rows) → api.terminalResize() runs the correct reflow path.
 *
 * The "Fix display" button must trigger that same path via fixDisplayRequestId.
 *
 * Verification steps (manual):
 *   1. Open app on cold start — observe blank gap at bottom or input misalignment.
 *   2. Click "Fix display" in the bottom bar.
 *   3. Gap should close immediately (same result as dragging the window edge).
 *   4. Claude session continues uninterrupted.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mocks (minimal — mirrors app.full-access.test.tsx) ───────────────────────

const mocks = vi.hoisted(() => {
  const baseWorkspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    kind: 'local' as const,
    rdevSshCommand: null,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const baseThread = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    agentId: 'claude-code',
    fullAccess: false,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Test Thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: null
  };

  let threadState = [{ ...baseThread }];
  let lastFixDisplayRequestId = 0;

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => [baseWorkspace]),
    addWorkspace: vi.fn(async () => baseWorkspace),
    addRdevWorkspace: vi.fn(async () => baseWorkspace),
    addSshWorkspace: vi.fn(async () => baseWorkspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => baseWorkspace),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]),
    gitWorkspaceStatus: vi.fn(async () => ({ isDirty: false, uncommittedFiles: 0, insertions: 0, deletions: 0 })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({ outcome: 'pulled' as const, message: '' })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      const t = { ...baseThread, id: 'thread-2', title: 'New Thread' };
      threadState = [t, ...threadState];
      return t;
    }),
    renameThread: vi.fn(async () => threadState[0]),
    archiveThread: vi.fn(async () => threadState[0]),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async () => threadState[0]),
    clearThreadClaudeSession: vi.fn(async () => threadState[0]),
    setThreadSkills: vi.fn(async () => { throw new Error('not needed'); }),
    setThreadAgent: vi.fn(async () => { throw new Error('not needed'); }),
    appendUserMessage: vi.fn(async () => { throw new Error('not needed'); }),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude' })),
    saveSettings: vi.fn(async (s: { claudeCliPath: string | null }) => s),
    detectClaudeCliPath: vi.fn(async () => '/usr/local/bin/claude'),
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async () => ({
      sessionId: 'session-1',
      sessionMode: 'new' as const,
      resumeSessionId: null,
      thread: { ...baseThread, claudeSessionId: null, lastResumeAt: null, lastNewSessionAt: new Date().toISOString() }
    })),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ''),
    terminalReadOutput: vi.fn(async () => ''),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics')
  };

  const reset = () => {
    threadState = [{ ...baseThread }];
    lastFixDisplayRequestId = 0;
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    recordFixDisplayRequestId: (value: number) => {
      lastFixDisplayRequestId = value;
    },
    getLastFixDisplayRequestId: () => lastFixDisplayRequestId,
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async () => () => undefined),
    onTerminalExit: vi.fn(async () => () => undefined),
    onThreadUpdated: vi.fn(async () => () => undefined)
  };
});

vi.mock('../../src/lib/api', () => ({
  api: mocks.api,
  onRunStream: mocks.onRunStream,
  onRunExit: mocks.onRunExit,
  onTerminalData: mocks.onTerminalData,
  onTerminalExit: mocks.onTerminalExit,
  onThreadUpdated: mocks.onThreadUpdated
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDialog,
  confirm: mocks.confirmDialog
}));

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: (props: { fixDisplayRequestId?: number }) => {
    const value = props.fixDisplayRequestId ?? 0;
    mocks.recordFixDisplayRequestId(value);
    return (
      <section data-testid="terminal-panel-mock">
        <output data-testid="terminal-fix-display-request-id">{String(value)}</output>
      </section>
    );
  }
}));

import App from '../../src/App';

// ── tests ────────────────────────────────────────────────────────────────────

describe('"Fix display" button', () => {
  beforeEach(() => {
    mocks.reset();
    window.localStorage.clear();
  });

  it('renders in the bottom bar', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /Test Thread/i });
    expect(screen.getByTestId('fix-display-button')).toBeInTheDocument();
  });

  it('is always visible regardless of thread selection', async () => {
    render(<App />);
    // Before any thread is selected the button should still be present
    await waitFor(() => {
      expect(screen.getByTestId('fix-display-button')).toBeInTheDocument();
    });
  });

  it('clicking the button increments fixDisplayRequestId wiring into TerminalPanel', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: /Test Thread/i });
    await screen.findByTestId('terminal-fix-display-request-id');

    await waitFor(() => {
      expect(mocks.getLastFixDisplayRequestId()).toBe(0);
    });

    const btn = screen.getByTestId('fix-display-button');
    await user.click(btn);
    await waitFor(() => {
      expect(mocks.getLastFixDisplayRequestId()).toBe(1);
    });
    await user.click(btn);
    await waitFor(() => {
      expect(mocks.getLastFixDisplayRequestId()).toBe(2);
    });

    expect(screen.getByTestId('fix-display-button')).toBeInTheDocument();
  });

  it('clicking the button is independent from Full Access and does not modify thread state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: /Test Thread/i });

    await user.click(screen.getByTestId('fix-display-button'));

    // Should not have touched setThreadFullAccess
    expect(mocks.api.setThreadFullAccess).not.toHaveBeenCalled();
  });
});

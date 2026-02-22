import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
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
    title: 'First thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: null,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  let threadState = [{ ...baseThread }];
  let terminalDataHandler: ((event: { sessionId: string; data: string }) => void) | null = null;

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]),
    gitWorkspaceStatus: vi.fn(async () => ({
      isDirty: false,
      uncommittedFiles: 0,
      insertions: 0,
      deletions: 0
    })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      const next = {
        ...baseThread,
        id: `thread-${threadState.length + 1}`,
        title: 'New thread',
        updatedAt: new Date().toISOString()
      };
      threadState = [next, ...threadState];
      return next;
    }),
    renameThread: vi.fn(async (_workspaceId: string, threadId: string, title: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        title,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    archiveThread: vi.fn(async () => true),
    deleteThread: vi.fn(async (_workspaceId: string, threadId: string) => {
      threadState = threadState.filter((thread) => thread.id !== threadId);
      return true;
    }),
    setThreadFullAccess: vi.fn(async () => {
      throw new Error('not needed');
    }),
    clearThreadClaudeSession: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        claudeSessionId: null,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    setThreadSkills: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    appendUserMessage: vi.fn(async () => {
      throw new Error('not needed');
    }),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude' })),
    saveSettings: vi.fn(async (settings: { claudeCliPath: string | null }) => settings),
    detectClaudeCliPath: vi.fn(async () => '/usr/local/bin/claude'),
    terminalStartSession: vi.fn(async (params: { threadId: string }) => {
      const thread = threadState.find((item) => item.id === params.threadId) ?? threadState[0];
      return {
        sessionId: `session-${params.threadId}`,
        sessionMode: thread?.claudeSessionId ? 'resumed' : 'new',
        resumeSessionId: thread?.claudeSessionId ?? null,
        thread: {
          ...thread,
          claudeSessionId: thread?.claudeSessionId ?? null,
          lastResumeAt: thread?.claudeSessionId ? new Date().toISOString() : null,
          lastNewSessionAt: thread?.claudeSessionId ? null : new Date().toISOString()
        }
      };
    }),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ''),
    terminalReadOutput: vi.fn(async () => '> '),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics')
  };

  const reset = () => {
    threadState = [{ ...baseThread }];
    terminalDataHandler = null;
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    emitTerminalData: (event: { sessionId: string; data: string }) => {
      terminalDataHandler?.(event);
    },
    openDialog: vi.fn(async () => null),
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async (handler: (event: { sessionId: string; data: string }) => void) => {
      terminalDataHandler = handler;
      return () => {
        if (terminalDataHandler === handler) {
          terminalDataHandler = null;
        }
      };
    }),
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
  open: mocks.openDialog
}));

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: (props: { onData?: (data: string) => void }) => (
    <section className="terminal-panel" data-testid="terminal-panel-mock">
      <button type="button" onClick={() => props.onData?.('   First prompt title line\r')}>
        send-first-prompt
      </button>
      <button type="button" onClick={() => props.onData?.('Second title should not apply\r')}>
        send-second-prompt
      </button>
      <button type="button" onClick={() => props.onData?.('x')}>
        type-char
      </button>
    </section>
  )
}));

import App from '../../src/App';

describe('Sidebar behavior', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('does not render Crunching/Running/Completed labels in the UI', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });

    expect(screen.queryByText(/Crunching/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Running for/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Completed$/i)).not.toBeInTheDocument();
  });

  it('does not show a header timer badge even after output is emitted', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    expect(screen.queryByTestId('header-output-age')).not.toBeInTheDocument();

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'Claude output\n' });
    });

    expect(screen.queryByTestId('header-output-age')).not.toBeInTheDocument();
  });

  it('sets title once from first prompt and does not change while typing or later submits', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    fireEvent.click(screen.getByTestId('workspace-compose-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));
    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-2', 'First prompt title line');
    });

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    await user.click(screen.getByRole('button', { name: 'send-second-prompt' }));

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledTimes(1);
    });
  });

  it('does not rerender the sidebar on terminal keystrokes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'ready\n' });
    });

    const sidebar = await screen.findByTestId('sidebar');
    const before = Number(sidebar.getAttribute('data-render-count') ?? '0');

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalled();
    });

    const after = Number(screen.getByTestId('sidebar').getAttribute('data-render-count') ?? '0');
    expect(after).toBe(before);
  });
});

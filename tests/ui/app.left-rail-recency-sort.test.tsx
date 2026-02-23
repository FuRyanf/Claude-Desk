import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const baseNow = Date.parse('2026-02-22T10:00:00.000Z');
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date(baseNow - 10_000).toISOString(),
    updatedAt: new Date(baseNow - 10_000).toISOString()
  };

  const baseThreads = [
    {
      id: 'thread-older',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(baseNow - 7_200_000).toISOString(),
      updatedAt: new Date(baseNow - 7_200_000).toISOString(),
      title: 'Older thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    },
    {
      id: 'thread-newer',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(baseNow - 3_600_000).toISOString(),
      updatedAt: new Date(baseNow - 3_600_000).toISOString(),
      title: 'Newer thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    }
  ];

  let threadState = baseThreads.map((thread) => ({ ...thread }));
  let terminalDataHandler: ((event: { sessionId: string; data: string }) => void) | null = null;
  let terminalExitHandler: ((event: { sessionId: string; code: number | null; signal: number | null }) => void) | null = null;

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => workspace),
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
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
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
    clearThreadClaudeSession: vi.fn(async () => {
      throw new Error('not needed');
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
    terminalStartSession: vi.fn(async (params: { threadId: string }) => ({
      sessionId: `session-${params.threadId}`,
      sessionMode: 'new',
      resumeSessionId: null,
      thread: threadState.find((thread) => thread.id === params.threadId) ?? threadState[0]
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
    threadState = baseThreads.map((thread) => ({ ...thread }));
    terminalDataHandler = null;
    terminalExitHandler = null;
    window.localStorage.clear();
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    prependThread: (thread: (typeof baseThreads)[number]) => {
      threadState = [thread, ...threadState];
    },
    emitTerminalData: (event: { sessionId: string; data: string }) => {
      terminalDataHandler?.(event);
    },
    emitTerminalExit: (event: { sessionId: string; code: number | null; signal: number | null }) => {
      terminalExitHandler?.(event);
    },
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
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
    onTerminalExit: vi.fn(
      async (handler: (event: { sessionId: string; code: number | null; signal: number | null }) => void) => {
        terminalExitHandler = handler;
        return () => {
          if (terminalExitHandler === handler) {
            terminalExitHandler = null;
          }
        };
      }
    ),
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
  TerminalPanel: (props: { onData?: (data: string) => void }) => (
    <section className="terminal-panel" data-testid="terminal-panel-mock">
      <button type="button" onClick={() => props.onData?.('x')}>
        type-char
      </button>
      <button type="button" onClick={() => props.onData?.('Submitted prompt\r')}>
        submit-input
      </button>
    </section>
  )
}));

import App from '../../src/App';

function getThreadOrder(): string[] {
  return Array.from(document.querySelectorAll('.workspace-thread-list .thread-title'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
}

describe('Left rail recency and sorting semantics', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.reset();
  });

  it('keeps the header clear of timer badges even after terminal output events', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });

    expect(screen.queryByTestId('header-output-age')).not.toBeInTheDocument();
  });

  it('hides recency under one minute and shows minute-level values after one minute', async () => {
    const baseMs = Date.parse('2026-02-22T10:00:00.000Z');
    let nowMs = baseMs;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const user = userEvent.setup();
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });
      await user.click(screen.getByRole('button', { name: 'submit-input' }));

      expect(screen.queryByTestId('thread-recency-thread-newer')).not.toBeInTheDocument();
      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });
      nowMs = baseMs + 61_000;

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      act(() => {
        mocks.emitTerminalExit({ sessionId: 'session-thread-newer', code: 0, signal: null });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
      });
      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      expect(screen.getByTestId('thread-recency-thread-newer')).toHaveTextContent('1m');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not change thread order when only selecting threads', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);
  });

  it('re-sorts only after explicit submit events, not clicks, typing, or output', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-older', data: 'assistant reply\n' });
    });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(getThreadOrder()).toEqual(['Older thread', 'Newer thread']);
    });
  });

  it('puts a newly created thread at the top even when another thread has recent submitted input', async () => {
    const user = userEvent.setup();
    mocks.api.createThread.mockImplementationOnce(async () => {
      const next = {
        id: 'thread-new',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        title: 'Newest thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      mocks.prependThread(next);
      return next;
    });
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });
    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(getThreadOrder()).toEqual(['Older thread', 'Newer thread']);
    });

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(getThreadOrder()).toEqual(['Newest thread', 'Older thread', 'Newer thread']);
    });
  });

  it('shows working spinner while generating and blue unread marker after completion on non-selected threads', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });
    expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      },
      { timeout: 2500 }
    );

    await user.click(screen.getByRole('button', { name: /Newer thread/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    });
  });
});

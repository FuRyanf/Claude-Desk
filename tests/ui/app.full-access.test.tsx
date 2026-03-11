import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REMOTE_FULL_ACCESS_STARTUP_BLOCK_REASON =
  'Send a message first to establish the session, then toggle Full access. To start with Full access, use New thread options and choose Full access thread, or enable full access by default in Settings.';

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
  let workspace = { ...baseWorkspace };

  const baseThread = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    agentId: 'claude-code',
    fullAccess: true,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Full Access Thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: '123e4567-e89b-12d3-a456-426614174000'
  };

  let threadState = [{ ...baseThread }];
  let sessionCounter = 0;
  let terminalDataHandler: ((
    event: { sessionId: string; threadId?: string; data: string; sequence?: number }
  ) => void) | null = null;
  let threadUpdatedHandler: ((thread: typeof baseThread) => void) | null = null;

  const terminalStartSessionImpl = async (params: { threadId: string }) => {
    const thread = threadState.find((item) => item.id === params.threadId) ?? threadState[0];
    return {
      sessionId: `session-${++sessionCounter}`,
      sessionMode: thread?.claudeSessionId ? 'resumed' as const : 'new' as const,
      resumeSessionId: thread?.claudeSessionId ?? null,
      thread: {
        ...thread,
        claudeSessionId: thread?.claudeSessionId ?? null,
        lastResumeAt: thread?.claudeSessionId ? new Date().toISOString() : null,
        lastNewSessionAt: thread?.claudeSessionId ? null : new Date().toISOString()
      }
    };
  };
  const terminalReadOutputImpl = async () => '? for shortcuts';

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    addRdevWorkspace: vi.fn(async () => workspace),
    addSshWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => workspace),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: true,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [
      { name: 'main', isCurrent: true, lastCommitUnix: 1700000000 },
      { name: 'feature/test', isCurrent: false, lastCommitUnix: 1690000000 }
    ]),
    gitWorkspaceStatus: vi.fn(async () => ({
      isDirty: true,
      uncommittedFiles: 1,
      insertions: 2,
      deletions: 3
    })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async (_workspaceId: string, _agentId?: string, fullAccess?: boolean) => {
      const next = {
        ...baseThread,
        id: `thread-${threadState.length + 1}`,
        title: 'New thread',
        fullAccess: Boolean(fullAccess),
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null,
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
    archiveThread: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        isArchived: true,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    deleteThread: vi.fn(async (_workspaceId: string, threadId: string) => {
      threadState = threadState.filter((thread) => thread.id !== threadId);
      return true;
    }),
    setThreadFullAccess: vi.fn(async (_workspaceId: string, threadId: string, fullAccess: boolean) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        fullAccess,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
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
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(terminalStartSessionImpl),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ''),
    terminalReadOutput: vi.fn(terminalReadOutputImpl),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    validateImportableClaudeSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    workspace = { ...baseWorkspace };
    threadState = [{ ...baseThread }];
    sessionCounter = 0;
    terminalDataHandler = null;
    threadUpdatedHandler = null;
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
    api.terminalStartSession.mockReset();
    api.terminalStartSession.mockImplementation(terminalStartSessionImpl);
    api.terminalReadOutput.mockReset();
    api.terminalReadOutput.mockImplementation(terminalReadOutputImpl);
  };

  return {
    api,
    reset,
    setWorkspaceKind: (kind: 'local' | 'rdev' | 'ssh') => {
      workspace = { ...workspace, kind };
    },
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    emitTerminalData: (event: { sessionId: string; threadId?: string; data: string; sequence?: number }) => {
      terminalDataHandler?.(event);
    },
    onTerminalData: vi.fn(
      async (handler: (event: { sessionId: string; threadId?: string; data: string; sequence?: number }) => void) => {
        terminalDataHandler = handler;
        return () => {
          if (terminalDataHandler === handler) {
            terminalDataHandler = null;
          }
        };
      }
    ),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalExit: vi.fn(async () => () => undefined),
    emitThreadUpdated: (thread: typeof baseThread) => {
      threadState = threadState.map((item) => (item.id === thread.id ? { ...item, ...thread } : item));
      threadUpdatedHandler?.(thread);
    },
    onThreadUpdated: vi.fn(async (handler: (thread: typeof baseThread) => void) => {
      threadUpdatedHandler = handler;
      return () => {
        if (threadUpdatedHandler === handler) {
          threadUpdatedHandler = null;
        }
      };
    })
  };
});

vi.mock('../../src/lib/api', () => ({
  api: mocks.api,
  onRunStream: mocks.onRunStream,
  onRunExit: mocks.onRunExit,
  onTerminalData: mocks.onTerminalData,
  onTerminalReady: mocks.onTerminalReady,
  onTerminalExit: mocks.onTerminalExit,
  onThreadUpdated: mocks.onThreadUpdated
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDialog,
  confirm: mocks.confirmDialog
}));

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: ({ content, onData }: { content?: string; onData?: (data: string) => void }) => (
    <section data-testid="terminal-panel-mock">
      <pre data-testid="terminal-content-mock">{content ?? ''}</pre>
      <button type="button" onClick={() => onData?.('draft')}>
        Type draft
      </button>
      <button type="button" onClick={() => onData?.('ship it\r')}>
        Submit prompt
      </button>
    </section>
  )
}));

import App from '../../src/App';

describe('Terminal launch flags', () => {
  beforeEach(() => {
    mocks.reset();
    window.localStorage.clear();
  });

  it('starts terminal sessions with full access flag from thread metadata', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          fullAccessFlag: true,
          threadId: 'thread-1'
        })
      );
    });
  });

  it('renders a Full Access toggle in the bottom bar', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /Full Access Thread/i });
    expect(screen.getByTestId('full-access-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('full-access-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps ssh new threads blocked until the first submitted prompt', async () => {
    mocks.setWorkspaceKind('ssh');

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    await user.click(await screen.findByRole('button', { name: 'Normal thread' }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: false
        })
      );
    });

    const toggle = screen.getByTestId('full-access-toggle');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveAttribute('title', REMOTE_FULL_ACCESS_STARTUP_BLOCK_REASON);

    await user.click(toggle);
    expect(mocks.api.setThreadFullAccess).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(2);
    });

    await user.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-2', 'ship it\r');
    });
    await waitFor(() => {
      expect(toggle).not.toHaveAttribute('aria-disabled');
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(mocks.api.setThreadFullAccess).toHaveBeenCalledWith('ws-1', 'thread-2', true);
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: true
        })
      );
    });
  });

  it('creates a new full-access thread from the new thread options menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    await user.click(await screen.findByRole('button', { name: 'Full access thread' }));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code', true);
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: true
        })
      );
    });

    expect(screen.getByTestId('full-access-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  it('can default the main new-thread action to full access from settings', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });

    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const fullAccessDefaultSwitch = await screen.findByRole('switch', {
      name: /Start new threads with Full access/i
    });
    expect(fullAccessDefaultSwitch).toHaveAttribute('aria-checked', 'false');

    await user.click(fullAccessDefaultSwitch);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mocks.api.saveSettings).toHaveBeenCalledWith({
        claudeCliPath: '/usr/local/bin/claude',
        appearanceMode: 'system',
        defaultNewThreadFullAccess: true
      });
    });

    const newThreadButton = screen.getByTestId('workspace-new-thread-ws-1');
    expect(newThreadButton).toHaveTextContent('New full access thread');

    await user.click(newThreadButton);

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code', true);
    });
  });

  it('lets local new threads toggle full access immediately', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    await user.click(await screen.findByRole('button', { name: 'Normal thread' }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: false
        })
      );
    });

    const toggle = screen.getByTestId('full-access-toggle');
    expect(toggle).not.toHaveAttribute('aria-disabled');

    await user.click(toggle);

    await waitFor(() => {
      expect(mocks.api.setThreadFullAccess).toHaveBeenCalledWith('ws-1', 'thread-2', true);
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: true
        })
      );
    });

    expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-2');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears a fresh generated Claude session id before toggling full access on a new thread', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    await user.click(await screen.findByRole('button', { name: 'Normal thread' }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: false
        })
      );
    });

    act(() => {
      mocks.emitThreadUpdated({
        id: 'thread-2',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'New thread',
        isArchived: false,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: '3e3483b5-067e-4e5c-baa1-7b5da3555412',
        lastResumeAt: null,
        lastNewSessionAt: new Date().toISOString()
      });
    });

    await user.click(screen.getByTestId('full-access-toggle'));

    await waitFor(() => {
      expect(mocks.api.clearThreadClaudeSession).toHaveBeenCalledWith('ws-1', 'thread-2');
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: true
        })
      );
    });
  });

  it('restarts the active session after toggling full access', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          fullAccessFlag: true
        })
      );
    });

    await user.click(screen.getByTestId('full-access-toggle'));

    await waitFor(() => {
      expect(mocks.api.setThreadFullAccess).toHaveBeenCalledWith('ws-1', 'thread-1', false);
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          fullAccessFlag: false
        })
      );
    });
    expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-1');
    expect(screen.getByTestId('full-access-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps rdev new threads blocked until the first submitted prompt, then reconnects without in-place resume', async () => {
    mocks.setWorkspaceKind('rdev');

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await user.click(screen.getByTestId('workspace-new-thread-options-ws-1'));
    await user.click(await screen.findByRole('button', { name: 'Normal thread' }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: false
        })
      );
    });

    const toggle = screen.getByTestId('full-access-toggle');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveAttribute('title', REMOTE_FULL_ACCESS_STARTUP_BLOCK_REASON);

    await user.click(toggle);
    expect(mocks.api.setThreadFullAccess).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-2', 'ship it\r');
    });
    await waitFor(() => {
      expect(toggle).not.toHaveAttribute('aria-disabled');
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(mocks.api.setThreadFullAccess).toHaveBeenCalledWith('ws-1', 'thread-2', true);
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          fullAccessFlag: true
        })
      );
    });

    expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-2');
    expect(mocks.api.terminalWrite).not.toHaveBeenCalledWith(
      'session-2',
      expect.stringContaining("claude --resume '")
    );
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('drops stale terminal data after full-access restart replaces the session', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          fullAccessFlag: true
        })
      );
    });

    await user.click(screen.getByTestId('full-access-toggle'));

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-1');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          fullAccessFlag: false
        })
      );
    });
    await waitFor(() => {
      expect(mocks.api.terminalResize).toHaveBeenCalledWith('session-2', expect.any(Number), expect.any(Number));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-1', threadId: 'thread-1', data: 'STALE_OLD_SESSION\n' });
      mocks.emitTerminalData({ sessionId: 'session-2', threadId: 'thread-1', data: 'FRESH_ACTIVE_SESSION\n' });
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect(rendered).toContain('FRESH_ACTIVE_SESSION');
      expect(rendered).not.toContain('STALE_OLD_SESSION');
    });
  });

  it('preserves the current draft when full access is toggled', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          fullAccessFlag: true
        })
      );
    });

    await user.click(screen.getByRole('button', { name: /Type draft/i }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-1', 'draft');
    });

    await user.click(screen.getByTestId('full-access-toggle'));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          fullAccessFlag: false
        })
      );
    });

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-2', 'draft');
    });
  });

  it('waits for the replacement Claude session to hydrate before replaying the draft', async () => {
    let replacementSessionReads = 0;
    mocks.api.terminalReadOutput.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session-2') {
        replacementSessionReads += 1;
        return replacementSessionReads === 1 ? '' : '? for shortcuts';
      }
      return '? for shortcuts';
    });

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await user.click(screen.getByRole('button', { name: /Type draft/i }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-1', 'draft');
    });

    await user.click(screen.getByTestId('full-access-toggle'));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-2', 'draft');
    });

    const replacementReadIndex = mocks.api.terminalReadOutput.mock.calls.findIndex(
      ([sessionId]: [string]) => sessionId === 'session-2'
    );
    const replayIndex = mocks.api.terminalWrite.mock.calls.findIndex(
      ([sessionId, payload]: [string, string]) => sessionId === 'session-2' && payload === 'draft'
    );

    expect(replacementReadIndex).toBeGreaterThanOrEqual(0);
    expect(replayIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.api.terminalReadOutput.mock.invocationCallOrder[replacementReadIndex]).toBeLessThan(
      mocks.api.terminalWrite.mock.invocationCallOrder[replayIndex]
    );
  });

  it('toggles full access in-place for rdev without reconnecting', async () => {
    mocks.setWorkspaceKind('rdev');
    mocks.api.terminalReadOutput.mockResolvedValue('[rfu@bloody-faraday li-productivity-agents]$ ');

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: 'Submit prompt' }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-1', 'ship it\r');
    });

    await user.click(screen.getByTestId('full-access-toggle'));

    await waitFor(() => {
      expect(mocks.api.setThreadFullAccess).toHaveBeenCalledWith('ws-1', 'thread-1', false);
      expect(mocks.api.terminalSendSignal).toHaveBeenCalledWith('session-1', 'SIGINT');
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith(
        'session-1',
        "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 NO_COLOR= claude --resume '123e4567-e89b-12d3-a456-426614174000'\r"
      );
    });

    expect(mocks.api.terminalKill).not.toHaveBeenCalled();
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('full-access-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});

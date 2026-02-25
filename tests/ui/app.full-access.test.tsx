import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    createThread: vi.fn(async () => {
      const next = {
        ...baseThread,
        id: `thread-${threadState.length + 1}`,
        title: 'New thread',
        fullAccess: false,
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
    terminalStartSession: vi.fn(async (params: { threadId: string }) => {
      const thread = threadState.find((item) => item.id === params.threadId) ?? threadState[0];
      return {
        sessionId: 'session-1',
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
    terminalReadOutput: vi.fn(async () => ''),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics')
  };

  const reset = () => {
    workspace = { ...baseWorkspace };
    threadState = [{ ...baseThread }];
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
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

  it('toggles full access in-place for rdev without reconnecting', async () => {
    mocks.setWorkspaceKind('rdev');
    mocks.api.terminalReadOutput.mockResolvedValue('[rfu@bloody-faraday li-productivity-agents]$ ');

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Full Access Thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
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

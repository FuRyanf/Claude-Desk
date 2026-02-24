import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const now = Date.now();
  const baseThreads = [
    {
      id: 'thread-1',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(now - 2_000).toISOString(),
      updatedAt: new Date(now - 2_000).toISOString(),
      title: 'Thread one',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    },
    {
      id: 'thread-2',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(now - 4_000).toISOString(),
      updatedAt: new Date(now - 4_000).toISOString(),
      title: 'Thread two',
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
  let workspaceState = { ...workspace };

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => [workspaceState]),
    addWorkspace: vi.fn(async () => workspaceState),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async (_workspaceId: string, enabled: boolean) => {
      workspaceState = {
        ...workspaceState,
        gitPullOnMasterForNewThreads: enabled,
        updatedAt: new Date().toISOString()
      };
      return workspaceState;
    }),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [
      { name: 'main', isCurrent: true, lastCommitUnix: 1700000000 },
      { name: 'feature/test', isCurrent: false, lastCommitUnix: 1690000000 }
    ]),
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
      const next = {
        ...threadState[0],
        id: `thread-${threadState.length + 1}`,
        title: 'New thread',
        createdAt: new Date().toISOString(),
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
    workspaceState = { ...workspace };
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

describe('Thread lifecycle integration', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('auto-starts the selected thread session when opening an existing workspace', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /Thread one/i });
    expect(mocks.api.createThread).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
  });

  it('still auto-starts after delayed thread metadata hydration', async () => {
    const originalListThreads = mocks.api.listThreads.getMockImplementation();
    mocks.api.listThreads.mockImplementation(async (workspaceId: string) => {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 30);
      });
      if (originalListThreads) {
        return originalListThreads(workspaceId);
      }
      return [];
    });

    render(<App />);

    await screen.findByRole('button', { name: /Thread one/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
  });

  it('waits for terminal data subscription before starting a thread session', async () => {
    let releaseSubscription: (() => void) | null = null;
    mocks.onTerminalData.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseSubscription = resolve;
      });
      return () => undefined;
    });

    render(<App />);

    await screen.findByRole('button', { name: /Thread one/i });
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 120);
    });
    expect(mocks.api.terminalStartSession).not.toHaveBeenCalled();

    act(() => {
      releaseSubscription?.();
    });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
  });

  it('keeps the previous thread session running and starts the next one when switching threads', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /Thread two/i }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-2' })
      );
    });
    expect(mocks.api.terminalSendSignal).not.toHaveBeenCalledWith('session-thread-1', 'SIGINT');
    expect(mocks.api.terminalKill).not.toHaveBeenCalledWith('session-thread-1');
  });

  it('switches branches without showing a confirmation prompt', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /^main$/i }));
    await screen.findByRole('dialog', { name: 'Branch switcher' });
    await user.click(await screen.findByRole('button', { name: 'feature/test' }));

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-thread-1');
      expect(mocks.api.gitCheckoutBranch).toHaveBeenCalledWith('/tmp/workspace', 'feature/test');
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('shows exactly one thread creation entry point under expanded workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Workspace/i });
    expect(screen.getByTestId('workspace-new-thread-ws-1')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-compose-ws-1')).not.toBeInTheDocument();

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    const menu = (await screen.findByRole('button', { name: 'Open folder' })).closest('.thread-context-menu');
    expect(menu).not.toBeNull();
    expect(within(menu as HTMLElement).queryByRole('button', { name: /^New thread$/i })).not.toBeInTheDocument();
  });

  it('creates a new thread from the in-list new thread row and selects it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Workspace/i });
    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-3' })
      );
    });
  });

  it('runs git pull pre-step before creating a thread when project setting is enabled', async () => {
    const user = userEvent.setup();
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));

    await waitFor(() => {
      expect(mocks.api.setWorkspaceGitPullOnMasterForNewThreads).toHaveBeenCalledWith('ws-1', true);
    });

    const indicator = screen.getByText('master pull enabled');
    expect(indicator).toHaveAttribute(
      'title',
      'Upon new threads, master is checked out and pulled automatically.'
    );

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));
    await waitFor(() => {
      expect(mocks.api.gitPullMasterForNewThread).toHaveBeenCalledWith('/tmp/workspace');
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
    });

    const pullInvocation = (mocks.api.gitPullMasterForNewThread as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const createInvocation = (mocks.api.createThread as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(pullInvocation).toBeLessThan(createInvocation);
  });

  it('shows the pulled commit id in a popup toast after successful pre-step', async () => {
    const user = userEvent.setup();
    mocks.api.gitPullMasterForNewThread.mockResolvedValueOnce({
      outcome: 'pulled',
      message: 'Checked out master and pulled latest changes to commit 4befdb3.'
    });
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));
    await waitFor(() => {
      expect(mocks.api.setWorkspaceGitPullOnMasterForNewThreads).toHaveBeenCalledWith('ws-1', true);
    });

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));
    expect(await screen.findByText('Checked out master and pulled latest changes to commit 4befdb3.')).toBeInTheDocument();
  });

  it('uses the toggled pull setting immediately when creating a thread before setting persistence resolves', async () => {
    const user = userEvent.setup();

    let resolveSettingUpdate: (() => void) | null = null;
    mocks.api.setWorkspaceGitPullOnMasterForNewThreads.mockImplementationOnce(
      async (_workspaceId: string, enabled: boolean) =>
        await new Promise((resolve) => {
          resolveSettingUpdate = () =>
            resolve({
              id: 'ws-1',
              name: 'Workspace',
              path: '/tmp/workspace',
              gitPullOnMasterForNewThreads: enabled,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
        })
    );

    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));
    await waitFor(() => {
      expect(mocks.api.gitPullMasterForNewThread).toHaveBeenCalledWith('/tmp/workspace');
    });

    resolveSettingUpdate?.();

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
    });
  });

  it('skips git pull when dirty and still creates thread with non-blocking error toast', async () => {
    const user = userEvent.setup();
    mocks.api.gitPullMasterForNewThread.mockResolvedValueOnce({
      outcome: 'skipped',
      message: 'Skipped git pull: working tree is dirty. Commit or stash changes first.'
    });
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));
    await waitFor(() => {
      expect(mocks.api.setWorkspaceGitPullOnMasterForNewThreads).toHaveBeenCalledWith('ws-1', true);
    });

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.gitPullMasterForNewThread).toHaveBeenCalledWith('/tmp/workspace');
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
    });
    expect(await screen.findByText('Skipped git pull: working tree is dirty. Commit or stash changes first.')).toBeInTheDocument();
  });

  it('renames a thread through inline edit and persists the title', async () => {
    const user = userEvent.setup();
    render(<App />);

    const title = await screen.findByRole('button', { name: 'Thread one' });
    await user.dblClick(title);

    const input = await screen.findByDisplayValue('Thread one');
    await user.clear(input);
    await user.type(input, 'Renamed inline{enter}');

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-1', 'Renamed inline');
    });
    expect(await screen.findByText('Renamed inline')).toBeInTheDocument();
  });

  it('deletes a thread and keeps remaining threads interactive', async () => {
    const user = userEvent.setup();
    render(<App />);

    const firstRow = await screen.findByRole('button', { name: /Thread one/i });
    await user.pointer([{ target: firstRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mocks.api.deleteThread).toHaveBeenCalledWith('ws-1', 'thread-1');
      expect(screen.queryByRole('button', { name: /Thread one/i })).not.toBeInTheDocument();
    });

    await user.click(await screen.findByRole('button', { name: /Thread two/i }));
    expect(screen.getByRole('button', { name: /Thread two/i })).toBeInTheDocument();
  });
});

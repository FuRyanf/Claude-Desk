import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspaces = [
    {
      id: 'ws-1',
      name: 'Workspace One',
      path: '/tmp/workspace-one',
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: 'ws-2',
      name: 'Workspace Two',
      path: '/tmp/workspace-two',
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  const threadsByWorkspace = {
    'ws-1': [
      {
        id: 'thread-a',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        updatedAt: new Date(Date.now() - 10_000).toISOString(),
        title: 'Alpha thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ],
    'ws-2': [
      {
        id: 'thread-b',
        workspaceId: 'ws-2',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        updatedAt: new Date(Date.now() - 5_000).toISOString(),
        title: 'Beta thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ]
  };

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => workspaces),
    addWorkspace: vi.fn(async () => workspaces[0]),
    addRdevWorkspace: vi.fn(async () => workspaces[0]),
    addSshWorkspace: vi.fn(async () => workspaces[0]),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceOrder: vi.fn(async (workspaceIds: string[]) => {
      return workspaceIds
        .map((workspaceId) => workspaces.find((workspace) => workspace.id === workspaceId))
        .filter(Boolean);
    }),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async (workspaceId: string, enabled: boolean) => {
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0];
      return {
        ...workspace,
        gitPullOnMasterForNewThreads: enabled,
        updatedAt: new Date().toISOString()
      };
    }),
    getGitInfo: vi.fn(async (workspacePath: string) => ({
      branch: workspacePath.includes('two') ? 'feature/two' : 'main',
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
    listThreads: vi.fn(async (workspaceId: string) => threadsByWorkspace[workspaceId as 'ws-1' | 'ws-2'] ?? []),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    renameThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    archiveThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    deleteThread: vi.fn(async () => true),
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
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async (params: { threadId: string }) => ({
      sessionId: `session-${params.threadId}`,
      sessionMode: 'new' as const,
      resumeSessionId: null,
      thread: (threadsByWorkspace[params.threadId === 'thread-a' ? 'ws-1' : 'ws-2'] ?? [])[0]
    })),
    workspaceShellStartSession: vi.fn(async () => ({
      sessionId: 'shell-session-default'
    })),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async (_workspaceId: string, threadId: string) => `log-${threadId}`),
    terminalReadOutput: vi.fn(async () => ''),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    openTerminalCommand: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics')
  };

  const reset = () => {
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

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-panel-mock" />
}));

vi.mock('../../src/components/WorkspaceShellDrawer', () => ({
  WorkspaceShellDrawer: (props: {
    open: boolean;
    workspace?: { name?: string };
    sessionId?: string | null;
    starting?: boolean;
    onClose: () => void;
  }) =>
    props.open ? (
      <section data-testid="workspace-shell-drawer">
        <span>{props.workspace?.name ?? 'No workspace'}</span>
        <span>{props.sessionId ?? 'pending'}</span>
        <span>{String(Boolean(props.starting))}</span>
        <button type="button" onClick={props.onClose}>
          close-shell
        </button>
      </section>
    ) : null
}));

import App from '../../src/App';

describe('Workspace shell lifecycle', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('kills stale shell starts when the selected workspace changes mid-launch', async () => {
    const user = userEvent.setup();
    let resolveFirstShellStart: ((value: { sessionId: string }) => void) | null = null;

    let shellStartCount = 0;
    mocks.api.workspaceShellStartSession.mockImplementation(async () => {
      shellStartCount += 1;
      if (shellStartCount === 1) {
        return await new Promise((resolve) => {
          resolveFirstShellStart = resolve;
        });
      }
      return {
        sessionId: 'shell-session-ws2'
      };
    });

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.click(screen.getByRole('button', { name: /Beta thread/i }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-two' })
      );
    });

    resolveFirstShellStart?.({ sessionId: 'shell-session-ws1' });

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-ws1');
    });
    expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('Workspace Two');
    expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws2');
  });

  it('stops the active shell session before removing its workspace', async () => {
    const user = userEvent.setup();
    mocks.api.workspaceShellStartSession.mockResolvedValueOnce({
      sessionId: 'shell-session-ws1'
    });

    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace One/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-ws1');
      expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByTestId('workspace-shell-drawer')).not.toBeInTheDocument();
  });
});

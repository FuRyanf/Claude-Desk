import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspaceOne = {
    id: 'ws-added',
    name: 'workspace-added',
    path: '/tmp/workspace-added',
    kind: 'local' as const,
    rdevSshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceTwo = {
    id: 'ws-second',
    name: 'workspace-second',
    path: '/tmp/workspace-second',
    kind: 'local' as const,
    rdevSshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceRdev = {
    id: 'ws-rdev',
    name: 'offbeat-apple',
    path: 'rdev-workspace-1',
    kind: 'rdev' as const,
    rdevSshCommand: 'rdev ssh comms-ai-open-connect/offbeat-apple',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  let workspaceState = [] as Array<typeof workspaceOne>;

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => workspaceState),
    addWorkspace: vi.fn(async () => {
      workspaceState = [workspaceOne];
      return workspaceOne;
    }),
    addRdevWorkspace: vi.fn(async () => {
      workspaceState = [workspaceRdev];
      return workspaceRdev;
    }),
    removeWorkspace: vi.fn(async (workspaceId: string) => {
      const before = workspaceState.length;
      workspaceState = workspaceState.filter((workspace) => workspace.id !== workspaceId);
      return workspaceState.length !== before;
    }),
    setWorkspaceOrder: vi.fn(async (workspaceIds: string[]) => {
      const byId = new Map(workspaceState.map((workspace) => [workspace.id, workspace]));
      const reordered = workspaceIds
        .map((workspaceId) => byId.get(workspaceId))
        .filter((workspace): workspace is typeof workspaceOne => Boolean(workspace));
      workspaceState = [...reordered, ...workspaceState.filter((workspace) => !workspaceIds.includes(workspace.id))];
      return workspaceState;
    }),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async (workspaceId: string, enabled: boolean) => {
      workspaceState = workspaceState.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, gitPullOnMasterForNewThreads: enabled, updatedAt: new Date().toISOString() }
          : workspace
      );
      return workspaceState.find((workspace) => workspace.id === workspaceId) ?? workspaceOne;
    }),
    getGitInfo: vi.fn(async () => null),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => []),
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
    terminalStartSession: vi.fn(async () => ({
      sessionId: 'session-1',
      sessionMode: 'new',
      resumeSessionId: null,
      thread: {
        id: 'thread-1',
        workspaceId: 'ws-added',
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
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
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
    openTerminalCommand: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics')
  };
  const openDialog = vi.fn(async () => null);
  const confirmDialog = vi.fn(async () => true);

  const reset = () => {
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
    openDialog.mockClear();
    confirmDialog.mockClear();
    workspaceState = [];
  };

  return {
    api,
    reset,
    seedWorkspaces: (next: Array<typeof workspaceOne>) => {
      workspaceState = next.map((workspace) => ({ ...workspace }));
    },
    sampleWorkspaces: {
      workspaceOne,
      workspaceTwo,
      workspaceRdev
    },
    openDialog,
    confirmDialog,
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

function createDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? ''
  } as unknown as DataTransfer;
}

function getWorkspaceOrder(): string[] {
  return Array.from(document.querySelectorAll('.workspace-group .workspace-group-name'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
}

describe('Workspace add flow', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('does nothing when native directory selection is canceled', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));

    expect(mocks.api.addWorkspace).not.toHaveBeenCalled();
  });

  it('adds workspace from manual fallback modal and updates UI immediately', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));

    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    expect(mocks.api.addWorkspace).toHaveBeenCalledWith('/tmp/workspace-added');
    expect(await screen.findByRole('button', { name: /workspace-added/i })).toBeInTheDocument();
  });

  it('removes workspace from the workspace context menu', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(true);
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('button', { name: /workspace-added/i });

    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-added');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /workspace-added/i })).not.toBeInTheDocument();
    });
  });

  it('does not remove workspace when remove confirmation is canceled', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(false);
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('button', { name: /workspace-added/i });

    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.api.removeWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /workspace-added/i })).toBeInTheDocument();
  });

  it('does not reorder workspaces by drag-and-drop when drag is disabled', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const sourceRow = screen.getByRole('button', { name: /workspace-added/i }).closest('.workspace-group-row');
    const targetGroup = screen.getByRole('button', { name: /workspace-second/i }).closest('.workspace-group');
    expect(sourceRow).not.toBeNull();
    expect(targetGroup).not.toBeNull();

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(sourceRow as HTMLElement, { dataTransfer });
    fireEvent.dragOver(targetGroup as HTMLElement, { dataTransfer });
    fireEvent.drop(targetGroup as HTMLElement, { dataTransfer });
    fireEvent.dragEnd(sourceRow as HTMLElement, { dataTransfer });

    expect(mocks.api.setWorkspaceOrder).not.toHaveBeenCalled();
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);
  });

  it('reorders workspaces with move arrows when drag events are unavailable', async () => {
    const user = userEvent.setup();
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const moveUpFirst = screen.queryByTestId('workspace-move-up-ws-added');
    const moveDownFirst = screen.getByTestId('workspace-move-down-ws-added');
    const moveDownLast = screen.queryByTestId('workspace-move-down-ws-second');
    expect(moveUpFirst).toBeNull();
    expect(moveDownLast).toBeNull();

    fireEvent.click(moveDownFirst);

    await waitFor(() => {
      expect(mocks.api.setWorkspaceOrder).toHaveBeenCalledWith(['ws-second', 'ws-added']);
    });
    await waitFor(() => {
      expect(getWorkspaceOrder()).toEqual(['workspace-second', 'workspace-added']);
    });
    expect(screen.queryByTestId('workspace-move-down-ws-added')).toBeNull();
    expect(screen.getByTestId('workspace-move-up-ws-added')).toBeInTheDocument();
  });

  it('adds an rdev workspace from the add-project modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(screen.getByRole('tab', { name: 'rdev' }));
    await user.type(
      screen.getByLabelText('rdev ssh command'),
      'rdev ssh comms-ai-open-connect/offbeat-apple'
    );
    await user.type(screen.getByLabelText('Display name (optional)'), 'offbeat-apple');
    await user.click(screen.getByRole('button', { name: 'Add rdev project' }));

    expect(mocks.api.addRdevWorkspace).toHaveBeenCalledWith(
      'rdev ssh comms-ai-open-connect/offbeat-apple',
      'offbeat-apple'
    );
    expect(await screen.findByRole('button', { name: /offbeat-apple/i })).toBeInTheDocument();
  });
});

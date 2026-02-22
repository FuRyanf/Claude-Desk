import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  const skill = {
    id: 'refactor-skill',
    name: 'Refactor Skill',
    description: 'Helps refactor code',
    entryPoints: ['/skill refactor'],
    path: '/tmp/workspace/skills/refactor-skill'
  };

  let threadState = [{ ...baseThread }];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ClaudeDesk'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
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
    setThreadSkills: vi.fn(async (_workspaceId: string, threadId: string, enabledSkills: string[]) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        enabledSkills,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    setThreadAgent: vi.fn(async (_workspaceId: string, threadId: string, agentId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        agentId,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    appendUserMessage: vi.fn(async (_workspaceId: string, _threadId: string, content: string) => ({
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      runId: null
    })),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => [skill]),
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
  open: mocks.openDialog
}));

import App from '../../src/App';

describe('App terminal-first layout', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('starts an interactive terminal automatically for the selected thread', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(screen.getByRole('button', { name: 'New thread' }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-2' })
      );
    });
  });

  it('keeps Codex-like core layout constraints', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    const header = await screen.findByTestId('header');
    const sidebar = screen.getByTestId('sidebar');
    const mainPanel = screen.getByTestId('main-panel');
    const composer = screen.queryByTestId('composer');

    expect(getComputedStyle(header).height).toBe('44px');
    expect(getComputedStyle(sidebar).width).toBe('320px');

    expect(getComputedStyle(mainPanel).display).toBe('grid');
    expect(getComputedStyle(mainPanel).gridTemplateRows).toContain('44px');
    expect(composer).toBeNull();

    await waitFor(() => {
      expect(document.querySelector('.terminal-panel')).toBeTruthy();
    });
  });

  it('supports dragging the sidebar resizer and persists width', async () => {
    render(<App />);

    const sidebar = await screen.findByTestId('sidebar');
    const resizer = await screen.findByTestId('sidebar-resizer');

    expect(getComputedStyle(sidebar).width).toBe('320px');

    fireEvent.mouseDown(resizer, { button: 0, clientX: 320 });
    fireEvent.mouseMove(window, { clientX: 392 });
    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(getComputedStyle(sidebar).width).toBe('392px');
      expect(window.localStorage.getItem('claude-desk:sidebar-width')).toBe('392');
    });
  });

  it('keeps terminal visible across repeated sidebar resize cycles', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    const sidebar = await screen.findByTestId('sidebar');
    const resizer = await screen.findByTestId('sidebar-resizer');

    const widths = [280, 430, 300, 450, 320];
    for (const width of widths) {
      fireEvent.mouseDown(resizer, { button: 0, clientX: Number.parseInt(getComputedStyle(sidebar).width, 10) });
      fireEvent.mouseMove(window, { clientX: width });
      fireEvent.mouseUp(window);
      await waitFor(() => {
        expect(getComputedStyle(sidebar).width).toBe(`${width}px`);
      });
    }

    await waitFor(() => {
      expect(document.querySelector('.terminal-panel')).toBeTruthy();
    });
  });
});

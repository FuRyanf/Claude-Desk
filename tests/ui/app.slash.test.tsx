import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  let terminalDataHandler: ((event: { sessionId: string; data: string; sequence?: number }) => void) | null = null;

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
    emitTerminalData: (event: { sessionId: string; data: string; sequence?: number }) => {
      terminalDataHandler?.(event);
    },
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async (handler: (event: { sessionId: string; data: string; sequence?: number }) => void) => {
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
  open: mocks.openDialog,
  confirm: mocks.confirmDialog
}));

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: (props: {
    content?: string;
    onData?: (data: string) => void;
    inputEnabled?: boolean;
    overlayMessage?: string;
  }) => (
    <section className="terminal-panel" data-testid="terminal-panel-mock">
      <pre data-testid="terminal-content-mock">{props.content ?? ''}</pre>
      <output data-testid="terminal-input-enabled">{String(Boolean(props.inputEnabled))}</output>
      <output data-testid="terminal-overlay">{props.overlayMessage ?? ''}</output>
      <button type="button" onClick={() => props.onData?.('   First prompt title line\r')}>
        send-first-prompt
      </button>
      <button
        type="button"
        onClick={() => {
          props.onData?.('\u001b[');
          props.onData?.('31m   Escaped title line\r');
        }}
      >
        send-split-escape-prompt
      </button>
      <button
        type="button"
        onClick={() =>
          props.onData?.(
            '   This title is intentionally very long and should be trimmed to fifty characters max\r'
          )
        }
      >
        send-long-first-prompt
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

  it('keeps snapshot backlog and buffered prompt output during pending hydration without typing', async () => {
    let releaseSnapshotReads: (() => void) | null = null;
    const snapshotReady = new Promise<void>((resolve) => {
      releaseSnapshotReads = resolve;
    });
    mocks.api.terminalReadOutput.mockImplementation(async () => {
      await snapshotReady;
      return 'Claude Code banner\n';
    });

    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: '\n> Try "create a test"\n' });
    });
    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect(rendered).toContain('Try "create a test"');
      expect(screen.getByTestId('terminal-overlay').textContent).toBe('');
    });

    act(() => {
      releaseSnapshotReads?.();
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect(rendered).toContain('Claude Code banner');
      expect(rendered).toContain('Try "create a test"');
    });
  });

  it('keeps input enabled when switching back to an existing session while hydration is pending', async () => {
    const user = userEvent.setup();
    let releaseSnapshotReads: (() => void) | null = null;
    const snapshotReady = new Promise<void>((resolve) => {
      releaseSnapshotReads = resolve;
    });
    mocks.api.terminalReadOutput.mockImplementation(async () => {
      await snapshotReady;
      return '';
    });

    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    fireEvent.click(screen.getByTestId('workspace-new-thread-ws-1'));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: /First thread/i }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled').textContent).toBe('true');
    });

    act(() => {
      releaseSnapshotReads?.();
    });
  });

  it('does not overwrite live terminal output with stale snapshot content', async () => {
    let resolveSnapshot: ((value: string) => void) | null = null;
    mocks.api.terminalReadOutput.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSnapshot = resolve;
        })
    );

    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'LIVE_OUTPUT\n' });
    });

    act(() => {
      resolveSnapshot?.('STALE_SNAPSHOT\n');
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect(rendered).toContain('LIVE_OUTPUT');
      expect(rendered).not.toContain('STALE_SNAPSHOT');
    });
  });

  it('ignores duplicate terminal data events when sequence ids repeat', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'DUPLICATE_LINE\n', sequence: 7 });
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'DUPLICATE_LINE\n', sequence: 7 });
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect((rendered.match(/DUPLICATE_LINE/g) ?? []).length).toBe(1);
    });
  });

  it('queues attachments and sends them with the next Enter submit', async () => {
    const user = userEvent.setup();
    mocks.openDialog.mockResolvedValueOnce(['/tmp/screenshot.png', '/tmp/spec.md']);
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    await user.click(screen.getByRole('button', { name: 'Add attachments' }));

    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalled();
    });

    const matchingCall = (mocks.api.terminalWrite as { mock: { calls: Array<[string, string]> } }).mock.calls.find(
      ([, payload]) => payload.includes('/tmp/screenshot.png') && payload.includes('/tmp/spec.md')
    );
    expect(matchingCall).toBeDefined();
    expect(matchingCall?.[0]).toBe('session-thread-1');
    expect(matchingCall?.[1]).toContain('Inspect image and screenshot files visually.');
    expect(matchingCall?.[1]).toContain('First prompt title line');
    expect(matchingCall?.[1].endsWith('\r')).toBe(true);
  });

  it('sets title once from first prompt and does not change while typing or later submits', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    fireEvent.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-long-first-prompt' }));
    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith(
        'ws-1',
        'thread-2',
        'This title is intentionally very long and should b'
      );
    });

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    await user.click(screen.getByRole('button', { name: 'send-second-prompt' }));

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledTimes(1);
    });
  });

  it('handles split terminal control sequences when deriving the first thread title', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    fireEvent.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-split-escape-prompt' }));

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-2', 'Escaped title line');
    });
  });

  it('does not rerender the sidebar on terminal keystrokes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'ready\n' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-content-mock').textContent ?? '').toContain('ready');
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

  it('clears stuck working state when only control chunks keep arriving', async () => {
    const user = userEvent.setup();
    const nowSpy = vi.spyOn(Date, 'now');
    let nowMs = Date.now();
    nowSpy.mockImplementation(() => nowMs);

    try {
      render(<App />);

      await screen.findByRole('button', { name: /First thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
      });

      await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));
      act(() => {
        nowMs += 10;
        mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'working...\n' });
      });
      await waitFor(() => {
        expect(screen.getByTestId('thread-running-thread-1')).toBeInTheDocument();
      });

      for (let index = 0; index < 40; index += 1) {
        act(() => {
          nowMs += 500;
          mocks.emitTerminalData({ sessionId: 'session-thread-1', data: '\u001b[2K\r' });
        });
      }

      await waitFor(() => {
        expect(screen.queryByTestId('thread-running-thread-1')).not.toBeInTheDocument();
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

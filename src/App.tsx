import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AddWorkspaceModal } from './components/AddWorkspaceModal';
import { HeaderBar } from './components/HeaderBar';
import { LeftRail } from './components/LeftRail';
import { SettingsModal } from './components/SettingsModal';
import { SimpleComposer } from './components/SimpleComposer';
import { TerminalPanel } from './components/TerminalPanel';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { api, onTerminalExit } from './lib/api';
import { useRunStore } from './stores/runStore';
import { useThreadStore } from './stores/threadStore';
import type { GitInfo, RunStatus, Settings, TerminalExitEvent, ThreadMetadata, Workspace } from './types';

const SELECTED_WORKSPACE_KEY = 'claude-desk:selected-workspace';

function threadSelectionKey(workspaceId: string) {
  return `claude-desk:selected-thread:${workspaceId}`;
}

function todayId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeComposerInput(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

function formatDurationShort(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function statusFromExit(event: TerminalExitEvent): RunStatus {
  if (event.signal || event.code === 130) {
    return 'Canceled';
  }
  if (event.code === 0) {
    return 'Succeeded';
  }
  if (typeof event.code === 'number') {
    return 'Failed';
  }
  return 'Idle';
}

export default function App() {
  const threadStore = useThreadStore();
  const runStore = useRunStore();

  const {
    threadsByWorkspace,
    selectedWorkspaceId,
    selectedThreadId,
    listThreads,
    createThread,
    renameThread,
    setSelectedWorkspace,
    setSelectedThread,
    setThreadRunState
  } = threadStore;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threadSearch, setThreadSearch] = useState('');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [terminalFocused, setTerminalFocused] = useState(false);
  const [terminalSize, setTerminalSize] = useState({ cols: 120, rows: 32 });
  const [lastTerminalLogByThread, setLastTerminalLogByThread] = useState<Record<string, string>>({});
  const [composerText, setComposerText] = useState('');
  const [sendingComposer, setSendingComposer] = useState(false);

  const [settings, setSettings] = useState<Settings>({ claudeCliPath: null });
  const [detectedCliPath, setDetectedCliPath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blockingError, setBlockingError] = useState<string | null>(null);

  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspacePath, setAddWorkspacePath] = useState('');
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [nowMs, setNowMs] = useState(Date.now());

  const selectedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const startingSessionByThreadRef = useRef<Record<string, Promise<string>>>({});
  const pendingInputByThreadRef = useRef<Record<string, string>>({});
  const escapeSignalRef = useRef<{ sessionId: string; at: number } | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces]
  );

  const selectedThreads = useMemo(() => {
    if (!selectedWorkspaceId) {
      return [];
    }
    return threadsByWorkspace[selectedWorkspaceId] ?? [];
  }, [selectedWorkspaceId, threadsByWorkspace]);

  const selectedThread = useMemo(() => {
    if (!selectedThreadId) {
      return undefined;
    }
    return selectedThreads.find((thread) => thread.id === selectedThreadId);
  }, [selectedThreadId, selectedThreads]);

  const selectedSessionId = runStore.sessionForThread(selectedThreadId);

  const selectedTerminalContent = useMemo(() => {
    if (!selectedThreadId) {
      return '';
    }
    return lastTerminalLogByThread[selectedThreadId] ?? '';
  }, [lastTerminalLogByThread, selectedThreadId]);

  const activeRunCount = Object.keys(runStore.activeRunsByThread).length;

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const pushToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    const id = todayId();
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    const all = await api.listWorkspaces();
    setWorkspaces(all);
    if (all.length === 0) {
      setSelectedWorkspace(undefined);
      setSelectedThread(undefined);
      return;
    }

    const persisted = window.localStorage.getItem(SELECTED_WORKSPACE_KEY) ?? '';
    const current = selectedWorkspaceIdRef.current;

    const nextWorkspaceId =
      (current && all.some((workspace) => workspace.id === current) && current) ||
      (persisted && all.some((workspace) => workspace.id === persisted) && persisted) ||
      all[0].id;

    setSelectedWorkspace(nextWorkspaceId);
  }, [setSelectedThread, setSelectedWorkspace]);

  const refreshThreadsForWorkspace = useCallback(
    async (workspaceId: string) => {
      const threads = await listThreads(workspaceId);

      if (selectedWorkspaceIdRef.current !== workspaceId) {
        return threads;
      }

      const persistedThreadId = window.localStorage.getItem(threadSelectionKey(workspaceId)) ?? '';
      const currentThreadId = selectedThreadIdRef.current;

      const nextThreadId =
        (currentThreadId && threads.some((thread) => thread.id === currentThreadId) && currentThreadId) ||
        (persistedThreadId && threads.some((thread) => thread.id === persistedThreadId) && persistedThreadId) ||
        threads[0]?.id;

      setSelectedThread(nextThreadId);
      return threads;
    },
    [listThreads, setSelectedThread]
  );

  const refreshGitInfo = useCallback(async () => {
    if (!selectedWorkspace) {
      setGitInfo(null);
      return;
    }
    const info = await api.getGitInfo(selectedWorkspace.path);
    setGitInfo(info);
  }, [selectedWorkspace]);

  const flushPendingThreadInput = useCallback(async (threadId: string, sessionId: string) => {
    const pending = pendingInputByThreadRef.current[threadId];
    if (!pending) {
      return;
    }
    delete pendingInputByThreadRef.current[threadId];
    await api.terminalWrite(sessionId, pending);
  }, []);

  const ensureSessionForThread = useCallback(
    async (thread: ThreadMetadata): Promise<string> => {
      const existing = runStore.sessionForThread(thread.id);
      if (existing) {
        await flushPendingThreadInput(thread.id, existing);
        return existing;
      }

      const inFlight = startingSessionByThreadRef.current[thread.id];
      if (inFlight) {
        return inFlight;
      }

      const workspace = workspaces.find((item) => item.id === thread.workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found for thread.');
      }

      const startPromise = (async () => {
        const response = await api.terminalStartSession({
          workspacePath: workspace.path,
          initialCwd: workspace.path,
          envVars: null,
          fullAccessFlag: thread.fullAccess,
          threadId: thread.id
        });

        const sessionId = response.sessionId;
        const startedAt = new Date().toISOString();
        runStore.bindSession(thread.id, sessionId, startedAt);
        setThreadRunState(thread.id, 'Running', startedAt, null);

        void api.terminalResize(sessionId, terminalSize.cols, terminalSize.rows);
        await flushPendingThreadInput(thread.id, sessionId);
        window.setTimeout(() => {
          void api
            .terminalReadOutput(sessionId)
            .then((snapshot) => {
              if (!snapshot) {
                return;
              }
              setLastTerminalLogByThread((current) => ({
                ...current,
                [thread.id]: snapshot
              }));
            })
            .catch(() => undefined);
        }, 350);
        return sessionId;
      })()
        .finally(() => {
          delete startingSessionByThreadRef.current[thread.id];
        });

      startingSessionByThreadRef.current[thread.id] = startPromise;
      return startPromise;
    },
    [flushPendingThreadInput, runStore, setThreadRunState, terminalSize.cols, terminalSize.rows, workspaces]
  );

  const addWorkspaceByPath = useCallback(
    async (path: string) => {
      const normalized = path.trim();
      if (!normalized) {
        throw new Error('Please enter a workspace path.');
      }

      const workspace = await api.addWorkspace(normalized);
      setWorkspaces((current) => {
        if (current.some((item) => item.id === workspace.id)) {
          return current;
        }
        return [...current, workspace];
      });
      setSelectedWorkspace(workspace.id);
      setSelectedThread(undefined);
      await refreshThreadsForWorkspace(workspace.id);
      return workspace;
    },
    [refreshThreadsForWorkspace, setSelectedThread, setSelectedWorkspace]
  );

  const openWorkspacePicker = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select workspace folder'
      });

      if (!selected) {
        return;
      }

      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) {
        return;
      }

      await addWorkspaceByPath(path);
    } catch (error) {
      const message = `Add workspace failed: ${String(error)}`;
      pushToast(message, 'error');
      setAddWorkspaceError(message);
      setAddWorkspaceOpen(true);
    }
  }, [addWorkspaceByPath, pushToast]);

  const confirmManualWorkspace = useCallback(
    async (path: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspacePath(path);
      try {
        await addWorkspaceByPath(path);
        setAddWorkspaceOpen(false);
        setAddWorkspacePath('');
      } catch (error) {
        const message = String(error);
        setAddWorkspaceError(message);
        pushToast(message, 'error');
      } finally {
        setAddingWorkspace(false);
      }
    },
    [addWorkspaceByPath, pushToast]
  );

  const onNewThread = useCallback(async () => {
    if (!selectedWorkspaceId) {
      pushToast('Select a workspace first.', 'error');
      return;
    }

    const thread = await createThread(selectedWorkspaceId);
    setSelectedThread(thread.id);
    await refreshThreadsForWorkspace(selectedWorkspaceId);
  }, [createThread, pushToast, refreshThreadsForWorkspace, selectedWorkspaceId, setSelectedThread]);

  const onRenameThread = useCallback(
    async (workspaceId: string, threadId: string, title: string) => {
      await renameThread(workspaceId, threadId, title);
      await refreshThreadsForWorkspace(workspaceId);
    },
    [refreshThreadsForWorkspace, renameThread]
  );

  const sendComposerMessage = useCallback(async () => {
    const text = normalizeComposerInput(composerText).trim();
    if (!text) {
      return;
    }

    if (!selectedWorkspaceId) {
      pushToast('Select a workspace first.', 'error');
      return;
    }

    setSendingComposer(true);
    try {
      let thread = selectedThread;
      if (!thread) {
        thread = await createThread(selectedWorkspaceId);
        setSelectedThread(thread.id);
      }

      const sessionId = await ensureSessionForThread(thread);
      await api.terminalWrite(sessionId, text.replace(/\n/g, '\r'));
      await api.terminalWrite(sessionId, '\r');

      await api.appendUserMessage(thread.workspaceId, thread.id, text);
      await refreshThreadsForWorkspace(thread.workspaceId);
      setComposerText('');
    } catch (error) {
      const errorText = String(error);
      if (errorText.includes('Claude CLI not found')) {
        setBlockingError('Claude CLI not found. Configure the path in Settings.');
        setSettingsOpen(true);
      } else {
        pushToast(errorText, 'error');
      }
    } finally {
      setSendingComposer(false);
    }
  }, [composerText, createThread, ensureSessionForThread, pushToast, refreshThreadsForWorkspace, selectedThread, selectedWorkspaceId, setSelectedThread]);

  useEffect(() => {
    const init = async () => {
      try {
        await api.getAppStorageRoot();
        await refreshWorkspaces();
        const savedSettings = await api.getSettings();
        setSettings(savedSettings);
        const detected = await api.detectClaudeCliPath();
        setDetectedCliPath(detected);
        if (!detected && !savedSettings.claudeCliPath) {
          setBlockingError('Claude CLI is missing. Open Settings to configure the CLI path.');
        }
      } catch (error) {
        setBlockingError(String(error));
      }
    };

    void init();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setSelectedThread(undefined);
      return;
    }

    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, selectedWorkspaceId);
    void refreshThreadsForWorkspace(selectedWorkspaceId);
  }, [refreshThreadsForWorkspace, selectedWorkspaceId, setSelectedThread]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setGitInfo(null);
      return;
    }

    void refreshGitInfo();
    const id = window.setInterval(() => {
      void refreshGitInfo();
    }, 4000);

    return () => window.clearInterval(id);
  }, [refreshGitInfo, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId) {
      return;
    }
    window.localStorage.setItem(threadSelectionKey(selectedWorkspaceId), selectedThreadId);
  }, [selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId) {
      return;
    }
    if (lastTerminalLogByThread[selectedThreadId] !== undefined) {
      return;
    }

    void api
      .terminalGetLastLog(selectedWorkspaceId, selectedThreadId)
      .then((log) => {
        setLastTerminalLogByThread((current) => ({
          ...current,
          [selectedThreadId]: log
        }));
      })
      .catch(() => {
        setLastTerminalLogByThread((current) => ({
          ...current,
          [selectedThreadId]: ''
        }));
      });
  }, [lastTerminalLogByThread, selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedThread) {
      return;
    }

    void ensureSessionForThread(selectedThread).catch((error) => {
      pushToast(String(error), 'error');
    });
  }, [ensureSessionForThread, pushToast, selectedThread]);

  useEffect(() => {
    let unlistenExit: (() => void) | null = null;

    const setup = async () => {
      unlistenExit = await onTerminalExit((event: TerminalExitEvent) => {
        const endedThreadId = runStore.finishSession(event.sessionId);
        if (!endedThreadId) {
          return;
        }

        const endedAt = new Date().toISOString();
        setThreadRunState(endedThreadId, statusFromExit(event), null, endedAt);

        const workspaceId = Object.values(threadsByWorkspace)
          .flat()
          .find((thread) => thread.id === endedThreadId)?.workspaceId;
        if (workspaceId) {
          void refreshThreadsForWorkspace(workspaceId);
        }

        void api
          .terminalReadOutput(event.sessionId)
          .then((snapshot) => {
            setLastTerminalLogByThread((current) => ({
              ...current,
              [endedThreadId]: snapshot
            }));
          })
          .catch(() => undefined);
      });
    };

    void setup();
    return () => {
      unlistenExit?.();
    };
  }, [refreshThreadsForWorkspace, runStore, setThreadRunState, threadsByWorkspace]);

  useEffect(() => {
    if (activeRunCount === 0) {
      return;
    }
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeRunCount]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (terminalFocused && event.metaKey && key === 'c' && selectedSessionId) {
        event.preventDefault();
        void api.terminalSendSignal(selectedSessionId, 'SIGINT');
        return;
      }

      if (event.metaKey && key === 'n') {
        event.preventDefault();
        void onNewThread();
        return;
      }

      if (event.key === 'Escape' && selectedSessionId) {
        event.preventDefault();
        const now = Date.now();
        if (
          escapeSignalRef.current &&
          escapeSignalRef.current.sessionId === selectedSessionId &&
          now - escapeSignalRef.current.at < 1500
        ) {
          void api.terminalKill(selectedSessionId);
          escapeSignalRef.current = null;
        } else {
          void api.terminalSendSignal(selectedSessionId, 'SIGINT');
          escapeSignalRef.current = { sessionId: selectedSessionId, at: now };
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onNewThread, selectedSessionId, terminalFocused]);

  const saveSettings = useCallback(async (cliPath: string) => {
    const saved = await api.saveSettings({ claudeCliPath: cliPath || null });
    setSettings(saved);
    const detected = await api.detectClaudeCliPath();
    setDetectedCliPath(detected);
    setSettingsOpen(false);
    if (detected || cliPath) {
      setBlockingError(null);
    }
  }, []);

  const selectedThreadStartedAt = runStore.startedAtForThread(selectedThreadId);
  const runningForLabel = selectedThreadStartedAt
    ? formatDurationShort((nowMs - Date.parse(selectedThreadStartedAt)) / 1000)
    : undefined;
  const statusLabel = selectedThread?.lastRunStatus ?? 'Idle';

  return (
    <div className="app-shell">
      <LeftRail
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedThreadId={selectedThreadId}
        threadSearch={threadSearch}
        nowMs={nowMs}
        activeRunsByThread={Object.fromEntries(
          Object.entries(runStore.activeRunsByThread).map(([threadId, run]) => [threadId, { startedAt: run.startedAt }])
        )}
        onSelectWorkspace={(workspaceId) => {
          setSelectedWorkspace(workspaceId);
          setSelectedThread(undefined);
          setThreadSearch('');
        }}
        onOpenWorkspacePicker={() => void openWorkspacePicker()}
        onOpenManualWorkspaceModal={() => {
          setAddWorkspaceError(null);
          setAddWorkspaceOpen(true);
        }}
        onNewThread={() => void onNewThread()}
        onThreadSearchChange={setThreadSearch}
        onSelectThread={setSelectedThread}
        onRenameThread={onRenameThread}
        getSearchTextForThread={(threadId) => lastTerminalLogByThread[threadId] ?? ''}
      />

      <main className={blockingError ? 'main-panel has-blocking-error' : 'main-panel'} data-testid="main-panel">
        <HeaderBar
          workspace={selectedWorkspace}
          gitInfo={gitInfo}
          statusLabel={statusLabel}
          runningForLabel={runningForLabel}
          onOpenWorkspace={() => {
            if (selectedWorkspace) {
              void api.openInFinder(selectedWorkspace.path);
            }
          }}
          onOpenTerminal={() => {
            if (selectedWorkspace) {
              void api.openInTerminal(selectedWorkspace.path);
            }
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {blockingError ? (
          <div className="blocking-error">
            <span>{blockingError}</span>
            <button type="button" className="ghost-button" onClick={() => setSettingsOpen(true)}>
              Open Settings
            </button>
          </div>
        ) : null}

        <section className="terminal-region">
          {selectedThread ? (
            <TerminalPanel
              sessionId={selectedSessionId}
              content={selectedTerminalContent}
              readOnly={false}
              onData={(data) => {
                if (!selectedThread) {
                  return;
                }

                const sessionId = runStore.sessionForThread(selectedThread.id);
                if (sessionId) {
                  void api.terminalWrite(sessionId, data);
                  return;
                }

                pendingInputByThreadRef.current[selectedThread.id] = `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${data}`;
                void ensureSessionForThread(selectedThread);
              }}
              onResize={(cols, rows) => {
                setTerminalSize({ cols, rows });
                if (!selectedSessionId) {
                  return;
                }
                void api.terminalResize(selectedSessionId, cols, rows);
              }}
              onFocusChange={setTerminalFocused}
            />
          ) : (
            <div className="terminal-empty">Create a thread to start typing.</div>
          )}
        </section>

        <SimpleComposer
          value={composerText}
          disabled={!selectedWorkspace || Boolean(blockingError)}
          sending={sendingComposer}
          onChange={setComposerText}
          onSend={sendComposerMessage}
        />
      </main>

      <SettingsModal
        open={settingsOpen}
        initialCliPath={settings.claudeCliPath ?? ''}
        detectedCliPath={detectedCliPath}
        onClose={() => setSettingsOpen(false)}
        onSave={(path) => void saveSettings(path)}
      />

      <AddWorkspaceModal
        open={addWorkspaceOpen}
        initialPath={addWorkspacePath}
        error={addWorkspaceError}
        saving={addingWorkspace}
        onClose={() => {
          setAddWorkspaceOpen(false);
          setAddWorkspaceError(null);
        }}
        onPickDirectory={() => void openWorkspacePicker()}
        onConfirm={(path) => void confirmManualWorkspace(path)}
      />

      <ToastRegion toasts={toasts} />
    </div>
  );
}

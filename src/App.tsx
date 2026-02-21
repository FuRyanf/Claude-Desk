import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AddWorkspaceModal } from './components/AddWorkspaceModal';
import { HeaderBar } from './components/HeaderBar';
import { LeftRail } from './components/LeftRail';
import { SettingsModal } from './components/SettingsModal';
import { TerminalPanel } from './components/TerminalPanel';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { api, onTerminalExit, onThreadUpdated } from './lib/api';
import { useRunStore } from './stores/runStore';
import { useThreadStore } from './stores/threadStore';
import type {
  GitBranchEntry,
  GitInfo,
  GitWorkspaceStatus,
  RunStatus,
  Settings,
  TerminalExitEvent,
  TerminalSessionMode,
  ThreadMetadata,
  Workspace
} from './types';

const SELECTED_WORKSPACE_KEY = 'claude-desk:selected-workspace';
const FULL_ACCESS_CONFIRM_KEY = 'claude-desk:full-access-confirmed';
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function threadSelectionKey(workspaceId: string) {
  return `claude-desk:selected-thread:${workspaceId}`;
}

function todayId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function terminalChunkSignalsIdle(chunk: string): boolean {
  const clean = stripAnsi(chunk);
  return clean.includes('\n❯') || clean.includes('❯ ') || clean.trim().endsWith('❯');
}

function terminalChunkSignalsWorking(chunk: string): boolean {
  const normalized = stripAnsi(chunk).toLowerCase();
  return (
    normalized.includes('esc to interrupt') ||
    normalized.includes('thinking') ||
    normalized.includes('actioning') ||
    normalized.includes('frosting') ||
    normalized.includes('moseying')
  );
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

function looksLikeResumeFailureOutput(output: string): boolean {
  const normalized = stripAnsi(output).toLowerCase();
  const mentionsResume =
    normalized.includes('--resume') || normalized.includes('resume a conversation') || normalized.includes('session');
  if (!mentionsResume) {
    return false;
  }
  return (
    normalized.includes('unknown session') ||
    normalized.includes('invalid session') ||
    normalized.includes('session not found') ||
    normalized.includes('no session found') ||
    normalized.includes('failed to resume')
  );
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
    archiveThread,
    deleteThread,
    setSelectedWorkspace,
    setSelectedThread,
    setThreadRunState,
    applyThreadUpdate
  } = threadStore;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threadSearch, setThreadSearch] = useState('');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [terminalFocused, setTerminalFocused] = useState(false);
  const [terminalSize, setTerminalSize] = useState({ cols: 120, rows: 32 });
  const [lastTerminalLogByThread, setLastTerminalLogByThread] = useState<Record<string, string>>({});

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
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const [pendingFullAccessValue, setPendingFullAccessValue] = useState<boolean | null>(null);
  const [savingFullAccess, setSavingFullAccess] = useState(false);
  const [sessionModeByThread, setSessionModeByThread] = useState<Record<string, TerminalSessionMode>>({});
  const [resumeFailureModal, setResumeFailureModal] = useState<{
    threadId: string;
    workspaceId: string;
    log: string;
    showLog: boolean;
  } | null>(null);

  const selectedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const startingSessionByThreadRef = useRef<Record<string, Promise<string>>>({});
  const pendingInputByThreadRef = useRef<Record<string, string>>({});
  const escapeSignalRef = useRef<{ sessionId: string; at: number } | null>(null);
  const sessionMetaBySessionIdRef = useRef<
    Record<
      string,
      {
        threadId: string;
        workspaceId: string;
        mode: TerminalSessionMode;
        startedAtMs: number;
      }
    >
  >({});

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

  const activeRunCount = Object.keys(runStore.workingByThread).length;

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
        applyThreadUpdate(response.thread);
        setSessionModeByThread((current) => ({
          ...current,
          [thread.id]: response.sessionMode
        }));
        sessionMetaBySessionIdRef.current[sessionId] = {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          mode: response.sessionMode,
          startedAtMs: Date.now()
        };

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
    [applyThreadUpdate, flushPendingThreadInput, runStore, terminalSize.cols, terminalSize.rows, workspaces]
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

  const onArchiveThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const existingSessionId = runStore.sessionForThread(threadId);
      if (existingSessionId) {
        void api.terminalKill(existingSessionId);
        runStore.finishSession(existingSessionId);
        delete sessionMetaBySessionIdRef.current[existingSessionId];
      }

      await archiveThread(workspaceId, threadId);

      if (existingSessionId) {
        runStore.stopWorking(threadId);
      }

      if (selectedThreadIdRef.current === threadId) {
        setSelectedThread(undefined);
      }

      await refreshThreadsForWorkspace(workspaceId);
    },
    [archiveThread, refreshThreadsForWorkspace, runStore, setSelectedThread]
  );

  const onDeleteThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const existingSessionId = runStore.sessionForThread(threadId);
      if (existingSessionId) {
        void api.terminalKill(existingSessionId);
        runStore.finishSession(existingSessionId);
        delete sessionMetaBySessionIdRef.current[existingSessionId];
      }

      await deleteThread(workspaceId, threadId);
      runStore.stopWorking(threadId);

      if (selectedThreadIdRef.current === threadId) {
        setSelectedThread(undefined);
      }

      await refreshThreadsForWorkspace(workspaceId);
    },
    [deleteThread, refreshThreadsForWorkspace, runStore, setSelectedThread]
  );

  const stopThreadSession = useCallback(
    async (threadId: string) => {
      const sessionId = runStore.sessionForThread(threadId);
      if (!sessionId) {
        return;
      }

      try {
        await api.terminalSendSignal(sessionId, 'SIGINT');
      } catch {
        // best effort
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 120);
      });
      try {
        await api.terminalKill(sessionId);
      } catch {
        // best effort
      }
      runStore.finishSession(sessionId);
      runStore.stopWorking(threadId);
      const endedAt = new Date().toISOString();
      setThreadRunState(threadId, 'Canceled', null, endedAt);
      delete sessionMetaBySessionIdRef.current[sessionId];
    },
    [runStore, setThreadRunState]
  );

  const stopSessionsExcept = useCallback(
    async (keepThreadId?: string) => {
      const activeRuns = Object.values(runStore.activeRunsByThread);
      for (const run of activeRuns) {
        if (keepThreadId && run.threadId === keepThreadId) {
          continue;
        }
        await stopThreadSession(run.threadId);
      }
    },
    [runStore.activeRunsByThread, stopThreadSession]
  );

  const switchToThread = useCallback(
    async (threadId: string) => {
      await stopSessionsExcept(threadId);
      setSelectedThread(threadId);
    },
    [setSelectedThread, stopSessionsExcept]
  );

  const restartThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      await stopSessionsExcept();
      if (selectedWorkspaceIdRef.current !== thread.workspaceId) {
        setSelectedWorkspace(thread.workspaceId);
      }
      setSelectedThread(thread.id);
      setResumeFailureModal(null);
      void ensureSessionForThread(thread).catch((error) => {
        pushToast(String(error), 'error');
      });
    },
    [ensureSessionForThread, pushToast, setSelectedThread, setSelectedWorkspace, stopSessionsExcept]
  );

  const onResumeThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      if (!thread.claudeSessionId) {
        pushToast('No saved Claude session id for this thread yet.', 'error');
        return;
      }
      await restartThreadSession(thread);
    },
    [pushToast, restartThreadSession]
  );

  const onStartFreshThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      try {
        const cleared = await api.clearThreadClaudeSession(thread.workspaceId, thread.id);
        applyThreadUpdate(cleared);
        setSessionModeByThread((current) => ({
          ...current,
          [thread.id]: 'new'
        }));
        await restartThreadSession(cleared);
      } catch (error) {
        pushToast(`Failed to start a fresh session: ${String(error)}`, 'error');
      }
    },
    [applyThreadUpdate, pushToast, restartThreadSession]
  );

  const onCopyResumeCommand = useCallback(
    async (thread: ThreadMetadata) => {
      if (!thread.claudeSessionId) {
        pushToast('No saved Claude session id for this thread yet.', 'error');
        return;
      }
      const command = `claude --resume ${thread.claudeSessionId}`;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        pushToast('Copied resume command.', 'info');
        return;
      }
      pushToast(command, 'info');
    },
    [pushToast]
  );

  const stopSessionsForBranchSwitch = useCallback(async () => {
    const activeRuns = Object.values(runStore.activeRunsByThread);
    if (activeRuns.length === 0) {
      return true;
    }

    const confirmed = window.confirm('Switching branches may affect the running session. Continue?');
    if (!confirmed) {
      return false;
    }
    await stopSessionsExcept();
    return true;
  }, [runStore.activeRunsByThread, stopSessionsExcept]);

  const onLoadBranchSwitcher = useCallback(async (): Promise<{
    branches: GitBranchEntry[];
    status: GitWorkspaceStatus | null;
  }> => {
    if (!selectedWorkspace || !gitInfo) {
      return { branches: [], status: null };
    }
    const [branches, status] = await Promise.all([
      api.gitListBranches(selectedWorkspace.path),
      api.gitWorkspaceStatus(selectedWorkspace.path)
    ]);
    return { branches, status };
  }, [gitInfo, selectedWorkspace]);

  const onCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!selectedWorkspace) {
        return false;
      }

      const shouldContinue = await stopSessionsForBranchSwitch();
      if (!shouldContinue) {
        return false;
      }

      try {
        await api.gitCheckoutBranch(selectedWorkspace.path, branchName);
        await refreshGitInfo();
        return true;
      } catch (error) {
        pushToast(`Branch checkout failed: ${String(error)}`, 'error');
        throw error;
      }
    },
    [pushToast, refreshGitInfo, selectedWorkspace, stopSessionsForBranchSwitch]
  );

  const onCreateAndCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!selectedWorkspace) {
        return false;
      }

      const shouldContinue = await stopSessionsForBranchSwitch();
      if (!shouldContinue) {
        return false;
      }

      try {
        await api.gitCreateAndCheckoutBranch(selectedWorkspace.path, branchName);
        await refreshGitInfo();
        return true;
      } catch (error) {
        pushToast(`Create branch failed: ${String(error)}`, 'error');
        throw error;
      }
    },
    [pushToast, refreshGitInfo, selectedWorkspace, stopSessionsForBranchSwitch]
  );

  const applyFullAccessSetting = useCallback(
    async (enabled: boolean) => {
      if (!selectedThread) {
        return;
      }
      setSavingFullAccess(true);
      try {
        const updated = await api.setThreadFullAccess(selectedThread.workspaceId, selectedThread.id, enabled);
        applyThreadUpdate(updated);
      } catch (error) {
        pushToast(`Failed to update Full Access: ${String(error)}`, 'error');
      } finally {
        setSavingFullAccess(false);
      }
    },
    [applyThreadUpdate, pushToast, selectedThread]
  );

  const onToggleFullAccess = useCallback(
    async (nextValue: boolean) => {
      if (!selectedThread) {
        return;
      }

      if (nextValue) {
        const alreadyConfirmed = window.localStorage.getItem(FULL_ACCESS_CONFIRM_KEY) === 'true';
        if (!alreadyConfirmed) {
          setPendingFullAccessValue(true);
          setFullAccessConfirmOpen(true);
          return;
        }
      }

      await applyFullAccessSetting(nextValue);
    },
    [applyFullAccessSetting, selectedThread]
  );

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
        const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
        delete sessionMetaBySessionIdRef.current[event.sessionId];

        const endedThreadId = runStore.finishSession(event.sessionId);
        if (!endedThreadId) {
          return;
        }

        const endedAt = new Date().toISOString();
        setThreadRunState(endedThreadId, statusFromExit(event), null, endedAt);

        const workspaceId =
          sessionMeta?.workspaceId ??
          Object.values(threadsByWorkspace)
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

            if (sessionMeta?.mode !== 'resumed') {
              return;
            }

            const elapsedMs = Date.now() - sessionMeta.startedAtMs;
            const failedCode = typeof event.code === 'number' && event.code !== 0 && event.code !== 130;
            const likelyResumeFailure =
              looksLikeResumeFailureOutput(snapshot) || (failedCode && elapsedMs < 15_000);
            if (!likelyResumeFailure || !workspaceId) {
              return;
            }

            setResumeFailureModal({
              threadId: endedThreadId,
              workspaceId,
              log: snapshot,
              showLog: false
            });
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
    let unlistenThreadUpdate: (() => void) | null = null;

    const setup = async () => {
      unlistenThreadUpdate = await onThreadUpdated((thread) => {
        applyThreadUpdate(thread);
      });
    };

    void setup();
    return () => {
      unlistenThreadUpdate?.();
    };
  }, [applyThreadUpdate]);

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

  const copyEnvDiagnostics = useCallback(async () => {
    if (!selectedWorkspace) {
      pushToast('Select a workspace first.', 'error');
      return;
    }

    try {
      const diagnostics = await api.copyTerminalEnvDiagnostics(selectedWorkspace.path);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(diagnostics);
        pushToast('Copied terminal environment diagnostics to clipboard.', 'info');
      } else {
        pushToast('Diagnostics saved to artifacts/env-diagnostics.txt.', 'info');
      }
    } catch (error) {
      pushToast(`Failed to collect diagnostics: ${String(error)}`, 'error');
    }
  }, [pushToast, selectedWorkspace]);

  const selectedWorkingStartedAt = runStore.workingStartedAtForThread(selectedThreadId);
  const runningForLabel = selectedWorkingStartedAt
    ? formatDurationShort((nowMs - Date.parse(selectedWorkingStartedAt)) / 1000)
    : undefined;
  const normalizedStatus =
    selectedThread?.lastRunStatus && selectedThread.lastRunStatus !== 'Running'
      ? selectedThread.lastRunStatus
      : 'Idle';
  const statusLabel = runStore.isThreadWorking(selectedThreadId) ? 'Running' : normalizedStatus;
  const selectedSessionMode = selectedThreadId ? sessionModeByThread[selectedThreadId] : undefined;
  const sessionModeLabel =
    selectedSessionMode === 'resumed' ? 'Resumed' : selectedSessionMode === 'new' ? 'New session' : undefined;

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
          Object.entries(runStore.workingByThread).map(([threadId, run]) => [threadId, { startedAt: run.startedAt }])
        )}
        onSelectWorkspace={(workspaceId) => {
          void stopSessionsExcept();
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
        onSelectThread={(threadId) => void switchToThread(threadId)}
        onRenameThread={onRenameThread}
        onArchiveThread={onArchiveThread}
        onDeleteThread={onDeleteThread}
        onResumeThreadSession={onResumeThreadSession}
        onStartFreshThreadSession={onStartFreshThreadSession}
        onCopyResumeCommand={onCopyResumeCommand}
        getSearchTextForThread={(threadId) => lastTerminalLogByThread[threadId] ?? ''}
      />

      <main className={blockingError ? 'main-panel has-blocking-error' : 'main-panel'} data-testid="main-panel">
        <HeaderBar
          workspace={selectedWorkspace}
          gitInfo={gitInfo}
          statusLabel={statusLabel}
          runningForLabel={runningForLabel}
          sessionModeLabel={sessionModeLabel}
          fullAccess={selectedThread?.fullAccess ?? false}
          fullAccessDisabled={!selectedThread || savingFullAccess}
          onToggleFullAccess={onToggleFullAccess}
          onLoadBranchSwitcher={onLoadBranchSwitcher}
          onCheckoutBranch={onCheckoutBranch}
          onCreateAndCheckoutBranch={onCreateAndCheckoutBranch}
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
                if (data.includes('\r')) {
                  runStore.startWorking(selectedThread.id);
                }
                if (sessionId) {
                  void api.terminalWrite(sessionId, data);
                  return;
                }

                pendingInputByThreadRef.current[selectedThread.id] = `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${data}`;
                void ensureSessionForThread(selectedThread);
              }}
              onOutput={(chunk) => {
                if (!selectedThread) {
                  return;
                }
                if (terminalChunkSignalsIdle(chunk)) {
                  runStore.stopWorking(selectedThread.id);
                } else if (terminalChunkSignalsWorking(chunk)) {
                  runStore.startWorking(selectedThread.id);
                }
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
      </main>

      <SettingsModal
        open={settingsOpen}
        initialCliPath={settings.claudeCliPath ?? ''}
        detectedCliPath={detectedCliPath}
        onClose={() => setSettingsOpen(false)}
        onSave={(path) => void saveSettings(path)}
        onCopyEnvDiagnostics={() => void copyEnvDiagnostics()}
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

      {resumeFailureModal ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h3>Failed to resume session. Start fresh?</h3>
            <p>Claude could not resume this thread&apos;s saved session id.</p>
            {resumeFailureModal.showLog ? <pre>{resumeFailureModal.log || '(No logs captured)'}</pre> : null}
            <footer className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setResumeFailureModal(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setResumeFailureModal((current) =>
                    current
                      ? {
                          ...current,
                          showLog: !current.showLog
                        }
                      : null
                  );
                }}
              >
                View logs
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const thread = (threadsByWorkspace[resumeFailureModal.workspaceId] ?? []).find(
                    (item) => item.id === resumeFailureModal.threadId
                  );
                  if (thread) {
                    void onStartFreshThreadSession(thread);
                  } else {
                    pushToast('Unable to locate thread metadata for fresh restart.', 'error');
                  }
                  setResumeFailureModal(null);
                }}
              >
                Start fresh
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {fullAccessConfirmOpen ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h3>Enable Full Access?</h3>
            <p>Full Access disables permission prompts. Continue?</p>
            <footer className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setFullAccessConfirmOpen(false);
                  setPendingFullAccessValue(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const nextValue = pendingFullAccessValue ?? true;
                  window.localStorage.setItem(FULL_ACCESS_CONFIRM_KEY, 'true');
                  setFullAccessConfirmOpen(false);
                  setPendingFullAccessValue(null);
                  void applyFullAccessSetting(nextValue);
                }}
              >
                Enable Full Access
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <ToastRegion toasts={toasts} />
    </div>
  );
}

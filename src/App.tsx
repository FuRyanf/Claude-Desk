import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AddWorkspaceModal } from './components/AddWorkspaceModal';
import { BottomBar } from './components/BottomBar';
import { HeaderBar } from './components/HeaderBar';
import { LeftRail } from './components/LeftRail';
import { SettingsModal } from './components/SettingsModal';
import { TerminalPanel } from './components/TerminalPanel';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { api, onTerminalData, onTerminalExit, onThreadUpdated } from './lib/api';
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
const SIDEBAR_WIDTH_KEY = 'claude-desk:sidebar-width';
const SIDEBAR_WIDTH_DEFAULT = 320;
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 460;
const TERMINAL_LOG_BUFFER_CHARS = 280_000;
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TERMINAL_INPUT_ESCAPE_REGEX = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.)/g;

interface PendingSessionStart {
  requestId: number;
  promise: Promise<string>;
}

function removeThreadFlag(map: Record<string, boolean>, threadId: string) {
  if (!map[threadId]) {
    return map;
  }
  const next = { ...map };
  delete next[threadId];
  return next;
}

function threadSelectionKey(workspaceId: string) {
  return `claude-desk:selected-thread:${workspaceId}`;
}

function todayId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function isDefaultThreadTitle(title: string): boolean {
  return title.trim().toLowerCase() === 'new thread';
}

function normalizeTerminalInputChunk(data: string): string {
  return data.replace(TERMINAL_INPUT_ESCAPE_REGEX, '');
}

function extractSubmittedInputLines(
  previousBuffer: string,
  chunk: string
): { nextBuffer: string; submittedLines: string[] } {
  const normalized = normalizeTerminalInputChunk(chunk);
  if (!normalized) {
    return { nextBuffer: previousBuffer, submittedLines: [] };
  }

  let buffer = previousBuffer;
  const submittedLines: string[] = [];

  for (const char of normalized) {
    if (char === '\r' || char === '\n') {
      if (buffer.trim().length > 0) {
        submittedLines.push(buffer);
      }
      buffer = '';
      continue;
    }

    if (char === '\u007f' || char === '\b') {
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
      }
      continue;
    }

    if (char >= ' ' && char !== '\u007f') {
      buffer += char;
    }
  }

  return { nextBuffer: buffer, submittedLines };
}

function clampTerminalLog(text: string): string {
  if (text.length <= TERMINAL_LOG_BUFFER_CHARS) {
    return text;
  }
  return text.slice(text.length - TERMINAL_LOG_BUFFER_CHARS);
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

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return await Promise.race<T | null>([
    promise,
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs);
    })
  ]);
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
    setThreadFullAccess,
    renameThread,
    deleteThread,
    setSelectedWorkspace,
    setSelectedThread,
    setThreadRunState,
    applyThreadUpdate,
    markThreadUserInput,
    threadLastUserInputAt
  } = threadStore;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedRaw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (savedRaw !== null) {
      const saved = Number(savedRaw);
      if (Number.isFinite(saved)) {
        return clampSidebarWidth(saved);
      }
    }
    return SIDEBAR_WIDTH_DEFAULT;
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
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
  const [fullAccessUpdating, setFullAccessUpdating] = useState(false);
  const [startingByThread, setStartingByThread] = useState<Record<string, boolean>>({});
  const [readyByThread, setReadyByThread] = useState<Record<string, boolean>>({});
  const [resumeFailureModal, setResumeFailureModal] = useState<{
    threadId: string;
    workspaceId: string;
    log: string;
    showLog: boolean;
  } | null>(null);

  const selectedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const activeRunsByThreadRef = useRef(runStore.activeRunsByThread);
  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startingSessionByThreadRef = useRef<Record<string, PendingSessionStart>>({});
  const sessionStartRequestIdByThreadRef = useRef<Record<string, number>>({});
  const threadsByWorkspaceRef = useRef<Record<string, ThreadMetadata[]>>({});
  const lastTerminalLogByThreadRef = useRef<Record<string, string>>({});
  const inputBufferByThreadRef = useRef<Record<string, string>>({});
  const threadTitleInitializedRef = useRef<Record<string, true>>({});
  const deletedThreadIdsRef = useRef<Record<string, true>>({});
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

  const allThreads = useMemo(() => Object.values(threadsByWorkspace).flat(), [threadsByWorkspace]);

  const selectedThread = useMemo(() => {
    if (!selectedThreadId) {
      return undefined;
    }
    return allThreads.find((thread) => thread.id === selectedThreadId);
  }, [allThreads, selectedThreadId]);

  const selectedSessionId = runStore.sessionForThread(selectedThreadId);
  const isSelectedThreadStarting = selectedThread ? Boolean(startingByThread[selectedThread.id]) : false;
  const isSelectedThreadReady = selectedThread ? Boolean(readyByThread[selectedThread.id]) : false;

  const selectedTerminalContent = useMemo(() => {
    if (!selectedThreadId) {
      return '';
    }
    return lastTerminalLogByThread[selectedThreadId] ?? '';
  }, [lastTerminalLogByThread, selectedThreadId]);


  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    activeRunsByThreadRef.current = runStore.activeRunsByThread;
  }, [runStore.activeRunsByThread]);

  useEffect(() => {
    lastTerminalLogByThreadRef.current = lastTerminalLogByThread;
  }, [lastTerminalLogByThread]);

  useEffect(() => {
    threadsByWorkspaceRef.current = threadsByWorkspace;

    for (const thread of Object.values(threadsByWorkspace).flat()) {
      if (!isDefaultThreadTitle(thread.title)) {
        threadTitleInitializedRef.current[thread.id] = true;
      }
    }

    const deletedThreadIds = deletedThreadIdsRef.current;
    if (Object.keys(deletedThreadIds).length === 0) {
      return;
    }

    for (const thread of Object.values(threadsByWorkspace).flat()) {
      if (!deletedThreadIds[thread.id]) {
        continue;
      }
      applyThreadUpdate({
        ...thread,
        isArchived: true
      });
    }
  }, [applyThreadUpdate, threadsByWorkspace]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    const onMove = (clientX: number) => {
      const state = sidebarResizeStateRef.current;
      if (!state) {
        return;
      }
      const safeClientX = Number.isFinite(clientX) ? clientX : state.startX;
      const nextWidth = clampSidebarWidth(state.startWidth + (safeClientX - state.startX));
      if (!Number.isFinite(nextWidth)) {
        return;
      }
      setSidebarWidth(nextWidth);
    };

    const onPointerMove = (event: PointerEvent) => {
      onMove(event.clientX);
    };

    const onMouseMove = (event: MouseEvent) => {
      onMove(event.clientX);
    };

    const finishResize = () => {
      sidebarResizeStateRef.current = null;
      setIsSidebarResizing(false);
    };

    document.body.classList.add('sidebar-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('mouseup', finishResize);

    return () => {
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('mouseup', finishResize);
    };
  }, [isSidebarResizing]);

  const pushToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    const id = todayId();
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  const beginSidebarResize = useCallback(
    (clientX: number) => {
      const safeClientX = Number.isFinite(clientX) ? clientX : 0;
      sidebarResizeStateRef.current = {
        startX: safeClientX,
        startWidth: sidebarWidth
      };
      setIsSidebarResizing(true);
    },
    [sidebarWidth]
  );

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      event.preventDefault();
      beginSidebarResize(event.clientX);
    },
    [beginSidebarResize]
  );

  const startSidebarResizeWithMouse = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      event.preventDefault();
      beginSidebarResize(event.clientX);
    },
    [beginSidebarResize]
  );

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

  const appendTerminalLogChunk = useCallback((threadId: string, chunk: string) => {
    if (!chunk) {
      return;
    }
    setLastTerminalLogByThread((current) => {
      const previous = current[threadId] ?? '';
      const combined = `${previous}${chunk}`;
      const next = clampTerminalLog(combined);
      if (next === previous) {
        return current;
      }
      return {
        ...current,
        [threadId]: next
      };
    });
  }, []);

  const hydrateSessionSnapshot = useCallback(
    async (threadId: string, sessionId: string, retries = 12, delayMs = 180) => {
      let attempts = 0;
      while (attempts < retries) {
        const liveSessionId = runStore.sessionForThread(threadId);
        if (!liveSessionId || liveSessionId !== sessionId) {
          return;
        }

        const snapshot = await api.terminalReadOutput(sessionId).catch(() => '');
        if (snapshot && snapshot.length > 0) {
          setLastTerminalLogByThread((current) => ({
            ...current,
            [threadId]: clampTerminalLog(snapshot)
          }));
          setStartingByThread((current) => removeThreadFlag(current, threadId));
          setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
          return;
        }

        attempts += 1;
        if (attempts >= retries) {
          break;
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), delayMs);
        });
      }

      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
    },
    [runStore]
  );

  const bumpSessionStartRequestId = useCallback((threadId: string) => {
    const next = (sessionStartRequestIdByThreadRef.current[threadId] ?? 0) + 1;
    sessionStartRequestIdByThreadRef.current[threadId] = next;
    return next;
  }, []);

  const invalidatePendingSessionStart = useCallback(
    (threadId: string) => {
      bumpSessionStartRequestId(threadId);
      delete startingSessionByThreadRef.current[threadId];
      delete pendingInputByThreadRef.current[threadId];
      setStartingByThread((current) => removeThreadFlag(current, threadId));
    },
    [bumpSessionStartRequestId]
  );

  const ensureSessionForThread = useCallback(
    async (thread: ThreadMetadata): Promise<string> => {
      if (deletedThreadIdsRef.current[thread.id]) {
        return '';
      }

      const existing = runStore.sessionForThread(thread.id);
      if (existing) {
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        setReadyByThread((current) => removeThreadFlag(current, thread.id));
        void hydrateSessionSnapshot(thread.id, existing, 8, 150);
        await flushPendingThreadInput(thread.id, existing);
        return existing;
      }

      const inFlight = startingSessionByThreadRef.current[thread.id];
      if (inFlight) {
        return inFlight.promise;
      }

      const workspace = workspaces.find((item) => item.id === thread.workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found for thread.');
      }
      const requestId = bumpSessionStartRequestId(thread.id);
      setStartingByThread((current) => ({
        ...current,
        [thread.id]: true
      }));
      setReadyByThread((current) => removeThreadFlag(current, thread.id));

      const startPromise = (async () => {
        const response = await api.terminalStartSession({
          workspacePath: workspace.path,
          initialCwd: workspace.path,
          fullAccessFlag: thread.fullAccess,
          threadId: thread.id
        });

        const sessionId = response.sessionId;
        if ((sessionStartRequestIdByThreadRef.current[thread.id] ?? 0) !== requestId) {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
          try {
            await api.terminalKill(sessionId);
          } catch {
            // best effort
          }
          return '';
        }

        if (deletedThreadIdsRef.current[thread.id]) {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
          try {
            await api.terminalKill(sessionId);
          } catch {
            // best effort
          }
          return '';
        }

        const threadStillExists = (threadsByWorkspaceRef.current[thread.workspaceId] ?? []).some(
          (item) => item.id === thread.id
        );
        if (!threadStillExists) {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
          try {
            await api.terminalKill(sessionId);
          } catch {
            // best effort
          }
          return '';
        }
        applyThreadUpdate(response.thread);

        const startedAt = new Date().toISOString();
        runStore.bindSession(thread.id, sessionId, startedAt);
        sessionMetaBySessionIdRef.current[sessionId] = {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          mode: response.sessionMode,
          startedAtMs: Date.now()
        };

        void api.terminalResize(sessionId, terminalSize.cols, terminalSize.rows);
        await flushPendingThreadInput(thread.id, sessionId);
        void hydrateSessionSnapshot(thread.id, sessionId, 18, 180);
        return sessionId;
      })()
        .catch((error) => {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
          throw error;
        })
        .finally(() => {
          if (startingSessionByThreadRef.current[thread.id]?.requestId === requestId) {
            delete startingSessionByThreadRef.current[thread.id];
          }
        });

      startingSessionByThreadRef.current[thread.id] = { requestId, promise: startPromise };
      return startPromise;
    },
    [
      applyThreadUpdate,
      bumpSessionStartRequestId,
      flushPendingThreadInput,
      hydrateSessionSnapshot,
      runStore,
      terminalSize.cols,
      terminalSize.rows,
      workspaces
    ]
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

  const onNewThreadInWorkspace = useCallback(
    async (workspaceId: string) => {
      if (selectedWorkspaceIdRef.current !== workspaceId) {
        setSelectedWorkspace(workspaceId);
      }
      const thread = await createThread(workspaceId);
      delete deletedThreadIdsRef.current[thread.id];
      setSelectedThread(thread.id);
      await refreshThreadsForWorkspace(workspaceId);
    },
    [createThread, refreshThreadsForWorkspace, setSelectedThread, setSelectedWorkspace]
  );

  const onRenameThread = useCallback(
    async (workspaceId: string, threadId: string, title: string) => {
      try {
        await renameThread(workspaceId, threadId, title);
        await refreshThreadsForWorkspace(workspaceId);
      } catch (error) {
        pushToast(`Rename failed: ${String(error)}`, 'error');
      }
    },
    [pushToast, refreshThreadsForWorkspace, renameThread]
  );

  const onDeleteThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      deletedThreadIdsRef.current[threadId] = true;
      invalidatePendingSessionStart(threadId);
      const existingSessionId = runStore.sessionForThread(threadId);
      if (existingSessionId) {
        try {
          await withTimeout(api.terminalSendSignal(existingSessionId, 'SIGINT'), 700);
        } catch {
          // best effort
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), 80);
        });
        try {
          await withTimeout(api.terminalKill(existingSessionId), 900);
        } catch {
          // best effort
        }
        runStore.finishSession(existingSessionId);
        delete sessionMetaBySessionIdRef.current[existingSessionId];
      }

      try {
        await deleteThread(workspaceId, threadId);
      } catch (error) {
        delete deletedThreadIdsRef.current[threadId];
        pushToast(`Delete failed: ${String(error)}`, 'error');
        return;
      }
      const deletedThread = (threadsByWorkspaceRef.current[workspaceId] ?? []).find((thread) => thread.id === threadId);
      if (deletedThread) {
        applyThreadUpdate({
          ...deletedThread,
          isArchived: true
        });
      }
      delete inputBufferByThreadRef.current[threadId];
      delete threadTitleInitializedRef.current[threadId];
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));

      if (selectedThreadIdRef.current === threadId) {
        setSelectedThread(undefined);
      }

      await refreshThreadsForWorkspace(workspaceId);
    },
    [
      applyThreadUpdate,
      deleteThread,
      invalidatePendingSessionStart,
      pushToast,
      refreshThreadsForWorkspace,
      runStore,
      setSelectedThread
    ]
  );

  const stopThreadSession = useCallback(
    async (threadId: string) => {
      invalidatePendingSessionStart(threadId);
      const sessionId = runStore.sessionForThread(threadId);
      if (!sessionId) {
        return;
      }

      try {
        const snapshot = await withTimeout(api.terminalReadOutput(sessionId), 350);
        if (typeof snapshot === 'string' && snapshot.length > 0) {
          setLastTerminalLogByThread((current) => ({
            ...current,
            [threadId]: clampTerminalLog(snapshot)
          }));
        }
      } catch {
        // best effort
      }

      try {
        await withTimeout(api.terminalSendSignal(sessionId, 'SIGINT'), 700);
      } catch {
        // best effort
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 120);
      });
      try {
        await withTimeout(api.terminalKill(sessionId), 900);
      } catch {
        // best effort
      }
      runStore.finishSession(sessionId);
      const endedAt = new Date().toISOString();
      setThreadRunState(threadId, 'Canceled', null, endedAt);
      delete sessionMetaBySessionIdRef.current[sessionId];
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));
    },
    [invalidatePendingSessionStart, runStore, setThreadRunState]
  );

  const stopSessionsExcept = useCallback(
    async (keepThreadId?: string) => {
      for (const threadId of Object.keys(startingSessionByThreadRef.current)) {
        if (keepThreadId && threadId === keepThreadId) {
          continue;
        }
        invalidatePendingSessionStart(threadId);
      }
      const activeRuns = Object.values(runStore.activeRunsByThread);
      for (const run of activeRuns) {
        if (keepThreadId && run.threadId === keepThreadId) {
          continue;
        }
        await stopThreadSession(run.threadId);
      }
    },
    [invalidatePendingSessionStart, runStore.activeRunsByThread, stopThreadSession]
  );

  const switchToThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      if (selectedWorkspaceIdRef.current !== workspaceId) {
        setSelectedWorkspace(workspaceId);
      }
      setSelectedThread(threadId);
    },
    [setSelectedThread, setSelectedWorkspace]
  );

  const restartThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      await stopThreadSession(thread.id);
      if (selectedWorkspaceIdRef.current !== thread.workspaceId) {
        setSelectedWorkspace(thread.workspaceId);
      }
      setSelectedThread(thread.id);
      setResumeFailureModal(null);
      void ensureSessionForThread(thread).catch((error) => {
        pushToast(String(error), 'error');
      });
    },
    [ensureSessionForThread, pushToast, setSelectedThread, setSelectedWorkspace, stopThreadSession]
  );

  const onStartFreshThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      try {
        const cleared = await api.clearThreadClaudeSession(thread.workspaceId, thread.id);
        applyThreadUpdate(cleared);
        await restartThreadSession(cleared);
      } catch (error) {
        pushToast(`Failed to start a fresh session: ${String(error)}`, 'error');
      }
    },
    [applyThreadUpdate, pushToast, restartThreadSession]
  );

  const stopSessionsForBranchSwitch = useCallback(async () => {
    await stopSessionsExcept();
  }, [stopSessionsExcept]);

  const stopSessionsForWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspaceThreads = threadsByWorkspaceRef.current[workspaceId] ?? [];
      const activeThreadIds = new Set(Object.values(runStore.activeRunsByThread).map((run) => run.threadId));
      for (const thread of workspaceThreads) {
        if (!activeThreadIds.has(thread.id)) {
          continue;
        }
        await stopThreadSession(thread.id);
      }
    },
    [runStore.activeRunsByThread, stopThreadSession]
  );

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

      await stopSessionsForBranchSwitch();

      try {
        await api.gitCheckoutBranch(selectedWorkspace.path, branchName);
        await refreshGitInfo();
        if (selectedThread?.workspaceId === selectedWorkspace.id) {
          const snapshot = await api.terminalGetLastLog(selectedWorkspace.id, selectedThread.id).catch(() => '');
          if (snapshot) {
            setLastTerminalLogByThread((current) => ({
              ...current,
              [selectedThread.id]: clampTerminalLog(snapshot)
            }));
          }
        }
        return true;
      } catch (error) {
        pushToast(`Branch checkout failed: ${String(error)}`, 'error');
        throw error;
      }
    },
    [pushToast, refreshGitInfo, selectedThread, selectedWorkspace, stopSessionsForBranchSwitch]
  );

  const onCreateAndCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!selectedWorkspace) {
        return false;
      }

      await stopSessionsForBranchSwitch();

      try {
        await api.gitCreateAndCheckoutBranch(selectedWorkspace.path, branchName);
        await refreshGitInfo();
        if (selectedThread?.workspaceId === selectedWorkspace.id) {
          const snapshot = await api.terminalGetLastLog(selectedWorkspace.id, selectedThread.id).catch(() => '');
          if (snapshot) {
            setLastTerminalLogByThread((current) => ({
              ...current,
              [selectedThread.id]: clampTerminalLog(snapshot)
            }));
          }
        }
        return true;
      } catch (error) {
        pushToast(`Create branch failed: ${String(error)}`, 'error');
        throw error;
      }
    },
    [pushToast, refreshGitInfo, selectedThread, selectedWorkspace, stopSessionsForBranchSwitch]
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
    if (workspaces.length === 0) {
      return;
    }

    void Promise.all(
      workspaces.map(async (workspace) => {
        try {
          await listThreads(workspace.id);
        } catch {
          // keep rendering other workspaces even if one fails to refresh
        }
      })
    );
  }, [listThreads, workspaces]);

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
    let cancelled = false;
    void api
      .terminalGetLastLog(selectedWorkspaceId, selectedThreadId)
      .then((log) => {
        if (cancelled) {
          return;
        }
        setLastTerminalLogByThread((current) => ({
          ...current,
          [selectedThreadId]: clampTerminalLog(log)
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLastTerminalLogByThread((current) => ({
          ...current,
          [selectedThreadId]: ''
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    let unlistenData: (() => void) | null = null;

    const setup = async () => {
      unlistenData = await onTerminalData((event) => {
        const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
        const threadId =
          sessionMeta?.threadId ??
          Object.entries(activeRunsByThreadRef.current).find(([, run]) => run.sessionId === event.sessionId)?.[0];
        if (!threadId) {
          return;
        }

        if (selectedThreadIdRef.current !== threadId) {
          return;
        }

        setStartingByThread((current) => removeThreadFlag(current, threadId));
        setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
        appendTerminalLogChunk(threadId, event.data);
      });
    };

    void setup();
    return () => {
      unlistenData?.();
    };
  }, [appendTerminalLogChunk]);

  useEffect(() => {
    if (!selectedThread) {
      return;
    }
    const existingSessionId = runStore.sessionForThread(selectedThread.id);
    if (existingSessionId) {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));
      void hydrateSessionSnapshot(selectedThread.id, existingSessionId, 3, 100);
      return;
    }

    setStartingByThread((current) => ({
      ...current,
      [selectedThread.id]: true
    }));
    setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));

    void ensureSessionForThread(selectedThread).catch((error) => {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      pushToast(`Failed to start Claude session: ${String(error)}`, 'error');
    });
  }, [ensureSessionForThread, hydrateSessionSnapshot, pushToast, runStore, selectedThread]);

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
        setStartingByThread((current) => removeThreadFlag(current, endedThreadId));
        setReadyByThread((current) => removeThreadFlag(current, endedThreadId));

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
              [endedThreadId]: clampTerminalLog(snapshot)
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
        if (!thread || !thread.id || !thread.workspaceId) {
          return;
        }
        if (deletedThreadIdsRef.current[thread.id]) {
          return;
        }
        applyThreadUpdate(thread);
      });
    };

    void setup();
    return () => {
      unlistenThreadUpdate?.();
    };
  }, [applyThreadUpdate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (terminalFocused && event.metaKey && key === 'c' && selectedSessionId) {
        event.preventDefault();
        void api.terminalSendSignal(selectedSessionId, 'SIGINT');
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
  }, [selectedSessionId, terminalFocused]);

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

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const selectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      void switchToThread(workspaceId, threadId);
    },
    [switchToThread]
  );

  const toggleFullAccess = useCallback(async () => {
    if (!selectedThread || fullAccessUpdating) {
      return;
    }

    const nextValue = !selectedThread.fullAccess;
    setFullAccessUpdating(true);
    try {
      const updatedThread = await setThreadFullAccess(selectedThread.workspaceId, selectedThread.id, nextValue);
      await stopThreadSession(updatedThread.id);
      if (selectedWorkspaceIdRef.current !== updatedThread.workspaceId) {
        setSelectedWorkspace(updatedThread.workspaceId);
      }
      setSelectedThread(updatedThread.id);
      await ensureSessionForThread(updatedThread);
    } catch (error) {
      pushToast(`Failed to update Full access: ${String(error)}`, 'error');
    } finally {
      setFullAccessUpdating(false);
    }
  }, [
    ensureSessionForThread,
    fullAccessUpdating,
    pushToast,
    selectedThread,
    setSelectedThread,
    setSelectedWorkspace,
    setThreadFullAccess,
    stopThreadSession
  ]);

  const openWorkspaceInFinder = useCallback((workspacePath: string) => {
    void api.openInFinder(workspacePath);
  }, []);

  const openWorkspaceInTerminal = useCallback((workspacePath: string) => {
    void api.openInTerminal(workspacePath);
  }, []);

  const onRemoveWorkspace = useCallback(
    async (workspace: Workspace) => {
      const confirmed = window.confirm(
        `Remove "${workspace.name}" from Claude Desk?\n\nThis keeps your local folder intact but removes its saved threads in Claude Desk.`
      );
      if (!confirmed) {
        return;
      }

      const workspaceThreads = threadsByWorkspaceRef.current[workspace.id] ?? [];
      const threadIds = workspaceThreads.map((thread) => thread.id);

      for (const threadId of threadIds) {
        invalidatePendingSessionStart(threadId);
      }
      await stopSessionsForWorkspace(workspace.id);

      const removed = await api.removeWorkspace(workspace.id);
      if (!removed) {
        pushToast(`Project "${workspace.name}" was already removed.`, 'info');
        await refreshWorkspaces();
        return;
      }

      window.localStorage.removeItem(threadSelectionKey(workspace.id));
      setLastTerminalLogByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });
      setStartingByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });
      setReadyByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });

      if (threadIds.includes(selectedThreadIdRef.current ?? '')) {
        setSelectedThread(undefined);
      }

      await refreshWorkspaces();
      pushToast(`Removed project "${workspace.name}".`, 'info');
    },
    [invalidatePendingSessionStart, pushToast, refreshWorkspaces, setSelectedThread, stopSessionsForWorkspace]
  );

  const getSearchTextForThread = useCallback((threadId: string) => {
    return lastTerminalLogByThreadRef.current[threadId] ?? '';
  }, []);

  const appShellStyle = useMemo(
    () =>
      ({
        '--sidebar-width': `${sidebarWidth}px`
      }) as CSSProperties,
    [sidebarWidth]
  );

  return (
    <div className={isSidebarResizing ? 'app-shell sidebar-resizing' : 'app-shell'} style={appShellStyle}>
      <LeftRail
        sidebarWidth={sidebarWidth}
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedThreadId={selectedThreadId}
        threadSearch={threadSearch}
        onOpenWorkspacePicker={openWorkspacePicker}
        onOpenSettings={openSettings}
        onNewThreadInWorkspace={onNewThreadInWorkspace}
        onThreadSearchChange={setThreadSearch}
        onSelectThread={selectThread}
        onRenameThread={onRenameThread}
        onDeleteThread={onDeleteThread}
        onOpenWorkspaceInFinder={openWorkspaceInFinder}
        onOpenWorkspaceInTerminal={openWorkspaceInTerminal}
        onRemoveWorkspace={onRemoveWorkspace}
        threadLastUserInputAt={threadLastUserInputAt}
        getSearchTextForThread={getSearchTextForThread}
      />
      <div
        className="sidebar-resizer"
        data-testid="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onPointerDown={startSidebarResize}
        onMouseDown={startSidebarResizeWithMouse}
      />

      <main className={blockingError ? 'main-panel has-blocking-error' : 'main-panel'} data-testid="main-panel">
        <HeaderBar
          workspace={selectedWorkspace}
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
              inputEnabled={Boolean(selectedSessionId) && isSelectedThreadReady && !isSelectedThreadStarting}
              overlayMessage={isSelectedThreadStarting || !selectedSessionId ? 'Starting Claude session...' : undefined}
              onData={(data) => {
                if (!selectedThread) {
                  return;
                }

                const { nextBuffer, submittedLines } = extractSubmittedInputLines(
                  inputBufferByThreadRef.current[selectedThread.id] ?? '',
                  data
                );
                inputBufferByThreadRef.current[selectedThread.id] = nextBuffer;

                if (
                  submittedLines.length > 0 &&
                  isDefaultThreadTitle(selectedThread.title) &&
                  !threadTitleInitializedRef.current[selectedThread.id]
                ) {
                  const firstLine = submittedLines.map((line) => line.trim()).find((line) => line.length > 0);
                  if (firstLine) {
                    threadTitleInitializedRef.current[selectedThread.id] = true;
                    void onRenameThread(selectedThread.workspaceId, selectedThread.id, firstLine.slice(0, 50));
                  }
                }

                if (submittedLines.length > 0) {
                  markThreadUserInput(selectedThread.workspaceId, selectedThread.id);
                }

                if (isSelectedThreadStarting || !selectedSessionId) {
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
            <div className="terminal-empty">Select a thread to start Claude.</div>
          )}
        </section>
        <BottomBar
          workspace={selectedWorkspace}
          selectedThread={selectedThread}
          fullAccessUpdating={fullAccessUpdating}
          gitInfo={gitInfo}
          onToggleFullAccess={toggleFullAccess}
          onLoadBranchSwitcher={onLoadBranchSwitcher}
          onCheckoutBranch={onCheckoutBranch}
          onCreateAndCheckoutBranch={onCreateAndCheckoutBranch}
        />
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

      <ToastRegion toasts={toasts} />
    </div>
  );
}

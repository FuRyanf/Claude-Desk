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
const MAX_ATTACHMENT_DRAFTS = 24;
const MAX_ATTACHMENTS_PER_MESSAGE = 12;
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TERMINAL_INPUT_ESCAPE_REGEX = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.)/g;
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']);

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

function normalizeAttachmentPaths(raw: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of raw) {
    const path = value.trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    normalized.push(path);
  }

  return normalized;
}

function mergeAttachmentPaths(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  const seen = new Set(existing);
  for (const path of incoming) {
    if (seen.has(path)) {
      continue;
    }
    merged.push(path);
    seen.add(path);
    if (merged.length >= MAX_ATTACHMENT_DRAFTS) {
      break;
    }
  }
  return merged;
}

function isImageAttachmentPath(path: string): boolean {
  const lastSegment = path.split(/[\\/]/).pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  const extension = lastSegment.slice(dotIndex + 1).toLowerCase();
  return IMAGE_ATTACHMENT_EXTENSIONS.has(extension);
}

function quotePathForPrompt(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

function buildAttachmentPrompt(paths: string[]): string {
  const limited = paths.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const omittedCount = Math.max(0, paths.length - limited.length);
  const hasImages = limited.some(isImageAttachmentPath);

  const parts = [
    `Use these attachments from Claude Desk as context: ${limited.map(quotePathForPrompt).join(', ')}.`,
    hasImages ? 'For image/screenshot files, analyze the visual content.' : 'Read each file directly from the provided path.',
    'If any path cannot be accessed, tell me exactly which one failed.'
  ];

  if (omittedCount > 0) {
    parts.push(
      `${omittedCount} additional attachment${omittedCount === 1 ? '' : 's'} were selected but omitted to keep the prompt compact.`
    );
  }

  return parts.join(' ');
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
  const [draftAttachmentsByThread, setDraftAttachmentsByThread] = useState<Record<string, string[]>>({});

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
  const draftAttachmentsByThreadRef = useRef<Record<string, string[]>>({});
  const inputBufferByThreadRef = useRef<Record<string, string>>({});
  const threadTitleInitializedRef = useRef<Record<string, true>>({});
  const deletedThreadIdsRef = useRef<Record<string, true>>({});
  const pendingInputByThreadRef = useRef<Record<string, string>>({});
  const escapeSignalRef = useRef<{ sessionId: string; at: number } | null>(null);
  const pendingSnapshotBySessionRef = useRef<Record<string, true>>({});
  const sawLiveDuringSnapshotBySessionRef = useRef<Record<string, true>>({});
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

  const selectedThreadDraftAttachments = useMemo(() => {
    if (!selectedThreadId) {
      return [];
    }
    return draftAttachmentsByThread[selectedThreadId] ?? [];
  }, [draftAttachmentsByThread, selectedThreadId]);


  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    activeRunsByThreadRef.current = runStore.activeRunsByThread;
  }, [runStore.activeRunsByThread]);

  const bindSession = useCallback(
    (threadId: string, sessionId: string, startedAt: string) => {
      activeRunsByThreadRef.current = {
        ...activeRunsByThreadRef.current,
        [threadId]: {
          threadId,
          sessionId,
          startedAt
        }
      };
      runStore.bindSession(threadId, sessionId, startedAt);
    },
    [runStore]
  );

  const finishSessionBinding = useCallback(
    (sessionId: string): string | null => {
      const removedThreadId =
        Object.entries(activeRunsByThreadRef.current).find(([, run]) => run.sessionId === sessionId)?.[0] ?? null;
      if (removedThreadId) {
        const next = { ...activeRunsByThreadRef.current };
        delete next[removedThreadId];
        activeRunsByThreadRef.current = next;
      }
      const removedFromStore = runStore.finishSession(sessionId);
      return removedThreadId ?? removedFromStore;
    },
    [runStore]
  );

  useEffect(() => {
    lastTerminalLogByThreadRef.current = lastTerminalLogByThread;
  }, [lastTerminalLogByThread]);

  useEffect(() => {
    draftAttachmentsByThreadRef.current = draftAttachmentsByThread;
  }, [draftAttachmentsByThread]);

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

  const setAttachmentDraftForThread = useCallback((threadId: string, paths: string[]) => {
    setDraftAttachmentsByThread((current) => {
      const next = { ...current };
      if (paths.length === 0) {
        if (!(threadId in next)) {
          return current;
        }
        delete next[threadId];
        return next;
      }
      const existing = current[threadId] ?? [];
      if (existing.length === paths.length && existing.every((item, index) => item === paths[index])) {
        return current;
      }
      next[threadId] = paths;
      return next;
    });
  }, []);

  const addAttachmentDraftPaths = useCallback(
    (threadId: string, rawPaths: string[]) => {
      const incoming = normalizeAttachmentPaths(rawPaths);
      if (incoming.length === 0) {
        return 0;
      }
      const existing = draftAttachmentsByThreadRef.current[threadId] ?? [];
      const merged = mergeAttachmentPaths(existing, incoming);
      setAttachmentDraftForThread(threadId, merged);
      return merged.length - existing.length;
    },
    [setAttachmentDraftForThread]
  );

  const clearAttachmentDraftForThread = useCallback(
    (threadId: string) => {
      setAttachmentDraftForThread(threadId, []);
    },
    [setAttachmentDraftForThread]
  );

  const removeAttachmentDraftPath = useCallback(
    (threadId: string, path: string) => {
      const existing = draftAttachmentsByThreadRef.current[threadId] ?? [];
      if (existing.length === 0) {
        return;
      }
      const next = existing.filter((item) => item !== path);
      setAttachmentDraftForThread(threadId, next);
    },
    [setAttachmentDraftForThread]
  );

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

  const resetTerminalLog = useCallback((threadId: string) => {
    setLastTerminalLogByThread((current) => {
      if ((current[threadId] ?? '') === '') {
        return current;
      }
      return {
        ...current,
        [threadId]: ''
      };
    });
  }, []);

  const hasCachedTerminalLog = useCallback((threadId: string) => {
    return (lastTerminalLogByThreadRef.current[threadId] ?? '').length > 0;
  }, []);

  const hydrateSessionSnapshot = useCallback(
    async (threadId: string, sessionId: string, retries = 12, delayMs = 180) => {
      pendingSnapshotBySessionRef.current[sessionId] = true;
      delete sawLiveDuringSnapshotBySessionRef.current[sessionId];
      let attempts = 0;
      while (attempts < retries) {
        const liveSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
        if (!liveSessionId || liveSessionId !== sessionId) {
          delete pendingSnapshotBySessionRef.current[sessionId];
          delete sawLiveDuringSnapshotBySessionRef.current[sessionId];
          return;
        }

        const snapshot = await api.terminalReadOutput(sessionId).catch(() => '');
        if (snapshot && snapshot.length > 0) {
          let settledSnapshot = snapshot;
          let stableReads = 0;
          for (let settleAttempt = 0; settleAttempt < 6; settleAttempt += 1) {
            const stillLiveSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
            if (!stillLiveSessionId || stillLiveSessionId !== sessionId) {
              break;
            }
            await new Promise<void>((resolve) => {
              window.setTimeout(() => resolve(), 90);
            });
            const candidate = await api.terminalReadOutput(sessionId).catch(() => '');
            if (candidate && candidate.length > 0 && candidate !== settledSnapshot) {
              if (candidate.length >= settledSnapshot.length || candidate.includes(settledSnapshot)) {
                settledSnapshot = candidate;
                stableReads = 0;
                continue;
              }
            }
            stableReads += 1;
            if (stableReads >= 2 && settleAttempt >= 1) {
              break;
            }
          }

          const sawLiveDuringSnapshot = Boolean(sawLiveDuringSnapshotBySessionRef.current[sessionId]);
          delete sawLiveDuringSnapshotBySessionRef.current[sessionId];
          if (!sawLiveDuringSnapshot) {
            setLastTerminalLogByThread((current) => ({
              ...current,
              [threadId]: clampTerminalLog(settledSnapshot)
            }));
          }
          setStartingByThread((current) => removeThreadFlag(current, threadId));
          setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
          delete pendingSnapshotBySessionRef.current[sessionId];
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

      delete sawLiveDuringSnapshotBySessionRef.current[sessionId];
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
      delete pendingSnapshotBySessionRef.current[sessionId];
    },
    []
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

      const existing = activeRunsByThreadRef.current[thread.id]?.sessionId ?? null;
      if (existing) {
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        if (hasCachedTerminalLog(thread.id)) {
          setReadyByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
        } else {
          setReadyByThread((current) => removeThreadFlag(current, thread.id));
          if (!pendingSnapshotBySessionRef.current[existing]) {
            void hydrateSessionSnapshot(thread.id, existing, 8, 150);
          }
        }
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
        resetTerminalLog(thread.id);

        const startedAt = new Date().toISOString();
        bindSession(thread.id, sessionId, startedAt);
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
      bindSession,
      bumpSessionStartRequestId,
      flushPendingThreadInput,
      hasCachedTerminalLog,
      hydrateSessionSnapshot,
      resetTerminalLog,
      terminalSize.cols,
      terminalSize.rows,
      workspaces
    ]
  );

  const addAttachmentPathsForSelectedThread = useCallback(
    (rawPaths: string[]) => {
      if (!selectedThread) {
        return 0;
      }
      return addAttachmentDraftPaths(selectedThread.id, rawPaths);
    },
    [addAttachmentDraftPaths, selectedThread]
  );

  const queueAttachmentPathsForSelectedThread = useCallback(
    (rawPaths: string[], showMissingThreadToast = true) => {
      if (!selectedThread) {
        if (showMissingThreadToast) {
          pushToast('Select a thread before adding attachments.', 'error');
        }
        return 0;
      }
      const added = addAttachmentPathsForSelectedThread(rawPaths);
      if (added > 0) {
        pushToast(`Queued ${added} attachment${added === 1 ? '' : 's'} for next Enter submit.`, 'info');
      }
      return added;
    },
    [addAttachmentPathsForSelectedThread, pushToast, selectedThread]
  );

  const pickAttachmentFiles = useCallback(async () => {
    if (!selectedThread) {
      pushToast('Select a thread before adding attachments.', 'error');
      return;
    }

    try {
      const picked = await open({
        title: 'Add attachments',
        directory: false,
        multiple: true,
        defaultPath: selectedWorkspace?.path
      });

      if (!picked) {
        return;
      }

      queueAttachmentPathsForSelectedThread((Array.isArray(picked) ? picked : [picked]).filter(Boolean), false);
    } catch (error) {
      pushToast(`Attach failed: ${String(error)}`, 'error');
    }
  }, [pushToast, queueAttachmentPathsForSelectedThread, selectedThread, selectedWorkspace?.path]);

  const addAttachmentPathsFromDrop = useCallback(
    (paths: string[]) => {
      return queueAttachmentPathsForSelectedThread(paths) > 0;
    },
    [queueAttachmentPathsForSelectedThread]
  );

  const removeSelectedThreadAttachmentPath = useCallback(
    (path: string) => {
      if (!selectedThread) {
        return;
      }
      removeAttachmentDraftPath(selectedThread.id, path);
    },
    [removeAttachmentDraftPath, selectedThread]
  );

  const clearSelectedThreadAttachmentDraft = useCallback(() => {
    if (!selectedThread) {
      return;
    }
    clearAttachmentDraftForThread(selectedThread.id);
  }, [clearAttachmentDraftForThread, selectedThread]);

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
      const existingSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? runStore.sessionForThread(threadId);
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
        finishSessionBinding(existingSessionId);
        delete sessionMetaBySessionIdRef.current[existingSessionId];
        delete pendingSnapshotBySessionRef.current[existingSessionId];
        delete sawLiveDuringSnapshotBySessionRef.current[existingSessionId];
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
      finishSessionBinding,
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
      const sessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? runStore.sessionForThread(threadId);
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
      finishSessionBinding(sessionId);
      const endedAt = new Date().toISOString();
      setThreadRunState(threadId, 'Canceled', null, endedAt);
      delete sessionMetaBySessionIdRef.current[sessionId];
      delete pendingSnapshotBySessionRef.current[sessionId];
      delete sawLiveDuringSnapshotBySessionRef.current[sessionId];
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));
    },
    [finishSessionBinding, invalidatePendingSessionStart, runStore, setThreadRunState]
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
    if (!selectedWorkspaceId || !selectedThreadId || selectedSessionId) {
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
  }, [selectedSessionId, selectedThreadId, selectedWorkspaceId]);

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

        const isSelectedThread = selectedThreadIdRef.current === threadId;
        if (isSelectedThread) {
          setStartingByThread((current) => removeThreadFlag(current, threadId));
          setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
        }
        if (pendingSnapshotBySessionRef.current[event.sessionId]) {
          sawLiveDuringSnapshotBySessionRef.current[event.sessionId] = true;
        }
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
    const existingSessionId = activeRunsByThreadRef.current[selectedThread.id]?.sessionId ?? null;
    if (existingSessionId) {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      if (hasCachedTerminalLog(selectedThread.id)) {
        setReadyByThread((current) =>
          current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
        );
      } else {
        setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));
        if (!pendingSnapshotBySessionRef.current[existingSessionId]) {
          void hydrateSessionSnapshot(selectedThread.id, existingSessionId, 3, 100);
        }
      }
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
  }, [
    ensureSessionForThread,
    hasCachedTerminalLog,
    hydrateSessionSnapshot,
    pushToast,
    selectedThread,
  ]);

  useEffect(() => {
    let unlistenExit: (() => void) | null = null;

    const setup = async () => {
      unlistenExit = await onTerminalExit((event: TerminalExitEvent) => {
        const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
        delete sessionMetaBySessionIdRef.current[event.sessionId];
        delete pendingSnapshotBySessionRef.current[event.sessionId];
        delete sawLiveDuringSnapshotBySessionRef.current[event.sessionId];

        const endedThreadId = finishSessionBinding(event.sessionId);
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
  }, [finishSessionBinding, refreshThreadsForWorkspace, setThreadRunState, threadsByWorkspace]);

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
          selectedThread={selectedThread}
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

                let outboundData = data;
                if (submittedLines.length > 0) {
                  const attachmentDraft = draftAttachmentsByThreadRef.current[selectedThread.id] ?? [];
                  if (attachmentDraft.length > 0) {
                    outboundData = `${buildAttachmentPrompt(attachmentDraft)}\r${data}`;
                    clearAttachmentDraftForThread(selectedThread.id);
                  }
                }

                if (isSelectedThreadStarting || !selectedSessionId) {
                  return;
                }

                const sessionId = runStore.sessionForThread(selectedThread.id);
                if (sessionId) {
                  void api.terminalWrite(sessionId, outboundData);
                  return;
                }

                pendingInputByThreadRef.current[selectedThread.id] = `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${outboundData}`;
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
          attachmentDraftPaths={selectedThreadDraftAttachments}
          attachmentsEnabled={Boolean(selectedThread)}
          fullAccessUpdating={fullAccessUpdating}
          gitInfo={gitInfo}
          onPickAttachments={pickAttachmentFiles}
          onAddAttachmentPaths={addAttachmentPathsFromDrop}
          onRemoveAttachmentPath={removeSelectedThreadAttachmentPath}
          onClearAttachmentPaths={clearSelectedThreadAttachmentDraft}
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

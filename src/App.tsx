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

import { confirm, open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AddWorkspaceModal } from './components/AddWorkspaceModal';
import { BottomBar } from './components/BottomBar';
import { HeaderBar } from './components/HeaderBar';
import { LeftRail } from './components/LeftRail';
import { SettingsModal } from './components/SettingsModal';
import { TerminalPanel } from './components/TerminalPanel';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { api, onTerminalData, onTerminalExit, onThreadUpdated } from './lib/api';
import { clampTerminalLog as clampTerminalLogText } from './lib/terminalLogClamp';
import {
  createRunLifecycleState,
  isStreamingStuck,
  markRunExited,
  markRunReady,
  markRunStreaming,
  noteRunOutput,
  type TerminalRunLifecycleState
} from './lib/terminalRunLifecycle';
import {
  appendBufferedLive,
  findSuffixPrefixOverlap,
  mergeSnapshotAndBufferedLive,
  type PendingSnapshotHydration
} from './lib/terminalHydration';
import { useRunStore } from './stores/runStore';
import { useThreadStore } from './stores/threadStore';
import type {
  AppUpdateInfo,
  GitBranchEntry,
  GitInfo,
  GitWorkspaceStatus,
  RunStatus,
  Settings,
  TerminalDataEvent,
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
const SNAPSHOT_BUFFER_MAX_CHARS = TERMINAL_LOG_BUFFER_CHARS;
const TERMINAL_LOG_FLUSH_INTERVAL_MS = 16;
const TERMINAL_DATA_LISTENER_READY_TIMEOUT_MS = 800;
const SESSION_SNAPSHOT_REFRESH_DELAYS_MS = [320, 1100];
const CLAUDE_IN_PLACE_RESTART_DELAY_MS = 120;
const RDEV_SHELL_PROMPT_POLL_INTERVAL_MS = 120;
const RDEV_SHELL_PROMPT_MAX_POLLS = 12;
const AUTO_RECOVER_SESSION_TIMEOUT_MS = 900;
const AUTO_RECOVER_RETRY_COOLDOWN_MS = 1200;
const THREAD_WORKING_IDLE_TIMEOUT_MS = 1200;
const THREAD_WORKING_STUCK_TIMEOUT_MS = 15_000;
const MAX_ATTACHMENT_DRAFTS = 24;
const MAX_ATTACHMENTS_PER_MESSAGE = 12;
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
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

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buildClaudeInPlaceRestartCommand(sessionId: string, fullAccess: boolean): string {
  const parts = [
    'exec',
    'env',
    'TERM=xterm-256color',
    'COLORTERM=truecolor',
    'CLICOLOR=1',
    'CLICOLOR_FORCE=1',
    'FORCE_COLOR=1',
    'NO_COLOR=',
    'claude',
    '--resume',
    `'${sessionId}'`
  ];
  if (fullAccess) {
    parts.push('--dangerously-skip-permissions');
  }
  return parts.join(' ');
}

function hasShellPromptInSnapshot(snapshot: string): boolean {
  if (!snapshot) {
    return false;
  }

  const lines = snapshot
    .replace(/\r/g, '\n')
    .split('\n')
    .slice(-12)
    .map((line) =>
      stripAnsi(line)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .trimEnd()
    )
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    if (
      lower.includes('claude code') ||
      lower.includes('for shortcuts') ||
      lower.includes('bypass permissions') ||
      lower.includes('starting ssh connection') ||
      lower.includes('uploading gh auth token')
    ) {
      continue;
    }
    if (/[#$%>]$/.test(line)) {
      return true;
    }
  }

  return false;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function isDefaultThreadTitle(title: string): boolean {
  return title.trim().toLowerCase() === 'new thread';
}

function isRemoteWorkspaceKind(kind: Workspace['kind']): boolean {
  return kind === 'rdev' || kind === 'ssh';
}

function normalizeTerminalInputChunk(data: string): string {
  return data;
}

interface StripControlSequencesResult {
  text: string;
  carry: string;
}

function consumeCsiSequence(input: string, startIndex: number): number | null {
  let index = startIndex;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
    index += 1;
  }
  return null;
}

function consumeStringControlSequence(input: string, startIndex: number): number | null {
  let index = startIndex;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) {
      return index + 1;
    }
    if (code === 0x1b) {
      if (index + 1 >= input.length) {
        return null;
      }
      if (input.charCodeAt(index + 1) === 0x5c) {
        return index + 2;
      }
    }
    index += 1;
  }
  return null;
}

function consumeEscapeSequence(input: string, startIndex: number): number | null {
  const escIndex = startIndex;
  if (escIndex + 1 >= input.length) {
    return null;
  }

  const code = input.charCodeAt(escIndex + 1);
  if (code === 0x5b) {
    return consumeCsiSequence(input, escIndex + 2);
  }

  // OSC, DCS, SOS, PM, APC
  if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return consumeStringControlSequence(input, escIndex + 2);
  }

  // ESC Fe / ESC Fs / ESC Fp forms.
  if (code >= 0x20 && code <= 0x2f) {
    let index = escIndex + 2;
    while (index < input.length) {
      const current = input.charCodeAt(index);
      if (current >= 0x30 && current <= 0x7e) {
        return index + 1;
      }
      index += 1;
    }
    return null;
  }

  return escIndex + 2;
}

function stripTerminalControlSequences(chunk: string, previousCarry: string): StripControlSequencesResult {
  const source = `${previousCarry}${chunk}`;
  if (!source) {
    return { text: '', carry: '' };
  }

  let output = '';
  let index = 0;

  while (index < source.length) {
    const code = source.charCodeAt(index);

    if (code === 0x1b) {
      const next = consumeEscapeSequence(source, index);
      if (next === null) {
        return { text: output, carry: source.slice(index) };
      }
      index = next;
      continue;
    }

    // C1 CSI
    if (code === 0x9b) {
      const next = consumeCsiSequence(source, index + 1);
      if (next === null) {
        return { text: output, carry: source.slice(index) };
      }
      index = next;
      continue;
    }

    // C1 DCS / SOS / OSC / PM / APC
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      const next = consumeStringControlSequence(source, index + 1);
      if (next === null) {
        return { text: output, carry: source.slice(index) };
      }
      index = next;
      continue;
    }

    output += source[index];
    index += 1;
  }

  return { text: output, carry: '' };
}

function extractSubmittedInputLines(
  previousBuffer: string,
  previousControlCarry: string,
  chunk: string
): { nextBuffer: string; nextControlCarry: string; submittedLines: string[] } {
  const normalizedChunk = normalizeTerminalInputChunk(chunk);
  const { text: normalized, carry } = stripTerminalControlSequences(normalizedChunk, previousControlCarry);
  if (!normalized) {
    return { nextBuffer: previousBuffer, nextControlCarry: carry, submittedLines: [] };
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

  return { nextBuffer: buffer, nextControlCarry: carry, submittedLines };
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
  return clampTerminalLogText(text, TERMINAL_LOG_BUFFER_CHARS);
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  if (element.closest('.thread-rename-input') !== null) {
    return true;
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'button' || type === 'checkbox' || type === 'file' || type === 'radio' || type === 'reset' || type === 'submit') {
      return false;
    }
    return true;
  }

  return element.getAttribute('role') === 'textbox';
}

function shouldIgnoreGlobalTerminalShortcutTarget(target: EventTarget | null): boolean {
  if (target instanceof Element && isEditableElement(target)) {
    return true;
  }

  if (typeof document !== 'undefined' && isEditableElement(document.activeElement)) {
    return true;
  }

  return false;
}

function hasMeaningfulTerminalOutputChunk(chunk: string): boolean {
  if (!chunk) {
    return false;
  }
  const visibleText = stripAnsi(chunk).replace(/[\r\n\t\b\f\v]/g, '');
  return visibleText.trim().length > 0;
}

function normalizeMeaningfulOutputText(chunk: string): string {
  if (!chunk) {
    return '';
  }
  const visibleText = stripAnsi(chunk)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return visibleText;
}

function mergeTerminalLogSnapshot(existing: string, incoming: string): string {
  if (!incoming) {
    return existing;
  }
  if (!existing || existing === incoming) {
    return incoming;
  }
  if (incoming.startsWith(existing) || incoming.includes(existing)) {
    return incoming;
  }
  if (existing.startsWith(incoming) || existing.includes(incoming)) {
    return existing;
  }

  const overlap = findSuffixPrefixOverlap(existing, incoming);
  if (overlap > 0) {
    return `${existing}${incoming.slice(overlap)}`;
  }

  return existing;
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

function isTerminalSessionUnavailableError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('terminal session not found') ||
    message.includes('session not found') ||
    message.includes('no such process') ||
    message.includes('broken pipe')
  );
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
}

function reorderWorkspacesByIds(currentWorkspaces: Workspace[], workspaceIds: string[]): Workspace[] {
  if (currentWorkspaces.length <= 1 || workspaceIds.length === 0) {
    return currentWorkspaces;
  }

  const remaining = [...currentWorkspaces];
  const ordered: Workspace[] = [];
  for (const workspaceId of workspaceIds) {
    const index = remaining.findIndex((workspace) => workspace.id === workspaceId);
    if (index < 0) {
      continue;
    }
    ordered.push(remaining[index]);
    remaining.splice(index, 1);
  }

  if (ordered.length === 0) {
    return currentWorkspaces;
  }
  return [...ordered, ...remaining];
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
  const [unreadOutputByThread, setUnreadOutputByThread] = useState<Record<string, boolean>>({});
  const [draftAttachmentsByThread, setDraftAttachmentsByThread] = useState<Record<string, string[]>>({});

  const [settings, setSettings] = useState<Settings>({ claudeCliPath: null });
  const [detectedCliPath, setDetectedCliPath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blockingError, setBlockingError] = useState<string | null>(null);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);

  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceMode, setAddWorkspaceMode] = useState<'local' | 'rdev' | 'ssh'>('local');
  const [addWorkspacePath, setAddWorkspacePath] = useState('');
  const [addWorkspaceRdevCommand, setAddWorkspaceRdevCommand] = useState('');
  const [addWorkspaceSshCommand, setAddWorkspaceSshCommand] = useState('');
  const [addWorkspaceDisplayName, setAddWorkspaceDisplayName] = useState('');
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [appUpdateInfo, setAppUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
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
  const workingByThreadRef = useRef(runStore.workingByThread);
  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startingSessionByThreadRef = useRef<Record<string, PendingSessionStart>>({});
  const sessionStartRequestIdByThreadRef = useRef<Record<string, number>>({});
  const threadsByWorkspaceRef = useRef<Record<string, ThreadMetadata[]>>({});
  const lastTerminalLogByThreadRef = useRef<Record<string, string>>({});
  const workingStopTimerByThreadRef = useRef<Record<string, number>>({});
  const pendingTerminalChunksByThreadRef = useRef<Record<string, string>>({});
  const terminalLogFlushHandleRef = useRef<number | null>(null);
  const terminalLogFlushUsesAnimationFrameRef = useRef(false);
  const draftAttachmentsByThreadRef = useRef<Record<string, string[]>>({});
  const inputBufferByThreadRef = useRef<Record<string, string>>({});
  const inputControlCarryByThreadRef = useRef<Record<string, string>>({});
  const outputControlCarryByThreadRef = useRef<Record<string, string>>({});
  const threadTitleInitializedRef = useRef<Record<string, true>>({});
  const deletedThreadIdsRef = useRef<Record<string, true>>({});
  const pendingInputByThreadRef = useRef<Record<string, string>>({});
  const escapeSignalRef = useRef<{ sessionId: string; at: number } | null>(null);
  const pendingSnapshotBySessionRef = useRef<Record<string, PendingSnapshotHydration>>({});
  const terminalSnapshotRefreshTimersBySessionRef = useRef<Record<string, number[]>>({});
  const liveDataSeenBySessionRef = useRef<Record<string, true>>({});
  const terminalDataSequenceBySessionRef = useRef<Record<string, number>>({});
  const terminalDataListenerReadyRef = useRef(false);
  const terminalDataListenerReadyResolverRef = useRef<(() => void) | null>(null);
  const terminalDataListenerReadyPromiseRef = useRef<Promise<void> | null>(null);
  const latestOutputSequenceByThreadRef = useRef<Record<string, number>>({});
  const seenOutputSequenceByThreadRef = useRef<Record<string, number>>({});
  const lastMeaningfulOutputByThreadRef = useRef<Record<string, string>>({});
  const runLifecycleByThreadRef = useRef<Record<string, TerminalRunLifecycleState>>({});
  const outputSequenceCounterRef = useRef(0);
  const terminalDataEventHandlerRef = useRef<(event: TerminalDataEvent) => void>(() => undefined);
  const terminalExitEventHandlerRef = useRef<(event: TerminalExitEvent) => void>(() => undefined);
  const threadUpdatedEventHandlerRef = useRef<(thread: ThreadMetadata) => void>(() => undefined);
  const autoRecoverInFlightRef = useRef(false);
  const lastAutoRecoverAttemptAtRef = useRef(0);
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

  if (!terminalDataListenerReadyPromiseRef.current) {
    terminalDataListenerReadyPromiseRef.current = new Promise<void>((resolve) => {
      terminalDataListenerReadyResolverRef.current = resolve;
    });
  }

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

  const resolveTerminalDataListenerReady = useCallback(() => {
    if (terminalDataListenerReadyRef.current) {
      return;
    }
    terminalDataListenerReadyRef.current = true;
    terminalDataListenerReadyResolverRef.current?.();
    terminalDataListenerReadyResolverRef.current = null;
  }, []);

  const waitForTerminalDataListenerReady = useCallback(async () => {
    if (terminalDataListenerReadyRef.current) {
      return;
    }
    if (!terminalDataListenerReadyPromiseRef.current) {
      return;
    }
    await withTimeout(terminalDataListenerReadyPromiseRef.current, TERMINAL_DATA_LISTENER_READY_TIMEOUT_MS);
  }, []);

  selectedWorkspaceIdRef.current = selectedWorkspaceId;
  selectedThreadIdRef.current = selectedThreadId;
  activeRunsByThreadRef.current = runStore.activeRunsByThread;
  workingByThreadRef.current = runStore.workingByThread;

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
      delete lastMeaningfulOutputByThreadRef.current[threadId];
      delete outputControlCarryByThreadRef.current[threadId];
      delete liveDataSeenBySessionRef.current[sessionId];
      runLifecycleByThreadRef.current[threadId] = createRunLifecycleState();
    },
    [runStore]
  );

  const startThreadWorking = useCallback(
    (threadId: string, startedAt = new Date().toISOString()) => {
      workingByThreadRef.current = {
        ...workingByThreadRef.current,
        [threadId]: { startedAt }
      };
      runStore.startWorking(threadId, startedAt);
      const startedAtMs = Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : Date.now();
      runLifecycleByThreadRef.current[threadId] = markRunStreaming(
        runLifecycleByThreadRef.current[threadId],
        startedAtMs
      );
    },
    [runStore]
  );

  const stopThreadWorking = useCallback(
    (threadId: string) => {
      if (workingByThreadRef.current[threadId]) {
        const next = { ...workingByThreadRef.current };
        delete next[threadId];
        workingByThreadRef.current = next;
      }
      runStore.stopWorking(threadId);
      const lifecycle = runLifecycleByThreadRef.current[threadId];
      if (lifecycle?.phase === 'streaming') {
        runLifecycleByThreadRef.current[threadId] = markRunReady(lifecycle);
      }
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
      const removed = removedThreadId ?? removedFromStore;
      if (removed && workingByThreadRef.current[removed]) {
        const nextWorking = { ...workingByThreadRef.current };
        delete nextWorking[removed];
        workingByThreadRef.current = nextWorking;
      }
      return removed;
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

  const refreshAppUpdateInfo = useCallback(async () => {
    try {
      const updateInfo = await api.checkForUpdate();
      setAppUpdateInfo(updateInfo);
    } catch {
      setAppUpdateInfo(null);
    }
  }, []);

  useEffect(() => {
    void refreshAppUpdateInfo();
    const handle = window.setInterval(() => {
      void refreshAppUpdateInfo();
    }, 10 * 60 * 1000);
    return () => {
      window.clearInterval(handle);
    };
  }, [refreshAppUpdateInfo]);

  const updateTerminalLogMap = useCallback(
    (updater: (current: Record<string, string>) => Record<string, string>): Record<string, string> => {
      const current = lastTerminalLogByThreadRef.current;
      const next = updater(current);
      if (next === current) {
        return current;
      }
      lastTerminalLogByThreadRef.current = next;
      setLastTerminalLogByThread(next);
      return next;
    },
    []
  );

  const flushPendingTerminalLogChunks = useCallback(() => {
    const pendingByThread = pendingTerminalChunksByThreadRef.current;
    const entries = Object.entries(pendingByThread);
    if (entries.length === 0) {
      return;
    }

    pendingTerminalChunksByThreadRef.current = {};
    updateTerminalLogMap((current) => {
      let next = current;
      for (const [threadId, chunk] of entries) {
        if (!chunk) {
          continue;
        }
        const previous = next[threadId] ?? '';
        const combined = `${previous}${chunk}`;
        const clamped = clampTerminalLog(combined);
        if (clamped === previous) {
          continue;
        }
        if (next === current) {
          next = { ...current };
        }
        next[threadId] = clamped;
      }
      return next;
    });
  }, [updateTerminalLogMap]);

  const cancelScheduledTerminalLogFlush = useCallback(() => {
    const handle = terminalLogFlushHandleRef.current;
    if (handle === null) {
      return;
    }
    terminalLogFlushHandleRef.current = null;
    if (terminalLogFlushUsesAnimationFrameRef.current && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(handle);
      return;
    }
    window.clearTimeout(handle);
  }, []);

  const clearThreadWorkingStopTimer = useCallback((threadId: string) => {
    const handle = workingStopTimerByThreadRef.current[threadId];
    if (typeof handle === 'number') {
      window.clearTimeout(handle);
    }
    delete workingStopTimerByThreadRef.current[threadId];
  }, []);

  const clearAllThreadWorkingStopTimers = useCallback(() => {
    for (const handle of Object.values(workingStopTimerByThreadRef.current)) {
      window.clearTimeout(handle);
    }
    workingStopTimerByThreadRef.current = {};
  }, []);

  const clearSessionSnapshotRefreshTimers = useCallback((sessionId: string) => {
    const handles = terminalSnapshotRefreshTimersBySessionRef.current[sessionId];
    if (!handles || handles.length === 0) {
      return;
    }
    for (const handle of handles) {
      window.clearTimeout(handle);
    }
    delete terminalSnapshotRefreshTimersBySessionRef.current[sessionId];
  }, []);

  const noteThreadOutput = useCallback((threadId: string, chunk: string) => {
    const previousCarry = outputControlCarryByThreadRef.current[threadId] ?? '';
    const stripped = stripTerminalControlSequences(chunk, previousCarry);
    outputControlCarryByThreadRef.current[threadId] = stripped.carry;
    const normalized = normalizeMeaningfulOutputText(stripped.text);
    if (!normalized) {
      return false;
    }

    // Terminal UIs often repaint identical content using cursor movement; don't
    // treat duplicate redraw chunks as fresh unread output.
    const looksLikeRedrawChunk = chunk.includes('\r') || chunk.includes('\u001b') || chunk.includes('\u009b');
    if (looksLikeRedrawChunk && lastMeaningfulOutputByThreadRef.current[threadId] === normalized) {
      return false;
    }

    lastMeaningfulOutputByThreadRef.current[threadId] = normalized;
    outputSequenceCounterRef.current += 1;
    latestOutputSequenceByThreadRef.current[threadId] = outputSequenceCounterRef.current;
    return true;
  }, []);

  const markThreadOutputSeen = useCallback((threadId: string) => {
    seenOutputSequenceByThreadRef.current[threadId] = latestOutputSequenceByThreadRef.current[threadId] ?? 0;
  }, []);

  const hasUnseenThreadOutput = useCallback((threadId: string) => {
    const latest = latestOutputSequenceByThreadRef.current[threadId] ?? 0;
    const seen = seenOutputSequenceByThreadRef.current[threadId] ?? 0;
    return latest > seen;
  }, []);

  const clearThreadUnread = useCallback((threadId: string) => {
    markThreadOutputSeen(threadId);
    setUnreadOutputByThread((current) => removeThreadFlag(current, threadId));
  }, [markThreadOutputSeen]);

  const markThreadUnread = useCallback((threadId: string) => {
    setUnreadOutputByThread((current) => {
      if (!hasUnseenThreadOutput(threadId)) {
        return current;
      }
      if (current[threadId]) {
        return current;
      }
      return {
        ...current,
        [threadId]: true
      };
    });
  }, [hasUnseenThreadOutput]);

  const scheduleThreadWorkingStop = useCallback(
    (threadId: string, delayMs = THREAD_WORKING_IDLE_TIMEOUT_MS) => {
      clearThreadWorkingStopTimer(threadId);
      workingStopTimerByThreadRef.current[threadId] = window.setTimeout(() => {
        delete workingStopTimerByThreadRef.current[threadId];
        stopThreadWorking(threadId);
        if (selectedThreadIdRef.current !== threadId) {
          markThreadUnread(threadId);
        }
      }, delayMs);
    },
    [clearThreadWorkingStopTimer, markThreadUnread, stopThreadWorking]
  );

  const scheduleTerminalLogFlush = useCallback(() => {
    if (terminalLogFlushHandleRef.current !== null) {
      return;
    }
    if (typeof window.requestAnimationFrame === 'function') {
      terminalLogFlushUsesAnimationFrameRef.current = true;
      terminalLogFlushHandleRef.current = window.requestAnimationFrame(() => {
        terminalLogFlushHandleRef.current = null;
        flushPendingTerminalLogChunks();
      });
      return;
    }
    terminalLogFlushUsesAnimationFrameRef.current = false;
    terminalLogFlushHandleRef.current = window.setTimeout(() => {
      terminalLogFlushHandleRef.current = null;
      flushPendingTerminalLogChunks();
    }, TERMINAL_LOG_FLUSH_INTERVAL_MS);
  }, [flushPendingTerminalLogChunks]);

  useEffect(() => {
    return () => {
      cancelScheduledTerminalLogFlush();
      clearAllThreadWorkingStopTimers();
      pendingTerminalChunksByThreadRef.current = {};
      outputControlCarryByThreadRef.current = {};
      for (const handles of Object.values(terminalSnapshotRefreshTimersBySessionRef.current)) {
        for (const handle of handles) {
          window.clearTimeout(handle);
        }
      }
      terminalSnapshotRefreshTimersBySessionRef.current = {};
      liveDataSeenBySessionRef.current = {};
      runLifecycleByThreadRef.current = {};
    };
  }, [cancelScheduledTerminalLogFlush, clearAllThreadWorkingStopTimers]);

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
    if (!selectedWorkspace || selectedWorkspace.kind !== 'local') {
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
    const pending = pendingTerminalChunksByThreadRef.current[threadId] ?? '';
    const combined = `${pending}${chunk}`;
    pendingTerminalChunksByThreadRef.current[threadId] =
      combined.length <= TERMINAL_LOG_BUFFER_CHARS
        ? combined
        : combined.slice(combined.length - TERMINAL_LOG_BUFFER_CHARS);
    scheduleTerminalLogFlush();
  }, [scheduleTerminalLogFlush]);

  const resetTerminalLog = useCallback((threadId: string) => {
    delete pendingTerminalChunksByThreadRef.current[threadId];
    updateTerminalLogMap((current) => {
      if ((current[threadId] ?? '') === '') {
        return current;
      }
      return {
        ...current,
        [threadId]: ''
      };
    });
  }, [updateTerminalLogMap]);

  const hasCachedTerminalLog = useCallback((threadId: string) => {
    return (
      (lastTerminalLogByThreadRef.current[threadId] ?? '').length > 0 ||
      (pendingTerminalChunksByThreadRef.current[threadId] ?? '').length > 0
    );
  }, []);

  const scheduleSessionSnapshotRefreshes = useCallback(
    (threadId: string, sessionId: string) => {
      clearSessionSnapshotRefreshTimers(sessionId);
      const handles: number[] = [];

      for (const delayMs of SESSION_SNAPSHOT_REFRESH_DELAYS_MS) {
        const handle = window.setTimeout(() => {
          void (async () => {
            if (activeRunsByThreadRef.current[threadId]?.sessionId !== sessionId) {
              return;
            }
            if (selectedThreadIdRef.current !== threadId) {
              return;
            }
            if (liveDataSeenBySessionRef.current[sessionId]) {
              return;
            }

            const snapshot = await api.terminalReadOutput(sessionId).catch(() => '');
            if (!snapshot) {
              return;
            }

            updateTerminalLogMap((current) => {
              const existing = current[threadId] ?? '';
              const merged = clampTerminalLog(mergeTerminalLogSnapshot(existing, snapshot));
              if (merged === existing) {
                return current;
              }
              return {
                ...current,
                [threadId]: merged
              };
            });
          })().finally(() => {
            const currentHandles = terminalSnapshotRefreshTimersBySessionRef.current[sessionId] ?? [];
            const remaining = currentHandles.filter((value) => value !== handle);
            if (remaining.length === 0) {
              delete terminalSnapshotRefreshTimersBySessionRef.current[sessionId];
            } else {
              terminalSnapshotRefreshTimersBySessionRef.current[sessionId] = remaining;
            }
          });
        }, delayMs);
        handles.push(handle);
      }

      terminalSnapshotRefreshTimersBySessionRef.current[sessionId] = handles;
    },
    [clearSessionSnapshotRefreshTimers, updateTerminalLogMap]
  );

  const hydrateSessionSnapshot = useCallback(
    async (threadId: string, sessionId: string, retries = 12, delayMs = 180) => {
      pendingSnapshotBySessionRef.current[sessionId] = {
        threadId,
        bufferedLive: ''
      };
      const isHydrationPending = () => pendingSnapshotBySessionRef.current[sessionId]?.threadId === threadId;
      let attempts = 0;
      while (attempts < retries) {
        if (!isHydrationPending()) {
          return;
        }
        const liveSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
        if (!liveSessionId || liveSessionId !== sessionId) {
          delete pendingSnapshotBySessionRef.current[sessionId];
          return;
        }

        const snapshot = await api.terminalReadOutput(sessionId).catch(() => '');
        if (!isHydrationPending()) {
          return;
        }
        if (snapshot && snapshot.length > 0) {
          let settledSnapshot = snapshot;
          let stableReads = 0;
          for (let settleAttempt = 0; settleAttempt < 6; settleAttempt += 1) {
            if (!isHydrationPending()) {
              return;
            }
            const stillLiveSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
            if (!stillLiveSessionId || stillLiveSessionId !== sessionId) {
              break;
            }
            await new Promise<void>((resolve) => {
              window.setTimeout(() => resolve(), 90);
            });
            if (!isHydrationPending()) {
              return;
            }
            const candidate = await api.terminalReadOutput(sessionId).catch(() => '');
            if (!isHydrationPending()) {
              return;
            }
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

          const pendingHydration = pendingSnapshotBySessionRef.current[sessionId];
          if (!pendingHydration || pendingHydration.threadId !== threadId) {
            return;
          }
          const bufferedLive = pendingHydration.bufferedLive;
          const mergedSnapshot = clampTerminalLog(mergeSnapshotAndBufferedLive(settledSnapshot, bufferedLive));
          delete pendingSnapshotBySessionRef.current[sessionId];
          delete pendingTerminalChunksByThreadRef.current[threadId];
          updateTerminalLogMap((current) => {
            const existing = current[threadId] ?? '';
            const merged = clampTerminalLog(mergeTerminalLogSnapshot(existing, mergedSnapshot));
            if (merged === existing) {
              return current;
            }
            return {
              ...current,
              [threadId]: merged
            };
          });
          runLifecycleByThreadRef.current[threadId] = markRunReady(runLifecycleByThreadRef.current[threadId]);
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

      const pendingHydration = pendingSnapshotBySessionRef.current[sessionId];
      if (!pendingHydration || pendingHydration.threadId !== threadId) {
        return;
      }
      const bufferedLive = pendingHydration.bufferedLive;
      delete pendingSnapshotBySessionRef.current[sessionId];
      if (bufferedLive.length > 0) {
        delete pendingTerminalChunksByThreadRef.current[threadId];
        updateTerminalLogMap((current) => {
          const existing = current[threadId] ?? '';
          const bufferedMerge = mergeSnapshotAndBufferedLive(existing, bufferedLive);
          const merged = clampTerminalLog(mergeTerminalLogSnapshot(existing, bufferedMerge));
          if (merged === existing) {
            return current;
          }
          return {
            ...current,
            [threadId]: merged
          };
        });
      }
      runLifecycleByThreadRef.current[threadId] = markRunReady(runLifecycleByThreadRef.current[threadId]);
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
    },
    [updateTerminalLogMap]
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
        if (!runLifecycleByThreadRef.current[thread.id]) {
          runLifecycleByThreadRef.current[thread.id] = createRunLifecycleState();
        }
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        if (hasCachedTerminalLog(thread.id)) {
          runLifecycleByThreadRef.current[thread.id] = markRunReady(runLifecycleByThreadRef.current[thread.id]);
          setReadyByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
        } else {
          setReadyByThread((current) => removeThreadFlag(current, thread.id));
          if (!pendingSnapshotBySessionRef.current[existing]) {
            void hydrateSessionSnapshot(thread.id, existing, 8, 150);
          }
        }
        if (selectedThreadIdRef.current === thread.id) {
          scheduleSessionSnapshotRefreshes(thread.id, existing);
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
        await waitForTerminalDataListenerReady();
        const response = await api.terminalStartSession({
          workspacePath: workspace.path,
          initialCwd: workspace.kind === 'local' ? workspace.path : null,
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
        if (selectedThreadIdRef.current === thread.id) {
          scheduleSessionSnapshotRefreshes(thread.id, sessionId);
        }
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
      scheduleSessionSnapshotRefreshes,
      resetTerminalLog,
      terminalSize.cols,
      terminalSize.rows,
      waitForTerminalDataListenerReady,
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

  const attemptAutoRecoverSelectedThread = useCallback(async () => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const threadId = selectedThreadIdRef.current;
    if (!workspaceId || !threadId) {
      return;
    }
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !isRemoteWorkspaceKind(workspace.kind)) {
      return;
    }

    if (autoRecoverInFlightRef.current) {
      return;
    }
    const now = Date.now();
    if (now - lastAutoRecoverAttemptAtRef.current < AUTO_RECOVER_RETRY_COOLDOWN_MS) {
      return;
    }
    lastAutoRecoverAttemptAtRef.current = now;

    const thread = (threadsByWorkspaceRef.current[workspaceId] ?? []).find((item) => item.id === threadId);
    if (!thread || deletedThreadIdsRef.current[thread.id] || startingSessionByThreadRef.current[thread.id]) {
      return;
    }

    autoRecoverInFlightRef.current = true;
    let sessionId = activeRunsByThreadRef.current[thread.id]?.sessionId ?? null;
    try {
      if (!sessionId) {
        if (selectedThreadIdRef.current === thread.id) {
          await ensureSessionForThread(thread);
        }
        return;
      }

      const hasCachedLog = hasCachedTerminalLog(thread.id);
      const snapshot = await withTimeout(api.terminalReadOutput(sessionId), AUTO_RECOVER_SESSION_TIMEOUT_MS);
      if (typeof snapshot === 'string') {
        if (snapshot.length > 0 && !hasCachedLog) {
          delete pendingTerminalChunksByThreadRef.current[thread.id];
          updateTerminalLogMap((current) => {
            const existing = current[thread.id] ?? '';
            const clamped = clampTerminalLog(snapshot);
            if (clamped === existing) {
              return current;
            }
            return {
              ...current,
              [thread.id]: clamped
            };
          });
        }
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        if (snapshot.length > 0 || hasCachedLog) {
          setReadyByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
        }
        if (!pendingSnapshotBySessionRef.current[sessionId] && (!hasCachedLog || snapshot.length === 0)) {
          void hydrateSessionSnapshot(thread.id, sessionId, 3, 120);
        }
      }
      return;
    } catch (error) {
      if (!sessionId || !isTerminalSessionUnavailableError(error)) {
        return;
      }

      finishSessionBinding(sessionId);
      delete sessionMetaBySessionIdRef.current[sessionId];
      delete pendingSnapshotBySessionRef.current[sessionId];
      delete terminalDataSequenceBySessionRef.current[sessionId];
      delete liveDataSeenBySessionRef.current[sessionId];
      clearSessionSnapshotRefreshTimers(sessionId);
      setStartingByThread((current) => removeThreadFlag(current, thread.id));
      setReadyByThread((current) => removeThreadFlag(current, thread.id));

      if (selectedThreadIdRef.current !== thread.id) {
        return;
      }

      try {
        await ensureSessionForThread(thread);
      } catch (startError) {
        pushToast(`Failed to recover terminal session: ${String(startError)}`, 'error');
      }
    } finally {
      autoRecoverInFlightRef.current = false;
    }
  }, [
    clearSessionSnapshotRefreshTimers,
    ensureSessionForThread,
    finishSessionBinding,
    hasCachedTerminalLog,
    hydrateSessionSnapshot,
    pushToast,
    updateTerminalLogMap,
    workspaces
  ]);

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

  const addRdevWorkspaceByCommand = useCallback(
    async (rdevSshCommand: string, displayName: string) => {
      const command = rdevSshCommand.trim();
      if (!command) {
        throw new Error('Please enter an rdev ssh command.');
      }

      const workspace = await api.addRdevWorkspace(command, displayName.trim() || null);
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

  const addSshWorkspaceByCommand = useCallback(
    async (sshCommand: string, displayName: string) => {
      const command = sshCommand.trim();
      if (!command) {
        throw new Error('Please enter an ssh command.');
      }

      const workspace = await api.addSshWorkspace(command, displayName.trim() || null);
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

  const openWorkspacePicker = useCallback(() => {
    setAddWorkspaceMode('local');
    setAddWorkspacePath('');
    setAddWorkspaceRdevCommand('');
    setAddWorkspaceSshCommand('');
    setAddWorkspaceDisplayName('');
    setAddWorkspaceError(null);
    setAddWorkspaceOpen(true);
  }, []);

  const pickWorkspaceDirectory = useCallback(async () => {
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

      setAddWorkspacePath(path);
    } catch (error) {
      const message = `Add workspace failed: ${String(error)}`;
      pushToast(message, 'error');
      setAddWorkspaceError(message);
      setAddWorkspaceOpen(true);
    }
  }, [pushToast]);

  const confirmManualWorkspace = useCallback(
    async (path: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspaceMode('local');
      setAddWorkspacePath(path);
      setAddWorkspaceSshCommand('');
      try {
        await addWorkspaceByPath(path);
        setAddWorkspaceOpen(false);
        setAddWorkspacePath('');
        setAddWorkspaceSshCommand('');
        setAddWorkspaceError(null);
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

  const confirmRdevWorkspace = useCallback(
    async (rdevSshCommand: string, displayName: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspaceMode('rdev');
      setAddWorkspaceRdevCommand(rdevSshCommand);
      setAddWorkspaceSshCommand('');
      setAddWorkspaceDisplayName(displayName);
      try {
        await addRdevWorkspaceByCommand(rdevSshCommand, displayName);
        setAddWorkspaceOpen(false);
        setAddWorkspaceRdevCommand('');
        setAddWorkspaceSshCommand('');
        setAddWorkspaceDisplayName('');
        setAddWorkspaceError(null);
      } catch (error) {
        const message = String(error);
        setAddWorkspaceError(message);
        pushToast(message, 'error');
      } finally {
        setAddingWorkspace(false);
      }
    },
    [addRdevWorkspaceByCommand, pushToast]
  );

  const confirmSshWorkspace = useCallback(
    async (sshCommand: string, displayName: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspaceMode('ssh');
      setAddWorkspaceRdevCommand('');
      setAddWorkspaceSshCommand(sshCommand);
      setAddWorkspaceDisplayName(displayName);
      try {
        await addSshWorkspaceByCommand(sshCommand, displayName);
        setAddWorkspaceOpen(false);
        setAddWorkspaceRdevCommand('');
        setAddWorkspaceSshCommand('');
        setAddWorkspaceDisplayName('');
        setAddWorkspaceError(null);
      } catch (error) {
        const message = String(error);
        setAddWorkspaceError(message);
        pushToast(message, 'error');
      } finally {
        setAddingWorkspace(false);
      }
    },
    [addSshWorkspaceByCommand, pushToast]
  );

  const onNewThreadInWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace?.kind === 'local' && workspace.gitPullOnMasterForNewThreads) {
        try {
          const pullResult = await api.gitPullMasterForNewThread(workspace.path);
          if (pullResult.outcome === 'pulled') {
            pushToast(pullResult.message, 'info');
            if (selectedWorkspaceIdRef.current === workspaceId) {
              await refreshGitInfo();
            }
          } else {
            pushToast(pullResult.message, 'error');
          }
        } catch (error) {
          pushToast(`Git pull pre-step failed: ${String(error)}`, 'error');
        }
      }

      if (selectedWorkspaceIdRef.current !== workspaceId) {
        setSelectedWorkspace(workspaceId);
      }
      const thread = await createThread(workspaceId);
      markThreadUserInput(workspaceId, thread.id);
      delete deletedThreadIdsRef.current[thread.id];
      setSelectedThread(thread.id);
      setTerminalFocusRequestId((current) => current + 1);
      await refreshThreadsForWorkspace(workspaceId);
    },
    [
      createThread,
      markThreadUserInput,
      pushToast,
      refreshGitInfo,
      refreshThreadsForWorkspace,
      setSelectedThread,
      setSelectedWorkspace,
      workspaces
    ]
  );

  const onSetWorkspaceGitPullOnMasterForNewThreads = useCallback(
    async (workspaceId: string, enabled: boolean) => {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId
            ? {
                ...workspace,
                gitPullOnMasterForNewThreads: enabled,
                updatedAt: new Date().toISOString()
              }
            : workspace
        )
      );
      try {
        const updatedWorkspace = await api.setWorkspaceGitPullOnMasterForNewThreads(workspaceId, enabled);
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updatedWorkspace.id ? updatedWorkspace : workspace))
        );
      } catch (error) {
        pushToast(`Workspace setting update failed: ${String(error)}`, 'error');
        await refreshWorkspaces();
      }
    },
    [pushToast, refreshWorkspaces]
  );

  const onReorderWorkspaces = useCallback(
    async (workspaceIds: string[]) => {
      setWorkspaces((current) => reorderWorkspacesByIds(current, workspaceIds));
      try {
        const reordered = await api.setWorkspaceOrder(workspaceIds);
        setWorkspaces(reordered);
      } catch (error) {
        pushToast(`Workspace reorder failed: ${String(error)}`, 'error');
        await refreshWorkspaces();
      }
    },
    [pushToast, refreshWorkspaces]
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
      clearThreadWorkingStopTimer(threadId);
      stopThreadWorking(threadId);
      clearThreadUnread(threadId);
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
      delete pendingTerminalChunksByThreadRef.current[threadId];
      delete outputControlCarryByThreadRef.current[threadId];
      delete latestOutputSequenceByThreadRef.current[threadId];
      delete seenOutputSequenceByThreadRef.current[threadId];
      delete runLifecycleByThreadRef.current[threadId];
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
      clearThreadUnread,
      clearThreadWorkingStopTimer,
      stopThreadWorking,
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
          delete pendingTerminalChunksByThreadRef.current[threadId];
          updateTerminalLogMap((current) => ({
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
      clearThreadWorkingStopTimer(threadId);
      stopThreadWorking(threadId);
      delete sessionMetaBySessionIdRef.current[sessionId];
      delete pendingSnapshotBySessionRef.current[sessionId];
      delete terminalDataSequenceBySessionRef.current[sessionId];
      clearSessionSnapshotRefreshTimers(sessionId);
      runLifecycleByThreadRef.current[threadId] = markRunExited();
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));
    },
    [
      finishSessionBinding,
      invalidatePendingSessionStart,
      runStore,
      setThreadRunState,
      stopThreadWorking,
      updateTerminalLogMap,
      clearThreadWorkingStopTimer,
      clearSessionSnapshotRefreshTimers
    ]
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
      const previousThreadId = selectedThreadIdRef.current;
      if (previousThreadId && previousThreadId !== threadId) {
        clearThreadUnread(previousThreadId);
      }
      clearThreadUnread(threadId);
      if (selectedWorkspaceIdRef.current !== workspaceId) {
        setSelectedWorkspace(workspaceId);
      }
      setSelectedThread(threadId);
      setTerminalFocusRequestId((current) => current + 1);
    },
    [clearThreadUnread, setSelectedThread, setSelectedWorkspace]
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
    if (!selectedWorkspace || !gitInfo || selectedWorkspace.kind !== 'local') {
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
      if (!selectedWorkspace || selectedWorkspace.kind !== 'local') {
        return false;
      }

      await stopSessionsForBranchSwitch();

      try {
        await api.gitCheckoutBranch(selectedWorkspace.path, branchName);
        await refreshGitInfo();
        if (selectedThread?.workspaceId === selectedWorkspace.id) {
          const snapshot = await api.terminalGetLastLog(selectedWorkspace.id, selectedThread.id).catch(() => '');
          if (snapshot) {
            delete pendingTerminalChunksByThreadRef.current[selectedThread.id];
            updateTerminalLogMap((current) => ({
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
    [pushToast, refreshGitInfo, selectedThread, selectedWorkspace, stopSessionsForBranchSwitch, updateTerminalLogMap]
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
    if (!selectedThreadId) {
      return;
    }
    clearThreadUnread(selectedThreadId);
  }, [clearThreadUnread, selectedThreadId]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || selectedSessionId) {
      return;
    }
    if (startingByThread[selectedThreadId] || startingSessionByThreadRef.current[selectedThreadId]) {
      return;
    }
    let cancelled = false;
    void api
      .terminalGetLastLog(selectedWorkspaceId, selectedThreadId)
      .then((log) => {
        if (cancelled) {
          return;
        }
        if (
          activeRunsByThreadRef.current[selectedThreadId]?.sessionId ||
          startingSessionByThreadRef.current[selectedThreadId]
        ) {
          return;
        }
        delete pendingTerminalChunksByThreadRef.current[selectedThreadId];
        updateTerminalLogMap((current) => ({
          ...current,
          [selectedThreadId]: clampTerminalLog(log)
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        if (
          activeRunsByThreadRef.current[selectedThreadId]?.sessionId ||
          startingSessionByThreadRef.current[selectedThreadId]
        ) {
          return;
        }
        delete pendingTerminalChunksByThreadRef.current[selectedThreadId];
        updateTerminalLogMap((current) => ({
          ...current,
          [selectedThreadId]: ''
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, selectedThreadId, selectedWorkspaceId, startingByThread, updateTerminalLogMap]);

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
    if (!selectedWorkspace || !isRemoteWorkspaceKind(selectedWorkspace.kind)) {
      return;
    }

    const recover = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void attemptAutoRecoverSelectedThread();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      recover();
    };

    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [attemptAutoRecoverSelectedThread, selectedWorkspace]);

  const handleTerminalDataEvent = useCallback(
    (event: TerminalDataEvent) => {
      if (typeof event.sequence === 'number') {
        const latestSeen = terminalDataSequenceBySessionRef.current[event.sessionId] ?? 0;
        if (event.sequence <= latestSeen) {
          return;
        }
        terminalDataSequenceBySessionRef.current[event.sessionId] = event.sequence;
      }
      if (!liveDataSeenBySessionRef.current[event.sessionId]) {
        liveDataSeenBySessionRef.current[event.sessionId] = true;
        clearSessionSnapshotRefreshTimers(event.sessionId);
      }

      const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
      const threadId =
        event.threadId ??
        sessionMeta?.threadId ??
        Object.entries(activeRunsByThreadRef.current).find(([, run]) => run.sessionId === event.sessionId)?.[0];
      if (!threadId) {
        return;
      }

      const hasMeaningfulOutput = noteThreadOutput(threadId, event.data);
      const isSelectedThread = selectedThreadIdRef.current === threadId;
      const nowMs = Date.now();
      runLifecycleByThreadRef.current[threadId] = noteRunOutput(
        runLifecycleByThreadRef.current[threadId],
        hasMeaningfulOutput,
        nowMs
      );

      const maybeResolveStuckStreaming = () => {
        if (!workingByThreadRef.current[threadId]) {
          return;
        }
        if (!isStreamingStuck(runLifecycleByThreadRef.current[threadId], nowMs, THREAD_WORKING_STUCK_TIMEOUT_MS)) {
          return;
        }
        clearThreadWorkingStopTimer(threadId);
        stopThreadWorking(threadId);
      };

      const pendingHydration = pendingSnapshotBySessionRef.current[event.sessionId];
      if (pendingHydration && pendingHydration.threadId === threadId) {
        pendingHydration.bufferedLive = appendBufferedLive(
          pendingHydration.bufferedLive,
          event.data,
          SNAPSHOT_BUFFER_MAX_CHARS
        );
        appendTerminalLogChunk(threadId, event.data);
        if (isSelectedThread) {
          setStartingByThread((current) => removeThreadFlag(current, threadId));
          setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
          clearThreadUnread(threadId);
        }
        if (workingByThreadRef.current[threadId]) {
          if (hasMeaningfulOutput) {
            scheduleThreadWorkingStop(threadId, THREAD_WORKING_IDLE_TIMEOUT_MS);
          } else {
            maybeResolveStuckStreaming();
          }
        } else if (!isSelectedThread && hasMeaningfulOutput) {
          markThreadUnread(threadId);
        } else {
          clearThreadUnread(threadId);
        }
        return;
      }

      if (isSelectedThread) {
        setStartingByThread((current) => removeThreadFlag(current, threadId));
        setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
        clearThreadUnread(threadId);
      }
      if (workingByThreadRef.current[threadId]) {
        if (hasMeaningfulOutput) {
          scheduleThreadWorkingStop(threadId, THREAD_WORKING_IDLE_TIMEOUT_MS);
        } else {
          maybeResolveStuckStreaming();
        }
      } else if (!isSelectedThread && hasMeaningfulOutput) {
        markThreadUnread(threadId);
      }
      appendTerminalLogChunk(threadId, event.data);
    },
    [
      appendTerminalLogChunk,
      clearSessionSnapshotRefreshTimers,
      clearThreadWorkingStopTimer,
      clearThreadUnread,
      markThreadUnread,
      noteThreadOutput,
      stopThreadWorking,
      scheduleThreadWorkingStop
    ]
  );

  const handleTerminalExitEvent = useCallback(
    (event: TerminalExitEvent) => {
      const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
      delete sessionMetaBySessionIdRef.current[event.sessionId];
      delete pendingSnapshotBySessionRef.current[event.sessionId];
      delete terminalDataSequenceBySessionRef.current[event.sessionId];
      delete liveDataSeenBySessionRef.current[event.sessionId];
      clearSessionSnapshotRefreshTimers(event.sessionId);

      const endedThreadId = finishSessionBinding(event.sessionId);
      if (!endedThreadId) {
        return;
      }
      runLifecycleByThreadRef.current[endedThreadId] = markRunExited();
      const exitStatus = statusFromExit(event);
      setStartingByThread((current) => removeThreadFlag(current, endedThreadId));
      setReadyByThread((current) => removeThreadFlag(current, endedThreadId));
      clearThreadWorkingStopTimer(endedThreadId);
      stopThreadWorking(endedThreadId);

      const endedAt = new Date().toISOString();
      setThreadRunState(endedThreadId, exitStatus, null, endedAt);
      if (exitStatus === 'Succeeded' && selectedThreadIdRef.current !== endedThreadId) {
        markThreadUnread(endedThreadId);
      }

      const workspaceId =
        sessionMeta?.workspaceId ??
        Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((thread) => thread.id === endedThreadId)?.workspaceId;
      if (workspaceId) {
        void refreshThreadsForWorkspace(workspaceId);
      }

      void api
        .terminalReadOutput(event.sessionId)
        .then((snapshot) => {
          delete pendingTerminalChunksByThreadRef.current[endedThreadId];
          updateTerminalLogMap((current) => ({
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
    },
    [
      finishSessionBinding,
      refreshThreadsForWorkspace,
      setThreadRunState,
      stopThreadWorking,
      updateTerminalLogMap,
      clearThreadWorkingStopTimer,
      clearSessionSnapshotRefreshTimers,
      markThreadUnread
    ]
  );

  const handleThreadUpdatedEvent = useCallback(
    (thread: ThreadMetadata) => {
      if (!thread || !thread.id || !thread.workspaceId) {
        return;
      }
      if (deletedThreadIdsRef.current[thread.id]) {
        return;
      }
      applyThreadUpdate(thread);
    },
    [applyThreadUpdate]
  );

  terminalDataEventHandlerRef.current = handleTerminalDataEvent;
  terminalExitEventHandlerRef.current = handleTerminalExitEvent;
  threadUpdatedEventHandlerRef.current = handleThreadUpdatedEvent;

  useEffect(() => {
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    terminalDataListenerReadyRef.current = false;

    void onTerminalData((event) => {
      terminalDataEventHandlerRef.current(event);
    })
      .then((off) => {
        if (cancelled) {
          off();
          resolveTerminalDataListenerReady();
          return;
        }
        unlistenData = off;
        resolveTerminalDataListenerReady();
      })
      .catch(() => {
        resolveTerminalDataListenerReady();
      });

    return () => {
      cancelled = true;
      unlistenData?.();
    };
  }, [resolveTerminalDataListenerReady]);

  useEffect(() => {
    let cancelled = false;
    let unlistenExit: (() => void) | null = null;

    void onTerminalExit((event: TerminalExitEvent) => {
      terminalExitEventHandlerRef.current(event);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenExit = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenExit?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenThreadUpdate: (() => void) | null = null;

    void onThreadUpdated((thread) => {
      threadUpdatedEventHandlerRef.current(thread);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenThreadUpdate = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenThreadUpdate?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalTerminalShortcutTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (terminalFocused && event.ctrlKey && !event.metaKey && !event.altKey && key === 'c' && selectedSessionId) {
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
    if (selectedWorkspace.kind !== 'local') {
      pushToast('Diagnostics are only available for local workspaces.', 'info');
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

  const waitForRdevShellPrompt = useCallback(async (sessionId: string) => {
    for (let attempt = 0; attempt < RDEV_SHELL_PROMPT_MAX_POLLS; attempt += 1) {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), RDEV_SHELL_PROMPT_POLL_INTERVAL_MS);
      });
      const snapshot = await api.terminalReadOutput(sessionId).catch(() => '');
      if (hasShellPromptInSnapshot(snapshot)) {
        return true;
      }
    }
    return false;
  }, []);

  const restartRdevClaudeInPlace = useCallback(
    async (thread: ThreadMetadata) => {
      const sessionId =
        activeRunsByThreadRef.current[thread.id]?.sessionId ?? runStore.sessionForThread(thread.id) ?? null;
      const resumeSessionId = thread.claudeSessionId?.trim() ?? '';
      if (!sessionId || !isUuidLike(resumeSessionId)) {
        return false;
      }

      const command = buildClaudeInPlaceRestartCommand(resumeSessionId, thread.fullAccess);

      await api.terminalSendSignal(sessionId, 'SIGINT').catch(() => undefined);
      let ready = await waitForRdevShellPrompt(sessionId);
      if (!ready) {
        await api.terminalWrite(sessionId, '/exit\r').catch(() => false);
        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), CLAUDE_IN_PLACE_RESTART_DELAY_MS);
        });
        ready = await waitForRdevShellPrompt(sessionId);
      }
      if (!ready) {
        return false;
      }

      const wrote = await api.terminalWrite(sessionId, `${command}\r`).catch(() => false);
      return wrote;
    },
    [runStore, waitForRdevShellPrompt]
  );

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
      const workspace = workspaces.find((item) => item.id === updatedThread.workspaceId);
      if (workspace && isRemoteWorkspaceKind(workspace.kind)) {
        const switchedInPlace = await restartRdevClaudeInPlace(updatedThread);
        if (switchedInPlace) {
          if (selectedWorkspaceIdRef.current !== updatedThread.workspaceId) {
            setSelectedWorkspace(updatedThread.workspaceId);
          }
          setSelectedThread(updatedThread.id);
          pushToast(`Full access ${nextValue ? 'enabled' : 'disabled'} in-place.`, 'info');
          return;
        }
        pushToast('Could not switch in-place for remote workspace; reconnecting session.', 'info');
      }
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
    stopThreadSession,
    workspaces,
    restartRdevClaudeInPlace
  ]);

  const openWorkspaceInFinder = useCallback(
    (workspace: Workspace) => {
      if (isRemoteWorkspaceKind(workspace.kind)) {
        pushToast('Remote workspaces do not map to a local Finder folder.', 'info');
        return;
      }
      void api.openInFinder(workspace.path);
    },
    [pushToast]
  );

  const openWorkspaceInTerminal = useCallback(
    (workspace: Workspace) => {
      if (isRemoteWorkspaceKind(workspace.kind)) {
        const command =
          workspace.kind === 'rdev' ? workspace.rdevSshCommand?.trim() : workspace.sshCommand?.trim();
        if (!command) {
          pushToast('Missing remote shell command for this workspace.', 'error');
          return;
        }
        void api.openTerminalCommand(command);
        return;
      }
      void api.openInTerminal(workspace.path);
    },
    [pushToast]
  );

  const installLatestUpdate = useCallback(async () => {
    if (installingUpdate) {
      return;
    }

    setInstallingUpdate(true);
    pushToast('Downloading and installing the latest Claude Desk release…', 'info');
    try {
      await api.installLatestUpdate();
    } catch (error) {
      pushToast(`Update failed: ${String(error)}`, 'error');
    } finally {
      setInstallingUpdate(false);
    }
  }, [installingUpdate, pushToast]);

  const onRemoveWorkspace = useCallback(
    async (workspace: Workspace) => {
      const detail =
        isRemoteWorkspaceKind(workspace.kind)
          ? 'This removes its saved threads in Claude Desk.'
          : 'This keeps your local folder intact but removes its saved threads in Claude Desk.';
      const message = `Remove "${workspace.name}" from Claude Desk?\n\n${detail}`;
      const confirmed = await confirm(message, {
        title: 'Claude Desk',
        kind: 'warning',
        okLabel: 'OK',
        cancelLabel: 'Cancel'
      }).catch(() => window.confirm(message));
      if (!confirmed) {
        return;
      }

      const workspaceThreads = threadsByWorkspaceRef.current[workspace.id] ?? [];
      const threadIds = workspaceThreads.map((thread) => thread.id);

      for (const threadId of threadIds) {
        invalidatePendingSessionStart(threadId);
        clearThreadWorkingStopTimer(threadId);
        stopThreadWorking(threadId);
      }
      await stopSessionsForWorkspace(workspace.id);

      const removed = await api.removeWorkspace(workspace.id);
      if (!removed) {
        pushToast(`Project "${workspace.name}" was already removed.`, 'info');
        await refreshWorkspaces();
        return;
      }

      window.localStorage.removeItem(threadSelectionKey(workspace.id));
      for (const threadId of threadIds) {
        delete inputBufferByThreadRef.current[threadId];
        delete inputControlCarryByThreadRef.current[threadId];
        delete threadTitleInitializedRef.current[threadId];
        delete pendingTerminalChunksByThreadRef.current[threadId];
        delete outputControlCarryByThreadRef.current[threadId];
        delete latestOutputSequenceByThreadRef.current[threadId];
        delete seenOutputSequenceByThreadRef.current[threadId];
        delete runLifecycleByThreadRef.current[threadId];
      }
      updateTerminalLogMap((current) => {
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
      setUnreadOutputByThread((current) => {
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
    [
      invalidatePendingSessionStart,
      pushToast,
      refreshWorkspaces,
      clearThreadWorkingStopTimer,
      setSelectedThread,
      stopThreadWorking,
      stopSessionsForWorkspace,
      updateTerminalLogMap
    ]
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
        onSetWorkspaceGitPullOnMasterForNewThreads={onSetWorkspaceGitPullOnMasterForNewThreads}
        onReorderWorkspaces={onReorderWorkspaces}
        onRemoveWorkspace={onRemoveWorkspace}
        threadLastUserInputAt={threadLastUserInputAt}
        isThreadWorking={runStore.isThreadWorking}
        hasUnreadThreadOutput={(threadId) =>
          Boolean(unreadOutputByThread[threadId]) && hasUnseenThreadOutput(threadId)
        }
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
          updateAvailable={Boolean(appUpdateInfo?.updateAvailable)}
          updateVersionLabel={appUpdateInfo?.latestVersion ?? undefined}
          updating={installingUpdate}
          onInstallUpdate={installLatestUpdate}
          onOpenWorkspace={() => {
            if (selectedWorkspace) {
              openWorkspaceInFinder(selectedWorkspace);
            }
          }}
          onOpenTerminal={() => {
            if (selectedWorkspace) {
              openWorkspaceInTerminal(selectedWorkspace);
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
              contentLimitChars={TERMINAL_LOG_BUFFER_CHARS}
              readOnly={false}
              inputEnabled={Boolean(selectedSessionId) && isSelectedThreadReady && !isSelectedThreadStarting}
              overlayMessage={isSelectedThreadStarting || !selectedSessionId ? 'Starting Claude session...' : undefined}
              focusRequestId={terminalFocusRequestId}
              onData={(data) => {
                if (!selectedThread) {
                  return;
                }

                const parsed = extractSubmittedInputLines(
                  inputBufferByThreadRef.current[selectedThread.id] ?? '',
                  inputControlCarryByThreadRef.current[selectedThread.id] ?? '',
                  data
                );
                inputBufferByThreadRef.current[selectedThread.id] = parsed.nextBuffer;
                inputControlCarryByThreadRef.current[selectedThread.id] = parsed.nextControlCarry;
                const submittedLines = parsed.submittedLines;

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
                  clearThreadUnread(selectedThread.id);
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
                  if (submittedLines.length > 0) {
                    pendingInputByThreadRef.current[selectedThread.id] = `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${outboundData}`;
                    void ensureSessionForThread(selectedThread);
                  }
                  return;
                }

                const sessionId = runStore.sessionForThread(selectedThread.id);
                if (sessionId) {
                  if (submittedLines.length > 0) {
                    clearThreadWorkingStopTimer(selectedThread.id);
                    startThreadWorking(selectedThread.id);
                    scheduleThreadWorkingStop(selectedThread.id, THREAD_WORKING_STUCK_TIMEOUT_MS);
                  }
                  void api.terminalWrite(sessionId, outboundData);
                  return;
                }

                if (submittedLines.length > 0) {
                  pendingInputByThreadRef.current[selectedThread.id] = `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${outboundData}`;
                  void ensureSessionForThread(selectedThread);
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
        initialMode={addWorkspaceMode}
        initialPath={addWorkspacePath}
        initialRdevCommand={addWorkspaceRdevCommand}
        initialSshCommand={addWorkspaceSshCommand}
        initialDisplayName={addWorkspaceDisplayName}
        error={addWorkspaceError}
        saving={addingWorkspace}
        onClose={() => {
          setAddWorkspaceOpen(false);
          setAddWorkspaceError(null);
          setAddWorkspaceSshCommand('');
        }}
        onPickDirectory={() => void pickWorkspaceDirectory()}
        onConfirmLocal={(path) => void confirmManualWorkspace(path)}
        onConfirmRdev={(command, displayName) => void confirmRdevWorkspace(command, displayName)}
        onConfirmSsh={(command, displayName) => void confirmSshWorkspace(command, displayName)}
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

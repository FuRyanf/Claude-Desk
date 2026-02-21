import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AddWorkspaceModal } from './components/AddWorkspaceModal';
import { CommandPalette, type CommandPaletteItem } from './components/CommandPalette';
import { CommitModal } from './components/CommitModal';
import { Composer, type SlashPaletteItem } from './components/Composer';
import { FullAccessWarningModal } from './components/FullAccessWarningModal';
import { HeaderBar } from './components/HeaderBar';
import { LandingView } from './components/LandingView';
import { LeftRail } from './components/LeftRail';
import { SettingsModal } from './components/SettingsModal';
import { TerminalPanel } from './components/TerminalPanel';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { api, onTerminalExit } from './lib/api';
import type {
  ContextPack,
  GitDiffSummary,
  GitInfo,
  Settings,
  SkillInfo,
  TerminalExitEvent,
  ThreadMetadata,
  TranscriptEntry,
  Workspace
} from './types';

const FULL_ACCESS_WARNING_KEY = 'claude-desk-full-access-warning-seen';

function sortThreads(threads: ThreadMetadata[]): ThreadMetadata[] {
  return [...threads].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function upsertThread(map: Record<string, ThreadMetadata[]>, thread: ThreadMetadata) {
  const existing = map[thread.workspaceId] ?? [];
  const filtered = existing.filter((item) => item.id !== thread.id);
  return {
    ...map,
    [thread.workspaceId]: sortThreads([thread, ...filtered])
  };
}

function resolveContextPack(value: string): ContextPack | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'minimal') {
    return 'Minimal';
  }
  if (normalized === 'git diff' || normalized === 'git-diff' || normalized === 'git_diff' || normalized === 'git') {
    return 'Git Diff';
  }
  if (normalized === 'debug') {
    return 'Debug';
  }
  return null;
}

function todayId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeComposerInput(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

interface TerminalStartResult {
  sessionId: string;
  startedNew: boolean;
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threadsByWorkspace, setThreadsByWorkspace] = useState<Record<string, ThreadMetadata[]>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [threadSearch, setThreadSearch] = useState('');

  const [skillsByWorkspace, setSkillsByWorkspace] = useState<Record<string, SkillInfo[]>>({});
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [composerText, setComposerText] = useState('');
  const [contextPack, setContextPack] = useState<ContextPack>('Minimal');
  const [status, setStatus] = useState<'Idle' | 'Running'>('Idle');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [threadSessions, setThreadSessions] = useState<Record<string, string>>({});
  const [sessionLive, setSessionLive] = useState<Record<string, boolean>>({});
  const [terminalFocused, setTerminalFocused] = useState(false);
  const [terminalSize, setTerminalSize] = useState({ cols: 120, rows: 32 });
  const [lastTerminalLogByThread, setLastTerminalLogByThread] = useState<Record<string, string>>({});

  const [commitOpen, setCommitOpen] = useState(false);
  const [commitSummary, setCommitSummary] = useState<GitDiffSummary | null>(null);
  const [generatedCommitMessage, setGeneratedCommitMessage] = useState('');
  const [loadingCommitMessage, setLoadingCommitMessage] = useState(false);

  const [settings, setSettings] = useState<Settings>({ claudeCliPath: null });
  const [detectedCliPath, setDetectedCliPath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blockingError, setBlockingError] = useState<string | null>(null);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [fullAccessWarningOpen, setFullAccessWarningOpen] = useState(false);

  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspacePath, setAddWorkspacePath] = useState('');
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const sessionThreadMapRef = useRef<Record<string, string>>({});
  const threadSessionsRef = useRef<Record<string, string>>({});
  const sessionLiveRef = useRef<Record<string, boolean>>({});
  const activeRunIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const selectedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const refreshThreadsForWorkspaceRef = useRef<((workspaceId: string) => Promise<void>) | null>(null);
  const refreshTranscriptRef = useRef<(() => Promise<void>) | null>(null);
  const escapeSignalRef = useRef<{ sessionId: string; at: number } | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces]
  );

  const selectedThreads = useMemo(() => {
    if (!selectedWorkspaceId) {
      return [];
    }
    return sortThreads(threadsByWorkspace[selectedWorkspaceId] ?? []);
  }, [selectedWorkspaceId, threadsByWorkspace]);

  const filteredThreads = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    if (!query) {
      return selectedThreads;
    }
    return selectedThreads.filter((thread) => thread.title.toLowerCase().includes(query));
  }, [selectedThreads, threadSearch]);

  const selectedThread = useMemo(() => {
    if (!selectedThreadId) {
      return undefined;
    }
    return selectedThreads.find((thread) => thread.id === selectedThreadId);
  }, [selectedThreadId, selectedThreads]);

  const skills = useMemo(() => {
    if (!selectedWorkspace) {
      return [];
    }
    return skillsByWorkspace[selectedWorkspace.path] ?? [];
  }, [selectedWorkspace, skillsByWorkspace]);

  const enabledSkillInfos = useMemo(() => {
    const enabled = selectedThread?.enabledSkills ?? [];
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    return enabled.map((skillId) => {
      const resolved = byId.get(skillId);
      if (resolved) {
        return resolved;
      }
      return {
        id: skillId,
        name: skillId,
        description: 'Enabled skill not currently indexed in this workspace',
        entryPoints: [],
        path: ''
      } satisfies SkillInfo;
    });
  }, [selectedThread, skills]);

  const selectedSessionId = useMemo(() => {
    if (activeRunId) {
      return activeRunId;
    }
    if (selectedThreadId && threadSessions[selectedThreadId]) {
      return threadSessions[selectedThreadId];
    }
    return null;
  }, [activeRunId, selectedThreadId, threadSessions]);

  const selectedSessionLive = useMemo(() => {
    if (!selectedSessionId) {
      return false;
    }
    return sessionLive[selectedSessionId] ?? false;
  }, [selectedSessionId, sessionLive]);

  const selectedTerminalContent = useMemo(() => {
    if (selectedThreadId) {
      return lastTerminalLogByThread[selectedThreadId] ?? '';
    }
    return '';
  }, [lastTerminalLogByThread, selectedThreadId]);

  const removeToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, type: 'error' | 'info' = 'error') => {
      const id = todayId();
      setToasts((current) => [...current, { id, type, message }]);
      window.setTimeout(() => removeToast(id), 4500);
    },
    [removeToast]
  );

  useEffect(() => {
    threadSessionsRef.current = threadSessions;
  }, [threadSessions]);

  useEffect(() => {
    sessionLiveRef.current = sessionLive;
  }, [sessionLive]);

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);


  const refreshWorkspaces = useCallback(async () => {
    const all = await api.listWorkspaces();
    setWorkspaces(all);

    if (all.length === 0) {
      setSelectedWorkspaceId(undefined);
      setSelectedThreadId(undefined);
      return;
    }

    if (!selectedWorkspaceId || !all.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(all[0].id);
    }
  }, [selectedWorkspaceId]);

  const refreshThreadsForWorkspace = useCallback(
    async (workspaceId: string) => {
      const threads = await api.listThreads(workspaceId);
      setThreadsByWorkspace((current) => ({
        ...current,
        [workspaceId]: sortThreads(threads)
      }));

      if (workspaceId !== selectedWorkspaceId) {
        return;
      }

      if (!selectedThreadId && threads.length > 0) {
        setSelectedThreadId(threads[0].id);
        return;
      }

      if (selectedThreadId && !threads.some((thread) => thread.id === selectedThreadId)) {
        setSelectedThreadId(threads[0]?.id);
      }
    },
    [selectedThreadId, selectedWorkspaceId]
  );

  const refreshGitInfo = useCallback(async () => {
    if (!selectedWorkspace) {
      setGitInfo(null);
      return;
    }
    const next = await api.getGitInfo(selectedWorkspace.path);
    setGitInfo(next);
  }, [selectedWorkspace]);

  const loadSkillsForWorkspace = useCallback(
    async (workspacePath: string, force = false) => {
      if (!force && skillsByWorkspace[workspacePath]) {
        return;
      }

      const next = await api.listSkills(workspacePath);
      setSkillsByWorkspace((current) => ({
        ...current,
        [workspacePath]: next
      }));
    },
    [skillsByWorkspace]
  );

  const refreshTranscript = useCallback(async () => {
    if (!selectedWorkspaceId || !selectedThreadId) {
      setTranscript([]);
      return;
    }
    const entries = await api.loadTranscript(selectedWorkspaceId, selectedThreadId);
    setTranscript(entries);
  }, [selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    refreshThreadsForWorkspaceRef.current = refreshThreadsForWorkspace;
  }, [refreshThreadsForWorkspace]);

  useEffect(() => {
    refreshTranscriptRef.current = refreshTranscript;
  }, [refreshTranscript]);

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
      setTranscript([]);
      return;
    }

    void refreshThreadsForWorkspace(selectedWorkspaceId);
  }, [refreshThreadsForWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setGitInfo(null);
      return;
    }

    void refreshGitInfo();
    void loadSkillsForWorkspace(selectedWorkspace.path);
  }, [loadSkillsForWorkspace, refreshGitInfo, selectedWorkspace]);

  useEffect(() => {
    void refreshTranscript();
  }, [refreshTranscript]);

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
    if (!selectedThreadId || !selectedSessionId || !selectedSessionLive) {
      return;
    }

    void api
      .terminalReadOutput(selectedSessionId)
      .then((snapshot) => {
        setLastTerminalLogByThread((current) => ({
          ...current,
          [selectedThreadId]: snapshot
        }));
      })
      .catch(() => undefined);
  }, [selectedSessionId, selectedSessionLive, selectedThreadId]);

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }

    const id = window.setInterval(() => {
      void refreshGitInfo();
    }, 4000);

    return () => window.clearInterval(id);
  }, [refreshGitInfo, selectedWorkspace]);

  useEffect(() => {
    let unlistenExit: (() => void) | null = null;

    const setup = async () => {
      unlistenExit = await onTerminalExit((event: TerminalExitEvent) => {
        setSessionLive((current) => ({
          ...current,
          [event.sessionId]: false
        }));

        if (activeRunIdRef.current && event.sessionId === activeRunIdRef.current) {
          setStatus('Idle');
          setActiveRunId(null);
        }

        const threadId = sessionThreadMapRef.current[event.sessionId];
        if (threadId) {
          void api
            .terminalReadOutput(event.sessionId)
            .then((snapshot) => {
              setLastTerminalLogByThread((current) => ({
                ...current,
                [threadId]: snapshot
              }));
            })
            .catch(() => undefined);
        }

        if (selectedThreadIdRef.current && threadId === selectedThreadIdRef.current) {
          void refreshTranscriptRef.current?.();
        }
        if (selectedWorkspaceIdRef.current) {
          void refreshThreadsForWorkspaceRef.current?.(selectedWorkspaceIdRef.current);
        }
      });
    };

    void setup();

    return () => {
      unlistenExit?.();
    };
  }, []);

  const applyThreadUpdate = useCallback((thread: ThreadMetadata) => {
    setThreadsByWorkspace((current) => upsertThread(current, thread));
  }, []);

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
      setSelectedWorkspaceId(workspace.id);
      setSelectedThreadId(undefined);
      await refreshThreadsForWorkspace(workspace.id);
      await loadSkillsForWorkspace(workspace.path, true);
      const nextGit = await api.getGitInfo(workspace.path);
      setGitInfo(nextGit);
      return workspace;
    },
    [loadSkillsForWorkspace, refreshThreadsForWorkspace]
  );

  const openManualWorkspaceModal = useCallback(() => {
    setAddWorkspaceError(null);
    setAddWorkspaceOpen(true);
  }, []);

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

  const onSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
  }, []);

  const onNewThread = useCallback(async () => {
    if (!selectedWorkspaceId) {
      pushToast('Select a workspace first.', 'error');
      return;
    }

    try {
      const thread = await api.createThread(selectedWorkspaceId, 'claude-code');
      applyThreadUpdate(thread);
      setSelectedThreadId(thread.id);
      setTranscript([]);
    } catch (error) {
      pushToast(String(error), 'error');
    }
  }, [applyThreadUpdate, pushToast, selectedWorkspaceId]);

  const toggleSkill = useCallback(
    async (skillToken: string) => {
      if (!selectedThread || !selectedWorkspaceId) {
        pushToast('Create or select a thread before toggling skills.', 'error');
        return;
      }

      const matchedSkill = skills.find(
        (skill) => skill.name.toLowerCase() === skillToken.toLowerCase() || skill.id.toLowerCase() === skillToken.toLowerCase()
      );
      const skillId = matchedSkill?.id ?? skillToken;
      const enabled = new Set(selectedThread.enabledSkills);
      const toggledOn = !enabled.has(skillId);

      if (toggledOn) {
        enabled.add(skillId);
      } else {
        enabled.delete(skillId);
      }

      const updated = await api.setThreadSkills(selectedWorkspaceId, selectedThread.id, [...enabled]);
      applyThreadUpdate(updated);
      setTranscript((current) => [
        ...current,
        {
          id: `system-skill-${todayId()}`,
          role: 'system',
          content: `${toggledOn ? 'Enabled' : 'Disabled'} skill: ${skillId}`,
          createdAt: new Date().toISOString(),
          runId: null
        }
      ]);
    },
    [applyThreadUpdate, pushToast, selectedThread, selectedWorkspaceId, skills]
  );

  const toggleFullAccess = useCallback(async () => {
    if (!selectedWorkspaceId || !selectedThread) {
      return;
    }

    if (selectedThread.fullAccess) {
      const updated = await api.setThreadFullAccess(selectedWorkspaceId, selectedThread.id, false);
      applyThreadUpdate(updated);
      return;
    }

    const warningSeen = window.localStorage.getItem(FULL_ACCESS_WARNING_KEY) === 'true';
    if (!warningSeen) {
      setFullAccessWarningOpen(true);
      return;
    }

    const updated = await api.setThreadFullAccess(selectedWorkspaceId, selectedThread.id, true);
    applyThreadUpdate(updated);
  }, [applyThreadUpdate, selectedThread, selectedWorkspaceId]);

  const enableFullAccessAfterWarning = useCallback(async () => {
    if (!selectedWorkspaceId || !selectedThread) {
      return;
    }
    window.localStorage.setItem(FULL_ACCESS_WARNING_KEY, 'true');
    const updated = await api.setThreadFullAccess(selectedWorkspaceId, selectedThread.id, true);
    applyThreadUpdate(updated);
    setFullAccessWarningOpen(false);
  }, [applyThreadUpdate, selectedThread, selectedWorkspaceId]);

  const appendStatusMessage = useCallback(() => {
    const branch = gitInfo ? gitInfo.branch : 'N/A';
    const dirty = gitInfo ? (gitInfo.isDirty ? 'dirty' : 'clean') : 'N/A';
    const aheadBehind = gitInfo ? `ahead ${gitInfo.ahead}, behind ${gitInfo.behind}` : 'ahead 0, behind 0';
    const skillsLabel = selectedThread?.enabledSkills.length ? selectedThread.enabledSkills.join(', ') : 'none';
    const message = [
      `Workspace: ${selectedWorkspace?.name ?? 'none'}`,
      `Branch: ${branch}`,
      `Git state: ${dirty} (${aheadBehind})`,
      `Full Access: ${selectedThread?.fullAccess ? 'enabled' : 'disabled'}`,
      `Agent: ${selectedThread?.agentId ?? 'claude-code'}`,
      `Context pack: ${contextPack}`,
      `Enabled skills: ${skillsLabel}`
    ].join('\n');

    setTranscript((current) => [
      ...current,
      {
        id: `system-status-${todayId()}`,
        role: 'system',
        content: message,
        createdAt: new Date().toISOString(),
        runId: null
      }
    ]);
  }, [contextPack, gitInfo, selectedThread, selectedWorkspace]);

  const openCommitModal = useCallback(async () => {
    if (!selectedWorkspace) {
      return;
    }

    const summary = await api.getGitDiffSummary(selectedWorkspace.path);
    setCommitSummary(summary);
    setGeneratedCommitMessage('');
    setCommitOpen(true);
  }, [selectedWorkspace]);

  const onSlashCommand = useCallback(
    async (command: string) => {
      const normalized = command.trim();

      if (normalized === '/new' || normalized === '/new thread') {
        await onNewThread();
        return;
      }

      if (normalized === '/open') {
        if (selectedWorkspace) {
          await api.openInFinder(selectedWorkspace.path);
        }
        return;
      }

      if (normalized.startsWith('/context ')) {
        const requested = normalized.replace('/context ', '');
        const next = resolveContextPack(requested);
        if (!next) {
          pushToast('Unknown context pack. Use Minimal, Git Diff, or Debug.', 'error');
          return;
        }
        setContextPack(next);
        return;
      }

      if (normalized === '/status') {
        appendStatusMessage();
        return;
      }

      if (normalized === '/commit') {
        await openCommitModal();
        return;
      }

      if (normalized === '/help') {
        setTranscript((current) => [
          ...current,
          {
            id: `system-help-${todayId()}`,
            role: 'system',
            content:
              '/new\n/open\n/context <minimal|git diff|debug>\n/agent <id>\n/status\n/commit\n/skill <name>\n/help',
            createdAt: new Date().toISOString(),
            runId: null
          }
        ]);
        return;
      }

      if (normalized.startsWith('/agent ') || normalized.startsWith('/switch agent ')) {
        if (!selectedWorkspaceId || !selectedThread) {
          pushToast('Select a thread before changing agents.', 'error');
          return;
        }
        const agentId = normalized.includes('/switch agent ')
          ? normalized.replace('/switch agent ', '').trim()
          : normalized.replace('/agent ', '').trim();
        if (!agentId) {
          pushToast('Agent id is required.', 'error');
          return;
        }
        const updated = await api.setThreadAgent(selectedWorkspaceId, selectedThread.id, agentId);
        applyThreadUpdate(updated);
        return;
      }

      if (normalized.startsWith('/skill ')) {
        const skillToken = normalized.replace('/skill ', '').trim();
        if (!skillToken) {
          return;
        }
        await toggleSkill(skillToken);
        return;
      }

      if (normalized.startsWith('/toggle skill ')) {
        const skillToken = normalized.replace('/toggle skill ', '').trim();
        if (!skillToken) {
          return;
        }
        await toggleSkill(skillToken);
        return;
      }

      pushToast(`Unknown command: ${normalized}`, 'error');
    },
    [
      appendStatusMessage,
      applyThreadUpdate,
      onNewThread,
      openCommitModal,
      pushToast,
      selectedThread,
      selectedWorkspace,
      selectedWorkspaceId,
      toggleSkill
    ]
  );

  const startTerminalSessionForThread = useCallback(
    async (thread: ThreadMetadata): Promise<TerminalStartResult> => {
      if (!selectedWorkspace) {
        throw new Error('Select a workspace before starting terminal.');
      }

      const existing = threadSessionsRef.current[thread.id];
      if (existing && sessionLiveRef.current[existing]) {
        return { sessionId: existing, startedNew: false };
      }

      const response = await api.terminalStartSession({
        workspacePath: selectedWorkspace.path,
        initialCwd: selectedWorkspace.path,
        envVars: null,
        fullAccessFlag: thread.fullAccess,
        threadId: thread.id
      });

      const sessionId = response.sessionId;
      sessionThreadMapRef.current[sessionId] = thread.id;
      setSelectedThreadId(thread.id);

      setThreadSessions((current) => ({
        ...current,
        [thread.id]: sessionId
      }));
      setSessionLive((current) => ({
        ...current,
        [sessionId]: true
      }));
      setStatus('Running');
      setActiveRunId(sessionId);
      setLastTerminalLogByThread((current) => ({
        ...current,
        [thread.id]: ''
      }));

      void api
        .terminalReadOutput(sessionId)
        .then((snapshot) => {
          setLastTerminalLogByThread((current) => ({
            ...current,
            [thread.id]: snapshot
          }));
        })
        .catch(() => undefined);

      void api.terminalResize(sessionId, terminalSize.cols, terminalSize.rows);
      return { sessionId, startedNew: true };
    },
    [selectedWorkspace, terminalSize.cols, terminalSize.rows]
  );

  const sendComposerInputToTerminal = useCallback(async (sessionId: string, message: string) => {
    const normalized = normalizeComposerInput(message);
    if (normalized.length > 0) {
      await api.terminalWrite(sessionId, normalized.replace(/\n/g, '\r'));
    }

    // Claude Code's prompt supports multi-line composition. Submit with an empty line.
    await api.terminalWrite(sessionId, '\r');
    await delay(24);
    await api.terminalWrite(sessionId, '\r');
  }, []);

  const waitForSessionPrompt = useCallback(async (sessionId: string): Promise<'ready' | 'trust-prompt' | 'timeout'> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const snapshot = await api.terminalReadOutput(sessionId);
        const normalized = snapshot.toLowerCase();

        if (normalized.includes('quick safety check') || normalized.includes('enter to confirm')) {
          return 'trust-prompt';
        }

        if (
          snapshot.includes('❯') ||
          normalized.includes('? for shortcuts') ||
          normalized.includes('esc to interrupt') ||
          normalized.includes('message from')
        ) {
          return 'ready';
        }
      } catch {
        // Continue retrying until timeout.
      }

      await delay(90);
    }

    return 'timeout';
  }, []);

  const submitComposerMessage = useCallback(
    async (message: string): Promise<boolean> => {
      if (!selectedWorkspace || !selectedWorkspaceId) {
        pushToast('Select a workspace before running Claude.', 'error');
        return false;
      }

      if (!message.trim()) {
        return false;
      }

      let thread = selectedThread;
      if (!thread) {
        thread = await api.createThread(selectedWorkspaceId, 'claude-code');
        applyThreadUpdate(thread);
        setSelectedThreadId(thread.id);
      }

      const optimisticId = `optimistic-user-${todayId()}`;
      const optimisticEntry: TranscriptEntry = {
        id: optimisticId,
        role: 'user',
        content: message,
        createdAt: new Date().toISOString(),
        runId: null
      };
      setTranscript((current) => [...current, optimisticEntry]);

      let sentToTerminal = false;
      try {
        const { sessionId, startedNew } = await startTerminalSessionForThread(thread);
        if (startedNew) {
          const readiness = await waitForSessionPrompt(sessionId);
          if (readiness === 'trust-prompt') {
            setTranscript((current) => current.filter((entry) => entry.id !== optimisticId));
            pushToast('Claude is waiting for workspace trust confirmation in terminal. Press Enter there first.', 'error');
            return false;
          }
          if (readiness === 'timeout') {
            setTranscript((current) => current.filter((entry) => entry.id !== optimisticId));
            pushToast('Claude terminal is still starting. Try again in a second.', 'error');
            return false;
          }
        }

        await sendComposerInputToTerminal(sessionId, message);
        sentToTerminal = true;

        const userEntry = await api.appendUserMessage(selectedWorkspaceId, thread.id, message);
        setTranscript((current) => current.map((entry) => (entry.id === optimisticId ? userEntry : entry)));
        return true;
      } catch (error) {
        const errorText = String(error);
        if (!sentToTerminal) {
          setTranscript((current) => current.filter((entry) => entry.id !== optimisticId));
        }
        if (errorText.includes('Claude CLI not found')) {
          setBlockingError('Claude CLI not found. Configure the path in Settings.');
          setSettingsOpen(true);
        } else {
          pushToast(errorText, 'error');
        }
        return false;
      } finally {
        void refreshThreadsForWorkspace(selectedWorkspaceId);
      }
    },
    [
      applyThreadUpdate,
      pushToast,
      refreshThreadsForWorkspace,
      selectedThread,
      selectedWorkspace,
      selectedWorkspaceId,
      sendComposerInputToTerminal,
      waitForSessionPrompt,
      startTerminalSessionForThread
    ]
  );

  const resumeSelectedThread = useCallback(async () => {
    if (!selectedThread) {
      return;
    }
    try {
      await startTerminalSessionForThread(selectedThread);
    } catch (error) {
      pushToast(String(error), 'error');
    }
  }, [pushToast, selectedThread, startTerminalSessionForThread]);

  const generateCommitMessage = useCallback(async () => {
    if (!selectedWorkspace || !selectedThread) {
      return;
    }
    setLoadingCommitMessage(true);
    try {
      const message = await api.generateCommitMessage(selectedWorkspace.path, selectedThread.fullAccess);
      setGeneratedCommitMessage(message);
    } catch (error) {
      setGeneratedCommitMessage(`Error: ${String(error)}`);
    } finally {
      setLoadingCommitMessage(false);
    }
  }, [selectedThread, selectedWorkspace]);

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

  const slashItems = useMemo<SlashPaletteItem[]>(() => {
    const commandItems: SlashPaletteItem[] = [
      {
        id: 'cmd-new-thread',
        group: 'Commands',
        command: '/new',
        label: '/new',
        description: 'Create a new thread'
      },
      {
        id: 'cmd-open',
        group: 'Commands',
        command: '/open',
        label: '/open',
        description: 'Open workspace in Finder'
      },
      {
        id: 'cmd-context-min',
        group: 'Commands',
        command: '/context minimal',
        label: '/context minimal',
        description: 'Set context pack to Minimal'
      },
      {
        id: 'cmd-context-diff',
        group: 'Commands',
        command: '/context git diff',
        label: '/context git diff',
        description: 'Set context pack to Git Diff'
      },
      {
        id: 'cmd-context-debug',
        group: 'Commands',
        command: '/context debug',
        label: '/context debug',
        description: 'Set context pack to Debug'
      },
      {
        id: 'cmd-agent',
        group: 'Commands',
        command: '/agent claude-code',
        label: '/agent claude-code',
        description: 'Switch agent'
      },
      {
        id: 'cmd-status',
        group: 'Commands',
        command: '/status',
        label: '/status',
        description: 'Show branch, skills, context, and full access'
      },
      {
        id: 'cmd-commit',
        group: 'Commands',
        command: '/commit',
        label: '/commit',
        description: 'Open commit assistant'
      },
      {
        id: 'cmd-help',
        group: 'Commands',
        command: '/help',
        label: '/help',
        description: 'List available commands'
      }
    ];

    const skillItems: SlashPaletteItem[] = skills.map((skill) => ({
      id: `skill-${skill.id}`,
      group: 'Skills',
      command: `/skill ${skill.name}`,
      label: `/skill ${skill.name}`,
      description: skill.description || 'Toggle skill for this thread'
    }));

    return [...commandItems, ...skillItems];
  }, [skills]);

  const commandItems = useMemo<CommandPaletteItem[]>(() => {
    const shared: CommandPaletteItem[] = [
      {
        id: 'new-thread',
        title: 'New Thread',
        subtitle: 'Create a new thread in the selected workspace',
        group: 'Commands',
        keywords: ['thread'],
        action: () => void onNewThread()
      },
      {
        id: 'add-workspace',
        title: 'Add Workspace',
        subtitle: 'Pick a workspace folder using the native dialog',
        group: 'Commands',
        keywords: ['workspace', 'open'],
        action: () => void openWorkspacePicker()
      },
      {
        id: 'add-workspace-path',
        title: 'Add Workspace by Path',
        subtitle: 'Open manual path entry modal',
        group: 'Commands',
        keywords: ['workspace', 'path'],
        action: () => openManualWorkspaceModal()
      },
      {
        id: 'toggle-full-access',
        title: 'Toggle Full Access',
        subtitle: 'Switch per-thread Full Access mode',
        group: 'Commands',
        keywords: ['permissions'],
        action: () => void toggleFullAccess()
      },
      {
        id: 'open-settings',
        title: 'Open Settings',
        subtitle: 'Configure Claude CLI path',
        group: 'Commands',
        action: () => setSettingsOpen(true)
      },
      {
        id: 'open-workspace',
        title: 'Open Workspace',
        subtitle: 'Open current workspace in Finder',
        group: 'Commands',
        action: () => {
          if (selectedWorkspace) {
            void api.openInFinder(selectedWorkspace.path);
          }
        }
      },
      {
        id: 'status',
        title: 'Insert Status Message',
        subtitle: 'Post current branch/skills/context status',
        group: 'Commands',
        action: appendStatusMessage
      }
    ];

    const workspaceItems: CommandPaletteItem[] = workspaces.map((workspace) => ({
      id: `workspace-${workspace.id}`,
      title: workspace.name,
      subtitle: workspace.path,
      group: 'Workspaces',
      keywords: [workspace.path],
      action: () => {
        setSelectedWorkspaceId(workspace.id);
        setSelectedThreadId((threadsByWorkspace[workspace.id] ?? [])[0]?.id);
      }
    }));

    return [...shared, ...workspaceItems];
  }, [
    appendStatusMessage,
    onNewThread,
    openManualWorkspaceModal,
    openWorkspacePicker,
    selectedWorkspace,
    threadsByWorkspace,
    toggleFullAccess,
    workspaces
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (terminalFocused && event.metaKey && key === 'c' && activeRunId) {
        event.preventDefault();
        void api.terminalSendSignal(activeRunId, 'SIGINT');
        return;
      }

      if (terminalFocused && !event.metaKey && event.key !== 'Escape') {
        return;
      }

      if (terminalFocused && event.metaKey && key !== 'c') {
        return;
      }

      if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (event.metaKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void onNewThread();
        return;
      }

      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleFullAccess();
        return;
      }

      if (event.key === 'Escape') {
        if (activeRunId) {
          const now = Date.now();
          if (
            escapeSignalRef.current &&
            escapeSignalRef.current.sessionId === activeRunId &&
            now - escapeSignalRef.current.at < 1500
          ) {
            void api.terminalKill(activeRunId);
            escapeSignalRef.current = null;
          } else {
            void api.terminalSendSignal(activeRunId, 'SIGINT');
            escapeSignalRef.current = { sessionId: activeRunId, at: now };
          }
          return;
        }

        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }

        if (addWorkspaceOpen) {
          setAddWorkspaceOpen(false);
          setAddWorkspaceError(null);
          return;
        }

        if (commandPaletteOpen) {
          setCommandPaletteOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeRunId,
    addWorkspaceOpen,
    commandPaletteOpen,
    onNewThread,
    settingsOpen,
    terminalFocused,
    toggleFullAccess
  ]);

  useEffect(() => {
    // Dev-only automation hook used by verify scripts.
    if (!import.meta.env.DEV) {
      return;
    }

    (window as Window & { __claudeDeskAddWorkspacePath?: (path: string) => void }).__claudeDeskAddWorkspacePath = (
      path: string
    ) => {
      void confirmManualWorkspace(path);
    };
  }, [confirmManualWorkspace]);

  return (
    <div className="app-shell">
      <LeftRail
        workspaces={workspaces}
        threads={filteredThreads}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedThreadId={selectedThreadId}
        threadSearch={threadSearch}
        onSelectWorkspace={(workspaceId) => {
          setSelectedWorkspaceId(workspaceId);
          setThreadSearch('');
          const firstThread = threadsByWorkspace[workspaceId]?.[0];
          setSelectedThreadId(firstThread?.id);
        }}
        onOpenWorkspacePicker={() => void openWorkspacePicker()}
        onOpenManualWorkspaceModal={openManualWorkspaceModal}
        onNewThread={() => void onNewThread()}
        onThreadSearchChange={setThreadSearch}
        onSelectThread={onSelectThread}
      />

      <main className={blockingError ? 'main-panel has-blocking-error' : 'main-panel'} data-testid="main-panel">
        <HeaderBar
          workspace={selectedWorkspace}
          gitInfo={gitInfo}
          thread={selectedThread}
          status={status}
          onToggleFullAccess={() => void toggleFullAccess()}
          onOpenWorkspace={() => {
            if (selectedWorkspace) {
              void api.openInFinder(selectedWorkspace.path);
            }
          }}
          onOpenCommit={() => void openCommitModal()}
          onAgentChange={async (agentId) => {
            if (!selectedWorkspaceId || !selectedThread) {
              return;
            }
            const updated = await api.setThreadAgent(selectedWorkspaceId, selectedThread.id, agentId);
            applyThreadUpdate(updated);
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

        {selectedThread ? (
          <section className="terminal-region">
            {!selectedSessionLive ? (
              <div className="terminal-banner">
                <span>Read-only terminal log</span>
                <button type="button" className="ghost-button" onClick={() => void resumeSelectedThread()}>
                  Resume
                </button>
              </div>
            ) : null}
            <TerminalPanel
              sessionId={selectedSessionId}
              content={selectedTerminalContent}
              readOnly={!selectedSessionLive}
              onData={(data) => {
                if (!selectedSessionId || !selectedSessionLive) {
                  return;
                }
                void api.terminalWrite(selectedSessionId, data);
              }}
              onResize={(cols, rows) => {
                setTerminalSize({ cols, rows });
                if (!selectedSessionId || !selectedSessionLive) {
                  return;
                }
                void api.terminalResize(selectedSessionId, cols, rows);
              }}
              onFocusChange={setTerminalFocused}
            />
          </section>
        ) : (
          <LandingView
            workspace={selectedWorkspace}
            gitInfo={gitInfo}
            onSuggestion={(text) => {
              if (!selectedWorkspaceId) {
                pushToast('Add a workspace first.', 'error');
                return;
              }

              if (!selectedThread) {
                void onNewThread();
              }

              setComposerText(text);
            }}
          />
        )}

      </main>

      <CommitModal
        open={commitOpen}
        summary={commitSummary}
        generatedMessage={generatedCommitMessage}
        loadingMessage={loadingCommitMessage}
        onClose={() => setCommitOpen(false)}
        onGenerateMessage={() => void generateCommitMessage()}
      />

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

      <CommandPalette open={commandPaletteOpen} items={commandItems} onClose={() => setCommandPaletteOpen(false)} />

      <FullAccessWarningModal
        open={fullAccessWarningOpen}
        onCancel={() => setFullAccessWarningOpen(false)}
        onEnable={() => void enableFullAccessAfterWarning()}
      />

      <ToastRegion toasts={toasts} />
    </div>
  );
}

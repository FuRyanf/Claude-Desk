import { useCallback, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { RunStatus, ThreadMetadata } from '../types';

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

export interface ThreadStore {
  threadsByWorkspace: Record<string, ThreadMetadata[]>;
  selectedWorkspaceId?: string;
  selectedThreadId?: string;
  listThreads: (workspaceId: string) => Promise<ThreadMetadata[]>;
  createThread: (workspaceId: string) => Promise<ThreadMetadata>;
  renameThread: (workspaceId: string, threadId: string, title: string) => Promise<ThreadMetadata>;
  archiveThread: (workspaceId: string, threadId: string) => Promise<void>;
  deleteThread: (workspaceId: string, threadId: string) => Promise<void>;
  setSelectedWorkspace: (workspaceId?: string) => void;
  setSelectedThread: (threadId?: string) => void;
  setThreadRunState: (
    threadId: string,
    status: RunStatus,
    startedAt?: string | null,
    endedAt?: string | null
  ) => void;
  applyThreadUpdate: (thread: ThreadMetadata) => void;
}

export function useThreadStore(): ThreadStore {
  const [threadsByWorkspace, setThreadsByWorkspace] = useState<Record<string, ThreadMetadata[]>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();

  const listThreads = useCallback(async (workspaceId: string) => {
    const threads = await api.listThreads(workspaceId);
    setThreadsByWorkspace((current) => ({
      ...current,
      [workspaceId]: sortThreads(threads)
    }));
    return threads;
  }, []);

  const createThread = useCallback(async (workspaceId: string) => {
    const thread = await api.createThread(workspaceId, 'claude-code');
    setThreadsByWorkspace((current) => upsertThread(current, thread));
    setSelectedThreadId(thread.id);
    return thread;
  }, []);

  const renameThread = useCallback(async (workspaceId: string, threadId: string, title: string) => {
    const thread = await api.renameThread(workspaceId, threadId, title);
    setThreadsByWorkspace((current) => upsertThread(current, thread));
    return thread;
  }, []);

  const archiveThread = useCallback(async (workspaceId: string, threadId: string) => {
    await api.archiveThread(workspaceId, threadId);
    setThreadsByWorkspace((current) => {
      const existing = current[workspaceId] ?? [];
      return {
        ...current,
        [workspaceId]: existing.filter((thread) => thread.id !== threadId)
      };
    });
  }, []);

  const deleteThread = useCallback(async (workspaceId: string, threadId: string) => {
    await api.deleteThread(workspaceId, threadId);
    setThreadsByWorkspace((current) => {
      const existing = current[workspaceId] ?? [];
      return {
        ...current,
        [workspaceId]: existing.filter((thread) => thread.id !== threadId)
      };
    });
  }, []);

  const applyThreadUpdate = useCallback((thread: ThreadMetadata) => {
    setThreadsByWorkspace((current) => upsertThread(current, thread));
  }, []);

  const setThreadRunState = useCallback(
    (threadId: string, status: RunStatus, startedAt?: string | null, endedAt?: string | null) => {
      setThreadsByWorkspace((current) => {
        const next: Record<string, ThreadMetadata[]> = {};
        for (const [workspaceId, threads] of Object.entries(current)) {
          next[workspaceId] = threads.map((thread) => {
            if (thread.id !== threadId) {
              return thread;
            }

            return {
              ...thread,
              lastRunStatus: status,
              lastRunStartedAt: startedAt ?? thread.lastRunStartedAt,
              lastRunEndedAt: endedAt ?? thread.lastRunEndedAt,
              updatedAt: new Date().toISOString()
            };
          });
        }
        return next;
      });
    },
    []
  );

  return useMemo(
    () => ({
      threadsByWorkspace,
      selectedWorkspaceId,
      selectedThreadId,
      listThreads,
      createThread,
      renameThread,
      archiveThread,
      deleteThread,
      setSelectedWorkspace: setSelectedWorkspaceId,
      setSelectedThread: setSelectedThreadId,
      setThreadRunState,
      applyThreadUpdate
    }),
    [
      applyThreadUpdate,
      createThread,
      listThreads,
      renameThread,
      archiveThread,
      deleteThread,
      selectedThreadId,
      selectedWorkspaceId,
      setThreadRunState,
      threadsByWorkspace
    ]
  );
}

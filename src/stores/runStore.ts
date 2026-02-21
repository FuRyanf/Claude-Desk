import { useMemo, useState } from 'react';

interface ActiveThreadRun {
  threadId: string;
  sessionId: string;
  startedAt: string;
}

export interface RunStore {
  activeRunsByThread: Record<string, ActiveThreadRun>;
  bindSession: (threadId: string, sessionId: string, startedAt?: string) => void;
  finishSession: (sessionId: string) => string | null;
  sessionForThread: (threadId?: string) => string | null;
  isThreadRunning: (threadId?: string) => boolean;
  startedAtForThread: (threadId?: string) => string | null;
}

export function useRunStore(): RunStore {
  const [activeRunsByThread, setActiveRunsByThread] = useState<Record<string, ActiveThreadRun>>({});

  return useMemo(
    () => ({
      activeRunsByThread,
      bindSession: (threadId: string, sessionId: string, startedAt = new Date().toISOString()) => {
        setActiveRunsByThread((current) => ({
          ...current,
          [threadId]: {
            threadId,
            sessionId,
            startedAt
          }
        }));
      },
      finishSession: (sessionId: string) => {
        let removedThreadId: string | null = null;
        setActiveRunsByThread((current) => {
          const next: Record<string, ActiveThreadRun> = {};
          for (const [threadId, run] of Object.entries(current)) {
            if (run.sessionId === sessionId) {
              removedThreadId = threadId;
              continue;
            }
            next[threadId] = run;
          }
          return next;
        });
        return removedThreadId;
      },
      sessionForThread: (threadId?: string) => {
        if (!threadId) {
          return null;
        }
        return activeRunsByThread[threadId]?.sessionId ?? null;
      },
      isThreadRunning: (threadId?: string) => {
        if (!threadId) {
          return false;
        }
        return Boolean(activeRunsByThread[threadId]);
      },
      startedAtForThread: (threadId?: string) => {
        if (!threadId) {
          return null;
        }
        return activeRunsByThread[threadId]?.startedAt ?? null;
      }
    }),
    [activeRunsByThread]
  );
}

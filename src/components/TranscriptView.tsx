import { useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';

import type { TranscriptEntry } from '../types';

interface TranscriptViewProps {
  transcript: TranscriptEntry[];
  draftRunId?: string | null;
  draftContent?: string;
}

export function TranscriptView({ transcript, draftRunId, draftContent }: TranscriptViewProps) {
  const items = useMemo(() => {
    if (!draftRunId) {
      return transcript;
    }

    return [
      ...transcript,
      {
        id: `draft-${draftRunId}`,
        role: 'assistant' as const,
        content: draftContent ?? '',
        createdAt: new Date().toISOString(),
        runId: draftRunId
      }
    ];
  }, [draftContent, draftRunId, transcript]);

  if (items.length === 0) {
    return (
      <div className="transcript-view empty-state">
        <p className="muted empty">No messages yet.</p>
      </div>
    );
  }

  return (
    <div className="transcript-view">
      <Virtuoso
        data={items}
        followOutput="auto"
        increaseViewportBy={280}
        itemContent={(_, entry) => (
          <article className={`message ${entry.role}`}>
            <header>{entry.role.toUpperCase()}</header>
            <pre>{entry.content}</pre>
          </article>
        )}
      />
    </div>
  );
}

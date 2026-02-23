import { findSuffixPrefixOverlap } from './terminalHydration';

export type TerminalContentUpdate =
  | { kind: 'none' }
  | { kind: 'append'; delta: string }
  | { kind: 'reset' };

interface ResolveTerminalContentUpdateParams {
  rendered: string;
  content: string;
  sessionId: string | null | undefined;
  readOnly: boolean;
  contentLimitChars?: number;
}

export function resolveTerminalContentUpdate({
  rendered,
  content,
  sessionId,
  readOnly,
  contentLimitChars
}: ResolveTerminalContentUpdateParams): TerminalContentUpdate {
  if (content === rendered) {
    return { kind: 'none' };
  }

  const canApplyLiveDelta = !readOnly && Boolean(sessionId);
  if (canApplyLiveDelta && content.length > rendered.length && content.startsWith(rendered)) {
    return {
      kind: 'append',
      delta: content.slice(rendered.length)
    };
  }

  const limit = contentLimitChars ?? 0;
  if (canApplyLiveDelta && limit > 0 && rendered.length >= limit && content.length === limit) {
    const overlap = findSuffixPrefixOverlap(rendered, content);
    if (overlap > 0) {
      const delta = content.slice(overlap);
      if (delta.length > 0) {
        return {
          kind: 'append',
          delta
        };
      }
    }
  }

  return { kind: 'reset' };
}

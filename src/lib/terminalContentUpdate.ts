import { findSuffixPrefixOverlap } from './terminalHydration';

export type TerminalContentUpdate =
  | { kind: 'none' }
  | { kind: 'append'; delta: string }
  | { kind: 'reset' };

const PREPENDED_HISTORY_SUFFIX_MIN_CHARS = 32;

interface ResolveTerminalContentUpdateParams {
  rendered: string;
  content: string;
  sessionId: string | null | undefined;
  readOnly: boolean;
  contentLimitChars?: number;
  contentByteCount?: number;
  renderedByteCount?: number;
  contentGeneration?: number;
  renderedGeneration?: number;
}

export function resolveTerminalContentUpdate({
  rendered,
  content,
  sessionId,
  readOnly,
  contentLimitChars,
  contentByteCount,
  renderedByteCount,
  contentGeneration,
  renderedGeneration
}: ResolveTerminalContentUpdateParams): TerminalContentUpdate {
  if (content === rendered) {
    return { kind: 'none' };
  }

  const canApplyLiveDelta = !readOnly && Boolean(sessionId);
  const canUseByteCursor =
    canApplyLiveDelta &&
    typeof contentByteCount === 'number' &&
    typeof renderedByteCount === 'number' &&
    typeof contentGeneration === 'number' &&
    typeof renderedGeneration === 'number' &&
    Number.isFinite(contentByteCount) &&
    Number.isFinite(renderedByteCount) &&
    contentGeneration === renderedGeneration;

  if (canUseByteCursor) {
    const byteDelta = contentByteCount - renderedByteCount;
    if (byteDelta > 0 && byteDelta <= content.length) {
      return {
        kind: 'append',
        delta: content.slice(content.length - byteDelta)
      };
    }
  }

  if (canApplyLiveDelta && content.length > rendered.length && content.startsWith(rendered)) {
    return {
      kind: 'append',
      delta: content.slice(rendered.length)
    };
  }

  if (
    canApplyLiveDelta &&
    content.length > rendered.length &&
    rendered.length >= PREPENDED_HISTORY_SUFFIX_MIN_CHARS &&
    /[\r\n]/.test(rendered) &&
    content.endsWith(rendered)
  ) {
    // Snapshot refresh appended history before an already-rendered live tail.
    // Avoid destructive reset and keep the live terminal buffer authoritative.
    return { kind: 'none' };
  }

  const limit = contentLimitChars ?? 0;
  if (canApplyLiveDelta && limit > 0 && rendered.length > content.length && rendered.endsWith(content)) {
    // Clamp trimmed older prefix text from cache; terminal already contains this tail.
    return { kind: 'none' };
  }

  if (canApplyLiveDelta && limit > 0 && rendered.length >= limit && content.length === limit) {
    const limitOverlap = findSuffixPrefixOverlap(rendered, content);
    if (limitOverlap > 0) {
      const delta = content.slice(limitOverlap);
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

import { describe, expect, it } from 'vitest';

import { resolveTerminalContentUpdate } from '../../src/lib/terminalContentUpdate';

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

describe('resolveTerminalContentUpdate', () => {
  it('appends when next content is a direct prefix extension', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'hello',
        content: 'hello world',
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: 280_000
      })
    ).toEqual({
      kind: 'append',
      delta: ' world'
    });
  });

  it('uses clamp-aware append deltas after buffer rollover', () => {
    const limit = 12;
    const rendered = 'abcdefghijkl';
    const content = clamp(`${rendered}XYZ`, limit);
    expect(content).toBe('defghijklXYZ');

    expect(
      resolveTerminalContentUpdate({
        rendered,
        content,
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: limit
      })
    ).toEqual({
      kind: 'append',
      delta: 'XYZ'
    });
  });

  it('uses byte-cursor append fast path when generation is stable', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'suffix-before',
        content: 'before-and-after',
        sessionId: 'session-1',
        readOnly: false,
        contentByteCount: 104,
        renderedByteCount: 96,
        contentGeneration: 7,
        renderedGeneration: 7
      })
    ).toEqual({
      kind: 'append',
      delta: 'nd-after'
    });
  });

  it('does not use byte-cursor append when generation changed', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'suffix-before',
        content: 'before-and-after',
        sessionId: 'session-1',
        readOnly: false,
        contentByteCount: 104,
        renderedByteCount: 96,
        contentGeneration: 8,
        renderedGeneration: 7
      })
    ).toEqual({
      kind: 'reset'
    });
  });

  it('avoids reset loops across many clamp rollovers in long streams', () => {
    const limit = 64;
    const chunks = ['--tick1--', '--tick2--', '--tick3--', '--tick4--', '--tick5--'];
    let rendered = 'x'.repeat(limit);

    for (const chunk of chunks) {
      const content = clamp(`${rendered}${chunk}`, limit);
      const update = resolveTerminalContentUpdate({
        rendered,
        content,
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: limit
      });
      expect(update.kind).toBe('append');
      rendered = content;
    }
  });

  it('falls back to reset when there is no safe append relationship', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'abc',
        content: 'xyz',
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: 3
      })
    ).toEqual({
      kind: 'reset'
    });
  });

  it('keeps live render when snapshot prepends older history before rendered tail', () => {
    const liveTail = 'chunk A output\r\nchunk B output\r\n';
    const fullSnapshot = `session startup preamble\r\n\x1b[32mclaude>\x1b[0m ${liveTail}`;
    expect(
      resolveTerminalContentUpdate({
        rendered: liveTail,
        content: fullSnapshot,
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: 280_000
      })
    ).toEqual({ kind: 'none' });
  });

  it('does not suppress reset for short suffix coincidences', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: '\r\n',
        content: 'header...\r\n',
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: 280_000
      })
    ).toEqual({ kind: 'reset' });
  });

  it('does not apply append deltas from incidental overlap outside clamp mode', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'line end\r\n',
        content: '\r\nnew unrelated payload',
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: 280_000
      })
    ).toEqual({ kind: 'reset' });
  });

  it('returns none when clamped cache drops only older prefix text', () => {
    const rendered = '0123456789abcdef';
    const content = '89abcdef';
    expect(
      resolveTerminalContentUpdate({
        rendered,
        content,
        sessionId: 'session-1',
        readOnly: false,
        contentLimitChars: 8
      })
    ).toEqual({ kind: 'none' });
  });

  it('returns reset when sessionId is null regardless of content relationship', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'abc',
        content: 'abcdef',
        sessionId: null,
        readOnly: false
      })
    ).toEqual({ kind: 'reset' });
  });

  it('returns reset when readOnly is true regardless of content relationship', () => {
    expect(
      resolveTerminalContentUpdate({
        rendered: 'abc',
        content: 'abcdef',
        sessionId: 'session-1',
        readOnly: true
      })
    ).toEqual({ kind: 'reset' });
  });
});

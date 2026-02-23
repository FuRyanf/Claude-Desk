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
});

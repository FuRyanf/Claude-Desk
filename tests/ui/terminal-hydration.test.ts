import { describe, expect, it } from 'vitest';

import { appendBufferedLive, mergeSnapshotAndBufferedLive } from '../../src/lib/terminalHydration';

describe('terminal hydration merge', () => {
  it('returns snapshot when there is no buffered live output', () => {
    expect(mergeSnapshotAndBufferedLive('snapshot', '')).toBe('snapshot');
  });

  it('returns buffered live output when snapshot is empty', () => {
    expect(mergeSnapshotAndBufferedLive('', 'live')).toBe('live');
  });

  it('de-duplicates fully overlapping buffered output', () => {
    expect(mergeSnapshotAndBufferedLive('abcdef', 'def')).toBe('abcdef');
  });

  it('de-duplicates partially overlapping buffered output', () => {
    expect(mergeSnapshotAndBufferedLive('abcdef', 'defghi')).toBe('abcdefghi');
  });

  it('prefers buffered output when there is no overlap', () => {
    expect(mergeSnapshotAndBufferedLive('abc', 'xyz')).toBe('xyz');
  });

  it('handles repeated pattern overlaps deterministically', () => {
    expect(mergeSnapshotAndBufferedLive('aaaaab', 'aabccc')).toBe('aaaaabccc');
  });
});

describe('terminal hydration buffering', () => {
  it('clamps buffered live output to max chars', () => {
    expect(appendBufferedLive('1234', '56', 5)).toBe('23456');
  });
});

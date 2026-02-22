import { describe, expect, it, vi } from 'vitest';

import { TerminalWriteQueue } from '../../src/lib/terminalWriteQueue';

describe('TerminalWriteQueue', () => {
  it('buffers output before sink is attached, then flushes in order', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 4,
      scheduleFlush: (flush) => window.setTimeout(flush, 0),
      cancelFlush: (id) => window.clearTimeout(id)
    });

    queue.enqueue('AB');
    queue.enqueue('CD');
    queue.enqueue('EF');

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        done();
      }
    });

    vi.runAllTimers();
    await Promise.resolve();

    expect(writes.join('')).toBe('ABCDEF');
    expect(writes).toEqual(['ABCD', 'EF']);
    vi.useRealTimers();
  });

  it('preserves FIFO ordering across async writes', async () => {
    vi.useFakeTimers();
    const queue = new TerminalWriteQueue({
      maxBatchBytes: 2,
      scheduleFlush: (flush) => window.setTimeout(flush, 0),
      cancelFlush: (id) => window.clearTimeout(id)
    });

    const writes: string[] = [];
    queue.setSink({
      write: (chunk, done) => {
        writes.push(chunk);
        window.setTimeout(done, 5);
      }
    });

    queue.enqueue('aa');
    queue.enqueue('bb');
    queue.enqueue('cc');

    vi.runOnlyPendingTimers();
    await Promise.resolve();
    expect(writes).toEqual(['aa']);

    vi.advanceTimersByTime(5);
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    expect(writes).toEqual(['aa', 'bb']);

    vi.advanceTimersByTime(5);
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    expect(writes).toEqual(['aa', 'bb', 'cc']);
    vi.useRealTimers();
  });
});

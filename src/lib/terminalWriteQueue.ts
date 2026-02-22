type WriteSink = {
  write: (chunk: string, done: () => void) => void;
};

type ScheduleFlush = (flush: () => void) => number;
type CancelFlush = (id: number) => void;

interface TerminalWriteQueueOptions {
  maxBatchBytes?: number;
  scheduleFlush?: ScheduleFlush;
  cancelFlush?: CancelFlush;
}

export interface TerminalWriteQueueStats {
  pendingChunks: number;
  pendingBytes: number;
  highWaterBytes: number;
  totalWrites: number;
  totalBytesWritten: number;
  writing: boolean;
}

const DEFAULT_MAX_BATCH_BYTES = 48 * 1024;

function defaultScheduleFlush(flush: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(() => flush());
  }
  return globalThis.setTimeout(() => flush(), 8) as unknown as number;
}

function defaultCancelFlush(id: number) {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }
  globalThis.clearTimeout(id);
}

export class TerminalWriteQueue {
  private readonly maxBatchBytes: number;

  private readonly scheduleFlush: ScheduleFlush;

  private readonly cancelFlush: CancelFlush;

  private sink: WriteSink | null = null;

  private pendingChunks: string[] = [];

  private pendingBytes = 0;

  private highWaterBytes = 0;

  private totalWrites = 0;

  private totalBytesWritten = 0;

  private writing = false;

  private scheduledFlushId: number | null = null;

  private epoch = 0;

  constructor(options: TerminalWriteQueueOptions = {}) {
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.scheduleFlush = options.scheduleFlush ?? defaultScheduleFlush;
    this.cancelFlush = options.cancelFlush ?? defaultCancelFlush;
  }

  setSink(sink: WriteSink | null) {
    this.sink = sink;
    if (sink) {
      this.scheduleDrain();
    }
  }

  enqueue(chunk: string) {
    if (!chunk) {
      return;
    }

    this.pendingChunks.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes > this.highWaterBytes) {
      this.highWaterBytes = this.pendingBytes;
    }
    this.scheduleDrain();
  }

  clear() {
    this.epoch += 1;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.writing = false;
    if (this.scheduledFlushId !== null) {
      this.cancelFlush(this.scheduledFlushId);
      this.scheduledFlushId = null;
    }
  }

  flushImmediate() {
    if (this.scheduledFlushId !== null) {
      this.cancelFlush(this.scheduledFlushId);
      this.scheduledFlushId = null;
    }
    this.drain();
  }

  getStats(): TerminalWriteQueueStats {
    return {
      pendingChunks: this.pendingChunks.length,
      pendingBytes: this.pendingBytes,
      highWaterBytes: this.highWaterBytes,
      totalWrites: this.totalWrites,
      totalBytesWritten: this.totalBytesWritten,
      writing: this.writing
    };
  }

  private scheduleDrain() {
    if (this.scheduledFlushId !== null) {
      return;
    }
    this.scheduledFlushId = this.scheduleFlush(() => {
      this.scheduledFlushId = null;
      this.drain();
    });
  }

  private drain() {
    if (this.writing) {
      return;
    }
    if (!this.sink) {
      return;
    }
    if (this.pendingChunks.length === 0) {
      return;
    }

    const batch = this.takeBatch();
    if (!batch) {
      return;
    }

    this.writing = true;
    this.totalWrites += 1;
    this.totalBytesWritten += batch.length;
    const writeEpoch = this.epoch;
    this.sink.write(batch, () => {
      if (writeEpoch !== this.epoch) {
        return;
      }
      this.writing = false;
      if (this.pendingChunks.length > 0) {
        this.scheduleDrain();
      }
    });
  }

  private takeBatch(): string {
    if (this.pendingChunks.length === 0) {
      return '';
    }

    let batchBytes = 0;
    const parts: string[] = [];
    while (this.pendingChunks.length > 0) {
      const head = this.pendingChunks[0];
      if (parts.length > 0 && batchBytes + head.length > this.maxBatchBytes) {
        break;
      }
      parts.push(head);
      this.pendingChunks.shift();
      this.pendingBytes -= head.length;
      batchBytes += head.length;
      if (batchBytes >= this.maxBatchBytes) {
        break;
      }
    }

    return parts.join('');
  }
}

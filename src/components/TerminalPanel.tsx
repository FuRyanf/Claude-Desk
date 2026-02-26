import { useCallback, useEffect, useRef, useState } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { Terminal } from 'xterm';
import { resolveTerminalContentUpdate } from '../lib/terminalContentUpdate';
import {
  createFollowState,
  handleTerminalScroll,
  jumpToLatest as jumpFollowStateToLatest,
  pauseFollowByUser,
  shouldAutoFollow
} from '../lib/terminalFollowState';
import { TerminalWriteQueue } from '../lib/terminalWriteQueue';

const INPUT_FLUSH_MS = 8;
const INPUT_CHUNK_SIZE = 4 * 1024;
const OUTPUT_BATCH_BYTES = 16 * 1024;
const OUTPUT_BATCH_BYTES_INTERACTIVE = 8 * 1024;
const OUTPUT_MAX_FLUSH_DELAY_MS = 48;
const OUTPUT_QUEUE_WARN_PENDING_BYTES = 128 * 1024;
const OUTPUT_QUEUE_WARN_LATENCY_MS = 96;
const OUTPUT_QUEUE_WARN_COOLDOWN_MS = 2_000;

interface TerminalPanelProps {
  sessionId?: string | null;
  content: string;
  contentByteCount?: number;
  contentGeneration?: number;
  contentLimitChars?: number;
  readOnly?: boolean;
  inputEnabled?: boolean;
  overlayMessage?: string;
  focusRequestId?: number;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

export function TerminalPanel({
  sessionId = null,
  content,
  contentByteCount,
  contentGeneration,
  contentLimitChars,
  readOnly = false,
  inputEnabled = true,
  overlayMessage,
  focusRequestId = 0,
  onData,
  onResize,
  onFocusChange
}: TerminalPanelProps) {
  const [fallback, setFallback] = useState(() => import.meta.env.MODE === 'test');
  const [followOutputPaused, setFollowOutputPaused] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const contentRef = useRef(content);
  const renderedContentRef = useRef(content);
  const renderedByteCountRef = useRef(contentByteCount ?? content.length);
  const renderedGenerationRef = useRef(contentGeneration ?? 0);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onFocusChangeRef = useRef(onFocusChange);
  const readOnlyRef = useRef(readOnly);
  const inputEnabledRef = useRef(inputEnabled);
  const previousInputEnabledRef = useRef(inputEnabled);
  const sessionRef = useRef<string | null>(sessionId);
  const followStateRef = useRef(createFollowState());
  const writeQueueRef = useRef(
    new TerminalWriteQueue({
      maxBatchBytes: OUTPUT_BATCH_BYTES,
      maxFlushDelayMs: OUTPUT_MAX_FLUSH_DELAY_MS
    })
  );
  const inputBufferRef = useRef('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const refreshFrameRef = useRef<number | null>(null);
  const previousFocusRequestRef = useRef(focusRequestId);
  const lastQueueWarningAtRef = useRef(0);
  const bulkWritingRef = useRef(false);
  const bulkWriteEpochRef = useRef(0);

  const scrollToBottomSoon = useCallback((term: Terminal) => {
    if (!shouldAutoFollow(followStateRef.current)) {
      return;
    }
    term.scrollToBottom();
    window.requestAnimationFrame(() => {
      if (terminalRef.current !== term) {
        return;
      }
      if (!shouldAutoFollow(followStateRef.current)) {
        return;
      }
      term.scrollToBottom();
    });
  }, []);

  const pauseFollowOutput = useCallback(() => {
    const next = pauseFollowByUser(followStateRef.current);
    if (next === followStateRef.current) {
      return;
    }
    followStateRef.current = next;
    setFollowOutputPaused(true);
  }, []);

  const scheduleTerminalRefresh = useCallback((term: Terminal) => {
    if (refreshFrameRef.current !== null) {
      return;
    }
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      if (terminalRef.current !== term) {
        return;
      }
      term.refresh(0, Math.max(0, term.rows - 1));
    });
  }, []);

  const maybeLogQueueHealth = useCallback(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const stats = writeQueueRef.current.getStats();
    if (
      stats.pendingBytes < OUTPUT_QUEUE_WARN_PENDING_BYTES &&
      stats.lastQueueLatencyMs < OUTPUT_QUEUE_WARN_LATENCY_MS
    ) {
      return;
    }
    const nowMs = Date.now();
    if (nowMs - lastQueueWarningAtRef.current < OUTPUT_QUEUE_WARN_COOLDOWN_MS) {
      return;
    }
    lastQueueWarningAtRef.current = nowMs;
    console.debug('[terminal-write-queue] burst pressure', {
      pendingBytes: stats.pendingBytes,
      pendingChunks: stats.pendingChunks,
      highWaterBytes: stats.highWaterBytes,
      highWaterChunks: stats.highWaterChunks,
      lastQueueLatencyMs: stats.lastQueueLatencyMs,
      maxQueueLatencyMs: stats.maxQueueLatencyMs,
      maxFlushDelayMs: stats.maxFlushDelayMs
    });
  }, []);

  const flushOutgoingInput = useCallback(() => {
    const payload = inputBufferRef.current;
    if (!payload) {
      return;
    }
    inputBufferRef.current = '';
    onDataRef.current?.(payload);
  }, []);

  const scheduleOutgoingInputFlush = useCallback(() => {
    if (inputFlushTimerRef.current !== null) {
      return;
    }
    inputFlushTimerRef.current = window.setTimeout(() => {
      inputFlushTimerRef.current = null;
      flushOutgoingInput();
    }, INPUT_FLUSH_MS);
  }, [flushOutgoingInput]);

  const queueWrite = useCallback((data: string) => {
    if (data.length === 0) {
      return;
    }
    writeQueueRef.current.enqueue(data);
  }, []);

  const clearPendingWrites = useCallback(() => {
    writeQueueRef.current.clear();
  }, []);

  const resetTerminalContent = useCallback(
    (nextContent: string) => {
      const term = terminalRef.current;
      if (!term) {
        return;
      }

      const bulkWriteEpoch = bulkWriteEpochRef.current + 1;
      bulkWriteEpochRef.current = bulkWriteEpoch;
      bulkWritingRef.current = true;
      clearPendingWrites();
      term.reset();
      if (nextContent.length > 0) {
        queueWrite(nextContent);
        writeQueueRef.current.flushImmediate();
      }

      void writeQueueRef.current.whenIdle().then(() => {
        if (terminalRef.current !== term) {
          return;
        }
        if (bulkWriteEpochRef.current !== bulkWriteEpoch) {
          return;
        }
        bulkWritingRef.current = false;
        followStateRef.current = createFollowState();
        setFollowOutputPaused(false);
        scrollToBottomSoon(term);
        scheduleTerminalRefresh(term);
      });
    },
    [clearPendingWrites, queueWrite, scheduleTerminalRefresh, scrollToBottomSoon]
  );

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onFocusChangeRef.current = onFocusChange;
  }, [onFocusChange]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (fallback) {
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    try {
      const term = new Terminal({
        cursorBlink: false,
        convertEol: false,
        scrollback: 10_000,
        fontFamily: '"SF Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.34,
        theme: {
          background: '#0b1426',
          foreground: '#d8e0ef',
          cursor: '#e6edf8',
          cursorAccent: '#0b1426',
          selectionBackground: 'rgba(151, 166, 189, 0.28)',
          black: '#1a2130',
          red: '#f38f79',
          green: '#62d5a4',
          yellow: '#f4c777',
          blue: '#8bb8ff',
          magenta: '#c8acff',
          cyan: '#80d5ea',
          white: '#d6deec',
          brightBlack: '#7f8ca6',
          brightRed: '#f8a996',
          brightGreen: '#7be0b3',
          brightYellow: '#f8d18e',
          brightBlue: '#a6c8ff',
          brightMagenta: '#d7bfff',
          brightCyan: '#97def0',
          brightWhite: '#f2f6ff'
        },
        disableStdin: readOnly || !inputEnabled
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      terminalRef.current = term;
      writeQueueRef.current.setSink({
        write: (chunk, done) => {
          term.write(chunk, () => {
            if (terminalRef.current === term && shouldAutoFollow(followStateRef.current)) {
              term.scrollToBottom();
            }
            scheduleTerminalRefresh(term);
            maybeLogQueueHealth();
            done();
          });
        }
      });

      const fitAndNotify = () => {
        fitAddon.fit();
        onResizeRef.current?.(term.cols, term.rows);
        if (shouldAutoFollow(followStateRef.current)) {
          scrollToBottomSoon(term);
        }
        scheduleTerminalRefresh(term);
      };
      fitAndNotify();
      window.requestAnimationFrame(() => {
        if (terminalRef.current !== term) {
          return;
        }
        fitAndNotify();
      });
      if ('fonts' in document) {
        void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(() => {
          if (terminalRef.current !== term) {
            return;
          }
          fitAndNotify();
        });
      }

      if (contentRef.current.length > 0) {
        followStateRef.current = {
          mode: 'following',
          viewportY: followStateRef.current.viewportY,
          baseY: followStateRef.current.baseY
        };
        queueWrite(contentRef.current);
        writeQueueRef.current.flushImmediate();
      }
      renderedContentRef.current = contentRef.current;
      renderedByteCountRef.current = contentByteCount ?? contentRef.current.length;
      renderedGenerationRef.current = contentGeneration ?? 0;

      const onDataDisposable = term.onData((data) => {
        if (readOnlyRef.current || !inputEnabledRef.current) {
          return;
        }

        inputBufferRef.current += data;
        if (
          data === '\r' ||
          data === '\x03' ||
          inputBufferRef.current.length >= INPUT_CHUNK_SIZE
        ) {
          if (inputFlushTimerRef.current !== null) {
            window.clearTimeout(inputFlushTimerRef.current);
            inputFlushTimerRef.current = null;
          }
          flushOutgoingInput();
        } else {
          scheduleOutgoingInputFlush();
        }
      });

      const onScrollDisposable = term.onScroll((viewportY) => {
        if (bulkWritingRef.current) {
          followStateRef.current = {
            ...followStateRef.current,
            viewportY,
            baseY: term.buffer.active.baseY
          };
          return;
        }
        const next = handleTerminalScroll(followStateRef.current, {
          viewportY,
          baseY: term.buffer.active.baseY
        });
        followStateRef.current = next;
        setFollowOutputPaused(next.mode === 'pausedByUser');
      });

      const onWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) {
          pauseFollowOutput();
        }
      };
      host.addEventListener('wheel', onWheel, { passive: true });

      const onFocusIn = () => onFocusChangeRef.current?.(true);
      const onFocusOut = () => onFocusChangeRef.current?.(false);
      host.addEventListener('focusin', onFocusIn);
      host.addEventListener('focusout', onFocusOut);

      const observer = new ResizeObserver(() => {
        if (resizeFrameRef.current !== null) {
          return;
        }
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          fitAndNotify();
        });
      });
      observer.observe(host);

      return () => {
        observer.disconnect();
        onDataDisposable.dispose();
        onScrollDisposable.dispose();
        host.removeEventListener('wheel', onWheel);
        host.removeEventListener('focusin', onFocusIn);
        host.removeEventListener('focusout', onFocusOut);
        flushOutgoingInput();
        fitAddon.dispose();
        writeQueueRef.current.setSink(null);
        writeQueueRef.current.clear();
        bulkWritingRef.current = false;
        bulkWriteEpochRef.current += 1;
        term.dispose();
        terminalRef.current = null;
        followStateRef.current = createFollowState();
        inputBufferRef.current = '';
        if (inputFlushTimerRef.current !== null) {
          window.clearTimeout(inputFlushTimerRef.current);
          inputFlushTimerRef.current = null;
        }
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        if (refreshFrameRef.current !== null) {
          window.cancelAnimationFrame(refreshFrameRef.current);
          refreshFrameRef.current = null;
        }
      };
    } catch {
      setFallback(true);
      return;
    }
  }, [
    fallback,
    flushOutgoingInput,
    maybeLogQueueHealth,
    pauseFollowOutput,
    queueWrite,
    scrollToBottomSoon,
    scheduleOutgoingInputFlush
  ]);

  useEffect(() => {
    writeQueueRef.current.setMaxBatchBytes(followOutputPaused ? OUTPUT_BATCH_BYTES_INTERACTIVE : OUTPUT_BATCH_BYTES);
  }, [followOutputPaused]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    inputEnabledRef.current = inputEnabled;

    const term = terminalRef.current;
    if (!term) {
      previousInputEnabledRef.current = inputEnabled;
      return;
    }

    term.options.disableStdin = readOnly || !inputEnabled;

    const wasEnabled = previousInputEnabledRef.current;
    if (!wasEnabled && inputEnabled && !readOnly && shouldAutoFollow(followStateRef.current)) {
      scrollToBottomSoon(term);
      window.setTimeout(() => {
        if (terminalRef.current !== term) {
          return;
        }
        if (!shouldAutoFollow(followStateRef.current)) {
          return;
        }
        term.scrollToBottom();
      }, 80);
    }
    previousInputEnabledRef.current = inputEnabled;
  }, [inputEnabled, readOnly, scrollToBottomSoon]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) {
      sessionRef.current = sessionId;
      return;
    }

    if (sessionRef.current === sessionId) {
      return;
    }

    sessionRef.current = sessionId;
    followStateRef.current = createFollowState();
    setFollowOutputPaused(false);
    clearPendingWrites();
    inputBufferRef.current = '';
    if (inputFlushTimerRef.current !== null) {
      window.clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }

    resetTerminalContent(contentRef.current);
    renderedContentRef.current = contentRef.current;
    renderedByteCountRef.current = contentByteCount ?? contentRef.current.length;
    renderedGenerationRef.current = contentGeneration ?? 0;
    scheduleTerminalRefresh(term);
  }, [clearPendingWrites, resetTerminalContent, scheduleTerminalRefresh, sessionId]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }

    const rendered = renderedContentRef.current;
    const nextUpdate = resolveTerminalContentUpdate({
      rendered,
      content,
      sessionId,
      readOnly,
      contentLimitChars,
      contentByteCount,
      renderedByteCount: renderedByteCountRef.current,
      contentGeneration,
      renderedGeneration: renderedGenerationRef.current
    });

    if (nextUpdate.kind === 'none') {
      if (content !== rendered) {
        // Keep the logical rendered anchor in sync when we intentionally skip destructive resets
        // (e.g. prepended snapshot history before already-rendered live tail). This prevents
        // repeated reset classifications on subsequent appends.
        renderedContentRef.current = content;
        renderedByteCountRef.current = contentByteCount ?? content.length;
        renderedGenerationRef.current = contentGeneration ?? renderedGenerationRef.current;
      }
      return;
    }

    if (nextUpdate.kind === 'append') {
      if (nextUpdate.delta.length > 0) {
        queueWrite(nextUpdate.delta);
      }
      renderedContentRef.current = content;
      renderedByteCountRef.current = contentByteCount ?? content.length;
      renderedGenerationRef.current = contentGeneration ?? renderedGenerationRef.current;
      if (shouldAutoFollow(followStateRef.current)) {
        scrollToBottomSoon(term);
      }
      return;
    }

    if (sessionId && !readOnly && content.length < rendered.length) {
      // Ignore regressive snapshots while a live session is active.
      // Allow resets for divergent/superset content so renderedContentRef can recover.
      return;
    }

    resetTerminalContent(content);
    renderedContentRef.current = content;
    renderedByteCountRef.current = contentByteCount ?? content.length;
    renderedGenerationRef.current = contentGeneration ?? renderedGenerationRef.current;
    scheduleTerminalRefresh(term);
  }, [
    content,
    contentByteCount,
    contentGeneration,
    contentLimitChars,
    readOnly,
    resetTerminalContent,
    scheduleTerminalRefresh,
    sessionId,
    queueWrite,
    scrollToBottomSoon
  ]);

  useEffect(() => {
    if (previousFocusRequestRef.current === focusRequestId) {
      return;
    }
    previousFocusRequestRef.current = focusRequestId;
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    term.focus();
    if (shouldAutoFollow(followStateRef.current)) {
      scrollToBottomSoon(term);
    }
    setFollowOutputPaused(followStateRef.current.mode === 'pausedByUser');
    scheduleTerminalRefresh(term);
  }, [focusRequestId, scheduleTerminalRefresh, scrollToBottomSoon]);

  const jumpToLatest = useCallback(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    followStateRef.current = jumpFollowStateToLatest(followStateRef.current, {
      baseY: term.buffer.active.baseY
    });
    setFollowOutputPaused(false);
    scrollToBottomSoon(term);
    scheduleTerminalRefresh(term);
  }, [scheduleTerminalRefresh, scrollToBottomSoon]);

  if (fallback) {
    return (
      <section className="terminal-panel">
        <pre className="terminal-fallback">{content}</pre>
        {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
      </section>
    );
  }

  return (
    <section className="terminal-panel">
      <div ref={hostRef} className="terminal-host" />
      {followOutputPaused ? (
        <button type="button" className="terminal-follow-button" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
      {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
    </section>
  );
}

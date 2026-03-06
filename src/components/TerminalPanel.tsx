import { useCallback, useEffect, useRef, useState } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { Terminal } from 'xterm';
import { api } from '../lib/api';
import { resolveTerminalContentUpdate } from '../lib/terminalContentUpdate';
import {
  createFollowState,
  handleTerminalScroll,
  jumpToLatest as jumpFollowStateToLatest,
  pauseFollowByUser,
  shouldAutoFollow
} from '../lib/terminalFollowState';
import { shouldScheduleTerminalStreamRepair } from '../lib/terminalStreamRepair';
import { TerminalWriteQueue } from '../lib/terminalWriteQueue';

const INPUT_FLUSH_MS = 8;
const INPUT_CHUNK_SIZE = 4 * 1024;
const OUTPUT_BATCH_BYTES = 16 * 1024;
const OUTPUT_BATCH_BYTES_INTERACTIVE = 8 * 1024;
const OUTPUT_MAX_FLUSH_DELAY_MS = 48;
const STREAM_REPAIR_IDLE_DELAY_MS = 120;
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
  repairRequestId?: number;
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
  repairRequestId = 0,
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
  const previousRepairRequestRef = useRef(repairRequestId);
  const lastQueueWarningAtRef = useRef(0);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitWithReflowRef = useRef<(() => void) | null>(null);
  const bulkWritingRef = useRef(false);
  const bulkWriteEpochRef = useRef(0);
  const isWritingRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const scrollPauseCooldownRef = useRef(0);
  const streamRepairTimerRef = useRef<number | null>(null);
  const bytesSinceRepairRef = useRef(0);
  const lastStreamRepairAtRef = useRef(0);

  const syncFollowOutputPaused = useCallback((nextPaused: boolean) => {
    setFollowOutputPaused((current) => (current === nextPaused ? current : nextPaused));
  }, []);

  const scrollToBottomSoon = useCallback((term: Terminal) => {
    if (!shouldAutoFollow(followStateRef.current)) {
      return;
    }
    // Skip if within the cooldown window after user paused scroll.
    // This prevents a race where a write-batch completion fires scrollToBottom
    // before the pause handler has propagated through React state.
    if (Date.now() < scrollPauseCooldownRef.current) {
      return;
    }
    // Coalesce rapid scroll requests into a single rAF to avoid fighting with
    // user scroll gestures and reduce redundant work during burst output.
    if (scrollRafRef.current !== null) {
      return;
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (terminalRef.current !== term) {
        return;
      }
      if (!shouldAutoFollow(followStateRef.current)) {
        return;
      }
      if (Date.now() < scrollPauseCooldownRef.current) {
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
    // Set a short cooldown so in-flight rAF scroll-to-bottom calls are suppressed.
    // This closes the race window between the user's scroll gesture and pending
    // write-batch completions that would snap the viewport back to the bottom.
    scrollPauseCooldownRef.current = Date.now() + 150;
    // Cancel any pending scroll-to-bottom rAF.
    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    syncFollowOutputPaused(true);
  }, [syncFollowOutputPaused]);

  const openExternalLink = useCallback((_: MouseEvent, uri: string) => {
    const target = uri.trim();
    if (!target) {
      return;
    }
    void api.openExternalUrl(target).catch(() => {
      const newWindow = window.open(target, '_blank', 'noopener,noreferrer');
      if (!newWindow) {
        return;
      }
      try {
        newWindow.opener = null;
      } catch {
        // no-op: some runtimes disallow setting opener
      }
    });
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

  const clearScheduledStreamRepair = useCallback(() => {
    if (streamRepairTimerRef.current !== null) {
      window.clearTimeout(streamRepairTimerRef.current);
      streamRepairTimerRef.current = null;
    }
  }, []);

  const runStreamRepair = useCallback(
    (term: Terminal) => {
      if (terminalRef.current !== term) {
        return;
      }
      lastStreamRepairAtRef.current = Date.now();
      bytesSinceRepairRef.current = 0;
      fitWithReflowRef.current?.();
      scheduleTerminalRefresh(term);
    },
    [scheduleTerminalRefresh]
  );

  const scheduleStreamRepair = useCallback(
    (term: Terminal, delayMs = STREAM_REPAIR_IDLE_DELAY_MS) => {
      if (streamRepairTimerRef.current !== null) {
        return;
      }

      streamRepairTimerRef.current = window.setTimeout(() => {
        streamRepairTimerRef.current = null;
        if (terminalRef.current !== term) {
          return;
        }

        const stats = writeQueueRef.current.getStats();
        if (bulkWritingRef.current || isWritingRef.current || stats.writing || stats.pendingBytes > 0) {
          scheduleStreamRepair(term, STREAM_REPAIR_IDLE_DELAY_MS);
          return;
        }

        runStreamRepair(term);
      }, delayMs);
    },
    [runStreamRepair]
  );

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
        syncFollowOutputPaused(false);
        bytesSinceRepairRef.current = 0;
        clearScheduledStreamRepair();
        scrollToBottomSoon(term);
        scheduleTerminalRefresh(term);
      });
    },
    [clearPendingWrites, clearScheduledStreamRepair, queueWrite, scheduleTerminalRefresh, scrollToBottomSoon, syncFollowOutputPaused]
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
        fontSize: 14,
        fontWeight: 460,
        lineHeight: 1.28,
        letterSpacing: 0.1,
        theme: {
          background: '#081121',
          foreground: '#d9e3f5',
          cursor: '#f5f8ff',
          cursorAccent: '#081121',
          selectionBackground: 'rgba(162, 182, 216, 0.24)',
          black: '#172033',
          red: '#f39a86',
          green: '#69d5a8',
          yellow: '#f0c97f',
          blue: '#90bcff',
          magenta: '#ccb2ff',
          cyan: '#86d7ec',
          white: '#d9e3f5',
          brightBlack: '#77849d',
          brightRed: '#f7ae9f',
          brightGreen: '#84dfb8',
          brightYellow: '#f6d79b',
          brightBlue: '#abcfff',
          brightMagenta: '#dbc5ff',
          brightCyan: '#9ce2f2',
          brightWhite: '#f5f8ff'
        },
        disableStdin: readOnly || !inputEnabled
      });
      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon(openExternalLink));
      term.open(host);
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === 'keydown' &&
          event.key === 'Enter' &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          if (!readOnlyRef.current && inputEnabledRef.current) {
            inputBufferRef.current += '\n';
            scheduleOutgoingInputFlush();
          }
          return false;
        }
        if (event.type === 'keydown' && event.key === 'PageUp') {
          pauseFollowOutput();
        }
        return true;
      });
      terminalRef.current = term;
      writeQueueRef.current.setSink({
        write: (chunk, done) => {
          isWritingRef.current = true;
          term.write(chunk, () => {
            isWritingRef.current = false;
            if (terminalRef.current === term && shouldAutoFollow(followStateRef.current)) {
              scrollToBottomSoon(term);
            }
            scheduleTerminalRefresh(term);
            bytesSinceRepairRef.current += chunk.length;
            const queueStats = writeQueueRef.current.getStats();
            if (
              shouldScheduleTerminalStreamRepair({
                autoFollow: shouldAutoFollow(followStateRef.current),
                bytesSinceLastRepair: bytesSinceRepairRef.current,
                lastQueueLatencyMs: queueStats.lastQueueLatencyMs,
                lastRepairAtMs: lastStreamRepairAtRef.current,
                nowMs: Date.now()
              })
            ) {
              scheduleStreamRepair(term);
            }
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

      // fitAddon.fit() short-circuits when the proposed cols/rows match the
      // current grid — it skips term.resize(), so xterm never re-measures
      // character metrics.  term.resize(same, same) also short-circuits.
      // On cold start the initial measurement can use stale font metrics
      // (before SF Mono is measurable) or stale container dimensions (before
      // Tauri window-restore completes).  Later fits silently no-op because
      // the grid "hasn't changed".
      //
      // A one-column nudge forces xterm through a real resize() →
      // _renderService.handleResize() → _updateDimensions() path, which
      // re-reads character metrics from the (now correct) char-measure
      // element and recomputes css.cell.width/height.  This is the same
      // mechanism that makes manual window resize fix the display.
      const fitWithReflow = () => {
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 1) {
          term.resize(cols + 1, rows);
          term.resize(cols, rows);
        }
        fitAndNotify();
      };
      fitWithReflowRef.current = fitWithReflow;

      // Synchronous best-effort fit (renderer may not have dims yet — that's OK).
      fitAndNotify();
      // Deferred fits use fitWithReflow to force correct metrics.
      window.requestAnimationFrame(() => {
        if (terminalRef.current !== term) {
          return;
        }
        fitWithReflow();
      });
      if ('fonts' in document) {
        void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(() => {
          if (terminalRef.current !== term) {
            return;
          }
          fitWithReflow();
        });
        // Explicitly wait for SF Mono so xterm's char-measure element gets correct metrics.
        // fonts.ready can resolve before the specific font is measurable on cold start.
        void (document as Document & { fonts?: { load: (font: string) => Promise<unknown> } }).fonts
          ?.load('13px "SF Mono"')
          .catch(() => {})
          .then(() => {
            if (terminalRef.current !== term) {
              return;
            }
            fitWithReflow();
          });
      }
      window.setTimeout(() => {
        if (terminalRef.current !== term) {
          return;
        }
        fitWithReflow();
      }, 100);
      // Second deferred fit for slow Tauri window-restore on first launch.
      window.setTimeout(() => {
        if (terminalRef.current !== term) {
          return;
        }
        fitWithReflow();
      }, 500);

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
        const baseY = term.buffer.active.baseY;
        const prev = followStateRef.current;
        const next = handleTerminalScroll(prev, { viewportY, baseY });
        followStateRef.current = next;
        syncFollowOutputPaused(next.mode === 'pausedByUser');
        // Pause follow for scrollbar drag; wheel and PageUp are handled by their own listeners.
        if (userScrollIntentRef.current && viewportY < baseY) {
          pauseFollowOutput();
          userScrollIntentRef.current = false;
        }
      });

      const onWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) {
          pauseFollowOutput();
        }
      };
      host.addEventListener('wheel', onWheel, { passive: true });

      const viewport = host.querySelector('.xterm-viewport') as HTMLElement | null;
      const onViewportPointerDown = (e: PointerEvent) => {
        // Only set scroll intent when the click lands in the native scrollbar area.
        // el.clientWidth excludes the permanent scrollbar gutter; clicks beyond it are on the track.
        // On macOS overlay-scrollbar mode offsetWidth === clientWidth (no gutter), so the check
        // is skipped — trackpad wheel events already handle pause in that case.
        const el = e.currentTarget as HTMLElement;
        const hasVisibleScrollbar = el.offsetWidth > el.clientWidth;
        if (hasVisibleScrollbar && e.clientX > el.getBoundingClientRect().left + el.clientWidth) {
          userScrollIntentRef.current = true;
        }
      };
      const clearViewportScrollIntent = () => {
        userScrollIntentRef.current = false;
      };
      if (viewport) {
        viewport.addEventListener('pointerdown', onViewportPointerDown);
        viewport.addEventListener('pointerup', clearViewportScrollIntent);
        viewport.addEventListener('pointercancel', clearViewportScrollIntent);
        viewport.addEventListener('pointerleave', clearViewportScrollIntent);
      }

      const onFocusIn = () => onFocusChangeRef.current?.(true);
      const onFocusOut = () => onFocusChangeRef.current?.(false);
      host.addEventListener('focusin', onFocusIn);
      host.addEventListener('focusout', onFocusOut);

      const observer = new ResizeObserver(() => {
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
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
        if (viewport) {
          viewport.removeEventListener('pointerdown', onViewportPointerDown);
          viewport.removeEventListener('pointerup', clearViewportScrollIntent);
          viewport.removeEventListener('pointercancel', clearViewportScrollIntent);
          viewport.removeEventListener('pointerleave', clearViewportScrollIntent);
        }
        userScrollIntentRef.current = false;
        flushOutgoingInput();
        fitAddonRef.current = null;
        fitAddon.dispose();
        writeQueueRef.current.setSink(null);
        writeQueueRef.current.clear();
        bulkWritingRef.current = false;
        isWritingRef.current = false;
        bulkWriteEpochRef.current += 1;
        fitWithReflowRef.current = null;
        clearScheduledStreamRepair();
        bytesSinceRepairRef.current = 0;
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
        if (scrollRafRef.current !== null) {
          window.cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
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
    openExternalLink,
    pauseFollowOutput,
    queueWrite,
    clearScheduledStreamRepair,
    scheduleStreamRepair,
    scrollToBottomSoon,
    scheduleOutgoingInputFlush,
    syncFollowOutputPaused
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
    syncFollowOutputPaused(false);
    clearPendingWrites();
    clearScheduledStreamRepair();
    bytesSinceRepairRef.current = 0;
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
  }, [clearPendingWrites, clearScheduledStreamRepair, resetTerminalContent, scheduleTerminalRefresh, sessionId, syncFollowOutputPaused]);

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
    window.requestAnimationFrame(() => {
      const fitAddon = fitAddonRef.current;
      if (!terminalRef.current || !fitAddon) {
        return;
      }
      fitAddon.fit();
      onResizeRef.current?.(terminalRef.current.cols, terminalRef.current.rows);
      scheduleTerminalRefresh(terminalRef.current);
    });
    if (shouldAutoFollow(followStateRef.current)) {
      scrollToBottomSoon(term);
    }
    syncFollowOutputPaused(followStateRef.current.mode === 'pausedByUser');
    scheduleTerminalRefresh(term);
  }, [focusRequestId, scheduleTerminalRefresh, scrollToBottomSoon, syncFollowOutputPaused]);

  useEffect(() => {
    if (previousRepairRequestRef.current === repairRequestId) {
      return;
    }
    previousRepairRequestRef.current = repairRequestId;
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    clearScheduledStreamRepair();
    runStreamRepair(term);
  }, [clearScheduledStreamRepair, repairRequestId, runStreamRepair]);

  const jumpToLatest = useCallback(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }
    followStateRef.current = jumpFollowStateToLatest(followStateRef.current, {
      baseY: term.buffer.active.baseY
    });
    syncFollowOutputPaused(false);
    // Clear cooldown so the explicit user action isn't suppressed.
    scrollPauseCooldownRef.current = 0;
    scrollToBottomSoon(term);
    scheduleTerminalRefresh(term);
  }, [scheduleTerminalRefresh, scrollToBottomSoon, syncFollowOutputPaused]);

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
        <div className="terminal-controls">
          <button type="button" className="terminal-follow-button" onClick={jumpToLatest}>
            Jump to latest
          </button>
        </div>
      ) : null}
      {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
    </section>
  );
}

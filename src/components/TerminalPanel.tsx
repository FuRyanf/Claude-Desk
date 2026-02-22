import { useCallback, useEffect, useRef, useState } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { Terminal } from 'xterm';

import { onTerminalData } from '../lib/api';
import { TerminalWriteQueue } from '../lib/terminalWriteQueue';

const INPUT_FLUSH_MS = 8;
const INPUT_CHUNK_SIZE = 4 * 1024;
const RESIZE_DEBOUNCE_MS = 40;
const INITIAL_FIT_RETRY_FRAMES = 12;

interface TerminalPanelProps {
  sessionId?: string | null;
  content: string;
  readOnly?: boolean;
  inputEnabled?: boolean;
  overlayMessage?: string;
  debugEnabled?: boolean;
  onData?: (data: string) => void;
  onOutput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

interface TerminalDebugMetrics {
  ptyEvents: number;
  ptyBytes: number;
  resizeEvents: number;
  queueHighWaterBytes: number;
  lastLogAt: number;
}

function emptyDebugMetrics(): TerminalDebugMetrics {
  return {
    ptyEvents: 0,
    ptyBytes: 0,
    resizeEvents: 0,
    queueHighWaterBytes: 0,
    lastLogAt: 0
  };
}

export function TerminalPanel({
  sessionId = null,
  content,
  readOnly = false,
  inputEnabled = true,
  overlayMessage,
  debugEnabled = false,
  onData,
  onOutput,
  onResize,
  onFocusChange
}: TerminalPanelProps) {
  const [fallback, setFallback] = useState(() => import.meta.env.MODE === 'test');
  const [terminalReady, setTerminalReady] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const contentRef = useRef(content);
  const onDataRef = useRef(onData);
  const onOutputRef = useRef(onOutput);
  const onResizeRef = useRef(onResize);
  const onFocusChangeRef = useRef(onFocusChange);
  const readOnlyRef = useRef(readOnly);
  const inputEnabledRef = useRef(inputEnabled);
  const debugEnabledRef = useRef(debugEnabled);
  const sessionRef = useRef<string | null>(sessionId);
  const hydratedSessionRef = useRef<string | null>(null);
  const hasLiveDataRef = useRef(false);
  const inputBufferRef = useRef('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const resizeDebounceTimerRef = useRef<number | null>(null);
  const initialFitFrameRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const debugMetricsRef = useRef<TerminalDebugMetrics>(emptyDebugMetrics());
  const writeQueueRef = useRef<TerminalWriteQueue>(new TerminalWriteQueue());
  const shouldScrollToBottomRef = useRef(true);

  const logDebugSnapshot = useCallback((reason: string, force = false) => {
    if (!debugEnabledRef.current) {
      return;
    }

    const now = performance.now();
    const metrics = debugMetricsRef.current;
    if (!force && now - metrics.lastLogAt < 850) {
      return;
    }

    const queueStats = writeQueueRef.current.getStats();
    metrics.lastLogAt = now;
    console.info('[TerminalDebug]', {
      reason,
      sessionId: sessionRef.current,
      ptyEvents: metrics.ptyEvents,
      ptyBytes: metrics.ptyBytes,
      resizeEvents: metrics.resizeEvents,
      queuePendingChunks: queueStats.pendingChunks,
      queuePendingBytes: queueStats.pendingBytes,
      queueHighWaterBytes: Math.max(metrics.queueHighWaterBytes, queueStats.highWaterBytes),
      queueWrites: queueStats.totalWrites,
      queueWrittenBytes: queueStats.totalBytesWritten,
      queueWriting: queueStats.writing
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

  const queueWrite = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      writeQueueRef.current.enqueue(data);
      const queueStats = writeQueueRef.current.getStats();
      if (queueStats.highWaterBytes > debugMetricsRef.current.queueHighWaterBytes) {
        debugMetricsRef.current.queueHighWaterBytes = queueStats.highWaterBytes;
      }
      logDebugSnapshot('queue-enqueue');
    },
    [logDebugSnapshot]
  );

  const clearPendingWrites = useCallback(() => {
    writeQueueRef.current.clear();
  }, []);

  const scrollTerminalToBottom = useCallback(() => {
    const term = terminalRef.current;
    if (!term) {
      return;
    }

    shouldScrollToBottomRef.current = false;
    term.scrollToBottom();
    window.requestAnimationFrame(() => {
      terminalRef.current?.scrollToBottom();
    });
  }, []);

  const resetTerminalContent = useCallback(
    (nextContent: string) => {
      const term = terminalRef.current;
      if (!term) {
        return;
      }

      clearPendingWrites();
      term.reset();
      if (nextContent.length > 0) {
        queueWrite(nextContent);
        writeQueueRef.current.flushImmediate();
      }
    },
    [clearPendingWrites, queueWrite]
  );

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

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
    debugEnabledRef.current = debugEnabled;
    if (debugEnabled) {
      debugMetricsRef.current = emptyDebugMetrics();
      logDebugSnapshot('debug-enabled', true);
    }
  }, [debugEnabled, logDebugSnapshot]);

  useEffect(() => {
    if (fallback) {
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;

    const emitResize = (term: Terminal, source: 'init' | 'observer') => {
      const cols = Math.max(term.cols, 2);
      const rows = Math.max(term.rows, 2);
      const previous = lastSentSizeRef.current;
      if (previous && previous.cols === cols && previous.rows === rows) {
        return;
      }
      lastSentSizeRef.current = { cols, rows };
      debugMetricsRef.current.resizeEvents += 1;
      onResizeRef.current?.(cols, rows);
      logDebugSnapshot(`resize-${source}`);
    };

    try {
      const term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        scrollback: 10_000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.28,
        theme: {
          background: '#0b1020',
          foreground: '#e5e7eb'
        },
        disableStdin: readOnlyRef.current || !inputEnabledRef.current
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      terminalRef.current = term;
      writeQueueRef.current.setSink({
        write: (chunk, done) => {
          term.write(chunk, done);
        }
      });

      const applyFitAndResize = (source: 'init' | 'observer') => {
        if (disposed) {
          return;
        }
        fitAddon.fit();
        emitResize(term, source);
      };

      const runInitialFit = (attempt: number) => {
        if (disposed) {
          return;
        }
        const rect = host.getBoundingClientRect();
        if (
          (rect.width < 4 || rect.height < 4) &&
          attempt < INITIAL_FIT_RETRY_FRAMES
        ) {
          initialFitFrameRef.current = window.requestAnimationFrame(() => runInitialFit(attempt + 1));
          return;
        }

        applyFitAndResize('init');
        setTerminalReady(true);
        if (contentRef.current.length > 0) {
          queueWrite(contentRef.current);
        }
        writeQueueRef.current.flushImmediate();
        scrollTerminalToBottom();
        logDebugSnapshot('terminal-ready', true);
      };

      runInitialFit(0);

      const onDataDisposable = term.onData((data) => {
        if (readOnlyRef.current || !inputEnabledRef.current) {
          return;
        }

        inputBufferRef.current += data;
        if (data === '\r' || data === '\x03' || inputBufferRef.current.length >= INPUT_CHUNK_SIZE) {
          if (inputFlushTimerRef.current !== null) {
            window.clearTimeout(inputFlushTimerRef.current);
            inputFlushTimerRef.current = null;
          }
          flushOutgoingInput();
        } else {
          scheduleOutgoingInputFlush();
        }
      });

      const onFocusIn = () => onFocusChangeRef.current?.(true);
      const onFocusOut = () => onFocusChangeRef.current?.(false);
      host.addEventListener('focusin', onFocusIn);
      host.addEventListener('focusout', onFocusOut);

      const scheduleResize = () => {
        if (resizeDebounceTimerRef.current !== null) {
          window.clearTimeout(resizeDebounceTimerRef.current);
        }
        resizeDebounceTimerRef.current = window.setTimeout(() => {
          resizeDebounceTimerRef.current = null;
          applyFitAndResize('observer');
        }, RESIZE_DEBOUNCE_MS);
      };

      const observer = new ResizeObserver(() => {
        scheduleResize();
      });
      observer.observe(host);

      return () => {
        disposed = true;
        setTerminalReady(false);
        observer.disconnect();
        onDataDisposable.dispose();
        host.removeEventListener('focusin', onFocusIn);
        host.removeEventListener('focusout', onFocusOut);
        if (resizeDebounceTimerRef.current !== null) {
          window.clearTimeout(resizeDebounceTimerRef.current);
          resizeDebounceTimerRef.current = null;
        }
        if (initialFitFrameRef.current !== null) {
          window.cancelAnimationFrame(initialFitFrameRef.current);
          initialFitFrameRef.current = null;
        }
        fitAddon.dispose();
        term.dispose();
        terminalRef.current = null;
        writeQueueRef.current.setSink(null);
        clearPendingWrites();
        inputBufferRef.current = '';
        if (inputFlushTimerRef.current !== null) {
          window.clearTimeout(inputFlushTimerRef.current);
          inputFlushTimerRef.current = null;
        }
        lastSentSizeRef.current = null;
        shouldScrollToBottomRef.current = true;
      };
    } catch {
      setFallback(true);
      return;
    }
  }, [
    clearPendingWrites,
    fallback,
    flushOutgoingInput,
    logDebugSnapshot,
    queueWrite,
    scheduleOutgoingInputFlush
  ]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    inputEnabledRef.current = inputEnabled;

    const term = terminalRef.current;
    if (!term) {
      return;
    }

    term.options.disableStdin = readOnly || !inputEnabled;
  }, [inputEnabled, readOnly]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !terminalReady) {
      sessionRef.current = sessionId;
      return;
    }

    if (sessionRef.current === sessionId) {
      return;
    }

    sessionRef.current = sessionId;
    hasLiveDataRef.current = false;
    hydratedSessionRef.current = null;
    shouldScrollToBottomRef.current = true;
    clearPendingWrites();
    inputBufferRef.current = '';
    if (inputFlushTimerRef.current !== null) {
      window.clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }

    resetTerminalContent(contentRef.current);
    if (contentRef.current.length > 0) {
      hydratedSessionRef.current = sessionId;
    }
    scrollTerminalToBottom();
    logDebugSnapshot('session-switch', true);
  }, [clearPendingWrites, logDebugSnapshot, resetTerminalContent, scrollTerminalToBottom, sessionId, terminalReady]);

  useEffect(() => {
    if (!readOnly && sessionId) {
      return;
    }

    const term = terminalRef.current;
    if (!term || !terminalReady) {
      return;
    }

    resetTerminalContent(content);
    shouldScrollToBottomRef.current = true;
    scrollTerminalToBottom();
  }, [content, readOnly, resetTerminalContent, scrollTerminalToBottom, sessionId, terminalReady]);

  useEffect(() => {
    if (fallback || readOnly || !sessionId || !terminalReady) {
      return;
    }

    if (content.length === 0 || hasLiveDataRef.current || hydratedSessionRef.current === sessionId) {
      return;
    }

    const term = terminalRef.current;
    if (!term) {
      return;
    }

    resetTerminalContent(content);
    hydratedSessionRef.current = sessionId;
    writeQueueRef.current.flushImmediate();
    shouldScrollToBottomRef.current = true;
    scrollTerminalToBottom();
    logDebugSnapshot('hydrate-content');
  }, [
    content,
    fallback,
    logDebugSnapshot,
    readOnly,
    resetTerminalContent,
    scrollTerminalToBottom,
    sessionId,
    terminalReady
  ]);

  useEffect(() => {
    if (fallback || readOnly || !sessionId || !terminalReady) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void onTerminalData((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      hasLiveDataRef.current = true;
      debugMetricsRef.current.ptyEvents += 1;
      debugMetricsRef.current.ptyBytes += event.data.length;
      onOutputRef.current?.(event.data);
      queueWrite(event.data);
      if (shouldScrollToBottomRef.current) {
        scrollTerminalToBottom();
      }
      logDebugSnapshot('pty-data');
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
    });

    return () => {
      disposed = true;
      flushOutgoingInput();
      unlisten?.();
    };
  }, [
    fallback,
    flushOutgoingInput,
    logDebugSnapshot,
    queueWrite,
    readOnly,
    scrollTerminalToBottom,
    sessionId,
    terminalReady
  ]);

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
      {overlayMessage ? <div className="terminal-overlay">{overlayMessage}</div> : null}
    </section>
  );
}

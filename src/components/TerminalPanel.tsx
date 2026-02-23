import { useCallback, useEffect, useRef, useState } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { Terminal } from 'xterm';
import { onTerminalData } from '../lib/api';
import { TerminalWriteQueue } from '../lib/terminalWriteQueue';

const INPUT_FLUSH_MS = 8;
const INPUT_CHUNK_SIZE = 4 * 1024;
const OUTPUT_BATCH_BYTES = 48 * 1024;
const STICKY_SCROLL_TOLERANCE = 2;

interface TerminalPanelProps {
  sessionId?: string | null;
  content: string;
  readOnly?: boolean;
  inputEnabled?: boolean;
  overlayMessage?: string;
  onData?: (data: string) => void;
  onOutput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

export function TerminalPanel({
  sessionId = null,
  content,
  readOnly = false,
  inputEnabled = true,
  overlayMessage,
  onData,
  onOutput,
  onResize,
  onFocusChange
}: TerminalPanelProps) {
  const [fallback, setFallback] = useState(() => import.meta.env.MODE === 'test');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const contentRef = useRef(content);
  const onDataRef = useRef(onData);
  const onOutputRef = useRef(onOutput);
  const onResizeRef = useRef(onResize);
  const onFocusChangeRef = useRef(onFocusChange);
  const readOnlyRef = useRef(readOnly);
  const inputEnabledRef = useRef(inputEnabled);
  const previousInputEnabledRef = useRef(inputEnabled);
  const sessionRef = useRef<string | null>(sessionId);
  const hydratedSessionRef = useRef<string | null>(null);
  const hasLiveDataRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const writeQueueRef = useRef(new TerminalWriteQueue({ maxBatchBytes: OUTPUT_BATCH_BYTES }));
  const inputBufferRef = useRef('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  const scrollToBottomSoon = useCallback((term: Terminal) => {
    term.scrollToBottom();
    window.requestAnimationFrame(() => {
      if (terminalRef.current !== term) {
        return;
      }
      term.scrollToBottom();
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

      shouldStickToBottomRef.current = true;
      clearPendingWrites();
      term.reset();
      if (nextContent.length > 0) {
        queueWrite(nextContent);
        writeQueueRef.current.flushImmediate();
      }
      scrollToBottomSoon(term);
    },
    [clearPendingWrites, queueWrite, scrollToBottomSoon]
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
    if (fallback) {
      return;
    }

    const host = hostRef.current;
    if (!host) {
      return;
    }

    try {
      const term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        scrollback: 10_000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.3,
        theme: {
          background: '#0b1020',
          foreground: '#e5e7eb'
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
            if (terminalRef.current === term && shouldStickToBottomRef.current) {
              term.scrollToBottom();
            }
            done();
          });
        }
      });

      const fitAndNotify = () => {
        fitAddon.fit();
        onResizeRef.current?.(term.cols, term.rows);
        if (shouldStickToBottomRef.current) {
          scrollToBottomSoon(term);
        }
      };
      fitAndNotify();
      window.requestAnimationFrame(() => {
        if (terminalRef.current !== term) {
          return;
        }
        fitAndNotify();
      });

      if (contentRef.current.length > 0) {
        shouldStickToBottomRef.current = true;
        queueWrite(contentRef.current);
        writeQueueRef.current.flushImmediate();
      }

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
        const bottom = term.buffer.active.baseY;
        shouldStickToBottomRef.current =
          viewportY >= Math.max(0, bottom - STICKY_SCROLL_TOLERANCE);
      });

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
        host.removeEventListener('focusin', onFocusIn);
        host.removeEventListener('focusout', onFocusOut);
        fitAddon.dispose();
        writeQueueRef.current.setSink(null);
        writeQueueRef.current.clear();
        term.dispose();
        terminalRef.current = null;
        inputBufferRef.current = '';
        if (inputFlushTimerRef.current !== null) {
          window.clearTimeout(inputFlushTimerRef.current);
          inputFlushTimerRef.current = null;
        }
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
      };
    } catch {
      setFallback(true);
      return;
    }
  }, [
    fallback,
    flushOutgoingInput,
    queueWrite,
    scrollToBottomSoon,
    scheduleOutgoingInputFlush
  ]);

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
    if (!wasEnabled && inputEnabled && !readOnly) {
      shouldStickToBottomRef.current = true;
      scrollToBottomSoon(term);
      window.setTimeout(() => {
        if (terminalRef.current !== term) {
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
    hasLiveDataRef.current = false;
    hydratedSessionRef.current = null;
    shouldStickToBottomRef.current = true;
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
  }, [clearPendingWrites, resetTerminalContent, sessionId]);

  useEffect(() => {
    if (!readOnly && sessionId) {
      return;
    }

    const term = terminalRef.current;
    if (!term) {
      return;
    }

    resetTerminalContent(content);
  }, [content, readOnly, resetTerminalContent, sessionId]);

  useEffect(() => {
    if (fallback || readOnly || !sessionId) {
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
  }, [content, fallback, readOnly, resetTerminalContent, sessionId]);

  useEffect(() => {
    if (fallback || readOnly || !sessionId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void onTerminalData((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      hasLiveDataRef.current = true;
      onOutputRef.current?.(event.data);
      queueWrite(event.data);
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
  }, [fallback, flushOutgoingInput, queueWrite, readOnly, sessionId]);

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

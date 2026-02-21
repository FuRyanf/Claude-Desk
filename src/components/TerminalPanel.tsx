import { useCallback, useEffect, useRef, useState } from 'react';

import 'xterm/css/xterm.css';
import { FitAddon } from 'xterm-addon-fit';
import { Terminal } from 'xterm';
import { onTerminalData } from '../lib/api';

interface TerminalPanelProps {
  sessionId?: string | null;
  content: string;
  readOnly?: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

export function TerminalPanel({
  sessionId = null,
  content,
  readOnly = false,
  onData,
  onResize,
  onFocusChange
}: TerminalPanelProps) {
  const [fallback, setFallback] = useState(() => import.meta.env.MODE === 'test');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const contentRef = useRef(content);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onFocusChangeRef = useRef(onFocusChange);
  const readOnlyRef = useRef(readOnly);
  const writeBufferRef = useRef('');
  const flushTimerRef = useRef<number | null>(null);
  const writingRef = useRef(false);

  const flushQueuedWrites = useCallback(() => {
    if (writingRef.current) {
      return;
    }

    const term = terminalRef.current;
    if (!term) {
      writeBufferRef.current = '';
      return;
    }

    const payload = writeBufferRef.current;
    if (payload.length === 0) {
      return;
    }

    writeBufferRef.current = '';
    writingRef.current = true;
    term.write(payload, () => {
      writingRef.current = false;
      if (writeBufferRef.current.length > 0) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          flushQueuedWrites();
        }, 8);
      }
    });
  }, []);

  const queueWrite = useCallback(
    (data: string) => {
      if (data.length === 0) {
        return;
      }

      writeBufferRef.current += data;
      if (flushTimerRef.current !== null) {
        return;
      }
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        flushQueuedWrites();
      }, 8);
    },
    [flushQueuedWrites]
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
        disableStdin: readOnly
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      fitAddon.fit();
      onResizeRef.current?.(term.cols, term.rows);
      if (contentRef.current.length > 0) {
        term.write(contentRef.current);
      }

      const onDataDisposable = term.onData((data) => {
        if (!readOnlyRef.current) {
          onDataRef.current?.(data);
        }
      });

      const onFocusIn = () => onFocusChangeRef.current?.(true);
      const onFocusOut = () => onFocusChangeRef.current?.(false);
      host.addEventListener('focusin', onFocusIn);
      host.addEventListener('focusout', onFocusOut);

      const observer = new ResizeObserver(() => {
        fitAddon.fit();
        onResizeRef.current?.(term.cols, term.rows);
      });
      observer.observe(host);

      terminalRef.current = term;

      return () => {
        observer.disconnect();
        onDataDisposable.dispose();
        host.removeEventListener('focusin', onFocusIn);
        host.removeEventListener('focusout', onFocusOut);
        fitAddon.dispose();
        term.dispose();
        terminalRef.current = null;
        writeBufferRef.current = '';
        writingRef.current = false;
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
      };
    } catch {
      setFallback(true);
      return;
    }
  }, [fallback]);

  useEffect(() => {
    readOnlyRef.current = readOnly;

    const term = terminalRef.current;
    if (!term) {
      return;
    }

    term.options.disableStdin = readOnly;
  }, [readOnly]);

  useEffect(() => {
    if (!readOnly && sessionId) {
      return;
    }

    const term = terminalRef.current;
    if (!term) {
      return;
    }

    term.reset();
    if (content.length > 0) {
      term.write(content);
    }
  }, [content, readOnly, sessionId]);

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
      unlisten?.();
    };
  }, [fallback, queueWrite, readOnly, sessionId]);

  if (fallback) {
    return (
      <section className="terminal-panel">
        <pre className="terminal-fallback">{content}</pre>
      </section>
    );
  }

  return (
    <section className="terminal-panel">
      <div ref={hostRef} className="terminal-host" />
    </section>
  );
}

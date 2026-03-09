import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DECTCEM_HIDE = '\u001b[?25l';
const DECTCEM_SHOW = '\u001b[?25h';

const mocks = vi.hoisted(() => {
  const fit = vi.fn();
  const terminals: Array<{
    open: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
    scrollToLine: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    screenLines: string[];
    wrappedRows: Set<number>;
    buffer: {
      active: {
        baseY: number;
        viewportY: number;
        cursorX: number;
        cursorY: number;
        length: number;
        getLine: (row: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined;
      };
    };
  }> = [];

  const syncBufferState = (term: (typeof terminals)[number]) => {
    const lineCount = Math.max(1, term.screenLines.length);
    term.buffer.active.length = lineCount;
    term.buffer.active.baseY = Math.max(0, lineCount - term.rows);
    term.buffer.active.cursorY = Math.max(0, Math.min(term.rows - 1, lineCount - 1 - term.buffer.active.baseY));
    term.buffer.active.viewportY = term.buffer.active.baseY;
  };

  const writePrintableChunk = (term: (typeof terminals)[number], chunk: string) => {
    if (term.screenLines.length === 0) {
      term.screenLines.push('');
    }

    let absoluteRow = term.buffer.active.baseY + term.buffer.active.cursorY;
    let cursorX = term.buffer.active.cursorX;

    const ensureRow = (row: number) => {
      while (term.screenLines.length <= row) {
        term.screenLines.push('');
      }
    };

    const writeChar = (char: string) => {
      ensureRow(absoluteRow);
      const current = term.screenLines[absoluteRow] ?? '';
      const padded = cursorX > current.length ? current.padEnd(cursorX, ' ') : current;
      if (cursorX >= padded.length) {
        term.screenLines[absoluteRow] = `${padded}${char}`;
      } else {
        term.screenLines[absoluteRow] = `${padded.slice(0, cursorX)}${char}${padded.slice(cursorX + 1)}`;
      }
      cursorX += 1;
    };

    for (const char of chunk) {
      if (char === '\n') {
        absoluteRow += 1;
        cursorX = 0;
        ensureRow(absoluteRow);
        continue;
      }
      if (char === '\r') {
        cursorX = 0;
        continue;
      }
      if (char === '\u001b') {
        continue;
      }
      writeChar(char);
    }

    term.buffer.active.cursorX = cursorX;
    syncBufferState(term);
    const nextAbsoluteRow = Math.max(0, term.screenLines.length - 1);
    term.buffer.active.cursorY = Math.max(0, Math.min(term.rows - 1, nextAbsoluteRow - term.buffer.active.baseY));
  };

  const createTerminal = () => {
    const term = {
      open: vi.fn((host: HTMLElement) => {
        const viewport = document.createElement('div');
        viewport.className = 'xterm-viewport';
        host.appendChild(viewport);
      }),
      loadAddon: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((chunk: string, callback?: () => void) => {
        const cursorMove = /^\u001b\[(\d+);(\d+)H$/.exec(chunk);
        if (cursorMove) {
          term.buffer.active.cursorY = Math.max(0, Number(cursorMove[1]) - 1);
          term.buffer.active.cursorX = Math.max(0, Number(cursorMove[2]) - 1);
          callback?.();
          return;
        }
        writePrintableChunk(term, chunk);
        callback?.();
      }),
      refresh: vi.fn(),
      reset: vi.fn(() => {
        term.screenLines = [''];
        term.wrappedRows.clear();
        term.buffer.active.cursorX = 0;
        syncBufferState(term);
      }),
      resize: vi.fn((cols: number, rows: number) => {
        term.cols = cols;
        term.rows = rows;
        syncBufferState(term);
      }),
      scrollToBottom: vi.fn(() => {
        term.buffer.active.viewportY = term.buffer.active.baseY;
      }),
      scrollToLine: vi.fn((line: number) => {
        term.buffer.active.viewportY = line;
      }),
      focus: vi.fn(),
      dispose: vi.fn(),
      options: {},
      cols: 80,
      rows: 24,
      screenLines: [''],
      wrappedRows: new Set<number>(),
      buffer: {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 1,
          getLine: (row: number) => {
            const value = term.screenLines[row];
            if (typeof value !== 'string') {
              return undefined;
            }
            return {
              isWrapped: term.wrappedRows.has(row),
              translateToString: (trimRight?: boolean) => (trimRight ? value.replace(/\s+$/u, '') : value)
            };
          }
        }
      }
    };
    syncBufferState(term);
    terminals.push(term);
    return term;
  };

  return {
    createTerminal,
    fit,
    terminals
  };
});

vi.mock('../../src/lib/api', () => ({
  api: {
    openExternalUrl: vi.fn(async () => undefined)
  }
}));

vi.mock('xterm', () => ({
  Terminal: vi.fn(() => mocks.createTerminal())
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: mocks.fit,
    dispose: vi.fn()
  }))
}));

vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({}))
}));

import { TerminalPanel } from '../../src/components/TerminalPanel';

describe('TerminalPanel manual repair', () => {
  beforeEach(() => {
    (globalThis as { __CLAUDE_DESK_ENABLE_XTERM_TESTS__?: boolean }).__CLAUDE_DESK_ENABLE_XTERM_TESTS__ = true;
    mocks.fit.mockClear();
    mocks.terminals.length = 0;

    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
      } as typeof ResizeObserver;
    }
  });

  afterEach(() => {
    delete (globalThis as { __CLAUDE_DESK_ENABLE_XTERM_TESTS__?: boolean }).__CLAUDE_DESK_ENABLE_XTERM_TESTS__;
  });

  it('rebuilds the xterm buffer from the latest content when a repair is requested', async () => {
    const content = 'line 1\nline 2\nline 3';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(firstTerm.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });
  });

  it('replays the raw terminal log on manual repair without injecting extra cursor movement', async () => {
    const rawContent = '> Try again';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={rawContent}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    firstTerm.screenLines = ['> Try again'];
    firstTerm.wrappedRows.clear();
    firstTerm.buffer.active.cursorX = 5;

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={rawContent}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.write).toHaveBeenCalledWith(rawContent, expect.any(Function));
    });
    expect(
      repairedTerm.write.mock.calls.some(
        ([chunk]) => typeof chunk === 'string' && /^\u001b\[\d+;\d+H$/u.test(chunk)
      )
    ).toBe(false);

    repairedTerm.write.mockClear();
    repairedTerm.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={`${rawContent}!`}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(repairedTerm.write).toHaveBeenCalledWith('!', expect.any(Function));
      expect(repairedTerm.reset).not.toHaveBeenCalled();
    });
  });

  it('hides the xterm cursor for Claude-style interactive sessions on mount and reset', async () => {
    const content = '> prompt';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(DECTCEM_HIDE);
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    firstTerm.write.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-2"
        content={content}
        readOnly={false}
        inputEnabled
        cursorVisible={false}
      />
    );

    await waitFor(() => {
      expect(firstTerm.reset).toHaveBeenCalled();
      expect(firstTerm.write).toHaveBeenCalledWith(DECTCEM_HIDE);
    });
  });

  it('keeps the xterm cursor visible by default for shell-style sessions', async () => {
    render(
      <TerminalPanel
        sessionId="session-1"
        content="shell prompt"
        readOnly={false}
        inputEnabled
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(DECTCEM_SHOW);
    });
    expect(firstTerm.write).not.toHaveBeenCalledWith(DECTCEM_HIDE);
  });

  it('restores the viewport when the user was scrolled up during repair', async () => {
    const content = Array.from({ length: 32 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container, rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    const firstTerm = mocks.terminals[0];
    await waitFor(() => {
      expect(firstTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    firstTerm.buffer.active.viewportY = 4;

    const host = container.querySelector('.terminal-host');
    expect(host).not.toBeNull();
    fireEvent.wheel(host as HTMLElement, { deltaY: -32 });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(2);
    });

    const repairedTerm = mocks.terminals[1];
    await waitFor(() => {
      expect(repairedTerm.scrollToLine).toHaveBeenCalledWith(4);
    });
  });

  it('keeps the final terminal instance consistent across repeated repair requests', async () => {
    const content = 'line 1\nline 2\nline 3';
    const { rerender } = render(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={0}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals).toHaveLength(1);
    });

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={1}
      />
    );
    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={content}
        readOnly={false}
        inputEnabled
        repairRequestId={2}
      />
    );

    await waitFor(() => {
      expect(mocks.terminals.length).toBeGreaterThanOrEqual(2);
    });

    const finalTerm = mocks.terminals[mocks.terminals.length - 1];
    await waitFor(() => {
      expect(finalTerm.write).toHaveBeenCalledWith(content, expect.any(Function));
    });

    finalTerm.write.mockClear();
    finalTerm.reset.mockClear();

    rerender(
      <TerminalPanel
        sessionId="session-1"
        content={`${content}\nline 4`}
        readOnly={false}
        inputEnabled
        repairRequestId={2}
      />
    );

    await waitFor(() => {
      expect(finalTerm.write).toHaveBeenCalledWith('\nline 4', expect.any(Function));
      expect(finalTerm.reset).not.toHaveBeenCalled();
    });
  });
});

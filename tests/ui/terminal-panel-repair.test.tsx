import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    buffer: {
      active: {
        baseY: number;
        viewportY: number;
      };
    };
  }> = [];

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
        term.buffer.active.baseY = Math.max(0, chunk.split('\n').length - 1);
        term.buffer.active.viewportY = term.buffer.active.baseY;
        callback?.();
      }),
      refresh: vi.fn(),
      reset: vi.fn(),
      resize: vi.fn((cols: number, rows: number) => {
        term.cols = cols;
        term.rows = rows;
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
      buffer: {
        active: {
          baseY: 0,
          viewportY: 0
        }
      }
    };
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

  it('restores the viewport when the user was scrolled up during repair', async () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
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

    firstTerm.buffer.active.baseY = 11;
    firstTerm.buffer.active.viewportY = 7;

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
      expect(repairedTerm.scrollToLine).toHaveBeenCalledWith(7);
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

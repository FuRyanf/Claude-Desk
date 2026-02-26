import { describe, expect, it } from 'vitest';

import {
  createFollowState,
  handleTerminalScroll,
  jumpToLatest,
  shouldAutoFollow
} from '../../src/lib/terminalFollowState';

describe('terminal follow state', () => {
  it('pauses follow mode when viewport moves off-bottom during active streaming', () => {
    let state = createFollowState();
    state = handleTerminalScroll(state, { viewportY: 120, baseY: 120 });
    state = handleTerminalScroll(state, { viewportY: 90, baseY: 120 });

    expect(state.mode).toBe('pausedByUser');
    expect(shouldAutoFollow(state)).toBe(false);
  });

  it('stays paused on at-bottom scroll events until user explicitly jumps to latest', () => {
    let state = createFollowState();
    state = handleTerminalScroll(state, { viewportY: 50, baseY: 200 }); // scroll up → paused
    expect(state.mode).toBe('pausedByUser');

    // Programmatic or incidental at-bottom events should not auto-resume.
    state = handleTerminalScroll(state, { viewportY: 200, baseY: 200 });
    expect(state.mode).toBe('pausedByUser');
    expect(shouldAutoFollow(state)).toBe(false);
  });

  it('stays paused when buffer grows but viewport stays at same relative offset', () => {
    // A resize or buffer growth that keeps the viewport at the same relative distance from
    // the bottom should not resume follow. viewportY and baseY advance together.
    let state = createFollowState();
    state = handleTerminalScroll(state, { viewportY: 100, baseY: 200 }); // 100 lines from bottom → paused
    expect(state.mode).toBe('pausedByUser');

    // Buffer grows by 10 lines; viewport stays at same position (viewportY unchanged)
    // baseY increases but viewportY < baseY so still not at bottom
    state = handleTerminalScroll(state, { viewportY: 100, baseY: 210 });
    expect(state.mode).toBe('pausedByUser');
    expect(shouldAutoFollow(state)).toBe(false);
  });

  it('stays paused through high-rate stream growth until user explicitly jumps to latest', () => {
    let state = createFollowState();
    state = handleTerminalScroll(state, { viewportY: 80, baseY: 120 });
    expect(state.mode).toBe('pausedByUser');

    for (let baseY = 121; baseY <= 260; baseY += 1) {
      state = handleTerminalScroll(state, { viewportY: 80, baseY });
      expect(state.mode).toBe('pausedByUser');
      expect(shouldAutoFollow(state)).toBe(false);
    }

    state = jumpToLatest(state, { baseY: 260 });
    expect(state.mode).toBe('following');
    expect(state.viewportY).toBe(260);
    expect(shouldAutoFollow(state)).toBe(true);
  });
});

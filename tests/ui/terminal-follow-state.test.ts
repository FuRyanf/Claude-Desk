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

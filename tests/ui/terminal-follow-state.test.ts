import { describe, expect, it } from 'vitest';

import {
  createFollowState,
  handleTerminalScroll,
  jumpToLatest,
  pauseFollowByUser,
  shouldAutoFollow
} from '../../src/lib/terminalFollowState';

describe('terminal follow state', () => {
  it('updates coordinates without changing mode — pausedByUser requires explicit user gesture', () => {
    // handleTerminalScroll is purely a coordinate tracker.
    // A viewport moving off-bottom via a system scroll (write rAF, programmatic scroll) must NOT
    // pause follow; only explicit user gestures wired in TerminalPanel do that.
    let state = createFollowState();
    state = handleTerminalScroll(state, { viewportY: 120, baseY: 120 });
    state = handleTerminalScroll(state, { viewportY: 90, baseY: 120 });

    expect(state.mode).toBe('following');
    expect(state.viewportY).toBe(90);
    expect(state.baseY).toBe(120);
    expect(shouldAutoFollow(state)).toBe(true);
  });

  it('resumes follow once a paused viewport is scrolled back to the latest line', () => {
    let state = createFollowState();
    // Simulate explicit user gesture pausing (wheel/PageUp/scrollbar drag detected in TerminalPanel).
    state = pauseFollowByUser(state);
    expect(state.mode).toBe('pausedByUser');

    // Once the viewport reaches the bottom again, resume follow and hide the affordance.
    state = handleTerminalScroll(state, { viewportY: 200, baseY: 200 });
    expect(state.mode).toBe('following');
    expect(shouldAutoFollow(state)).toBe(true);
  });

  it('stays paused when buffer grows but viewport stays at same relative offset', () => {
    let state = createFollowState();
    state = pauseFollowByUser(state);
    expect(state.mode).toBe('pausedByUser');

    // Buffer grows by 10 lines; viewport stays at same position.
    state = handleTerminalScroll(state, { viewportY: 100, baseY: 210 });
    expect(state.mode).toBe('pausedByUser');
    expect(shouldAutoFollow(state)).toBe(false);
  });

  it('stays paused through high-rate stream growth until user explicitly jumps to latest', () => {
    let state = createFollowState();
    state = pauseFollowByUser(state);
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

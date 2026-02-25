export type TerminalFollowMode = 'following' | 'pausedByUser';

export interface TerminalFollowState {
  mode: TerminalFollowMode;
  viewportY: number;
  baseY: number;
}

interface TerminalScrollEvent {
  viewportY: number;
  baseY: number;
}

interface JumpToLatestEvent {
  baseY: number;
}

export function createFollowState(): TerminalFollowState {
  return {
    mode: 'following',
    viewportY: 0,
    baseY: 0
  };
}

export function shouldAutoFollow(state: TerminalFollowState): boolean {
  return state.mode === 'following';
}

export function pauseFollowByUser(state: TerminalFollowState): TerminalFollowState {
  if (state.mode === 'pausedByUser') {
    return state;
  }
  return {
    ...state,
    mode: 'pausedByUser'
  };
}

export function handleTerminalScroll(state: TerminalFollowState, event: TerminalScrollEvent): TerminalFollowState {
  const next = {
    ...state,
    viewportY: event.viewportY,
    baseY: event.baseY
  };
  const atBottom = event.viewportY >= Math.max(0, event.baseY);
  const viewportMoved = event.viewportY !== state.viewportY;

  if (state.mode === 'following') {
    if (!atBottom && viewportMoved) {
      return {
        ...next,
        mode: 'pausedByUser'
      };
    }
    return next;
  }

  if (atBottom) {
    return {
      ...next,
      mode: 'following'
    };
  }

  return next;
}

export function jumpToLatest(state: TerminalFollowState, event: JumpToLatestEvent): TerminalFollowState {
  return {
    ...state,
    mode: 'following',
    baseY: event.baseY,
    viewportY: event.baseY
  };
}

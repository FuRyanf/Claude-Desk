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
  // Only updates coordinates — pausedByUser transitions are controlled exclusively by
  // explicit user gestures (wheel, scrollbar drag, PageUp) detected in TerminalPanel.
  // This prevents xterm's deferred rAF viewport updates from causing false pauses.
  return {
    ...state,
    viewportY: event.viewportY,
    baseY: event.baseY
  };
}

export function jumpToLatest(state: TerminalFollowState, event: JumpToLatestEvent): TerminalFollowState {
  return {
    ...state,
    mode: 'following',
    baseY: event.baseY,
    viewportY: event.baseY
  };
}

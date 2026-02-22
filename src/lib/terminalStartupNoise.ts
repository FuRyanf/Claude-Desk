const DEFAULT_SUPPRESS_WINDOW_CHARS = 32 * 1024;

const STARTUP_LINE_PATTERNS: RegExp[] = [
  /(^|[\r\n])[ \t]*(?:this is claude(?: code)?)[^\r\n]*(?=$|[\r\n])/gi,
  /(^|[\r\n])[ \t]*(?:claude(?: code)?[ \t]*[0-9]+(?:\.[0-9]+)*)[^\r\n]*(?=$|[\r\n])/gi,
  /(^|[\r\n])[ \t]*type[ \t]+[^\r\n]*(?=$|[\r\n])/gi,
  /(^|[\r\n])[ \t]*use[ \t]+\/[^\r\n]*(?=$|[\r\n])/gi,
  /(^|[\r\n])[ \t]*[^\r\n]*shift\+tab[^\r\n]*(?=$|[\r\n])/gi
];

export interface TerminalStartupNoiseSuppressor {
  enabled: boolean;
  remainingChars: number;
}

function stripStartupLines(text: string): string {
  let next = text;
  for (const pattern of STARTUP_LINE_PATTERNS) {
    next = next.replace(pattern, '$1');
  }
  return next;
}

export function createTerminalStartupNoiseSuppressor(
  enabled: boolean,
  windowChars = DEFAULT_SUPPRESS_WINDOW_CHARS
): TerminalStartupNoiseSuppressor {
  return {
    enabled,
    remainingChars: Math.max(windowChars, 0)
  };
}

export function filterTerminalStartupNoiseChunk(
  suppressor: TerminalStartupNoiseSuppressor,
  chunk: string
): string {
  if (!chunk || !suppressor.enabled) {
    return chunk;
  }

  suppressor.remainingChars = Math.max(0, suppressor.remainingChars - chunk.length);
  if (suppressor.remainingChars === 0) {
    suppressor.enabled = false;
  }

  return stripStartupLines(chunk);
}

export function stripTerminalStartupNoiseSnapshot(text: string): string {
  if (!text) {
    return text;
  }
  return stripStartupLines(text);
}

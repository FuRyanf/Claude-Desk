export interface PendingSnapshotHydration {
  threadId: string;
  bufferedLive: string;
}

export function appendBufferedLive(bufferedLive: string, chunk: string, maxChars: number): string {
  if (!chunk) {
    return bufferedLive;
  }
  const combined = `${bufferedLive}${chunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(combined.length - maxChars);
}

function buildLps(pattern: string): number[] {
  const lps = new Array<number>(pattern.length).fill(0);
  let length = 0;
  let index = 1;
  while (index < pattern.length) {
    if (pattern[index] === pattern[length]) {
      length += 1;
      lps[index] = length;
      index += 1;
      continue;
    }
    if (length !== 0) {
      length = lps[length - 1];
      continue;
    }
    lps[index] = 0;
    index += 1;
  }
  return lps;
}

export function findSuffixPrefixOverlap(text: string, pattern: string): number {
  if (!text || !pattern) {
    return 0;
  }
  const lps = buildLps(pattern);
  let matched = 0;

  for (let index = 0; index < text.length; index += 1) {
    while (matched > 0 && text[index] !== pattern[matched]) {
      matched = lps[matched - 1];
    }
    if (text[index] === pattern[matched]) {
      matched += 1;
      if (matched === pattern.length && index < text.length - 1) {
        matched = lps[matched - 1];
      }
    }
  }
  return matched;
}

export function mergeSnapshotAndBufferedLive(snapshot: string, bufferedLive: string): string {
  if (!snapshot) {
    return bufferedLive;
  }
  if (!bufferedLive) {
    return snapshot;
  }
  const overlap = findSuffixPrefixOverlap(snapshot, bufferedLive);
  if (overlap === 0) {
    return bufferedLive;
  }
  return `${snapshot}${bufferedLive.slice(overlap)}`;
}

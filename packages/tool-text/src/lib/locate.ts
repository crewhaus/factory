/**
 * Offset bookkeeping shared by every tool that reports where something was
 * found. Kept in one place so "line 12, column 3" means the same thing
 * whether it came from a regex match or an entity scan.
 */

/** Byte offsets at which each line starts, so an offset maps to a line. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Turn a 0-based offset into a 1-based {line, column} by binary search. */
export function offsetToLineCol(
  starts: ReadonlyArray<number>,
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
}

/**
 * The token estimate used across this package.
 *
 * Four characters per token is the well-worn heuristic for English prose and
 * is deliberately NOT a real tokenizer: a real BPE would make the answer
 * depend on a vocabulary file, which is the kind of hidden state that stops
 * a tool being reproducible. Callers needing exactness should measure with
 * their provider's own counter.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Lowercase word tokens — the shared basis for keyword and token measures. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((t) => t.length > 0);
}

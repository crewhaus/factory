/**
 * "Did you mean" for a failed enum check.
 *
 * A gate that says `"complet" is not allowed` costs someone a minute; one
 * that says `did you mean "completed"?` costs them nothing. That is the whole
 * purpose of this file — it never changes a verdict, only the message.
 */

/**
 * Optimal string alignment distance: Levenshtein plus a transposition of two
 * adjacent characters as a single edit, so `opne` is one edit from `open`
 * rather than two. That matters here because transposition is the most common
 * typo and the one a plain Levenshtein threshold misses.
 *
 * Counted in UTF-16 units, so an astral character counts as two. It is the
 * *restricted* variant: a substring is not edited twice, which is why this is
 * called optimal string alignment rather than Damerau-Levenshtein.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Three rows: two back, one back, and the one being filled.
  let twoBack = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (previous[j - 1] as number) + cost,
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + 1);
      }
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
    current = new Array<number>(b.length + 1).fill(0);
  }
  return previous[b.length] as number;
}

/**
 * The closest candidate to `value`, or `null` when nothing is close enough.
 * "Close enough" is an edit distance within a third of the longer string,
 * which catches a typo or a case difference and rejects an unrelated word.
 * Ties go to the earliest candidate, so the result is stable.
 */
export function closestMatch(value: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(value.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === null) return null;
  const tolerance = Math.max(1, Math.floor(Math.max(value.length, best.length) / 3));
  return bestDistance <= tolerance ? best : null;
}

/**
 * A global pattern's matches, in order, with the pattern tried (sticky) only
 * where `canStart` says a match may begin, and, after a try that fails at
 * `at`, not again before `failedTo(text, at)`.
 *
 * For a pattern whose first part scans ahead an unbounded way (an import
 * clause up to `from`, a brace list up to `}`), a global search that fails
 * at one start moves one character right and scans the same stretch again
 * from the next start inside it: quadratic in the stretch's length. Where
 * every later start inside the stretch would read to the same end and the
 * same text after it, it fails too; `failedTo` names where that stops being
 * true, and the matches are the global pattern's, start for start. After a
 * match the next try is at its end (one further for an empty match), as
 * `lastIndex` would be.
 */
export function* matchAllSkipping(
  text: string,
  pattern: RegExp,
  canStart: (text: string, at: number) => boolean,
  failedTo: (text: string, at: number) => number,
): Generator<RegExpExecArray> {
  const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}y`);
  let at = 0;
  while (at <= text.length) {
    if (!canStart(text, at)) {
      at++;
      continue;
    }
    re.lastIndex = at;
    const m = re.exec(text);
    if (m !== null) {
      yield m;
      at += Math.max(1, m[0].length);
      continue;
    }
    at = Math.max(at + 1, failedTo(text, at));
  }
}

/** A code unit `\w` matches. */
function isWordUnit(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f
  );
}

/** Whether `word` starts at `at` on a word boundary (`\bword`). */
export function wordAt(word: string): (text: string, at: number) => boolean {
  return (text, at) =>
    text.startsWith(word, at) && (at === 0 || !isWordUnit(text.charCodeAt(at - 1)));
}

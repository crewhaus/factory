/**
 * The matches of `/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g` in a
 * text, found without the regex engine.
 *
 * The pattern may start at every word boundary inside a run of local-part
 * characters, and from each one it reads to the end of the run (and over the
 * domain after an `@`) before it fails, so a run like `a-a-a-…` took time
 * quadratic in it: 40 000 characters, a second and a half. The text is
 * whatever is being graded or redacted: agent output, transcripts, ratings.
 *
 * Every start inside one run reaches the same end, the same `@` and the same
 * domain, so they all succeed or all fail together and the first of them is
 * the match. The scan checks each run and domain once, and returns exactly
 * the matches `matchAll` returns; email-scan.test.ts compares them.
 */

/** `[A-Za-z0-9_]`: a `\b` word character. */
const isWordChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

/** `[A-Za-z0-9._%+-]`: a local-part character. */
const isLocalChar = (code: number): boolean =>
  isWordChar(code) || code === 0x2e || code === 0x25 || code === 0x2b || code === 0x2d;

/** `[A-Za-z0-9.-]`: a domain character. */
const isDomainChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2e ||
  code === 0x2d;

const isLetter = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);

/** `\b` at `at`: a word character on exactly one side. */
const isBoundary = (text: string, at: number): boolean =>
  isWordChar(text.charCodeAt(at - 1)) !== isWordChar(text.charCodeAt(at));

/**
 * Where `[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b` ends when matched at `from`, or -1.
 * The greedy domain run gives characters back from its end, so the match
 * ends after the letters following the last `.` that has at least two of
 * them and no word character right after.
 */
function domainEnd(text: string, from: number): number {
  let run = from;
  while (run < text.length && isDomainChar(text.charCodeAt(run))) run++;
  for (let dot = run - 1; dot > from; dot--) {
    if (text.charCodeAt(dot) !== 0x2e /* . */) continue;
    let end = dot + 1;
    while (isLetter(text.charCodeAt(end))) end++;
    if (end - dot - 1 >= 2 && !isWordChar(text.charCodeAt(end))) return end;
  }
  return -1;
}

export type EmailMatch = { readonly index: number; readonly value: string };

/** Every match of the email pattern in `text`, in order, as `matchAll` finds them. */
export function emailMatches(text: string): EmailMatch[] {
  const matches: EmailMatch[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("@", from);
    if (at === -1) return matches;
    const end = domainEnd(text, at + 1);
    if (end !== -1) {
      let local = at;
      while (local > from && isLocalChar(text.charCodeAt(local - 1))) local--;
      let start = local;
      while (start < at && !isBoundary(text, start)) start++;
      if (start < at) {
        matches.push({ index: start, value: text.slice(start, end) });
        from = end;
        continue;
      }
    }
    from = at + 1;
  }
}

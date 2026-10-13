/**
 * Masking reads that look at each character a bounded number of times. Each
 * replaces a pattern that rescanned a run from every position in it, and so
 * took time quadratic in a run in a document this manager serves: a
 * transcript, a log, a wiki page, all of it text a model or a tool wrote, up
 * to MAX_TEXT_BYTES (about 40 seconds for one 256 KiB run). Each does exactly
 * what its pattern did; linear-mask.test.ts compares them.
 */

const isQuerySeparator = (code: number): boolean =>
  code === 0x3f /* ? */ || code === 0x26 /* & */ || code === 0x3b; /* ; */

const isPairBreak = (code: number): boolean => code === 0x26 /* & */ || code === 0x3b; /* ; */

/**
 * `query.replace(/([?&;])([^=&;]*)=([^&;]*)/g, replace)`.
 *
 * A pair starts at a `?`, `&` or `;` and its name runs to the first `=`, `&`
 * or `;` after it. When that is not `=`, every `?` before it meets the same
 * end and fails the same way, so the search resumes there: a run of `?` with
 * no `=` is read once, where the pattern read the rest of it from every `?`.
 */
export function replaceQueryPairs(
  query: string,
  replace: (whole: string, sep: string, name: string, value: string) => string,
): string {
  let out = "";
  let kept = 0;
  let from = 0;
  const end = query.length;
  for (;;) {
    let sep = from;
    while (sep < end && !isQuerySeparator(query.charCodeAt(sep))) sep++;
    if (sep >= end) break;
    let eq = sep + 1;
    while (
      eq < end &&
      query.charCodeAt(eq) !== 0x3d /* = */ &&
      !isPairBreak(query.charCodeAt(eq))
    ) {
      eq++;
    }
    if (eq < end && query.charCodeAt(eq) === 0x3d /* = */) {
      let stop = eq + 1;
      while (stop < end && !isPairBreak(query.charCodeAt(stop))) stop++;
      out +=
        query.slice(kept, sep) +
        replace(
          query.slice(sep, stop),
          query.charAt(sep),
          query.slice(sep + 1, eq),
          query.slice(eq + 1, stop),
        );
      kept = stop;
      from = stop;
    } else {
      from = eq;
    }
  }
  return kept === 0 ? query : out + query.slice(kept);
}

const BEGIN = "-----BEGIN ";
const END = "-----END ";
const TAIL = "PRIVATE KEY";
const DASHES = "-----";

const isHeaderChar = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) /* A-Z */ ||
  (code >= 0x30 && code <= 0x39) /* 0-9 */ ||
  code === 0x20;

/**
 * Where `<word>[A-Z0-9 ]*PRIVATE KEY-----` ends when it matches at `at`, or
 * -1. `PRIVATE KEY` is itself made of header characters and the `-` after it
 * is not one, so it must end the run of them, with the dashes right after.
 */
function headerEnd(text: string, at: number, word: string): number {
  if (!text.startsWith(word, at)) return -1;
  const from = at + word.length;
  let run = from;
  while (run < text.length && isHeaderChar(text.charCodeAt(run))) run++;
  if (run - from < TAIL.length || !text.startsWith(TAIL, run - TAIL.length)) return -1;
  return text.startsWith(DASHES, run) ? run + DASHES.length : -1;
}

/**
 * `text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement)`
 * for a replacement with no `$` in it.
 *
 * A block runs from a BEGIN line to the first END line after it. When a
 * BEGIN line has no END line after it, no later one does either, so the
 * search stops: a document of BEGIN lines is read once, where the pattern
 * read the rest of it from every one.
 */
export function replacePrivateKeyBlocks(text: string, replacement: string): string {
  let out = "";
  let kept = 0;
  let from = 0;
  for (;;) {
    const begin = text.indexOf(BEGIN, from);
    if (begin === -1) break;
    const body = headerEnd(text, begin, BEGIN);
    if (body === -1) {
      from = begin + 1;
      continue;
    }
    let close = -1;
    for (let end = text.indexOf(END, body); end !== -1; end = text.indexOf(END, end + 1)) {
      close = headerEnd(text, end, END);
      if (close !== -1) break;
    }
    if (close === -1) break;
    out += text.slice(kept, begin) + replacement;
    kept = close;
    from = close;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

/**
 * Whether `line` holds a line break other than `\n`. `.` does not match one,
 * so a pattern that ends `(.*)$` cannot match such a line, but it learns that
 * only after giving back every character of a run before it, one at a time.
 */
export function hasLineBreak(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

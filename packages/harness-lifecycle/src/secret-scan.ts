/**
 * Scans for the three knowledge-secret patterns the regex engine runs in
 * quadratic time (knowledge-sync.ts). Each finds what its pattern finds,
 * reading each character a bounded number of times; secret-scan.test.ts
 * compares them. A pushed memory is model-written and uncapped, a pulled one
 * up to 64 KiB, and on a run like `a-a-a-…` the patterns took seconds.
 */

export type SecretMatch = { readonly index: number; readonly value: string };

/** `[A-Za-z0-9_]`: a `\b` word character. */
const isWordChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

/** `\b` at `at`: a word character on exactly one side. */
const isBoundary = (text: string, at: number): boolean =>
  isWordChar(text.charCodeAt(at - 1)) !== isWordChar(text.charCodeAt(at));

/**
 * Where `-----<word> [^-]+-----` ends at `at`, or -1. The name runs to the
 * first `-`, and the dashes must start there.
 */
function pemLineEnd(text: string, at: number, word: string): number {
  const lead = `-----${word} `;
  if (!text.startsWith(lead, at)) return -1;
  const from = at + lead.length;
  const dash = text.indexOf("-", from);
  return dash > from && text.startsWith("-----", dash) ? dash + 5 : -1;
}

/**
 * `/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g`: a block runs from a
 * BEGIN line to the first END line after it. When a BEGIN line has none
 * after it no later one does either, so the scan stops, where the pattern
 * read the rest of the text from every BEGIN line.
 */
export function pemBlockMatches(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  let from = 0;
  for (;;) {
    const begin = text.indexOf("-----BEGIN ", from);
    if (begin === -1) return matches;
    const body = pemLineEnd(text, begin, "BEGIN");
    if (body === -1) {
      from = begin + 1;
      continue;
    }
    let close = -1;
    for (
      let end = text.indexOf("-----END ", body);
      end !== -1;
      end = text.indexOf("-----END ", end + 1)
    ) {
      close = pemLineEnd(text, end, "END");
      if (close !== -1) break;
    }
    if (close === -1) return matches;
    matches.push({ index: begin, value: text.slice(begin, close) });
    from = close;
  }
}

/** `[A-Za-z0-9_-]`: a base64url character. */
const isTokenChar = (code: number): boolean => isWordChar(code) || code === 0x2d;

function tokenRunEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && isTokenChar(text.charCodeAt(end))) end++;
  return end;
}

/**
 * `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g`.
 *
 * Each segment runs to the end of its run of base64url characters (`.` is
 * not one); the last ends at the last word boundary at least ten characters
 * in. Every `eyJ` in one run sees the same runs after it and a shorter first
 * segment, so when the first fails they all do, and the scan resumes after
 * the run, where the pattern read it again from each (`eyJ-eyJ-…`).
 */
export function jwtMatches(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  let from = 0;
  for (;;) {
    let start = text.indexOf("eyJ", from);
    while (start !== -1 && !isBoundary(text, start)) start = text.indexOf("eyJ", start + 1);
    if (start === -1) return matches;
    const first = tokenRunEnd(text, start + 3);
    let end = -1;
    if (first - (start + 3) >= 10 && text.charCodeAt(first) === 0x2e) {
      const second = tokenRunEnd(text, first + 1);
      if (second - (first + 1) >= 10 && text.charCodeAt(second) === 0x2e) {
        const third = tokenRunEnd(text, second + 1);
        for (let at = third; at >= second + 11; at--) {
          if (isBoundary(text, at)) {
            end = at;
            break;
          }
        }
      }
    }
    if (end !== -1) {
      matches.push({ index: start, value: text.slice(start, end) });
      from = end;
    } else {
      from = first + 1;
    }
  }
}

/** `[A-Za-z0-9+/_-]`. */
const isEntropyChar = (code: number): boolean =>
  isTokenChar(code) || code === 0x2b || code === 0x2f;

const isLetter = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/**
 * `/\b(?=[A-Za-z0-9+/_-]*[A-Za-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{32,}\b/.test(text)`.
 *
 * From a start, both lookaheads and the run read to the end of the same run
 * of these characters, and the pattern tried every word boundary in it
 * (`a-a-a-…`: two and a half seconds for 40 000 characters). An earlier start
 * sees more of the run, so the run's first word boundary is its best start:
 * the run qualifies when, from there, it holds a letter and a digit, is at
 * least 32 characters long, and has a word boundary 32 or more characters in.
 */
export function hasHighEntropyToken(text: string): boolean {
  let at = 0;
  while (at < text.length) {
    if (!isEntropyChar(text.charCodeAt(at))) {
      at++;
      continue;
    }
    let end = at;
    while (end < text.length && isEntropyChar(text.charCodeAt(end))) end++;
    let start = at;
    while (start < end && !isBoundary(text, start)) start++;
    if (start < end && end - start >= 32) {
      let letter = false;
      let digit = false;
      for (let k = start; k < end && !(letter && digit); k++) {
        const code = text.charCodeAt(k);
        if (isLetter(code)) letter = true;
        else if (isDigit(code)) digit = true;
      }
      if (letter && digit) {
        for (let k = end; k >= start + 32; k--) {
          if (isBoundary(text, k)) return true;
        }
      }
    }
    at = end;
  }
  return false;
}

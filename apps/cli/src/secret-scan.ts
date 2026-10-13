/**
 * Scans for the two candidate-secret patterns the regex engine runs in
 * quadratic time over a tool result (security-corpus.ts). Each returns the
 * matches `matchAll` finds for its pattern, in order, reading each character a
 * bounded number of times; secret-scan.test.ts compares them.
 */
import type { PiiMatch } from "@crewhaus/grader-safety-classifiers";

/** `[A-Za-z0-9_-]`: a base64url character. */
const isTokenChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f ||
  code === 0x2d;

/** `[A-Za-z0-9_]`: a `\b` word character. */
const isWordChar = (code: number): boolean => isTokenChar(code) && code !== 0x2d;

/** `\b` at `at`: a word character on exactly one side. */
const isBoundary = (text: string, at: number): boolean =>
  isWordChar(text.charCodeAt(at - 1)) !== isWordChar(text.charCodeAt(at));

/** The end of the run of base64url characters starting at `from`. */
function tokenRunEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && isTokenChar(text.charCodeAt(end))) end++;
  return end;
}

/**
 * `/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g`.
 *
 * The pattern may start at every `ey` after a `-` in a run of base64url
 * characters and reads to the end of the run from each (`ey-ey-ey-…`: a
 * second for 40 000 characters). Each segment runs to the end of its run, as
 * `.` is not in it; the last ends at the last word boundary at least ten
 * characters in. Every `ey` in one run sees the same runs after it and a
 * shorter first segment, so when the first fails they all do, and the search
 * resumes after the run.
 */
export function jwtMatches(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
  let from = 0;
  for (;;) {
    let start = text.indexOf("ey", from);
    while (start !== -1 && !isBoundary(text, start)) start = text.indexOf("ey", start + 1);
    if (start === -1) return matches;
    const first = tokenRunEnd(text, start + 2);
    let end = -1;
    if (first - (start + 2) >= 10 && text.charCodeAt(first) === 0x2e) {
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

const isHeaderChar = (code: number): boolean => (code >= 0x41 && code <= 0x5a) || code === 0x20;

/**
 * Where `-----<word> [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----` ends at `at`, or
 * -1. Both names are made of header characters and the `-` after them is
 * not one, so the name must end the run of them, with the dashes right after.
 */
function pemLineEnd(text: string, at: number, word: string): number {
  const lead = `-----${word} `;
  if (!text.startsWith(lead, at)) return -1;
  const from = at + lead.length;
  let run = from;
  while (run < text.length && isHeaderChar(text.charCodeAt(run))) run++;
  const named =
    (run - from >= 11 && text.startsWith("PRIVATE KEY", run - 11)) ||
    (run - from >= 11 && text.startsWith("CERTIFICATE", run - 11));
  return named && text.startsWith("-----", run) ? run + 5 : -1;
}

/**
 * `/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/g`.
 *
 * A block runs from a BEGIN line to the first END line after it. When a
 * BEGIN line has no END line after it, no later one does either, so the scan
 * stops, where the pattern read the rest of the text from every BEGIN line.
 */
export function pemMatches(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
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

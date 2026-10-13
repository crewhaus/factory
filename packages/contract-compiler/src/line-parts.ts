/**
 * Bullet and numbered-item reads of an issue's lines, without the regex
 * engine.
 *
 * `/^\s*[-*]\s+(.+)$/` and `/^\s*\d+\.\s+(.+)$/` gave back the run of
 * whitespace after the marker one character at a time when the rest of the
 * line held a `\r` or a U+2028, which `.` does not match and which splitting
 * on `\r?\n` leaves in place, re-reading the rest each time: one such line of
 * 40 000 spaces took two seconds. The issue text is whatever the user
 * supplied. Each function returns what its pattern captured; line-parts.test.ts
 * compares them.
 */

/** `\s`: ECMAScript WhiteSpace and LineTerminator. */
const isSpace = (code: number): boolean =>
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x20 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/** What `.` does not match. */
const isLineTerminator = (code: number): boolean =>
  code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

function skipSpace(line: string, from: number): number {
  let at = from;
  while (at < line.length && isSpace(line.charCodeAt(at))) at++;
  return at;
}

/** Whether `(.+)$` can take `line` from `from` to its end: no line terminator. */
function restIsOneLine(line: string, from: number): boolean {
  for (let at = from; at < line.length; at++) {
    if (isLineTerminator(line.charCodeAt(at))) return false;
  }
  return true;
}

/**
 * What `\s+(.+)$` captures in `line` from `from`, or undefined. The greedy
 * `\s+` takes the whole run, and `(.+)$` the rest of the line when it holds
 * no line terminator. When nothing follows the run, `(.+)` takes back its
 * last character, if `\s+` keeps one and `.` can match it.
 */
function itemText(line: string, from: number): string | undefined {
  const text = skipSpace(line, from);
  if (text === from) return undefined;
  if (text < line.length) return restIsOneLine(line, text) ? line.slice(text) : undefined;
  if (text - from < 2 || isLineTerminator(line.charCodeAt(text - 1))) return undefined;
  return line.slice(text - 1);
}

/** `line.match(/^\s*[-*]\s+(.+)$/)?.[1]`: a bullet item's text, or undefined. */
export function bulletText(line: string): string | undefined {
  const marker = skipSpace(line, 0);
  const code = line.charCodeAt(marker);
  if (code !== 0x2d /* - */ && code !== 0x2a /* * */) return undefined;
  return itemText(line, marker + 1);
}

/** `line.match(/^\s*\d+\.\s+(.+)$/)?.[1]`: a numbered item's text, or undefined. */
export function numberedText(line: string): string | undefined {
  const start = skipSpace(line, 0);
  let digits = start;
  while (digits < line.length && isDigit(line.charCodeAt(digits))) digits++;
  if (digits === start || line.charCodeAt(digits) !== 0x2e /* . */) return undefined;
  return itemText(line, digits + 1);
}

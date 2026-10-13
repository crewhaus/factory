/**
 * The curriculum ladder's unchecked rung, read without the regex engine.
 *
 * `/^\s*[-*]\s*\[\s\]\s*(.+)$/` gave back the whitespace after the box one
 * character at a time when the rest of the line held a `\r` (a CRLF file)
 * or a U+2028, re-reading the rest each time: one such line of 40 000 spaces
 * took a second. The curriculum is agent-editable. line-parts.test.ts
 * compares this with the pattern.
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

function skipSpace(line: string, from: number): number {
  let at = from;
  while (at < line.length && isSpace(line.charCodeAt(at))) at++;
  return at;
}

/** Whether `(.*)$` matches `line` from `from`: no line terminator after it. */
function restIsOneLine(line: string, from: number): boolean {
  for (let at = from; at < line.length; at++) {
    if (isLineTerminator(line.charCodeAt(at))) return false;
  }
  return true;
}

/** `/^\s*[-*]\s*\[\s\]\s*(.+)$/.exec(line)?.[1]`, or undefined. */
export function uncheckedRungText(line: string): string | undefined {
  const marker = skipSpace(line, 0);
  const bullet = line.charCodeAt(marker);
  if (bullet !== 0x2d /* - */ && bullet !== 0x2a /* * */) return undefined;
  const open = skipSpace(line, marker + 1);
  if (
    line.charCodeAt(open) !== 0x5b /* [ */ ||
    !isSpace(line.charCodeAt(open + 1)) ||
    line.charCodeAt(open + 2) !== 0x5d /* ] */
  ) {
    return undefined;
  }
  const spaces = open + 3;
  const text = skipSpace(line, spaces);
  if (text < line.length) return restIsOneLine(line, text) ? line.slice(text) : undefined;
  // Nothing after the spaces: `(.+)` takes back the last of them, if `.`
  // can match it.
  if (text === spaces || isLineTerminator(line.charCodeAt(text - 1))) return undefined;
  return line.slice(text - 1);
}

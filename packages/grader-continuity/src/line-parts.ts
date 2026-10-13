/**
 * A heading line's text, read without the regex engine.
 *
 * `/^##\s+(.*)$/` gave back the whitespace after `##` one character at a
 * time when the rest of the line held a `\r` (a CRLF handoff) or a U+2028,
 * re-reading the rest each time: one such line of 40 000 spaces took a
 * second. A handoff is agent-written. line-parts.test.ts compares this with
 * the pattern.
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

/** `/^##\s+(.*)$/.exec(line)?.[1]`: the text after `##` and its spaces, or undefined. */
export function h2Text(line: string): string | undefined {
  if (!line.startsWith("##")) return undefined;
  const text = skipSpace(line, 2);
  if (text === 2 || !restIsOneLine(line, text)) return undefined;
  return line.slice(text);
}

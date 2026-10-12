/**
 * Line reads for documents an agent writes (wiki pages, the curriculum
 * ladder), without the regex engine.
 *
 * Each pattern below gave back a run of whitespace one character at a time
 * when the rest of the line held a `\r` (a CRLF file) or a U+2028, which `.`
 * does not match, re-reading the rest each time: one such line of 40 000
 * spaces took a second. Each function returns what its pattern captured;
 * line-parts.test.ts compares them.
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

/** `line.match(/^#{1,3}\s+(.*)$/)?.[1]`: a level 1-3 heading's text, or undefined. */
export function headingText(line: string): string | undefined {
  let hashes = 0;
  while (line.charCodeAt(hashes) === 0x23 /* # */) hashes++;
  if (hashes < 1 || hashes > 3) return undefined;
  const text = skipSpace(line, hashes);
  if (text === hashes || !restIsOneLine(line, text)) return undefined;
  return line.slice(text);
}

/**
 * `line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)`: a checkbox item's mark and
 * text, or null.
 */
export function checkboxParts(line: string): [string, string] | null {
  const marker = skipSpace(line, 0);
  const bullet = line.charCodeAt(marker);
  if (bullet !== 0x2d /* - */ && bullet !== 0x2a /* * */) return null;
  const open = skipSpace(line, marker + 1);
  if (open === marker + 1 || line.charCodeAt(open) !== 0x5b /* [ */) return null;
  const mark = line.charAt(open + 1);
  if (
    (mark !== " " && mark !== "x" && mark !== "X") ||
    line.charCodeAt(open + 2) !== 0x5d /* ] */
  ) {
    return null;
  }
  const text = skipSpace(line, open + 3);
  if (text === open + 3 || !restIsOneLine(line, text)) return null;
  return [mark, line.slice(text)];
}

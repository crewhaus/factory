/**
 * The parts of a markdown line the CLI renderer styles, read without the
 * regex engine.
 *
 * Each function returns the captures its pattern returned. The patterns
 * gave back a run of whitespace one character at a time when what followed
 * could not match: `(.*)$` cannot pass a `\r` (a CRLF reply) or a U+2028,
 * and the fence's trailing `\s*$` cannot pass a second word. Each give-back
 * re-read the rest of the line, so a model reply with a long run of spaces
 * in such a line took time quadratic in it. cli-markdown-lines.test.ts
 * compares every function with its pattern.
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

/** `/^(\s*)```\s*(\S*)\s*$/`: [indent, language], or null. */
export function fenceParts(line: string): [string, string] | null {
  const indent = skipSpace(line, 0);
  if (!line.startsWith("```", indent)) return null;
  const langStart = skipSpace(line, indent + 3);
  let langEnd = langStart;
  while (langEnd < line.length && !isSpace(line.charCodeAt(langEnd))) langEnd++;
  if (skipSpace(line, langEnd) !== line.length) return null;
  return [line.slice(0, indent), line.slice(langStart, langEnd)];
}

/** `/^(\s*)(#{1,6})\s+(.*)$/`: [indent, hashes, text], or null. */
export function headingParts(line: string): [string, string, string] | null {
  const indent = skipSpace(line, 0);
  let hashes = indent;
  while (line.charCodeAt(hashes) === 0x23 /* # */) hashes++;
  const level = hashes - indent;
  if (level < 1 || level > 6) return null;
  const text = skipSpace(line, hashes);
  if (text === hashes || !restIsOneLine(line, text)) return null;
  return [line.slice(0, indent), line.slice(indent, hashes), line.slice(text)];
}

/** `/^(\s*)[-*+]\s+(.*)$/`: [indent, text], or null. */
export function bulletParts(line: string): [string, string] | null {
  const indent = skipSpace(line, 0);
  const marker = line.charCodeAt(indent);
  if (marker !== 0x2d /* - */ && marker !== 0x2a /* * */ && marker !== 0x2b /* + */) return null;
  const text = skipSpace(line, indent + 1);
  if (text === indent + 1 || !restIsOneLine(line, text)) return null;
  return [line.slice(0, indent), line.slice(text)];
}

/** `/^(\s*)(\d+)\.\s+(.*)$/`: [indent, number, text], or null. */
export function numberedParts(line: string): [string, string, string] | null {
  const indent = skipSpace(line, 0);
  let digits = indent;
  while (line.charCodeAt(digits) >= 0x30 && line.charCodeAt(digits) <= 0x39) digits++;
  if (digits === indent || line.charCodeAt(digits) !== 0x2e /* . */) return null;
  const text = skipSpace(line, digits + 1);
  if (text === digits + 1 || !restIsOneLine(line, text)) return null;
  return [line.slice(0, indent), line.slice(indent, digits), line.slice(text)];
}

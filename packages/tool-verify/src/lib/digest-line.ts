/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** A code unit `.` does not match without the `s` flag. */
function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

/** A code unit `[0-9a-fA-F]` matches. */
function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/** `line[from..]`, unless it holds a code unit `.` refuses. */
function restWithoutBreak(line: string, from: number): string | null {
  for (let i = from; i < line.length; i++) if (isLineBreak(line.charCodeAt(i))) return null;
  return line.slice(from);
}

/**
 * A `sha256sum` line's digest and path: what
 * `/^([0-9a-fA-F]{64})\s+\*?(.+)$/` captured, read in one pass. The
 * whitespace after the digest and the binary-mode `*` are taken whole and
 * the path must hold no line break (`.` stops at \n, \r, U+2028 and U+2029);
 * a lone `*` is the path itself, and with nothing after the whitespace the
 * pattern took its last character, unless that is a line break or the
 * whitespace is a single character. The pattern tried every shorter run of
 * whitespace and rescanned the rest from each, so a run before a stray \r in
 * a manifest from the workspace was quadratic in the run's length.
 */
export function digestLine(line: string): { digest: string; path: string } | null {
  if (line.length < 64) return null;
  for (let i = 0; i < 64; i++) if (!isHexDigit(line.charCodeAt(i))) return null;
  let at = 64;
  while (at < line.length && isRegExpSpace(line.charCodeAt(at))) at++;
  if (at === 64) return null;
  const digest = line.slice(0, 64);
  if (line.charCodeAt(at) === 0x2a) {
    if (at + 1 === line.length) return { digest, path: "*" };
    const path = restWithoutBreak(line, at + 1);
    return path === null ? null : { digest, path };
  }
  if (at === line.length) {
    const last = at - 1;
    return last > 64 && !isLineBreak(line.charCodeAt(last))
      ? { digest, path: line.charAt(last) }
      : null;
  }
  const path = restWithoutBreak(line, at);
  return path === null ? null : { digest, path };
}

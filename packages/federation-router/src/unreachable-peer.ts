/**
 * Whether a router error message says a peer is unreachable: what
 * `/peer .* unreachable/i.test(message)` answered, found without the regex
 * engine.
 *
 * The pattern read to the end of the line from every `peer ` in it before
 * failing, so a message holding many of them took time quadratic in its
 * length. A message can carry a peer's own text (the version string its
 * discovery document declares), so the peer chose that length. The first
 * `peer ` on a line sees the most of the line after it, so the scan checks
 * only that one against the line's text after it.
 */
export function mentionsUnreachablePeer(message: string): boolean {
  let lineStart = 0;
  while (lineStart <= message.length) {
    let lineEnd = lineStart;
    while (lineEnd < message.length && !isLineTerminator(message.charCodeAt(lineEnd))) lineEnd++;
    const peer = indexOfFolded(message, "peer ", lineStart, lineEnd);
    if (peer !== -1 && indexOfFolded(message, " unreachable", peer + 5, lineEnd) !== -1) {
      return true;
    }
    lineStart = lineEnd + 1;
  }
  return false;
}

/** What `.` does not match. */
const isLineTerminator = (code: number): boolean =>
  code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;

/**
 * The first `at` in [from, end) where `word` (lowercase ASCII) fits before
 * `end`, in any ASCII case as `i` matches without `u`, or -1.
 */
function indexOfFolded(text: string, word: string, from: number, end: number): number {
  for (let at = from; at + word.length <= end; at++) {
    let k = 0;
    for (; k < word.length; k++) {
      const want = word.charCodeAt(k);
      const got = text.charCodeAt(at + k);
      if (got !== want && !(want >= 0x61 && want <= 0x7a && got === want - 0x20)) break;
    }
    if (k === word.length) return at;
  }
  return -1;
}

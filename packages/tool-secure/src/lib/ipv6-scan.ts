const isHexDigit = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isHexOrColon = (c: number): boolean => isHexDigit(c) || c === 0x3a;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
/** A code unit `\w` matches, which is what `\b` looks at. */
const isWordUnit = (c: number): boolean =>
  isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;

/** `(?:[0-9A-Fa-f]{1,4}:){7}` at `at`. */
function sevenGroups(text: string, at: number): boolean {
  let p = at;
  for (let g = 0; g < 7; g++) {
    let d = p;
    while (d < p + 4 && isHexDigit(text.charCodeAt(d))) d++;
    if (d === p || text.charCodeAt(d) !== 0x3a) return false;
    p = d + 1;
  }
  return true;
}

/**
 * The matches of the IPv6 candidate pattern
 * `/\b(?=[0-9A-Fa-f:]*::|(?:[0-9A-Fa-f]{1,4}:){7})[0-9A-Fa-f:]{2,39}(?:\.\d{1,3}){0,3}/g`,
 * in order, start for start.
 *
 * The lookahead's `[0-9A-Fa-f:]*::` read on to the end of a run of hex
 * digits and colons from every word boundary in it, and a run like
 * `a:a:a:…` has one every second character and matches every 39: quadratic
 * in the run, minutes over the 2M characters `PiiScan` accepts. Here the run
 * is read once: a start sees `::` ahead exactly when the run's last `::`
 * begins at or after it.
 */
export function ipv6Candidates(text: string): Array<{ index: number; value: string }> {
  const out: Array<{ index: number; value: string }> = [];
  // The run of hex digits and colons the current start is in, and where its
  // last `::` begins (-1 for none).
  let runEnd = -1;
  let lastPair = -1;
  let at = 0;
  while (at < text.length) {
    if (!isHexOrColon(text.charCodeAt(at))) {
      at++;
      continue;
    }
    if (at >= runEnd) {
      runEnd = at;
      lastPair = -1;
      while (runEnd < text.length && isHexOrColon(text.charCodeAt(runEnd))) {
        if (
          runEnd > at &&
          text.charCodeAt(runEnd) === 0x3a &&
          text.charCodeAt(runEnd - 1) === 0x3a
        ) {
          lastPair = runEnd - 1;
        }
        runEnd++;
      }
    }
    const boundary =
      (at > 0 && isWordUnit(text.charCodeAt(at - 1))) !== isWordUnit(text.charCodeAt(at));
    if (boundary && runEnd - at >= 2 && (lastPair >= at || sevenGroups(text, at))) {
      let end = at + Math.min(39, runEnd - at);
      for (let g = 0; g < 3; g++) {
        if (text.charCodeAt(end) !== 0x2e || !isDigit(text.charCodeAt(end + 1))) break;
        let d = end + 1;
        while (d < end + 4 && isDigit(text.charCodeAt(d))) d++;
        end = d;
      }
      out.push({ index: at, value: text.slice(at, end) });
      at = end;
      continue;
    }
    at++;
  }
  return out;
}

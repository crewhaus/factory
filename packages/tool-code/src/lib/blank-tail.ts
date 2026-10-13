import { isLineBreak, isRegExpSpace } from "./regexp-space";

/** How many `\s` code units start at `from`. */
export function blanksAt(text: string, from: number): number {
  let i = from;
  while (i < text.length && isRegExpSpace(text.charCodeAt(i))) i++;
  return i - from;
}

/**
 * Where a pattern's closing `\s*(.*)$`, `\s+(.*)$`, `\s*(.+)$` or
 * `\s+(.+)$` starts its capture when it is tried at `from`, or -1 when it
 * does not match there. `minBlanks` is the blanks' `*` (0) or `+` (1),
 * `minRest` the capture's.
 *
 * The capture runs to the end of the input, so it must hold no line break
 * (`.` takes none), and the pattern took the most blanks that leaves it
 * that: the whole run of them, or one fewer when the run reaches the end
 * and the capture needs a character. As a pattern it got there by giving
 * the run back one character at a time and reading the rest again after
 * each, so a run of spaces before a stray `\r` or U+2028 was quadratic in
 * the run's length; with one more `\s*` in front of it, cubic.
 */
export function restAfterBlanks(
  text: string,
  from: number,
  minBlanks: 0 | 1,
  minRest: 0 | 1,
): number {
  const blanks = blanksAt(text, from);
  if (blanks < minBlanks) return -1;
  let start = from + blanks;
  if (text.length - start < minRest) {
    // Blanks to the very end: the capture takes the last of them.
    start = text.length - 1;
    if (start < from + minBlanks) return -1;
  }
  for (let i = start; i < text.length; i++) if (isLineBreak(text.charCodeAt(i))) return -1;
  return start;
}

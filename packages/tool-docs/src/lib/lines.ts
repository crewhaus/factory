/**
 * Line tidying shared by the text extractors, written as a scan rather than
 * as `replace(/[ \t]+\n/g, "\n")`.
 *
 * That regex is quadratic on a long run of blanks that does NOT end in a
 * newline: the engine tries a match at every blank of the run, each attempt
 * reads to the end of the run, and each fails. 200 000 spaces and an "x"
 * took 28 s in DocumentText (C090's sibling).
 */

/** True for the two characters `[ \t]` names. */
function isBlank(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/**
 * Drop the spaces and tabs at the end of every line but the last, collapse
 * three or more newlines to two, and trim: exactly
 * `.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()`, in
 * linear time.
 */
export function tidyLines(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] as string;
    let end = line.length;
    while (end > 0 && isBlank(line.charCodeAt(end - 1))) end -= 1;
    if (end !== line.length) lines[i] = line.slice(0, end);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

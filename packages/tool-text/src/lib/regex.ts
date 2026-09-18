import { lineStarts, offsetToLineCol } from "./locate";

/** A single regex hit, located by offset AND by line/column. */
export type RegexMatch = {
  readonly match: string;
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly groups: Readonly<Record<string, string>>;
  readonly captures: ReadonlyArray<string | undefined>;
};

/**
 * Run a regex over text and return located matches.
 *
 * Always compiles with `g` so the scan advances, and a zero-width match bumps
 * `lastIndex` by one so a pattern like `a*` terminates instead of spinning
 * forever at the same offset.
 */
export function regexExtractAll(
  text: string,
  pattern: string,
  flags: string,
  maxMatches: number,
): { matches: RegexMatch[]; truncated: boolean } {
  const withGlobal = flags.includes("g") ? flags : `${flags}g`;
  const re = new RegExp(pattern, withGlobal);
  const starts = lineStarts(text);
  const matches: RegexMatch[] = [];
  let truncated = false;
  for (;;) {
    const m = re.exec(text);
    if (m === null) break;
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    const { line, column } = offsetToLineCol(starts, m.index);
    matches.push({
      match: m[0],
      index: m.index,
      line,
      column,
      groups: { ...(m.groups ?? {}) },
      captures: m.slice(1),
    });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return { matches, truncated };
}

/**
 * Strip wrapping quotes/brackets/trailing punctuation off a raw token, one
 * character at a time from each end.
 *
 * This was `/^["'`(<[{]+/` then `/["'`)\]}>.,;:!?]+$/`. The second pattern
 * rescans a run of those characters from every position in it before it
 * fails at the character after the run, so it is quadratic in a run that is
 * not at the end: "x" + 40 000 dots + "y" took a second, 400 000 about two
 * minutes. Tokens come from tool output, MCP and federation replies and
 * channel messages, which is text someone else wrote. These loops read each
 * character at most once.
 */
export function trimToken(raw: string): string {
  let start = 0;
  while (start < raw.length && isLeadingWrapper(raw.charCodeAt(start))) start++;
  let end = raw.length;
  while (end > start && isTrailingPunctuation(raw.charCodeAt(end - 1))) end--;
  return raw.slice(start, end);
}

/** `["'`(<[{]`: what a token may open with. */
function isLeadingWrapper(code: number): boolean {
  return (
    code === 0x22 || // "
    code === 0x27 || // '
    code === 0x60 || // `
    code === 0x28 || // (
    code === 0x3c || // <
    code === 0x5b || // [
    code === 0x7b // {
  );
}

/** `["'`)\]}>.,;:!?]`: what a token may close with. */
function isTrailingPunctuation(code: number): boolean {
  return (
    code === 0x22 || // "
    code === 0x27 || // '
    code === 0x60 || // `
    code === 0x29 || // )
    code === 0x5d || // ]
    code === 0x7d || // }
    code === 0x3e || // >
    code === 0x2e || // .
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x3a || // :
    code === 0x21 || // !
    code === 0x3f // ?
  );
}

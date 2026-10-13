/**
 * The text from the first `{` to the last `}`, or null when no `}` follows
 * the first `{`: what `/\{[\s\S]*\}/` matched, found with `indexOf` and
 * `lastIndexOf`.
 *
 * The pattern tried each `{` in turn and scanned the rest of the text from
 * every one, so a model reply holding a long run of `{` and no `}` took time
 * quadratic in the run (40 000: most of a second). When no `}` follows the
 * first `{`, none follows a later one either, and when one does the greedy
 * match runs to the last: the first `{` and the last `}` decide it.
 */
export function firstObjectSpan(text: string): string | null {
  const open = text.indexOf("{");
  if (open === -1) return null;
  const close = text.lastIndexOf("}");
  return close > open ? text.slice(open, close + 1) : null;
}

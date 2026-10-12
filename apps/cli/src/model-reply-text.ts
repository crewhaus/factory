/**
 * Reads of model replies that look at each character a bounded number of
 * times. Each replaces a pattern that rescanned a run from every position in
 * it, and so took time quadratic in a run of `{` or of digits in a reply
 * (40 000 characters: about a second). Each returns exactly what its pattern
 * did; model-reply-text.test.ts compares them.
 */

/**
 * The text from the first `{` to the last `}`, or null when no `}` follows
 * the first `{`: what `/\{[\s\S]*\}/` matched. When no `}` follows the first
 * `{`, none follows a later one either, and when one does the greedy match
 * runs to the last: the first `{` and the last `}` decide it.
 */
export function firstObjectSpan(text: string): string | null {
  const open = text.indexOf("{");
  if (open === -1) return null;
  const close = text.lastIndexOf("}");
  return close > open ? text.slice(open, close + 1) : null;
}

/**
 * Whether `line` maps a requirement: what `/REQ-\d+.*(?:→|->)/.test(line)`
 * answered. The arrow must come after `REQ-` and a digit with no line break
 * between (`.` stops at one), so each `REQ-<digit>` is checked by reading on
 * to the next line break. A later `REQ-<digit>` before that break would read
 * a part of the same text, so the search resumes after the break.
 */
export function mapsARequirement(line: string): boolean {
  let from = 0;
  for (;;) {
    const req = line.indexOf("REQ-", from);
    if (req === -1) return false;
    if (!isDigit(line.charCodeAt(req + 4))) {
      from = req + 1;
      continue;
    }
    let i = req + 5;
    for (; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (code === 0x2192 /* → */) return true;
      if (code === 0x2d /* - */ && line.charCodeAt(i + 1) === 0x3e /* > */) return true;
      if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) break;
    }
    if (i >= line.length) return false;
    from = i + 1;
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

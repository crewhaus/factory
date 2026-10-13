/**
 * Text helpers that read each character a bounded number of times. Each
 * replaces a pattern that rescanned a run from every position in it, and so
 * took time quadratic in the run, over text a model or a user wrote: a judge's
 * rationale, a model's reply, a mined session input. Each returns exactly
 * what its pattern gave; linear-text.test.ts compares them.
 */

/**
 * The text from the first `{` to the last `}`, or undefined when no `}`
 * follows the first `{`: what `/\{[\s\S]*\}/` matched. When no `}` follows the
 * first `{`, none follows a later one either, and when one does the greedy
 * match runs to the last: the first `{` and the last `}` decide it.
 */
export function firstObjectSpan(text: string): string | undefined {
  const open = text.indexOf("{");
  if (open === -1) return undefined;
  const close = text.lastIndexOf("}");
  return close > open ? text.slice(open, close + 1) : undefined;
}

/**
 * `text` without its trailing `.`, `?` and `!`: `text.replace(/[.?!]+$/, "")`.
 */
export function withoutClosingMarks(text: string): string {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x2e /* . */ && code !== 0x3f /* ? */ && code !== 0x21 /* ! */) break;
    end--;
  }
  return text.slice(0, end);
}

const CHECK = 0x2713; // ✓
const CROSS = 0x2717; // ✗

/**
 * `text` with every `[name: ✓]` / `[name: ✗]` combinator marker replaced by a
 * space: `text.replace(/\[[^\]]*: [✓✗]\]/g, " ")`.
 *
 * A marker runs from a `[` to the first `]` after it. Every `[` before that
 * `]` meets the same `]`, so the leftmost one is the match when the three
 * characters before the `]` are `: ✓` or `: ✗` (with room for them), and
 * none of them is when they are not: the search then resumes after the `]`.
 */
export function withoutCombinatorMarkers(text: string): string {
  let out = "";
  let kept = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("[", from);
    if (open === -1) break;
    const close = text.indexOf("]", open + 1);
    if (close === -1) break;
    const mark = text.charCodeAt(close - 1);
    if (
      close - 3 > open &&
      text.charCodeAt(close - 3) === 0x3a /* : */ &&
      text.charCodeAt(close - 2) === 0x20 &&
      (mark === CHECK || mark === CROSS)
    ) {
      out += `${text.slice(kept, open)} `;
      kept = close + 1;
    }
    from = close + 1;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

const NEED = "need ≥";

/**
 * `text` with every judge prefix replaced by a space:
 * `text.replace(/judge(?:=\d+(?:\.\d+)?| abstained) \([^)]*need ≥\d+(?:\.\d+)?\):/g, " ")`
 * — `judge=4 (need ≥3):`, `judge=3.5 (median of 3 repeats …, need ≥4):`,
 * `judge abstained (… need ≥3):`.
 *
 * After its `(`, a prefix runs to the first `)`, which must be followed by
 * `:` and preceded by `need ≥` and a number. Every `judge` before that `)`
 * meets the same `)` and the same text before it, so when it fails they all
 * do, and the search resumes after the `)`. The `need ≥` is looked for only
 * between the `(` and the `)`: those stretches do not overlap, so each
 * character is read a bounded number of times. (A search back from the `)`
 * with no lower bound read to the start of the text for every prefix that
 * had none: quadratic in a rationale of `judge=1 (x):`.)
 */
export function withoutJudgePrefixes(text: string): string {
  let out = "";
  let kept = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf("judge", from);
    if (start === -1) break;
    const inside = judgeOpenEnd(text, start + 5);
    if (inside === -1) {
      from = start + 1;
      continue;
    }
    const close = text.indexOf(")", inside);
    if (close === -1) break;
    if (text.charCodeAt(close + 1) === 0x3a /* : */) {
      const need = text.slice(inside, close).lastIndexOf(NEED);
      if (need !== -1 && numberEnd(text, inside + need + NEED.length) === close) {
        out += `${text.slice(kept, start)} `;
        kept = close + 2;
        from = close + 2;
        continue;
      }
    }
    from = close + 1;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

/** After `judge` at `at`: the index after `=<number> (` or ` abstained (`, or -1. */
function judgeOpenEnd(text: string, at: number): number {
  let p: number;
  if (text.startsWith(" abstained", at)) {
    p = at + 10;
  } else if (text.charCodeAt(at) === 0x3d /* = */) {
    p = numberEnd(text, at + 1);
    if (p === -1) return -1;
  } else {
    return -1;
  }
  return text.startsWith(" (", p) ? p + 2 : -1;
}

/**
 * Where `\d+(?:\.\d+)?` ends when matched greedily at `at`, or -1 when no digit
 * is there. A `.` is taken only with a digit after it, as the optional group's
 * backtracking would leave it otherwise.
 */
function numberEnd(text: string, at: number): number {
  let p = at;
  while (isDigit(text.charCodeAt(p))) p++;
  if (p === at) return -1;
  if (text.charCodeAt(p) === 0x2e /* . */ && isDigit(text.charCodeAt(p + 1))) {
    p += 2;
    while (isDigit(text.charCodeAt(p))) p++;
  }
  return p;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Pure formatting helpers for the process tools. Nothing here spawns,
 * reads the filesystem or looks at a clock, so the behaviour that these
 * back can be unit-tested without a world.
 */

export type CappedText = {
  readonly text: string;
  readonly truncated: boolean;
  readonly droppedChars: number;
};

/**
 * Cap a captured stream to a character budget, keeping BOTH ends.
 *
 * A command's head says what it started doing and its tail says how it
 * ended; dropping either one loses the half a caller usually needs. The
 * elision marker states the exact number of dropped characters so the
 * result is still a faithful description of what the process produced.
 */
export function capText(text: string, maxChars: number): CappedText {
  if (maxChars <= 0) {
    return { text: "", truncated: text.length > 0, droppedChars: text.length };
  }
  if (text.length <= maxChars) {
    return { text, truncated: false, droppedChars: 0 };
  }
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  const dropped = text.length - maxChars;
  const kept = `${text.slice(0, head)}\n...[${dropped} chars dropped]...\n${text.slice(text.length - tail)}`;
  return { text: kept, truncated: true, droppedChars: dropped };
}

/**
 * Render an argv array the way a person would type it, for log lines and
 * error messages ONLY. This is never fed back to a shell — the tools spawn
 * the argv array directly — so it quotes for readability, not for safety.
 */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((arg) =>
      arg === "" || /[\s"'\\$`*?|&;<>()[\]{}#~!]/.test(arg) ? JSON.stringify(arg) : arg,
    )
    .join(" ");
}

/**
 * Compile a caller-supplied regular expression, refusing the shapes behind
 * catastrophic backtracking. The pattern reaches us from a model, and a
 * waiting tool applies it repeatedly to a growing buffer, so an exponential
 * pattern would pin a core for the whole deadline.
 */
export function compileSafePattern(
  source: string,
  flags: string,
):
  | { readonly ok: true; readonly regex: RegExp }
  | { readonly ok: false; readonly message: string } {
  if (source.length > 1_000) {
    return { ok: false, message: `pattern is ${source.length} characters, over the 1000 limit` };
  }
  const risk = backtrackingRisk(source);
  if (risk === "nested-quantifier") {
    return {
      ok: false,
      message: "pattern nests one quantifier inside another, which can backtrack exponentially",
    };
  }
  if (risk === "quantified-alternation") {
    return {
      ok: false,
      message:
        "pattern quantifies a group containing an alternation, e.g. (a|a)*, which can backtrack exponentially — quantify a character class instead",
    };
  }
  try {
    return { ok: true, regex: new RegExp(source, flags) };
  } catch (err) {
    return { ok: false, message: `invalid regex: ${(err as Error).message}` };
  }
}

/**
 * The two shapes that make a regex blow up, both found in one scan.
 *
 * "nested-quantifier" is star height ≥ 2 — `(a+)+`, `(\s*\w)*`. "quantified-
 * alternation" is a quantified group whose branches can match the same text —
 * `(a|a)*`, `(a|ab)*` — which backtracks just as badly while its star height
 * is only 1. Deciding whether two branches really overlap is not something a
 * scanner can do, so EVERY quantified group containing a `|` is refused.
 *
 * That over-refuses `(a|b)*`, and it is worth it: this matters because
 * `WaitForOutput`'s deadline bounds its POLL LOOP, not a single `exec` call.
 * One catastrophic match against a process's output buffer pins a core for
 * longer than the deadline, longer than the turn, longer than the age of the
 * universe — measurably, `(a|a)*$` against 41 characters already takes ~750ms
 * and doubles with each one after that. A pattern that waits for a line
 * — `Listening on (\d+)`, `(ready|listening)` — is unaffected, because the
 * group is not quantified.
 */
type BacktrackingRisk = "none" | "nested-quantifier" | "quantified-alternation";

function backtrackingRisk(source: string): BacktrackingRisk {
  let depth = 0;
  let nested = false;
  let quantifiedAlternation = false;
  const quantifiedAt: boolean[] = [];
  const alternationAt: boolean[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") {
      depth++;
      quantifiedAt[depth] = false;
      alternationAt[depth] = false;
      continue;
    }
    if (ch === "|") {
      if (depth > 0) alternationAt[depth] = true;
      continue;
    }
    if (ch === ")") {
      const next = source[i + 1];
      if (next === "*" || next === "+" || next === "{" || next === "?") {
        // This group is itself quantified. `?` cannot repeat, so it only
        // carries an inner quantifier outward; `*`, `+` and `{n,}` repeat,
        // which is what turns an overlapping alternation catastrophic.
        if (quantifiedAt[depth] === true && next !== "?") nested = true;
        if (alternationAt[depth] === true && next !== "?") quantifiedAlternation = true;
        if (depth > 1) quantifiedAt[depth - 1] = true;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "*" || ch === "+") {
      if (depth > 0) quantifiedAt[depth] = true;
    }
  }
  if (nested) return "nested-quantifier";
  if (quantifiedAlternation) return "quantified-alternation";
  return "none";
}

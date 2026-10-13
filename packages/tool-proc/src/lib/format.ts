/**
 * Pure formatting helpers for the process tools. Nothing here spawns,
 * reads the filesystem or looks at a clock, so the behaviour that these
 * back can be unit-tested without a world.
 */
import { compileUserRegex } from "@crewhaus/tool-safety/regex";

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
 * waiting tool applies it repeatedly to a growing buffer.
 *
 * The screen is @crewhaus/tool-safety's `compileUserRegex`, the one every
 * tool shares (C079). 0.7.0 kept a scanner here that counted only `*` and
 * `+` inside a group, so `(\w{1,})*$`, `(\w{1,64})*$` and `(\w\w?)*$`
 * passed it and JavaScriptCore then gave up on them — a false "no match"
 * after pinning the event loop. The shared screen models `{n,m}` and `?`
 * too, accepts a repetition only when each pass ends in exactly one place,
 * and is fuzzed; it also admits safe alternations the old scanner refused
 * wholesale, such as `(a|b)*`. WaitForOutput still runs the match in the
 * regex worker under a deadline: the screen is the second layer, not the
 * first.
 */
export function compileSafePattern(
  source: string,
  flags: string,
):
  | { readonly ok: true; readonly regex: RegExp }
  | { readonly ok: false; readonly message: string } {
  const compiled = compileUserRegex(source, flags);
  if (compiled.ok) return compiled;
  switch (compiled.code) {
    case "nested-quantifier":
      return {
        ok: false,
        message: `pattern nests one quantifier inside another, which can backtrack exponentially: ${compiled.reason}`,
      };
    case "overlapping-alternation":
      return {
        ok: false,
        message: `pattern repeats an alternation whose branches can match the same text, e.g. (a|a)*, which can backtrack exponentially: ${compiled.reason}`,
      };
    case "invalid-syntax":
      return { ok: false, message: `invalid regex: ${compiled.reason}` };
    default:
      return { ok: false, message: compiled.reason };
  }
}

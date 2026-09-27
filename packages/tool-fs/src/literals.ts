/**
 * Text every match of a Grep pattern must contain, so a line without it is
 * a definite non-match that never has to go to the regex worker.
 *
 * Sending a line to tool-safety's worker costs about 0.4 µs (copying it
 * across, timing the match), where 0.7.0 tested it on the caller's thread in
 * a fraction of that: a no-match search of factory's source took 620 ms
 * against 0.7.0's 175 ms. Most searches name a word, and a line that does
 * not contain the word cannot match, which `String.prototype.includes`
 * decides in linear time on any line, however long. This is the literal
 * pre-filter ripgrep and GNU grep use.
 *
 * It is deliberately narrow, because a literal claimed as required that is
 * not would hide a real match. Per top-level alternative, a run of
 * consecutive plain characters that no quantifier applies to is consumed,
 * in order and adjacent, by every match of that alternative, so each such
 * run is required. Anything else (a group, a class, an escape that is not a
 * plain character, an anchor, a quantified character) ends a run and adds
 * nothing. A pattern with an alternative that has no run gets no filter,
 * and neither does one with more alternatives than {@link MAX_LITERALS}.
 * Grep compiles the pattern with no flags, so the comparison is exact.
 */

/** More alternatives than this and the per-line checks cost more than they save. */
export const MAX_LITERALS = 8;

const PLAIN_ESCAPES: Readonly<Record<string, string>> = {
  t: "\t",
  n: "\n",
  r: "\r",
  v: "\v",
  f: "\f",
};
const QUANTIFIER_BRACE = /^\{\d+(?:,\d*)?\}/;

/** The index just past a class that opens at `i`. */
function skipClass(pattern: string, i: number): number {
  let j = i + 1;
  if (pattern[j] === "^") j++;
  while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The index just past a quantifier (and its lazy `?`) at `i`, or `i`. */
function skipQuantifier(pattern: string, i: number): number {
  let j = i;
  const c = pattern[i];
  if (c === "*" || c === "+" || c === "?") j = i + 1;
  else if (c === "{") {
    const m = pattern.slice(i, i + 24).match(QUANTIFIER_BRACE);
    if (m !== null) j = i + m[0].length;
  }
  if (j > i && pattern[j] === "?") j++;
  return j;
}

/**
 * One literal per top-level alternative (its longest required run), such
 * that every match of `pattern` contains at least one of them; `undefined`
 * when no such list can be given. The pattern must already have passed
 * tool-safety's syntax screen.
 */
export function requiredLiterals(pattern: string): string[] | undefined {
  const alternatives: string[][] = [[]];
  let run = "";
  const endRun = (): void => {
    if (run !== "") (alternatives[alternatives.length - 1] as string[]).push(run);
    run = "";
  };
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "|") {
      endRun();
      alternatives.push([]);
      i++;
      continue;
    }
    if (c === "(") {
      // Skip the whole group, and its quantifier: nothing inside is counted.
      endRun();
      let depth = 0;
      while (i < pattern.length) {
        const g = pattern[i] as string;
        if (g === "\\") i += 2;
        else if (g === "[") i = skipClass(pattern, i);
        else {
          if (g === "(") depth++;
          else if (g === ")") depth--;
          i++;
          if (depth === 0) break;
        }
      }
      i = skipQuantifier(pattern, i);
      continue;
    }
    if (c === "[") {
      endRun();
      i = skipQuantifier(pattern, skipClass(pattern, i));
      continue;
    }
    let literal: string | undefined;
    let next = i + 1;
    if (c === "\\") {
      const n = pattern[i + 1] ?? "";
      next = i + 2;
      const plain = PLAIN_ESCAPES[n];
      if (plain !== undefined) literal = plain;
      else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(pattern.slice(i + 2, i + 6))) {
        literal = String.fromCharCode(Number.parseInt(pattern.slice(i + 2, i + 6), 16));
        next = i + 6;
      } else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(pattern.slice(i + 2, i + 4))) {
        literal = String.fromCharCode(Number.parseInt(pattern.slice(i + 2, i + 4), 16));
        next = i + 4;
      } else if (/\d/.test(n)) {
        // A backreference or a legacy octal escape: all its digits go.
        while (next < pattern.length && /\d/.test(pattern[next] as string)) next++;
      } else if (n === "c" && /[A-Za-z]/.test(pattern[i + 2] ?? "")) {
        // A control character: `\cA` is U+0001, not "A".
        next = i + 3;
      } else if (n === "k" && pattern[i + 2] === "<") {
        const close = pattern.indexOf(">", i);
        next = close === -1 ? pattern.length : close + 1;
      } else if (n !== "" && !/[A-Za-z0-9_]/.test(n)) {
        literal = n;
      }
    } else if (!"^$.?*+)[]{}".includes(c)) {
      literal = c;
    }
    const after = skipQuantifier(pattern, next);
    if (literal === undefined || after !== next) {
      // Not a plain character, or a quantified one: the run ends here.
      endRun();
      i = after;
      continue;
    }
    run += literal;
    i = next;
  }
  endRun();
  if (alternatives.length > MAX_LITERALS) return undefined;
  const chosen = new Set<string>();
  for (const runs of alternatives) {
    if (runs.length === 0) return undefined;
    chosen.add(runs.reduce((a, b) => (b.length > a.length ? b : a)));
  }
  return [...chosen];
}

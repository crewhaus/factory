/**
 * linear-text.ts replaces patterns that rescanned a run from every position
 * in it. Each helper must give exactly what its pattern gave, and reading a
 * long run must not run a pattern over it.
 */
import { describe, expect, test } from "bun:test";
import { templateParaphrases } from "./dataset-mine";
import { cleanRationale, parseRubricSuggestion } from "./graders-suggest";
import {
  firstObjectSpan,
  withoutClosingMarks,
  withoutCombinatorMarkers,
  withoutJudgePrefixes,
} from "./linear-text";

const OBJECT = /\{[\s\S]*\}/;
const CLOSING = /[.?!]+$/;
const MARKER = /\[[^\]]*: [✓✗]\]/g;
const JUDGE = /judge(?:=\d+(?:\.\d+)?| abstained) \([^)]*need ≥\d+(?:\.\d+)?\):/g;

const byPattern = {
  object: (text: string): string | undefined => text.match(OBJECT)?.[0],
  closing: (text: string): string => text.replace(CLOSING, ""),
  markers: (text: string): string => text.replace(MARKER, " "),
  judge: (text: string): string => text.replace(JUDGE, " "),
};

/** Every concatenation of up to `depth` of `pieces`, `visit`ed; returns how many. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): number {
  let count = 0;
  const walk = (text: string, d: number): void => {
    visit(text);
    count++;
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
  return count;
}

/** `n` seeded pseudo-random concatenations of 1 to `maxPieces` of `pieces`. */
function randomTexts(pieces: readonly string[], n: number, maxPieces: number): string[] {
  let seed = 0x2545f491;
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    const length = 1 + next(maxPieces);
    for (let k = 0; k < length; k++) text += pieces[next(pieces.length)];
    out.push(text);
  }
  return out;
}

/**
 * Runs `body` with every regular expression run over a text holding `run`
 * refused on the spot and recorded, unless its source is in `allowed`.
 * Replacing `RegExp.prototype.exec` routes every String and RegExp method
 * that runs a pattern through it (the controls below check that for
 * `String#match` and `String#replace`); restored after.
 */
function patternsOver<T>(
  run: string,
  allowed: readonly string[],
  body: () => T,
): { refused: string[]; outcome: T | Error } {
  const refused: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && input.includes(run) && !allowed.includes(this.source)) {
      refused.push(`/${this.source}/`);
      throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { refused, outcome: body() };
  } catch (err) {
    return { refused, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

describe("each helper gives what its pattern gave", () => {
  test("firstObjectSpan", () => {
    const differ: string[] = [];
    const checked = everyText(["{", "}", "a", "\n"], 8, (t) => {
      if (firstObjectSpan(t) !== byPattern.object(t)) differ.push(t);
    });
    for (const t of ['Here:\n```json\n{"a": {"b": 2}}\n```', "} {a}", `${"{".repeat(50)}x`]) {
      if (firstObjectSpan(t) !== byPattern.object(t)) differ.push(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((4 ** 9 - 1) / 3);
  }, 20_000);

  test("withoutClosingMarks", () => {
    const differ: string[] = [];
    const checked = everyText([".", "?", "!", "a", " ", "é"], 6, (t) => {
      if (withoutClosingMarks(t) !== byPattern.closing(t)) differ.push(t);
    });
    expect(differ).toEqual([]);
    expect(checked).toBe((6 ** 7 - 1) / 5);
  }, 20_000);

  const markerPieces = ["[", "]", ":", " ", "✓", "✗", "a", ": ✓", ": ✗"];
  test("withoutCombinatorMarkers", () => {
    const differ: string[] = [];
    const visit = (t: string): void => {
      if (withoutCombinatorMarkers(t) !== byPattern.markers(t)) differ.push(t);
    };
    const checked = everyText(markerPieces, 5, visit);
    for (const t of randomTexts(markerPieces, 20_000, 16)) visit(t);
    for (const t of ["[contains: ✓] ok [len: ✗]", "[[x: ✓]", "[x: ✓]]", "[: ✓]", "[x:✓]"]) {
      visit(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((9 ** 6 - 1) / 8);
  }, 20_000);

  const judgePieces = [
    "judge=1 (",
    "judge=1.5 (",
    "judge abstained (",
    "need ≥2",
    "need ≥2.5",
    "):",
    ")",
    ":",
    "(",
    "judge",
    "=",
    "1",
    ".",
    " ",
    "x",
  ];
  test("withoutJudgePrefixes", () => {
    const differ: string[] = [];
    const visit = (t: string): void => {
      if (withoutJudgePrefixes(t) !== byPattern.judge(t)) differ.push(t);
    };
    const checked = everyText(judgePieces, 4, visit);
    for (const t of randomTexts(judgePieces, 20_000, 14)) visit(t);
    for (const t of [
      "judge=4 (need ≥3): wrong answer",
      "judge=3.5 (median of 3 repeats [3, abstain, 4], agreement 1/2, need ≥4): missed X",
      "prefix judge abstained (panel split, need ≥3): tail",
      "judge=4 (need ≥3) no colon",
      "judge=4. (need ≥3):",
      "judge=4 (need ≥3.):",
      "judge=4 (need ≥3.5.5):",
      "judge=4 (need ≥3 need ≥4):",
      "judge=4 (need ≥x need ≥4):",
      "judge=4 (need ≥4 x):",
    ]) {
      visit(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((15 ** 5 - 1) / 14);
  }, 20_000);
});

// Counted, not timed: the only place quadratic work could hide in reading
// these texts is a pattern run over the run, so each one is refused and
// recorded. Collapsing whitespace with /\s+/g needs no suffix after its run,
// so it stays linear and is allowed.
describe("long runs", () => {
  test("a rationale that is a run of [ or of judge prefixes runs no rescanning pattern", () => {
    const brackets = "[".repeat(10_000);
    // Control: the hook sees a pattern String#replace runs.
    expect(patternsOver(brackets, [], () => byPattern.markers(`x${brackets}`)).refused).toEqual([
      `/${MARKER.source}/`,
    ]);
    const marked = patternsOver(brackets, ["\\s+"], () =>
      cleanRationale(`missed it ${"[".repeat(100_000)}`),
    );
    expect(marked.refused).toEqual([]);
    expect(marked.outcome).toBe(`missed it ${"[".repeat(100_000)}`);

    const prefix = "judge=1 (".repeat(1_000);
    const judged = patternsOver(prefix, ["\\s+"], () =>
      cleanRationale(`x ${"judge=1 (".repeat(10_000)}`),
    );
    expect(judged.refused).toEqual([]);
    expect(String(judged.outcome).startsWith("x judge=1 (judge=1 (")).toBe(true);
  }, 20_000);

  test("a model reply that is a run of { has no JSON object", () => {
    const run = "{".repeat(10_000);
    // Control: the hook sees the pattern String#match runs.
    expect(patternsOver(run, [], () => byPattern.object(run)).refused).toEqual([
      `/${OBJECT.source}/`,
    ]);
    const parsed = patternsOver(run, [], () => parseRubricSuggestion("{".repeat(1_000_000)));
    expect(parsed.refused).toEqual([]);
    expect(parsed.outcome).toBeUndefined();
  });

  test("an input with a long run of ? before its last word keeps the run", () => {
    const run = "?".repeat(10_000);
    const input = `fix it${"?".repeat(1_000_000)}now???`;
    const paraphrased = patternsOver(run, [], () => templateParaphrases(input));
    expect(paraphrased.refused).toEqual([]);
    expect((paraphrased.outcome as string[])[1]).toBe(
      `I need help with this: fix it${"?".repeat(1_000_000)}now.`,
    );
  });
});

/**
 * An `rgb(…)` or `hsl(…)` colour is read in one pass.
 *
 * `\(\s*([^)]+)\)$` let the capture start with whitespace too, so when the
 * colour did not end in `)`, `\s*` gave a run of whitespace back one
 * character at a time and `[^)]+` re-read the rest of the run from each:
 * quadratic in the run. The colour is whatever the model passed to
 * ColorConvert, ColorContrast or QrEncode, with no length cap. The capture
 * now starts at a character that is not whitespace, or is a single
 * whitespace character, which is what the old one captured in a match.
 *
 * Counted, not timed: the work is the patterns' backtracking steps, counted
 * by the step model in tool-text's src/__test__/regex-work.ts, imported by
 * path so its copies stay as they are. It walks every regular expression the
 * parse runs, in ECMAScript's order, and must agree with the engine on every
 * match, so the count is of the real patterns on the real input.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { HSL_FN, RGB_FN, parseColor } from "./lib/color";

/** The patterns as they were. */
const OLD_RGB_FN = /^rgba?\(\s*([^)]+)\)$/i;
const OLD_HSL_FN = /^hsla?\(\s*([^)]+)\)$/i;

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    out.push(...layer);
  }
  return out;
}

/** `input -> answer` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

const captures = (m: RegExpMatchArray | null): unknown =>
  m === null ? null : [m.index, m[0], m[1]];

/** What parseColor did with a colour: the channels, or the refusal. */
function parsed(text: string): unknown {
  try {
    return parseColor(text);
  } catch (err) {
    return (err as Error).message;
  }
}

describe("the captures are the old patterns'", () => {
  // Bodies over parentheses, whitespace `\s` takes (a line break, a no-break
  // space and a BOM among them) and channel text, after every prefix spelling.
  const bodies = allJoins(
    [")", "(", " ", "\t", "\n", "\u2028", "\u00a0", "\ufeff", "1", ",", "x"],
    4,
  );
  const inputs = ["rgb(", "rgba(", "RgBa(", "hsl(", "HSLA(", "rgb", "rgbx(", ""].flatMap((p) =>
    bodies.map((b) => p + b),
  );

  // Some 129 000 generated colours per test: budgeted, as the house does for
  // a test that is slow by construction.
  test("RGB_FN captures what /^rgba?\\(\\s*([^)]+)\\)$/i captured", () => {
    expect(answers(inputs, (s) => captures(s.match(RGB_FN)))).toEqual(
      answers(inputs, (s) => captures(s.match(OLD_RGB_FN))),
    );
  }, 20_000);

  test("HSL_FN captures what /^hsla?\\(\\s*([^)]+)\\)$/i captured", () => {
    expect(answers(inputs, (s) => captures(s.match(HSL_FN)))).toEqual(
      answers(inputs, (s) => captures(s.match(OLD_HSL_FN))),
    );
  }, 20_000);
});

describe("a run of whitespace in a colour is read once", () => {
  // The parse now takes about 19 steps a character on these: it tries six
  // anchored patterns, each a step at every start. The old capture took about
  // 1.5 n² on a run of n: at 4 000, 24 million against this bound's 128 000.
  const STEPS_PER_CHARACTER = 32;
  const NOT_A_COLOUR = "is not a colour this package reads (hex, rgb(), hsl(), or a basic keyword)";

  test.each([
    ["rgb( and spaces, never closed", (n: number) => `rgb(${" ".repeat(n)}x`, OLD_RGB_FN],
    [
      "rgba( and spaces, then text after the )",
      (n: number) => `rgba(${" ".repeat(n)})x`,
      OLD_RGB_FN,
    ],
    ["hsl( and tabs, never closed", (n: number) => `hsl(${"\t".repeat(n)}120`, OLD_HSL_FN],
  ] as const)(
    "%s",
    (_, make, old) => {
      const colour = make(4_000);
      const bound = STEPS_PER_CHARACTER * colour.length;
      const counted = regexWork(bound, () => parsed(colour));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(String(counted.value)).toEndWith(NOT_A_COLOUR);
      // Twice the run, twice the steps (a rescan would be four times).
      const half = regexWork(bound, () => parsed(make(2_000)));
      expect(counted.steps).toBeLessThanOrEqual(2.1 * half.steps);
      // Control: the count sees the old pattern go past the bound.
      expect(regexWork(bound, () => old.exec(colour)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );

  test("a run of whitespace before the channels still reads", () => {
    const colour = `rgb(${" ".repeat(4_000)}1, 2, 3)`;
    const counted = regexWork(STEPS_PER_CHARACTER * colour.length, () => parsed(colour));
    expect(counted.unmodelled).toEqual([]);
    expect(counted.value).toEqual({ r: 1, g: 2, b: 3, a: 255 });
  });
});

/**
 * A date-time is split at its `T` in one pass.
 *
 * `/^(.+?)[Tt](.+)$/` tried every `T` or `t` in a value's first line and ran
 * `(.+)` from each to the line break that `$` cannot pass: quadratic in the
 * line. Any value with a long first line and a second line set it off, which
 * is ordinary prose. ValidateFormat, a `format: date-time` in
 * JsonSchemaValidate or ValidateRecords, and JsonSchemaInfer run the check
 * over model, web and workspace data with no length cap. DATE_TIME_SPLIT ends
 * the date at the first `T`, so a failed try gives back only characters that
 * cannot be one.
 *
 * Counted, not timed: the work is the patterns' backtracking steps, counted
 * by the step model in tool-text's src/__test__/regex-work.ts, imported by
 * path so its copies stay as they are. It walks every regular expression the
 * check runs, in ECMAScript's order, and must agree with the engine on every
 * match, so the count is of the real patterns on the real input.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import {
  DATE_TIME_SPLIT,
  type FormatResult,
  checkFormat,
  isDate,
  isTime,
  matchingFormats,
} from "./lib/formats";

/** The pattern as it was. */
const OLD_SPLIT = /^(.+?)[Tt](.+)$/;

/** isDateTime as it was, around the old pattern. */
function oldIsDateTime(value: string): FormatResult {
  const split = value.match(OLD_SPLIT);
  if (split === null) {
    return { valid: false, reason: 'expected a "T" between the date and the time' };
  }
  const date = isDate(split[1] ?? "");
  if (!date.valid) return { valid: false, reason: `date part: ${date.reason}` };
  const time = isTime(split[2] ?? "");
  if (!time.valid) return { valid: false, reason: `time part: ${time.reason}` };
  return { valid: true, reason: null };
}

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
  m === null ? null : [m.index, m[0], m[1], m[2]];

describe("the split is the old pattern's", () => {
  const inputs = [
    // Every line break `.` refuses, both cases of the separator, and the
    // characters a date and a time are made of.
    ...allJoins(["T", "t", "1", "-", ":", "Z", " ", "\n", "\r", "\u2028", "\u2029"], 5),
    "2024-02-29T12:30:00Z",
    "2024-02-29t12:30:00.123+05:30",
    "2023-02-30T12:30:00Z",
    "2024-02-29 12:30:00Z",
    "2024-02-29T12:30:00Z\n",
    "2024-02-29T12:30:00Z\u2028",
    "T2024-02-29T12:30:00Z",
    "2024-02-29TT12:30:00Z",
    "2024-02-29T",
    "The note text goes on.\nAnd a second line.",
    "\u{1F600}T\u{1F600}",
    "\uD800T\uDC00",
  ];

  // Some 177 000 generated values: budgeted, as the house does for a test
  // that is slow by construction.
  test("DATE_TIME_SPLIT captures what /^(.+?)[Tt](.+)$/ captured", () => {
    expect(answers(inputs, (s) => captures(s.match(DATE_TIME_SPLIT)))).toEqual(
      answers(inputs, (s) => captures(s.match(OLD_SPLIT))),
    );
  }, 20_000);

  test("checkFormat(date-time) answers what isDateTime answered", () => {
    // Dates, separators and times, each well formed or wrong in one way.
    const shaped = ["2024-02-29", "2023-02-30", "2024-2-29", "", "x"].flatMap((date) =>
      ["T", "t", " ", "TT", "\n", ""].flatMap((sep) =>
        ["12:30:00Z", "12:30:00.5+05:30", "24:00:00Z", "12:30:60z", "12:30:00Z\n", ""].map(
          (time) => date + sep + time,
        ),
      ),
    );
    const values = [...inputs.filter((s) => s.length <= 4), ...shaped];
    expect(answers(values, (s) => checkFormat(s, "date-time"))).toEqual(
      answers(values, oldIsDateTime),
    );
  }, 20_000);
});

describe("a long first line is read once", () => {
  // The check now takes 5 steps a character on these, and matchingFormats,
  // which runs every format, 15. The old split took about 1.5 n² on a run of
  // n t's: at 4 000 characters, 24 million against this bound's 128 000.
  const STEPS_PER_CHARACTER = 32;
  const NO_SPLIT: FormatResult = {
    valid: false,
    reason: 'expected a "T" between the date and the time',
  };
  const shapes: ReadonlyArray<readonly [string, (n: number) => string]> = [
    ["a run of t, then a line break", (n) => `${"t".repeat(n)}\n`],
    ["a run of T, then a U+2028", (n) => `${"T".repeat(n)}\u2028x`],
    [
      "prose, then a second line",
      (n) => `${"The note text goes on. ".repeat(Math.ceil(n / 23))}\nAnd a second line.`,
    ],
  ];

  test.each(shapes)(
    "%s",
    (_, make) => {
      const value = make(4_000);
      const bound = STEPS_PER_CHARACTER * value.length;
      const counted = regexWork(bound, () => checkFormat(value, "date-time"));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value).toEqual(NO_SPLIT);
      // Twice the line, twice the steps (a rescan would be four times).
      const half = regexWork(bound, () => checkFormat(make(2_000), "date-time"));
      expect(counted.steps).toBeLessThanOrEqual(2.1 * half.steps);
      // Control: the count sees the old pattern go past the bound.
      expect(regexWork(bound, () => OLD_SPLIT.exec(value)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );

  test.each(shapes)(
    "matchingFormats, %s",
    (_, make) => {
      const value = make(4_000);
      const bound = STEPS_PER_CHARACTER * value.length;
      const counted = regexWork(bound, () => matchingFormats(value));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value).toEqual([]);
    },
    20_000,
  );
});

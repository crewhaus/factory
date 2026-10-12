/**
 * A subtitle timing line is read in one pass.
 *
 * `/^(.*?)-->(.*?)$/` tried every `-->` on a line and ran from each to the
 * line break that `$` cannot pass. Folding `\r\n` leaves U+2028 and U+2029
 * inside a line, so a line of arrows with one of those was quadratic in its
 * length, and SubtitleParse reads a workspace file of up to 32 MiB. TIMING
 * now takes only the characters before the first `-->` as the start, so a
 * failed try gives each back in a step.
 *
 * Counted, not timed: the work is the patterns' backtracking steps, counted
 * by the step model in tool-text's src/__test__/regex-work.ts, imported by
 * path so its copies stay as they are. It walks every regular expression the
 * parse runs, in ECMAScript's order, and must agree with the engine on every
 * match, so the count is of the real patterns on the real input.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { type ParseResult, type SubtitleFormat, TIMING, parseSubtitles } from "./lib/subtitle";

/** The pattern as it was. */
const OLD_TIMING = /^(.*?)-->(.*?)$/;

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

test("TIMING captures what /^(.*?)-->(.*?)$/ captured", () => {
  const inputs = [
    // Arrows whole and in parts, and every line break `.` refuses.
    ...allJoins(["-", ">", "-->", "a", " ", "\n", "\r", "\u2028", "\u2029"], 5),
    "00:00:01,000 --> 00:00:02,500",
    "00:00:01.000 --> 00:00:02.500 align:start position:10%",
    "00:01.000-->00:02.000",
    "00:00:01,000 --> 00:00:02,500 --> 00:00:03,000",
    "00:00:01,000 -> 00:00:02,500",
    "00:00:01,000 --> 00:00:02,500\u2028",
    "\u{1F600}-->\u{1F600}",
  ];
  // Some 66 000 generated lines: budgeted, as the house does for a test
  // that is slow by construction.
  expect(answers(inputs, (s) => captures(s.match(TIMING)))).toEqual(
    answers(inputs, (s) => captures(s.match(OLD_TIMING))),
  );
}, 20_000);

describe("a line of arrows is read once", () => {
  // The parse now takes about 10 steps a character on these. The old pattern
  // took about 3 n² on a line of n arrows: at 2 000 arrows, 12 million
  // against this bound's 192 000.
  const STEPS_PER_CHARACTER = 32;
  const arrows = (n: number, end: string): string => `${"-->".repeat(n)}${end}x`;

  const cases: ReadonlyArray<
    readonly [string, (n: number) => string, SubtitleFormat, ParseResult]
  > = [
    [
      "an SRT block whose timing line holds a U+2028",
      (n) => `1\n${arrows(n, "\u2028")}`,
      "srt",
      { format: "srt", cues: [], skipped: [{ block: 0, reason: "no timing line" }] },
    ],
    [
      "a WebVTT identifier line holding a U+2029, then a cue",
      (n) => `WEBVTT\n\n${arrows(n, "\u2029")}\n00:01.000 --> 00:02.000\nhello`,
      "vtt",
      {
        format: "vtt",
        cues: [
          { index: 1, startMs: 1000, endMs: 2000, text: "hello", id: arrows(2_000, "\u2029") },
        ],
        skipped: [],
      },
    ],
  ];

  test.each(cases)(
    "%s",
    (_, make, format, parsed) => {
      const text = make(2_000);
      const bound = STEPS_PER_CHARACTER * text.length;
      const counted = regexWork(bound, () => parseSubtitles(text, format));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value).toEqual(parsed);
      // Twice the arrows, twice the steps (a rescan would be four times).
      const half = regexWork(bound, () => parseSubtitles(make(1_000), format));
      expect(counted.steps).toBeLessThanOrEqual(2.1 * half.steps);
      // Control: the count sees the old pattern go past the bound.
      const line = text.split("\n").find((l) => l.startsWith("-->")) as string;
      expect(regexWork(bound, () => OLD_TIMING.exec(line)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );
});

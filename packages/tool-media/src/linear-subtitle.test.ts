/**
 * A subtitle timing line is read in one pass, however long it is.
 *
 * `/^(.*?)-->(.*?)$/` tried every `-->` on a line and ran from each to the
 * line break that `$` cannot pass. Folding `\r\n` leaves U+2028 and U+2029
 * inside a line, so a line of arrows with one of those was quadratic in its
 * length, and SubtitleParse reads a workspace file of up to 32 MiB.
 * timingParts now finds the first `-->` and any line break with one search
 * each.
 *
 * It runs no pattern that repeats a group. The first rewrite,
 * `/^((?:(?!-->).)*)-->(.*)$/`, was linear but repeated a group once per
 * character before the arrow, and JavaScriptCore silently returns no match
 * once a group repeats a million times or so (for this one, 1 114 111): a
 * timing line with that much before its arrow stopped being one, and its cue
 * was dropped or read wrongly.
 *
 * Counted, not timed: the work is the patterns' backtracking steps, counted
 * by the step model in tool-text's src/__test__/regex-work.ts, imported by
 * path so its copies stay as they are. It walks every regular expression the
 * parse runs, in ECMAScript's order, and must agree with the engine on every
 * match, so the count is of the real patterns on the real input.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { type ParseResult, type SubtitleFormat, parseSubtitles, timingParts } from "./lib/subtitle";

/** The pattern as it was. */
const OLD_TIMING = /^(.*?)-->(.*?)$/;
const oldParts = (line: string): readonly [string, string] | null => {
  const m = line.match(OLD_TIMING);
  return m === null ? null : [m[1] as string, m[2] as string];
};

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

test("timingParts splits a line where /^(.*?)-->(.*?)$/ did", () => {
  const breaks = ["\n", "\r", "\u2028", "\u2029"];
  const inputs = [
    // Arrows whole and in parts, and every line break `.` refuses; then a
    // lone surrogate and a character outside the BMP among them.
    ...allJoins(["-", ">", "-->", "a", " ", ...breaks], 5),
    ...allJoins(["-", ">", "-->", "a", "\r", "\u2028", "\uD800", "\u{1F600}"], 4),
    "00:00:01,000 --> 00:00:02,500",
    "00:00:01.000 --> 00:00:02.500 align:start position:10%",
    "00:01.000-->00:02.000",
    "00:00:01,000 --> 00:00:02,500 --> 00:00:03,000",
    "00:00:01,000 -> 00:00:02,500",
    "00:00:01,000 --> 00:00:02,500\u2028",
  ];
  // Some 71 000 generated lines: budgeted, as the house does for a test
  // that is slow by construction.
  expect(answers(inputs, timingParts)).toEqual(answers(inputs, oldParts));
}, 20_000);

describe("a timing line past a million characters is still one", () => {
  // Well past the 1 114 111 repeats at which JavaScriptCore stopped matching
  // the first rewrite. Building and reading lines this long is slow by
  // construction on a slow runner, so each test is budgeted.
  const LONG = 2 ** 21;
  const lengths = (parts: readonly [string, string] | null) =>
    parts === null ? null : parts.map((part) => part.length);

  test("split where the old pattern split it, before the arrow or after it", () => {
    for (const line of [
      `${"a".repeat(LONG)}-->b`,
      `${" ".repeat(LONG)}00:00:03,000 --> 00:00:04,000`,
      `a-->${"b".repeat(LONG)}`,
      `${"a".repeat(LONG)}-->b\u2028`,
    ]) {
      expect(lengths(timingParts(line))).toEqual(lengths(oldParts(line)));
    }
    expect(lengths(timingParts(`${"a".repeat(LONG)}-->b`))).toEqual([LONG, 1]);
  }, 20_000);

  test("an SRT timing line padded with blanks still times its cue", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "hi",
      "",
      "2",
      `${" ".repeat(LONG)}00:00:03,000 --> 00:00:04,000`,
      "yo",
      "",
    ].join("\n");
    expect(parseSubtitles(srt, "srt")).toEqual({
      format: "srt",
      cues: [
        { index: 1, startMs: 1000, endMs: 2000, text: "hi" },
        { index: 2, startMs: 3000, endMs: 4000, text: "yo" },
      ],
      skipped: [],
    });
  }, 20_000);

  test("a WebVTT first line with an arrow is a timing line, not an identifier", () => {
    const vtt = `WEBVTT\n\n${"x".repeat(LONG)}-->\n00:01.000 --> 00:02.000\nhello\n`;
    const parsed = parseSubtitles(vtt, "vtt");
    // As before: the line is the block's timing line, and its start is no
    // timestamp, so the block is skipped rather than read as a cue with that
    // line for its identifier.
    expect(parsed.cues).toEqual([]);
    expect(
      parsed.skipped.map((s) => [s.block, s.reason.endsWith("is not a subtitle timestamp")]),
    ).toEqual([[0, true]]);
  }, 20_000);
});

describe("a line of arrows is read once", () => {
  // The parse now takes about 6 steps a character on these. The old pattern
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

  /** The parse of `make(2 000)`, held to the bound and to linear growth. */
  const readOnce = (make: (n: number) => string, format: SubtitleFormat) => {
    const text = make(2_000);
    const bound = STEPS_PER_CHARACTER * text.length;
    const counted = regexWork(bound, () => parseSubtitles(text, format));
    expect(counted.unmodelled).toEqual([]);
    expect(counted.steps).toBeLessThanOrEqual(bound);
    // Twice the arrows, twice the steps (a rescan would be four times).
    const half = regexWork(bound, () => parseSubtitles(make(1_000), format));
    expect(counted.steps).toBeLessThanOrEqual(2.1 * half.steps);
    return { text, bound, value: counted.value };
  };

  test.each(cases)(
    "%s",
    (_, make, format, parsed) => {
      const { text, bound, value } = readOnce(make, format);
      expect(value).toEqual(parsed);
      // Control: the count sees the old pattern go past the bound.
      const line = text.split("\n").find((l) => l.startsWith("-->")) as string;
      expect(regexWork(bound, () => line.match(OLD_TIMING)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );

  // With no break the line is a timing line, which the old pattern read once
  // too; this holds the split to one search, not one from every arrow.
  test("an SRT timing line of nothing but arrows", () => {
    const { value } = readOnce((n) => `1\n${arrows(n, "")}`, "srt");
    expect(value).toEqual({
      format: "srt",
      cues: [],
      skipped: [{ block: 0, reason: '"" is not a subtitle timestamp' }],
    });
  }, 20_000);
});

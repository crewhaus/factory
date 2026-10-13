/**
 * A `.env` assignment is matched in one pass.
 *
 * `/^(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/` gave the
 * blanks after `=` back one at a time when a line break that `.` cannot pass
 * (`\r`, U+2028, U+2029) sat later in the line, and ran `(.*)` to it from
 * each: quadratic in the blanks. Lines are split on `\n` only, so such a
 * break survives into the line, and the file is a workspace `.env` that
 * EnvFileUpsert, SecretRotate and `envfile:` references read. ASSIGN_RE now
 * takes the blanks whole; a match never gave any back, so the groups are the
 * same.
 *
 * Counted, not timed: the work is the patterns' backtracking steps, counted
 * by the step model in tool-text's src/__test__/regex-work.ts, imported by
 * path so its copies stay as they are. It walks every regular expression the
 * read runs, in ECMAScript's order, and must agree with the engine on every
 * match, so the count is of the real patterns on the real input.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
import { ASSIGN_RE, decodeAssignment, exportedAssignment, parseEnvDoc } from "./lib/envfile";

/** The pattern as it was. */
const OLD_ASSIGN = /^(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

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
  m === null ? null : [m.index, m[0], m[1], m[2], m[3]];

test("ASSIGN_RE captures what the old pattern captured", () => {
  const inputs = [
    // The prefix, blanks of both kinds, key characters, `=`, and every
    // line break `.` refuses.
    ...allJoins(["export", " ", "\t", "=", "A", "_", "1", "\r", "\n", "\u2028", "\u2029"], 5),
    "export SLACK_BOT_TOKEN=xoxb-1",
    "export  \t SLACK_BOT_TOKEN = 'quoted value'",
    "ANTHROPIC_API_KEY=  sk-ant-aaaa  # note",
    "export=1",
    "export =1",
    "exportFOO=1",
    "export A B=1",
    "A==b",
    "A= \r b",
    "A=\u{1F600}",
  ];
  // Some 177 000 generated lines: budgeted, as the house does for a test
  // that is slow by construction.
  expect(answers(inputs, (s) => captures(s.match(ASSIGN_RE)))).toEqual(
    answers(inputs, (s) => captures(s.match(OLD_ASSIGN))),
  );
}, 20_000);

describe("blanks before a line break are read once", () => {
  // The read now takes about 6 steps a character on these. The old pattern
  // took about 1.5 n² on n blanks: at 4 000, 24 million against this bound's
  // 128 000.
  const STEPS_PER_CHARACTER = 32;
  const shapes: ReadonlyArray<readonly [string, (n: number) => string]> = [
    ["spaces, then a carriage return", (n) => `A=${" ".repeat(n)}\rX`],
    ["tabs on an export line, then a U+2028", (n) => `export A=${"\t".repeat(n)}\u2028X`],
    ["spaces, then a U+2029", (n) => `A = ${" ".repeat(n)}\u2029X`],
  ];

  test.each(shapes)(
    "%s",
    (_, make) => {
      const line = make(4_000);
      const bound = STEPS_PER_CHARACTER * line.length;
      const counted = regexWork(bound, () => {
        const doc = parseEnvDoc(`${line}\n`);
        return {
          kinds: doc.lines.map((l) => l.kind),
          decoded: decodeAssignment(line),
          exported: exportedAssignment(doc, "A"),
        };
      });
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      // Not an assignment, as before: kept verbatim and read as a comment.
      expect(counted.value).toEqual({ kinds: ["comment"], decoded: undefined, exported: false });
      // Twice the blanks, twice the steps (a rescan would be four times).
      const half = regexWork(bound, () => parseEnvDoc(`${make(2_000)}\n`));
      const whole = regexWork(bound, () => parseEnvDoc(`${line}\n`));
      expect(whole.steps).toBeLessThanOrEqual(2.1 * half.steps);
      // Control: the count sees the old pattern go past the bound.
      expect(regexWork(bound, () => OLD_ASSIGN.exec(line)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );
});

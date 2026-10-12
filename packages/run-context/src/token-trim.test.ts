/**
 * trimToken strips a token's wrappers with loops, not `/["'`)\]}>.,;:!?]+$/`,
 * which rescans a run of punctuation from every position in it and so took
 * time quadratic in a run that is not at the end of the token.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { createRunContext, tagContent } from "./index";
import { trimToken } from "./token-trim";

/** The two patterns trimToken replaced, applied the way it applied them. */
const byRegex = (raw: string): string =>
  raw.replace(/^["'`(<[{]+/, "").replace(/["'`)\]}>.,;:!?]+$/, "");

/**
 * Runs `body` with every regular expression run refused on the spot and
 * recorded. Replacing `RegExp.prototype.exec` routes every String and RegExp
 * method that runs a pattern through it (the control below checks that for
 * `String#replace`); restored after.
 */
function regexRuns<T>(body: () => T): { runs: string[]; outcome: T | Error } {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    runs.push(`/${this.source}/ over ${String(input).length} characters`);
    throw new Error(`/${this.source}/ ran`);
  };
  try {
    return { runs, outcome: body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

describe("trimToken", () => {
  test("strips exactly what the two patterns stripped", () => {
    const cases = [
      "",
      "a",
      "sk-abc123",
      '"sk-abc123"',
      "(token)",
      "<{[x]}>",
      "key=value.",
      "value...",
      "a...b",
      "...",
      "!?!?",
      '"',
      '".',
      "'`",
      "((((",
      "))))",
      "(a)(b)",
      "a. ",
      " a.",
      "é…",
      "日本語。",
      "x😀.",
      "😀",
      "\u00a0.",
      `x${".".repeat(50)}y${"!".repeat(50)}`,
    ];
    for (const raw of cases) expect(`${raw} → ${trimToken(raw)}`).toBe(`${raw} → ${byRegex(raw)}`);
  });

  test("agrees with the patterns on every string of up to four characters from the classes and their neighbours", () => {
    const alphabet = [
      '"',
      "'",
      "`",
      "(",
      ")",
      "<",
      ">",
      "[",
      "]",
      "{",
      "}",
      ".",
      ",",
      ";",
      ":",
      "!",
      "?",
      "a",
      " ",
      "é",
    ];
    let checked = 0;
    const differ: string[] = [];
    const visit = (prefix: string): void => {
      if (trimToken(prefix) !== byRegex(prefix)) differ.push(prefix);
      checked++;
      if (prefix.length === 4) return;
      for (const c of alphabet) visit(prefix + c);
    };
    visit("");
    expect(differ).toEqual([]);
    expect(checked).toBe(1 + 20 + 20 ** 2 + 20 ** 3 + 20 ** 4);
  }, 20_000);

  // Counted, not timed: a pattern run over the token is refused and
  // recorded. The trim's own reads are counted below.
  test("runs no pattern over the token, however long its run of punctuation", () => {
    const dots = ".".repeat(100_000);
    // Control: the hook sees a pattern String#replace runs.
    expect(regexRuns(() => `x${dots}y`.replace(/["'`)\]}>.,;:!?]+$/, "")).runs).toEqual([
      `/["'\`)\\]}>.,;:!?]+$/ over ${dots.length + 2} characters`,
    ]);
    const trimmed = regexRuns(() => trimToken(`("x${dots}y${dots}")`));
    expect(trimmed.runs).toEqual([]);
    expect(trimmed.outcome).toBe(`x${dots}y`);
  });
});

describe("tagContent on a long run of punctuation", () => {
  // A hang detector, not a timing: one token of a million dots between two
  // letters. The loops read it once (a few milliseconds here); the old
  // pattern needed on the order of 10^12 steps for it, hours on any
  // machine, so only a return to a quadratic trim can reach the budget.
  test("tags the token without rescanning the run", () => {
    const ctx = createRunContext({});
    const token = `sk-${"a".repeat(30)}${".".repeat(1_000_000)}x`;
    tagContent(ctx, `prefix ${token} suffix`, "tool");
    expect(ctx.dataLineage?.get(token)).toBe("tool");
  }, 30_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a search
// that resumes one character on instead of after what it read), so its own
// reads are counted (__test__/scan-work.ts) over tokens shaped to make it
// rescan, and held to a few per character. A rescan reads the rest of the run
// from every place in it and stops at the bound at once.
describe("the trim takes a long token in a bounded number of reads", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a run of punctuation inside the token", trimToken, `x${".".repeat(N)}y`],
    [
      "runs of wrappers and punctuation at its ends",
      trimToken,
      `${"(".repeat(N)}x${".".repeat(N)}`,
    ],
  ];
  for (const [label, scan, text] of cases) {
    test(label, () => {
      const most = PER_CHARACTER * text.length;
      const { work } = scanWork(most, () => scan(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
    });
  }
});

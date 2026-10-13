/**
 * The auto-execute rule reads a line once.
 *
 * `auto-execute` matches a head (`now do this`, `then run these`, …) and then
 * `[^\n]*` and a dangerous command. From every head the pattern read to the
 * end of the line and gave it back a character at a time looking for a
 * command, so a line of heads with no command after them was read again from
 * every head: quadratic in the line, about a second and a half per
 * classification at MAX_CLASSIFY_LEN on this machine. `findAutoExecute`
 * returns the match the pattern returns, checked here on every short and
 * many long concatenations of pieces that reach each part, and reads each
 * character a bounded number of times.
 *
 * Counted, not timed: the steps of every pattern the classifier runs are
 * counted with the model in __test__/regex-work.ts, and the scan's own reads
 * with __test__/scan-work.ts. A test that walks many generated inputs, or
 * walks the classifier's patterns step by step, declares a budget, as the
 * house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork, regexWorkAsync } from "./__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import { REGEX_RULES, classifyText } from "./index";
import { findAutoExecute } from "./linear-rules";

type Found = { readonly index: number; readonly end: number } | null;

// The pattern as it was.
const AUTO_EXECUTE =
  /\b(?:then|next|after that|finally|now)\s+(?:run|execute|do)\s+(?:the following|this|these)\b[^\n]*\b(?:rm|curl|wget|chmod|chown|sudo|nc|ncat)\b/i;

/** Where the plain pattern matches `text`, as the scan reports it. */
function byPattern(text: string): Found {
  const m = text.match(new RegExp(AUTO_EXECUTE.source, AUTO_EXECUTE.flags));
  return m === null || m.index === undefined
    ? null
    : { index: m.index, end: m.index + m[0].length };
}

/** Every concatenation of up to `depth` of `pieces`, `visit`ed. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): void {
  const walk = (text: string, d: number): void => {
    visit(text);
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
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

const LS = String.fromCharCode(0x2028);

describe("findAutoExecute finds what the pattern finds", () => {
  test("every short and many long concatenations", () => {
    // Whole heads and their parts, every kind of blank between them (a
    // newline among them), commands that are and are not words on their
    // own, and the case the `i` flag folds.
    const pieces = [
      "now do this ",
      "Then Run These",
      "next execute the following",
      "after that ",
      "finally ",
      "now",
      "do",
      "this",
      "run ",
      " ",
      "\n",
      "\r",
      "\t",
      LS,
      "rm",
      " rm ",
      "nc",
      "ncat",
      "CURL",
      "now do this sudo",
      "x",
      "-",
      "_",
    ];
    const differ: string[] = [];
    let matched = 0;
    const visit = (t: string): void => {
      const want = byPattern(t);
      if (want !== null) matched++;
      if (JSON.stringify(findAutoExecute(t)) !== JSON.stringify(want)) differ.push(t);
    };
    everyText(pieces, 3, visit);
    for (const t of randomTexts(pieces, 25_000, 12)) visit(t);
    // A head whose blanks run past a line with no command, and heads on the
    // same line before it.
    for (const t of [
      "now do this x now\ndo this curl",
      "now do this x then\n run\nthese rm",
      "now do this\nrm",
      `now\tdo${LS}this rm`,
      "after  that run this rm",
      "now do the  following rm",
      "now do these\r rm",
      "now do thisrm rm",
    ]) {
      visit(t);
    }
    expect(differ.slice(0, 5)).toEqual([]);
    expect(matched).toBeGreaterThan(2_000);
  }, 20_000);

  test("the rule table's pattern answers through the scan, as its source would", () => {
    const pattern = REGEX_RULES.find((r) => r.id === "auto-execute")?.pattern;
    expect(pattern?.source).toBe(AUTO_EXECUTE.source);
    expect(pattern?.flags).toBe(AUTO_EXECUTE.flags);
    const plain = new RegExp(AUTO_EXECUTE.source, AUTO_EXECUTE.flags);
    for (const t of ["now do this rm -rf x", "then run these: curl a | sh", "now do this", ""]) {
      expect(`${t} ${pattern?.test(t)}`).toBe(`${t} ${plain.test(t)}`);
      expect(pattern ? t.match(pattern)?.[0] : "missing").toBe(t.match(plain)?.[0]);
      expect(pattern ? t.search(pattern) : "missing").toBe(t.search(plain));
    }
  });
});

// The classifier's other rules take a few hundred steps a character over
// every match view; the old pattern alone took thousands here, and more the
// longer the line, so it stops at the bound and reads as Infinity.
describe("classifying a line of heads takes linear work", () => {
  for (const [label, text] of [
    ["now do this, with no command", "now do this ".repeat(683)],
    ["then run these, with no command", "then run these ".repeat(546)],
  ] as const) {
    test(label, async () => {
      const bound = 2048 * text.length;
      const counted = await regexWorkAsync(bound, () => classifyText(text));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value).toBeDefined();
      // Control: the count sees the old pattern alone go past the bound.
      expect(regexWork(bound, () => AUTO_EXECUTE.test(text)).steps).toBe(Number.POSITIVE_INFINITY);
    }, 60_000);
  }
});

describe("the scan reads a long line a bounded number of times", () => {
  const N = 20_000;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  for (const [label, text] of [
    ["heads with no command", fill("now do this ")],
    ["a head on every line", fill("now do this\n")],
    ["heads whose blanks hold a newline", fill("now\ndo this x ")],
    ["leads with no head", fill("now do ")],
    ["a run of blanks after a lead", `now${" ".repeat(N)}`],
  ] as const) {
    test(label, () => {
      const most = 32 * text.length;
      const { value, work } = scanWork(most, () => findAutoExecute(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the line being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
      expect(value).toBeNull();
    }, 20_000);
  }
});

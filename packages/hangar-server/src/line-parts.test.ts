/**
 * line-parts.ts reads headings and checkbox items without the patterns that
 * gave back a run of spaces one character at a time when the line ended in
 * a `\r`.
 */
import { describe, expect, test } from "bun:test";
import { checkboxParts, headingText } from "./line-parts";
import { curriculumRungs } from "./memory-ops";
import { headingTitle } from "./wiki-ops";

const HEADING = /^#{1,3}\s+(.*)$/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

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
  let seed = 0x7f4a7c15;
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
 * refused on the spot and recorded. Replacing `RegExp.prototype.exec` routes
 * every String and RegExp method that runs a pattern through it (the control
 * below checks that); restored after.
 */
function patternsOver<T>(run: string, body: () => T): { refused: string[]; outcome: T | Error } {
  const refused: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && input.includes(run)) {
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

describe("each line reader returns its pattern's captures", () => {
  test("headingText", () => {
    const pieces = ["#", "###", " ", "\t", "\r", "\u2028", "a", "\n"];
    const differ: string[] = [];
    let matched = 0;
    const visit = (line: string): void => {
      const want = line.match(HEADING)?.[1];
      if (want !== undefined) matched++;
      if (headingText(line) !== want) differ.push(line);
    };
    const checked = everyText(pieces, 5, visit);
    for (const line of randomTexts(pieces, 20_000, 10)) visit(line);
    expect(differ).toEqual([]);
    expect(checked).toBe((8 ** 6 - 1) / 7);
    expect(matched).toBeGreaterThan(1_000);
  }, 20_000);

  test("checkboxParts", () => {
    const pieces = [
      "- ",
      "*",
      "-",
      " ",
      "\t",
      "\r",
      "\u2028",
      "[",
      "]",
      "[ ]",
      "[x]",
      "[X]",
      "x",
      "- [ ] ",
      "* [x] ",
      "a",
    ];
    const differ: string[] = [];
    let matched = 0;
    const visit = (line: string): void => {
      const m = line.match(CHECKBOX);
      const want = m === null ? null : [m[1] ?? "", m[2] ?? ""];
      if (want !== null) matched++;
      if (JSON.stringify(checkboxParts(line)) !== JSON.stringify(want)) differ.push(line);
    };
    const checked = everyText(pieces, 4, visit);
    for (const line of randomTexts(pieces, 30_000, 10)) visit(line);
    expect(differ).toEqual([]);
    expect(checked).toBe((16 ** 5 - 1) / 15);
    expect(matched).toBeGreaterThan(1_000);
  }, 20_000);
});

// Counted, not timed: no pattern runs over the run of spaces.
describe("CRLF documents with a long run of spaces in a line", () => {
  test("a wiki title and the curriculum rungs are read without a pattern over it", () => {
    const run = " ".repeat(10_000);
    // Control: the hook sees the pattern String#match runs.
    expect(patternsOver(run, () => `#${run}x\r`.match(HEADING)).refused).toEqual([
      `/${HEADING.source}/`,
    ]);
    const body = `#${" ".repeat(200_000)}x\r\n# Deploy\r\nsteps`;
    const title = patternsOver(run, () => headingTitle(body, "fallback"));
    expect(title.refused).toEqual([]);
    expect(title.outcome).toBe("fallback");
    const ladder = `- [x] basics\r\n- [ ]${" ".repeat(200_000)}x\r\n- [ ] next`;
    const rungs = patternsOver(run, () => curriculumRungs(ladder));
    expect(rungs.refused).toEqual([]);
    // The CRLF lines do not match (`.` stops at the `\r`), as before; the last does.
    expect(rungs.outcome).toEqual([{ done: false, text: "next" }]);
  });
});

/**
 * line-parts.ts reads the curriculum's unchecked rung without
 * `/^\s*[-*]\s*\[\s\]\s*(.+)$/`, which gave back the spaces after the box one
 * at a time when the line ended in a `\r`.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { nextCurriculumRung } from "./learning";
import { uncheckedRungText } from "./line-parts";

const RUNG = /^\s*[-*]\s*\[\s\]\s*(.+)$/;

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

describe("uncheckedRungText", () => {
  test("returns what the pattern captured", () => {
    const pieces = ["- ", "*", "-", " ", "\t", "\r", "\u2028", "[", "]", "[ ]", "[\t]", "[x]", "a"];
    const differ: string[] = [];
    let matched = 0;
    const visit = (line: string): void => {
      const want = RUNG.exec(line)?.[1];
      if (want !== undefined) matched++;
      if (uncheckedRungText(line) !== want) differ.push(line);
    };
    const checked = everyText(pieces, 4, visit);
    for (const line of randomTexts(pieces, 30_000, 10)) visit(line);
    expect(differ).toEqual([]);
    expect(checked).toBe((13 ** 5 - 1) / 12);
    expect(matched).toBeGreaterThan(1_000);
  }, 20_000);

  // Counted, not timed: no pattern runs over the run of spaces.
  test("a CRLF curriculum with a long run of spaces after a box runs no pattern over it", () => {
    const run = " ".repeat(10_000);
    // Control: the hook sees the pattern RegExp#exec runs.
    expect(patternsOver(run, () => RUNG.exec(`- [ ]${run}x\r`)).refused).toEqual([
      `/${RUNG.source}/`,
    ]);
    const curriculum = `- [x] basics\r\n- [ ]${" ".repeat(200_000)}x\r\n- [ ] next`;
    const next = patternsOver(run, () => nextCurriculumRung(curriculum));
    expect(next.refused).toEqual([]);
    expect(next.outcome).toBe("next");
  });
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a search
// that resumes one character on instead of after what it read), so its own
// reads are counted (__test__/scan-work.ts) over lines shaped to make it
// rescan, and held to a few per character. A rescan reads the rest of the run
// from every place in it and stops at the bound at once.
describe("the rung read takes a long line in a bounded number of reads", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a CRLF rung with a long run of spaces", uncheckedRungText, `- [ ]${" ".repeat(N)}x\r`],
    ["a rung that is a long run of spaces", uncheckedRungText, `- [ ]${" ".repeat(N)}`],
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

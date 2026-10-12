/**
 * line-parts.ts reads an issue's bullet and numbered items without
 * `/^\s*[-*]\s+(.+)$/` and `/^\s*\d+\.\s+(.+)$/`, which gave back the spaces
 * after the marker one at a time when the line held a `\r` or a U+2028.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { compileContract } from "./index";
import { bulletText, numberedText } from "./line-parts";

const BULLET = /^\s*[-*]\s+(.+)$/;
const NUMBERED = /^\s*\d+\.\s+(.+)$/;

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
  let seed = 0x1b873593;
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
 * Runs `body` with the item patterns refused on the spot, and recorded, when
 * they run over a text holding `run`; every other pattern runs. Replacing
 * `RegExp.prototype.exec` routes every String and RegExp method that runs a
 * pattern through it (the control below checks that); restored once `body`
 * settles.
 */
async function patternsOver<T>(
  run: string,
  body: () => Promise<T>,
): Promise<{ refused: string[]; outcome: T | Error }> {
  const refused: string[] = [];
  const items = new Set([BULLET.source, NUMBERED.source]);
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && items.has(this.source) && input.includes(run)) {
      refused.push(`/${this.source}/`);
      throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { refused, outcome: await body() };
  } catch (err) {
    return { refused, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

describe("each item read returns what its pattern captured", () => {
  // Every space, tab, line break and marker the patterns tell apart; NEL as a
  // control that is neither whitespace nor a line terminator to them; and
  // text with a space inside it.
  const pieces = [
    " ",
    "\t",
    "\r",
    "\u2028",
    "\u2029",
    "\u00a0",
    "\u0085",
    "-",
    "*",
    "1",
    "12",
    ".",
    "x",
    "a b",
  ];
  const readers: ReadonlyArray<readonly [RegExp, (line: string) => string | undefined]> = [
    [BULLET, bulletText],
    [NUMBERED, numberedText],
  ];
  for (const [pattern, read] of readers) {
    test(read.name, () => {
      const differ: string[] = [];
      let matched = 0;
      const visit = (line: string): void => {
        const want = line.match(pattern)?.[1];
        if (want !== undefined) matched++;
        if (read(line) !== want) differ.push(JSON.stringify(line));
      };
      const checked = everyText(pieces, 5, visit);
      for (const line of randomTexts(pieces, 30_000, 12)) visit(line);
      expect(differ).toEqual([]);
      expect(checked).toBe((14 ** 6 - 1) / 13);
      expect(matched).toBeGreaterThan(1_000);
    }, 20_000);
  }
});

// Counted, not timed: the item patterns are refused if they run over the run;
// the rest of the compiler runs as usual. The item reads' own reads are
// counted below.
describe("an issue with a long run of spaces in an item line", () => {
  test("is compiled without the item patterns over it", async () => {
    const run = " ".repeat(10_000);
    // Control: the hook sees the pattern String#match runs.
    expect((await patternsOver(run, async () => `-${run}x\r`.match(BULLET))).refused).toEqual([
      `/${BULLET.source}/`,
    ]);
    const spaces = " ".repeat(200_000);
    const rawIssue = [
      "Title",
      `-${spaces}x\u2028y`,
      `1.${spaces}x\ry`,
      "- handle empty input",
      "2. return the top ten",
    ].join("\n");
    const compiled = await patternsOver(run, () => compileContract({ rawIssue }));
    expect(compiled.refused).toEqual([]);
    const contract = compiled.outcome as Awaited<ReturnType<typeof compileContract>>;
    // The lines holding a U+2028 or a lone CR are no items, as before.
    expect(contract.requirements.filter((r) => r.source === "user").map((r) => r.text)).toEqual([
      "handle empty input",
      "return the top ten",
    ]);
  }, 20_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a search
// that resumes one character on instead of after what it read), so each item
// read's own reads are counted (__test__/scan-work.ts) over lines shaped to
// make it rescan, and held to a few per character. A rescan reads the rest of
// the run from every place in it and stops at the bound at once.
describe("each item read takes a long line in a bounded number of reads", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const spaces = " ".repeat(N);
  const cases: ReadonlyArray<readonly [string, (line: string) => unknown, string]> = [
    ["a bullet with a U+2028 after a run of spaces", bulletText, `-${spaces}x\u2028y`],
    ["a bullet that is a run of spaces", bulletText, `-${spaces}`],
    ["a numbered item with a CR after a run of spaces", numberedText, `1.${spaces}x\ry`],
    ["a long number with no dot", numberedText, "1".repeat(N)],
  ];
  for (const [label, read, line] of cases) {
    test(label, () => {
      const most = PER_CHARACTER * line.length;
      const { work } = scanWork(most, () => read(line));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a read that took it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(line.length);
    });
  }
});

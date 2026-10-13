/**
 * cli-markdown-lines.ts reads the parts of a markdown line without the four
 * patterns the renderer used, which gave back a run of whitespace one
 * character at a time when the rest of the line could not match. Each
 * function must return its pattern's captures, and rendering a reply with
 * such a line must not run those patterns.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import { createCliMarkdownRenderer } from "./cli-markdown";
import { bulletParts, fenceParts, headingParts, numberedParts } from "./cli-markdown-lines";

const FENCE = /^(\s*)```\s*(\S*)\s*$/;
const HEADING = /^(\s*)(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)\.\s+(.*)$/;

/** The captures of `pattern` on `line`, or null. */
const captures = (pattern: RegExp, line: string): string[] | null => {
  const m = pattern.exec(line);
  return m === null ? null : m.slice(1).map((c) => c ?? "");
};

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
  let seed = 0x3c6ef372;
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

describe("each line reader returns its pattern's captures", () => {
  test("on every line of up to four pieces and on seeded random ones", () => {
    const pieces = [
      " ",
      "\t",
      "\r",
      "\u2028",
      "\u2029",
      // U+0085 (NEL) is neither \s nor a line terminator to these patterns.
      "\u0085",
      "#",
      "#######",
      "-",
      "*",
      "+",
      "1",
      ".",
      "12. ",
      "```",
      "a",
      "b",
      "\u00a0",
    ];
    const readers: [RegExp, (line: string) => string[] | null][] = [
      [FENCE, fenceParts],
      [HEADING, headingParts],
      [BULLET, bulletParts],
      [NUMBERED, numberedParts],
    ];
    const differ: string[] = [];
    const matched = [0, 0, 0, 0];
    const visit = (line: string): void => {
      for (const [k, [pattern, read]] of readers.entries()) {
        const want = captures(pattern, line);
        if (want !== null) matched[k] = (matched[k] ?? 0) + 1;
        if (JSON.stringify(read(line)) !== JSON.stringify(want))
          differ.push(`${pattern.source} ${JSON.stringify(line)}`);
      }
    };
    const checked = everyText(pieces, 4, visit);
    for (const line of randomTexts(pieces, 30_000, 12)) visit(line);
    // Fence lines start with ```: more of them, with what may follow one.
    for (const line of randomTexts(pieces, 10_000, 4)) visit(`\`\`\`${line}`);
    expect(differ).toEqual([]);
    expect(checked).toBe((18 ** 5 - 1) / 17);
    for (const m of matched) expect(m).toBeGreaterThan(1_000);
  }, 30_000);
});

// Counted, not timed: the four patterns are refused on the spot if they run
// over the run; everything else in the renderer runs as usual.
describe("rendering a reply with a long run of spaces in a line", () => {
  test("runs none of the four patterns over it", () => {
    const run = " ".repeat(10_000);
    const lines = [
      `\`\`\`${" ".repeat(200_000)}a b`,
      `#${" ".repeat(200_000)}x\r`,
      `-${" ".repeat(200_000)}x\r`,
      `1.${" ".repeat(200_000)}x\r`,
    ];
    const refused = new Set([FENCE.source, HEADING.source, BULLET.source, NUMBERED.source]);
    const ran: string[] = [];
    const realExec = RegExp.prototype.exec;
    RegExp.prototype.exec = function (this: RegExp, input: string) {
      if (refused.has(this.source) && typeof input === "string" && input.includes(run)) {
        ran.push(`/${this.source}/`);
        throw new Error(`/${this.source}/ ran over the run`);
      }
      return realExec.call(this, input);
    };
    let out = "";
    let control: string[] = [];
    try {
      const renderer = createCliMarkdownRenderer({
        write: (s) => {
          out += s;
        },
      });
      renderer.push(`${lines.join("\n")}\n`);
      renderer.end();
      control = [...ran];
      // Control: the hook sees a refused pattern when RegExp#exec runs it.
      try {
        HEADING.exec(lines[1] as string);
      } catch {
        // refused, as intended
      }
    } finally {
      RegExp.prototype.exec = realExec;
    }
    expect(control).toEqual([]);
    expect(ran).toEqual([`/${HEADING.source}/`]);
    expect(out.split("\n")).toHaveLength(5);
  }, 20_000);
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a search
// that resumes one character on instead of after what it read), so each
// reader's own reads are counted (__test__/scan-work.ts) over lines shaped to
// make it rescan, and held to a few per character. A rescan reads the rest of
// the run from every place in it and stops at the bound at once.
describe("each line reader takes a long line in a bounded number of reads", () => {
  const N = 20_000;
  const PER_CHARACTER = 8;
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["a fence with a long run of spaces", fenceParts, `\`\`\`${" ".repeat(N)}x y`],
    ["a CRLF heading with a long run of spaces", headingParts, `#${" ".repeat(N)}x\r`],
    ["a CRLF bullet with a long run of spaces", bulletParts, `-${" ".repeat(N)}x\r`],
    ["a CRLF numbered item with a long run of spaces", numberedParts, `1.${" ".repeat(N)}x\r`],
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

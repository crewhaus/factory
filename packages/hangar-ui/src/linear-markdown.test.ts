/**
 * The wiki reader's block patterns read a line once.
 *
 * The heading and list patterns ended in blanks and then `(.*)$`. The split
 * on "\n" leaves a `\r`, U+2028 or U+2029 in a line, which `.` does not
 * take, so on such a line the pattern gave the blanks back one at a time and
 * read the rest of the line again after each: quadratic in the blanks. The
 * reader renders memory, wiki and feedback text an agent wrote, in the
 * operator's tab, so a crafted line could freeze it. Each pattern now reads
 * only its marker and blanks, and the rest is checked for a break once.
 *
 * Every line the generator builds gets the blocks the old patterns gave it,
 * and the steps are counted with the model in tool-text's
 * __test__/regex-work.ts, which walks every regular expression in
 * ECMAScript's order: a bound of a few steps a character holds, and the old
 * pattern goes past it on the same line. A test that walks many generated
 * inputs declares a 20 s budget, as the house does for a test that is slow
 * by construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "../../tool-text/src/__test__/regex-work";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { parseInline, parseMarkdown } from "../assets/js/markdown.js";

// The patterns as they were.
const OLD_HEADING = /^(#{1,6})\s+(.*)$/;
const OLD_UL_ITEM = /^\s*[-*]\s+(.*)$/;
const OLD_OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;

/** The blocks the old patterns gave one line (no "\n" in it). */
function oldBlocks(line: string): unknown[] {
  if (line.trim().startsWith("```")) return [{ type: "code", text: "" }];
  const heading = line.match(OLD_HEADING);
  if (heading) {
    return [{ type: "heading", level: heading[1]?.length, spans: parseInline(heading[2]) }];
  }
  const ul = line.match(OLD_UL_ITEM);
  const ol = ul === null ? line.match(OLD_OL_ITEM) : null;
  const item = ul ?? ol;
  if (item) return [{ type: "list", ordered: ol !== null, items: [parseInline(item[1])] }];
  if (line.trim() === "") return [];
  return [{ type: "para", spans: parseInline(line.trim()) }];
}

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    for (const s of layer) out.push(s);
  }
  return out;
}

/** Seeded, so a failure names the same input every run. */
function randomTexts(pieces: ReadonlyArray<string>, count: number, maxPieces: number): string[] {
  let seed = 0x4d2a91b7;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    const n = Math.floor(next() * (maxPieces + 1));
    for (let j = 0; j < n; j++) s += pieces[Math.floor(next() * pieces.length)];
    out.push(s);
  }
  return out;
}

describe("each line gets the blocks the old patterns gave it", () => {
  test("every short line, and long generated ones", () => {
    // Markers, every kind of blank (a break the split leaves among them),
    // text, and inline marks.
    const pieces = ["#", "-", "*", "1", ".", ")", " ", "\t", "\r", "\u2028", "x", "`"];
    const longer = [
      "#",
      "###",
      "#######",
      "- ",
      "* ",
      "12. ",
      "3) ",
      " ",
      "  ",
      "\t",
      "\r",
      "\u2028",
      "\u2029",
      "\u00a0",
      "\v",
      "x",
      "word",
      "**b**",
      "`c`",
      "```",
      "-",
      "1",
    ];
    const lines = [...allJoins(pieces, 4), ...randomTexts(longer, 20_000, 12)];
    const differ: string[] = [];
    const kinds = new Map<string, number>();
    for (const line of lines) {
      const ours = parseMarkdown(line);
      const old = oldBlocks(line);
      if (JSON.stringify(ours) !== JSON.stringify(old)) differ.push(JSON.stringify(line));
      const kind = (old[0] as { type?: string } | undefined)?.type ?? "none";
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    expect(differ.slice(0, 5)).toEqual([]);
    // Every kind of block was reached, and lines that are not one.
    for (const kind of ["heading", "list", "para", "code", "none"]) {
      expect(`${kind}:${(kinds.get(kind) ?? 0) > 500}`).toBe(`${kind}:true`);
    }
  }, 20_000);
});

describe("a line of blanks before a break is read once", () => {
  // The parser's patterns take about seven steps a character on these, most
  // of them a step at each place an anchored pattern is tried; the old ones
  // took thousands. The model walks every step in JavaScript, so each test
  // declares a 20 s budget.
  const STEPS_PER_CHARACTER = 16;
  const blanks = " ".repeat(20_000);

  test.each([
    ["a heading, then \\r", `# ${blanks}x\ry`, OLD_HEADING],
    ["a bullet, then U+2028", `- ${blanks}x\u2028y`, OLD_UL_ITEM],
    ["a numbered item, then U+2029", `1. ${blanks}x\u2029y`, OLD_OL_ITEM],
    ["a heading of tabs, then \\r", `### ${"\t".repeat(20_000)}x\r`, OLD_HEADING],
  ] as const)(
    "%s",
    (_, line, old) => {
      const bound = STEPS_PER_CHARACTER * line.length;
      const counted = regexWork(bound, () => parseMarkdown(line));
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      // Not a block: one paragraph of the line. (The old patterns are not
      // run here uncounted: on this line they take seconds.)
      expect(counted.value).toEqual([{ type: "para", spans: parseInline(line.trim()) }]);
      // Control: the count sees the old pattern go past the bound.
      expect(regexWork(bound, () => line.match(old)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );
});

/**
 * FindReferences cuts each line's text once.
 *
 * `findOccurrences` reports every occurrence with the text of its line, and
 * it copied and trimmed that line again for each one: a line holding k
 * occurrences cost k times the line, and a workspace file is up to 2 MB.
 * The trim scans a run of blanks at either end, so a long indent made it
 * quadratic in practice as well as in the copies. Each line's text is now
 * worked out once and shared by the occurrences on it.
 *
 * The answers are checked against the reader as it was over generated
 * sources. The characters the string methods read are counted with
 * __test__/scan-work.ts, never timed.
 */
import { describe, expect, test } from "bun:test";
import { scanWork } from "./__test__/scan-work";
import {
  KIND_CODE,
  type Occurrence,
  findOccurrences,
  lineAt,
  lineStarts,
  maskSource,
} from "./lib/scan";

/** `findOccurrences` as it was in 0.7.0. */
function oldFindOccurrences(src: string, name: string, maxLineChars = 300): Occurrence[] {
  if (name === "") return [];
  const { kind } = maskSource(src);
  const starts = lineStarts(src);
  const out: Occurrence[] = [];
  let from = 0;
  while (true) {
    const idx = src.indexOf(name, from);
    if (idx === -1) break;
    from = idx + name.length;
    const before = idx > 0 ? (src[idx - 1] as string) : "";
    const after = idx + name.length < src.length ? (src[idx + name.length] as string) : "";
    if (before !== "" && /[A-Za-z0-9_$]/.test(before)) continue;
    if (after !== "" && /[A-Za-z0-9_$]/.test(after)) continue;
    if (kind[idx] !== KIND_CODE) continue;
    const line = lineAt(starts, idx);
    const lineStart = starts[line - 1] as number;
    const lineEnd = line < starts.length ? (starts[line] as number) - 1 : src.length;
    const text = src.slice(lineStart, lineEnd).trim();
    out.push({
      line,
      column: idx - lineStart + 1,
      text: text.length > maxLineChars ? `${text.slice(0, maxLineChars)}…` : text,
    });
  }
  return out;
}

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("findOccurrences cuts each line's text once", () => {
  test("answers as it did, over generated sources, names and caps", () => {
    const next = rng(0x0cc0ffee);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const pieces = [
      ...["x", "x", "x", "x ", " x ", "x;", "ab", "$", "_a", "xx", "x1", ".x", "x."],
      ...[" ", "  ", "\t", "\r", " ", String.fromCharCode(0x2028), "﻿"],
      ...["\n", "\n", "//", "/*", "*/", '"', "'", "`", "(", ")", ";", "=", "y".repeat(40)],
    ];
    const caps = [undefined, undefined, 0, 5, 40, -1, Number.NaN, 2.5];
    let occurrences = 0;
    let shared = 0;
    for (let n = 0; n < 6_000; n++) {
      let src = "";
      for (let i = Math.floor(next() * 30) + 1; i > 0; i--) src += pick(pieces);
      const name = pick(["x", "x", "x", "ab", "$", "_a"]);
      const cap = pick(caps);
      const was = oldFindOccurrences(src, name, cap);
      expect(findOccurrences(src, name, cap)).toEqual(was);
      occurrences += was.length;
      shared += was.filter((o, i) => i > 0 && was[i - 1]?.line === o.line).length;
    }
    // The cases reach occurrences, and lines holding more than one (about
    // 3,700 and 1,200).
    expect(occurrences).toBeGreaterThan(2_000);
    expect(shared).toBeGreaterThan(600);
  }, 20_000);

  test("a long indent, then thousands of occurrences on one line, after another", () => {
    // About three characters read for each in the source here.
    const READS_PER_CHARACTER = 8;
    const rows = [2_000, 4_000].map((k) => {
      const src = `x\n${" ".repeat(2 * k)}${"x ".repeat(k)}\n`;
      const run = scanWork(READS_PER_CHARACTER * src.length, () => findOccurrences(src, "x"));
      return { k, src, run };
    });
    for (const { k, src, run } of rows) {
      expect(run.work).toBeGreaterThanOrEqual(src.length);
      expect(run.work).toBeLessThanOrEqual(READS_PER_CHARACTER * src.length);
      const text = `${"x ".repeat(150)}…`;
      expect(run.value).toEqual([
        { line: 1, column: 1, text: "x" },
        ...Array.from({ length: k }, (_, i) => ({ line: 2, column: 2 * k + 2 * i + 1, text })),
      ]);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
    // Control: the count sees the reader as it was go past the bound.
    const { src } = small;
    expect(scanWork(8 * src.length, () => oldFindOccurrences(src, "x")).work).toBe(
      Number.POSITIVE_INFINITY,
    );
  }, 20_000);
});

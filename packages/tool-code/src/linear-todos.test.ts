/**
 * TodoScan reads each line holding a marker once.
 *
 * A note's text runs to the end of its line, and `scanTodos` read it there
 * for every marker: a copy of the rest of the line, three patterns over the
 * copy (one of them, `\*\/\s*$`, unanchored, so it tried every start in it)
 * and a trim. A comment line of k markers cost k times the line, and a
 * workspace file is up to 2 MB. Each answer now comes from the line's
 * offsets, worked out once.
 *
 * The answers are checked against the reader as it was, over generated
 * notes and with every code unit in the places it reads. The work is
 * counted, never timed: regular-expression steps with the model in
 * __test__/regex-work.ts and the characters the string methods read with
 * __test__/scan-work.ts.
 *
 * A test that walks many generated inputs declares a 20 s budget, as the
 * house does for a test that is slow by construction; the walk over every
 * code unit scans about four million characters twice, and declares 60 s.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "./__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import {
  DEFAULT_TODO_MARKERS,
  KIND_COMMENT,
  type TodoRecord,
  lineAt,
  lineStarts,
  maskSource,
  scanTodos,
} from "./lib/scan";

/** `scanTodos` as it was in 0.7.0. */
function oldScanTodos(
  src: string,
  markers: readonly string[] = DEFAULT_TODO_MARKERS,
  maxTextChars = 200,
): TodoRecord[] {
  const { kind } = maskSource(src);
  const starts = lineStarts(src);
  const out: TodoRecord[] = [];
  for (const marker of markers) {
    let from = 0;
    while (true) {
      const idx = src.indexOf(marker, from);
      if (idx === -1) break;
      from = idx + marker.length;
      if (kind[idx] !== KIND_COMMENT) continue;
      const before = idx > 0 ? (src[idx - 1] as string) : "";
      if (before !== "" && /[A-Za-z0-9_$]/.test(before)) continue;
      const line = lineAt(starts, idx);
      const lineStart = starts[line - 1] as number;
      const lineEnd = line < starts.length ? (starts[line] as number) - 1 : src.length;
      const rest = src.slice(idx + marker.length, lineEnd);
      // `match` with a pattern that is not global is the pattern's `exec`.
      const authorMatch = rest.match(/^\s*(?:\(\s*@?([\w.@-]+)\s*\)|@([\w.-]+))/);
      const author = authorMatch?.[1] ?? authorMatch?.[2];
      const body = rest
        .slice(authorMatch === null ? 0 : authorMatch[0].length)
        .replace(/^\s*[:\-–]\s*/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      out.push({
        marker,
        ...(author === undefined ? {} : { author }),
        line,
        column: idx - lineStart + 1,
        text: body.length > maxTextChars ? `${body.slice(0, maxTextChars)}…` : body,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
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

/** U+2028, a line break `\s` takes, spelled without a raw one in this file. */
const LS = String.fromCharCode(0x2028);

describe("scanTodos answers as it did", () => {
  test("over generated comment lines, markers and caps", () => {
    const next = rng(0x70d05ca1);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const blanks = [" ", "  ", "\t", "\r", " ", LS, "　", "﻿", "​", ""];
    const pieces = [
      ...["TODO", "TODO", "TODO", "FIXME", "HACK", "XXX", "xTODO", ".TODO", "-TODO", "todo"],
      ...["(dave)", "( @dave )", "(@a.b-c)", "(a b)", "(", ")", "@dave", "@", "(@)", "(@@)"],
      ...[":", "-", "–", "—", ": ", " - ", "*/", "* /", "**/", "*", "/"],
      ...["note", "fix this", "é", "x".repeat(30), "\n", "\r\n", "//", "/*", '"', "'"],
      ...blanks,
      ...blanks,
    ];
    const markerSets: ReadonlyArray<readonly string[] | undefined> = [
      undefined,
      undefined,
      ["TODO", "TO"],
      ["  "],
      ["\t\t"],
      [" :"],
      ["*/"],
      ["O*"],
      [" *"],
      ["**"],
      ["(@"],
      ["DO\nX", " \n"],
    ];
    const caps = [undefined, undefined, 0, 1, 10, -2, Number.NaN, Number.POSITIVE_INFINITY, 2.5];
    let notes = 0;
    let authors = 0;
    let cut = 0;
    for (let n = 0; n < 10_000; n++) {
      let src = pick(["// ", "// ", "/* ", ""]);
      for (let i = Math.floor(next() * 16) + 1; i > 0; i--) {
        const piece = pick(pieces);
        src += piece;
        if (/^(TODO|FIXME)$/.test(piece) && next() < 0.6) {
          src += pick(blanks) + pick(["(dave)", "( @dave )", "@d.e-f", "(a", "@x:", "(x)\t-"]);
        }
      }
      if (next() < 0.3) src += pick(["*/", " */ ", "*/\n", "\n// TODO tail"]);
      const markers = pick(markerSets);
      const cap = pick(caps);
      const was = oldScanTodos(src, markers, cap);
      expect(scanTodos(src, markers, cap)).toEqual(was);
      notes += was.length;
      authors += was.filter((t) => t.author !== undefined).length;
      cut += was.filter((t) => t.text.endsWith("…")).length;
    }
    // The cases reach notes, authors and cut texts (about 3,200, 600 and 1,200).
    expect(notes).toBeGreaterThan(2_000);
    expect(authors).toBeGreaterThan(300);
    expect(cut).toBeGreaterThan(600);
  }, 20_000);

  test("with every code unit in each place the patterns and the trim read", () => {
    // 256 code units a source, one a line, so each scan reads many.
    for (let block = 0; block < 0x10000; block += 256) {
      const units = Array.from({ length: 256 }, (_, i) => String.fromCharCode(block + i));
      for (const line of [
        (c: string) => `// TODO${c}(${c}@a${c})${c}:${c}x${c}*/${c}`,
        (c: string) => `// FIXME${c}${c}-${c}x${c}`,
        (c: string) => `/* HACK${c}@a${c}*/ XXX${c}`,
      ]) {
        const src = units.map(line).join("\n");
        expect(scanTodos(src)).toEqual(oldScanTodos(src));
      }
    }
  }, 60_000);
});

describe("scanTodos reads a line of markers once", () => {
  // The scan takes under two steps a character here, and reads about six
  // characters for each one beyond those the notes keep.
  const STEPS_PER_CHARACTER = 4;
  const READS_PER_CHARACTER = 16;

  /** Characters the notes keep, which the scan copies out of the line. */
  const kept = (notes: readonly TodoRecord[]): number =>
    notes.reduce((sum, t) => sum + t.text.length, 0);

  const count = (src: string, markers?: readonly string[]) =>
    regexWork(STEPS_PER_CHARACTER * src.length, () =>
      scanWork(Number.MAX_SAFE_INTEGER, () => scanTodos(src, markers)),
    );

  test("a comment line of thousands of markers", () => {
    const rows = [2_000, 4_000].map((k) => {
      const src = `// ${"TODO ".repeat(k)}*/\n`;
      return { k, src, run: count(src) };
    });
    for (const { k, src, run } of rows) {
      expect(run.unmodelled).toEqual([]);
      expect(run.steps).toBeLessThanOrEqual(STEPS_PER_CHARACTER * src.length);
      const notes = run.value?.value ?? [];
      expect(notes).toHaveLength(k);
      expect(notes[0]?.text).toBe(`${"TODO ".repeat(40)}…`);
      expect(notes[k - 1]?.text).toBe("");
      expect(notes[k - 2]?.text).toBe("TODO");
      // Read through, and at most a few times beyond what the notes keep.
      const reads = (run.value?.work ?? 0) - kept(notes);
      expect(reads).toBeGreaterThanOrEqual(src.length);
      expect(reads).toBeLessThanOrEqual(READS_PER_CHARACTER * src.length);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.steps / small.run.steps).toBeLessThan(2.4);
    // Control: the count sees the reader as it was go past the bound.
    const { src } = small;
    expect(regexWork(STEPS_PER_CHARACTER * src.length, () => oldScanTodos(src)).steps).toBe(
      Number.POSITIVE_INFINITY,
    );
  }, 20_000);

  test("a caller's blank marker in a long blank run, before an author never closed", () => {
    // Every pair of blanks is a marker, and each finds the same `(` after
    // the blanks: the author pattern is tried there once.
    const rows = [2_000, 4_000].map((k) => {
      const src = `// ${" ".repeat(2 * k)}(${"a".repeat(k)}\n`;
      return { k, src, run: count(src, ["  "]) };
    });
    for (const { k, src, run } of rows) {
      expect(run.unmodelled).toEqual([]);
      expect(run.steps).toBeLessThanOrEqual(STEPS_PER_CHARACTER * src.length);
      const notes = run.value?.value ?? [];
      expect(notes).toHaveLength(k);
      expect(notes.every((t) => t.author === undefined)).toBe(true);
      const reads = (run.value?.work ?? 0) - kept(notes);
      expect(reads).toBeLessThanOrEqual(READS_PER_CHARACTER * src.length);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.steps / small.run.steps).toBeLessThan(2.4);
    const { src } = small;
    expect(regexWork(STEPS_PER_CHARACTER * src.length, () => oldScanTodos(src, ["  "])).steps).toBe(
      Number.POSITIVE_INFINITY,
    );
  }, 20_000);
});

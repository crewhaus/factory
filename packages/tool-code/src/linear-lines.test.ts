/**
 * The line readers for compiler, test and stack output take each line in one
 * pass.
 *
 * Seven patterns ended in blanks and then the rest of the line, `\s+(.*)$`
 * or `\s*(.+)$`. When a line break stood inside that rest (a `\r` from a
 * progress line, a U+2028 in a message or a file name), the rest could not
 * reach the end, and each pattern gave the blanks back one at a time and
 * read the rest again after each: quadratic in the run of blanks, and cubic
 * in the generic `file:line:` reader, whose optional severity sits between
 * two more runs. `/([^\s()]+):(\d+):(\d+)/` tried every start inside a run
 * of characters with no `file:line:col` in it and reread the rest from each.
 * The text is a compiler's or a runner's output about workspace files, or a
 * log or trace a caller passes `TestFailureSummary` and `StackTrace` (up to
 * eight and two megabytes); per-line caps bounded one line, not how many.
 *
 * Each reader now captures what its pattern did, checked here against the
 * pattern on every short line over pieces that reach each part, and its
 * steps are counted with the model in __test__/regex-work.ts, which walks
 * every regular expression in ECMAScript's order: a bound of a few steps a
 * character holds here, and the old pattern goes past it on the same line.
 * The characters the scans read are counted too (__test__/scan-work.ts),
 * so a scan that rereads the line fails the same way.
 *
 * A test that walks many generated inputs declares a 20 s budget, as the
 * house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { regexWork } from "./__test__/regex-work";
import { scanWork } from "./__test__/scan-work";
import {
  genericLine,
  parseGenericDiagnostics,
  parseTsc,
  prettierWarnPath,
  tscBareLine,
  tscLine,
} from "./lib/diagnostics";
import { parseStackTrace, pythonFrame } from "./lib/stack";
import { locationFromFrame, parseTestOutput, pytestFailedLine } from "./lib/tests";

/** U+2028, a line break `.` does not take, spelled without a raw one in this file. */
const LS = String.fromCharCode(0x2028);

// The patterns as they were.
const OLD_TSC =
  /^(?<file>[^\s(][^(]*)\((?<line>\d+),(?<col>\d+)\):\s+(?<sev>error|warning|message)\s+(?<code>TS\d+):\s+(?<msg>.*)$/;
const OLD_TSC_BARE = /^(?<sev>error|warning)\s+(?<code>TS\d+):\s+(?<msg>.*)$/;
const OLD_GENERIC =
  /^(?<file>[^\s:][^:]*):(?<line>\d+):(?:(?<col>\d+):)?\s*(?:(?<sev>error|warning|note|info)\s*:)?\s*(?<msg>.+)$/;
const OLD_PYTHON = /^File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>.+))?$/;
const OLD_FRAME = /([^\s()]+):(\d+):(\d+)/;
const OLD_FAILED =
  /^(?<kind>FAILED|ERROR)\s+(?<path>[^\s:]+)(?:::(?<rest>\S+))?(?:\s+-\s+(?<msg>.*))?$/;
const OLD_WARN = /^\[warn\]\s+(.*)$/;

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

/** Seeded, so a failure names the same input every run. */
function randomTexts(pieces: ReadonlyArray<string>, count: number, maxPieces: number): string[] {
  let seed = 0x2545f491;
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

/** The groups a match captured, without the ones that did not take part. */
function groupsOf(m: RegExpExecArray | null): Record<string, string> | null {
  if (m === null) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/** The first few `inputs` where `ours` and `old` disagree, and how many matched. */
function disagreements(
  inputs: ReadonlyArray<string>,
  ours: (s: string) => unknown,
  old: (s: string) => unknown,
): { differ: string[]; matched: number } {
  const differ: string[] = [];
  let matched = 0;
  for (const s of inputs) {
    const a = JSON.stringify(ours(s) ?? null);
    const b = JSON.stringify(old(s) ?? null);
    if (a !== b) differ.push(`${JSON.stringify(s)}: ${a} vs ${b}`);
    else if (b !== "null") matched++;
  }
  return { differ: differ.slice(0, 5), matched };
}

describe("each reader captures what its pattern did", () => {
  test("tsc lines, with and without a file", () => {
    const heads = [
      "a(1,2): error TS1:",
      "src/a b.ts(10,20): warning TS2345:",
      "a(1,2):  message  TS9:",
      "a(1,2): error TS1",
      " a(1,2): error TS1:",
      "a(1,x): error TS1:",
      "error TS18003:",
      "warning  TS1:",
      "error TS:",
      "",
    ];
    const tail = [" ", "\t", "x", "\r", LS, ":", "1", "error"];
    const inputs = heads.flatMap((h) => allJoins(tail, 4).map((t) => h + t));
    const tsc = disagreements(inputs, tscLine, (s) => groupsOf(OLD_TSC.exec(s)));
    expect(tsc.differ).toEqual([]);
    expect(tsc.matched).toBeGreaterThan(2_000);
    const bare = disagreements(inputs, tscBareLine, (s) => groupsOf(OLD_TSC_BARE.exec(s)));
    expect(bare.differ).toEqual([]);
    expect(bare.matched).toBeGreaterThan(1_000);
  }, 20_000);

  test("generic file:line: lines", () => {
    const heads = ["a:1:", "a:1:2:", "a b:12:", "a:b:1:", " a:1:", ":1:", "a:1", "1:2:3:", "a:1:2"];
    const tail = [" ", "x", "\r", LS, ":", "1", "error", "info", "\t"];
    const inputs = [
      ...heads.flatMap((h) => allJoins(tail, 4).map((t) => h + t)),
      ...randomTexts(["a", ":", "1", " ", "error", "note", "x", "\r", LS, "\t"], 20_000, 12),
    ];
    const r = disagreements(inputs, genericLine, (s) => groupsOf(OLD_GENERIC.exec(s)));
    expect(r.differ).toEqual([]);
    expect(r.matched).toBeGreaterThan(10_000);
  }, 20_000);

  test("CPython frames", () => {
    const heads = [
      'File "a.py", line 3',
      'File  "a b.py",  line  12',
      'File "", line 1',
      'File "a", line',
      'File"a", line 1',
      'File "a", line 1x',
    ];
    const tail = [",", " ", "in", "x", "\r", LS, "\t", "1"];
    const inputs = heads.flatMap((h) => allJoins(tail, 5).map((t) => h + t));
    const r = disagreements(inputs, pythonFrame, (s) => groupsOf(OLD_PYTHON.exec(s)));
    expect(r.differ).toEqual([]);
    expect(r.matched).toBeGreaterThan(500);
  }, 20_000);

  test("file:line:col in a frame", () => {
    const pieces = ["a", ":", "1", ":2", "(", ")", " ", LS, "/"];
    const inputs = [...allJoins(pieces, 6), ...randomTexts(pieces, 20_000, 16)];
    const old = (s: string) => {
      const m = OLD_FRAME.exec(s);
      return m === null ? undefined : { file: m[1] as string, line: Number(m[2]) };
    };
    const r = disagreements(inputs, locationFromFrame, old);
    expect(r.differ).toEqual([]);
    expect(r.matched).toBeGreaterThan(10_000);
  }, 20_000);

  test("pytest FAILED and ERROR lines", () => {
    const heads = [
      "FAILED a.py",
      "ERROR a.py::t",
      "FAILED  a.py::t::u",
      "FAILED a:b",
      "FAILED",
      "ERRORa",
    ];
    const tail = [" ", "-", "x", "\r", LS, "::", "\t"];
    const inputs = heads.flatMap((h) => allJoins(tail, 5).map((t) => h + t));
    const r = disagreements(inputs, pytestFailedLine, (s) => groupsOf(OLD_FAILED.exec(s)));
    expect(r.differ).toEqual([]);
    expect(r.matched).toBeGreaterThan(1_000);
  }, 20_000);

  test("prettier [warn] lines", () => {
    const inputs = ["[warn]", "[warn", "x[warn] a", ""].flatMap((h) =>
      allJoins([" ", "\t", "a", "\r", LS], 5).map((t) => h + t),
    );
    const r = disagreements(inputs, prettierWarnPath, (s) => OLD_WARN.exec(s)?.[1]);
    expect(r.differ).toEqual([]);
    expect(r.matched).toBeGreaterThan(500);
  }, 20_000);
});

describe("a long run of blanks before a line break is read once", () => {
  const RUN = " ".repeat(20_000);
  // The readers take at most a few steps a character on these, and read
  // each character at most four times. The model walks every step in
  // JavaScript, so each test declares a 20 s budget.
  const STEPS_PER_CHARACTER = 8;
  const READS_PER_CHARACTER = 8;

  test.each([
    ["tsc", `a(1,2): error TS1:${RUN}x\ry`, tscLine, OLD_TSC],
    ["tsc, file-less", `error TS1:${RUN}x\ry`, tscBareLine, OLD_TSC_BARE],
    ["generic", `a:1:${RUN}x${LS}y`, genericLine, OLD_GENERIC],
    ["generic, after a column", `a:1:2:${RUN}error${RUN}:${RUN}x\ry`, genericLine, OLD_GENERIC],
    ["CPython", `File "a.py", line 1, in${RUN}x\ry`, pythonFrame, OLD_PYTHON],
    ["pytest", `FAILED a.py::t -${RUN}x\ry`, pytestFailedLine, OLD_FAILED],
    ["prettier", `[warn]${RUN}x\ry`, prettierWarnPath, OLD_WARN],
    ["a frame", `at ${"a:0:".repeat(5_000)}`, locationFromFrame, OLD_FRAME],
  ] as const)(
    "%s",
    (_, line, read, old) => {
      const bound = STEPS_PER_CHARACTER * line.length;
      const counted = regexWork(bound, () =>
        scanWork(READS_PER_CHARACTER * line.length, () => read(line)),
      );
      expect(counted.unmodelled).toEqual([]);
      expect(counted.steps).toBeLessThanOrEqual(bound);
      expect(counted.value?.value ?? null).toBeNull();
      // Read through, and at most a few times: the count reaches the line's
      // length, so the line was read with the methods it counts.
      expect(counted.value?.work).toBeGreaterThanOrEqual(0.9 * line.length);
      expect(counted.value?.work).toBeLessThanOrEqual(READS_PER_CHARACTER * line.length);
      // Control: the count sees the old pattern go past the bound.
      expect(regexWork(bound, () => old.exec(line)).steps).toBe(Number.POSITIVE_INFINITY);
    },
    20_000,
  );

  test("through the parsers, over many such lines", () => {
    const tail = (i: number) => ` ${" ".repeat(1_900)}x\r${i}`;
    const lines = Array.from({ length: 40 }, (_, i) => i);
    const runs: Array<[string, string]> = [
      ["StackTrace", lines.map((i) => `File "a.py", line 1, in${tail(i)}`).join("\n")],
      ["generic", lines.map((i) => `a:1:${tail(i)}`).join("\n")],
      ["tsc", lines.map((i) => `a(1,2): error TS1:${tail(i)}`).join("\n")],
      ["pytest", lines.map((i) => `FAILED a.py::t -${tail(i)}`).join("\n")],
      ["bun", lines.map((i) => `    at ${"a:0:".repeat(490)}\n(fail) t${i}`).join("\n")],
    ];
    const parse: Record<string, (text: string) => unknown> = {
      StackTrace: (text) => parseStackTrace(text),
      generic: (text) => parseGenericDiagnostics(text),
      tsc: (text) => parseTsc(text),
      pytest: (text) => parseTestOutput(text, "pytest"),
      bun: (text) => parseTestOutput(text, "bun"),
    };
    for (const [name, text] of runs) {
      // Every pattern a parser runs over a line, the readers' and the rest,
      // takes at most 31 steps a character here; the old readers took
      // millions of steps on each of these lines.
      const bound = 40 * text.length;
      const counted = regexWork(bound, () => parse[name]?.(text));
      expect({ name, unmodelled: counted.unmodelled, under: counted.steps <= bound }).toEqual({
        name,
        unmodelled: [],
        under: true,
      });
    }
  }, 20_000);
});

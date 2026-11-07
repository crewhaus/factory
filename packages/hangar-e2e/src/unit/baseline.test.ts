import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AXE_TAGS } from "../a11y/axe";
import {
  type AxeReport,
  baselineProblems,
  diffAgainstBaseline,
  diffMarkdown,
  reportTotals,
  rowKey,
  sortReport,
} from "../a11y/baseline";

const BASELINE = join(import.meta.dir, "..", "..", "axe-baseline.json");

const report = (rows: AxeReport["rows"]): AxeReport => ({
  schema: 1,
  axe: "4.14.0",
  tags: [...AXE_TAGS],
  rows,
});

describe("the committed baseline", () => {
  const text = readFileSync(BASELINE, "utf8");
  const parsed = JSON.parse(text) as AxeReport;

  test("is well formed", () => {
    expect(baselineProblems(text)).toEqual([]);
  });

  test("names axe's exact pinned version", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(parsed.axe).toBe(manifest.devDependencies["axe-core"] as string);
  });

  test("covers both themes at both widths", () => {
    const keys = Object.keys(parsed.rows);
    expect(keys.length).toBeGreaterThanOrEqual(124);
    for (const theme of ["dark", "light"]) {
      for (const width of [1280, 320]) {
        expect(keys).toContain(rowKey("#/", theme, width));
        expect(keys).toContain(rowKey("#/h/:id/overview", theme, width));
      }
    }
  });

  test("holds no harness id, which changes every run", () => {
    expect(text).not.toContain("hrn_");
  });
});

describe("baselineProblems", () => {
  const good = report({ "#/|dark|1280": { "color-contrast": 2 }, "#/|dark|320": {} });

  test("a good report has none", () => {
    expect(baselineProblems(JSON.stringify(good))).toEqual([]);
  });

  test("not JSON", () => {
    expect(baselineProblems("{")).toEqual(["it is not JSON"]);
    expect(baselineProblems("[]").length).toBeGreaterThan(0);
  });

  test("a wrong schema", () => {
    const problems = baselineProblems(JSON.stringify({ ...good, schema: 2 }));
    expect(problems).toEqual(["schema is 2, not 1"]);
  });

  test("no version of axe", () => {
    expect(baselineProblems(JSON.stringify({ ...good, axe: "" }))).toEqual([
      "axe names no version",
    ]);
  });

  test("an unknown tag set", () => {
    const problems = baselineProblems(JSON.stringify({ ...good, tags: ["wcag2a"] }));
    expect(problems[0]).toContain("not the known set");
  });

  test("unsorted rows", () => {
    const text = JSON.stringify({ ...good, rows: { "#/z|dark|320": {}, "#/a|dark|320": {} } });
    expect(baselineProblems(text)).toEqual(["rows are not sorted"]);
  });

  test("unsorted rules in a row", () => {
    const text = JSON.stringify({ ...good, rows: { "#/|dark|320": { b: 1, a: 1 } } });
    expect(baselineProblems(text)).toEqual(["row #/|dark|320's rules are not sorted"]);
  });

  test("no rows, and a row that is not one", () => {
    expect(baselineProblems(JSON.stringify({ ...good, rows: {} }))).toEqual(["rows is empty"]);
    expect(baselineProblems(JSON.stringify({ ...good, rows: { "#/": {} } }))).toEqual([
      "row #/ is not template|theme|width",
    ]);
  });

  test.each([0, -1, 1.5, "2"])("a count of %p", (count) => {
    const text = JSON.stringify({ ...good, rows: { "#/|dark|320": { a: count } } });
    expect(baselineProblems(text)).toEqual([`row #/|dark|320 counts a as ${String(count)}`]);
  });
});

describe("diffAgainstBaseline", () => {
  const base = report({ "#/|dark|1280": { a: 2, b: 3 }, "#/|dark|320": {} });

  test("a rule the baseline does not hold is new, and nothing else", () => {
    const diff = diffAgainstBaseline(
      base,
      report({ "#/|dark|1280": { a: 2, b: 3, c: 1 }, "#/|dark|320": {} }),
    );
    expect(diff).toEqual({
      new: ["#/|dark|1280: c (1)"],
      increased: [],
      decreased: [],
      gone: [],
    });
  });

  test("a row the baseline does not hold is new", () => {
    const diff = diffAgainstBaseline(base, report({ ...base.rows, "#/runs|dark|320": { a: 1 } }));
    expect(diff.new).toEqual(["row #/runs|dark|320"]);
  });

  test("a count that moved is increased or decreased", () => {
    const diff = diffAgainstBaseline(
      base,
      report({ "#/|dark|1280": { a: 5, b: 1 }, "#/|dark|320": {} }),
    );
    expect(diff.increased).toEqual(["#/|dark|1280: a 2 to 5"]);
    expect(diff.decreased).toEqual(["#/|dark|1280: b 3 to 1"]);
    expect(diff.new).toEqual([]);
  });

  test("a rule or a row the report no longer holds is gone", () => {
    const diff = diffAgainstBaseline(base, report({ "#/|dark|1280": { a: 2 } }));
    expect(diff.gone).toEqual(["#/|dark|1280: b (3)", "row #/|dark|320"]);
  });

  test("the same report has no differences", () => {
    expect(diffAgainstBaseline(base, base)).toEqual({
      new: [],
      increased: [],
      decreased: [],
      gone: [],
    });
  });
});

describe("the rest of the format", () => {
  test("sortReport orders rows and rules, so a file changes only with its content", () => {
    const sorted = sortReport(report({ "#/z|dark|1": { b: 1, a: 2 }, "#/a|dark|1": {} }));
    expect(Object.keys(sorted.rows)).toEqual(["#/a|dark|1", "#/z|dark|1"]);
    expect(Object.keys(sorted.rows["#/z|dark|1"] ?? {})).toEqual(["a", "b"]);
    expect(baselineProblems(JSON.stringify(sorted))).toEqual([]);
  });

  test("the top-level shape is exactly what a later gate reads", () => {
    const sorted = sortReport(report({ "#/|dark|1": {} }));
    expect(Object.keys(sorted)).toEqual(["schema", "axe", "tags", "rows"]);
  });

  test("reportTotals adds across rows", () => {
    expect(reportTotals(report({ "#/|dark|1": { a: 1, b: 2 }, "#/|dark|2": { a: 3 } }))).toEqual({
      a: 4,
      b: 2,
    });
  });

  test("the summary says it never fails the build, and names what is new", () => {
    const base = report({ "#/|dark|1": {} });
    const now = report({ "#/|dark|1": { a: 1 } });
    const markdown = diffMarkdown(diffAgainstBaseline(base, now), now);
    expect(markdown).toContain("never fails the build");
    expect(markdown).toContain("New against the baseline");
    expect(markdown).toContain("#/|dark|1: a (1)");
  });

  test("the tag set includes the rule target size lives under", () => {
    expect(AXE_TAGS).toContain("wcag22aa");
  });
});

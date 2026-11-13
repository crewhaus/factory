import { describe, expect, test } from "bun:test";
import { AXE_TAGS } from "../a11y/axe";
import { type AxeReport, gateMarkdown, reportTotals, rowKey, sortReport } from "../a11y/baseline";

const report = (rows: AxeReport["rows"]): AxeReport => ({
  schema: 1,
  axe: "4.14.0",
  tags: [...AXE_TAGS],
  rows,
});

describe("the report format", () => {
  test("rowKey names a row by template, theme and width", () => {
    expect(rowKey("#/h/:id/setup/spec", "dark", 320)).toBe("#/h/:id/setup/spec|dark|320");
  });

  test("sortReport orders rows and rules, so a file changes only with its content", () => {
    const sorted = sortReport(report({ "#/z|dark|1": { b: 1, a: 2 }, "#/a|dark|1": {} }));
    expect(Object.keys(sorted.rows)).toEqual(["#/a|dark|1", "#/z|dark|1"]);
    expect(Object.keys(sorted.rows["#/z|dark|1"] ?? {})).toEqual(["a", "b"]);
  });

  test("the top-level shape is exactly what the gate reads", () => {
    const sorted = sortReport(report({ "#/|dark|1": {} }));
    expect(Object.keys(sorted)).toEqual(["schema", "axe", "tags", "rows"]);
  });

  test("reportTotals adds across rows", () => {
    expect(reportTotals(report({ "#/|dark|1": { a: 1, b: 2 }, "#/|dark|2": { a: 3 } }))).toEqual({
      a: 4,
      b: 2,
    });
  });

  test("the tag set includes the rule target size lives under", () => {
    expect(AXE_TAGS).toContain("wcag22aa");
  });
});

describe("the step summary", () => {
  test("leads with the gate's result over every route", () => {
    const now = report({ "#/|dark|1": {} });
    expect(gateMarkdown(now, { gated: 46, failures: 0, missing: 0 })).toContain(
      "**Gate passed:** 46 routes",
    );
    expect(gateMarkdown(now, { gated: 46, failures: 2, missing: 1 })).toContain(
      "**Gate failed:** 2 violation(s) and 1 missing row(s)",
    );
  });

  test("names the nodes by rule, and says when there are none", () => {
    const failing = report({
      "#/|dark|1": { "target-size": 2 },
      "#/|light|1": { "target-size": 1 },
    });
    expect(gateMarkdown(failing, { gated: 1, failures: 2, missing: 0 })).toContain(
      "`target-size` 3",
    );
    expect(
      gateMarkdown(report({ "#/|dark|1": {} }), { gated: 1, failures: 0, missing: 0 }),
    ).toContain("Nodes by rule: none");
  });
});

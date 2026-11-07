/**
 * Accepted-but-unwired rows may name a nested path and carry `since` (#514).
 * `specDeclares` is fed hand-built values, because several of the forms it must
 * read do not parse: it is the walk that is under test.
 */
import { describe, expect, test } from "bun:test";
import type { Spec } from "@crewhaus/spec";
import { ABSENT_CORPUS } from "./absent-corpus";
import { collectCompileWarnings, specDeclares, unwiredRows, unwiredWarnings } from "./index";

const spec = (fields: Record<string, unknown>): Spec => fields as unknown as Spec;

describe("specDeclares — a dotted path", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, boolean]> = [
    ["the leaf is set", { compaction: { curate: true } }, true],
    ["the leaf is set, with a sibling", { compaction: { curate: true, threshold: 0.5 } }, true],
    ["the leaf is false", { compaction: { curate: false } }, false],
    ["the block is false", { compaction: false }, false],
    ["the block is null", { compaction: null }, false],
    ["the block is a scalar", { compaction: "on" }, false],
    ["the block is an array", { compaction: [{ curate: true }] }, false],
    ["the block is switched off", { compaction: { enabled: false, curate: true } }, false],
    ["the leaf is an empty object", { compaction: { curate: {} } }, false],
    ["the leaf is an empty array", { compaction: { curate: [] } }, false],
    ["the leaf is absent", { compaction: {} }, false],
    ["the block is absent", {}, false],
    ["the block is switched on", { compaction: { enabled: true, curate: true } }, true],
    ["a falsy value that is not false", { compaction: { curate: 0 } }, true],
  ];
  for (const [what, fields, expected] of cases) {
    test(`compaction.curate when ${what}: ${expected}`, () => {
      expect(specDeclares(spec(fields), "compaction.curate")).toBe(expected);
    });
  }

  test("each sibling is read on its own", () => {
    const value = spec({ compaction: { threshold: 0.5 } });
    expect(specDeclares(value, "compaction.threshold")).toBe(true);
    expect(specDeclares(value, "compaction.curate")).toBe(false);
  });

  test("it walks more than one level, and an opt-out at any level stops it", () => {
    expect(specDeclares(spec({ a: { b: { c: 1 } } }), "a.b.c")).toBe(true);
    expect(specDeclares(spec({ a: { b: { enabled: false, c: 1 } } }), "a.b.c")).toBe(false);
    expect(specDeclares(spec({ a: { enabled: false, b: { c: 1 } } }), "a.b.c")).toBe(false);
    expect(specDeclares(spec({ a: { b: false } }), "a.b.c")).toBe(false);
  });

  test("a provability block at level off declares nothing beneath it", () => {
    const threshold = "provability.threshold";
    expect(specDeclares(spec({ provability: { level: "off", threshold: 0.5 } }), threshold)).toBe(
      false,
    );
    expect(specDeclares(spec({ provability: "off" }), threshold)).toBe(false);
    expect(specDeclares(spec({ provability: "grounded" }), threshold)).toBe(false);
    expect(
      specDeclares(spec({ provability: { level: "grounded", threshold: 0.5 } }), threshold),
    ).toBe(true);
  });
});

describe("specDeclares — a top-level key reads as it always did", () => {
  const cases: ReadonlyArray<readonly [string, string, Record<string, unknown>, boolean]> = [
    ["continuity: false", "continuity", { continuity: false }, false],
    ["continuity set", "continuity", { continuity: { enabled: true } }, true],
    ["continuity switched off", "continuity", { continuity: { enabled: false } }, false],
    ["mcp_servers: {}", "mcp_servers", { mcp_servers: {} }, false],
    ["mcp_servers set", "mcp_servers", { mcp_servers: { a: {} } }, true],
    ["tools: []", "tools", { tools: [] }, false],
    ["tools set", "tools", { tools: ["read"] }, true],
    ["a scalar", "goal", { goal: "g" }, true],
    ["absent", "continuity", {}, false],
    ["provability: off", "provability", { provability: "off" }, false],
    [
      "provability at level off",
      "provability",
      { provability: { level: "off", threshold: 1 } },
      false,
    ],
    ["provability: grounded", "provability", { provability: "grounded" }, true],
    ["provability at a level", "provability", { provability: { level: "cited" } }, true],
  ];
  for (const [what, path, fields, expected] of cases) {
    test(`${what}: ${expected}`, () => {
      expect(specDeclares(spec(fields), path)).toBe(expected);
    });
  }
});

describe("unwiredRows", () => {
  test("a shape's rows come back, and no row carries since yet", () => {
    expect(unwiredRows("crew").map((row) => row.path)).toContain("provability");
    const targets = Object.keys(ABSENT_CORPUS) as Spec["target"][];
    expect(targets.length).toBe(14);
    const rows = targets.flatMap((target) => unwiredRows(target));
    // Every row the table holds today, read through the view: one is enough to show it reads.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect("since" in row, row.path).toBe(false);
  });

  test("a shape with no rows answers empty", () => {
    expect(unwiredRows("cli")).toEqual([]);
  });

  test("the rows are copies: changing one leaves the table as it was", () => {
    const first = unwiredRows("crew") as Array<{ path: string; message: string }>;
    const before = unwiredRows("crew");
    (first[0] as { path: string }).path = "changed";
    first.push({ path: "added", message: "m" });
    expect(unwiredRows("crew")).toEqual(before);
    expect(unwiredRows("crew").map((row) => row.path)).not.toContain("changed");
  });

  test("the table's warnings still reach collectCompileWarnings", () => {
    const warnings = collectCompileWarnings(
      spec({ target: "crew", provability: { level: "grounded" } }),
    );
    expect(warnings.filter((w) => w.path === "provability").map((w) => w.code)).toEqual([
      "accepted-but-unwired",
    ]);
    expect(
      collectCompileWarnings(spec({ target: "crew", provability: "off" })).map((w) => w.path),
    ).not.toContain("provability");
  });
});

describe("unwiredWarnings", () => {
  const ROW = { path: "compaction.curate", message: "m", since: "0.9.0" } as const;

  test("a nested row warns at its path, and the warning has no since field", () => {
    const warnings = unwiredWarnings(spec({ compaction: { curate: true } }), [ROW]);
    expect(warnings).toEqual([
      { code: "accepted-but-unwired", path: "compaction.curate", message: "m" },
    ]);
  });

  test("no warning when the key is absent or opted out", () => {
    expect(unwiredWarnings(spec({ compaction: {} }), [ROW])).toEqual([]);
    expect(unwiredWarnings(spec({ compaction: { curate: false } }), [ROW])).toEqual([]);
    expect(unwiredWarnings(spec({}), [ROW])).toEqual([]);
  });
});

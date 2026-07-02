import { describe, expect, test } from "bun:test";
import { currentQuarterPeriod, findEmptyControls, resolvePeriodFlag } from "./compliance-schedule";

describe("currentQuarterPeriod", () => {
  test("maps every month to its UTC quarter", () => {
    expect(currentQuarterPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-Q1");
    expect(currentQuarterPeriod(new Date("2026-03-31T23:59:59Z"))).toBe("2026-Q1");
    expect(currentQuarterPeriod(new Date("2026-04-01T00:00:00Z"))).toBe("2026-Q2");
    expect(currentQuarterPeriod(new Date("2026-07-01T12:00:00Z"))).toBe("2026-Q3");
    expect(currentQuarterPeriod(new Date("2026-10-15T00:00:00Z"))).toBe("2026-Q4");
    expect(currentQuarterPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-Q4");
  });

  test("quarters are UTC — a local-evening Dec 31 that is already Jan 1 UTC rolls the year", () => {
    // 2026-12-31T20:00-05:00 is 2027-01-01T01:00Z → Q1 of the NEW year, matching
    // the audit log's UTC day rotation.
    expect(currentQuarterPeriod(new Date("2026-12-31T20:00:00-05:00"))).toBe("2027-Q1");
  });
});

describe("resolvePeriodFlag", () => {
  test('"current" resolves via the injected clock', () => {
    expect(resolvePeriodFlag("current", () => new Date("2026-08-09T00:00:00Z"))).toBe("2026-Q3");
  });

  test("any other label passes through verbatim", () => {
    expect(resolvePeriodFlag("2025-Q4")).toBe("2025-Q4");
    expect(resolvePeriodFlag("2026-H1")).toBe("2026-H1");
    // Case-sensitive: only the literal "current" triggers resolution.
    expect(resolvePeriodFlag("Current")).toBe("Current");
  });
});

describe("findEmptyControls", () => {
  test("returns framework/control ids of zero-record bundles, in collection order", () => {
    const bundles = [
      { frameworkId: "soc2", controlId: "CC6.1", recordCount: 3 },
      { frameworkId: "soc2", controlId: "CC6.7", recordCount: 0 },
      { frameworkId: "hipaa", controlId: "164.312(b)", recordCount: 0 },
    ];
    expect(findEmptyControls(bundles)).toEqual(["soc2/CC6.7", "hipaa/164.312(b)"]);
  });

  test("returns an empty list when every control collected evidence", () => {
    expect(
      findEmptyControls([{ frameworkId: "soc2", controlId: "CC6.1", recordCount: 1 }]),
    ).toEqual([]);
    expect(findEmptyControls([])).toEqual([]);
  });
});

/**
 * A split's release count is known only when its use ledger was read whole; a count
 * that cannot be determined refuses a release unless it is forced.
 */
import { describe, expect, test } from "bun:test";
import type { HeldOutUse, HeldOutUsesReport } from "@crewhaus/dataset-registry";
import { releaseCountOf, releaseGate } from "./datasets-holdout";

const release: HeldOutUse = {
  v: 1,
  at: "2026-01-01T00:00:00Z",
  split: "test",
  purpose: "release",
  via: "cli",
};

function report(over: Partial<HeldOutUsesReport> = {}): HeldOutUsesReport {
  return {
    present: true,
    uses: [release],
    legacyReleases: [],
    skipped: 0,
    truncated: false,
    ...over,
  };
}

describe("releaseCountOf", () => {
  test("a ledger read whole gives its count", () => {
    expect(releaseCountOf(report(), "test")).toBe(1);
    expect(releaseCountOf(report({ uses: [] }), "test")).toBe(0);
    expect(releaseCountOf(report(), "holdout")).toBe(0);
  });

  test("a truncated ledger gives no count", () => {
    expect(releaseCountOf(report({ truncated: true }), "test")).toBeUndefined();
  });

  test("a ledger that could not be read gives no count", () => {
    expect(
      releaseCountOf(report({ uses: [], note: "the use ledger is not a regular file" }), "test"),
    ).toBeUndefined();
  });
});

describe("releaseGate", () => {
  test("a known count passes through, forced or not", () => {
    expect(releaseGate(report(), "test", false)).toEqual({ count: 1 });
    expect(releaseGate(report({ uses: [] }), "holdout", true)).toEqual({ count: 0 });
  });

  test("an unknown count is refused without force, naming why and --force", () => {
    const gate = releaseGate(report({ truncated: true }), "holdout", false);
    if (!("refuse" in gate)) throw new Error(JSON.stringify(gate));
    expect(gate.refuse).toContain("holdout split was released cannot be determined");
    expect(gate.refuse).toContain("the use ledger is longer than one read");
    expect(gate.refuse).toContain("--force");
  });

  test("an unknown count warns under force, naming the ledger's note", () => {
    const gate = releaseGate(
      report({ note: "the use ledger is not a regular file" }),
      "test",
      true,
    );
    if (!("warn" in gate)) throw new Error(JSON.stringify(gate));
    expect(gate.warn).toContain("cannot be determined (the use ledger is not a regular file)");
  });
});

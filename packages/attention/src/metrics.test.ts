/**
 * Metrics from a seeded decision log on a fixed clock: how long open items have waited,
 * how long decisions took by kind and by the door they came through, one fallback, one
 * re-ask. Every breakdown is rows, so Home's masker leaves the counts readable.
 */
import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "@crewhaus/control-contract";
import { metricsOf, percentile, windowMs } from "./metrics";
import type { MetricDecision } from "./types";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

const open = (kind: string, sinceMs: number) =>
  ({ kind, state: "open", since: at(sinceMs) }) as unknown as AttentionItem;

describe("metricsOf", () => {
  const decisions: MetricDecision[] = [
    {
      kind: "permission",
      createdAt: at(NOW - 60 * MIN),
      decidedAt: at(NOW - 50 * MIN),
      decidedVia: "home",
    },
    {
      kind: "permission",
      createdAt: at(NOW - 60 * MIN),
      decidedAt: at(NOW - 30 * MIN),
      decidedVia: "slack",
    },
    {
      kind: "permission",
      createdAt: at(NOW - 60 * MIN),
      decidedAt: at(NOW - 20 * MIN),
      decidedVia: "home",
    },
    {
      kind: "standing-rule-proposal",
      createdAt: at(NOW - 90 * MIN),
      decidedAt: at(NOW - 10 * MIN),
      resolvedBy: "policy",
    },
    { kind: "permission", createdAt: at(NOW - 5 * MIN), askDigest: "d1" },
    { kind: "permission", createdAt: at(NOW - 3 * MIN), askDigest: "d1" },
    { kind: "permission", createdAt: at(NOW - 2 * MIN), askDigest: "d2" },
    // Decided before the window: not counted.
    { kind: "review", createdAt: at(NOW - 40 * 86_400_000), decidedAt: at(NOW - 39 * 86_400_000) },
  ];
  const items = [
    open("permission", NOW - 10 * MIN),
    open("permission", NOW - 30 * MIN),
    open("credential", NOW - 60 * MIN),
  ];
  const m = metricsOf({ items, decisions }, { since: NOW - 30 * 86_400_000, now: NOW });

  test("open items by kind, with their age percentiles", () => {
    expect(m.open).toEqual([
      { kind: "credential", open: 1, p50Ms: 60 * MIN, p90Ms: 60 * MIN },
      { kind: "permission", open: 2, p50Ms: 10 * MIN, p90Ms: 30 * MIN },
    ]);
  });

  test("time to a decision by kind and by door, a fallback, and a re-ask", () => {
    expect(m.resolution).toEqual([
      { kind: "permission", resolved: 3, p50Ms: 30 * MIN, p90Ms: 40 * MIN },
      { kind: "standing-rule-proposal", resolved: 1, p50Ms: 80 * MIN, p90Ms: 80 * MIN },
    ]);
    expect(m.resolutionByVia).toEqual([
      { decidedVia: "home", resolved: 2, p50Ms: 10 * MIN, p90Ms: 40 * MIN },
      { decidedVia: "policy", resolved: 1, p50Ms: 80 * MIN, p90Ms: 80 * MIN },
      { decidedVia: "slack", resolved: 1, p50Ms: 30 * MIN, p90Ms: 30 * MIN },
    ]);
    expect(m.fallbacks).toBe(1);
    expect(m.reasks).toBe(1);
    expect(m.asOf).toBe(at(NOW));
  });

  test("no breakdown is keyed by a kind or a door", () => {
    for (const rows of [m.open, m.resolution, m.resolutionByVia])
      expect(Array.isArray(rows)).toBe(true);
  });

  test("percentiles and windows", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(windowMs("30d")).toBe(30 * 86_400_000);
    expect(windowMs("12h")).toBe(12 * 3_600_000);
    expect(windowMs("0d")).toBeUndefined();
    expect(windowMs("week")).toBeUndefined();
  });
});

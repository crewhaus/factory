/**
 * Ops item 37 — tests for the `doctor --slo` TTFT probe: p95 from durable
 * session history + histogram-bucket fallback, faster-candidate naming, and the
 * container-HEALTHCHECK exit-code semantics (0 within SLO / no data, 1 breach).
 */
import { describe, expect, test } from "bun:test";
import {
  type HistogramSeries,
  nameFasterCandidates,
  percentileFromHistogram,
  recentTtftP95Ms,
  runSloProbe,
} from "./slo-doctor";

function jsonl(...ttftSeconds: number[]): string {
  return ttftSeconds
    .map((s) => JSON.stringify({ ttftP95Seconds: s, ts: "2026-07-02T00:00:00Z" }))
    .join("\n");
}

describe("recentTtftP95Ms", () => {
  test("means the trailing window of durable ttftP95Seconds, in ms", () => {
    expect(recentTtftP95Ms(jsonl(1.0, 2.0))).toBeCloseTo(1500, 5);
  });

  test("skips torn lines, returns undefined on empty history", () => {
    expect(recentTtftP95Ms("")).toBeUndefined();
    expect(recentTtftP95Ms(`${jsonl(1.4)}\n{not json`)).toBeCloseTo(1400, 5);
  });

  test("bounds to the trailing window", () => {
    // 25 sessions at 0.1s then one at 10s; window=20 so the old 0.1s ones drop.
    const many = Array.from({ length: 25 }, () => 0.1);
    const text = jsonl(...many, 10);
    // trailing 20 = last 19 of the 0.1s + the 10s one → mean ≈ (19*100 + 10000)/20
    const got = recentTtftP95Ms(text, 20);
    expect(got).toBeGreaterThan(500);
  });
});

describe("percentileFromHistogram", () => {
  test("returns the first bucket edge whose cumulative count reaches the rank", () => {
    const series: HistogramSeries = {
      buckets: [0.1, 0.5, 1.0, 2.0],
      counts: [2, 5, 9, 10], // cumulative
      total: 10,
    };
    // p95 rank = 9.5 → first cumulative count >= 9.5 is bucket idx 3 (2.0).
    expect(percentileFromHistogram(series, 0.95)).toBe(2.0);
    // p50 rank = 5 → idx 1 (0.5).
    expect(percentileFromHistogram(series, 0.5)).toBe(0.5);
  });

  test("empty histogram ⇒ 0", () => {
    expect(percentileFromHistogram({ buckets: [], counts: [], total: 0 }, 0.95)).toBe(0);
  });
});

describe("nameFasterCandidates", () => {
  test("names same-provider cheaper candidates for a table-backed claude model", () => {
    const candidates = nameFasterCandidates("claude-opus-4-6");
    // Every candidate is a claude-* string (same provider), and none is the current family.
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.modelString.startsWith("claude-")).toBe(true);
      expect(c.modelString.startsWith("claude-opus-4-6")).toBe(false);
    }
    // Sorted cheapest-first.
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i]?.blendedPer1M).toBeGreaterThanOrEqual(
        candidates[i - 1]?.blendedPer1M ?? 0,
      );
    }
  });

  test("empty for a non-table-backed (local) model", () => {
    expect(nameFasterCandidates("local/llama3.2@http://localhost:11434/v1")).toEqual([]);
  });
});

describe("runSloProbe — exit code semantics", () => {
  test("no target ⇒ exit 0 with a note", () => {
    const r = runSloProbe({
      ttftTargetMs: undefined,
      currentModel: "claude-opus-4-6",
      sessionsJsonl: "",
    });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain("no observability.slo.ttft_ms");
  });

  test("no data ⇒ exit 0 (HEALTHCHECK must not flap on a cold store)", () => {
    const r = runSloProbe({
      ttftTargetMs: 1400,
      currentModel: "claude-opus-4-6",
      sessionsJsonl: "",
    });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain("no recent TTFT history");
  });

  test("within SLO ⇒ exit 0", () => {
    const r = runSloProbe({
      ttftTargetMs: 1400,
      currentModel: "claude-opus-4-6",
      sessionsJsonl: jsonl(0.5, 0.6),
    });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain("within target");
  });

  test("breach ⇒ exit 1 and names faster candidates + the eval --models command", () => {
    const r = runSloProbe({
      ttftTargetMs: 1000,
      currentModel: "claude-opus-4-6",
      sessionsJsonl: jsonl(2.0, 2.2),
    });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("exceeds target");
    const joined = r.lines.join("\n");
    expect(joined).toContain("faster candidates");
    expect(joined).toContain("crewhaus eval --models");
  });

  test("histogram fallback when no durable history", () => {
    const r = runSloProbe({
      ttftTargetMs: 1000,
      currentModel: "claude-opus-4-6",
      sessionsJsonl: "",
      histogram: { buckets: [0.5, 1.0, 2.0, 5.0], counts: [0, 0, 0, 10], total: 10 },
    });
    // p95 from buckets ≈ 2.0s = 2000ms > 1000ms target.
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("histogram");
  });
});

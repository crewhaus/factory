/**
 * The cost fold's 0.6.0 half: role/profile attribution, and the `summary`
 * split that decides whether a line is a double-count or the only record of
 * a nested run's spend.
 *
 * The pre-0.6.0 fields (`totalUsdMicros`, `byModel`, `days`) are pinned
 * golden in `server.test.ts`; this file covers what was added.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldHarnessCosts } from "./costs";
import { logLine, makeFixtureHarness } from "./fixture";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

function fold(lines: readonly unknown[]): ReturnType<typeof foldHarnessCosts> {
  const root = mkdtempSync(join(tmpdir(), "hangar-costs-"));
  try {
    const dir = makeFixtureHarness(join(root, "h"), {
      specName: "cost-fixture",
      sessions: [{ id: "sess_00000000000000aa", updatedAt: iso(NOW - DAY), log: lines }],
    });
    return foldHarnessCosts(dir, NOW);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const accrual = (fields: Record<string, unknown>): unknown =>
  logLine("cost_accrual", { provider: "anthropic", modelId: "m", ...fields }, iso(NOW - DAY));

describe("byRole / byProfile (0.6.0 §8.3)", () => {
  test("an unattributed call is the main turn, under the un-profiled bucket", () => {
    const costs = fold([accrual({ costUsdMicros: 100, inputTokens: 4, outputTokens: 2 })]);
    expect(costs.byRole).toEqual([
      { role: "primary", calls: 1, usdMicros: 100, inputTokens: 4, outputTokens: 2 },
    ]);
    expect(costs.byProfile).toEqual([
      { profile: "(none)", calls: 1, usdMicros: 100, inputTokens: 4, outputTokens: 2 },
    ]);
  });

  test("both splits rank biggest-first and sum to the total", () => {
    const costs = fold([
      accrual({ costUsdMicros: 100, role: "draft", profile: "fast" }),
      accrual({ costUsdMicros: 900, role: "judge", profile: "strong" }),
      accrual({ costUsdMicros: 300, role: "draft", profile: "fast" }),
    ]);
    expect(costs.byRole.map((r) => r.role)).toEqual(["judge", "draft"]);
    expect(costs.byRole.map((r) => r.usdMicros)).toEqual([900, 400]);
    expect(costs.byProfile.map((p) => p.profile)).toEqual(["strong", "fast"]);
    const roleSum = costs.byRole.reduce((n, r) => n + r.usdMicros, 0);
    const profileSum = costs.byProfile.reduce((n, r) => n + r.usdMicros, 0);
    expect(roleSum).toBe(costs.totalUsdMicros);
    expect(profileSum).toBe(costs.totalUsdMicros);
  });

  test("equal spend sorts by name, so the table never flickers between reads", () => {
    const costs = fold([
      accrual({ costUsdMicros: 100, role: "judge" }),
      accrual({ costUsdMicros: 100, role: "draft" }),
    ]);
    expect(costs.byRole.map((r) => r.role)).toEqual(["draft", "judge"]);
  });
});

describe("the `summary: true` split", () => {
  test("a role-LESS run total stays skipped — it sums lines already counted", () => {
    const costs = fold([
      accrual({ costUsdMicros: 100 }),
      accrual({ costUsdMicros: 9999, summary: true }),
    ]);
    expect(costs.totalUsdMicros).toBe(100);
    expect(costs.calls).toBe(1);
    expect(costs.rollups).toBe(0);
  });

  test("a role-BEARING roll-up folds — the child's own tracker writes no per-call line", () => {
    const costs = fold([
      accrual({ costUsdMicros: 100, role: "primary" }),
      accrual({
        costUsdMicros: 250,
        inputTokens: 40,
        outputTokens: 8,
        role: "subagent",
        profile: "fast",
        summary: true,
      }),
    ]);
    expect(costs.totalUsdMicros).toBe(350);
    expect(costs.rollups).toBe(1);
    expect(costs.byRole.map((r) => r.role)).toEqual(["subagent", "primary"]);
    expect(costs.byProfile.find((p) => p.profile === "fast")?.usdMicros).toBe(250);
    // One LINE is one call: the roll-up's real call count lives in the child's
    // own log, and `rollups` is how a reader sees the approximation.
    expect(costs.calls).toBe(2);
  });

  test("a flat (non-enveloped) roll-up folds the same way", () => {
    const costs = fold([
      { kind: "cost_accrual", provider: "anthropic", modelId: "m", costUsdMicros: 60 },
      {
        kind: "cost_accrual",
        provider: "anthropic",
        modelId: "m",
        costUsdMicros: 40,
        role: "subagent",
        summary: true,
      },
    ]);
    expect(costs.totalUsdMicros).toBe(100);
    expect(costs.rollups).toBe(1);
  });
});

/**
 * The cost fold's 0.6.0 half: role/profile attribution, and the `summary`
 * rule — in a DIRECTORY-wide fold every roll-up is a double-count, because
 * the nested run's own session log is one of the files being folded.
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

function foldSessions(
  sessions: ReadonlyArray<{ id: string; log: readonly unknown[] }>,
): ReturnType<typeof foldHarnessCosts> {
  const root = mkdtempSync(join(tmpdir(), "hangar-costs-"));
  try {
    const dir = makeFixtureHarness(join(root, "h"), {
      specName: "cost-fixture",
      sessions: sessions.map((s) => ({ id: s.id, updatedAt: iso(NOW - DAY), log: s.log })),
    });
    return foldHarnessCosts(dir, NOW);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fold(lines: readonly unknown[]): ReturnType<typeof foldHarnessCosts> {
  return foldSessions([{ id: "sess_00000000000000aa", log: lines }]);
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

  test("a role-BEARING roll-up is skipped too — this fold is DIRECTORY-wide", () => {
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
    // The roll-up is a TOTAL, never a call: the child's own per-call lines
    // are folded from the child's session file, a sibling in this very
    // directory. `rollups` reports that one was seen and skipped.
    expect(costs.totalUsdMicros).toBe(100);
    expect(costs.rollups).toBe(1);
    expect(costs.calls).toBe(1);
    expect(costs.byRole.map((r) => r.role)).toEqual(["primary"]);
  });

  test("a flat (non-enveloped) roll-up is skipped the same way", () => {
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
    expect(costs.totalUsdMicros).toBe(60);
    expect(costs.rollups).toBe(1);
  });

  test("parent roll-up + the child's own log counts the sub-agent's spend ONCE", () => {
    // The topology a sub-agent actually produces: the child runs with the
    // parent's `sessionRootDir`, so its session file is a sibling here and
    // runtime-core's cost mirror has already written its per-call
    // `role: "subagent"` lines. Folding the parent's roll-up on top would
    // report 2800 for 1900 of real spend.
    const costs = foldSessions([
      {
        id: "sess_00000000000000aa",
        log: [
          accrual({ costUsdMicros: 1000, role: "primary" }),
          accrual({ costUsdMicros: 900, role: "subagent", profile: "fast", summary: true }),
        ],
      },
      {
        id: "sess_00000000000000bb",
        log: [
          accrual({ costUsdMicros: 500, role: "subagent", profile: "fast" }),
          accrual({ costUsdMicros: 400, role: "subagent", profile: "fast" }),
        ],
      },
    ]);
    expect(costs.totalUsdMicros).toBe(1900);
    expect(costs.calls).toBe(3);
    expect(costs.rollups).toBe(1);
    expect(costs.byRole).toEqual([
      { role: "primary", calls: 1, usdMicros: 1000, inputTokens: 0, outputTokens: 0 },
      { role: "subagent", calls: 2, usdMicros: 900, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(costs.byProfile.find((p) => p.profile === "fast")?.usdMicros).toBe(900);
  });
});

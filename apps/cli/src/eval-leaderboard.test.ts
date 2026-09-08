/**
 * 0.6.0 §6.1 (PR 12) — `crewhaus eval leaderboard`'s CLI half: cell discovery
 * from a matrix root, the arm table, and `--export-priors`.
 *
 * The priors assertions are the load-bearing ones: a file written in the wrong
 * units, or fingerprinted against the wrong thing, is not "slightly off" — the
 * runtime either rejects it as stale (and warms up cold) or seeds the learned
 * policy with a number that means something else.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedRun } from "@crewhaus/eval-report";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { MAX_PRIOR_PSEUDO_COUNT, loadPriors, priorsFingerprint } from "@crewhaus/model-plan";
import { computeReward } from "@crewhaus/routing-store";
import {
  PRIOR_ROUTE_KEYS,
  buildPriorsFile,
  discoverMatrixCells,
  leaderboardLines,
  leaderboardTable,
  loadLeaderboard,
  writePriorsFile,
} from "./eval-leaderboard";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-leaderboard-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function sample(id: string, passed: boolean): SampleResult {
  return {
    sampleId: id,
    sessionId: `s_${id}`,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:01.000Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 100, output: 50 },
    model: "m",
    agentOutput: "out",
    grades: {
      overall: { passed, score: passed ? 1 : 0, rationale: "r" },
      perGrader: [{ name: "g", passed, score: passed ? 1 : 0, rationale: "r" }],
    },
  };
}

function summaryOf(model: string, n: number, passes: number): EvalRunSummary {
  const samples = Array.from({ length: n }, (_, i) => sample(`s${i}`, i < passes));
  return {
    runId: `run_${model.replace(/\W/g, "")}`,
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:10.000Z",
    samples,
    aggregates: {
      passRate: passes / n,
      meanScore: passes / n,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 200,
      totalTokens: { input: 100 * n, output: 50 * n },
      errorCount: 0,
      passRateCI95: [Math.max(0, passes / n - 0.05), Math.min(1, passes / n + 0.05)],
      meanScoreCI95: [Math.max(0, passes / n - 0.05), Math.min(1, passes / n + 0.05)],
    },
    config: {
      specHash: "h",
      datasetName: "d",
      graderNames: ["g"],
      model,
      concurrency: 1,
    },
    outDir: `/tmp/${model}`,
  };
}

const stubLoad =
  (byDir: Record<string, EvalRunSummary>) =>
  async (dir: string): Promise<LoadedRun> => {
    const summary = byDir[dir];
    if (summary === undefined) throw new Error(`results.json not found in ${dir}`);
    return { summary, perSample: {} };
  };

describe("discoverMatrixCells", () => {
  test("prefers matrix.json — it names crashed cells AND carries their arm ids", () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "matrix.json"),
      JSON.stringify({
        generatedAt: "x",
        rows: [
          {
            model: "claude-haiku-4-5",
            armId: "fast",
            slug: "fast",
            outDir: join(root, "fast"),
            status: "ok",
          },
          {
            model: "claude-opus-4-7",
            armId: "strong",
            slug: "strong",
            outDir: join(root, "strong"),
            status: "error",
          },
        ],
        best: { passRate: [], meanScore: [], p95LatencyMs: [], costPer1kSamplesUsd: [] },
      }),
    );
    expect(discoverMatrixCells(root)).toEqual([
      { model: "claude-haiku-4-5", armId: "fast", slug: "fast", outDir: join(root, "fast") },
      { model: "claude-opus-4-7", armId: "strong", slug: "strong", outDir: join(root, "strong") },
    ]);
  });

  test("falls back to the directory walk when matrix.json is absent or torn", () => {
    const root = newTempRoot();
    writeFileSync(join(root, "matrix.json"), "{ not json");
    for (const name of ["b-cell", "a-cell"]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "results.json"), "{}");
    }
    mkdirSync(join(root, "no-results"), { recursive: true });
    expect(discoverMatrixCells(root).map((c) => c.slug)).toEqual(["a-cell", "b-cell"]);
  });

  test("a directory with no cells at all says what to point it at", () => {
    expect(() => discoverMatrixCells(newTempRoot())).toThrow(/no eval cells found/);
  });
});

describe("loadLeaderboard", () => {
  test("an unreadable cell becomes an ERROR row, never an aborted board", async () => {
    const good = summaryOf("claude-haiku-4-5", 40, 30);
    const result = await loadLeaderboard(
      [
        { model: "claude-haiku-4-5", armId: "fast", slug: "fast", outDir: "/d/fast" },
        { model: "claude-opus-4-7", armId: "strong", slug: "strong", outDir: "/d/missing" },
      ],
      { loadRun: stubLoad({ "/d/fast": good }), seed: 29 },
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ arm: "fast", status: "ok", samples: 40 });
    expect(result.rows[1]).toMatchObject({ arm: "strong", status: "error" });
    // One comparable arm ⇒ the board refuses rather than crowning it.
    expect(result.board.verdict["passRate"]?.decision).toBe("underpowered");
    expect(leaderboardLines(result).join("\n")).toContain("[eval] passRate: UNDERPOWERED");
  });

  test("the table ranks by pass rate and carries the intervals", async () => {
    const result = await loadLeaderboard(
      [
        { model: "haiku", armId: "fast", slug: "fast", outDir: "/d/fast" },
        { model: "opus", armId: "strong", slug: "strong", outDir: "/d/strong" },
      ],
      {
        loadRun: stubLoad({
          "/d/fast": summaryOf("haiku", 40, 10),
          "/d/strong": summaryOf("opus", 40, 36),
        }),
        seed: 29,
      },
    );
    const table = leaderboardTable(result);
    expect(table.rows[0]?.[0]).toBe("strong");
    expect(table.rows[1]?.[0]).toBe("fast");
    expect(table.rows[0]?.[3]).toContain("[");
    expect(result.board.verdict["passRate"]?.decision).toBe("winner");
  });
});

describe("--export-priors", () => {
  const candidates = [
    { model: "claude-haiku-4-5", tags: ["cheap"], profile: "fast" },
    { model: "claude-opus-4-7", tags: ["strong"], profile: "strong" },
  ];

  async function board(): Promise<Awaited<ReturnType<typeof loadLeaderboard>>> {
    return loadLeaderboard(
      [
        { model: "claude-haiku-4-5", armId: "fast", slug: "fast", outDir: "/d/fast" },
        { model: "claude-opus-4-7", armId: "strong", slug: "strong", outDir: "/d/strong" },
      ],
      {
        loadRun: stubLoad({
          "/d/fast": summaryOf("claude-haiku-4-5", 40, 20),
          "/d/strong": summaryOf("claude-opus-4-7", 40, 36),
        }),
        pricing: (_model, tokens) => tokens.input * 2 + tokens.output * 8,
        seed: 29,
      },
    );
  }

  test("priors are in REWARD units — the same computeReward the live policy maximises", async () => {
    const result = await board();
    const priors = buildPriorsFile(result, { candidates });
    const strong = priors.arms.find((a) => a.arm === "strong" && a.routeKey === "hard");
    const row = result.matrix.rows.find((r) => r.armId === "strong");
    expect(strong?.meanReward).toBeCloseTo(
      computeReward({
        success: true,
        latencyMs: row?.p95LatencyMs as number,
        quality: row?.meanScore as number,
        costUsd: (row?.costPer1kSamplesUsd as number) / 1000,
      }),
      10,
    );
    // NOT the raw pass rate — that is the whole point of the units note.
    expect(strong?.meanReward).not.toBeCloseTo(0.9, 3);
  });

  test("the pseudo-count is capped at ten, whatever the dataset size", async () => {
    const priors = buildPriorsFile(await board(), { candidates });
    for (const a of priors.arms) expect(a.n).toBeLessThanOrEqual(MAX_PRIOR_PSEUDO_COUNT);
    expect(priors.arms.every((a) => a.n === MAX_PRIOR_PSEUDO_COUNT)).toBe(true);
    // A small eval seeds a proportionally weaker prior.
    const small = await loadLeaderboard(
      [{ model: "claude-haiku-4-5", armId: "fast", slug: "fast", outDir: "/d/fast" }],
      { loadRun: stubLoad({ "/d/fast": summaryOf("claude-haiku-4-5", 4, 2) }), seed: 29 },
    );
    expect(buildPriorsFile(small, { candidates }).arms[0]?.n).toBe(4);
  });

  test("every routable band is seeded, and the file is pinned to the ROSTER fingerprint", async () => {
    const priors = buildPriorsFile(await board(), { candidates, source: "/tmp/matrix" });
    expect(priors.fingerprint).toBe(priorsFingerprint(candidates));
    expect(priors.arms.map((a) => a.routeKey).sort()).toEqual(
      [...PRIOR_ROUTE_KEYS, ...PRIOR_ROUTE_KEYS].sort(),
    );
    // The runtime's own validator accepts it against that fingerprint …
    const accepted = loadPriors(priors, { expectFingerprint: priorsFingerprint(candidates) });
    expect(accepted.ok).toBe(true);
    // … and rejects it once the roster changes, rather than seeding wrong arms.
    const stale = loadPriors(priors, { expectFingerprint: "0000000000000000" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("fingerprint-stale");
  });

  test("an errored arm is seeded with NOTHING, never with a reward of zero", async () => {
    const result = await loadLeaderboard(
      [
        { model: "claude-haiku-4-5", armId: "fast", slug: "fast", outDir: "/d/fast" },
        { model: "claude-opus-4-7", armId: "strong", slug: "strong", outDir: "/d/missing" },
      ],
      { loadRun: stubLoad({ "/d/fast": summaryOf("claude-haiku-4-5", 40, 20) }), seed: 29 },
    );
    const priors = buildPriorsFile(result, { candidates });
    expect(priors.arms.every((a) => a.arm === "fast")).toBe(true);
  });

  test("the written file round-trips through the runtime validator", async () => {
    const dir = newTempRoot();
    const path = join(dir, "routing", "priors.json");
    writePriorsFile(path, buildPriorsFile(await board(), { candidates }));
    const parsed = loadPriors(JSON.parse(readFileSync(path, "utf-8")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.priors.arms.size).toBe(4);
  });
});

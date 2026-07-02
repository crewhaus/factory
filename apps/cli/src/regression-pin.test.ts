/**
 * Unit tests for the item-9 regression suite: post-accept pinning of
 * optimize recoveries (`pinRecoveredSamples` / `pinRecoveriesAfterOptimize`)
 * and the eval-side default union (`applyRegressionUnion`), plus the
 * documented item-3 interaction (the union changes the sample keyset, so
 * unioned runs key into a NEW baseline lineage). Fabricated `EvalRunSummary`
 * runs are persisted as `results.json` so `loadRun` works; the registry is
 * the real file-backed one rooted in a temp dir. No LLM/credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatasetRegistry, createFileBackedRegistry } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { getBaseline, readRunIndex } from "@crewhaus/eval-report";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { finishEvalRun } from "./eval-history";
import {
  applyRegressionUnion,
  foldDatasetHash,
  pinRecoveredSamples,
  pinRecoveriesAfterOptimize,
  regressionSuiteName,
} from "./regression-pin";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-regression-pin-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function newRegistry(root: string): DatasetRegistry {
  return createFileBackedRegistry({ rootDir: join(root, "datasets") });
}

const sample = (id: string, input = `input ${id}`): Sample => ({
  id,
  input,
  expected_output: `expected ${id}`,
});

// -------- eval-run fixtures (mirrors eval-history.test.ts) --------

function makeSampleResult(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

function makeSummary(
  runId: string,
  samples: SampleResult[],
  outDir: string,
  datasetName = "smoke",
): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: samples.reduce((sum, s) => sum + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName,
      datasetHash: "d".repeat(64),
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir,
  };
}

/** Persist a fabricated run so `loadRun(outDir)` succeeds. */
function persistRun(summary: EvalRunSummary): void {
  mkdirSync(summary.outDir, { recursive: true });
  writeFileSync(join(summary.outDir, "results.json"), JSON.stringify(summary, null, 2));
}

// -------- pinRecoveredSamples --------

describe("pinRecoveredSamples — suite versioning", () => {
  test("first pin creates v1: train-only split with provenance metadata", async () => {
    const registry = newRegistry(newTempRoot());
    const result = await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [sample("r1"), sample("r2")],
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
      now: () => new Date("2026-07-01T12:00:00Z"),
    });

    expect(result).toEqual({ suiteName: "concierge-regressions", pinned: 2, version: "v1" });
    const record = await registry.getRecord("concierge-regressions", "v1");
    expect(record.splits.train.map((s) => s.id).sort()).toEqual(["r1", "r2"]);
    expect(record.splits.dev).toHaveLength(0);
    expect(record.splits.test).toBeUndefined();
    expect(record.splits.train[0]?.metadata?.["regression_pin"]).toEqual({
      optimizeRunId: "opt_cafe",
      pinnedAt: "2026-07-01T12:00:00.000Z",
      sourceDataset: "support@v3",
    });
  });

  test("second pin unions + dedupes into v2, keeping the original pin's provenance", async () => {
    const registry = newRegistry(newTempRoot());
    await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [sample("r1")],
      sourceDataset: "support@v3",
      optimizeRunId: "opt_one",
      now: () => new Date("2026-07-01T12:00:00Z"),
    });
    const result = await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [sample("r1"), sample("r3")], // r1 is a re-pin
      sourceDataset: "support@v4",
      optimizeRunId: "opt_two",
      now: () => new Date("2026-07-02T12:00:00Z"),
    });

    expect(result.pinned).toBe(1);
    expect(result.version).toBe("v2");
    const record = await registry.getRecord("concierge-regressions", "v2");
    expect(record.splits.train.map((s) => s.id).sort()).toEqual(["r1", "r3"]);
    // r1 keeps its ORIGINAL provenance (existing pins win the dedupe).
    const r1 = record.splits.train.find((s) => s.id === "r1");
    expect(r1?.metadata?.["regression_pin"]).toMatchObject({ optimizeRunId: "opt_one" });
    const r3 = record.splits.train.find((s) => s.id === "r3");
    expect(r3?.metadata?.["regression_pin"]).toMatchObject({
      optimizeRunId: "opt_two",
      sourceDataset: "support@v4",
    });
  });

  test("no recoveries → no-op (no dataset version is written)", async () => {
    const registry = newRegistry(newTempRoot());
    const result = await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [],
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });
    expect(result).toEqual({ suiteName: "concierge-regressions", pinned: 0 });
    expect(await registry.list("concierge-regressions")).toHaveLength(0);
  });

  test("all-duplicate pin → no-op (no version churn)", async () => {
    const registry = newRegistry(newTempRoot());
    await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [sample("r1")],
      sourceDataset: "support@v3",
      optimizeRunId: "opt_one",
    });
    const result = await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [sample("r1")],
      sourceDataset: "support@v3",
      optimizeRunId: "opt_two",
    });
    expect(result.pinned).toBe(0);
    expect(await registry.list("concierge-regressions")).toEqual(["v1"]);
  });

  test("spec names outside the registry grammar → no-op instead of a registry error", async () => {
    const registry = newRegistry(newTempRoot());
    const result = await pinRecoveredSamples({
      registry,
      specName: "hello world", // spec safeName allows spaces; registry names don't
      samples: [sample("r1")],
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });
    expect(result.pinned).toBe(0);
  });
});

// -------- pinRecoveriesAfterOptimize --------

describe("pinRecoveriesAfterOptimize — diff-driven pinning", () => {
  /** Baseline: a fail, b pass, c fail. Winner: a pass, b pass, c fail → recoveries = [a]. */
  function persistDiffPair(root: string): { baselineRunDir: string; candidateRunDir: string } {
    const baselineRunDir = join(root, "run-base");
    const candidateRunDir = join(root, "run-best");
    persistRun(
      makeSummary(
        "run_aaaa1111aaaa1111",
        [
          makeSampleResult("a", false, 0),
          makeSampleResult("b", true, 1),
          makeSampleResult("c", false, 0),
        ],
        baselineRunDir,
      ),
    );
    persistRun(
      makeSummary(
        "run_bbbb2222bbbb2222",
        [
          makeSampleResult("a", true, 1),
          makeSampleResult("b", true, 1),
          makeSampleResult("c", false, 0),
        ],
        candidateRunDir,
      ),
    );
    return { baselineRunDir, candidateRunDir };
  }

  const samplesById = new Map<string, Sample>([
    ["a", sample("a")],
    ["b", sample("b")],
    ["c", sample("c")],
  ]);

  test("pins exactly the fail→pass recoveries from the run diff", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const dirs = persistDiffPair(root);

    const result = await pinRecoveriesAfterOptimize({
      registry,
      specName: "concierge",
      pin: true,
      ...dirs,
      samplesById,
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });

    expect(result).toEqual({ suiteName: "concierge-regressions", pinned: 1, version: "v1" });
    const record = await registry.getRecord("concierge-regressions", "v1");
    expect(record.splits.train.map((s) => s.id)).toEqual(["a"]);
  });

  test("pin: false (--no-pin-regressions) → undefined and the registry stays untouched", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const dirs = persistDiffPair(root);

    const result = await pinRecoveriesAfterOptimize({
      registry,
      specName: "concierge",
      pin: false,
      ...dirs,
      samplesById,
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });

    expect(result).toBeUndefined();
    expect(await registry.list("concierge-regressions")).toHaveLength(0);
  });

  test("missing run dirs (fitness fn without runDir reporting) → undefined", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const result = await pinRecoveriesAfterOptimize({
      registry,
      specName: "concierge",
      pin: true,
      samplesById,
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });
    expect(result).toBeUndefined();
  });

  test("no recoveries in the diff → no-op pin result", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    // Identical runs — diff has zero recoveries.
    const dir = join(root, "run-same");
    persistRun(makeSummary("run_cccc3333cccc3333", [makeSampleResult("a", true, 1)], dir));

    const result = await pinRecoveriesAfterOptimize({
      registry,
      specName: "concierge",
      pin: true,
      baselineRunDir: dir,
      candidateRunDir: dir,
      samplesById,
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });
    expect(result).toEqual({ suiteName: "concierge-regressions", pinned: 0 });
    expect(await registry.list("concierge-regressions")).toHaveLength(0);
  });
});

// -------- applyRegressionUnion --------

describe("applyRegressionUnion — eval-side default union", () => {
  async function seedSuite(registry: DatasetRegistry, samples: Sample[]): Promise<void> {
    await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples,
      sourceDataset: "support@v3",
      optimizeRunId: "opt_cafe",
    });
  }

  test("unions suite samples in by default, deduped by id — primary wins on collision", async () => {
    const registry = newRegistry(newTempRoot());
    await seedSuite(registry, [sample("p1", "SUITE COPY — must lose"), sample("r1")]);

    const primary = [sample("p1", "primary copy — must win"), sample("p2")];
    const union = await applyRegressionUnion({
      registry,
      specName: "concierge",
      includeRegressions: true,
      loadPrimarySamples: async () => primary,
      datasetName: "smoke",
      datasetHash: "a".repeat(64),
    });

    expect(union).toBeDefined();
    expect(union?.added).toBe(1);
    // Primary order first, suite additions appended.
    expect(union?.samples.map((s) => s.id)).toEqual(["p1", "p2", "r1"]);
    expect(union?.samples.find((s) => s.id === "p1")?.input).toBe("primary copy — must win");
    expect(union?.suiteName).toBe("concierge-regressions");
    expect(union?.suiteVersion).toBe("v1");
  });

  test("suffixes datasetName and folds the suite hash into datasetHash", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    await seedSuite(registry, [sample("r1")]);

    const opts = {
      registry,
      specName: "concierge",
      includeRegressions: true,
      loadPrimarySamples: async () => [sample("p1")],
      datasetName: "smoke",
      datasetHash: "a".repeat(64),
    };
    const union = await applyRegressionUnion(opts);
    expect(union?.datasetName).toBe("smoke+regressions@v1");
    expect(union?.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(union?.datasetHash).not.toBe("a".repeat(64));
    // Deterministic: the same inputs fold to the same hash…
    expect((await applyRegressionUnion(opts))?.datasetHash).toBe(union?.datasetHash as string);

    // …and a new suite version changes BOTH the name suffix and the hash.
    await seedSuite(registry, [sample("r2")]);
    const union2 = await applyRegressionUnion(opts);
    expect(union2?.datasetName).toBe("smoke+regressions@v2");
    expect(union2?.datasetHash).not.toBe(union?.datasetHash as string);
  });

  test("includeRegressions: false (--no-regressions) → undefined, primary never materialized", async () => {
    const registry = newRegistry(newTempRoot());
    await seedSuite(registry, [sample("r1")]);

    let loaded = false;
    const union = await applyRegressionUnion({
      registry,
      specName: "concierge",
      includeRegressions: false,
      loadPrimarySamples: async () => {
        loaded = true;
        return [sample("p1")];
      },
      datasetName: "smoke",
      datasetHash: "a".repeat(64),
    });
    expect(union).toBeUndefined();
    expect(loaded).toBe(false);
  });

  test("no suite in the registry → undefined, primary never materialized", async () => {
    const registry = newRegistry(newTempRoot());
    let loaded = false;
    const union = await applyRegressionUnion({
      registry,
      specName: "concierge",
      includeRegressions: true,
      loadPrimarySamples: async () => {
        loaded = true;
        return [sample("p1")];
      },
      datasetName: "smoke",
      datasetHash: "a".repeat(64),
    });
    expect(union).toBeUndefined();
    expect(loaded).toBe(false);
  });

  test("evaling the suite itself (registry:<spec>-regressions) skips the self-union", async () => {
    const registry = newRegistry(newTempRoot());
    await seedSuite(registry, [sample("r1")]);

    const union = await applyRegressionUnion({
      registry,
      specName: "concierge",
      includeRegressions: true,
      primaryRegistryName: regressionSuiteName("concierge"),
      loadPrimarySamples: async () => [sample("r1")],
      datasetName: "concierge-regressions@v1",
      datasetHash: "a".repeat(64),
    });
    expect(union).toBeUndefined();
  });

  test("foldDatasetHash is order-sensitive across its two inputs", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(foldDatasetHash(a, b)).not.toBe(foldDatasetHash(b, a));
    expect(foldDatasetHash(a, b)).toBe(foldDatasetHash(a, b));
  });
});

// -------- item-3 interaction: union restarts the baseline lineage --------

describe("regression union × run-history baselines (item 3 interaction)", () => {
  test("a unioned run keys into a NEW baseline lineage; the pre-union baseline survives", async () => {
    const root = newTempRoot();
    const registry = newRegistry(root);
    const evalsDir = join(root, ".crewhaus", "evals");
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);

    // Run 1 — plain primary dataset, pins the (concierge, smoke) baseline.
    const runA = makeSummary(
      "run_aaaa1111aaaa1111",
      [makeSampleResult("p1", true, 1), makeSampleResult("p2", true, 1)],
      join(root, "runA"),
    );
    persistRun(runA);
    await finishEvalRun({
      summary: runA,
      specName: "concierge",
      datasetHash: "a".repeat(64),
      outDir: runA.outDir,
      gateRequested: false,
      promote: true,
      evalsDir,
      write,
    });

    // An optimize run pins a recovery; eval now unions it in by default.
    await pinRecoveredSamples({
      registry,
      specName: "concierge",
      samples: [sample("r1")],
      sourceDataset: "smoke",
      optimizeRunId: "opt_cafe",
    });
    const union = await applyRegressionUnion({
      registry,
      specName: "concierge",
      includeRegressions: true,
      loadPrimarySamples: async () => [sample("p1"), sample("p2")],
      datasetName: "smoke",
      datasetHash: "a".repeat(64),
    });
    expect(union?.datasetName).toBe("smoke+regressions@v1");

    // Run 2 — the union changed the sample keyset AND the lineage key:
    // datasetName/datasetHash reflect the union, so the run-history index
    // keys honestly and the run starts a fresh baseline lineage instead of
    // diffing (and keyset-erroring) against the pre-union baseline.
    const runB = makeSummary(
      "run_bbbb2222bbbb2222",
      [
        makeSampleResult("p1", true, 1),
        makeSampleResult("p2", true, 1),
        makeSampleResult("r1", true, 1),
      ],
      join(root, "runB"),
      union?.datasetName as string,
    );
    persistRun(runB);
    lines.length = 0;
    const finish = await finishEvalRun({
      summary: runB,
      specName: "concierge",
      datasetHash: union?.datasetHash as string,
      outDir: runB.outDir,
      gateRequested: true,
      promote: true,
      evalsDir,
      write,
    });

    expect(finish.gateFailed).toBe(false);
    expect(lines).toContain(
      "[eval] baseline set: run_bbbb2222bbbb2222 (first run for concierge/smoke+regressions@v1)",
    );
    // New lineage pinned under the union key; the pre-union pin survives.
    expect(getBaseline("concierge", "smoke+regressions@v1", evalsDir)?.runId).toBe(
      "run_bbbb2222bbbb2222",
    );
    expect(getBaseline("concierge", "smoke", evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    // The run index carries the honest union datasetName + folded hash.
    const index = readRunIndex(evalsDir);
    expect(index[index.length - 1]).toMatchObject({
      runId: "run_bbbb2222bbbb2222",
      datasetName: "smoke+regressions@v1",
      datasetHash: union?.datasetHash as string,
    });
  });

  test("counterfactual: a keyset change under an UNCHANGED datasetName restarts the lineage in place", async () => {
    // This is the "dataset changed — starting new baseline lineage" path the
    // union would trip if datasetName were NOT suffixed — kept honest here so
    // a regression in either half of the interaction fails a test.
    const root = newTempRoot();
    const evalsDir = join(root, ".crewhaus", "evals");
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);

    const runA = makeSummary(
      "run_aaaa1111aaaa1111",
      [makeSampleResult("p1", true, 1)],
      join(root, "runA"),
    );
    persistRun(runA);
    await finishEvalRun({
      summary: runA,
      specName: "concierge",
      datasetHash: "a".repeat(64),
      outDir: runA.outDir,
      gateRequested: false,
      promote: true,
      evalsDir,
      write,
    });

    const runB = makeSummary(
      "run_bbbb2222bbbb2222",
      [makeSampleResult("p1", true, 1), makeSampleResult("r1", true, 1)],
      join(root, "runB"),
    );
    persistRun(runB);
    lines.length = 0;
    await finishEvalRun({
      summary: runB,
      specName: "concierge",
      datasetHash: "b".repeat(64),
      outDir: runB.outDir,
      gateRequested: false,
      promote: true,
      evalsDir,
      write,
    });

    expect(lines).toContain("[eval] dataset changed — starting new baseline lineage");
    expect(getBaseline("concierge", "smoke", evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
  });
});

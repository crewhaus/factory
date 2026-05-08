#!/usr/bin/env bun
/**
 * Section 29 — Evaluation depth + EVAL target shape — end-to-end smoke.
 *
 * Five probes:
 *   1. dataset-registry: put + list + get per split
 *   2. dataset-registry: split-leak refusal (test split locked)
 *   3. grader-registry: register/lookup + plugin discovery
 *   4. regression-runner: identical runs → pass; injected regression → fail
 *   5. prompt-optimizer: deterministic search improves a fitness function
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatasetRegistryError, createFileBackedRegistry } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { GraderRegistry, discoverPluginGraders } from "@crewhaus/grader-registry";
import { optimize } from "@crewhaus/prompt-optimizer";
import { gate, regress } from "@crewhaus/regression-runner";

const log = (m: string): void => {
  process.stderr.write(`[smoke-29] ${m}\n`);
};
const fail = (m: string): never => {
  process.stderr.write(`[smoke-29] FAIL: ${m}\n`);
  process.exit(2);
};
const ok = (m: string): void => {
  process.stderr.write(`[smoke-29] ✓ ${m}\n`);
};

const sample = (id: string, input: string, expected = ""): Sample => ({
  id,
  input,
  expected_output: expected,
});

function makeSampleResult(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess-${id}`,
    startedAt: "2026-05-08T00:00:00Z",
    endedAt: "2026-05-08T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 10 },
    model: "claude-opus-4-7",
    agentOutput: `output ${id}`,
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "fail" },
      perGrader: [{ name: "g", passed, score, rationale: passed ? "ok" : "fail" }],
    },
  };
}

function makeSummary(samples: SampleResult[]): EvalRunSummary {
  const passed = samples.filter((s) => s.grades.overall.passed).length;
  return {
    runId: `run-${Math.random().toString(16).slice(2, 6)}`,
    startedAt: "2026-05-08T00:00:00Z",
    endedAt: "2026-05-08T00:00:01Z",
    samples,
    aggregates: {
      passRate: samples.length === 0 ? 0 : passed / samples.length,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 100, output: 100 },
      errorCount: 0,
    },
    config: {
      specHash: "h",
      datasetName: "smoke",
      graderNames: ["g"],
      model: "claude-opus-4-7",
      concurrency: 1,
    },
    outDir: "/tmp",
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const s of it) out.push(s);
  return out;
}

const main = async (): Promise<void> => {
  const tmpRoot = join(tmpdir(), `smoke29-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });

  try {
    // ────────── Probe 1: dataset-registry ──────────
    {
      log("probe 1: dataset-registry — put + list + get per split");
      const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "datasets") });
      await reg.put({
        name: "smoke-eval",
        version: "v1",
        splits: {
          train: [sample("t1", "2+2", "4"), sample("t2", "3+3", "6")],
          dev: [sample("d1", "1+1", "2")],
          test: [sample("test1", "5+5", "10")],
        },
      });
      const versions = await reg.list("smoke-eval");
      if (JSON.stringify(versions) !== JSON.stringify(["v1"])) {
        fail(`expected [v1], got ${JSON.stringify(versions)}`);
      }
      const train = await collect(reg.get("smoke-eval", "v1", "train"));
      const dev = await collect(reg.get("smoke-eval", "v1", "dev"));
      if (train.length !== 2) fail(`expected 2 train samples, got ${train.length}`);
      if (dev.length !== 1) fail(`expected 1 dev sample, got ${dev.length}`);
      ok("dataset-registry: put + list + get per split");
    }

    // ────────── Probe 2: split-leak refusal ──────────
    {
      log("probe 2: dataset-registry — test split locked without allowTestSplit");
      const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "datasets") });
      try {
        await collect(reg.get("smoke-eval", "v1", "test"));
        fail("expected DatasetRegistryError but get succeeded");
      } catch (err) {
        if (!(err instanceof DatasetRegistryError)) {
          fail(`expected DatasetRegistryError, got ${(err as Error).constructor.name}`);
        }
      }
      // With override, it works:
      const test = await collect(reg.get("smoke-eval", "v1", "test", { allowTestSplit: true }));
      if (test.length !== 1) fail(`expected 1 test sample with override, got ${test.length}`);
      ok("dataset-registry: test split locked without allowTestSplit override");
    }

    // ────────── Probe 3: grader-registry ──────────
    {
      log("probe 3: grader-registry — register/lookup + plugin discovery");
      const reg = new GraderRegistry();
      reg.register("inline_grader", async () => ({
        passed: true,
        score: 1,
        rationale: "always pass",
      }));
      if (!reg.has("inline_grader")) fail("expected inline_grader registered");

      const pluginRoot = join(tmpRoot, "grader-plugins");
      mkdirSync(join(pluginRoot, "fixture"), { recursive: true });
      writeFileSync(
        join(pluginRoot, "fixture", "index.ts"),
        `export default {
  name: "fixture_grader",
  grader: async () => ({ passed: true, score: 0.9, rationale: "from plugin" }),
};
`,
      );
      const registered = await discoverPluginGraders(reg, pluginRoot);
      if (registered.length !== 1 || registered[0] !== "fixture_grader") {
        fail(`unexpected discovered graders: ${JSON.stringify(registered)}`);
      }
      const g = reg.lookup("fixture_grader");
      const r = await g({ id: "x", input: "y" }, {} as never);
      if (r.rationale !== "from plugin") fail("plugin grader return wrong");
      ok("grader-registry: inline register + plugin discovery");
    }

    // ────────── Probe 4: regression-runner ──────────
    {
      log("probe 4: regression-runner — identical runs pass; injected regression fails");
      const allPass = makeSummary([
        makeSampleResult("a", true, 1),
        makeSampleResult("b", true, 1),
        makeSampleResult("c", true, 1),
        makeSampleResult("d", true, 1),
      ]);
      const passVerdict = gate(allPass, allPass);
      if (passVerdict.verdict !== "pass") fail("identical runs should pass gate");

      const regressed = makeSummary([
        makeSampleResult("a", true, 1),
        makeSampleResult("b", true, 1),
        makeSampleResult("c", false, 0),
        makeSampleResult("d", false, 0),
      ]);
      const regressedReport = regress(allPass, regressed);
      if (regressedReport.regressions.length !== 2) {
        fail(`expected 2 regressions, got ${regressedReport.regressions.length}`);
      }
      const failVerdict = gate(allPass, regressed, { regressionThreshold: 0.1 });
      if (failVerdict.verdict !== "fail") fail("regression should trigger fail verdict");
      ok("regression-runner: identical→pass; 50% pass→fail flips→fail under 10% threshold");
    }

    // ────────── Probe 5: prompt-optimizer ──────────
    {
      log("probe 5: prompt-optimizer — fitness-driven search improves baseline");
      const fitness = async (prompt: string): Promise<number> => {
        let score = 0.5;
        if (prompt.includes("Be concise")) score += 0.4;
        if (prompt.startsWith("Think step by step")) score += 0.1;
        return score;
      };
      const samples = Array.from({ length: 20 }, (_, i) => sample(`s${i}`, `q${i}`, `a${i}`));
      const result = await optimize("answer", {
        trainSet: samples.slice(0, 15),
        devSet: samples.slice(15),
        fitness,
        iterations: 20,
        seed: 0xfeed,
      });
      if (result.improvement < 0.1) {
        fail(`expected ≥0.1 improvement, got ${result.improvement.toFixed(3)}`);
      }
      ok(
        `prompt-optimizer: improved baseline by ${result.improvement.toFixed(2)} over 20 iterations`,
      );
    }

    log("all probes passed.");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((err) => {
  process.stderr.write(
    `[smoke-29] threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});

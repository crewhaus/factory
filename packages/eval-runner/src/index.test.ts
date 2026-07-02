import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`test fixture must be target:cli, got ${ir.target}`);
  return ir;
}
import { aggregate, quantile } from "./aggregate";
import { type AgentInvoker, runEval } from "./index";
import { Semaphore } from "./semaphore";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-runner-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const HELLO_SPEC = `name: hello-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    You are a helpful, concise assistant.
`;

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const FIXED_GRADERS = `
graders:
  - name: math
    type: exact_match
`;

describe("Semaphore", () => {
  test("respects capacity", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 10 }).map(async () => {
      const release = await sem.acquire();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      release();
    });
    await Promise.all(tasks);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("rejects capacity < 1", () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

describe("aggregate", () => {
  test("quantile handles edge cases", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([42], 0.5)).toBe(42);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8);
  });

  test("computes pass rate, mean score, percentiles", () => {
    const samples = [
      mockSample("s1", true, 1, 100, 1),
      mockSample("s2", true, 0.5, 200, 2),
      mockSample("s3", false, 0, 300, 3),
    ];
    const agg = aggregate(samples);
    expect(agg.passRate).toBeCloseTo(2 / 3);
    expect(agg.meanScore).toBeCloseTo(0.5);
    expect(agg.p50LatencyMs).toBe(200);
    expect(agg.errorCount).toBe(0);
  });
});

describe("runEval — T3 5-sample fixture", () => {
  test("runs 5 samples, persists artifacts, computes aggregates", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const samples: Sample[] = [
      { id: "q1", input: "What is 2+2?", expected_output: "4" },
      { id: "q2", input: "What is 5-3?", expected_output: "2" },
      { id: "q3", input: "What is 6/2?", expected_output: "3" },
      { id: "q4", input: "What is 3*3?", expected_output: "9" },
      { id: "q5", input: "What is 10-7?", expected_output: "3" },
    ];

    // Stub invoker: returns the expected_output verbatim. exact_match grader passes.
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      transcript: [],
      events: [],
    });

    const { compiled } = parseGradersConfig(FIXED_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "fixture5", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir, concurrency: 2 },
    });

    expect(summary.samples).toHaveLength(5);
    expect(summary.aggregates.passRate).toBe(1);
    expect(summary.aggregates.meanScore).toBe(1);

    // Per-sample artifacts
    for (const id of ["q1", "q2", "q3", "q4", "q5"]) {
      expect(existsSync(join(outDir, id, "transcript.jsonl"))).toBe(true);
      expect(existsSync(join(outDir, id, "events.jsonl"))).toBe(true);
      expect(existsSync(join(outDir, id, "grades.json"))).toBe(true);
      expect(existsSync(join(outDir, id, "meta.json"))).toBe(true);
    }
    // Run-level artifacts
    expect(existsSync(join(outDir, "run.json"))).toBe(true);
    expect(existsSync(join(outDir, "results.json"))).toBe(true);
    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect(results.samples).toHaveLength(5);
    expect(results.aggregates.passRate).toBe(1);
  });

  test("threads an optional datasetHash into run.json and results.json config", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "x", expected_output: "y" }];
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      transcript: [],
      events: [],
    });
    const { compiled } = parseGradersConfig(FIXED_GRADERS);
    const datasetHash = "f".repeat(64);
    const summary = await runEval({
      ir,
      dataset: { name: "hashed", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir, datasetHash },
    });
    expect(summary.config.datasetHash).toBe(datasetHash);
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.datasetHash).toBe(datasetHash);
    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect(results.config.datasetHash).toBe(datasetHash);
  });

  test("omits datasetHash when the caller does not supply one", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "x", expected_output: "y" }];
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      transcript: [],
      events: [],
    });
    const { compiled } = parseGradersConfig(FIXED_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "unhashed", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(summary.config.datasetHash).toBeUndefined();
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect("datasetHash" in runJson).toBe(false);
  });

  test("captures grader failures correctly", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const samples: Sample[] = [
      { id: "ok", input: "x", expected_output: "y" },
      { id: "wrong", input: "x", expected_output: "y" },
    ];
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.id === "ok" ? "y" : "z",
      transcript: [],
      events: [],
    });
    const { compiled } = parseGradersConfig(FIXED_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "mixed", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(summary.aggregates.passRate).toBe(0.5);
    expect(summary.samples.find((s) => s.sampleId === "wrong")?.grades.overall.passed).toBe(false);
  });

  test("invoker errors do not kill the rest of the run", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const samples: Sample[] = [
      { id: "ok", input: "x", expected_output: "y" },
      { id: "boom", input: "x", expected_output: "y" },
    ];
    const invoker: AgentInvoker = async ({ sample }) => {
      if (sample.id === "boom") throw new Error("invoker exploded");
      return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
    };
    const { compiled } = parseGradersConfig(FIXED_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "withErr", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(summary.samples).toHaveLength(2);
    expect(summary.aggregates.errorCount).toBe(1);
    const boom = summary.samples.find((s) => s.sampleId === "boom");
    expect(boom?.error).toBe("invoker exploded");
    expect(boom?.grades.overall.passed).toBe(false);
    // The good sample still completed and was scored.
    expect(summary.samples.find((s) => s.sampleId === "ok")?.grades.overall.passed).toBe(true);
  });

  test("rejects empty dataset", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const invoker: AgentInvoker = async () => ({
      agentOutput: "",
      transcript: [],
      events: [],
    });
    const { compiled } = parseGradersConfig(FIXED_GRADERS);
    await expect(
      runEval({
        ir,
        dataset: { name: "empty", samples: yieldSamples([]) },
        compiledGraders: compiled,
        opts: { invoker, outDir },
      }),
    ).rejects.toThrow(/yielded zero samples/);
  });
});

describe("runEval — T7 200-sample concurrency-8 SLO", () => {
  test("completes 200 samples at concurrency 8 well under 60s", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const samples: Sample[] = Array.from({ length: 200 }).map((_, i) => ({
      id: `s${i.toString().padStart(3, "0")}`,
      input: `q${i}`,
      expected_output: `a${i}`,
    }));
    const invoker: AgentInvoker = async ({ sample }) => {
      // Tiny delay to mimic real-world async work without burning CPU.
      await new Promise((r) => setTimeout(r, 1));
      return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
    };
    const { compiled } = parseGradersConfig(FIXED_GRADERS);

    const t0 = performance.now();
    const summary = await runEval({
      ir,
      dataset: { name: "load200", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir, concurrency: 8 },
    });
    const elapsedMs = performance.now() - t0;

    expect(summary.samples).toHaveLength(200);
    expect(summary.aggregates.passRate).toBe(1);
    expect(elapsedMs).toBeLessThan(60_000);
  }, 90_000);
});

function mockSample(id: string, passed: boolean, score: number, latencyMs: number, turns: number) {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs,
    turns,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: "x",
    grades: {
      overall: { passed, score, rationale: "" },
      perGrader: [],
    },
  };
}

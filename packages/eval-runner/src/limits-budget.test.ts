/**
 * NEW-HUNT-3 — the spec's `limits:`/`budget:` blocks (and their flag
 * overrides) honored by eval runs:
 *   - per-sample wall-clock watchdog (`sampleTimeoutMs` >
 *     `limits.deadline_ms`): a slow invoker records an errored sample
 *     instead of stalling its slot;
 *   - run-level budget cap (`budgetUsd` > `budget.usd`, metered through the
 *     injected pricing seam): queued samples abort at the cap with the
 *     documented `[eval] budget exhausted after k/N samples` error, and
 *     the summary/results.json are marked partial;
 *   - flag > spec precedence on both knobs;
 *   - absent both spec block and options = today's exact behavior
 *     (covered by every other suite in this package).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, type EvalPricingFn, runEval } from "./index";

const BASE_SPEC = `name: limits-budget-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
`;

function specWith(extra: string): IrV0 {
  return narrowToAgent(lower(parseSpec(BASE_SPEC + extra)));
}

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-limits-budget-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

function samples(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    input: `q${i + 1}`,
    expected_output: "yes",
  }));
}

/** Invoker that answers correctly after `delayMs` of wall clock. */
function slowInvoker(delayMs: number): AgentInvoker {
  return async ({ sample }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { agentOutput: sample.expected_output ?? "", events: [] };
  };
}

/** Prices every run at a constant micro-USD figure, whatever the tokens
 *  (stub invokers emit no model_response events, so token totals are 0). */
function flatPricing(microsPerCall: number): EvalPricingFn {
  return () => microsPerCall;
}

describe("runEval — per-sample timeout (NEW-HUNT-3 limits)", () => {
  test("a slow sample times out into an errored result; fast samples still grade", async () => {
    const outDir = newTempRoot();
    const ir = specWith("");
    const invoker: AgentInvoker = async ({ sample }) => {
      if (sample.id === "s2") await new Promise((resolve) => setTimeout(resolve, 300));
      return { agentOutput: sample.expected_output ?? "", events: [] };
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "timeout", samples: yieldSamples(samples(3)) },
      compiledGraders: compiled,
      opts: { invoker, outDir, concurrency: 1, sampleTimeoutMs: 40, retryErrors: false },
    });

    const byId = new Map(summary.samples.map((s) => [s.sampleId, s]));
    expect(byId.get("s1")?.grades.overall.passed).toBe(true);
    expect(byId.get("s3")?.grades.overall.passed).toBe(true);
    expect(byId.get("s2")?.error).toMatch(/timed out after 40ms/);
    expect(byId.get("s2")?.grades.overall.passed).toBe(false);
    expect(summary.aggregates.errorCount).toBe(1);
    // The knob in force is recorded on the config snapshot.
    expect(summary.config.sampleTimeoutMs).toBe(40);
    // A timeout is a normal errored sample — never a partial run.
    expect(summary.partial).toBeUndefined();
  });

  test("the spec's limits.deadline_ms is the default per-sample timeout", async () => {
    const outDir = newTempRoot();
    const ir = specWith("limits:\n  deadline_ms: 40\n");
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "spec-deadline", samples: yieldSamples(samples(1)) },
      compiledGraders: compiled,
      opts: { invoker: slowInvoker(300), outDir, concurrency: 1, retryErrors: false },
    });
    expect(summary.samples[0]?.error).toMatch(/timed out after 40ms/);
    expect(summary.config.sampleTimeoutMs).toBe(40);
  });

  test("--sample-timeout-ms overrides the spec's tighter deadline (flag > spec)", async () => {
    const outDir = newTempRoot();
    const ir = specWith("limits:\n  deadline_ms: 20\n");
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "flag-wins", samples: yieldSamples(samples(1)) },
      compiledGraders: compiled,
      opts: { invoker: slowInvoker(60), outDir, concurrency: 1, sampleTimeoutMs: 5000 },
    });
    expect(summary.samples[0]?.error).toBeUndefined();
    expect(summary.samples[0]?.grades.overall.passed).toBe(true);
    expect(summary.config.sampleTimeoutMs).toBe(5000);
  });

  test("an invalid sampleTimeoutMs is a loud config error at run start", async () => {
    const outDir = newTempRoot();
    const ir = specWith("");
    const { compiled } = parseGradersConfig(GRADERS);
    for (const bad of [0, -5, 2.5]) {
      await expect(
        runEval({
          ir,
          dataset: { name: "bad-timeout", samples: yieldSamples(samples(1)) },
          compiledGraders: compiled,
          opts: { invoker: slowInvoker(1), outDir, sampleTimeoutMs: bad },
        }),
      ).rejects.toThrow(/invalid sampleTimeoutMs/);
    }
  });
});

describe("runEval — run-level budget cap (NEW-HUNT-3 budget)", () => {
  test("budget exhaustion aborts queued samples with partial results", async () => {
    const outDir = newTempRoot();
    const ir = specWith("");
    const { compiled } = parseGradersConfig(GRADERS);
    // $0.50 per sample against a $1.00 cap: s1 + s2 run, s3 + s4 abort.
    const summary = await runEval({
      ir,
      dataset: { name: "budget", samples: yieldSamples(samples(4)) },
      compiledGraders: compiled,
      opts: {
        invoker: slowInvoker(1),
        outDir,
        concurrency: 1,
        budgetUsd: 1,
        pricing: flatPricing(500_000),
      },
    });

    const byId = new Map(summary.samples.map((s) => [s.sampleId, s]));
    expect(byId.get("s1")?.grades.overall.passed).toBe(true);
    expect(byId.get("s2")?.grades.overall.passed).toBe(true);
    expect(byId.get("s3")?.error).toMatch(/\[eval\] budget exhausted after 2\/4 samples/);
    expect(byId.get("s4")?.error).toMatch(/\[eval\] budget exhausted after 2\/4 samples/);
    expect(summary.partial).toEqual({
      reason: "budget_exhausted",
      completedSamples: 2,
      totalSamples: 4,
      spentUsd: 1,
      budgetUsd: 1,
    });
    expect(summary.config.budgetUsd).toBe(1);
    // The partial marker survives into the persisted results.json.
    const persisted = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect(persisted.partial).toEqual({
      reason: "budget_exhausted",
      completedSamples: 2,
      totalSamples: 4,
      spentUsd: 1,
      budgetUsd: 1,
    });
  });

  test("the spec's budget.usd is the default cap", async () => {
    const outDir = newTempRoot();
    const ir = specWith("budget:\n  usd: 0.5\n");
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "spec-budget", samples: yieldSamples(samples(3)) },
      compiledGraders: compiled,
      opts: {
        invoker: slowInvoker(1),
        outDir,
        concurrency: 1,
        pricing: flatPricing(500_000),
      },
    });
    expect(summary.partial?.completedSamples).toBe(1);
    expect(summary.partial?.budgetUsd).toBe(0.5);
    expect(summary.config.budgetUsd).toBe(0.5);
    expect(
      summary.samples.filter((s) => s.error?.includes("budget exhausted") === true),
    ).toHaveLength(2);
  });

  test("--budget-usd overrides the spec's tighter cap (flag > spec)", async () => {
    const outDir = newTempRoot();
    const ir = specWith("budget:\n  usd: 0.5\n");
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "budget-flag-wins", samples: yieldSamples(samples(3)) },
      compiledGraders: compiled,
      opts: {
        invoker: slowInvoker(1),
        outDir,
        concurrency: 1,
        budgetUsd: 100,
        pricing: flatPricing(500_000),
      },
    });
    expect(summary.partial).toBeUndefined();
    expect(summary.samples.every((s) => s.error === undefined)).toBe(true);
    expect(summary.config.budgetUsd).toBe(100);
  });

  test("a declared budget without a priced model runs un-metered (never guesses)", async () => {
    const outDir = newTempRoot();
    const ir = specWith("budget:\n  usd: 0.5\n");
    const { compiled } = parseGradersConfig(GRADERS);
    // No pricing seam at all — enforcement is impossible, so every sample
    // still runs and the declared cap is recorded on the config snapshot.
    const summary = await runEval({
      ir,
      dataset: { name: "unpriced", samples: yieldSamples(samples(3)) },
      compiledGraders: compiled,
      opts: { invoker: slowInvoker(1), outDir, concurrency: 1 },
    });
    expect(summary.partial).toBeUndefined();
    expect(summary.samples.every((s) => s.error === undefined)).toBe(true);
    expect(summary.config.budgetUsd).toBe(0.5);
  });

  test("an invalid budgetUsd is a loud config error at run start", async () => {
    const outDir = newTempRoot();
    const ir = specWith("");
    const { compiled } = parseGradersConfig(GRADERS);
    for (const bad of [0, -1, Number.NaN]) {
      await expect(
        runEval({
          ir,
          dataset: { name: "bad-budget", samples: yieldSamples(samples(1)) },
          compiledGraders: compiled,
          opts: { invoker: slowInvoker(1), outDir, budgetUsd: bad },
        }),
      ).rejects.toThrow(/invalid budgetUsd/);
    }
  });
});

/**
 * Loop contract 0.4 (Batch B, G15) — `RunEvalOptions.repeats`: per-sample
 * seed-offset trials, per-trial grades on the SampleResult, pass@k /
 * pass^k in the aggregates, and the untouched single-trial shape when
 * repeats is 1/absent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, runEval } from "./index";

const SPEC = `name: repeats-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-repeats-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

const SAMPLES: Sample[] = [
  { id: "s1", input: "a", expected_output: "yes" },
  { id: "s2", input: "b", expected_output: "yes" },
  { id: "s3", input: "c", expected_output: "yes" },
];

/** Deterministic flaky invoker: per-sample outcome script, one entry per
 *  trial (true = return the expected output, false = return garbage). */
function scriptedInvoker(script: Record<string, boolean[]>): {
  invoker: AgentInvoker;
  seeds: Record<string, Array<number | undefined>>;
} {
  const counts = new Map<string, number>();
  const seeds: Record<string, Array<number | undefined>> = {};
  const invoker: AgentInvoker = async ({ sample, seed }) => {
    const n = counts.get(sample.id) ?? 0;
    counts.set(sample.id, n + 1);
    const seen = seeds[sample.id] ?? [];
    seen.push(seed);
    seeds[sample.id] = seen;
    const pass = script[sample.id]?.[n] ?? false;
    return { agentOutput: pass ? (sample.expected_output ?? "") : "wrong", events: [] };
  };
  return { invoker, seeds };
}

describe("runEval — repeats (G15 pass^k)", () => {
  test("k=3 trials: per-trial grades, trial pass-rates, pass@k / pass^k", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    // s1: all 3 pass; s2: pass, fail, pass; s3: all fail.
    const { invoker, seeds } = scriptedInvoker({
      s1: [true, true, true],
      s2: [true, false, true],
      s3: [false, false, false],
    });
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "flaky", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: { invoker, outDir, concurrency: 2, repeats: 3, seed: 100 },
    });

    // Canonical fields come from trial 1: s1 pass, s2 pass, s3 fail.
    expect(summary.aggregates.passRate).toBeCloseTo(2 / 3);
    // pass@3 — any trial passed: s1 and s2. pass^3 — ALL trials passed: s1.
    expect(summary.aggregates.passAtK).toBeCloseTo(2 / 3);
    expect(summary.aggregates.passHatK).toBeCloseTo(1 / 3);
    expect(summary.aggregates.totalTokensAllTrials).toEqual({ input: 0, output: 0 });
    expect(summary.config.repeats).toBe(3);

    const byId = new Map(summary.samples.map((s) => [s.sampleId, s]));
    const s1 = byId.get("s1");
    const s2 = byId.get("s2");
    const s3 = byId.get("s3");
    expect(s1?.trials).toHaveLength(3);
    expect(s1?.trialPassRate).toBeCloseTo(1);
    expect(s2?.trialPassRate).toBeCloseTo(2 / 3);
    expect(s2?.trials?.map((t) => t.passed)).toEqual([true, false, true]);
    expect(s3?.trialPassRate).toBeCloseTo(0);
    // Trials are 1-based and carry their seed-offset seed.
    expect(s2?.trials?.map((t) => t.trial)).toEqual([1, 2, 3]);
    expect(s2?.trials?.map((t) => t.seed)).toEqual([100, 101, 102]);
    // The invoker actually SAW the offset seeds, in trial order.
    expect(seeds["s2"]).toEqual([100, 101, 102]);

    // Trial ≥ 2 artifacts land in their own directories; trial 1 keeps the
    // canonical layout.
    expect(existsSync(join(outDir, "s2", "grades.json"))).toBe(true);
    expect(existsSync(join(outDir, "s2.trial2", "grades.json"))).toBe(true);
    expect(existsSync(join(outDir, "s2.trial3", "grades.json"))).toBe(true);
    const trial2Meta = JSON.parse(readFileSync(join(outDir, "s2.trial2", "meta.json"), "utf-8"));
    expect(trial2Meta.trial).toBe(2);
    expect(trial2Meta.seed).toBe(101);

    // run.json records repeats.
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.repeats).toBe(3);
  });

  test("without a run seed, trials carry no seed (i.i.d. draws)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { invoker, seeds } = scriptedInvoker({ s1: [true, true] });
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "noseed", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: { invoker, outDir, repeats: 2 },
    });
    expect(seeds["s1"]).toEqual([undefined, undefined]);
    expect(summary.samples[0]?.trials?.every((t) => t.seed === undefined)).toBe(true);
  });

  test("repeats=1 (default) keeps the single-trial result shape exactly", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { invoker } = scriptedInvoker({ s1: [true] });
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "single", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    const s = summary.samples[0];
    expect(s?.trials).toBeUndefined();
    expect(s?.trialPassRate).toBeUndefined();
    expect(summary.aggregates.passAtK).toBeUndefined();
    expect(summary.aggregates.passHatK).toBeUndefined();
    expect(summary.aggregates.totalTokensAllTrials).toBeUndefined();
    expect(summary.config.repeats).toBeUndefined();
    // The persisted results.json carries none of the trial keys either.
    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect("trials" in (results.samples[0] ?? {})).toBe(false);
    expect("passAtK" in results.aggregates).toBe(false);
  });

  test("invalid repeats is a loud RunnerError", async () => {
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { invoker } = scriptedInvoker({ s1: [true] });
    const { compiled } = parseGradersConfig(GRADERS);
    for (const repeats of [0, -1, 1.5]) {
      await expect(
        runEval({
          ir,
          dataset: { name: "bad", samples: yieldSamples([SAMPLES[0] as Sample]) },
          compiledGraders: compiled,
          opts: { invoker, outDir: newTempRoot(), repeats },
        }),
      ).rejects.toThrow(/invalid repeats/);
    }
  });

  test("an errored trial counts as a failed trial in pass^k", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const counts = new Map<string, number>();
    const invoker: AgentInvoker = async ({ sample }) => {
      const n = counts.get(sample.id) ?? 0;
      counts.set(sample.id, n + 1);
      // Trial 1 passes; trial 2 blows up (twice — the noise retry reruns it
      // once and it must fail again to stay an error).
      if (n === 0) return { agentOutput: sample.expected_output ?? "", events: [] };
      throw new Error("provider exploded");
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "errtrial", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: { invoker, outDir, repeats: 2 },
    });
    const s = summary.samples[0];
    expect(s?.trials?.[0]?.passed).toBe(true);
    expect(s?.trials?.[1]?.passed).toBe(false);
    expect(s?.trials?.[1]?.error).toMatch(/provider exploded/);
    expect(s?.trials?.[1]?.retried).toBe(true);
    expect(s?.trialPassRate).toBeCloseTo(0.5);
    expect(summary.aggregates.passAtK).toBeCloseTo(1);
    expect(summary.aggregates.passHatK).toBeCloseTo(0);
    // The canonical sample (trial 1) did not error, so errorCount stays 0.
    expect(summary.aggregates.errorCount).toBe(0);
  });
});

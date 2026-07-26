/**
 * Evals Wave 4, cluster T — the runner half:
 *   C34 flake detection (samples whose repeat trials disagreed),
 *   C33 the reproducibility manifest (cliVersion / bunVersion / platform),
 *   C35 judge token metering (`aggregates.judgeUsage`).
 *
 * The judge cases ride `RunEvalOptions.judgeAdapter` — the injectable
 * judge-transport seam (mirroring the exam runner's) — so a REAL eval-judge
 * stack runs over a stub provider adapter with no network and no
 * process-global `mock.module`. Every artifact this file writes lives under
 * an `mkdtemp` root.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { aggregate } from "./aggregate";
import { type AgentInvoker, type SampleResult, runEval } from "./index";

const SPEC = `name: wave4-t
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
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-wave4t-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const EXACT_GRADERS = "graders:\n  - name: m\n    type: exact_match\n";
const SAMPLES: Sample[] = [
  { id: "stable_pass", input: "a", expected_output: "yes" },
  { id: "flip_flop", input: "b", expected_output: "yes" },
  { id: "stable_fail", input: "c", expected_output: "yes" },
];

/** Per-sample, per-trial outcome script (true = answer with the gold). */
function scriptedInvoker(script: Record<string, boolean[]>): AgentInvoker {
  const counts = new Map<string, number>();
  return async ({ sample }) => {
    const n = counts.get(sample.id) ?? 0;
    counts.set(sample.id, n + 1);
    const pass = script[sample.id]?.[n] ?? false;
    return { agentOutput: pass ? (sample.expected_output ?? "") : "wrong", events: [] };
  };
}

/** A minimal SampleResult carrying only what the flake fold reads. */
function resultWithTrialRate(sampleId: string, trialPassRate?: number): SampleResult {
  return {
    sampleId,
    sessionId: `sess_${sampleId}`,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 10,
    turns: 1,
    tokens: { input: 1, output: 1 },
    model: "claude-opus-4-7",
    agentOutput: "x",
    grades: { overall: { passed: true, score: 1, rationale: "ok" }, perGrader: [] },
    ...(trialPassRate !== undefined ? { trialPassRate } : {}),
  };
}

describe("C34 — flake detection", () => {
  test("aggregate flags ONLY trial pass rates strictly between 0 and 1", () => {
    const a = aggregate([
      resultWithTrialRate("all_pass", 1),
      resultWithTrialRate("all_fail", 0),
      resultWithTrialRate("half", 0.5),
      resultWithTrialRate("mostly_pass", 0.75),
      resultWithTrialRate("single_trial"),
    ]);
    expect(a.flaky).toBe(2);
    // Ranked by instability: 0.5 is maximally unstable, 0.75 less so.
    expect(a.flakySampleIds).toEqual(["half", "mostly_pass"]);
  });

  test("a run with no instability keeps the pre-C34 aggregate shape", () => {
    const a = aggregate([resultWithTrialRate("all_pass", 1), resultWithTrialRate("all_fail", 0)]);
    expect(a.flaky).toBeUndefined();
    expect(a.flakySampleIds).toBeUndefined();
    expect(Object.keys(a)).not.toContain("flaky");
  });

  test("repeats>1: the flip-flopping sample is marked in results.json and aggregated", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(EXACT_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "flaky", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: {
        invoker: scriptedInvoker({
          stable_pass: [true, true, true],
          flip_flop: [true, false, true],
          stable_fail: [false, false, false],
        }),
        outDir,
        repeats: 3,
      },
    });
    const byId = new Map(summary.samples.map((s) => [s.sampleId, s]));
    expect(byId.get("flip_flop")?.flaky).toBe(true);
    expect(byId.get("flip_flop")?.trialPassRate).toBeCloseTo(2 / 3, 10);
    expect(byId.get("stable_pass")?.flaky).toBeUndefined();
    expect(byId.get("stable_fail")?.flaky).toBeUndefined();
    expect(summary.aggregates.flaky).toBe(1);
    expect(summary.aggregates.flakySampleIds).toEqual(["flip_flop"]);

    // …and it survives to disk for eval-report/history to read.
    const persisted = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8")) as {
      aggregates: { flaky?: number; flakySampleIds?: string[] };
      samples: Array<{ sampleId: string; flaky?: boolean }>;
    };
    expect(persisted.aggregates.flaky).toBe(1);
    expect(persisted.samples.find((s) => s.sampleId === "flip_flop")?.flaky).toBe(true);
  });

  test("single-trial runs never mark a sample flaky", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(EXACT_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "flaky", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: {
        invoker: scriptedInvoker({ stable_pass: [true], flip_flop: [true], stable_fail: [false] }),
        outDir,
      },
    });
    expect(summary.aggregates.flaky).toBeUndefined();
    expect(summary.samples.every((s) => s.flaky === undefined)).toBe(true);
  });

  test("a flaky sample's verdict still counts — detection never quarantines silently", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(EXACT_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "flaky", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: {
        invoker: scriptedInvoker({
          stable_pass: [true, true],
          flip_flop: [true, false],
          stable_fail: [false, false],
        }),
        outDir,
        repeats: 2,
      },
    });
    // Trial 1 verdicts: pass, pass, fail → pass rate 2/3, unchanged by the flag.
    expect(summary.aggregates.passRate).toBeCloseTo(2 / 3, 10);
    expect(summary.aggregates.flaky).toBe(1);
  });
});

describe("C33 — reproducibility manifest", () => {
  test("run.json and results.json record bunVersion + platform, and cliVersion when supplied", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(EXACT_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "smoke", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: {
        invoker: scriptedInvoker({ stable_pass: [true] }),
        outDir,
        cliVersion: "9.9.9-test",
      },
    });
    expect(summary.config.cliVersion).toBe("9.9.9-test");
    expect(summary.config.bunVersion).toBe(Bun.version);
    expect(summary.config.platform).toBe(`${process.platform}-${process.arch}`);

    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      cliVersion?: string;
      bunVersion?: string;
      platform?: string;
    };
    expect(manifest).toMatchObject({
      cliVersion: "9.9.9-test",
      bunVersion: Bun.version,
      platform: `${process.platform}-${process.arch}`,
    });
  });

  test("cliVersion is absent (never guessed) when the launcher does not name itself", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(EXACT_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "smoke", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: { invoker: scriptedInvoker({ stable_pass: [true] }), outDir },
    });
    expect(summary.config.cliVersion).toBeUndefined();
    expect(summary.config.bunVersion).toBe(Bun.version);
  });
});

// -------- C35: judge token metering --------

/**
 * A judge-serving stub adapter that reports token usage exactly the way a
 * provider does: an initial `message_start` usage plus an output-token
 * update on `message_delta`.
 *
 * SENTINEL SAFETY (Wave-3 postmortem): the verdict never inspects the whole
 * prompt — the judge prompt wraps content in RANDOM hex markers, and a
 * whole-prompt match fires spuriously when the hex happens to contain the
 * needle. This stub answers the same way for every call.
 */
function meteringJudgeAdapter(usage: { input: number; output: number }): {
  adapter: ProviderAdapter;
  calls: () => number;
} {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      calls += 1;
      const tool = req.tools?.[0]?.name ?? "submit_score";
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start", usage: { input: usage.input, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_stub", name: tool, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              score: 5,
              rationale: "stub verdict",
              criterion_scores: { quality: 5 },
            }),
          },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield {
          kind: "message_delta",
          stopReason: "tool_use",
          usage: { input: usage.input, output: usage.output },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
  return { adapter, calls: () => calls };
}

const JUDGE_GRADERS = `graders:
  - name: quality
    type: llm_judge
    rubric:
      criteria:
        - name: quality
          description: is the answer good
          anchors:
            "1": terrible
            "2": bad
            "3": ok
            "4": good
            "5": great
      passing_score: 3
`;

describe("C35 — judge token metering", () => {
  test("every judge call's usage lands in aggregates.judgeUsage, keyed by judge model", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(JUDGE_GRADERS);
    const { adapter, calls } = meteringJudgeAdapter({ input: 120, output: 30 });
    const summary = await runEval({
      ir,
      dataset: { name: "smoke", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: {
        invoker: scriptedInvoker({
          stable_pass: [true],
          flip_flop: [true],
          stable_fail: [true],
        }),
        outDir,
        judgeModel: "openai/gpt-judge",
        judgeAdapter: adapter,
        readCalibrationFile: () => undefined,
      },
    });
    expect(calls()).toBe(3);
    expect(summary.aggregates.judgeUsage).toEqual({
      calls: 3,
      tokens: { input: 360, output: 90 },
      byModel: { "openai/gpt-judge": { calls: 3, input: 360, output: 90 } },
    });
    // …persisted, so the CLI's cost line and any later reader see it.
    const persisted = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8")) as {
      aggregates: { judgeUsage?: { calls: number } };
    };
    expect(persisted.aggregates.judgeUsage?.calls).toBe(3);
  });

  test("a judge panel meters per panelist model", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const panelGraders = JUDGE_GRADERS.replace(
      "    rubric:",
      "    judges: [judge-a, judge-b, judge-c]\n    rubric:",
    );
    const { compiled } = parseGradersConfig(panelGraders);
    const { adapter } = meteringJudgeAdapter({ input: 10, output: 4 });
    const summary = await runEval({
      ir,
      dataset: { name: "smoke", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: {
        invoker: scriptedInvoker({ stable_pass: [true] }),
        outDir,
        judgeAdapter: adapter,
        readCalibrationFile: () => undefined,
      },
    });
    const usage = summary.aggregates.judgeUsage;
    expect(usage?.calls).toBe(3);
    expect(Object.keys(usage?.byModel ?? {})).toEqual(["judge-a", "judge-b", "judge-c"]);
    expect(usage?.tokens).toEqual({ input: 30, output: 12 });
  });

  test("a judge-free run records no judgeUsage at all (byte-identical results.json)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(EXACT_GRADERS);
    const summary = await runEval({
      ir,
      dataset: { name: "smoke", samples: yieldSamples([SAMPLES[0] as Sample]) },
      compiledGraders: compiled,
      opts: { invoker: scriptedInvoker({ stable_pass: [true] }), outDir },
    });
    expect(summary.aggregates.judgeUsage).toBeUndefined();
    expect(readFileSync(join(outDir, "results.json"), "utf-8")).not.toContain("judgeUsage");
  });
});

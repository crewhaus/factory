/**
 * 0.6.0 §6.2 (PR 13) — PER-MODEL graders, thresholds and judges.
 *
 * The claims pinned here:
 *   - a `graders.yaml` `per_model:` map binds the samples the CHEAP arm
 *     served to the strong judge, at that arm's own cut and weight, while an
 *     unrouted run keeps grading with the base judge;
 *   - judge spend is attributed to the (judge model, agent arm) pair;
 *   - judge calibration resolves pair → spec → default;
 *   - an unresolvable `$profile` judge ref fails at RUN START, not on
 *     whichever sample happens to route to that arm.
 *
 * `@crewhaus/eval-judge` is stubbed (process-global `mock.module`, so this
 * lives in its own file) to record the model and rubric each grader was bound
 * to, and to report a metered usage line — no network, no provider.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { GradeResult } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";

/** One `createJudgeGrader` binding: the model, and the rubric's own cut. */
type Binding = { model?: string; passingScore?: number };
const bindings: Binding[] = [];

const realEvalJudge = { ...(await import("@crewhaus/eval-judge")) };

mock.module("@crewhaus/eval-judge", () => ({
  ...realEvalJudge,
  loadRubric: (input: unknown) => input,
  createJudgeGrader: (
    rubric: unknown,
    opts: { model?: string; onUsage?: (u: Record<string, unknown>) => void } = {},
  ) => {
    const binding: Binding = {
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(typeof (rubric as { passing_score?: unknown }).passing_score === "number"
        ? { passingScore: (rubric as { passing_score: number }).passing_score }
        : {}),
    };
    bindings.push(binding);
    return async (): Promise<GradeResult> => {
      opts.onUsage?.({ model: opts.model ?? "(default)", input: 10, output: 2 });
      return { passed: true, score: 1, rationale: `judged with ${opts.model ?? "(default)"}` };
    };
  },
}));

const { runEval } = await import("./index");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-per-model-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("@crewhaus/eval-judge", () => realEvalJudge);
});

const POOL_SPEC = `name: hybrid-eval
target: cli
models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
  strong:
    model: claude-opus-4-7
    tags: [strong]
agent:
  model: $strong
  instructions: spec instructions
  model_pool:
    policy: learned
    candidates:
      - model: $fast
      - model: $strong
`;

function irOf(spec: string): IrV0 {
  const ir: IrNode = lower(parseSpec(spec));
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const SAMPLES: Sample[] = [{ id: "a", input: "first", expected_output: "answer for first" }];

/** A judge grader whose rubric declares no cut, plus a `per_model:` map. */
function gradersYaml(perModel: string): string {
  return `graders:
  - name: quality
    type: llm_judge
    model: claude-sonnet-5
    rubric:
      criteria:
        - name: q
          description: is it good
          anchors:
            "1": bad
            "2": meh
            "3": ok
            "4": good
            "5": great
${perModel}
`;
}

/** A chatLoop stub that publishes the route + response a routed turn would. */
function routingChatLoop(servedModel: string, profile?: string) {
  return async (opts: Record<string, unknown>) => {
    const ctx = opts["runContext"] as
      | { eventBus: { envelope(): Record<string, unknown>; publish(e: unknown): void } }
      | undefined;
    ctx?.eventBus.publish({
      ...ctx.eventBus.envelope(),
      kind: "model_route",
      routeKey: "hard",
      model: servedModel,
      specModel: servedModel,
      ...(profile !== undefined ? { profile } : {}),
      policy: "learned",
      reason: "exploit",
    });
    ctx?.eventBus.publish({
      ...ctx.eventBus.envelope(),
      kind: "model_response",
      model: servedModel,
      ...(profile !== undefined ? { profile } : {}),
      stopReason: "end_turn",
      usage: { input: 4, output: 2 },
      durationMs: 3,
    });
    const seed = opts["seedMessages"] as Array<{ content: string }>;
    return `answer for ${seed[seed.length - 1]?.content}`;
  };
}

const noCalibration = { readCalibrationFile: () => undefined } as const;

describe("graders.yaml per_model", () => {
  test("binds the $fast arm's samples to the strong judge, cut and weight", async () => {
    bindings.length = 0;
    const outDir = newTempRoot();
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $strong
        passing_score: 4
        weight: 2`),
    ).compiled;

    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders,
      opts: {
        outDir,
        cwd: newTempRoot(),
        concurrency: 1,
        seed: 3,
        routing: "as-declared",
        chatLoop: routingChatLoop("claude-haiku-4-5", "fast") as never,
        ...noCalibration,
      },
    });

    // One set per arm is built up front (base, then the roster in declaration
    // order): the BASE set binds the grader's own judge, the `fast` arm's set
    // binds the profile the map names — resolved through the roster to its
    // model — and `strong`, which the map does not name, keeps the base judge.
    expect(bindings.map((b) => b.model)).toEqual([
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-sonnet-5",
    ]);
    // …at that arm's declared cut (no other set carries one).
    expect(bindings[0]?.passingScore).toBeUndefined();
    expect(bindings[1]?.passingScore).toBe(4);
    expect(bindings[2]?.passingScore).toBeUndefined();
    // The sample really was graded by the arm's set.
    expect(summary.samples[0]?.grades.perGrader[0]?.rationale).toBe("judged with claude-opus-4-7");
    // …and the manifest says which model grades which arm, refs resolved.
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeSampling[0].perModel).toEqual({
      fast: { judge: "claude-opus-4-7", passingScore: 4, weight: 2 },
    });
  });

  test("judge spend is attributed to the (judge model, agent arm) pair", async () => {
    bindings.length = 0;
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      fast:
        judge: $strong`),
    ).compiled;

    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders,
      opts: {
        outDir: newTempRoot(),
        cwd: newTempRoot(),
        concurrency: 1,
        routing: "as-declared",
        chatLoop: routingChatLoop("claude-haiku-4-5", "fast") as never,
        ...noCalibration,
      },
    });

    const usage = summary.aggregates.judgeUsage;
    // byModel is unchanged — it is what the cost line prices with.
    expect(usage?.byModel).toEqual({
      "claude-opus-4-7": { calls: 1, input: 10, output: 2 },
    });
    expect(usage?.byPair).toEqual([
      { judgeModel: "claude-opus-4-7", arm: "fast", calls: 1, input: 10, output: 2 },
    ]);
  });

  test("an unrouted run keeps the base judge and a byte-identical judgeUsage", async () => {
    bindings.length = 0;
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $strong`),
    ).compiled;

    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders,
      opts: {
        outDir: newTempRoot(),
        cwd: newTempRoot(),
        concurrency: 1,
        chatLoop: routingChatLoop("claude-opus-4-7") as never,
        ...noCalibration,
      },
    });

    expect(bindings.map((b) => b.model)).toEqual(["claude-sonnet-5"]);
    expect(summary.aggregates.judgeUsage?.byPair).toBeUndefined();
    expect(summary.samples[0]?.grades.perGrader[0]?.rationale).toBe("judged with claude-sonnet-5");
  });

  test("a candidate:-pinned run resolves the arm from the pin, not the events", async () => {
    bindings.length = 0;
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $strong`),
    ).compiled;

    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders,
      opts: {
        outDir: newTempRoot(),
        cwd: newTempRoot(),
        concurrency: 1,
        routing: "candidate:$fast",
        // A pinned run routes nothing: no `model_route` line, and the
        // `model_response` carries no `profile` (attribution is gated on
        // `plan.fromPool`, and a pin builds no pool). The events can therefore
        // only ever name the MODEL STRING — never the `fast` profile the
        // `per_model:` map is keyed on — which is why the pin has to win.
        chatLoop: (async (opts: Record<string, unknown>) => {
          const ctx = opts["runContext"] as
            | { eventBus: { envelope(): Record<string, unknown>; publish(e: unknown): void } }
            | undefined;
          ctx?.eventBus.publish({
            ...ctx.eventBus.envelope(),
            kind: "model_response",
            model: "claude-haiku-4-5",
            specModel: "claude-haiku-4-5",
            stopReason: "end_turn",
            usage: { input: 4, output: 2 },
            durationMs: 3,
          });
          const seed = opts["seedMessages"] as Array<{ content: string }>;
          return `answer for ${seed[seed.length - 1]?.content}`;
        }) as never,
        ...noCalibration,
      },
    });

    expect(summary.samples[0]?.grades.perGrader[0]?.rationale).toBe("judged with claude-opus-4-7");
    // …and no THIRD set was built for the model-string arm the events name.
    expect(bindings.map((b) => b.model)).toEqual(["claude-sonnet-5", "claude-opus-4-7"]);
  });

  test("an unresolvable $profile judge ref fails at run start", async () => {
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $nonesuch`),
    ).compiled;

    await expect(
      runEval({
        ir: irOf(POOL_SPEC),
        dataset: { name: "d", samples: yieldSamples(SAMPLES) },
        compiledGraders,
        opts: {
          outDir: newTempRoot(),
          cwd: newTempRoot(),
          concurrency: 1,
          routing: "as-declared",
          chatLoop: routingChatLoop("claude-haiku-4-5", "fast") as never,
          ...noCalibration,
        },
      }),
    ).rejects.toThrow(/names judge "\$nonesuch".*declared: \$fast/s);
  });

  test("a per_model key naming no roster arm warns loudly", async () => {
    // A typo (or a profile renamed in the spec but not in graders.yaml) used
    // to be silently inert: every sample kept the base judge at the base cut
    // while the operator believed the cheap arm was being checked.
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fst:
        judge: $strong`),
    ).compiled;
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runEval({
        ir: irOf(POOL_SPEC),
        dataset: { name: "d", samples: yieldSamples(SAMPLES) },
        compiledGraders,
        opts: {
          outDir: newTempRoot(),
          cwd: newTempRoot(),
          concurrency: 1,
          routing: "as-declared",
          chatLoop: routingChatLoop("claude-haiku-4-5", "fast") as never,
          ...noCalibration,
        },
      });
    } finally {
      process.stderr.write = realWrite;
    }
    const stderr = written.join("");
    expect(stderr).toContain("`per_model:` names arm(s) fst");
    expect(stderr).toContain("known arms: fast, strong");
  });

  test("a per_model key naming a real roster arm warns about nothing", async () => {
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $strong`),
    ).compiled;
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runEval({
        ir: irOf(POOL_SPEC),
        dataset: { name: "d", samples: yieldSamples(SAMPLES) },
        compiledGraders,
        opts: {
          outDir: newTempRoot(),
          cwd: newTempRoot(),
          concurrency: 1,
          routing: "as-declared",
          chatLoop: routingChatLoop("claude-haiku-4-5", "fast") as never,
          ...noCalibration,
        },
      });
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).not.toContain("names arm(s)");
  });

  test("a static run declaring per_model warns that no arm can resolve it", async () => {
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $strong`),
    ).compiled;
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runEval({
        ir: irOf(POOL_SPEC),
        dataset: { name: "d", samples: yieldSamples(SAMPLES) },
        compiledGraders,
        opts: {
          outDir: newTempRoot(),
          cwd: newTempRoot(),
          concurrency: 1,
          chatLoop: routingChatLoop("claude-opus-4-7") as never,
          ...noCalibration,
        },
      });
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).toContain("declares `per_model:` judge overrides");
  });
});

describe("judge calibration by (arm, judge) pair", () => {
  const CALIBRATION = JSON.stringify({
    version: 1,
    calibrations: {
      "hybrid-eval": {
        minScore: 0.5,
        correlation: 0.4,
        bias: 0,
        pairCount: 8,
        updatedAt: "2026-09-01T00:00:00.000Z",
        byPair: {
          "fast::claude-opus-4-7": {
            arm: "fast",
            minScore: 0.75,
            correlation: 0.8,
            bias: 0,
            pairCount: 5,
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      },
    },
  });

  test("the pair cut wins for the arm it names; the spec cut is the fallback", async () => {
    bindings.length = 0;
    const outDir = newTempRoot();
    const compiledGraders = parseGradersConfig(
      gradersYaml(`    per_model:
      $fast:
        judge: $strong`),
    ).compiled;

    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders,
      opts: {
        outDir,
        cwd: newTempRoot(),
        concurrency: 1,
        routing: "as-declared",
        chatLoop: routingChatLoop("claude-haiku-4-5", "fast") as never,
        readCalibrationFile: () => CALIBRATION,
      },
    });

    // Base set: the spec-level cut 0.5 → 1 + 0.5·4 = 3.
    expect(bindings[0]?.passingScore).toBe(3);
    // `fast` graded by claude-opus-4-7: the pair cut 0.75 → 1 + 0.75·4 = 4.
    expect(bindings[1]?.passingScore).toBe(4);
    // `strong` names no pair, so it falls back to the spec cut.
    expect(bindings[2]?.passingScore).toBe(3);
    // Only the pair application is recorded beside the run-level one.
    const applied = summary.config.judgeCalibration?.applied ?? [];
    expect(applied).toHaveLength(2);
    expect(applied[1]).toMatchObject({
      grader: "quality",
      arm: "fast",
      pairKey: "fast::claude-opus-4-7",
      minScore: 0.75,
      passingScore: 4,
    });
  });

  test("an unrouted run resolves the spec cut exactly as before", async () => {
    bindings.length = 0;
    const summary = await runEval({
      ir: irOf(POOL_SPEC),
      dataset: { name: "d", samples: yieldSamples(SAMPLES) },
      compiledGraders: parseGradersConfig(gradersYaml("")).compiled,
      opts: {
        outDir: newTempRoot(),
        cwd: newTempRoot(),
        concurrency: 1,
        chatLoop: routingChatLoop("claude-opus-4-7") as never,
        readCalibrationFile: () => CALIBRATION,
      },
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.passingScore).toBe(3);
    const applied = summary.config.judgeCalibration?.applied ?? [];
    expect(applied).toHaveLength(1);
    expect(applied[0]?.arm).toBeUndefined();
    expect(applied[0]?.pairKey).toBeUndefined();
  });
});

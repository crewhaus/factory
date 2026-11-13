/**
 * Criteria in the runner: a scoped grader skips the cases outside its scope
 * without being called, an observing grader records its verdict without
 * deciding the case, a judge with no credentials leaves its case not
 * measured, and a regrade grades a recorded run's answers without running
 * the agent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { lower } from "@crewhaus/compiler";
import { ProviderAuthError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type CompiledGrader,
  type GradeResult,
  type Grader,
  parseGradersConfig,
  runCriteriaRecord,
} from "@crewhaus/eval-grader";
import type { IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, type RunEvalOptions, createRegrade, runEval } from "./index";
import { runSample } from "./run-sample";

const TMP: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-criteria-runner-"));
  TMP.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

const SPEC = "name: criteria\ntarget: cli\nagent:\n  model: m\n  instructions: Answer.\n";
const ir = (): IrV0 => {
  const lowered = lower(parseSpec(SPEC));
  if (lowered.target !== "cli") throw new Error("expected cli");
  return lowered;
};
async function* yieldSamples(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}
const SAMPLES: Sample[] = [
  { id: "c1", input: "q1", expected_output: "a1", metadata: { family: "csv" } },
  { id: "j1", input: "q2", expected_output: "a2", metadata: { family: "json" } },
  { id: "x1", input: "q3", expected_output: "a3", metadata: { family: "xml" } },
];

/** An invoker that answers each case's expected output, and counts its calls. */
function echoInvoker(): { invoker: AgentInvoker; calls: () => number } {
  let calls = 0;
  return {
    invoker: async ({ sample }) => {
      calls += 1;
      return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
    },
    calls: () => calls,
  };
}

/** A grader that counts its calls and passes. */
function counting(result: GradeResult = { passed: true, score: 1, rationale: "ok" }): {
  grader: Grader;
  calls: () => number;
} {
  let calls = 0;
  return {
    grader: async () => {
      calls += 1;
      return result;
    },
    calls: () => calls,
  };
}

const run = (
  compiledGraders: ReadonlyArray<CompiledGrader>,
  opts: RunEvalOptions,
  samples: ReadonlyArray<Sample> = SAMPLES,
) =>
  runEval({
    ir: ir(),
    dataset: { name: "d", samples: yieldSamples(samples) },
    compiledGraders,
    opts: { readCalibrationFile: () => undefined, ...opts },
  });

const GRADERS = `graders:
  - name: exact
    type: exact_match
criteria:
  - id: json-only
    scope: { metadata: { family: [json] } }
    measured_by: [exact]
`;

describe("scope and observation", () => {
  test("an out-of-scope grader is never called and records skipped", async () => {
    const { compiled } = parseGradersConfig(GRADERS);
    const count = counting();
    const graders = compiled.map((g) => ({ ...g, grader: count.grader }));
    const summary = await run(graders, { invoker: echoInvoker().invoker, outDir: tempDir() });
    expect(count.calls()).toBe(1);
    const statuses = summary.samples.map((s) => [s.sampleId, s.grades.perGrader[0]?.status]);
    expect(statuses).toEqual([
      ["c1", "skipped"],
      ["j1", undefined],
      ["x1", "skipped"],
    ]);
    const skipped = summary.samples[0]?.grades.perGrader[0];
    expect(skipped?.statusReason).toBe("out_of_scope");
    expect(skipped?.rationale).toBe("outside criterion json-only's cases");
    expect(summary.aggregates.skippedSampleIds).toEqual(["c1", "x1"]);
  });

  test("an observing grader keeps its verdict and leaves the sample's", async () => {
    const { compiled } = parseGradersConfig(`graders:
  - name: exact
    type: exact_match
criteria:
  - id: watch
    mode: observe
    measured_by: [exact]
`);
    const wrong: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.id === "j1" ? "nope" : (sample.expected_output ?? ""),
    });
    const summary = await run(compiled, { invoker: wrong, outDir: tempDir() });
    const j1 = summary.samples.find((s) => s.sampleId === "j1");
    expect(j1?.grades.perGrader[0]).toMatchObject({ status: "observing", passed: false, score: 0 });
    expect(summary.samples.find((s) => s.sampleId === "c1")?.grades.perGrader[0]).toMatchObject({
      status: "observing",
      passed: true,
      score: 1,
    });
    expect(summary.aggregates.observing?.["exact"]).toEqual({
      graded: 3,
      wouldFail: 1,
      wouldFailSampleIds: ["j1"],
    });
  });

  test("a grade that is not measured keeps its status under observation", async () => {
    const { compiled } = parseGradersConfig(`graders:
  - name: exact
    type: exact_match
criteria:
  - id: watch
    mode: observe
    measured_by: [exact]
`);
    const unmeasured: Grader = async () => ({
      passed: false,
      score: 0,
      rationale: "no proof bundle",
      status: "not_measured",
      statusReason: "no_proof_bundle",
    });
    const summary = await run(
      compiled.map((g) => ({ ...g, grader: unmeasured })),
      { invoker: echoInvoker().invoker, outDir: tempDir() },
    );
    expect(summary.samples.every((s) => s.grades.perGrader[0]?.status === "not_measured")).toBe(
      true,
    );
  });
});

describe("a judge with no credentials", () => {
  const sample: Sample = { id: "a", input: "q", expected_output: "a" };
  const entry = (grader: Grader) => [{ name: "judge", grader }];

  test("records not measured with its reason, no grader error, and is called once", async () => {
    let calls = 0;
    const judge: Grader = async () => {
      calls += 1;
      throw new ProviderAuthError("anthropic", "no Anthropic credentials found");
    };
    const result = await runSample({
      sample,
      invoker: echoInvoker().invoker,
      graders: entry(judge),
      outDir: tempDir(),
      model: "m",
    });
    expect(calls).toBe(1);
    expect(result.graderError).toBeUndefined();
    expect(result.grades.perGrader[0]).toMatchObject({
      status: "not_measured",
      statusReason: "no_judge_credentials",
      passed: false,
    });
    expect(result.grades.perGrader[0]?.rationale).toContain("no judge credentials:");
    expect(result.grades.overall.status).toBe("not_measured");
    expect(result.grades.overall.statusReason).toBe("no_judge_credentials");
  });

  test("the run does not retry it, and leaves the case out of the pass rate", async () => {
    const judge: Grader = async () => {
      throw new ProviderAuthError("anthropic", "none");
    };
    const live = echoInvoker();
    const summary = await run([{ name: "judge", grader: judge, weight: 1 }], {
      invoker: live.invoker,
      outDir: tempDir(),
    });
    expect(live.calls()).toBe(3);
    expect(summary.aggregates.notMeasured).toBe(3);
    expect(summary.samples.every((s) => s.retried === undefined)).toBe(true);
  });

  test("any other throw is still a failed grade and a grader error", async () => {
    const live = echoInvoker();
    const summary = await run(
      [
        {
          name: "judge",
          weight: 1,
          grader: async () => {
            throw new Error("judge 429");
          },
        },
      ],
      { invoker: live.invoker, outDir: tempDir() },
      [sample],
    );
    const s = summary.samples[0];
    expect(s?.grades.perGrader[0]?.status).toBeUndefined();
    expect(s?.grades.perGrader[0]?.rationale).toBe("grader threw: judge 429");
    expect(s?.graderError).toContain("judge 429");
    // The one noise retry runs the case again.
    expect(live.calls()).toBe(2);
  });
});

describe("an observing grader never decides its case, whatever it records", () => {
  const WATCHED = `graders:
  - name: exact
    type: exact_match
  - name: watch
    type: contains
    substring: a
criteria:
  - id: watching
    mode: observe
    measured_by: [watch]
`;
  const withWatch = (watch: Grader) =>
    parseGradersConfig(WATCHED).compiled.map((g) =>
      g.name === "watch" ? { ...g, grader: watch } : g,
    );
  const expectDecidedByExact = (
    summary: Awaited<ReturnType<typeof run>>,
    agentCalls: number,
  ): void => {
    expect(agentCalls).toBe(3);
    for (const s of summary.samples) {
      expect(s.grades.overall.status).toBeUndefined();
      expect(s.grades.overall.passed).toBe(true);
      expect(s.graderError).toBeUndefined();
      expect(s.retried).toBeUndefined();
    }
    expect(summary.aggregates.passRate).toBe(1);
    expect(summary.aggregates.notMeasured ?? 0).toBe(0);
  };

  test("a judge with no credentials leaves the enforced verdict standing", async () => {
    const live = echoInvoker();
    const summary = await run(
      withWatch(async () => {
        throw new ProviderAuthError("anthropic", "no Anthropic credentials found");
      }),
      { invoker: live.invoker, outDir: tempDir() },
    );
    expectDecidedByExact(summary, live.calls());
    expect(summary.samples[0]?.grades.perGrader[1]).toMatchObject({
      name: "watch",
      status: "not_measured",
      statusReason: "no_judge_credentials",
    });
  });

  test("any other throw is not a grader error and does not run the agent again", async () => {
    const live = echoInvoker();
    const summary = await run(
      withWatch(async () => {
        throw new Error("judge 429");
      }),
      { invoker: live.invoker, outDir: tempDir() },
    );
    expectDecidedByExact(summary, live.calls());
    const watch = summary.samples[0]?.grades.perGrader[1];
    expect(watch).toMatchObject({ name: "watch", status: "not_measured" });
    expect(watch?.statusReason).toBeUndefined();
    expect(watch?.rationale).toBe("grader threw: judge 429");
  });

  test("a grader a regrade cannot feed leaves the enforced verdict standing", async () => {
    const source = await run(
      parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n").compiled,
      { invoker: echoInvoker().invoker, outDir: tempDir() },
    );
    const plugin = counting();
    const { compiled } = parseGradersConfig(`graders:
  - name: exact
    type: exact_match
  - name: mine
    type: registry
    grader: mine.check
criteria:
  - id: watching
    mode: observe
    measured_by: [mine]
`);
    const summary = await run(compiled, {
      regrade: createRegrade({ sourceDir: source.outDir, purpose: "regrade", samples: SAMPLES }),
      outDir: tempDir(),
      graderRegistry: { lookup: () => plugin.grader, metaOf: () => ({ kind: "custom" }) },
    });
    expect(plugin.calls()).toBe(0);
    expectDecidedByExact(summary, 3);
    expect(summary.samples[0]?.grades.perGrader[1]).toMatchObject({
      name: "mine",
      status: "not_measured",
      statusReason: "not_regradable",
    });
  });
});

/** A stub judge transport that always scores 5, counting calls. */
function judgeAdapter(): { adapter: ProviderAdapter; calls: () => number } {
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
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu", name: tool, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              score: 5,
              rationale: "fine",
              criterion_scores: { q: 5 },
            }),
          },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 1, output: 1 } };
        yield { kind: "message_stop" };
      })();
    },
  };
  return { adapter, calls: () => calls };
}

const JUDGED = (mode: "enforce" | "observe") => `graders:
  - name: exact
    type: exact_match
  - name: judge
    type: llm_judge
    rubric:
      criteria:
        - name: q
          description: is it right
          anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }
      passing_score: 3
criteria:
  - id: quality
    mode: ${mode}
    measured_by: [judge]
`;

/** A live source run with its criteria recorded. */
async function sourceRun(graders = JUDGED("enforce"), samples: ReadonlyArray<Sample> = SAMPLES) {
  const { compiled, config } = parseGradersConfig(graders);
  const judge = judgeAdapter();
  const criteria = runCriteriaRecord(config);
  const summary = await run(
    compiled,
    {
      invoker: echoInvoker().invoker,
      outDir: tempDir(),
      judgeAdapter: judge.adapter,
      judgeModel: "judge-model",
      datasetHash: "h1",
      ...(criteria !== undefined ? { criteria } : {}),
    },
    samples,
  );
  return { summary, judgeCalls: judge.calls() };
}

describe("regrade", () => {
  test("grades the recorded answers without running the agent, and records what it is", async () => {
    const source = await sourceRun();
    const { compiled, config } = parseGradersConfig(JUDGED("enforce"));
    const plan = createRegrade({
      sourceDir: source.summary.outDir,
      purpose: "regrade",
      samples: SAMPLES,
      datasetHash: "h1",
    });
    const judge = judgeAdapter();
    const criteria = runCriteriaRecord(config);
    const summary = await run(compiled, {
      regrade: plan,
      outDir: tempDir(),
      judgeAdapter: judge.adapter,
      judgeModel: "judge-model",
      ...(criteria !== undefined ? { criteria } : {}),
    });
    expect(summary.samples.map((s) => s.agentOutput)).toEqual(["a1", "a2", "a3"]);
    expect(summary.config.purpose).toBe("regrade");
    expect(summary.config.regradeOf).toBe(source.summary.runId);
    const runJson = JSON.parse(readFileSync(join(summary.outDir, "run.json"), "utf8"));
    expect(runJson.purpose).toBe("regrade");
    expect(runJson.regradeOf).toBe(source.summary.runId);
    expect(summary.aggregates.passRate).toBe(1);
  });

  test("moving a criterion from enforcing to observing reuses the recorded grades: no judge call", async () => {
    const source = await sourceRun();
    expect(source.judgeCalls).toBe(3);
    const { compiled, config } = parseGradersConfig(JUDGED("observe"));
    const criteria = runCriteriaRecord(config);
    const judge = judgeAdapter();
    const summary = await run(compiled, {
      regrade: createRegrade({
        sourceDir: source.summary.outDir,
        purpose: "preview",
        samples: SAMPLES,
        datasetHash: "h1",
        judgeModel: "judge-model",
        ...(criteria !== undefined ? { criteria } : {}),
      }),
      outDir: tempDir(),
      judgeAdapter: judge.adapter,
      judgeModel: "judge-model",
      ...(criteria !== undefined ? { criteria } : {}),
    });
    expect(judge.calls()).toBe(0);
    const judged = summary.samples.map((s) => s.grades.perGrader.find((g) => g.name === "judge"));
    expect(judged.every((g) => g?.status === "observing" && g.passed)).toBe(true);
  });

  test("another run-level judge model is graded again, even with an unchanged spec", async () => {
    const source = await sourceRun();
    const { compiled, config } = parseGradersConfig(JUDGED("observe"));
    const criteria = runCriteriaRecord(config);
    const judge = judgeAdapter();
    await run(compiled, {
      regrade: createRegrade({
        sourceDir: source.summary.outDir,
        purpose: "preview",
        samples: SAMPLES,
        datasetHash: "h1",
        judgeModel: "another-judge",
        ...(criteria !== undefined ? { criteria } : {}),
      }),
      outDir: tempDir(),
      judgeAdapter: judge.adapter,
      judgeModel: "another-judge",
    });
    expect(judge.calls()).toBe(3);
  });

  test("a judge whose cut came from a calibration is graded again", async () => {
    const calibration = JSON.stringify({
      version: 1,
      calibrations: {
        default: {
          minScore: 0.5,
          correlation: 0.7,
          bias: 0,
          pairCount: 10,
          updatedAt: "2026-07-01T00:00:00Z",
        },
      },
    });
    const uncut = (mode: "enforce" | "observe") =>
      JUDGED(mode).replace("      passing_score: 3\n", "");
    const first = parseGradersConfig(uncut("enforce"));
    const firstCriteria = runCriteriaRecord(first.config);
    const src = await run(first.compiled, {
      invoker: echoInvoker().invoker,
      outDir: tempDir(),
      judgeAdapter: judgeAdapter().adapter,
      judgeModel: "judge-model",
      datasetHash: "h1",
      readCalibrationFile: () => calibration,
      ...(firstCriteria !== undefined ? { criteria: firstCriteria } : {}),
    });
    expect(src.config.judgeCalibration?.applied.map((a) => a.grader)).toEqual(["judge"]);
    const next = parseGradersConfig(uncut("observe"));
    const criteria = runCriteriaRecord(next.config);
    const judge = judgeAdapter();
    await run(next.compiled, {
      regrade: createRegrade({
        sourceDir: src.outDir,
        purpose: "preview",
        samples: SAMPLES,
        datasetHash: "h1",
        judgeModel: "judge-model",
        ...(criteria !== undefined ? { criteria } : {}),
      }),
      outDir: tempDir(),
      judgeAdapter: judge.adapter,
      judgeModel: "judge-model",
      readCalibrationFile: () => calibration,
    });
    expect(judge.calls()).toBe(3);
  });

  test("a changed judge spec is graded again", async () => {
    const source = await sourceRun();
    const changed = JUDGED("enforce").replace("passing_score: 3", "passing_score: 4");
    const { compiled, config } = parseGradersConfig(changed);
    const criteria = runCriteriaRecord(config);
    const judge = judgeAdapter();
    await run(compiled, {
      regrade: createRegrade({
        sourceDir: source.summary.outDir,
        purpose: "preview",
        samples: SAMPLES,
        datasetHash: "h1",
        judgeModel: "judge-model",
        ...(criteria !== undefined ? { criteria } : {}),
      }),
      outDir: tempDir(),
      judgeAdapter: judge.adapter,
      judgeModel: "judge-model",
    });
    expect(judge.calls()).toBe(3);
  });

  const exactOnly = parseGradersConfig(
    "graders:\n  - name: exact\n    type: exact_match\n",
  ).compiled;
  const notRegradable = (
    summary: Awaited<ReturnType<typeof run>>,
    id: string,
  ): string | undefined => {
    const s = summary.samples.find((x) => x.sampleId === id);
    const g = s?.grades.perGrader[0];
    expect(g?.status).toBe("not_measured");
    expect(g?.statusReason).toBe("not_regradable");
    expect(s?.grades.overall.status).toBe("not_measured");
    return g?.rationale;
  };

  test("each reason a case cannot be regraded leaves it not measured", async () => {
    const errored: AgentInvoker = async ({ sample }) => {
      if (sample.id === "x1") throw new Error("agent crashed");
      return { agentOutput: sample.expected_output ?? "" };
    };
    const src = await run(exactOnly, {
      invoker: errored,
      outDir: tempDir(),
      retryErrors: false,
      datasetHash: "h1",
    });
    // A case the source never ran, a case that changed, a case whose files are gone.
    rmSync(join(src.outDir, "c1"), { recursive: true, force: true });
    const now: Sample[] = [
      { ...(SAMPLES[0] as Sample) },
      { ...(SAMPLES[1] as Sample), expected_output: "changed" },
      { ...(SAMPLES[2] as Sample) },
      { id: "new", input: "q4", expected_output: "a4" },
    ];
    const summary = await run(
      exactOnly,
      {
        regrade: createRegrade({
          sourceDir: src.outDir,
          purpose: "regrade",
          samples: now,
          datasetHash: "h2",
        }),
        outDir: tempDir(),
      },
      now,
    );
    expect(notRegradable(summary, "c1")).toContain("kept no files for this case");
    expect(notRegradable(summary, "j1")).toContain("the case changed since the source run");
    expect(notRegradable(summary, "x1")).toContain("the recorded answer errored");
    expect(notRegradable(summary, "new")).toContain("holds no answer for this case");
  });

  test("with no case digests, a moved dataset makes every case not regradable", async () => {
    const src = await run(exactOnly, {
      invoker: echoInvoker().invoker,
      outDir: tempDir(),
      datasetHash: "h1",
    });
    unlinkSync(join(src.outDir, "cases.json"));
    const moved = await run(exactOnly, {
      regrade: createRegrade({
        sourceDir: src.outDir,
        purpose: "regrade",
        samples: SAMPLES,
        datasetHash: "h2",
      }),
      outDir: tempDir(),
    });
    expect(notRegradable(moved, "c1")).toContain("recorded no digest");
    const same = await run(exactOnly, {
      regrade: createRegrade({
        sourceDir: src.outDir,
        purpose: "regrade",
        samples: SAMPLES,
        datasetHash: "h1",
      }),
      outDir: tempDir(),
    });
    expect(same.samples.every((s) => s.grades.overall.status === undefined)).toBe(true);
  });

  test("a recorded file that leads outside the source run is refused", async () => {
    const src = await run(exactOnly, { invoker: echoInvoker().invoker, outDir: tempDir() });
    const outside = join(tempDir(), "elsewhere.jsonl");
    writeFileSync(outside, "");
    const transcript = join(src.outDir, "j1", "transcript.jsonl");
    unlinkSync(transcript);
    symlinkSync(outside, transcript);
    const linkedDir = join(tempDir(), "linked");
    mkdirSync(linkedDir);
    rmSync(join(src.outDir, "x1"), { recursive: true, force: true });
    symlinkSync(linkedDir, join(src.outDir, "x1"));
    const summary = await run(exactOnly, {
      regrade: createRegrade({ sourceDir: src.outDir, purpose: "regrade", samples: SAMPLES }),
      outDir: tempDir(),
    });
    expect(notRegradable(summary, "j1")).toContain("outside the source run directory");
    expect(notRegradable(summary, "x1")).toContain("outside the source run directory");
    expect(summary.samples.find((s) => s.sampleId === "c1")?.grades.overall.status).toBeUndefined();
  });

  test("a grader a recorded run cannot feed is not called", async () => {
    const src = await run(exactOnly, { invoker: echoInvoker().invoker, outDir: tempDir() });
    const plugin = counting();
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: mine\n    type: registry\n    grader: mine.check\n",
    );
    const summary = await run(compiled, {
      regrade: createRegrade({ sourceDir: src.outDir, purpose: "regrade", samples: SAMPLES }),
      outDir: tempDir(),
      graderRegistry: {
        lookup: () => plugin.grader,
        metaOf: () => ({ kind: "custom" }),
      },
    });
    expect(plugin.calls()).toBe(0);
    expect(notRegradable(summary, "c1")).toContain(
      'grader "mine" reads more than a recorded run keeps',
    );
  });

  test("a run with more than one trial per case is refused, naming the limit", async () => {
    const src = await run(exactOnly, {
      invoker: echoInvoker().invoker,
      outDir: tempDir(),
      repeats: 3,
    });
    expect(() =>
      createRegrade({ sourceDir: src.outDir, purpose: "regrade", samples: SAMPLES }),
    ).toThrow(/ran 3 trials per case — a regrade grades one recorded answer per case/);
  });

  test("a regrade cannot be combined with what would stand in for the recorded answers", async () => {
    const src = await run(exactOnly, { invoker: echoInvoker().invoker, outDir: tempDir() });
    const plan = createRegrade({ sourceDir: src.outDir, purpose: "regrade", samples: SAMPLES });
    await expect(
      run(exactOnly, { regrade: plan, invoker: echoInvoker().invoker, outDir: tempDir() }),
    ).rejects.toThrow(/cannot be combined with a caller-supplied invoker/);
    await expect(
      run(exactOnly, { regrade: plan, resume: true, outDir: tempDir() }),
    ).rejects.toThrow(/cannot be combined with resume/);
    await expect(run(exactOnly, { regrade: plan, repeats: 2, outDir: tempDir() })).rejects.toThrow(
      /more than one trial/,
    );
  });
});

describe("a run without criteria or a regrade", () => {
  /** results.json with the fields a clock, a path or a host decides set to fixed values. */
  const normalized = (text: string): string =>
    JSON.stringify(
      JSON.parse(text, (key, value) => {
        if (
          ["startedAt", "endedAt", "outDir", "sessionId", "bunVersion", "platform"].includes(key)
        ) {
          return "<x>";
        }
        if (["latencyMs", "p50LatencyMs", "p95LatencyMs"].includes(key)) return 0;
        return value;
      }),
    );

  test("records exactly what it always did", async () => {
    const outDir = tempDir();
    await run(
      parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n").compiled,
      { invoker: echoInvoker().invoker, outDir, runId: "run_fixed", concurrency: 1 },
      SAMPLES.slice(0, 1),
    );
    expect(normalized(readFileSync(join(outDir, "results.json"), "utf8"))).toBe(PINNED_RESULTS);
  });
});

/** The normalized results.json of the run above, as the runner wrote it before criteria. */
const PINNED_RESULTS =
  '{"runId":"run_fixed","startedAt":"<x>","endedAt":"<x>","samples":[{"sampleId":"c1","sessionId":"<x>","startedAt":"<x>","endedAt":"<x>","latencyMs":0,"turns":0,"tokens":{"input":0,"output":0},"model":"m","agentOutput":"a1","metadata":{"family":"csv"},"grades":{"overall":{"passed":true,"score":1,"rationale":"[exact: ✓] output matched expected (2 chars)"},"perGrader":[{"name":"exact","passed":true,"score":1,"rationale":"output matched expected (2 chars)"}]},"metrics":{"interventions":0,"safetyViolations":{"permissionDenials":0,"egressBlocks":0,"justificationRejections":0,"total":0},"modelCallLatenciesMs":[]}}],"aggregates":{"passRate":1,"meanScore":1,"p50Turns":0,"p95Turns":0,"p50LatencyMs":0,"p95LatencyMs":0,"totalTokens":{"input":0,"output":0},"errorCount":0,"partialScoreMean":1,"interventionRate":0,"safetyViolations":{"permissionDenials":0,"egressBlocks":0,"justificationRejections":0,"total":0},"p50ModelCallMs":0,"p95ModelCallMs":0,"passRateCI95":[0.2065493117918027,1]},"slices":{"family":{"csv":{"sampleCount":1,"passRate":1,"meanScore":1}}},"config":{"specHash":"d6c5a9026d98671","datasetName":"d","graderNames":["exact"],"model":"m","concurrency":1,"bunVersion":"<x>","platform":"<x>"},"outDir":"<x>"}';

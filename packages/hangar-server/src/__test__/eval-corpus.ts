/**
 * Real eval artifacts, generated rather than typed.
 *
 * A hand-written `results.json` proves a view reads what its author imagined,
 * which is how the drill-downs came to read fields no writer emits. Everything
 * here comes out of the real `runEval` and `recordEvalRun` over a fake invoker,
 * so a change to what the runner records reaches these tests.
 *
 * Test-only: `__test__/` is outside every build, and non-test source must not
 * import it.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { type CompiledGrader, parseGradersConfig } from "@crewhaus/eval-grader";
import { type RunIndexEntry, recordEvalRun } from "@crewhaus/eval-report";
import {
  type AgentInvoker,
  type EvalRunSummary,
  type RunEvalOptions,
  runEval,
} from "@crewhaus/eval-runner";
import type { IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";

/** What a sample does when it runs. */
export type CorpusBehavior = "pass" | "fail" | "error" | "abstain" | "flaky";

/** The named runs a test can ask for. */
export const CORPUS_CASES = {
  pass: { s1: "pass", s2: "pass" },
  fail: { s1: "fail", s2: "pass" },
  /** Mostly errors, but a real verdict survives: still a measurement. */
  "some-errored": { s1: "error", s2: "error", s3: "pass" },
  abstained: { s1: "abstain", s2: "pass" },
  flaky: { s1: "flaky", s2: "pass" },
  "all-errored": { s1: "error", s2: "error" },
  "zero-measured": { s1: "abstain", s2: "abstain" },
  /** A sample id that is not a safe directory name. */
  sanitized: { "a/b": "pass", s2: "fail" },
} as const satisfies Record<string, Readonly<Record<string, CorpusBehavior>>>;

export type CorpusCase = keyof typeof CORPUS_CASES;

const SPEC_NAME = "corpus-harness";

const specIr = (name: string): IrV0 => {
  const ir = lower(
    parseSpec(`name: ${name}\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: t\n`),
  );
  if (ir.target !== "cli") throw new Error("the corpus spec is a cli spec");
  return ir;
};

async function* yieldSamples(samples: readonly Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const behaviorOf = (sample: Sample): CorpusBehavior =>
  (sample.metadata?.["behavior"] as CorpusBehavior | undefined) ?? "pass";

/** Fails on "fail" and "error" (the invoker throws), alternates on "flaky". */
function corpusInvoker(): AgentInvoker {
  const calls = new Map<string, number>();
  return async ({ sample }) => {
    const n = calls.get(sample.id) ?? 0;
    calls.set(sample.id, n + 1);
    const behavior = behaviorOf(sample);
    if (behavior === "error") throw new Error(`invoker failed on ${sample.id}`);
    const right = behavior !== "fail" && (behavior !== "flaky" || n % 2 === 0);
    return {
      agentOutput: right ? (sample.expected_output ?? "") : "wrong",
      transcript: [{ version: 1, kind: "user_message", payload: { content: sample.input } }],
      events: [],
    } as Awaited<ReturnType<AgentInvoker>>;
  };
}

/** `exact_match`, plus a grader that declines to score the samples that ask it to. */
function corpusGraders(): CompiledGrader[] {
  const { compiled } = parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n");
  const judge: CompiledGrader = {
    name: "judge",
    weight: 1,
    grader: async (sample) =>
      behaviorOf(sample) === "abstain"
        ? { passed: false, score: 0, rationale: "evidence insufficient", abstained: true }
        : { passed: true, score: 1, rationale: "fine" },
  };
  return [...compiled, judge];
}

const samplesFrom = (
  behaviors: Readonly<Record<string, CorpusBehavior>>,
  extra: Readonly<Record<string, unknown>> = {},
): Sample[] =>
  Object.entries(behaviors).map(([id, behavior]) => ({
    id,
    input: `q ${id}`,
    expected_output: "yes",
    metadata: { behavior, ...extra },
  }));

export type CorpusRunOptions = {
  readonly runId: string;
  readonly specName?: string;
  readonly datasetName?: string;
  readonly repeats?: number;
  /** Extra `runEval` options (`budgetUsd`, `pricing`, …). */
  readonly opts?: Partial<RunEvalOptions>;
  /** Samples to add as contamination canaries: a verdict about nothing. */
  readonly canaries?: Readonly<Record<string, CorpusBehavior>>;
};

export type CorpusRun = {
  readonly summary: EvalRunSummary;
  readonly row: RunIndexEntry;
  readonly outDir: string;
};

/** Run these samples through the real runner, into this harness's history. */
export async function runCorpusEval(
  harnessDir: string,
  behaviors: Readonly<Record<string, CorpusBehavior>>,
  options: CorpusRunOptions,
): Promise<CorpusRun> {
  const specName = options.specName ?? SPEC_NAME;
  const evalsDir = join(harnessDir, ".crewhaus", "evals");
  const outDir = join(evalsDir, options.runId);
  const summary = await runEval({
    ir: specIr(specName),
    dataset: {
      name: options.datasetName ?? "corpus",
      samples: yieldSamples([
        ...samplesFrom(behaviors),
        ...samplesFrom(options.canaries ?? {}, { source: "canary" }),
      ]),
    },
    compiledGraders: corpusGraders(),
    opts: {
      runId: options.runId,
      outDir,
      invoker: corpusInvoker(),
      concurrency: 1,
      retryErrors: false,
      ...(options.repeats !== undefined ? { repeats: options.repeats } : {}),
      ...options.opts,
    },
  });
  const row = recordEvalRun(summary, {
    specName,
    datasetHash: "d".repeat(64),
    outDir,
    evalsDir,
  });
  return { summary, row, outDir };
}

/** One named case, under `runId`. */
export function runCorpusCase(
  harnessDir: string,
  name: CorpusCase,
  options: CorpusRunOptions,
): Promise<CorpusRun> {
  return runCorpusEval(harnessDir, CORPUS_CASES[name], {
    ...(name === "flaky" ? { repeats: 2 } : {}),
    ...options,
  });
}

/** Stopped by its budget: two samples ran, two were recorded as synthetic errors. */
export function runCorpusPartial(
  harnessDir: string,
  options: CorpusRunOptions,
): Promise<CorpusRun> {
  return runCorpusEval(
    harnessDir,
    { s1: "pass", s2: "pass", s3: "pass", s4: "pass" },
    { ...options, opts: { budgetUsd: 1, pricing: () => 500_000, ...options.opts } },
  );
}

/**
 * A run recorded, then resumed under its own id: the index holds two lines for
 * it, the first scoring `first` and the second `second`.
 */
export async function runCorpusResumed(
  harnessDir: string,
  options: CorpusRunOptions,
): Promise<{ readonly first: CorpusRun; readonly second: CorpusRun }> {
  const first = await runCorpusEval(harnessDir, { s1: "pass", s2: "fail" }, options);
  rmSync(join(first.outDir, "s2", "grades.json"));
  const second = await runCorpusEval(
    harnessDir,
    { s1: "pass", s2: "pass" },
    { ...options, opts: { resume: true, ...options.opts } },
  );
  return { first, second };
}

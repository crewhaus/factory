/**
 * Fixtures for the quality-service tests: a throwaway harness on disk, eval run
 * summaries built from per-case verdicts, and fake check runners that record what
 * they were asked to run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedRegistry } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { gradersConfigHash, parseGradersConfig } from "@crewhaus/eval-grader";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import type { CheckRunners, EvalSpecArgs, RegradeArgs } from "./check";

const DIRS: string[] = [];

export function removeTempDirs(): void {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const NOW = Date.parse("2026-11-12T12:00:00.000Z");

export const SPEC = `name: shop
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: Help the customer.
`;

export const GRADERS = `graders:
  - name: exact
    type: exact_match
`;

/** A harness with a spec, a graders file and (optionally) a registry dataset. */
export async function harness(
  opts: { readonly holdout?: boolean; readonly cases?: number } = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "quality-service-"));
  DIRS.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), SPEC);
  mkdirSync(join(dir, "eval"), { recursive: true });
  writeFileSync(join(dir, "eval", "graders.yaml"), GRADERS);
  const n = opts.cases ?? 3;
  const sample = (prefix: string, i: number): Sample => ({
    id: `${prefix}${i}`,
    input: `q-${prefix}${i}`,
    expected_output: "ok",
  });
  const reg = createFileBackedRegistry({ rootDir: join(dir, ".crewhaus", "datasets") });
  await reg.put({
    name: "cases",
    version: "v1",
    splits: {
      train: Array.from({ length: n }, (_, i) => sample("c", i)),
      dev: [sample("d", 0)],
      ...(opts.holdout === true ? { holdout: [sample("h", 0), sample("h", 1)] } : {}),
    },
  });
  return dir;
}

export type Verdict = "pass" | "fail" | "not_measured" | "error";

export function caseResult(id: string, verdict: Verdict): SampleResult {
  const passed = verdict === "pass";
  return {
    sampleId: id,
    sessionId: "sess_0000000000000000",
    startedAt: "t",
    endedAt: "t",
    latencyMs: 1,
    turns: 1,
    tokens: { input: 0, output: 0 },
    model: "m",
    agentOutput: "x",
    ...(verdict === "error" ? { error: "boom" } : {}),
    grades: {
      overall: {
        passed,
        score: passed ? 1 : 0,
        rationale: "",
        ...(verdict === "not_measured"
          ? { status: "not_measured" as const, statusReason: "no_proof_bundle" as never }
          : {}),
      },
      perGrader: [{ name: "exact", passed, score: passed ? 1 : 0, rationale: "" }],
    },
  };
}

/** A run over these verdicts, its pass rate counted over the measured cases. */
export function run(
  runId: string,
  verdicts: Readonly<Record<string, Verdict>>,
  config: Partial<EvalRunSummary["config"]> = {},
): EvalRunSummary {
  const samples = Object.entries(verdicts).map(([id, v]) => caseResult(id, v));
  const measured = samples.filter(
    (s) => s.error === undefined && s.grades.overall.status === undefined,
  );
  const passed = measured.filter((s) => s.grades.overall.passed).length;
  return {
    runId,
    startedAt: "t",
    endedAt: "t",
    samples,
    aggregates: {
      passRate: measured.length === 0 ? 0 : passed / measured.length,
      meanScore: measured.length === 0 ? 0 : passed / measured.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1,
      p95LatencyMs: 1,
      totalTokens: { input: 0, output: 0 },
      errorCount: samples.filter((s) => s.error !== undefined).length,
      measured: measured.length,
    },
    config: {
      specHash: "s",
      datasetName: "d",
      graderNames: ["exact"],
      model: "m",
      concurrency: 1,
      gradersHash: "graders-1",
      ...config,
    },
    outDir: "/x",
  };
}

export type Recorded = {
  readonly evals: EvalSpecArgs[];
  readonly regrades: RegradeArgs[];
};

/**
 * Runners whose evals answer from `verdictsFor(label, args)`, recording each call.
 */
export function fakeRunners(
  verdictsFor: (label: string, args: EvalSpecArgs | RegradeArgs) => Record<string, Verdict>,
  extra: Partial<CheckRunners> = {},
): { runners: CheckRunners; calls: Recorded } {
  const calls: Recorded = { evals: [], regrades: [] };
  let seq = 0;
  const runners: CheckRunners = {
    async evalSpec(args) {
      calls.evals.push(args);
      seq += 1;
      return run(`run_${String(seq).padStart(16, "0")}`, verdictsFor(args.label, args), {
        gradersHash: gradersConfigHash(parseGradersConfig(args.gradersYaml).config),
      });
    },
    async regrade(args) {
      calls.regrades.push(args);
      seq += 1;
      return run(`run_${String(seq).padStart(16, "0")}`, verdictsFor(args.label, args), {
        gradersHash: gradersConfigHash(parseGradersConfig(args.gradersYaml).config),
      });
    },
    async loadFileDataset() {
      throw new Error("no file datasets in these tests");
    },
    ...extra,
  };
  return { runners, calls };
}

/** Every case of the seeded dataset passing. */
export function allPass(args: EvalSpecArgs | RegradeArgs): Record<string, Verdict> {
  return Object.fromEntries(args.samples.map((s) => [s.id, "pass" as const]));
}

/** The instrument a fake check measured with, computed from the graders now. */
export function sameInstrument(inputs: { readonly gradersYaml: string }): {
  readonly source: "summary";
  readonly routed: false;
  readonly gradersHash: string;
} {
  return {
    source: "summary",
    routed: false,
    gradersHash: gradersConfigHash(parseGradersConfig(inputs.gradersYaml).config),
  };
}

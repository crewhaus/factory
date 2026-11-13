/**
 * Observation and scope, end to end: a real run of graders bound to an
 * observing, scoped criterion and an enforcing, scoped one, read by every
 * consumer of result states — the sample's combined grade, the aggregates'
 * observing and skipped buckets and the pass-rate denominator, the suite's
 * OBSERVING verdict, and the gate's instrument and lost-measurement checks.
 * Nothing here is planted: every status comes from the runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { gradersConfigHash, parseGradersConfig, runCriteriaRecord } from "@crewhaus/eval-grader";
import { finishEvalRun } from "@crewhaus/eval-ops";
import { type EvalRunSummary, runEval } from "@crewhaus/eval-runner";
import { parseSpec } from "@crewhaus/spec";
import {
  type SuiteEntryOutcome,
  aggregateSuite,
  entryAggregatesFromResults,
  entryObserving,
  renderSuiteSummary,
} from "./eval-suite";

const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});
const root = mkdtempSync(join(tmpdir(), "crewhaus-criteria-e2e-"));
TMP.push(root);

const SPEC = "name: shop\ntarget: cli\nagent:\n  model: m\n  instructions: Answer.\n";
const ir = () => {
  const lowered = lower(parseSpec(SPEC));
  if (lowered.target !== "cli") throw new Error("cli");
  return lowered;
};

const SAMPLES: Sample[] = [
  { id: "c1", input: "q", expected_output: "ok c1", metadata: { family: "csv" } },
  { id: "c2", input: "q", expected_output: "ok c2", metadata: { family: "csv" } },
  { id: "j1", input: "q", expected_output: "ok j1", metadata: { family: "json" } },
  { id: "j2", input: "q", expected_output: "ok j2", metadata: { family: "json" } },
  { id: "x1", input: "q", expected_output: "ok x1", metadata: { family: "xml" } },
  { id: "x2", input: "q", expected_output: "ok x2", metadata: { family: "xml" } },
];

/** The agent answers each case's expected output, except one json case. */
const invoker = async ({ sample }: { sample: Sample }) => ({
  agentOutput: sample.id === "j2" ? "ok, but wrong" : (sample.expected_output ?? ""),
});

async function* stream(): AsyncIterable<Sample> {
  for (const s of SAMPLES) yield s;
}

const SCOPED = `graders:
  - name: exact
    type: exact_match
  - name: has
    type: contains
    substring: ok
criteria:
  - id: json-exact
    mode: observe
    scope: { metadata: { family: [json] } }
    measured_by: [exact]
  - id: csv-has
    scope: { metadata: { family: [csv] } }
    measured_by: [has]
`;

const ALL_OBSERVING = `graders:
  - name: exact
    type: exact_match
  - name: has
    type: contains
    substring: ok
criteria:
  - id: watch-exact
    mode: observe
    measured_by: [exact]
  - id: watch-has
    mode: observe
    measured_by: [has]
`;

const ENFORCED = `graders:
  - name: exact
    type: exact_match
  - name: has
    type: contains
    substring: ok
`;

/** A real run of `graders`, recorded the way `crewhaus eval` records it. */
async function run(
  name: string,
  graders: string,
  opts: { readonly gradersHash?: boolean } = {},
): Promise<EvalRunSummary> {
  const { compiled, config } = parseGradersConfig(graders);
  const criteria = runCriteriaRecord(config);
  const outDir = join(root, name);
  mkdirSync(outDir, { recursive: true });
  return runEval({
    ir: ir(),
    dataset: { name: "families", samples: stream() },
    compiledGraders: compiled,
    opts: {
      invoker,
      outDir,
      runId: `run_${name}`,
      datasetHash: "d".repeat(64),
      ...(opts.gradersHash !== false ? { gradersHash: gradersConfigHash(config) } : {}),
      ...(criteria !== undefined ? { criteria } : {}),
      readCalibrationFile: () => undefined,
    },
  });
}

const resultsOf = (summary: EvalRunSummary): EvalRunSummary =>
  JSON.parse(readFileSync(join(summary.outDir, "results.json"), "utf8")) as EvalRunSummary;

describe("observe and scope, from a real run through every consumer", () => {
  test("statuses, buckets, the pass rate, the suite verdict and the gate", async () => {
    const scoped = resultsOf(await run("scoped", SCOPED));
    const byId = new Map(scoped.samples.map((s) => [s.sampleId, s]));
    const statusOf = (id: string, grader: string) =>
      byId.get(id)?.grades.perGrader.find((g) => g.name === grader)?.status;

    // csv: has enforced, exact out of scope — a verdict.
    expect(statusOf("c1", "exact")).toBe("skipped");
    expect(statusOf("c1", "has")).toBeUndefined();
    expect(byId.get("c1")?.grades.overall.status).toBeUndefined();
    expect(byId.get("c1")?.grades.overall.passed).toBe(true);
    // json: exact observed, has out of scope — observing.
    expect(statusOf("j1", "exact")).toBe("observing");
    expect(statusOf("j1", "has")).toBe("skipped");
    expect(byId.get("j1")?.grades.overall.status).toBe("observing");
    // xml: both out of scope — skipped.
    expect(statusOf("x1", "exact")).toBe("skipped");
    expect(statusOf("x1", "has")).toBe("skipped");
    expect(byId.get("x1")?.grades.overall.status).toBe("skipped");
    expect(byId.get("x1")?.grades.overall.statusReason).toBe("out_of_scope");

    // The aggregates read what the runner produced.
    expect(scoped.aggregates.observing?.["exact"]).toEqual({
      graded: 2,
      wouldFail: 1,
      wouldFailSampleIds: ["j2"],
    });
    expect(scoped.aggregates.skipped).toBe(2);
    expect(scoped.aggregates.skippedSampleIds).toEqual(["x1", "x2"]);
    // The pass rate is over the csv cases alone.
    expect(scoped.aggregates.measured).toBe(2);
    expect(scoped.aggregates.passRate).toBe(1);

    // The suite: an all-observing run reads OBSERVING; the scoped one does not.
    const observing = resultsOf(await run("observing", ALL_OBSERVING));
    const entry = (name: string, summary: EvalRunSummary): SuiteEntryOutcome => {
      const aggregates = entryAggregatesFromResults(summary);
      if (aggregates === undefined) throw new Error("no aggregates");
      const isObserving = entryObserving(aggregates);
      return {
        name,
        dataset: "families",
        graders: name,
        outDir: summary.outDir,
        passed: true,
        failures: [],
        aggregates,
        errored: false,
        ...(isObserving ? { state: "observing" as const } : {}),
      };
    };
    expect(entryAggregatesFromResults(observing)?.observing).toBe(true);
    expect(entryAggregatesFromResults(scoped)?.observing).toBeUndefined();
    const suite = (entries: SuiteEntryOutcome[]) =>
      renderSuiteSummary(
        aggregateSuite({
          suiteName: "s",
          tier: "fast",
          startedAt: "t",
          endedAt: "t",
          outDir: root,
          entries,
        }),
      );
    expect(suite([entry("observing", observing)])).toContain("tier=fast: OBSERVING");
    expect(suite([entry("scoped", scoped)])).toContain("tier=fast: PASS");

    // The gate. A mode or a scope is part of the instrument: against a
    // baseline graded by the enforce-only file, the run is not comparable.
    const evalsDir = join(root, "evals-instrument");
    const lines: string[] = [];
    const finish = (summary: EvalRunSummary, dir: string) =>
      finishEvalRun({
        summary,
        specName: "shop",
        datasetHash: "d".repeat(64),
        outDir: summary.outDir,
        gateRequested: true,
        promote: true,
        evalsDir: dir,
        write: (l) => lines.push(l),
        warn: () => {},
      });
    const enforced = await run("enforced", ENFORCED);
    expect((await finish(enforced, evalsDir)).gateFailed).toBe(false);
    const notComparable = await finish(scoped, evalsDir);
    expect(notComparable.gateFailed).toBe(true);
    expect(notComparable.notComparable).toBe("instrument");

    // A baseline whose record carries no gradersHash cannot say its
    // instrument differed, so the gate compares the cases: every case the
    // baseline measured that this run only observed or skipped fails it.
    const lostDir = join(root, "evals-lost");
    const legacy = await run("legacy", ENFORCED, { gradersHash: false });
    expect((await finish(legacy, lostDir)).gateFailed).toBe(false);
    const lost = await finish(scoped, lostDir);
    expect(lost.gateFailed).toBe(true);
    expect(lost.notComparable).toBeUndefined();
    expect(lost.gateReason).toContain(
      "cases the baseline measured were not measured: j1, j2, x1, x2",
    );
  }, 20_000); // five real runs over six cases each, with their run directories
});

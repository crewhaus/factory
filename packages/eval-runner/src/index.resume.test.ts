/**
 * NEW-HUNT-6 — `runEval({ resume: true })` end to end: an interrupted run
 * directory is re-opened under its ORIGINAL runId, already-graded samples are
 * reloaded (no invoker call, no judge call, no spend), only the missing ones
 * run, and the UNION is re-aggregated into a fresh results.json.
 *
 * The "interruption" is simulated exactly as one looks on disk: a sample that
 * never ran has no artifact directory (the runner throws before `runSample`),
 * so the test deletes one.
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

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-resume-run-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const SPEC = `name: resume-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: be brief
`;

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const SAMPLES: Sample[] = [
  { id: "q1", input: "2+2?", expected_output: "4", metadata: { difficulty: "easy" } },
  { id: "q2", input: "5-3?", expected_output: "2" },
  { id: "q3", input: "6/2?", expected_output: "3" },
];

/** Answers every sample correctly and counts which ones it was asked for. */
function countingInvoker(): { invoker: AgentInvoker; asked: string[] } {
  const asked: string[] = [];
  const invoker: AgentInvoker = async ({ sample }) => {
    asked.push(sample.id);
    return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
  };
  return { invoker, asked };
}

async function firstRun(outDir: string): Promise<Awaited<ReturnType<typeof runEval>>> {
  const { invoker } = countingInvoker();
  return runEval({
    ir: narrowToAgent(lower(parseSpec(SPEC))),
    dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
    compiledGraders: parseGradersConfig(GRADERS).compiled,
    opts: { invoker, outDir, datasetHash: "ds1", gradersHash: "gr1", concurrency: 1 },
  });
}

describe("runEval --resume", () => {
  test("reuses graded samples, runs only the missing one, re-aggregates the union", async () => {
    const outDir = newTempRoot();
    const first = await firstRun(outDir);
    expect(first.samples).toHaveLength(3);

    // Simulate the interruption: q2 never ran, so it left no artifacts.
    rmSync(join(outDir, "q2"), { recursive: true, force: true });
    expect(existsSync(join(outDir, "q2", "grades.json"))).toBe(false);

    const { invoker, asked } = countingInvoker();
    const resumed = await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker,
        outDir,
        resume: true,
        datasetHash: "ds1",
        gradersHash: "gr1",
        concurrency: 1,
      },
    });

    // Only the missing sample was paid for.
    expect(asked).toEqual(["q2"]);
    // The run kept its identity: same id, same start time, one directory.
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.startedAt).toBe(first.startedAt);
    expect(resumed.outDir).toBe(outDir);
    // The UNION is what got aggregated.
    expect(resumed.samples.map((s) => s.sampleId).sort()).toEqual(["q1", "q2", "q3"]);
    expect(resumed.aggregates.passRate).toBe(1);
    expect(resumed.resumed).toEqual({
      runDir: outDir,
      resumedAt: expect.any(String),
      reusedSamples: 2,
      ranSamples: 1,
    });
    // Reused samples keep their grades and their dataset metadata.
    const q1 = resumed.samples.find((s) => s.sampleId === "q1");
    expect(q1?.grades.overall.passed).toBe(true);
    expect(q1?.metadata).toEqual({ difficulty: "easy" });

    // results.json was rewritten with the union; run.json kept the runId and
    // gained the resume marker.
    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8")) as {
      runId: string;
      samples: unknown[];
      resumed: { reusedSamples: number };
    };
    expect(results.runId).toBe(first.runId);
    expect(results.samples).toHaveLength(3);
    expect(results.resumed.reusedSamples).toBe(2);
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      runId: string;
      startedAt: string;
      resumedAt?: string[];
    };
    expect(manifest.runId).toBe(first.runId);
    expect(manifest.startedAt).toBe(first.startedAt);
    // The resume LEDGER: one ISO stamp per attempt, appended.
    expect(manifest.resumedAt).toHaveLength(1);
    expect(manifest.resumedAt?.[0]).toBe(resumed.resumed?.resumedAt);
  });

  test("a second resume APPENDS to the run.json ledger rather than erasing the first", async () => {
    const outDir = newTempRoot();
    await firstRun(outDir);
    const readLedger = (): string[] =>
      (JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as { resumedAt?: string[] })
        .resumedAt ?? [];

    const resumeOnce = async (): Promise<void> => {
      const { invoker } = countingInvoker();
      await runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          invoker,
          outDir,
          resume: true,
          datasetHash: "ds1",
          gradersHash: "gr1",
          concurrency: 1,
        },
      });
    };

    rmSync(join(outDir, "q2"), { recursive: true, force: true });
    await resumeOnce();
    const afterFirst = readLedger();
    expect(afterFirst).toHaveLength(1);

    rmSync(join(outDir, "q3"), { recursive: true, force: true });
    await resumeOnce();
    const afterSecond = readLedger();
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0]).toBe(afterFirst[0] as string);
  });

  test("under --repeats, reloaded samples carry the SAME flaky flag a fresh run would", async () => {
    // C34 × NEW-HUNT-6 — `aggregates.flakySampleIds` is derived from
    // `trialPassRate`, but `SampleResult.flaky` used to be attached only on
    // the freshly-run path, so a resumed results.json held two classes of
    // flaky sample that disagreed — and `eval-report export` (the CSV the
    // flake line names as the triage path) emitted `flaky=false` for the
    // reused ones.
    const outDir = newTempRoot();
    const flakySamples: Sample[] = [
      { id: "stable", input: "2+2?", expected_output: "4" },
      { id: "flip", input: "5-3?", expected_output: "2" },
    ];
    // "flip" answers correctly on odd trials only, so its 3 trials disagree.
    let flipCalls = 0;
    const scriptedInvoker: AgentInvoker = async ({ sample }) => {
      if (sample.id !== "flip") {
        return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
      }
      flipCalls += 1;
      return {
        agentOutput: flipCalls % 2 === 1 ? "2" : "wrong",
        transcript: [],
        events: [],
      };
    };
    const opts = {
      outDir,
      datasetHash: "ds1",
      gradersHash: "gr1",
      concurrency: 1,
      repeats: 3,
    } as const;
    await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: { name: "fixture2", samples: yieldSamples(flakySamples) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: { ...opts, invoker: scriptedInvoker },
    });

    // The FLAKY sample is the one that gets reloaded — that is the whole
    // point: "flip" keeps all three disagreeing trials on disk, and only
    // "stable" is re-run.
    rmSync(join(outDir, "stable"), { recursive: true, force: true });
    const resumed = await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: { name: "fixture2", samples: yieldSamples(flakySamples) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: { ...opts, invoker: scriptedInvoker, resume: true },
    });
    expect(resumed.resumed?.reusedSamples).toBe(1);

    // The invariant: per-sample `flaky` and the trialPassRate the aggregates
    // derive `flakySampleIds` from agree for EVERY sample, reused or not.
    for (const s of resumed.samples) {
      expect(s.flaky === true).toBe(
        s.trialPassRate !== undefined && s.trialPassRate > 0 && s.trialPassRate < 1,
      );
    }
    const flagged = resumed.samples.filter((s) => s.flaky === true).map((s) => s.sampleId);
    expect(flagged.sort()).toEqual([...(resumed.aggregates.flakySampleIds ?? [])].sort());
    // …and the reused sample is the flagged one (before the fix it was
    // listed in the aggregates while its own `flaky` field was absent).
    expect(flagged).toEqual(["flip"]);
    expect(resumed.samples.find((s) => s.sampleId === "flip")?.flaky).toBe(true);
  });

  test("refuses a resume that changes the judge model, seed, repeats or tool mode", async () => {
    const outDir = newTempRoot();
    const { invoker } = countingInvoker();
    await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker,
        outDir,
        datasetHash: "ds1",
        gradersHash: "gr1",
        concurrency: 1,
        judgeModel: "claude-sonnet-4-6",
        seed: 7,
      },
    });
    rmSync(join(outDir, "q2"), { recursive: true, force: true });

    const resumeWith = async (extra: Record<string, unknown>): Promise<unknown> =>
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          invoker: countingInvoker().invoker,
          outDir,
          resume: true,
          datasetHash: "ds1",
          gradersHash: "gr1",
          concurrency: 1,
          judgeModel: "claude-sonnet-4-6",
          seed: 7,
          ...extra,
        },
      });

    // A judge swap is exactly the instrument mismatch the guard exists for:
    // neither specHash nor gradersHash moves with `--judge-model`.
    await expect(resumeWith({ judgeModel: "claude-haiku-4-5" })).rejects.toThrow(
      /judgeModel: claude-sonnet-4-6 \(recorded\) → claude-haiku-4-5/,
    );
    await expect(resumeWith({ seed: 8 })).rejects.toThrow(/seed: 7 \(recorded\) → 8/);
    await expect(resumeWith({ repeats: 3 })).rejects.toThrow(/repeats: 1 \(recorded\) → 3/);
    // The unchanged invocation still resumes.
    await resumeWith({});
  });

  test("resuming an already-complete run costs nothing at all", async () => {
    const outDir = newTempRoot();
    await firstRun(outDir);

    const refusingInvoker: AgentInvoker = async ({ sample }) => {
      throw new Error(`sample "${sample.id}" must not be re-run`);
    };
    const resumed = await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker: refusingInvoker,
        outDir,
        resume: true,
        datasetHash: "ds1",
        gradersHash: "gr1",
      },
    });
    expect(resumed.resumed?.reusedSamples).toBe(3);
    expect(resumed.resumed?.ranSamples).toBe(0);
    expect(resumed.aggregates.errorCount).toBe(0);
    expect(resumed.aggregates.passRate).toBe(1);
  });

  test("refuses loudly when the run's identity moved", async () => {
    const outDir = newTempRoot();
    await firstRun(outDir);

    const attempt = (hashes: { datasetHash?: string; gradersHash?: string }) =>
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: { invoker: countingInvoker().invoker, outDir, resume: true, ...hashes },
      });

    await expect(attempt({ datasetHash: "ds2", gradersHash: "gr1" })).rejects.toThrow(
      /datasetHash: ds1 \(recorded\) → ds2/,
    );
    await expect(attempt({ datasetHash: "ds1", gradersHash: "gr2" })).rejects.toThrow(
      /gradersHash: gr1 \(recorded\) → gr2/,
    );

    // A different SPEC moves specHash — the loudest mismatch of the three.
    await expect(
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC.replace("be brief", "be verbose")))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          invoker: countingInvoker().invoker,
          outDir,
          resume: true,
          datasetHash: "ds1",
          gradersHash: "gr1",
        },
      }),
    ).rejects.toThrow(/specHash/);
  });

  test("refuses a resume that also pins a DIFFERENT runId", async () => {
    const outDir = newTempRoot();
    const first = await firstRun(outDir);
    await expect(
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          invoker: countingInvoker().invoker,
          outDir,
          resume: true,
          runId: "run_somethingelse",
          datasetHash: "ds1",
          gradersHash: "gr1",
        },
      }),
    ).rejects.toThrow(new RegExp(`resume keeps the original runId ${first.runId}`));
  });

  test("refuses a resume with no run directory, or a directory with no run.json", async () => {
    const empty = newTempRoot();
    await expect(
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: { invoker: countingInvoker().invoker, resume: true },
      }),
    ).rejects.toThrow(/resume requires outDir/);

    await expect(
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "fixture3", samples: yieldSamples(SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: { invoker: countingInvoker().invoker, outDir: empty, resume: true },
      }),
    ).rejects.toThrow(/no run\.json there/);
  });

  test("without the flag a run is byte-identical: no resumed block, no resumedAt", async () => {
    const outDir = newTempRoot();
    const summary = await firstRun(outDir);
    expect(summary.resumed).toBeUndefined();
    expect(summary.config).not.toHaveProperty("toolRecording");
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(manifest).not.toHaveProperty("resumedAt");
    expect(manifest).not.toHaveProperty("toolRecording");
    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(results).not.toHaveProperty("resumed");
  });
});

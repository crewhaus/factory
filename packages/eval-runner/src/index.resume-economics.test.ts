/**
 * Wave 4 cluster R, review fixes — the three places where a resumed or
 * replayed run used to lose information it had already paid for:
 *
 *  - G54 `failureClass` on a REUSED errored sample. The class is attached
 *    after `runSample` (meta.json never carried it), and `--resume` reuses
 *    errored samples as-is, so the failure-class tally silently under-reported
 *    by exactly the samples the taxonomy exists to triage.
 *  - NEW-HUNT-3 budget re-arming. The meter starts at zero on every attempt,
 *    so a resumed run authorises another full `--budget-usd`; the earlier
 *    attempt's spend is now recorded on run.json and named on stderr.
 *  - NEW-HUNT-4 exhausted-entry replay. Serving an already-consumed entry
 *    means the replayed trajectory diverged from the recording — a run-level
 *    warning plus a `reusedEntries` count, never a silent stale result.
 *
 * Real filesystem work in per-test `mkdtemp` directories; the invoker and the
 * chat loop are injected through the existing additive seams (no module
 * mocks, nothing written near the repo).
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
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type AgentInvoker, type EvalChatLoopFn, runEval } from "./index";
import { TOOL_RECORDING_FILENAME } from "./tool-record";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-resume-econ-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: ReadonlyArray<Sample>): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

/** Capture stderr for the duration of `fn` (the run-level warning channel). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: captured };
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
}

// ---------------------------------------------------------------- G54 reuse

const TAXONOMY_SPEC = `name: resume-taxonomy
target: cli
agent:
  model: claude-opus-4-7
  instructions: be brief
failure_taxonomy:
  - class: quota_exhausted
    pattern: quota exceeded
    recovery: fail
    hint: top up the provider account
`;

const TAXONOMY_SAMPLES: Sample[] = [
  { id: "boom", input: "explode", expected_output: "never" },
  { id: "ok", input: "2+2?", expected_output: "4" },
];

describe("runEval --resume — a reused ERRORED sample keeps its failure class", () => {
  test("classifyFailure is re-derived on reload, so the taxonomy tally is complete", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(TAXONOMY_SPEC)));
    const failing: AgentInvoker = async ({ sample }) => {
      if (sample.id === "boom") throw new Error("provider quota exceeded for this key");
      return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
    };

    const first = await runEval({
      ir,
      dataset: { name: "tax2", samples: yieldSamples(TAXONOMY_SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker: failing,
        outDir,
        datasetHash: "ds1",
        gradersHash: "gr1",
        concurrency: 1,
        retryErrors: false,
      },
    });
    const firstBoom = first.samples.find((s) => s.sampleId === "boom");
    expect(firstBoom?.error).toContain("quota exceeded");
    expect(firstBoom?.failureClass).toBe("quota_exhausted");

    // Resume: "boom" already has grades.json, so it is reused as-is — the
    // documented behaviour, and exactly the sample triage cares about.
    rmSync(join(outDir, "ok"), { recursive: true, force: true });
    const refuseBoom: AgentInvoker = async ({ sample }) => {
      if (sample.id === "boom") throw new Error("boom must not be re-run");
      return { agentOutput: sample.expected_output ?? "", transcript: [], events: [] };
    };
    const resumed = await runEval({
      ir,
      dataset: { name: "tax2", samples: yieldSamples(TAXONOMY_SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker: refuseBoom,
        outDir,
        resume: true,
        datasetHash: "ds1",
        gradersHash: "gr1",
        concurrency: 1,
        retryErrors: false,
      },
    });

    expect(resumed.resumed?.reusedSamples).toBe(1);
    const reusedBoom = resumed.samples.find((s) => s.sampleId === "boom");
    expect(reusedBoom?.error).toContain("quota exceeded");
    // The regression this test pins: without re-classification the reused
    // sample carries `failureClass: undefined` and the run's
    // "[eval] failure classes:" line silently omits it.
    expect(reusedBoom?.failureClass).toBe("quota_exhausted");
  });
});

// ------------------------------------------------------------ budget re-arm

const BUDGET_SPEC = `name: resume-budget
target: cli
agent:
  model: claude-opus-4-7
  instructions: be brief
`;

const BUDGET_SAMPLES: Sample[] = [
  { id: "b1", input: "one", expected_output: "one" },
  { id: "b2", input: "two", expected_output: "two" },
];

describe("runEval --resume — the budget cap is re-armed, and says so", () => {
  test("run.json records cumulative spend; resuming names it before spending more", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(BUDGET_SPEC)));
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      transcript: [],
      events: [],
    });
    // A pricing seam that charges a flat $0.25 per completed sample.
    const pricing = (_model: string, tokens: { input: number; output: number }): number =>
      tokens.input + tokens.output >= 0 ? 250_000 : 0;

    await runEval({
      ir,
      dataset: { name: "budget2", samples: yieldSamples(BUDGET_SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker,
        outDir,
        datasetHash: "ds1",
        gradersHash: "gr1",
        concurrency: 1,
        budgetUsd: 10,
        pricing,
      },
    });

    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      spentUsd?: number;
    };
    // Two samples × $0.25 — amended onto the manifest AFTER the run.
    expect(manifest.spentUsd).toBeCloseTo(0.5, 6);

    // Resume the (already complete) run with the same cap: the meter restarts
    // at zero, so the warning must name what the earlier attempt spent.
    const { value: resumed, stderr } = await captureStderr(() =>
      runEval({
        ir,
        dataset: { name: "budget2", samples: yieldSamples(BUDGET_SAMPLES) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          invoker,
          outDir,
          resume: true,
          datasetHash: "ds1",
          gradersHash: "gr1",
          concurrency: 1,
          budgetUsd: 10,
          pricing,
        },
      }),
    );
    expect(resumed.resumed?.reusedSamples).toBe(2);
    expect(stderr).toContain("[eval] warning:");
    expect(stderr).toContain("already metered $0.5000 in earlier attempt(s)");
    expect(stderr).toContain("re-armed for THIS attempt");
    expect(stderr).toContain("$10.5000");

    // The running total survives the resume (this attempt reused everything,
    // so it added nothing).
    const after = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      spentUsd?: number;
    };
    expect(after.spentUsd).toBeCloseTo(0.5, 6);
  });

  test("an un-metered run records no spentUsd at all (manifests stay identical)", async () => {
    const outDir = newTempRoot();
    await runEval({
      ir: narrowToAgent(lower(parseSpec(BUDGET_SPEC))),
      dataset: { name: "budget2", samples: yieldSamples(BUDGET_SAMPLES) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        invoker: async ({ sample }) => ({
          agentOutput: sample.expected_output ?? "",
          transcript: [],
          events: [],
        }),
        outDir,
        concurrency: 1,
      },
    });
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(manifest).not.toHaveProperty("spentUsd");
  });
});

// --------------------------------------------------------- reused cassette

const TOOL_SPEC = `name: resume-cassette
target: cli
agent:
  model: claude-opus-4-7
  instructions: read the file
tools: [read]
`;

const TOOL_SAMPLE: Sample[] = [{ id: "s1", input: "read it" }];

/** A chat loop that calls the wired `Read` tool `times` times, same args. */
function repeatingReadLoop(times: number): EvalChatLoopFn {
  return async (opts) => {
    const read = (opts.tools as ReadonlyArray<RegisteredTool> | undefined)?.find(
      (t) => t.name === "Read",
    );
    if (read === undefined) throw new Error("Read tool was not wired");
    let last: unknown = "";
    for (let i = 0; i < times; i++) last = await read.execute({ path: "package.json" });
    return typeof last === "string" ? last : JSON.stringify(last);
  };
}

describe("runEval --replay-tools — reusing an exhausted entry is never silent", () => {
  test("a trajectory that over-calls a tool warns and records reusedEntries", async () => {
    const recDir = newTempRoot();
    // Record ONE call…
    await runEval({
      ir: narrowToAgent(lower(parseSpec(TOOL_SPEC))),
      dataset: { name: "cassette", samples: yieldSamples(TOOL_SAMPLE) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        outDir: newTempRoot(),
        recordToolsDir: recDir,
        chatLoop: repeatingReadLoop(1),
        concurrency: 1,
      },
    });
    expect(
      readFileSync(join(recDir, TOOL_RECORDING_FILENAME), "utf-8").trim().split("\n"),
    ).toHaveLength(1);

    // …then replay a trajectory that makes THREE. Calls 2 and 3 are served
    // the exhausted entry: a hit, but a divergence.
    const outDir = newTempRoot();
    const { value: summary, stderr } = await captureStderr(() =>
      runEval({
        ir: narrowToAgent(lower(parseSpec(TOOL_SPEC))),
        dataset: { name: "cassette", samples: yieldSamples(TOOL_SAMPLE) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          outDir,
          replayToolsDir: recDir,
          chatLoop: repeatingReadLoop(3),
          concurrency: 1,
        },
      }),
    );

    expect(stderr).toContain("[eval] warning:");
    expect(stderr).toContain("2 tool call(s) replayed a REUSED recording entry");
    expect(stderr).toContain("s1/Read@");
    expect(summary.config.toolRecording?.reusedEntries).toBe(2);
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      toolRecording?: { reusedEntries?: number };
    };
    expect(manifest.toolRecording?.reusedEntries).toBe(2);
  });

  test("a replay that matches the recording call-for-call stays silent", async () => {
    const recDir = newTempRoot();
    await runEval({
      ir: narrowToAgent(lower(parseSpec(TOOL_SPEC))),
      dataset: { name: "cassette", samples: yieldSamples(TOOL_SAMPLE) },
      compiledGraders: parseGradersConfig(GRADERS).compiled,
      opts: {
        outDir: newTempRoot(),
        recordToolsDir: recDir,
        chatLoop: repeatingReadLoop(2),
        concurrency: 1,
      },
    });

    const outDir = newTempRoot();
    const { value: summary, stderr } = await captureStderr(() =>
      runEval({
        ir: narrowToAgent(lower(parseSpec(TOOL_SPEC))),
        dataset: { name: "cassette", samples: yieldSamples(TOOL_SAMPLE) },
        compiledGraders: parseGradersConfig(GRADERS).compiled,
        opts: {
          outDir,
          replayToolsDir: recDir,
          chatLoop: repeatingReadLoop(2),
          concurrency: 1,
        },
      }),
    );
    expect(stderr).not.toContain("REUSED recording entry");
    expect(summary.config.toolRecording).not.toHaveProperty("reusedEntries");
    const manifest = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8")) as {
      toolRecording?: Record<string, unknown>;
    };
    expect(manifest.toolRecording).not.toHaveProperty("reusedEntries");
  });
});

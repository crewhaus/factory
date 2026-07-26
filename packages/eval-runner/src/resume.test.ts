/**
 * NEW-HUNT-6 — the resume primitives: the run-manifest reader, the identity
 * guard, and the per-sample reload built from the artifacts a completed
 * sample already wrote. Everything is real filesystem work inside per-test
 * `mkdtemp` directories — no module mocks, no cwd-relative writes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  RUN_MANIFEST_FILENAME,
  assertResumeCompatible,
  loadCompletedSample,
  readRunManifest,
  resumeMismatches,
  sampleArtifactDirName,
} from "./resume";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-resume-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function writeManifest(runDir: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(runDir, RUN_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
}

/** Write the artifact set a COMPLETED sample leaves behind. */
function writeCompletedSample(args: {
  runDir: string;
  sampleId: string;
  trial?: number;
  passed?: boolean;
  score?: number;
  output?: string;
  error?: string;
  /** The seed the trial ACTUALLY ran with, as `runSample` records it. */
  seed?: number;
}): string {
  const suffix = args.trial !== undefined && args.trial > 1 ? `.trial${args.trial}` : "";
  const dir = join(args.runDir, `${sampleArtifactDirName(args.sampleId)}${suffix}`);
  mkdirSync(dir, { recursive: true });
  const passed = args.passed ?? true;
  writeFileSync(
    join(dir, "grades.json"),
    JSON.stringify({
      overall: { passed, score: args.score ?? (passed ? 1 : 0), rationale: "recorded" },
      perGrader: [{ name: "m", passed, score: args.score ?? (passed ? 1 : 0), rationale: "r" }],
    }),
  );
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      sampleId: args.sampleId,
      sessionId: `sess_${"a".repeat(16)}`,
      startedAt: "2026-07-26T00:00:00.000Z",
      endedAt: "2026-07-26T00:00:01.000Z",
      latencyMs: 1000,
      turns: 1,
      tokens: { input: 10, output: 5 },
      model: "claude-recorded",
      metrics: { interventions: 0, modelCallLatenciesMs: [900] },
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    }),
  );
  if (args.output !== undefined) {
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${[
        JSON.stringify({ ts: 1, version: 1, kind: "user_message", payload: { content: "q" } }),
        JSON.stringify({
          ts: 2,
          version: 1,
          kind: "assistant_message",
          payload: { content: [{ type: "text", text: args.output }] },
        }),
      ].join("\n")}\n`,
    );
  }
  return dir;
}

const SAMPLE: Sample = { id: "q1", input: "What is 2+2?", expected_output: "4" };

describe("sampleArtifactDirName", () => {
  test("keeps the on-disk layout flat and path-separator free", () => {
    expect(sampleArtifactDirName("a/b c")).toBe("a_b_c");
    expect(sampleArtifactDirName("ok_id.1-2")).toBe("ok_id.1-2");
  });
});

describe("readRunManifest", () => {
  test("reads runId + startedAt + the identity hashes", () => {
    const runDir = newTempRoot();
    writeManifest(runDir, {
      runId: "run_abc",
      startedAt: "2026-07-26T00:00:00.000Z",
      specHash: "sp",
      datasetHash: "ds",
      gradersHash: "gr",
      concurrency: 4,
    });
    expect(readRunManifest(runDir)).toEqual({
      runId: "run_abc",
      startedAt: "2026-07-26T00:00:00.000Z",
      specHash: "sp",
      datasetHash: "ds",
      gradersHash: "gr",
    });
  });

  test("refuses a directory that is not a run directory", () => {
    const runDir = newTempRoot();
    expect(() => readRunManifest(runDir)).toThrow(/no run\.json there/);
  });

  test("refuses a malformed or id-less manifest", () => {
    const bad = newTempRoot();
    writeFileSync(join(bad, RUN_MANIFEST_FILENAME), "{not json");
    expect(() => readRunManifest(bad)).toThrow(/not valid JSON/);

    const idless = newTempRoot();
    writeManifest(idless, { startedAt: "x" });
    expect(() => readRunManifest(idless)).toThrow(/no runId/);
  });
});

describe("resume identity guard", () => {
  const manifest = { runId: "run_abc", specHash: "sp", datasetHash: "ds", gradersHash: "gr" };

  test("an unchanged identity resumes", () => {
    expect(
      resumeMismatches(manifest, { specHash: "sp", datasetHash: "ds", gradersHash: "gr" }),
    ).toEqual([]);
    expect(() =>
      assertResumeCompatible("/run", manifest, {
        specHash: "sp",
        datasetHash: "ds",
        gradersHash: "gr",
      }),
    ).not.toThrow();
  });

  test("every moved field is listed — spec, dataset and graders alike", () => {
    const mismatches = resumeMismatches(manifest, {
      specHash: "sp2",
      datasetHash: "ds2",
      gradersHash: "gr2",
    });
    expect(mismatches).toHaveLength(3);
    expect(mismatches[0]).toContain("specHash: sp (recorded) → sp2");
    expect(mismatches[1]).toContain("datasetHash");
    expect(mismatches[2]).toContain("gradersHash");
  });

  test("DROPPING a hash the run recorded is a mismatch too", () => {
    expect(resumeMismatches(manifest, { specHash: "sp", datasetHash: "ds" })).toEqual([
      "gradersHash: gr (recorded) → (none) (this run)",
    ]);
  });

  test("a hash the run never recorded cannot block the resume", () => {
    expect(
      resumeMismatches({ runId: "r", specHash: "sp" }, { specHash: "sp", datasetHash: "ds" }),
    ).toEqual([]);
  });

  test("the judge model is part of the instrument, not just the hashes", () => {
    // `--judge-model` is a RUN-LEVEL override: it lives in neither the spec
    // (so specHash holds) nor graders.yaml (so gradersHash holds), and
    // without it a resume would grade the remaining samples with a different
    // judge than the reused ones and report the union as one measurement.
    const pinned = { ...manifest, judgeModel: "claude-sonnet-4-6" };
    expect(
      resumeMismatches(pinned, {
        specHash: "sp",
        datasetHash: "ds",
        gradersHash: "gr",
        judgeModel: "claude-haiku-4-5",
      }),
    ).toEqual(["judgeModel: claude-sonnet-4-6 (recorded) → claude-haiku-4-5 (this run)"]);
  });

  test("seed, repeats and toolRecording move the measurement too", () => {
    const base = { specHash: "sp", datasetHash: "ds", gradersHash: "gr" } as const;
    expect(resumeMismatches({ ...manifest, seed: 7 }, { ...base, seed: 8 })).toEqual([
      "seed: 7 (recorded) → 8 (this run)",
    ]);
    // Both directions: an unseeded run resumed WITH a seed would seed only
    // the samples that had not been paid for yet.
    expect(resumeMismatches(manifest, { ...base, seed: 8 })).toEqual([
      "seed: (none) (recorded) → 8 (this run)",
    ]);
    expect(resumeMismatches({ ...manifest, seed: 7 }, base)).toEqual([
      "seed: 7 (recorded) → (none) (this run)",
    ]);
    // repeats is normalized: run.json omits it only when it was 1, so BOTH
    // directions are caught rather than skipped as "unrecorded".
    expect(resumeMismatches({ ...manifest, repeats: 3 }, base)).toEqual([
      "repeats: 3 (recorded) → 1 (this run)",
    ]);
    expect(resumeMismatches(manifest, { ...base, repeats: 3 })).toEqual([
      "repeats: 1 (recorded) → 3 (this run)",
    ]);
    // Same normalization for tool execution: absent = live tools.
    expect(
      resumeMismatches(manifest, {
        ...base,
        toolRecording: { mode: "replay", dir: "/cassette", recordingHash: "h1" },
      }),
    ).toEqual(["toolRecording: live (recorded) → replay:h1 (this run)"]);
    expect(
      resumeMismatches(
        { ...manifest, toolRecording: { mode: "replay", recordingHash: "h1" } },
        { ...base, toolRecording: { mode: "replay", dir: "/other", recordingHash: "h2" } },
      ),
    ).toEqual(["toolRecording: replay:h1 (recorded) → replay:h2 (this run)"]);
  });

  test("the refusal names the run and every mismatch", () => {
    let msg = "";
    try {
      assertResumeCompatible("/runs/run_abc", manifest, { specHash: "sp2" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("/runs/run_abc");
    expect(msg).toContain("run_abc");
    expect(msg).toContain("specHash: sp (recorded) → sp2");
    expect(msg).toContain("start a fresh run instead");
  });
});

describe("loadCompletedSample", () => {
  test("reloads grades, meta and the transcript's final assistant text", () => {
    const runDir = newTempRoot();
    writeCompletedSample({ runDir, sampleId: SAMPLE.id, output: "4" });

    const reloaded = loadCompletedSample({
      runDir,
      sample: { ...SAMPLE, metadata: { difficulty: "easy" } },
      model: "claude-current",
    });
    expect(reloaded).toBeDefined();
    expect(reloaded?.sampleId).toBe("q1");
    expect(reloaded?.agentOutput).toBe("4");
    expect(reloaded?.grades.overall.passed).toBe(true);
    expect(reloaded?.grades.perGrader).toHaveLength(1);
    expect(reloaded?.tokens).toEqual({ input: 10, output: 5 });
    // meta.json's model wins over the caller's fallback; metadata comes from
    // the CURRENT dataset (the hash guard already proved it did not move).
    expect(reloaded?.model).toBe("claude-recorded");
    expect(reloaded?.metadata).toEqual({ difficulty: "easy" });
    expect(reloaded?.trials).toBeUndefined();
    // Never claims a retry it cannot prove.
    expect(reloaded?.retried).toBeUndefined();
  });

  test("carries a completed sample's recorded error forward", () => {
    const runDir = newTempRoot();
    writeCompletedSample({ runDir, sampleId: "boom", passed: false, error: "provider 429" });
    const reloaded = loadCompletedSample({
      runDir,
      sample: { id: "boom", input: "x" },
      model: "m",
    });
    expect(reloaded?.error).toBe("provider 429");
    expect(reloaded?.grades.overall.passed).toBe(false);
  });

  test("a sample with no artifacts (never ran) is undefined — the caller runs it", () => {
    const runDir = newTempRoot();
    expect(loadCompletedSample({ runDir, sample: SAMPLE, model: "m" })).toBeUndefined();
  });

  test("a half-written sample dir (grades, no meta) is undefined", () => {
    const runDir = newTempRoot();
    const dir = join(runDir, "q1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "grades.json"), JSON.stringify({ overall: { passed: true } }));
    expect(loadCompletedSample({ runDir, sample: SAMPLE, model: "m" })).toBeUndefined();
  });

  test("a missing transcript degrades to an empty output, keeping the grades", () => {
    const runDir = newTempRoot();
    writeCompletedSample({ runDir, sampleId: SAMPLE.id });
    const reloaded = loadCompletedSample({ runDir, sample: SAMPLE, model: "m" });
    expect(reloaded?.agentOutput).toBe("");
    expect(reloaded?.grades.overall.score).toBe(1);
  });

  test("under repeats, ALL trials must be complete or the sample re-runs whole", () => {
    const runDir = newTempRoot();
    writeCompletedSample({ runDir, sampleId: SAMPLE.id, output: "4", seed: 100 });
    writeCompletedSample({
      runDir,
      sampleId: SAMPLE.id,
      trial: 2,
      passed: false,
      output: "5",
      seed: 101,
    });
    // trial 3 never got written — the pass@k figure would be a lie.
    expect(loadCompletedSample({ runDir, sample: SAMPLE, model: "m", repeats: 3 })).toBeUndefined();

    const reloaded = loadCompletedSample({ runDir, sample: SAMPLE, model: "m", repeats: 2 });
    expect(reloaded?.trials).toHaveLength(2);
    // Seeds come from each trial's OWN meta.json — never re-derived from the
    // resuming invocation's `--seed`.
    expect(reloaded?.trials?.[0]).toMatchObject({ trial: 1, seed: 100, passed: true });
    expect(reloaded?.trials?.[1]).toMatchObject({ trial: 2, seed: 101, passed: false });
    expect(reloaded?.trialPassRate).toBe(0.5);
    // C34 — the reloaded sample is flagged by the same rule the freshly-run
    // path applies, so `aggregates.flakySampleIds` and `sample.flaky` agree.
    expect(reloaded?.flaky).toBe(true);
    // The canonical result is still trial 1's.
    expect(reloaded?.agentOutput).toBe("4");
  });

  test("a trial whose artifact carries no seed reports none (no synthesis)", () => {
    const runDir = newTempRoot();
    writeCompletedSample({ runDir, sampleId: SAMPLE.id, output: "4" });
    writeCompletedSample({ runDir, sampleId: SAMPLE.id, trial: 2, output: "4" });
    const reloaded = loadCompletedSample({ runDir, sample: SAMPLE, model: "m", repeats: 2 });
    expect(reloaded?.trials?.every((t) => t.seed === undefined)).toBe(true);
    // Every trial agreed — stable, so no flake flag.
    expect(reloaded?.trialPassRate).toBe(1);
    expect(reloaded?.flaky).toBeUndefined();
  });
});

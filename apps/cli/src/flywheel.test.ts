/**
 * Unit tests for the item-45 flywheel core: knob/default resolution, the
 * acceptance gate, the accept-then-write loop (with injected step hooks —
 * no LLM/credentials needed), the report, and the workflow scaffold.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  CONVENTIONAL_DATASET,
  CONVENTIONAL_GRADERS,
  FLYWHEEL_DEFAULT_KNOBS,
  FLYWHEEL_ENV_KNOBS,
  FlywheelConfigError,
  type FlywheelHooks,
  type FlywheelOptimizeOutcome,
  buildFlywheelWorkflowYaml,
  evaluateFlywheelAcceptance,
  formatDatasetSourceLine,
  formatFlywheelKnobsGuide,
  formatFlywheelReport,
  formatGateSplitLine,
  formatRatingsShadowWarning,
  gateSplitRefusal,
  normalizeHarnessDir,
  parseGateSplit,
  resolveFlywheelData,
  resolveFlywheelKnobs,
  runFlywheelLoop,
  scaffoldWorkflowFile,
  specIsDirty,
} from "./flywheel";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-flywheel-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// -------- fixtures --------

function makeSample(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

function makeSummary(runId: string, samples: SampleResult[]): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: samples.reduce((sum, s) => sum + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "smoke",
      datasetHash: "d".repeat(64),
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 1,
    },
    outDir: `/tmp/${runId}`,
  };
}

const OPTIMIZE_OUTCOME: FlywheelOptimizeOutcome = {
  applied: true,
  patchedYaml: "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: better\n",
  runId: "fly_test",
  outDir: "/tmp/fly_test/optimize",
  scoreBefore: 0.3,
  scoreAfter: 1,
  mutatorName: "rule-based",
  iterations: 3,
  spendUsd: "$0.0000",
};

type HookLog = string[];

function makeHooks(opts: {
  log: HookLog;
  before: EvalRunSummary;
  after: EvalRunSummary;
  optimize?: Partial<FlywheelOptimizeOutcome>;
  failPostCompile?: boolean;
}): FlywheelHooks {
  return {
    compileCheck: (_yaml, phase) => {
      opts.log.push(`compile:${phase}`);
      if (phase === "post-optimize" && opts.failPostCompile === true) {
        throw new Error("bad candidate yaml");
      }
    },
    evalRun: async (label) => {
      opts.log.push(`eval:${label}`);
      return label === "before" ? opts.before : opts.after;
    },
    optimize: async () => {
      opts.log.push("optimize");
      return { ...OPTIMIZE_OUTCOME, ...opts.optimize };
    },
    applyAccepted: async () => {
      opts.log.push("apply");
    },
  };
}

// -------- knobs --------

describe("resolveFlywheelKnobs", () => {
  test("defaults match the demo's (budget $2, 3 iterations, seed 1, concurrency 1)", () => {
    const knobs = resolveFlywheelKnobs({ flags: {}, env: {} });
    expect(knobs).toEqual(FLYWHEEL_DEFAULT_KNOBS);
    expect(knobs).toEqual({ budgetUsd: 2, iterations: 3, seed: 1, concurrency: 1 });
  });

  test("FLYWHEEL_* env overrides defaults (demo knob-name continuity)", () => {
    const knobs = resolveFlywheelKnobs({
      flags: {},
      env: {
        [FLYWHEEL_ENV_KNOBS.budgetUsd]: "5.50",
        [FLYWHEEL_ENV_KNOBS.iterations]: "7",
        [FLYWHEEL_ENV_KNOBS.seed]: "42",
        [FLYWHEEL_ENV_KNOBS.concurrency]: "4",
      },
    });
    expect(knobs).toEqual({ budgetUsd: 5.5, iterations: 7, seed: 42, concurrency: 4 });
  });

  test("flags beat env beat defaults", () => {
    const knobs = resolveFlywheelKnobs({
      flags: { "budget-usd": "1.25", iterations: "2" },
      env: { [FLYWHEEL_ENV_KNOBS.budgetUsd]: "9", [FLYWHEEL_ENV_KNOBS.seed]: "3" },
    });
    expect(knobs.budgetUsd).toBe(1.25);
    expect(knobs.iterations).toBe(2);
    expect(knobs.seed).toBe(3);
    expect(knobs.concurrency).toBe(1);
  });

  test("empty env values fall through to defaults", () => {
    const knobs = resolveFlywheelKnobs({
      flags: {},
      env: { [FLYWHEEL_ENV_KNOBS.iterations]: "" },
    });
    expect(knobs.iterations).toBe(3);
  });

  test.each([
    [{ "budget-usd": "0" }, "--budget-usd"],
    [{ "budget-usd": "nope" }, "--budget-usd"],
    // H3 — strict float parsing: parseFloat would silently truncate "2abc"
    // to 2 and Number would accept "Infinity"; both must reject.
    [{ "budget-usd": "2abc" }, "--budget-usd"],
    [{ "budget-usd": "Infinity" }, "--budget-usd"],
    [{ iterations: "0" }, "--iterations"],
    [{ iterations: "2.5" }, "--iterations"],
    [{ concurrency: "-1" }, "--concurrency"],
    [{ seed: "abc" }, "--seed"],
  ])("invalid flag %j throws naming the flag", (flags, expected) => {
    expect(() => resolveFlywheelKnobs({ flags, env: {} })).toThrow(expected);
  });

  test.each([["2abc"], ["Infinity"], ["-Infinity"], ["NaN"]])(
    "budget %s rejects with FlywheelConfigError (fail-closed parsing)",
    (bad) => {
      expect(() => resolveFlywheelKnobs({ flags: { "budget-usd": bad }, env: {} })).toThrow(
        FlywheelConfigError,
      );
    },
  );

  test("invalid env value throws naming the env knob", () => {
    expect(() =>
      resolveFlywheelKnobs({ flags: {}, env: { [FLYWHEEL_ENV_KNOBS.budgetUsd]: "-3" } }),
    ).toThrow(FLYWHEEL_ENV_KNOBS.budgetUsd);
  });
});

// -------- dataset/graders defaults --------

describe("resolveFlywheelData", () => {
  const base = {
    specName: "concierge",
    specDir: ".",
    hasConventionalDataset: false,
    hasConventionalGraders: false,
    ratingsRegistered: false,
  };

  test("flags win over everything", () => {
    const r = resolveFlywheelData({
      ...base,
      datasetFlag: "my.jsonl",
      gradersFlag: "g.yaml",
      hasConventionalDataset: true,
      hasConventionalGraders: true,
      ratingsRegistered: true,
    });
    expect(r).toEqual({
      dataset: "my.jsonl",
      graders: "g.yaml",
      datasetSource: "flag",
      gradersSource: "flag",
    });
  });

  test("conventional files are the first fallback", () => {
    const r = resolveFlywheelData({
      ...base,
      hasConventionalDataset: true,
      hasConventionalGraders: true,
      ratingsRegistered: true,
    });
    expect(r.dataset).toBe(CONVENTIONAL_DATASET);
    expect(r.graders).toBe(CONVENTIONAL_GRADERS);
    expect(r.datasetSource).toBe("convention");
  });

  test("H4 — conventional paths resolve from the SPEC's directory, not the cwd", () => {
    const r = resolveFlywheelData({
      ...base,
      specDir: join("/repo", "agents", "concierge"),
      hasConventionalDataset: true,
      hasConventionalGraders: true,
    });
    expect(r.dataset).toBe(join("/repo", "agents", "concierge", CONVENTIONAL_DATASET));
    expect(r.graders).toBe(join("/repo", "agents", "concierge", CONVENTIONAL_GRADERS));
    expect(r.datasetSource).toBe("convention");
    expect(r.gradersSource).toBe("convention");
  });

  test("H4 — flag paths are NOT rebased onto the spec dir (cwd-relative)", () => {
    const r = resolveFlywheelData({
      ...base,
      specDir: "/repo/agents/concierge",
      datasetFlag: "my.jsonl",
      gradersFlag: "g.yaml",
    });
    expect(r.dataset).toBe("my.jsonl");
    expect(r.graders).toBe("g.yaml");
  });

  test("feedback ratings registry backs the dataset when no file exists", () => {
    const r = resolveFlywheelData({
      ...base,
      hasConventionalGraders: true,
      ratingsRegistered: true,
    });
    expect(r.dataset).toBe("registry:concierge-ratings");
    expect(r.datasetSource).toBe("ratings-registry");
  });

  test("no dataset anywhere → FlywheelConfigError with remediation", () => {
    expect(() => resolveFlywheelData({ ...base, hasConventionalGraders: true })).toThrow(
      FlywheelConfigError,
    );
    expect(() => resolveFlywheelData({ ...base, hasConventionalGraders: true })).toThrow("distill");
  });

  test("no graders anywhere → FlywheelConfigError", () => {
    expect(() => resolveFlywheelData({ ...base, hasConventionalDataset: true })).toThrow(
      "no graders",
    );
  });
});

describe("formatDatasetSourceLine + formatRatingsShadowWarning (NEW-flywheel-shadow)", () => {
  const base = {
    specName: "concierge",
    specDir: ".",
    hasConventionalDataset: false,
    hasConventionalGraders: true,
    ratingsRegistered: false,
  };

  test("the source line names the resolved dataset and its precedence rung", () => {
    const flag = resolveFlywheelData({ ...base, datasetFlag: "my.jsonl" });
    expect(formatDatasetSourceLine(flag)).toBe("[flywheel] dataset: my.jsonl (source: flag)");
    const convention = resolveFlywheelData({ ...base, hasConventionalDataset: true });
    expect(formatDatasetSourceLine(convention)).toBe(
      `[flywheel] dataset: ${CONVENTIONAL_DATASET} (source: convention)`,
    );
    const ratings = resolveFlywheelData({ ...base, ratingsRegistered: true });
    expect(formatDatasetSourceLine(ratings)).toBe(
      "[flywheel] dataset: registry:concierge-ratings (source: ratings-registry)",
    );
  });

  test("warns when the convention file shadows a registered ratings dataset", () => {
    const data = resolveFlywheelData({
      ...base,
      hasConventionalDataset: true,
      ratingsRegistered: true,
    });
    const warning = formatRatingsShadowWarning({
      data,
      specName: "concierge",
      ratingsRegistered: true,
      ratingsVersion: "v3",
    });
    expect(warning).toContain(CONVENTIONAL_DATASET);
    expect(warning).toContain("shadows");
    expect(warning).toContain("registry:concierge-ratings@v3");
    // The exact remediation flag, copy-pasteable.
    expect(warning).toContain("pass --dataset registry:concierge-ratings");
  });

  test("no warning when the flag chose the dataset or no ratings exist", () => {
    const flagged = resolveFlywheelData({
      ...base,
      datasetFlag: "my.jsonl",
      hasConventionalDataset: true,
      ratingsRegistered: true,
    });
    expect(
      formatRatingsShadowWarning({ data: flagged, specName: "concierge", ratingsRegistered: true }),
    ).toBeUndefined();
    const noRatings = resolveFlywheelData({ ...base, hasConventionalDataset: true });
    expect(
      formatRatingsShadowWarning({
        data: noRatings,
        specName: "concierge",
        ratingsRegistered: false,
      }),
    ).toBeUndefined();
  });

  test("the ratings-registry rung itself never warns (nothing is shadowed)", () => {
    const data = resolveFlywheelData({ ...base, ratingsRegistered: true });
    expect(
      formatRatingsShadowWarning({ data, specName: "concierge", ratingsRegistered: true }),
    ).toBeUndefined();
  });
});

// -------- git dirtiness --------

describe("D42 — --gate-split", () => {
  test("undefined is the default (all resolved splits, unchanged behavior)", () => {
    expect(parseGateSplit(undefined)).toBeUndefined();
    expect(
      gateSplitRefusal({ gateSplit: undefined, isRegistryRef: false, dataset: "eval/d.jsonl" }),
    ).toBeUndefined();
  });

  test("accepts train/dev case-insensitively", () => {
    expect(parseGateSplit("dev")).toBe("dev");
    expect(parseGateSplit(" TRAIN ")).toBe("train");
  });

  test("refuses #test with the B16 rationale", () => {
    expect(() => parseGateSplit("test")).toThrow(FlywheelConfigError);
    expect(() => parseGateSplit("test")).toThrow(/held-out split/);
  });

  test("refuses an unknown split", () => {
    expect(() => parseGateSplit("holdout")).toThrow(/expected one of: train, dev/);
  });

  test("refuses a flat-file dataset and names the fix", () => {
    const msg = gateSplitRefusal({
      gateSplit: "dev",
      isRegistryRef: false,
      dataset: "eval/dataset.jsonl",
    });
    expect(msg).toContain("needs a registry dataset with splits");
    expect(msg).toContain("datasets put");
    expect(
      gateSplitRefusal({ gateSplit: "dev", isRegistryRef: true, dataset: "registry:x" }),
    ).toBeUndefined();
  });

  test("discloses the narrowed gate on stdout", () => {
    const line = formatGateSplitLine({
      gateSplit: "dev",
      datasetName: "concierge-ratings@v3#dev",
      sampleCount: 12,
    });
    expect(line).toContain("concierge-ratings@v3#dev");
    expect(line).toContain("12 sample(s)");
    expect(line).toContain("dev split ONLY");
  });
});

describe("specIsDirty", () => {
  test("empty / whitespace porcelain is clean", () => {
    expect(specIsDirty("")).toBe(false);
    expect(specIsDirty("\n")).toBe(false);
  });
  test("any status line is dirty", () => {
    expect(specIsDirty(" M crewhaus.yaml\n")).toBe(true);
    expect(specIsDirty("?? crewhaus.yaml\n")).toBe(true);
  });
});

// -------- acceptance gate --------

describe("evaluateFlywheelAcceptance", () => {
  test("accepts a strict improvement with zero regressions", () => {
    const before = makeSummary("r1", [makeSample("a", false, 0), makeSample("b", true, 1)]);
    const after = makeSummary("r2", [makeSample("a", true, 1), makeSample("b", true, 1)]);
    const v = evaluateFlywheelAcceptance(before, after);
    expect(v.accepted).toBe(true);
    expect(v.recoveries).toBe(1);
    expect(v.regressions).toBe(0);
    expect(v.passRateBefore).toBe(0.5);
    expect(v.passRateAfter).toBe(1);
  });

  test("rejects a flat pass rate (must be STRICTLY up)", () => {
    const before = makeSummary("r1", [makeSample("a", true, 1), makeSample("b", false, 0)]);
    const after = makeSummary("r2", [makeSample("a", true, 1), makeSample("b", false, 0.2)]);
    const v = evaluateFlywheelAcceptance(before, after);
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("strictly");
  });

  test("rejects a pass-rate drop", () => {
    const before = makeSummary("r1", [makeSample("a", true, 1), makeSample("b", true, 1)]);
    const after = makeSummary("r2", [makeSample("a", true, 1), makeSample("b", false, 0)]);
    const v = evaluateFlywheelAcceptance(before, after);
    expect(v.accepted).toBe(false);
    expect(v.regressions).toBe(1);
  });

  test("H1 — NaN→NaN pass rates REJECT fail-closed (0-sample runs must never auto-accept)", () => {
    // 0/0 samples → passRate NaN on both sides. NaN satisfies neither
    // `<=` nor `>`, so the old `after <= before → reject` form ACCEPTED
    // this pair; the fail-closed gate must reject it with a clear reason.
    const before = makeSummary("r1", []);
    const after = makeSummary("r2", []);
    expect(Number.isNaN(before.aggregates.passRate)).toBe(true);
    expect(Number.isNaN(after.aggregates.passRate)).toBe(true);
    const v = evaluateFlywheelAcceptance(before, after);
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("fail-closed");
    expect(v.reason).toContain("NaN");
  });

  test("H1 — a one-sided NaN pass rate also rejects", () => {
    const before = makeSummary("r1", [makeSample("a", false, 0)]);
    const after = makeSummary("r2", []);
    const v = evaluateFlywheelAcceptance(before, after);
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain("fail-closed");
  });

  test("rejects a net improvement that hides a sample regression", () => {
    // 2 recoveries + 1 regression: pass rate goes UP but sample `c`
    // regressed — a single flip vetoes the patch (taste over averages).
    const before = makeSummary("r1", [
      makeSample("a", false, 0),
      makeSample("b", false, 0),
      makeSample("c", true, 1),
    ]);
    const after = makeSummary("r2", [
      makeSample("a", true, 1),
      makeSample("b", true, 1),
      makeSample("c", false, 0),
    ]);
    expect(after.aggregates.passRate).toBeGreaterThan(before.aggregates.passRate);
    const v = evaluateFlywheelAcceptance(before, after);
    expect(v.accepted).toBe(false);
    expect(v.regressions).toBe(1);
    expect(v.recoveries).toBe(2);
  });
});

// -------- the loop --------

describe("runFlywheelLoop", () => {
  const improved = {
    before: makeSummary("r1", [makeSample("a", false, 0), makeSample("b", true, 1)]),
    after: makeSummary("r2", [makeSample("a", true, 1), makeSample("b", true, 1)]),
  };
  const regressed = {
    before: makeSummary("r1", [makeSample("a", true, 1), makeSample("b", true, 1)]),
    after: makeSummary("r2", [makeSample("a", true, 1), makeSample("b", false, 0)]),
  };

  test("accept path: full order, applyAccepted runs exactly once", async () => {
    const log: HookLog = [];
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: false,
      hooks: makeHooks({ log, ...improved }),
    });
    expect(result.outcome).toBe("accepted");
    expect(log).toEqual([
      "compile:pre-optimize",
      "eval:before",
      "optimize",
      "compile:post-optimize",
      "eval:after",
      "apply",
    ]);
    expect(result.verdict?.accepted).toBe(true);
  });

  test("dry-run: acceptance verdict computed but nothing is written", async () => {
    const log: HookLog = [];
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: true,
      hooks: makeHooks({ log, ...improved }),
    });
    expect(result.outcome).toBe("accepted-dry-run");
    expect(result.reason).toContain("dry-run");
    expect(log).not.toContain("apply");
    expect(result.verdict?.accepted).toBe(true);
  });

  test("reject path: gate failure leaves the spec untouched (no apply, no revert needed)", async () => {
    const log: HookLog = [];
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: false,
      hooks: makeHooks({ log, ...regressed }),
    });
    expect(result.outcome).toBe("rejected");
    expect(log).not.toContain("apply");
    expect(result.verdict?.accepted).toBe(false);
  });

  test("no-improvement short-circuits: no post compile, no after eval", async () => {
    const log: HookLog = [];
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: false,
      hooks: makeHooks({ log, ...improved, optimize: { applied: false } }),
    });
    expect(result.outcome).toBe("no-improvement");
    expect(log).toEqual(["compile:pre-optimize", "eval:before", "optimize"]);
    expect(result.after).toBeUndefined();
  });

  test("patched spec that fails the compile gate → patch-compile-failed, no after eval, no apply", async () => {
    const log: HookLog = [];
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: false,
      hooks: makeHooks({ log, ...improved, failPostCompile: true }),
    });
    expect(result.outcome).toBe("patch-compile-failed");
    expect(result.reason).toContain("bad candidate yaml");
    expect(log).not.toContain("eval:after");
    expect(log).not.toContain("apply");
  });

  test("pre-optimize compile failure propagates (nothing was spent yet)", async () => {
    const log: HookLog = [];
    const hooks = makeHooks({ log, ...improved });
    const failing: FlywheelHooks = {
      ...hooks,
      compileCheck: () => {
        throw new Error("spec does not compile");
      },
    };
    await expect(
      runFlywheelLoop({ sourceYaml: "y", dryRun: false, hooks: failing }),
    ).rejects.toThrow("spec does not compile");
    expect(log).toEqual([]);
  });
});

// -------- report --------

describe("formatFlywheelReport", () => {
  test("accepted run reports scores, samples, spend, and artifacts on one screen", async () => {
    const before = makeSummary("r1", [makeSample("a", false, 0), makeSample("b", true, 1)]);
    const after = makeSummary("r2", [makeSample("a", true, 1), makeSample("b", true, 1)]);
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: false,
      hooks: makeHooks({ log: [], before, after }),
    });
    const lines = formatFlywheelReport(result, {
      specPath: "crewhaus.yaml",
      datasetName: "smoke",
      sampleCount: 2,
      budgetUsd: 2,
      artifactsDir: "/tmp/fly",
    });
    const text = lines.join("\n");
    expect(text).toContain("pass_rate: 50.0% → 100.0%");
    expect(text).toContain("1 recovered / 0 regressed");
    // H3 — the budget meters only the optimizer; the report line says so.
    expect(text).toContain("optimizer spend $0.0000 (optimizer budget $2.00)");
    expect(text).toContain("ACCEPTED");
    expect(text).toContain("artifacts: /tmp/fly");
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  test("rejected run says the spec was untouched", async () => {
    const before = makeSummary("r1", [makeSample("a", true, 1)]);
    const after = makeSummary("r2", [makeSample("a", false, 0)]);
    const result = await runFlywheelLoop({
      sourceYaml: "y",
      dryRun: false,
      hooks: makeHooks({ log: [], before, after }),
    });
    const text = formatFlywheelReport(result, {
      specPath: "crewhaus.yaml",
      datasetName: "smoke",
      sampleCount: 1,
      budgetUsd: 2,
      artifactsDir: "/tmp/fly",
    }).join("\n");
    expect(text).toContain("REJECTED — spec untouched");
  });
});

// -------- scaffolding --------

describe("scaffoldWorkflowFile", () => {
  test("writes the file, creating parent dirs", () => {
    const root = newTempRoot();
    const res = scaffoldWorkflowFile({
      rootDir: root,
      relPath: join(".github", "workflows", "x.yml"),
      content: "hello: 1\n",
      force: false,
    });
    expect(res.action).toBe("wrote");
    expect(readFileSync(res.path, "utf-8")).toBe("hello: 1\n");
  });

  test("refuses to overwrite an existing file without force", () => {
    const root = newTempRoot();
    const relPath = join(".github", "workflows", "x.yml");
    scaffoldWorkflowFile({ rootDir: root, relPath, content: "a\n", force: false });
    expect(() =>
      scaffoldWorkflowFile({ rootDir: root, relPath, content: "b\n", force: false }),
    ).toThrow("--force");
    expect(readFileSync(join(root, relPath), "utf-8")).toBe("a\n");
  });

  test("force overwrites", () => {
    const root = newTempRoot();
    const relPath = join(".github", "workflows", "x.yml");
    scaffoldWorkflowFile({ rootDir: root, relPath, content: "a\n", force: false });
    scaffoldWorkflowFile({ rootDir: root, relPath, content: "b\n", force: true });
    expect(readFileSync(join(root, relPath), "utf-8")).toBe("b\n");
  });
});

describe("normalizeHarnessDir", () => {
  test.each([
    [undefined, ""],
    ["", ""],
    [".", ""],
    ["./", ""],
    ["agents/concierge", "agents/concierge"],
    ["agents/concierge/", "agents/concierge"],
    ["./agents/concierge", "agents/concierge"],
    ["agents\\concierge", "agents/concierge"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeHarnessDir(input)).toBe(expected);
  });
});

describe("buildFlywheelWorkflowYaml", () => {
  const yaml = buildFlywheelWorkflowYaml();

  test("nightly cron + manual dispatch with budget knobs", () => {
    expect(yaml).toContain('cron: "13 7 * * *"');
    expect(yaml).toContain("workflow_dispatch:");
    // H3 — the input is named for what it meters (optimizer mutation calls
    // only); eval spend is billed outside it and the description says so.
    expect(yaml).toContain("optimizer_budget_usd:");
    expect(yaml).toContain("eval spend is billed separately");
    expect(yaml).toContain("iterations:");
  });

  test("steers the run with the demo's FLYWHEEL_* env knob names", () => {
    for (const knob of Object.values(FLYWHEEL_ENV_KNOBS)) {
      expect(yaml).toContain(`${knob}:`);
    }
    // H3 — the demo-continuity env name maps from the renamed input.
    expect(yaml).toContain(
      "FLYWHEEL_BUDGET_USD: ${{ github.event.inputs.optimizer_budget_usd || '2.00' }}",
    );
    expect(yaml).toContain("crewhaus flywheel run");
  });

  test("H5 — harnessDir points working-directory AND the artifact path at the subdir", () => {
    const nested = buildFlywheelWorkflowYaml({ harnessDir: "agents/concierge" });
    expect(nested).toContain("working-directory: agents/concierge");
    // actions paths don't honor working-directory — must be prefixed.
    expect(nested).toContain("path: agents/concierge/.crewhaus/flywheel/");
    // Root scaffold stays unprefixed with no working-directory override.
    expect(yaml).not.toContain("working-directory:");
    expect(yaml).toContain("path: .crewhaus/flywheel/");
  });

  test("opens a PR via gh and NEVER auto-merges", () => {
    expect(yaml).toContain("gh pr create");
    expect(yaml).not.toContain("gh pr merge");
    expect(yaml).toContain("NEVER");
  });

  test("single-flight concurrency group and artifact upload", () => {
    expect(yaml).toContain("cancel-in-progress: false");
    expect(yaml).toContain("actions/upload-artifact@v4");
    expect(yaml).toContain(".crewhaus/flywheel/");
  });

  test("requires the explicit PAT secret, not just GITHUB_TOKEN", () => {
    expect(yaml).toContain("FLYWHEEL_GH_TOKEN");
    expect(yaml).toContain("ANTHROPIC_API_KEY");
  });

  test("NEW-HUNT-8 — without --suite the document is byte-identical to before", () => {
    // The suite step is purely additive: a scaffold with no --suite must be
    // exactly the pre-NEW-HUNT-8 bytes (same pin the CI/sentinel scaffolds
    // carry).
    expect(buildFlywheelWorkflowYaml({})).toBe(yaml);
    expect(buildFlywheelWorkflowYaml({ harnessDir: "" })).toBe(yaml);
    expect(yaml).not.toContain("eval suite");
  });

  test("NEW-HUNT-8 — --suite appends a nightly-tier step that runs even on failure", () => {
    const tiered = buildFlywheelWorkflowYaml({ suite: "eval/suite.yaml" });
    expect(tiered.startsWith(yaml.trimEnd())).toBe(true);
    expect(tiered).toContain("crewhaus eval suite eval/suite.yaml --tier nightly --gate");
    // `if: always()` — an optimizer blow-up must not hide a tier regression.
    expect(tiered).toContain("if: always()");
    // It runs LAST, after the improvement PR is opened.
    expect(tiered.indexOf("eval suite")).toBeGreaterThan(tiered.indexOf("gh pr create"));
  });
});

describe("formatFlywheelKnobsGuide", () => {
  test("names every env knob with its default", () => {
    const text = formatFlywheelKnobsGuide().join("\n");
    for (const knob of Object.values(FLYWHEEL_ENV_KNOBS)) expect(text).toContain(knob);
    expect(text).toContain("2.00");
  });

  test("H3 — says eval spend is NOT metered by the optimizer budget", () => {
    const text = formatFlywheelKnobsGuide().join("\n");
    expect(text).toContain("ONLY the optimizer's mutation model calls");
    expect(text).toContain("NOT metered by this budget");
  });
});

// -------- CLI surface (spawned) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("crewhaus flywheel (CLI surface)", () => {
  test("flywheel init writes the workflow and refuses a second run without --force", async () => {
    const root = newTempRoot();
    const first = await runCli(["flywheel", "init"], root);
    expect(first.exitCode).toBe(0);
    const wfPath = join(root, ".github", "workflows", "crewhaus-flywheel.yml");
    expect(existsSync(wfPath)).toBe(true);
    expect(first.stdout).toContain("wrote");
    expect(first.stdout).toContain("FLYWHEEL_BUDGET_USD");

    const second = await runCli(["flywheel", "init"], root);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("--force");

    const forced = await runCli(["flywheel", "init", "--force"], root);
    expect(forced.exitCode).toBe(0);
  });

  test("NEW-HUNT-8 — flywheel init --suite wires the nightly tier and validates the path", async () => {
    const tieredRoot = newTempRoot();
    const outsideRoot = newTempRoot();
    mkdirSync(join(tieredRoot, "eval"), { recursive: true });
    writeFileSync(
      join(tieredRoot, "eval", "suite.yaml"),
      "tiers:\n  fast:\n    - name: smoke\n      dataset: eval/d.jsonl\n      graders: eval/g.yaml\n      thresholds: {min_pass_rate: 0.8}\n",
    );
    const [tiered, outside] = await Promise.all([
      runCli(["flywheel", "init", "--suite", "eval/suite.yaml"], tieredRoot),
      runCli(["flywheel", "init", "--suite", "../elsewhere/suite.yaml"], outsideRoot),
    ]);
    expect(tiered.exitCode).toBe(0);
    expect(
      readFileSync(join(tieredRoot, ".github", "workflows", "crewhaus-flywheel.yml"), "utf-8"),
    ).toBe(buildFlywheelWorkflowYaml({ suite: "eval/suite.yaml" }));
    expect(tiered.stdout).toContain("--tier nightly --gate");
    // The manifest declares no nightly tier — the cron job would fail nightly.
    expect(tiered.stderr).toContain("declares only: fast");
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toContain("inside the harness directory");
  }, 60_000);

  test("H5 — flywheel init from a repo subdir writes the workflow at the REPO ROOT", async () => {
    const root = newTempRoot();
    Bun.spawnSync(["git", "-C", root, "init", "-q"]);
    const harness = join(root, "agents", "concierge");
    mkdirSync(harness, { recursive: true });

    const res = await runCli(["flywheel", "init"], harness);
    expect(res.exitCode).toBe(0);
    // GitHub only reads .github/workflows at the repo root — nothing may
    // land inside the harness dir.
    expect(existsSync(join(root, ".github", "workflows", "crewhaus-flywheel.yml"))).toBe(true);
    expect(existsSync(join(harness, ".github"))).toBe(false);
    expect(res.stdout).toContain("repo root");

    const wf = readFileSync(join(root, ".github", "workflows", "crewhaus-flywheel.yml"), "utf-8");
    expect(wf).toContain("working-directory: agents/concierge");
    expect(wf).toContain("path: agents/concierge/.crewhaus/flywheel/");
  });

  test("unknown action dies with the allowed set", async () => {
    const root = newTempRoot();
    const res = await runCli(["flywheel", "spin"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('"init" or "run"');
  });

  test("flywheel run refuses a dirty spec in a git repo (invariant)", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n",
    );
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", root, ...a]);
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "crewhaus.yaml");
    git("commit", "-qm", "init");
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: edited\n",
    );

    const refused = await runCli(["flywheel", "run"], root);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("uncommitted");
    expect(refused.stderr).toContain("--allow-dirty");

    // --allow-dirty proceeds past the guard (and then dies on the missing
    // dataset default — proving the guard, not the loop, was the stopper).
    const allowed = await runCli(["flywheel", "run", "--allow-dirty"], root);
    expect(allowed.exitCode).toBe(1);
    expect(allowed.stderr).toContain("no dataset");
  });

  // D42 — the flag is parsed before any spend, and per-split gating is a
  // registry-only concept.
  test("flywheel run --gate-split test is refused before anything is spent", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n",
    );
    const res = await runCli(["flywheel", "run", "--gate-split", "test"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("held-out split");
  });

  test("flywheel run --gate-split over a flat-file dataset is refused", async () => {
    const root = newTempRoot();
    mkdirSync(join(root, "eval"), { recursive: true });
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n",
    );
    writeFileSync(
      join(root, "eval", "dataset.jsonl"),
      `${JSON.stringify({ id: "s1", input: "hello there" })}\n`,
    );
    writeFileSync(
      join(root, "eval", "graders.yaml"),
      "graders:\n  - name: g\n    type: contains\n    substring: 'x'\n",
    );
    const res = await runCli(["flywheel", "run", "--gate-split", "dev"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("needs a registry dataset with splits");
  });

  test("flywheel run without a spec dies with the harness-convention hint", async () => {
    const root = newTempRoot();
    const res = await runCli(["flywheel", "run"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("spec not found");
  });

  test("H4 — conventional dataset/graders are found beside a spec in a sibling dir", async () => {
    const root = newTempRoot();
    const harness = join(root, "harness");
    mkdirSync(join(harness, "eval"), { recursive: true });
    writeFileSync(
      join(harness, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n",
    );
    // Zero samples → a deterministic die that happens strictly AFTER data
    // resolution (and before anything paid), proving the conventional files
    // were found relative to the SPEC dir, not the cwd (which has no eval/).
    writeFileSync(join(harness, "eval", "dataset.jsonl"), "");
    writeFileSync(
      join(harness, "eval", "graders.yaml"),
      "graders:\n  - name: g\n    type: contains\n    substring: 'x'\n",
    );

    const res = await runCli(["flywheel", "run", join("harness", "crewhaus.yaml")], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).not.toContain("no dataset");
    expect(res.stderr).toContain("zero samples");
  });

  test("flywheel --help documents the loop, the knobs, and the invariants", async () => {
    const root = newTempRoot();
    const res = await runCli(["flywheel", "run", "--help"], root);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("acceptance gate");
    expect(res.stdout).toContain("FLYWHEEL_BUDGET_USD");
    expect(res.stdout).toContain("--dry-run");
    expect(res.stdout).toContain("permissions");
    // H3 — budget scope honesty (evals are billed outside the budget).
    expect(res.stdout).toContain("NOT metered by this budget");
    // B16 — registry refs resolve train+dev only; the locked test split
    // never enters the flywheel (supersedes the old ALL-splits disclosure).
    expect(res.stdout).toContain("train+dev only");
    expect(res.stdout).toContain("#test ref is refused");
    // D42 — the per-split acceptance knob is documented (it used to be
    // help text calling itself "a future knob").
    expect(res.stdout).toContain("--gate-split train|dev");
    expect(res.stdout).not.toContain("future knob");
    // D43 — the help must describe what THIS COMMAND does. Neither
    // `flywheel run` nor `optimize` passes `knobs` to optimizeSpec, so the
    // dial search is a library capability only; claiming the command patches
    // "the declared numeric dials" would be a shipped overclaim (and would
    // retire the accurate wording, making the gap undetectable).
    expect(res.stdout).toContain("only ever rewrites agent.instructions");
    expect(res.stdout).toContain("reachable programmatically");
    expect(res.stdout).not.toContain("ALL splits");
    // NEW-flywheel-shadow — the provenance line + shadow warning are documented.
    expect(res.stdout).toContain("flag|convention|ratings-registry");
    expect(res.stdout).toContain("shadows");
  });

  test("B16 — flywheel run refuses an explicit #test registry ref", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n",
    );
    mkdirSync(join(root, "eval"), { recursive: true });
    writeFileSync(
      join(root, "eval", "graders.yaml"),
      "graders:\n  - name: g\n    type: contains\n    substring: 'x'\n",
    );
    const res = await runCli(["flywheel", "run", "--dataset", "registry:golden#test"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("flywheel never runs over the test split");
    // NEW-flywheel-shadow — the provenance line printed before the refusal.
    expect(res.stdout).toContain("[flywheel] dataset: registry:golden#test (source: flag)");
  });

  test("NEW-flywheel-shadow — a conventional dataset shadowing ratings warns loudly", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\nfeedback:\n  enabled: true\n",
    );
    mkdirSync(join(root, "eval"), { recursive: true });
    // Zero samples → a deterministic die strictly AFTER data resolution (and
    // the provenance/shadow prints), before anything paid.
    writeFileSync(join(root, "eval", "dataset.jsonl"), "");
    writeFileSync(
      join(root, "eval", "graders.yaml"),
      "graders:\n  - name: g\n    type: contains\n    substring: 'x'\n",
    );
    const ratings = join(root, "ratings.jsonl");
    writeFileSync(ratings, '{"id":"r1","input":"hi","expected_output":"yo"}\n');
    expect(
      (await runCli(["datasets", "put", "hello-ratings", "--file", ratings], root)).exitCode,
    ).toBe(0);

    const res = await runCli(["flywheel", "run"], root);
    expect(res.exitCode).toBe(1);
    // The conventional path is spec-dir-absolute; assert the stable suffix.
    expect(res.stdout).toContain("[flywheel] dataset: ");
    expect(res.stdout).toContain(`${join("eval", "dataset.jsonl")} (source: convention)`);
    expect(res.stderr).toContain("shadows the distilled ratings dataset");
    expect(res.stderr).toContain("registry:hello-ratings@v1");
    expect(res.stderr).toContain("pass --dataset registry:hello-ratings");
  });

  test("NEW-flywheel-shadow — no shadow warning without a registered ratings dataset", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\nfeedback:\n  enabled: true\n",
    );
    mkdirSync(join(root, "eval"), { recursive: true });
    writeFileSync(join(root, "eval", "dataset.jsonl"), "");
    writeFileSync(
      join(root, "eval", "graders.yaml"),
      "graders:\n  - name: g\n    type: contains\n    substring: 'x'\n",
    );
    const res = await runCli(["flywheel", "run"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("(source: convention)");
    expect(res.stderr).not.toContain("shadows");
  });
});

/**
 * Unit tests for the item-45 flywheel core: knob/default resolution, the
 * acceptance gate, the accept-then-write loop (with injected step hooks —
 * no LLM/credentials needed), the report, and the workflow scaffold.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  formatFlywheelKnobsGuide,
  formatFlywheelReport,
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
    [{ iterations: "0" }, "--iterations"],
    [{ iterations: "2.5" }, "--iterations"],
    [{ concurrency: "-1" }, "--concurrency"],
    [{ seed: "abc" }, "--seed"],
  ])("invalid flag %j throws naming the flag", (flags, expected) => {
    expect(() => resolveFlywheelKnobs({ flags, env: {} })).toThrow(expected);
  });

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

// -------- git dirtiness --------

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
    expect(text).toContain("spend $0.0000 (budget $2.00)");
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

describe("buildFlywheelWorkflowYaml", () => {
  const yaml = buildFlywheelWorkflowYaml();

  test("nightly cron + manual dispatch with budget knobs", () => {
    expect(yaml).toContain('cron: "13 7 * * *"');
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("budget_usd:");
    expect(yaml).toContain("iterations:");
  });

  test("steers the run with the demo's FLYWHEEL_* env knob names", () => {
    for (const knob of Object.values(FLYWHEEL_ENV_KNOBS)) {
      expect(yaml).toContain(`${knob}:`);
    }
    expect(yaml).toContain("crewhaus flywheel run");
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
});

describe("formatFlywheelKnobsGuide", () => {
  test("names every env knob with its default", () => {
    const text = formatFlywheelKnobsGuide().join("\n");
    for (const knob of Object.values(FLYWHEEL_ENV_KNOBS)) expect(text).toContain(knob);
    expect(text).toContain("2.00");
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

  test("flywheel run without a spec dies with the harness-convention hint", async () => {
    const root = newTempRoot();
    const res = await runCli(["flywheel", "run"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("spec not found");
  });

  test("flywheel --help documents the loop, the knobs, and the invariants", async () => {
    const root = newTempRoot();
    const res = await runCli(["flywheel", "run", "--help"], root);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("acceptance gate");
    expect(res.stdout).toContain("FLYWHEEL_BUDGET_USD");
    expect(res.stdout).toContain("--dry-run");
    expect(res.stdout).toContain("permissions");
  });
});

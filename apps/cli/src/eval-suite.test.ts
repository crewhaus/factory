/**
 * NEW-HUNT-8 — `crewhaus eval suite`: manifest schema, tier selection, the
 * per-entry argument lowering, the preflight, and the threshold/suite
 * verdicts. Pure + offline (the run loop itself lives in index.ts and is
 * exercised through the CLI's refusal paths, which all resolve before any
 * model spend).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SUITE_TIER,
  type EntryAggregates,
  EvalSuiteError,
  SUITE_TIERS,
  type SuiteEntryOutcome,
  aggregateSuite,
  buildEntryEvalArgs,
  entryAggregatesFromResults,
  evaluateEntryThresholds,
  parseSuiteManifest,
  parseTierFlag,
  renderSuiteSummary,
  selectTier,
  specForEntry,
  suitePreflight,
} from "./eval-suite";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-eval-suite-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = `
name: brewbird
spec: crewhaus.yaml
tiers:
  fast:
    - name: smoke
      dataset: eval/smoke.jsonl
      graders: eval/graders.yaml
      seed: 1
      concurrency: 1
      thresholds:
        min_pass_rate: 0.8
  nightly:
    - name: full
      dataset: "registry:brewbird-golden"
      graders: eval/graders.yaml
      repeats: 3
      slice: [family, difficulty]
      gate: true
      allow_test_split: false
    - name: adversarial
      dataset: "registry:brewbird-redteam"
      graders: eval/redteam-graders.yaml
      gate: true
      thresholds:
        min_mean_score: 0.7
        max_cost_usd: 2
`;

describe("suite manifest schema", () => {
  test("parses tiers, entries and their flags", () => {
    const manifest = parseSuiteManifest(MANIFEST);
    expect(manifest.name).toBe("brewbird");
    expect(manifest.tiers.fast).toHaveLength(1);
    expect(manifest.tiers.nightly).toHaveLength(2);
    expect(manifest.tiers.nightly?.[0]?.slice).toEqual(["family", "difficulty"]);
    expect(manifest.tiers.release).toBeUndefined();
  });

  test("is STRICT — a typo'd key is a refusal, never a silently skipped gate", () => {
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      threshold: {min_pass_rate: 0.9}\n",
      ),
    ).toThrow(/threshold/);
    expect(() =>
      parseSuiteManifest("tiers:\n  smoke:\n    - name: a\n      dataset: d\n      graders: g\n"),
    ).toThrow(EvalSuiteError);
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      thresholds: {min_pass_rate: 1.4}\n",
      ),
    ).toThrow(EvalSuiteError);
  });

  test("refuses an empty manifest, an empty tier and duplicate entry names", () => {
    expect(() => parseSuiteManifest("tiers: {}\n")).toThrow(/at least one tier/);
    expect(() => parseSuiteManifest("tiers:\n  fast: []\n")).toThrow(EvalSuiteError);
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n    - name: a\n      dataset: e\n      graders: g\n",
      ),
    ).toThrow(/duplicate entry name/);
  });

  test("an entry with NO gating criteria can never fail — and is refused", () => {
    // Neither thresholds nor `gate: true`: `passed` would be true whatever
    // the entry measured, and the tier line would report PASS while the
    // scaffolded CI job treats it as a required check.
    expect(() =>
      parseSuiteManifest("tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n"),
    ).toThrow(/declares no gating criteria/);
    // Either mechanism alone satisfies it.
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      gate: true\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      thresholds: {min_mean_score: 0.5}\n",
      ),
    ).not.toThrow();
    // An EMPTY thresholds map is not a criterion either.
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      thresholds: {}\n",
      ),
    ).toThrow(/declares no gating criteria/);
  });

  test("a baseline-gate ceiling without `gate: true` is dead config — and is refused", () => {
    // max_p95_latency_ms / max_cost_usd only bite through the baseline gate;
    // accepting them without it would look like a ceiling and enforce nothing.
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      thresholds: {max_cost_usd: 1}\n",
      ),
    ).toThrow(/gate: true/);
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      gate: true\n      thresholds: {max_cost_usd: 1, max_p95_latency_ms: 100}\n",
      ),
    ).not.toThrow();
    // Absolute floors need no baseline and stay gate-free.
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      thresholds: {min_pass_rate: 0.9}\n",
      ),
    ).not.toThrow();
  });

  test("entry names must be directory-safe (they ARE the run directories)", () => {
    expect(() =>
      parseSuiteManifest(
        "tiers:\n  fast:\n    - name: ../escape\n      dataset: d\n      graders: g\n",
      ),
    ).toThrow(EvalSuiteError);
  });

  test("malformed YAML fails as a suite error, not a stack trace", () => {
    expect(() => parseSuiteManifest("tiers: [\n")).toThrow(/not valid YAML/);
  });
});

describe("tier selection", () => {
  const manifest = parseSuiteManifest(MANIFEST);

  test("--tier defaults to the per-change rung and validates the vocabulary", () => {
    expect(parseTierFlag(undefined)).toBe(DEFAULT_SUITE_TIER);
    expect(DEFAULT_SUITE_TIER).toBe("fast");
    for (const tier of SUITE_TIERS) expect(parseTierFlag(tier)).toBe(tier);
    expect(() => parseTierFlag("smoke")).toThrow(/fast \| nightly \| release/);
  });

  test("selectTier returns that tier's entries only", () => {
    expect(selectTier(manifest, "fast").map((e) => e.name)).toEqual(["smoke"]);
    expect(selectTier(manifest, "nightly").map((e) => e.name)).toEqual(["full", "adversarial"]);
  });

  test("an undeclared tier names what IS declared instead of passing vacuously", () => {
    expect(() => selectTier(manifest, "release")).toThrow(/declared tiers: fast, nightly/);
  });
});

describe("entry → eval arguments", () => {
  const manifest = parseSuiteManifest(MANIFEST);

  test("lowers dataset/graders/flags into the ordinary eval argument shape", () => {
    const entry = selectTier(manifest, "nightly")[0];
    const args = buildEntryEvalArgs({
      manifest,
      entry: entry as NonNullable<typeof entry>,
      outDir: "/out/full",
    });
    expect(args.positional).toEqual(["crewhaus.yaml"]);
    expect(args.flags["dataset"]).toBe("registry:brewbird-golden");
    expect(args.flags["graders"]).toBe("eval/graders.yaml");
    expect(args.flags["out"]).toBe("/out/full");
    expect(args.flags["repeats"]).toBe("3");
    expect(args.flags["slice"]).toBe("family,difficulty");
    expect(args.flags["gate"]).toBe(true);
    // false must not become a flag — `allow_test_split: false` is the default.
    expect(args.flags["allow-test-split"]).toBeUndefined();
  });

  test("threshold ceilings thread into the baseline gate's own flags", () => {
    const entry = selectTier(manifest, "nightly")[1];
    const args = buildEntryEvalArgs({
      manifest,
      entry: entry as NonNullable<typeof entry>,
      outDir: "/out/adversarial",
    });
    expect(args.flags["max-cost-usd"]).toBe("2");
    expect(args.flags["max-p95-latency-ms"]).toBeUndefined();
    // Absolute floors are the suite's own business, never eval flags.
    expect(args.flags["min-mean-score"]).toBeUndefined();
  });

  test("spec resolution is --spec > entry > manifest, and a spec-less entry refuses", () => {
    const entry = selectTier(manifest, "fast")[0] as NonNullable<
      ReturnType<typeof selectTier>[number]
    >;
    expect(specForEntry(manifest, entry)).toBe("crewhaus.yaml");
    expect(specForEntry(manifest, entry, "/base/crewhaus.yaml")).toBe("/base/crewhaus.yaml");
    expect(specForEntry(manifest, { ...entry, spec: "other.yaml" })).toBe("other.yaml");
    const specless = parseSuiteManifest(
      "tiers:\n  fast:\n    - name: a\n      dataset: d\n      graders: g\n      gate: true\n",
    );
    expect(() =>
      specForEntry(specless, selectTier(specless, "fast")[0] as NonNullable<typeof entry>),
    ).toThrow(/no spec/);
  });
});

describe("preflight", () => {
  const manifest = parseSuiteManifest(MANIFEST);

  test("refuses missing spec/dataset/graders BEFORE anything is spent", () => {
    const present = new Set(["crewhaus.yaml", "eval/graders.yaml"]);
    const refusals = suitePreflight({
      manifest,
      entries: selectTier(manifest, "fast"),
      exists: (p) => present.has(p),
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("eval/smoke.jsonl");
  });

  test("registry: and http datasets resolve at run time and are not preflighted", () => {
    const present = new Set(["crewhaus.yaml", "eval/graders.yaml", "eval/redteam-graders.yaml"]);
    const refusals = suitePreflight({
      manifest,
      entries: selectTier(manifest, "nightly"),
      exists: (p) => present.has(p),
    });
    expect(refusals).toEqual([]);
  });

  test("a --spec override is what gets checked", () => {
    const refusals = suitePreflight({
      manifest,
      entries: selectTier(manifest, "fast"),
      specOverride: "/base/crewhaus.yaml",
      exists: (p) => p !== "/base/crewhaus.yaml",
    });
    expect(refusals.some((r) => r.includes("/base/crewhaus.yaml"))).toBe(true);
  });
});

describe("verdicts", () => {
  const aggregates = (over: Partial<EntryAggregates> = {}): EntryAggregates => ({
    passRate: 0.9,
    meanScore: 0.85,
    sampleCount: 10,
    ...over,
  });

  test("absolute thresholds gate from run one", () => {
    expect(evaluateEntryThresholds(aggregates(), { min_pass_rate: 0.8 })).toEqual([]);
    expect(
      evaluateEntryThresholds(aggregates({ passRate: 0.5 }), { min_pass_rate: 0.8 })[0],
    ).toContain("pass_rate 50.0% < min_pass_rate 80.0%");
    expect(
      evaluateEntryThresholds(aggregates({ meanScore: 0.2 }), { min_mean_score: 0.7 })[0],
    ).toContain("mean_score 0.200 < min_mean_score 0.700");
  });

  test("no thresholds declared = nothing to breach", () => {
    expect(evaluateEntryThresholds(aggregates({ passRate: 0 }), undefined)).toEqual([]);
  });

  test("a PARTIAL (budget-exhausted) run can never clear a floor", () => {
    const failures = evaluateEntryThresholds(aggregates({ partial: true }), { min_pass_rate: 0.1 });
    expect(failures[0]).toContain("PARTIAL");
  });

  test("results.json → aggregates reads `partial` STRUCTURALLY, not by presence", () => {
    const complete = { aggregates: { passRate: 0.9, meanScore: 0.8 }, samples: [1, 2, 3] };
    expect(entryAggregatesFromResults(complete)).toEqual({
      passRate: 0.9,
      meanScore: 0.8,
      sampleCount: 3,
    });
    // The runner writes `partial` as an OBJECT; only that is a partial run.
    expect(
      entryAggregatesFromResults({
        ...complete,
        partial: { completedSamples: 2, totalSamples: 3 },
      })?.partial,
    ).toBe(true);
    // A falsy `partial` must NOT hard-fail the entry — keying on presence
    // would read `partial: false` as "budget exhausted".
    for (const falsy of [false, null, 0, ""]) {
      expect(entryAggregatesFromResults({ ...complete, partial: falsy })?.partial).toBeUndefined();
    }
    // Not a measurement at all.
    expect(entryAggregatesFromResults({ aggregates: {} })).toBeUndefined();
    expect(entryAggregatesFromResults(null)).toBeUndefined();
    expect(entryAggregatesFromResults("nope")).toBeUndefined();
  });

  test("a tier passes only when EVERY entry passes", () => {
    const entry = (name: string, passed: boolean): SuiteEntryOutcome => ({
      name,
      dataset: "d",
      graders: "g",
      outDir: `/out/${name}`,
      passed,
      failures: passed ? [] : ["pass_rate 10.0% < min_pass_rate 80.0%"],
      aggregates: aggregates(),
      errored: false,
    });
    const base = {
      suiteName: "s",
      tier: "fast" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      outDir: "/out",
    };
    expect(aggregateSuite({ ...base, entries: [entry("a", true), entry("b", true)] }).passed).toBe(
      true,
    );
    expect(aggregateSuite({ ...base, entries: [entry("a", true), entry("b", false)] }).passed).toBe(
      false,
    );
    // A tier with nothing in it is not a pass.
    expect(aggregateSuite({ ...base, entries: [] }).passed).toBe(false);
  });

  test("the summary names every entry and why it failed", () => {
    const result = aggregateSuite({
      suiteName: "brewbird",
      tier: "fast",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      outDir: "/out",
      entries: [
        {
          name: "smoke",
          dataset: "d",
          graders: "g",
          outDir: "/out/smoke",
          passed: false,
          failures: ["pass_rate 10.0% < min_pass_rate 80.0%"],
          aggregates: aggregates({ passRate: 0.1 }),
          errored: false,
        },
      ],
    });
    const text = renderSuiteSummary(result);
    expect(text).toContain("brewbird tier=fast: FAIL (0/1 entries passed)");
    expect(text).toContain("FAIL  smoke");
    expect(text).toContain("min_pass_rate");
    expect(text).toContain("/out/suite.json");
  });
});

// -------- CLI surface (spawned; every case resolves before model spend) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const HELLO_SPEC = join(SRC_DIR, "..", "test-fixtures", "minimal-cli", "crewhaus.yaml");

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_DATASETS_DIR: join(cwd, "datasets"),
    },
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

const SPEC_YAML = "name: helper\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n";

describe("crewhaus eval suite (CLI)", () => {
  test("--help documents the tiers and exits 0", async () => {
    const root = newTempRoot();
    const res = await runCli(["eval", "suite", "--help"], root);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("crewhaus eval suite <suite.yaml>");
    expect(res.stdout).toContain("fast | nightly | release");
  }, 60_000);

  test("refuses a bad manifest, an undeclared tier and missing files — before any spend", async () => {
    const badRoot = newTempRoot();
    const tierRoot = newTempRoot();
    const missingRoot = newTempRoot();
    for (const dir of [badRoot, tierRoot, missingRoot]) {
      writeFileSync(join(dir, "crewhaus.yaml"), SPEC_YAML);
    }
    writeFileSync(join(badRoot, "suite.yaml"), "tiers:\n  smoke:\n    - name: a\n");
    writeFileSync(
      join(tierRoot, "suite.yaml"),
      "spec: crewhaus.yaml\ntiers:\n  fast:\n    - name: a\n      dataset: d.jsonl\n      graders: g.yaml\n      gate: true\n",
    );
    writeFileSync(
      join(missingRoot, "suite.yaml"),
      "spec: crewhaus.yaml\ntiers:\n  fast:\n    - name: a\n      dataset: nope.jsonl\n      graders: nope.yaml\n      gate: true\n",
    );
    // Independent cases → concurrent spawns + an explicit CI ceiling.
    const [bad, tier, missing] = await Promise.all([
      runCli(["eval", "suite", "suite.yaml"], badRoot),
      runCli(["eval", "suite", "suite.yaml", "--tier", "release"], tierRoot),
      runCli(["eval", "suite", "suite.yaml"], missingRoot),
    ]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("invalid suite manifest");
    expect(tier.exitCode).toBe(1);
    expect(tier.stderr).toContain('declares no "release" tier');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("refused before any run");
    expect(missing.stderr).toContain("nope.jsonl");
    // A refused suite writes nothing.
    expect(existsSync(join(missingRoot, ".crewhaus", "evals"))).toBe(false);
  }, 60_000);

  test("a spec file literally named suite.yaml still takes the run path", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "suite.yaml"), SPEC_YAML);
    // No --dataset → the RUN path's own refusal, not the suite parser's.
    const res = await runCli(["eval", "suite.yaml"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--dataset");
  }, 60_000);

  test("an unreadable manifest path dies cleanly", async () => {
    const root = newTempRoot();
    const res = await runCli(["eval", "suite", "nope.yaml"], root);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("could not read");
  }, 60_000);

  test("runs the tier end to end: entry run dirs, suite.json, verdict, --gate exit code", async () => {
    // The spawned CLI gets PATH only, so the agent call fails at model
    // construction: the entry still RUNS (errored sample, results.json
    // written) and the absolute threshold catches it — which is exactly the
    // path a real failing tier takes, without any model spend.
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), readFileSync(HELLO_SPEC, "utf-8"));
    writeFileSync(join(root, "d.jsonl"), '{"id":"q1","input":"hi","expected_output":"hi"}\n');
    writeFileSync(
      join(root, "g.yaml"),
      'graders:\n  - name: nonempty\n    type: regex\n    pattern: "."\n',
    );
    writeFileSync(
      join(root, "suite.yaml"),
      "name: smoke-suite\nspec: crewhaus.yaml\ntiers:\n  fast:\n    - name: smoke\n      dataset: d.jsonl\n      graders: g.yaml\n      seed: 1\n      concurrency: 1\n      thresholds:\n        min_pass_rate: 0.9\n",
    );

    const reported = await runCli(["eval", "suite", "suite.yaml", "-o", "out"], root);
    // Report-only: a failing tier is data, not an exit code.
    expect(reported.exitCode).toBe(0);
    expect(existsSync(join(root, "out", "smoke", "results.json"))).toBe(true);
    const summary = JSON.parse(readFileSync(join(root, "out", "suite.json"), "utf-8"));
    expect(summary.tier).toBe("fast");
    expect(summary.passed).toBe(false);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].name).toBe("smoke");
    expect(summary.entries[0].failures.join(" ")).toContain("min_pass_rate");
    expect(reported.stdout).toContain("smoke-suite tier=fast: FAIL");

    // The same tier under --gate is a non-zero exit.
    const gated = await runCli(["eval", "suite", "suite.yaml", "-o", "out-gated", "--gate"], root);
    expect(gated.exitCode).toBe(1);
    expect(gated.stderr).toContain('tier "fast" failed');
    expect(existsSync(join(root, "out-gated", "suite.json"))).toBe(true);
  }, 120_000);
});

describe("suite.json is the machine-readable verdict", () => {
  test("its shape survives a JSON round-trip", () => {
    const result = aggregateSuite({
      suiteName: "s",
      tier: "nightly",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      outDir: "/out",
      entries: [
        {
          name: "a",
          dataset: "d",
          graders: "g",
          outDir: "/out/a",
          passed: true,
          failures: [],
          aggregates: { passRate: 1, meanScore: 1, sampleCount: 3 },
          errored: false,
        },
      ],
    });
    const root = newTempRoot();
    const path = join(root, "suite.json");
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    const reloaded = JSON.parse(readFileSync(path, "utf-8"));
    expect(reloaded.passed).toBe(true);
    expect(reloaded.tier).toBe("nightly");
    expect(reloaded.entries[0].aggregates.passRate).toBe(1);
  });
});

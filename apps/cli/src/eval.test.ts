/**
 * CLI integration test for `crewhaus eval` and `crewhaus eval-report diff`.
 *
 * NOTE: The existing index.test.ts asserts on stdout text via Bun.spawn, which
 * is broken on Bun 1.3.13 in `bun test` mode (stdout pipes return empty even
 * though the subprocess wrote output — confirmed by reproducing on `main`).
 * This test stays robust to that regression by asserting on file existence
 * + JSON shape rather than stdout strings.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(SRC_DIR, "index.ts");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-eval-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/**
 * Default spawn cwd. `crewhaus eval` finishes a run by appending to the run
 * history index, and that root (`@crewhaus/eval-report`'s
 * `DEFAULT_EVALS_DIR = ".crewhaus/evals"`) is RELATIVE — it resolves against
 * the child's cwd, and no flag or env var here overrides it. With cwd at the
 * repo root a credentialed run therefore appended to the operator's own
 * `.crewhaus/evals/index.jsonl` and `baselines.json`, which `.gitignore`
 * hides. `CREWHAUS_DATASETS_DIR` below already pins the sibling registry for
 * the same reason; this pins the rest.
 */
const SPAWN_CWD = newTempRoot();

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string = SPAWN_CWD,
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      // Hermetic dataset registry per invocation: `crewhaus eval` unions the
      // per-spec `<specName>-regressions` suite (item 9) from the registry
      // under the cwd by default, and `optimize` PINS into it — running with
      // cwd=REPO_ROOT would read/write the shared checkout's
      // `.crewhaus/datasets`, so a suite pinned by any earlier live run
      // would silently grow this test's sample set (observed: a stale
      // `hello-regressions` made the 2-sample dataset grade 3 samples).
      CREWHAUS_DATASETS_DIR: join(newTempRoot(), "datasets"),
      // CREWHAUS_EVAL_STUB short-circuits the runner to use a deterministic
      // stub model — set in the spawned process via env. The runner picks
      // this up in a future iteration; for now we use the invoker injection
      // path inside the stub-mode spec file.
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return { exitCode };
}

describe("crewhaus eval CLI integration (T3)", () => {
  // Stub-mode is wired via a deterministic spec that returns the
  // expected_output verbatim; we exercise the orchestration path
  // (parse spec → load dataset → run graders → render report) but
  // skip the live LLM call. This is the same pattern the eval-runner
  // unit tests use, just lifted to the CLI subprocess boundary.

  test("eval subcommand creates results.json + index.html + per-sample dirs", async () => {
    const out = newTempRoot();
    const dataset = join(out, "dataset.jsonl");
    const graders = join(out, "graders.yaml");
    writeFileSync(
      dataset,
      [
        '{"id":"q1","input":"hi","expected_output":"hi"}',
        '{"id":"q2","input":"yo","expected_output":"yo"}',
      ].join("\n"),
    );
    writeFileSync(graders, "graders:\n  - name: math\n    type: contains\n    substring: 'q'\n");

    // We can't easily inject a stub into the CLI subprocess without
    // adding a new flag, so we test the orchestration via a grader that
    // doesn't depend on the agent's actual response — `contains: q` will
    // never match the real Claude output for the prompt "hi". The test's
    // job is to verify the pipeline runs end-to-end and produces the
    // expected artifacts, not that the agent answers correctly.
    //
    // Skipping when no auth is available — the test would block on the SDK.
    if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
      // No credentials → can't reach the real model. Skip so CI without
      // secrets still passes; the smoke test exercises the live path.
      return;
    }

    const result = await runCli([
      "eval",
      HELLO_SPEC,
      "--dataset",
      dataset,
      "--graders",
      graders,
      "--concurrency",
      "1",
      "-o",
      join(out, "out"),
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "out", "results.json"))).toBe(true);
    expect(existsSync(join(out, "out", "index.html"))).toBe(true);
    expect(existsSync(join(out, "out", "run.json"))).toBe(true);

    const results = JSON.parse(readFileSync(join(out, "out", "results.json"), "utf-8"));
    expect(results.samples).toHaveLength(2);
    expect(results.runId).toMatch(/^run_[0-9a-f]{16}$/);
    expect(typeof results.aggregates.passRate).toBe("number");
    expect(existsSync(join(out, "out", "q1", "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(out, "out", "q1", "events.jsonl"))).toBe(true);
    expect(existsSync(join(out, "out", "q1", "grades.json"))).toBe(true);
    expect(existsSync(join(out, "out", "q1", "meta.json"))).toBe(true);
  }, 60_000);

  test("eval --help exits 0", async () => {
    const result = await runCli(["eval", "--help"]);
    expect(result.exitCode).toBe(0);
  });

  test("eval rejects missing --dataset", async () => {
    const result = await runCli(["eval", HELLO_SPEC]);
    expect(result.exitCode).toBe(1);
  });

  // Loop contract 0.4 (Batch B, G15) — `--repeats` is validated strictly and
  // BEFORE any dataset load or model spend, so these need no credentials.
  test("eval rejects a non-positive, fractional, or non-numeric --repeats", async () => {
    const base = ["eval", HELLO_SPEC, "--dataset", "d.jsonl", "--graders", "g.yaml"];
    for (const bad of ["0", "-2", "3.5", "two", "3x"]) {
      const result = await runCli([...base, "--repeats", bad]);
      expect(result.exitCode).toBe(1);
    }
  });

  // B13 — `--slice` is validated the same way: blank keys die loudly before
  // any dataset load or model spend, so these need no credentials.
  test("eval rejects blank --slice keys", async () => {
    const base = ["eval", HELLO_SPEC, "--dataset", "d.jsonl", "--graders", "g.yaml"];
    for (const bad of ["", " ", "difficulty,,family", "difficulty, ,family"]) {
      const result = await runCli([...base, "--slice", bad]);
      expect(result.exitCode).toBe(1);
    }
  });

  // C30 / NEW-HUNT-3 — the gate-threshold and runtime-ceiling flags are
  // validated up front too: a typo dies before any dataset load or spend,
  // so none of these need credentials.
  test("eval rejects malformed threshold/timeout/budget flag values", async () => {
    const base = ["eval", HELLO_SPEC, "--dataset", "d.jsonl", "--graders", "g.yaml"];
    const bads: Array<[string, string]> = [
      ["--max-p95-latency-ms", "-1"],
      ["--max-p95-latency-ms", "abc"],
      ["--max-cost-usd", "-0.5"],
      ["--max-cost-usd", "x"],
      ["--sample-timeout-ms", "0"],
      ["--sample-timeout-ms", "1.5"],
      ["--sample-timeout-ms", "abc"],
      ["--budget-usd", "0"],
      ["--budget-usd", "-1"],
      ["--budget-usd", "x"],
    ];
    // Spawned concurrently: each case is an arg-parse rejection that exits
    // before touching the registry, and ten sequential CLI boots overrun the
    // default per-test timeout on a slow runner.
    const results = await Promise.all(
      bads.map(async ([flag, value]) => ({ flag, ...(await runCli([...base, flag, value])) })),
    );
    for (const { flag, exitCode } of results) {
      expect(`${flag}:${exitCode}`).toBe(`${flag}:1`);
    }
  }, 60_000);

  test("eval rejects the gate thresholds with --models and --sentinel (which skip the gate)", async () => {
    const base = ["eval", HELLO_SPEC, "--dataset", "d.jsonl", "--graders", "g.yaml"];
    const matrix = await runCli([
      ...base,
      "--models",
      "claude-sonnet-4-5,claude-haiku-4-5",
      "--max-cost-usd",
      "2",
    ]);
    expect(matrix.exitCode).toBe(1);
    const sentinel = await runCli([
      ...base,
      "--sentinel",
      "--baseline",
      "does-not-matter",
      "--max-p95-latency-ms",
      "500",
    ]);
    expect(sentinel.exitCode).toBe(1);
  });

  test("eval-report --help exits 0", async () => {
    const result = await runCli(["eval-report", "--help"]);
    expect(result.exitCode).toBe(0);
  });

  test("eval-report rejects unknown action", async () => {
    const result = await runCli(["eval-report", "bogus"]);
    expect(result.exitCode).toBe(1);
  });
});

describe("crewhaus eval-report history/baseline (run-history item 3)", () => {
  // stdout assertions are avoided (see note at the top of this file) —
  // assert on exit codes and on-disk side effects instead.

  function indexEntry(runId: string): string {
    return `${JSON.stringify({
      runId,
      specName: "concierge",
      specHash: "abc123",
      datasetName: "smoke",
      datasetHash: "d".repeat(64),
      gradersHash: "g".repeat(64),
      judgeModel: "judge-model-x",
      passRate: 0.8,
      meanScore: 0.75,
      sampleCount: 5,
      ts: "2026-07-01T00:00:00.000Z",
      outDir: `/abs/evals/${runId}`,
    })}\n`;
  }

  test("history exits 0 with no index and with filters", async () => {
    const root = newTempRoot();
    expect((await runCli(["eval-report", "history"], root)).exitCode).toBe(0);
    mkdirSync(join(root, ".crewhaus", "evals"), { recursive: true });
    writeFileSync(
      join(root, ".crewhaus", "evals", "index.jsonl"),
      indexEntry("run_aaaa1111aaaa1111"),
    );
    expect((await runCli(["eval-report", "history"], root)).exitCode).toBe(0);
    expect(
      (await runCli(["eval-report", "history", "--spec", "concierge", "--dataset", "smoke"], root))
        .exitCode,
    ).toBe(0);
  });

  test("baseline show exits 0 with no pins", async () => {
    const root = newTempRoot();
    expect((await runCli(["eval-report", "baseline", "show"], root)).exitCode).toBe(0);
  });

  test("baseline set pins a recorded run into baselines.json", async () => {
    const root = newTempRoot();
    const evalsDir = join(root, ".crewhaus", "evals");
    mkdirSync(evalsDir, { recursive: true });
    writeFileSync(
      join(evalsDir, "index.jsonl"),
      indexEntry("run_aaaa1111aaaa1111") + indexEntry("run_bbbb2222bbbb2222"),
    );
    const result = await runCli(["eval-report", "baseline", "set", "run_aaaa1111aaaa1111"], root);
    expect(result.exitCode).toBe(0);
    const baselines = JSON.parse(readFileSync(join(evalsDir, "baselines.json"), "utf-8"));
    expect(baselines["concierge::smoke"]).toMatchObject({
      runId: "run_aaaa1111aaaa1111",
      specName: "concierge",
      datasetName: "smoke",
      outDir: "/abs/evals/run_aaaa1111aaaa1111",
      // Instrument identity must be carried forward onto manual pins so
      // gradersHash/judgeModel mismatch detection keeps working.
      gradersHash: "g".repeat(64),
      judgeModel: "judge-model-x",
    });
    // `baseline show` over the pin still exits 0.
    expect((await runCli(["eval-report", "baseline", "show"], root)).exitCode).toBe(0);
  });

  test("baseline set rejects a runId absent from the index", async () => {
    const root = newTempRoot();
    const result = await runCli(["eval-report", "baseline", "set", "run_ffff9999ffff9999"], root);
    expect(result.exitCode).toBe(1);
  });

  test("baseline set rejects a missing runId argument", async () => {
    const root = newTempRoot();
    expect((await runCli(["eval-report", "baseline", "set"], root)).exitCode).toBe(1);
  });

  test("baseline rejects unknown sub-action", async () => {
    const root = newTempRoot();
    expect((await runCli(["eval-report", "baseline", "bogus"], root)).exitCode).toBe(1);
  });
});

describe("crewhaus eval-report diff — C29 significance + B13 slice deltas", () => {
  /** Stderr-capturing variant (the datasets-cli.test.ts pattern: read the
   *  pipe CONCURRENTLY with the exit — the Bun 1.3.x capture regression
   *  bites only read-after-exit stdout). */
  async function runCliStderr(
    args: ReadonlyArray<string>,
    cwd: string,
  ): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
      cwd,
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
  }

  type FixtureSample = { id: string; passed: boolean; score: number };
  /** Write a minimal-but-faithful results.json run dir for `loadRun`. */
  function writeRunDir(
    root: string,
    name: string,
    samples: ReadonlyArray<FixtureSample>,
    slices?: Record<string, Record<string, unknown>>,
  ): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const summary = {
      runId: `run_${name
        .replace(/[^a-z0-9]/g, "0")
        .padEnd(16, "0")
        .slice(0, 16)}`,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:30Z",
      samples: samples.map((s) => ({
        sampleId: s.id,
        sessionId: `sess_${s.id.padEnd(16, "0")}`,
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
        latencyMs: 100,
        turns: 1,
        tokens: { input: 10, output: 20 },
        model: "claude-opus-4-7",
        agentOutput: s.passed ? "correct" : "wrong",
        grades: {
          overall: { passed: s.passed, score: s.score, rationale: s.passed ? "ok" : "nope" },
          perGrader: [{ name: "exact", passed: s.passed, score: s.score, rationale: "" }],
        },
      })),
      aggregates: {
        passRate: samples.filter((s) => s.passed).length / Math.max(samples.length, 1),
        meanScore: 0.5,
        p50Turns: 1,
        p95Turns: 1,
        p50LatencyMs: 100,
        p95LatencyMs: 100,
        totalTokens: { input: 10, output: 20 },
        errorCount: 0,
      },
      ...(slices !== undefined ? { slices } : {}),
      config: {
        specHash: "abc123",
        datasetName: "fixture",
        graderNames: ["exact"],
        model: "claude-opus-4-7",
        concurrency: 1,
      },
      outDir: dir,
    };
    writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
    return dir;
  }

  const flipped = (ids: ReadonlyArray<string>, failing: number): FixtureSample[] =>
    ids.map((id, i) => ({ id, passed: i >= failing, score: i >= failing ? 1 : 0 }));

  test("diff.json carries significance (CI, p-value, paired-n) and slice deltas", async () => {
    const root = newTempRoot();
    const ids = ["s1", "s2", "s3", "s4"];
    const sliceStats = (passRate: number) => ({ sampleCount: 2, passRate, meanScore: passRate });
    const prev = writeRunDir(root, "prev", flipped(ids, 0), {
      difficulty: { easy: sliceStats(1), hard: sliceStats(1) },
    });
    const next = writeRunDir(root, "next", flipped(ids, 1), {
      difficulty: { easy: sliceStats(1), hard: sliceStats(0.5) },
    });
    const out = join(root, "out");
    const result = await runCli(["eval-report", "diff", prev, next, "-o", out], root);
    expect(result.exitCode).toBe(0);
    const diff = JSON.parse(readFileSync(join(out, "diff.json"), "utf-8"));
    expect(diff.significance).toMatchObject({
      pairedN: 4,
      method: "exact",
      pValue: 1,
      significant: false,
    });
    expect(Array.isArray(diff.significance.passRateDeltaCI95)).toBe(true);
    expect(diff.sliceDeltas).toHaveLength(2);
    const html = readFileSync(join(out, "index.html"), "utf-8");
    expect(html).toContain("Paired significance:");
    expect(html).toContain("Slice deltas (2)");
  });

  test("unseeded diffs are byte-identical across runs (fixed default seed)", async () => {
    const root = newTempRoot();
    // 25 shared ids > the exact bound → the Monte Carlo + bootstrap path.
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const prev = writeRunDir(root, "prev", flipped(ids, 0));
    const next = writeRunDir(root, "next", flipped(ids, 6));
    expect(
      (await runCli(["eval-report", "diff", prev, next, "-o", join(root, "a")], root)).exitCode,
    ).toBe(0);
    expect(
      (await runCli(["eval-report", "diff", prev, next, "-o", join(root, "b")], root)).exitCode,
    ).toBe(0);
    const a = readFileSync(join(root, "a", "diff.json"), "utf-8");
    const b = readFileSync(join(root, "b", "diff.json"), "utf-8");
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(parsed.significance.method).toBe("monte-carlo");
    // 6/25 same-direction regressions: decisively significant.
    expect(parsed.significance.significant).toBe(true);
  });

  test("--seed override is recorded; a garbled seed dies loudly", async () => {
    const root = newTempRoot();
    const prev = writeRunDir(root, "prev", flipped(["s1", "s2"], 0));
    const next = writeRunDir(root, "next", flipped(["s1", "s2"], 1));
    const out = join(root, "out");
    const ok = await runCli(["eval-report", "diff", prev, next, "--seed", "7", "-o", out], root);
    expect(ok.exitCode).toBe(0);
    const diff = JSON.parse(readFileSync(join(out, "diff.json"), "utf-8"));
    expect(diff.significance.seed).toBe(7);
    const bad = await runCliStderr(
      ["eval-report", "diff", prev, next, "--seed", "lucky", "-o", out],
      root,
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("--seed must be an integer");
  });

  test("--judge-model without --pairwise warns loudly and stays offline", async () => {
    const root = newTempRoot();
    const prev = writeRunDir(root, "prev", flipped(["s1", "s2"], 0));
    const next = writeRunDir(root, "next", flipped(["s1", "s2"], 1));
    const out = join(root, "out");
    const result = await runCliStderr(
      ["eval-report", "diff", prev, next, "--judge-model", "claude-opus-4-7", "-o", out],
      root,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--judge-model has no effect without --pairwise");
    // The flag stayed inert: a fully offline diff, no pairwise block.
    const diff = JSON.parse(readFileSync(join(out, "diff.json"), "utf-8"));
    expect(diff.pairwise).toBeUndefined();
  });

  test("history/baseline warn when handed the pairwise-only flags", async () => {
    const root = newTempRoot();
    const history = await runCliStderr(["eval-report", "history", "--pairwise"], root);
    expect(history.exitCode).toBe(0);
    expect(history.stderr).toContain("--pairwise only applies to `eval-report diff`");
    const baseline = await runCliStderr(
      ["eval-report", "baseline", "show", "--judge-model", "m"],
      root,
    );
    expect(baseline.exitCode).toBe(0);
    expect(baseline.stderr).toContain("--judge-model only applies to `eval-report diff`");
  });

  test("disjoint sample ids → clean mismatch message, not a stack trace", async () => {
    const root = newTempRoot();
    const prev = writeRunDir(root, "prev", flipped(["a1", "a2"], 0));
    const next = writeRunDir(root, "next", flipped(["b1", "b2"], 0));
    const result = await runCliStderr(["eval-report", "diff", prev, next], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dataset shape mismatch");
    expect(result.stderr).not.toContain("    at "); // no stack frames
  });

  test("a missing run dir also dies cleanly", async () => {
    const root = newTempRoot();
    const prev = writeRunDir(root, "prev", flipped(["s1"], 0));
    const result = await runCliStderr(["eval-report", "diff", prev, join(root, "nope")], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("results.json not found");
  });
});

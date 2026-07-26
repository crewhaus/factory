/**
 * C31 / C32 / NEW-stats-1 at the CLI seam: `crewhaus eval-report trends`,
 * `… export` and `… diff --epsilon` driven end-to-end over a FIXTURE history
 * (an index.jsonl + real run directories) in an mkdtemp sandbox — the
 * commands are offline by construction, so no credentials and no network are
 * involved.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";

const CLI_PATH = join(import.meta.dir, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-trends-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function sampleResult(
  id: string,
  passed: boolean,
  score: number,
  extra: Partial<SampleResult> = {},
): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id}`,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 900,
    turns: 1,
    tokens: { input: 100, output: 40 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "right" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [
        { name: "exact", passed, score, rationale: passed ? "matched" : "no match, expected x" },
        { name: "judge", passed, score, rationale: "judge=4 (need ≥3): reasonable" },
      ],
    },
    ...extra,
  };
}

/** Write a real run directory (results.json) + its index entry. */
function writeRun(
  root: string,
  opts: {
    runId: string;
    ts: string;
    passRate: number;
    meanScore: number;
    samples: SampleResult[];
    costUsd?: number;
    flakyCount?: number;
    datasetName?: string;
  },
): string {
  const outDir = join(root, ".crewhaus", "evals", opts.runId);
  mkdirSync(outDir, { recursive: true });
  const summary: EvalRunSummary = {
    runId: opts.runId,
    startedAt: opts.ts,
    endedAt: opts.ts,
    samples: opts.samples,
    aggregates: {
      passRate: opts.passRate,
      meanScore: opts.meanScore,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 900,
      p95LatencyMs: 900,
      totalTokens: { input: 200, output: 80 },
      errorCount: 0,
      ...(opts.flakyCount !== undefined
        ? {
            flaky: opts.flakyCount,
            flakySampleIds: opts.samples.slice(0, opts.flakyCount).map((s) => s.sampleId),
          }
        : {}),
    },
    slices: { difficulty: { hard: { sampleCount: 1, passRate: opts.passRate, meanScore: 0.5 } } },
    config: {
      specHash: "spec1",
      datasetName: opts.datasetName ?? "smoke",
      graderNames: ["exact", "judge"],
      model: "claude-opus-4-7",
      concurrency: 4,
      seed: 7,
    },
    outDir,
  };
  writeFileSync(join(outDir, "results.json"), JSON.stringify(summary, null, 2));
  const entry = {
    runId: opts.runId,
    specName: "concierge",
    specHash: "spec1",
    datasetName: opts.datasetName ?? "smoke",
    datasetHash: "d".repeat(64),
    passRate: opts.passRate,
    meanScore: opts.meanScore,
    sampleCount: opts.samples.length,
    p95LatencyMs: 900,
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.flakyCount !== undefined ? { flakyCount: opts.flakyCount } : {}),
    ts: opts.ts,
    outDir,
  };
  const indexPath = join(root, ".crewhaus", "evals", "index.jsonl");
  const prior = (() => {
    try {
      return readFileSync(indexPath, "utf-8");
    } catch {
      return "";
    }
  })();
  writeFileSync(indexPath, `${prior}${JSON.stringify(entry)}\n`);
  return outDir;
}

/** Two runs of one lineage plus one run of another — a small history. */
function fixtureHistory(root: string): { first: string; second: string } {
  const first = writeRun(root, {
    runId: "run_1111111111111111",
    ts: "2026-07-01T00:00:00.000Z",
    passRate: 0.5,
    meanScore: 0.5,
    costUsd: 0.01,
    samples: [
      sampleResult("s1", true, 1, { metadata: { difficulty: "hard" } }),
      sampleResult("s2", false, 0),
    ],
  });
  const second = writeRun(root, {
    runId: "run_2222222222222222",
    ts: "2026-07-05T00:00:00.000Z",
    passRate: 1,
    meanScore: 0.95,
    costUsd: 0.02,
    flakyCount: 1,
    samples: [
      sampleResult("s1", true, 1, { metadata: { difficulty: "hard" } }),
      sampleResult("s2", true, 0.9, { trialPassRate: 0.5, flaky: true }),
    ],
  });
  writeRun(root, {
    runId: "run_3333333333333333",
    ts: "2026-07-06T00:00:00.000Z",
    passRate: 0.25,
    meanScore: 0.3,
    datasetName: "hard-suite",
    samples: [sampleResult("h1", false, 0.3)],
  });
  return { first, second };
}

describe("eval-report trends (C31)", () => {
  test("prints a per-run table and a movement line per lineage", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const { exitCode, stdout } = await runCli(["eval-report", "trends"], root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("pass_rate");
    expect(stdout).toContain("run_1111111111111111");
    expect(stdout).toContain("run_3333333333333333");
    expect(stdout).toContain(
      "[eval-report] trends concierge/smoke: 2 runs 2026-07-01T00:00:00.000Z → 2026-07-05T00:00:00.000Z",
    );
    expect(stdout).toContain("pass_rate 50.0% → 100.0% (+50.0pp)");
    expect(stdout).toContain("cost $0.0300 over 2 priced run(s)");
    expect(stdout).toContain("flaky_samples=1");
  });

  test("--dataset filters to one lineage", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const { stdout } = await runCli(["eval-report", "trends", "--dataset", "hard-suite"], root);
    expect(stdout).toContain("hard-suite");
    expect(stdout).not.toContain("run_1111111111111111");
    expect(stdout).toContain("no trend yet");
  });

  test("-o writes a self-contained HTML chart page + trends.json", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const out = join(root, "trends-out");
    const { exitCode, stdout } = await runCli(["eval-report", "trends", "-o", out], root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[eval-report] trends: ${join(out, "index.html")}`);
    const html = readFileSync(join(out, "index.html"), "utf-8");
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/https?:\/\//);
    const json = JSON.parse(readFileSync(join(out, "trends.json"), "utf-8")) as Array<{
      specName: string;
      points: unknown[];
    }>;
    expect(json).toHaveLength(2);
    expect(json[0]?.points).toHaveLength(2);
  });

  test("an empty history says so instead of rendering an empty chart", async () => {
    const root = newTempRoot();
    const { exitCode, stdout } = await runCli(["eval-report", "trends"], root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("no recorded runs match");
  });
});

describe("eval-report export (C32)", () => {
  test("last:N flattens the indexed runs to CSV rows per (run, sample, grader)", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const { exitCode, stdout } = await runCli(
      ["eval-report", "export", "--runs", "last:2", "--format", "csv", "--dataset", "smoke"],
      root,
    );
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toContain("runId,runTs,specName");
    // 2 runs × 2 samples × 2 graders.
    expect(lines).toHaveLength(1 + 8);
    expect(stdout).toContain("run_1111111111111111");
    expect(stdout).toContain("run_2222222222222222");
    expect(stdout).toContain("concierge");
    expect(stdout).toContain("difficulty=hard");
  });

  test("--format jsonl emits one parseable object per row, -o writes the file", async () => {
    const root = newTempRoot();
    const { second } = fixtureHistory(root);
    const out = join(root, "rows.jsonl");
    const { exitCode, stdout } = await runCli(
      ["eval-report", "export", "--runs", second, "--format", "jsonl", "-o", out],
      root,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[eval-report] export: 4 row(s) from 1 run(s)");
    const rows = readFileSync(out, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r["grader"])).toEqual(["exact", "judge", "exact", "judge"]);
    // C34's flaky flag rides the export so instability is analyzable.
    expect(rows.filter((r) => r["flaky"] === true)).toHaveLength(2);
  });

  test("a comma-separated run list works, and a missing dir warns but does not abort", async () => {
    const root = newTempRoot();
    const { first, second } = fixtureHistory(root);
    const { exitCode, stdout, stderr } = await runCli(
      [
        "eval-report",
        "export",
        "--runs",
        `${first},${join(root, "nope")},${second}`,
        "--format",
        "csv",
      ],
      root,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("warning: skipping");
    expect(stdout.trim().split("\n")).toHaveLength(1 + 8);
  });

  test("bad flags die with a usable message", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const missing = await runCli(["eval-report", "export", "--format", "csv"], root);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("--runs <dir|dir,dir|last:N> is required");

    const badFormat = await runCli(
      ["eval-report", "export", "--runs", "last:1", "--format", "parquet"],
      root,
    );
    expect(badFormat.exitCode).not.toBe(0);
    expect(badFormat.stderr).toContain("--format must be csv or jsonl");

    const unreadable = await runCli(
      ["eval-report", "export", "--runs", join(root, "ghost"), "--format", "csv"],
      root,
    );
    expect(unreadable.exitCode).not.toBe(0);
    expect(unreadable.stderr).toContain("none of the requested runs could be read");
  });
});

describe("eval-report diff --epsilon (NEW-stats-1)", () => {
  test("the flag re-classifies a sub-default score move as a shift", async () => {
    const root = newTempRoot();
    const a = writeRun(root, {
      runId: "run_aaaaaaaaaaaaaaaa",
      ts: "2026-07-01T00:00:00.000Z",
      passRate: 1,
      meanScore: 0.5,
      samples: [sampleResult("s1", true, 0.5)],
    });
    const b = writeRun(root, {
      runId: "run_bbbbbbbbbbbbbbbb",
      ts: "2026-07-02T00:00:00.000Z",
      passRate: 1,
      meanScore: 0.58,
      samples: [sampleResult("s1", true, 0.58)],
    });
    const dflt = await runCli(["eval-report", "diff", a, b, "-o", join(root, "d1")], root);
    expect(dflt.stdout).toContain("score_shifts=0");

    const tight = await runCli(
      ["eval-report", "diff", a, b, "--epsilon", "0.05", "-o", join(root, "d2")],
      root,
    );
    expect(tight.stdout).toContain("score_shifts=1");

    const bad = await runCli(
      ["eval-report", "diff", a, b, "--epsilon", "-1", "-o", join(root, "d3")],
      root,
    );
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("--epsilon must be a non-negative number");
  });

  test("--epsilon on a read verb warns that it is diff-only", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const { stderr } = await runCli(["eval-report", "history", "--epsilon", "0.2"], root);
    expect(stderr).toContain("--epsilon only applies to `eval-report diff`");
  });
});

describe("eval-report history (C34 marking)", () => {
  test("marks flake-containing runs and points at the export verb", async () => {
    const root = newTempRoot();
    fixtureHistory(root);
    const { stdout } = await runCli(["eval-report", "history"], root);
    expect(stdout).toContain("flaky");
    expect(stdout).toContain("run(s) contain flaky samples (worst: run_2222222222222222, 1 sample");
    expect(stdout).toContain("crewhaus eval-report export --runs");
  });
});

describe("eval plan (C28) at the CLI seam", () => {
  test("prints the arithmetic, and reads a pilot run directory", async () => {
    const root = newTempRoot();
    const { second } = fixtureHistory(root);
    const worst = await runCli(["eval", "plan", "--target-delta", "0.05"], root);
    expect(worst.exitCode).toBe(0);
    expect(worst.stdout).toContain("n = 1.960² · 0.500·0.500 / 0.050² = 384.15 → 385 samples");

    const piloted = await runCli(
      ["eval", "plan", "--target-delta", "0.1", "--confidence", "0.9", "--pilot", second],
      root,
    );
    expect(piloted.exitCode).toBe(0);
    expect(piloted.stdout).toContain("(pilot run_2222222222222222, n=2 measured pass rate)");

    const missing = await runCli(["eval", "plan"], root);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("--target-delta F is required");
  });
});

describe("schedule generate (D41) at the CLI seam", () => {
  test("prints installable text and writes nothing", async () => {
    const root = newTempRoot();
    const { exitCode, stdout } = await runCli(
      ["schedule", "generate", "--for", "sentinel", "--dir", root],
      root,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("17 3 * * *");
    expect(stdout).toContain("--sentinel --baseline eval/sentinel-baseline");
    expect(stdout).toContain("nothing was installed");
    // The verb is a shim: the working directory is untouched — no crontab,
    // no unit file, not even a `.crewhaus/` scaffold.
    expect(readdirSync(root)).toEqual([]);
  });

  test("unknown target / action die with the supported list", async () => {
    const root = newTempRoot();
    const badFor = await runCli(["schedule", "generate", "--for", "nightly"], root);
    expect(badFor.exitCode).not.toBe(0);
    expect(badFor.stderr).toContain("supported: flywheel, eval-gate, sentinel");

    const badAction = await runCli(["schedule", "install"], root);
    expect(badAction.exitCode).not.toBe(0);
    expect(badAction.stderr).toContain('schedule action must be "generate"');
  });
});

/**
 * Item 4 — CLI integration for `crewhaus graders suggest` over seeded run
 * dirs. Split out of the unit tests when the suggest core moved to
 * `@crewhaus/dataset-ops`: these spawn the CLI, so they stay with the app.
 * The run-dir seeding below is copied from that unit file — both halves need
 * a loadRun-compatible run dir, and a package's test may not be imported for
 * it.
 *
 * CLI tests follow datasets-cli.test.ts's posture: stdout assertions are
 * avoided (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`) —
 * assert on exit codes and on-disk artifacts instead. The spawned env
 * carries only PATH, so no model call is ever attempted.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SUGGESTED_GRADERS_FILE } from "@crewhaus/dataset-ops/graders-suggest";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-graders-suggest-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

// -------- run-dir seeding --------

type SeedSample = {
  readonly sampleId: string;
  readonly passed: boolean;
  readonly output: string;
  readonly perGrader: Array<{
    name: string;
    passed: boolean;
    rationale: string;
    abstained?: boolean;
  }>;
  readonly toolNames?: string[];
  readonly error?: string;
  /** A3 — the sample outcome was abstained (judge declined, nothing else failed). */
  readonly abstained?: boolean;
};

function sampleResult(seed: SeedSample): SampleResult {
  const perGrader = seed.perGrader.map((g) => ({
    name: g.name,
    passed: g.passed,
    score: g.passed ? 1 : 0,
    rationale: g.rationale,
    ...(g.abstained === true ? { abstained: true } : {}),
  }));
  return {
    sampleId: seed.sampleId,
    sessionId: "sess_0123456789abcdef",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 1000,
    turns: 1,
    tokens: { input: 10, output: 10 },
    model: "claude-sonnet-4-6",
    agentOutput: seed.output,
    grades: {
      overall: {
        passed: seed.passed,
        score: seed.passed ? 1 : 0,
        rationale: perGrader
          .map((g) => `[${g.name}: ${g.passed ? "✓" : "✗"}] ${g.rationale}`)
          .join(" & "),
        ...(seed.abstained === true ? { abstained: true } : {}),
      },
      perGrader,
    },
    ...(seed.error !== undefined ? { error: seed.error } : {}),
  };
}

/** Write a loadRun-compatible run dir: results.json + per-sample dirs with
 *  grades.json / events.jsonl — the artifacts eval-runner persists. */
function seedRunDir(dir: string, runId: string, seeds: ReadonlyArray<SeedSample>): void {
  mkdirSync(dir, { recursive: true });
  const samples = seeds.map(sampleResult);
  const summary: EvalRunSummary = {
    runId,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: 0.5,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1000,
      p95LatencyMs: 1000,
      totalTokens: { input: 100, output: 100 },
      errorCount: seeds.filter((s) => s.error !== undefined).length,
    },
    config: {
      specHash: "spec-hash",
      datasetName: "seeded",
      graderNames: ["cited", "used_tools"],
      model: "claude-sonnet-4-6",
      concurrency: 1,
    },
    outDir: dir,
  };
  writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
  for (const seed of seeds) {
    const sampleDir = join(dir, seed.sampleId.replace(/[^A-Za-z0-9_.-]/g, "_"));
    mkdirSync(sampleDir, { recursive: true });
    const result = sampleResult(seed);
    writeFileSync(join(sampleDir, "grades.json"), JSON.stringify(result.grades, null, 2));
    const events = (seed.toolNames ?? []).map((toolName, i) =>
      JSON.stringify({
        kind: "tool_call_end",
        toolName,
        toolUseId: `use_${i}`,
        isError: false,
        timestamp: "2026-07-01T00:00:00.500Z",
      }),
    );
    writeFileSync(
      join(sampleDir, "events.jsonl"),
      events.length > 0 ? `${events.join("\n")}\n` : "",
    );
  }
}

const CITATION_FAIL = 'output missing "Source:"';
const TOOL_FAIL = "tool subsequence not found: expected [Read] got []";

function seedStandardRun(dir: string, runId: string): void {
  seedRunDir(dir, runId, [
    {
      sampleId: "s1",
      passed: false,
      output: "Answer without citation.",
      perGrader: [{ name: "cited", passed: false, rationale: CITATION_FAIL }],
    },
    {
      sampleId: "s2",
      passed: false,
      output: "Another answer, still no citation.",
      perGrader: [{ name: "cited", passed: false, rationale: CITATION_FAIL }],
    },
    {
      sampleId: "s3",
      passed: false,
      output: "I looked at docs but gave no citation.",
      perGrader: [{ name: "used_tools", passed: false, rationale: TOOL_FAIL }],
    },
    {
      sampleId: "s4",
      passed: true,
      output: "Done. Source: docs/guide.md",
      perGrader: [{ name: "cited", passed: true, rationale: 'output contains "Source:"' }],
      toolNames: ["Read", "Grep", "Read"],
    },
    {
      sampleId: "s5",
      passed: false,
      output: "",
      perGrader: [{ name: "cited", passed: false, rationale: "grader threw: judge 429" }],
      error: "provider 500",
    },
  ]);
}

// -------- CLI integration (seeded run dirs; env carries no creds) --------

const CWD_SPEC = `name: helper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You answer questions about the codebase, citing file paths.
`;

function seedIndexedRun(root: string, runId: string): string {
  const dir = join(root, ".crewhaus", "evals", runId);
  seedStandardRun(dir, runId);
  const entry = {
    runId,
    specName: "helper",
    specHash: "spec-hash",
    datasetName: "seeded",
    datasetHash: "dataset-hash",
    passRate: 0.2,
    meanScore: 0.2,
    sampleCount: 5,
    ts: "2026-07-01T00:01:00.000Z",
    outDir: dir,
  };
  const evalsDir = join(root, ".crewhaus", "evals");
  mkdirSync(evalsDir, { recursive: true });
  writeFileSync(join(evalsDir, "index.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
  return dir;
}

describe("crewhaus graders suggest (CLI)", () => {
  it("drafts a review file from indexed runs and guards overwrites", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), CWD_SPEC);
    seedIndexedRun(root, "run_000000000000000a");

    const first = await runCli(["graders", "suggest"], root);
    expect(first.exitCode).toBe(0);
    const outPath = join(root, DEFAULT_SUGGESTED_GRADERS_FILE);
    expect(existsSync(outPath)).toBe(true);
    const yaml = readFileSync(outPath, "utf-8");
    expect(yaml).toContain("hard-ANDs");
    expect(yaml).toContain("# evidence:");
    // The review file parses as a real graders config.
    const { config } = parseGradersConfig(yaml);
    expect(config.graders.length).toBeGreaterThan(0);
    // Deterministic drafting: the seeded tool-failure theme yields the shared
    // pass tools.
    expect(yaml).toContain("tool_call_sequence");

    // No --force → refuse; --force → replace.
    expect((await runCli(["graders", "suggest"], root)).exitCode).toBe(1);
    expect((await runCli(["graders", "suggest", "--force"], root)).exitCode).toBe(0);
  });

  it("accepts an explicit --runs <dir> without any index", async () => {
    const root = newTempRoot();
    const runDir = join(root, "some-run");
    seedStandardRun(runDir, "run_000000000000000b");
    const got = await runCli(["graders", "suggest", "--runs", runDir, "-o", "review.yaml"], root);
    expect(got.exitCode).toBe(0);
    expect(existsSync(join(root, "review.yaml"))).toBe(true);
  });

  it("fails cleanly with no evidence and rejects unknown actions", async () => {
    const root = newTempRoot();
    expect((await runCli(["graders", "suggest"], root)).exitCode).toBe(1);
    expect((await runCli(["graders", "propose"], root)).exitCode).toBe(1);
  });
});

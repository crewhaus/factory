/**
 * Wave 4 cluster R — the `crewhaus eval` CLI surface for tool record/replay
 * (NEW-HUNT-4) and run resume (NEW-HUNT-6).
 *
 * Every assertion here is offline: the flag combinations are validated BEFORE
 * any dataset load or model spend, so none of these need credentials. The
 * history-supersede assertion drives `eval-report history` over a planted
 * index in a per-test `mkdtemp` cwd — nothing is written near the repo.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(SRC_DIR, "index.ts");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-cassette-cli-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/**
 * Default spawn cwd. Today every default-cwd call here is a `--help` or
 * arg-validation path that exits before opening a store, so nothing leaks —
 * but the CLI roots `.crewhaus/{evals,sessions,specs}` at its cwd, so pointing
 * the default at the repo root left one added assertion away from writing into
 * the operator's checkout.
 */
const SPAWN_CWD = newTempRoot();

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string = SPAWN_CWD,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      // Hermetic dataset registry — `eval` unions the per-spec regression
      // suite from the cwd's registry by default (see eval.test.ts).
      CREWHAUS_DATASETS_DIR: join(newTempRoot(), "datasets"),
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

const BASE = ["eval", HELLO_SPEC, "--dataset", "d.jsonl", "--graders", "g.yaml"];

describe("crewhaus eval — tool record/replay flags (NEW-HUNT-4)", () => {
  test("--help documents the cassette and resume flags", async () => {
    const got = await runCli(["eval", "--help"]);
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("--record-tools");
    expect(got.stdout).toContain("--replay-tools");
    expect(got.stdout).toContain("--replay-miss error|live");
    expect(got.stdout).toContain("--resume <runDir>");
    // The honest scope note: tools are replayed, the model is not.
    expect(got.stdout).toContain("the MODEL still runs live");
  });

  test("--record-tools and --replay-tools are mutually exclusive", async () => {
    const got = await runCli([...BASE, "--record-tools", "rec", "--replay-tools", "rec"]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("mutually exclusive");
  });

  test("--replay-miss without --replay-tools is refused, never silently ignored", async () => {
    const got = await runCli([...BASE, "--replay-miss", "live"]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--replay-miss is only valid with --replay-tools");
  });

  test("--replay-miss only accepts error|live", async () => {
    const got = await runCli([...BASE, "--replay-tools", "rec", "--replay-miss", "sometimes"]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain('must be "error" or "live"');
  });

  test("a replay directory with no cassette dies before any spend", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "d.jsonl"), '{"id":"q1","input":"hi","expected_output":"hi"}\n');
    writeFileSync(join(root, "g.yaml"), "graders:\n  - name: m\n    type: exact_match\n");
    const got = await runCli(
      [
        "eval",
        HELLO_SPEC,
        "--dataset",
        join(root, "d.jsonl"),
        "--graders",
        join(root, "g.yaml"),
        "--replay-tools",
        join(root, "no-recording"),
        "-o",
        join(root, "out"),
      ],
      root,
    );
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("tool recording not found");
  });

  test("the cassette flags are refused with --models (cells share sample ids)", async () => {
    const got = await runCli([
      ...BASE,
      "--models",
      "claude-sonnet-4-5,claude-haiku-4-5",
      "--record-tools",
      "rec",
    ]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--models is incompatible with --record-tools/--replay-tools");
  });

  test("--help states the cassette's sensitivity and the reused-entry warning", async () => {
    const got = await runCli(["eval", "--help"]);
    expect(got.stdout).toContain("tool args and results VERBATIM");
    expect(got.stdout).toContain("do not commit one");
    expect(got.stdout).toContain("reusedEntries count");
  });
});

describe("crewhaus eval --voice — the R flags die instead of being ignored (D44)", () => {
  // `--voice` returns before the text-eval flags are read, so these used to be
  // accepted and silently dropped — the class of no-op the campaign filed D44
  // for, and newly confusing since D46 taught --voice to honour --graders.
  for (const [flag, value] of [
    ["--record-tools", "rec"],
    ["--replay-tools", "rec"],
    ["--resume", "run"],
  ] as const) {
    test(`${flag} under --voice is refused, never silently ignored`, async () => {
      const got = await runCli(["eval", "--voice", flag, value]);
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain(`--voice does not support ${flag}`);
      expect(got.stderr).toContain("text evals only");
    });
  }

  test("--replay-miss under --voice is refused too", async () => {
    const got = await runCli(["eval", "--voice", "--replay-miss", "live"]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--voice does not support --replay-miss");
  });
});

describe("crewhaus eval --resume (NEW-HUNT-6)", () => {
  test("refuses a directory that is not an eval run directory", async () => {
    const root = newTempRoot();
    const got = await runCli([...BASE, "--resume", join(root, "nope")]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("is not an eval run directory");
  });

  test("refuses -o alongside --resume (the run dir IS the output)", async () => {
    const root = newTempRoot();
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "run_abc" }));
    const got = await runCli([...BASE, "--resume", runDir, "-o", join(root, "elsewhere")]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--resume and -o are mutually exclusive");
  });

  test("refuses --models alongside --resume", async () => {
    const root = newTempRoot();
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "run_abc" }));
    const got = await runCli([
      ...BASE,
      "--models",
      "claude-sonnet-4-5,claude-haiku-4-5",
      "--resume",
      runDir,
    ]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--resume and --models are mutually exclusive");
  });

  test("a moved dataset identity refuses the resume by name, before any spend", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "d.jsonl"), '{"id":"q1","input":"hi","expected_output":"hi"}\n');
    writeFileSync(join(root, "g.yaml"), "graders:\n  - name: m\n    type: exact_match\n");
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    // A manifest recorded against a DIFFERENT dataset than the one passed.
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run_abc",
        startedAt: "2026-07-26T00:00:00.000Z",
        datasetHash: "nope",
      }),
    );
    const got = await runCli(
      [
        "eval",
        HELLO_SPEC,
        "--dataset",
        join(root, "d.jsonl"),
        "--graders",
        join(root, "g.yaml"),
        "--resume",
        runDir,
      ],
      root,
    );
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("its identity moved");
    expect(got.stderr).toContain("datasetHash: nope (recorded)");
  });
});

describe("run history — a resumed run supersedes, never duplicates", () => {
  test("eval-report history keeps the LATEST entry per runId", async () => {
    const root = newTempRoot();
    const evalsDir = join(root, ".crewhaus", "evals");
    mkdirSync(evalsDir, { recursive: true });
    const entry = (over: Record<string, unknown>) =>
      JSON.stringify({
        runId: "run_1111111111111111",
        specName: "hello",
        specHash: "sp",
        datasetName: "smoke",
        datasetHash: "ds",
        passRate: 0.5,
        meanScore: 0.5,
        sampleCount: 2,
        ts: "2026-07-26T00:00:00.000Z",
        outDir: join(root, "run"),
        ...over,
      });
    writeFileSync(
      join(evalsDir, "index.jsonl"),
      `${[
        // The interrupted run's entry …
        entry({}),
        // … a different run in between …
        entry({ runId: "run_2222222222222222", passRate: 1, ts: "2026-07-26T00:00:01.000Z" }),
        // … and the resumed run's superseding entry (same id, later ts).
        entry({ passRate: 1, sampleCount: 4, ts: "2026-07-26T00:00:02.000Z" }),
      ].join("\n")}\n`,
    );

    const got = await runCli(["eval-report", "history"], root);
    expect(got.exitCode).toBe(0);
    const rows = got.stdout
      .split("\n")
      .filter((l) => l.includes("run_1111111111111111") || l.includes("run_2222222222222222"));
    expect(rows).toHaveLength(2);
    const superseded = rows.find((l) => l.includes("run_1111111111111111")) ?? "";
    // The completed figures won; the truncated 50% row is gone.
    expect(superseded).toContain("100.0%");
    expect(superseded).toContain("2026-07-26T00:00:02.000Z");
    expect(got.stdout).not.toContain("50.0%");
  });

  test("a run resumed TWICE still yields exactly one row", async () => {
    const root = newTempRoot();
    const evalsDir = join(root, ".crewhaus", "evals");
    mkdirSync(evalsDir, { recursive: true });
    const entry = (over: Record<string, unknown>) =>
      JSON.stringify({
        runId: "run_3333333333333333",
        specName: "hello",
        specHash: "sp",
        datasetName: "smoke",
        datasetHash: "ds",
        passRate: 0.25,
        meanScore: 0.25,
        sampleCount: 1,
        ts: "2026-07-26T00:00:00.000Z",
        outDir: join(root, "run"),
        ...over,
      });
    writeFileSync(
      join(evalsDir, "index.jsonl"),
      `${[
        entry({}),
        entry({ passRate: 0.5, sampleCount: 2, ts: "2026-07-26T00:00:01.000Z" }),
        entry({ passRate: 1, sampleCount: 4, ts: "2026-07-26T00:00:02.000Z" }),
      ].join("\n")}\n`,
    );

    const got = await runCli(["eval-report", "history"], root);
    expect(got.exitCode).toBe(0);
    const rows = got.stdout.split("\n").filter((l) => l.includes("run_3333333333333333"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("100.0%");
  });
});

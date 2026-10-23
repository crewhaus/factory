/**
 * 0.8.0 §9.1 — the `crewhaus eval --provability <level>` flag surface.
 *
 * Every assertion is offline: the flag is validated BEFORE any dataset load
 * or model spend, so none of these need credentials — and a real run without
 * credentials still completes (each sample errors at the model call), which
 * is enough to pin the CLI's own glue: the floor reaching runEval, the six
 * graders in run.json, and the never-promote rule. What the flag does inside
 * a sample (the re-levelled gate in the loop, proof.json per sample, the
 * graders' verdicts) is covered against the live loop in
 * packages/eval-runner/src/provability.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(SRC_DIR, "index.ts");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-provability-cli-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** The CLI roots `.crewhaus/` at its cwd: never the repo. */
const SPAWN_CWD = newTempRoot();
/** Hermetic harness registry (the spec dir is inside the repo — see eval.test.ts). */
const REGISTRY_ROOT = newTempRoot();

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string = SPAWN_CWD,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      CREWHAUS_REGISTRY_ROOT: join(REGISTRY_ROOT, "registry"),
      CREWHAUS_WATCHME_ROOT: join(REGISTRY_ROOT, "watchme"),
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

describe("crewhaus eval --provability <level> (design §9.1)", () => {
  test("--help documents the flag and its semantics", async () => {
    const got = await runCli(["eval", "--help"]);
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("[--provability <level>]");
    expect(got.stdout).toContain("without editing the spec");
    expect(got.stdout).toContain("never\n  becomes the baseline");
    expect(got.stdout).toContain("provability.*");
  }, 20_000);

  test("anything but a rung is refused before any spend — `off` included", async () => {
    for (const bad of ["off", "proved", "GROUNDED"]) {
      const got = await runCli([...BASE, "--provability", bad]);
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain(`invalid --provability "${bad}"`);
      expect(got.stderr).toContain("cited, grounded, checked, proven");
    }
  }, 30_000);

  test("a what-if floor is never gated against the baseline", async () => {
    const got = await runCli([...BASE, "--provability", "grounded", "--gate"]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--provability and --gate are mutually exclusive");
  }, 20_000);

  test("--sentinel and --models refuse it too", async () => {
    const sentinel = await runCli([
      ...BASE,
      "--provability",
      "cited",
      "--sentinel",
      "--baseline",
      "somewhere",
    ]);
    expect(sentinel.exitCode).toBe(1);
    expect(sentinel.stderr).toContain("--provability and --sentinel are mutually exclusive");
    const models = await runCli([
      ...BASE,
      "--provability",
      "cited",
      "--models",
      "claude-haiku-4-5,claude-sonnet-4-6",
    ]);
    expect(models.exitCode).toBe(1);
    expect(models.stderr).toContain("--provability and --models are mutually exclusive");
  }, 30_000);

  test("--voice refuses it: a replayed call session ran no gate", async () => {
    const got = await runCli(["eval", "--voice", "--provability", "cited"]);
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--voice does not support --provability");
  }, 20_000);

  test("a valid rung passes flag validation (the run then fails on the missing dataset, not the flag)", async () => {
    const got = await runCli([...BASE, "--provability", "checked"]);
    expect(got.stderr).not.toContain("--provability");
  }, 20_000);

  test("a real run: the floor reaches runEval, the six graders are recorded, and no baseline is pinned", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: evalprov\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: i\ncontinuity: false\n",
    );
    writeFileSync(join(root, "data.jsonl"), '{"id":"s1","input":"hi","expected_output":"hi"}\n');
    writeFileSync(join(root, "graders.yaml"), "graders:\n  - name: exact\n    type: exact_match\n");
    const out = join(root, "out");
    const got = await runCli(
      [
        "eval",
        join(root, "crewhaus.yaml"),
        "--dataset",
        join(root, "data.jsonl"),
        "--graders",
        join(root, "graders.yaml"),
        "--provability",
        "cited",
        "--out",
        out,
      ],
      root,
    );
    expect(got.exitCode).toBe(0);
    const six = [
      "provability.claimCoverage",
      "provability.rungAchieved",
      "provability.citationValidity",
      "provability.assumptionRate",
      "provability.replayIntegrity",
      "provability.costPerProvenClaim",
    ];
    type Recorded = { provability?: string; graderNames?: string[] };
    const manifest = JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as Recorded;
    const { config } = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as {
      config: Recorded;
    };
    for (const [file, rec] of [
      ["run.json", manifest],
      ["results.json", config],
    ] as const) {
      expect({ file, provability: rec.provability, graders: rec.graderNames }).toEqual({
        file,
        provability: "cited",
        graders: ["exact", ...six],
      });
    }
    // The sample errored before the gate graded anything (no credentials):
    // the graders say so, without telling a --provability run to add the flag.
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8")) as {
      samples: Array<{ grades: { perGrader: Array<{ name: string; rationale: string }> } }>;
    };
    const coverage = results.samples[0]?.grades.perGrader.find(
      (g) => g.name === "provability.claimCoverage",
    );
    expect(coverage?.rationale).toContain("or the sample ended before the gate graded an answer");
    // A what-if floor is recorded in the history but never becomes the baseline.
    expect(got.stdout + got.stderr).toContain("baseline not set");
    expect(existsSync(join(root, ".crewhaus", "evals", "index.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "evals", "baselines.json"))).toBe(false);
  }, 60_000);
});

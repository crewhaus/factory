/**
 * E48 — offline CLI integration for `crewhaus graders test`: dispatch, help,
 * and the gate's exit code with a deterministic grader. Split out of the unit
 * tests when the meta-eval core moved to `@crewhaus/eval-ops`: these spawn
 * the CLI, so they stay with the app. No credentials, no network — so
 * llm_judge entries must SKIP rather than fabricate a verdict.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -------- CLI integration (offline — no judge credentials) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-graders-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  cliArgs: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...cliArgs], {
    cwd,
    // No provider creds → llm_judge entries must SKIP, never fabricate.
    env: { PATH: process.env["PATH"] ?? "" },
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

const CONTAINS_GRADERS_YAML = `graders:
  - name: mentions_ok
    type: contains
    substring: ok
`;

/** ok-containing outputs labeled pass/fail so `mentions_ok` agrees on 2 of
 *  3 lines (one human-failed output still says ok — a false positive). */
const GOLDEN_JSONL = [
  JSON.stringify({ id: "g1", input: "i1", agent_output: "ok fine", expected_passed: true }),
  JSON.stringify({ id: "g2", input: "i2", agent_output: "nope", expected_passed: false }),
  JSON.stringify({ id: "g3", input: "i3", agent_output: "ok but wrong", expected_passed: false }),
].join("\n");

describe("crewhaus graders test (CLI, offline)", () => {
  it("shows help", async () => {
    const got = await runCli(["graders", "test", "--help"], newTempRoot());
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("usage: crewhaus graders test");
    expect(got.stdout).toContain("--min-agreement");
    expect(got.stdout).toContain("expected_passed");
  });

  it("rejects an unknown graders action naming every verb", async () => {
    const got = await runCli(["graders", "bogus"], newTempRoot());
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("graders action must be one of: suggest, test, card");
  });

  it("dies on missing --graders / --golden", async () => {
    const root = newTempRoot();
    const noGraders = await runCli(["graders", "test"], root);
    expect(noGraders.exitCode).toBe(1);
    expect(noGraders.stderr).toContain("--graders");
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    const noGolden = await runCli(["graders", "test", "--graders", "g.yaml"], root);
    expect(noGolden.exitCode).toBe(1);
    expect(noGolden.stderr).toContain("--golden");
  });

  it("dies with the line number on a malformed golden line", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\nnot json\n`);
    const got = await runCli(
      ["graders", "test", "--graders", "g.yaml", "--golden", "golden.jsonl"],
      root,
    );
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("golden line 4");
  });

  it("replays a deterministic grader credential-free and reports FP exemplars", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const got = await runCli(
      ["graders", "test", "--graders", "g.yaml", "--golden", "golden.jsonl"],
      root,
    );
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("3 golden verdict(s), 1 grader(s) tested");
    expect(got.stdout).toContain("mentions_ok (deterministic): agreement 67% (2/3)");
    expect(got.stdout).toContain("false positives (grader passed, human failed): 1 — g3");
  });

  it("skips llm_judge graders with a notice when no credentials are visible", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "g.yaml"),
      `${CONTAINS_GRADERS_YAML}  - name: judge_q
    type: llm_judge
    rubric:
      criteria:
        - name: quality
          description: q
          anchors: {"1": a, "2": b, "3": c, "4": d, "5": e}
      passing_score: 3
`,
    );
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const got = await runCli(
      ["graders", "test", "--graders", "g.yaml", "--golden", "golden.jsonl"],
      root,
    );
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("1 grader(s) tested, 1 skipped");
    expect(got.stdout).toContain('skipped llm_judge "judge_q"');
    expect(got.stdout).toContain("mentions_ok (deterministic)");
  });

  it("--min-agreement gates: non-zero under the floor, zero at/above it", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const fail = await runCli(
      [
        "graders",
        "test",
        "--graders",
        "g.yaml",
        "--golden",
        "golden.jsonl",
        "--min-agreement",
        "0.9",
      ],
      root,
    );
    expect(fail.exitCode).toBe(1);
    expect(fail.stderr).toContain('FAIL: grader "mentions_ok"');
    const pass = await runCli(
      [
        "graders",
        "test",
        "--graders",
        "g.yaml",
        "--golden",
        "golden.jsonl",
        "--min-agreement",
        "0.5",
      ],
      root,
    );
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout).toContain("gate passed");
  });

  it("rejects an out-of-range --min-agreement", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const got = await runCli(
      [
        "graders",
        "test",
        "--graders",
        "g.yaml",
        "--golden",
        "golden.jsonl",
        "--min-agreement",
        "1.5",
      ],
      root,
    );
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--min-agreement");
  });

  it("mentions graders test in the top-level usage", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    const got = await runCli(["--help"], root);
    expect(got.stdout).toContain("graders test --graders <g.yaml>");
    expect(got.stdout).toContain("--min-agreement");
  });
});

/**
 * D36 / D38 (Evals Wave 5, cluster O) — CLI surface for multi-stage optimize
 * and the third mutator.
 *
 * Everything here fails (or prints) BEFORE any model call, so the file needs
 * no credentials and never runs an eval: the assertions are exit codes and
 * stderr text. The behaviour behind the flags is unit-tested hermetically in
 * `optimize-stages.test.ts` and `meta-harness-mutator.test.ts`.
 *
 * Spawn-heavy: an explicit ceiling is mandatory (bun's 5s default is not
 * enough for >=4 CLI boots on CI), and the independent cases spawn
 * concurrently.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-optimize-stage-"));
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
  // Read the pipes CONCURRENTLY with the exit (flywheel.test.ts pattern).
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const WORKFLOW_YAML = `name: mini-flow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: Draft a one-line answer.
  - name: polish
    instructions: Polish the draft.
`;

const CLI_YAML = `name: hello-cli
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: You are a helpful assistant.
tools:
  - Read
`;

const GRADERS_YAML = `graders:
  - name: gold
    type: expected_contains
`;

/** A harness dir with a spec, a 2-sample dataset and a graders file. */
function scaffold(yaml: string): { root: string; spec: string } {
  const root = newTempRoot();
  const spec = join(root, "crewhaus.yaml");
  writeFileSync(spec, yaml);
  writeFileSync(join(root, "graders.yaml"), GRADERS_YAML);
  writeFileSync(
    join(root, "dataset.jsonl"),
    `${JSON.stringify({ id: "s0", input: "q0", expected_output: "a0" })}\n${JSON.stringify({ id: "s1", input: "q1", expected_output: "a1" })}\n`,
  );
  return { root, spec };
}

const DATA_FLAGS = ["--dataset", "dataset.jsonl", "--graders", "graders.yaml"];

describe("optimize --stage (D36)", () => {
  test("an unknown stage errors and lists the valid stage names", async () => {
    const { root } = scaffold(WORKFLOW_YAML);
    const r = await runCli(["optimize", "crewhaus.yaml", ...DATA_FLAGS, "--stage", "nope"], root);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown --stage "nope"');
    expect(r.stderr).toContain("valid stages: draft, polish");
  }, 60_000);

  test("--stage is refused for a single-agent spec, and multi-stage flags reach the help", async () => {
    const { root } = scaffold(CLI_YAML);
    const [refused, help] = await Promise.all([
      runCli(["optimize", "crewhaus.yaml", ...DATA_FLAGS, "--stage", "draft"], root),
      runCli(["optimize", "--help"], root),
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--stage is only meaningful for a multi-stage spec");

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("[--stage <name>]");
    expect(help.stdout).toContain("MULTI-STAGE SPECS (D36)");
    // The strategy the campaign asked to be documented in help.
    expect(help.stdout).toContain("SEQUENTIALLY in declaration order");
    expect(help.stdout).toContain("gated independently");
    expect(help.stdout).toContain("--budget-usd is a RUN ceiling");
    // The retired `--path` misdirection must never reappear.
    expect(help.stdout).not.toContain("--path <step.instructions>");
  }, 60_000);

  test("--stage is refused with --from-advice instead of being silently ignored", async () => {
    const { root } = scaffold(WORKFLOW_YAML);
    writeFileSync(join(root, "suggestions.json"), JSON.stringify({ suggestions: [] }));
    const r = await runCli(
      [
        "optimize",
        "crewhaus.yaml",
        ...DATA_FLAGS,
        "--from-advice",
        "suggestions.json",
        "--stage",
        "draft",
      ],
      root,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--stage has no meaning with --from-advice");
  }, 60_000);

  test("a bridged run refuses multi-turn samples the way the eval bundle does", async () => {
    const { root } = scaffold(WORKFLOW_YAML);
    // One history-carrying sample among history-less ones: workflow is driven
    // through its compiled entry, which takes ONE trigger input.
    writeFileSync(
      join(root, "dataset.jsonl"),
      `${JSON.stringify({ id: "s0", input: "q0", expected_output: "a0" })}\n${JSON.stringify({
        id: "s1",
        input: "q1",
        expected_output: "a1",
        history: [{ role: "user", content: "earlier" }],
      })}\n`,
    );
    const r = await runCli(["optimize", "crewhaus.yaml", ...DATA_FLAGS], root);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("multi-turn history");
    expect(r.stderr).toContain("s1");
    expect(r.stderr).toContain("single trigger input");
  }, 60_000);

  test("the mutator vocabulary names all three mutators and rejects an unknown one", async () => {
    const { root } = scaffold(CLI_YAML);
    const r = await runCli(
      ["optimize", "crewhaus.yaml", ...DATA_FLAGS, "--mutator", "bogus"],
      root,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("supported: rule-based, claude, meta-harness");
  }, 60_000);

  test("top-level help advertises the stage flag and the third mutator", async () => {
    const { root } = scaffold(CLI_YAML);
    const r = await runCli(["--help"], root);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--mutator rule-based|claude|meta-harness");
    expect(r.stdout).toContain("[--stage <name>]");
  }, 60_000);

  test("optimize --help DOCUMENTS the third mutator (not just its name in the usage line)", async () => {
    const { root } = scaffold(CLI_YAML);
    const r = await runCli(["optimize", "--help"], root);
    expect(r.exitCode).toBe(0);
    // The mutator catalogue: all three named, with the properties a user must
    // know BEFORE committing to a paid run (D38 "documented as experimental").
    expect(r.stdout).toContain("MUTATORS (--mutator, default rule-based)");
    expect(r.stdout).toContain("rule-based");
    expect(r.stdout).toContain("meta-harness  EXPERIMENTAL");
    expect(r.stdout).toContain("EXPERIENCE STORE");
    expect(r.stdout).toContain("Credentials required");
    expect(r.stdout).toContain("--budget-usd");
    expect(r.stdout).toContain("REWRITES THE WHOLE PROMPT");
    expect(r.stdout).toContain("whole-BUNDLE rewriting mode stays library-only");
    // The measurement boundary the search actually honours.
    expect(r.stdout).toContain("WHAT THE SEARCH MEASURES");
    expect(r.stdout).toContain("expected_tools");
  }, 60_000);

  test("sessions --help no longer claims --mutator meta-harness does not exist", async () => {
    const { root } = scaffold(CLI_YAML);
    const r = await runCli(["sessions", "--help"], root);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("G53 posture");
    // The retired claim.
    expect(r.stdout).not.toContain("there is no --mutator");
    expect(r.stdout).not.toContain("deliberately NOT");
    // What is true now.
    expect(r.stdout).toContain("crewhaus optimize --mutator meta-harness");
    expect(r.stdout).toContain("library-only");
  }, 60_000);
});

describe("flywheel's cli-only refusal (D36 follow-up)", () => {
  test("names the flywheel's OWN limit and points at the lanes that do support the shape", async () => {
    const { root } = scaffold(WORKFLOW_YAML);
    const r = await runCli(["flywheel", "run", "crewhaus.yaml", ...DATA_FLAGS], root);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("flywheel only supports target: cli");
    expect(r.stderr).toContain("crewhaus optimize` does support this shape");
    expect(r.stderr).toContain("--with-eval-harness");
    // The retired overclaim.
    expect(r.stderr).not.toContain("eval/optimize v0 are cli-only");
  }, 60_000);
});

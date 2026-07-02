/**
 * Unit tests for the item-44 eval-on-PR CI scaffold: the workflow content
 * contract and the `crewhaus init --ci` CLI surface (fresh dir, existing
 * harness, refuse-overwrite/--force). No LLM/credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_CI_WORKFLOW_RELPATH, buildEvalCiWorkflowYaml } from "./ci-scaffold";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-ci-scaffold-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("buildEvalCiWorkflowYaml", () => {
  const yaml = buildEvalCiWorkflowYaml();

  test("triggers on PRs touching the spec, dataset, or graders", () => {
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain('- "crewhaus.yaml"');
    expect(yaml).toContain('- "eval/**"');
  });

  test("compile gate runs before any eval budget is spent", () => {
    const compileIdx = yaml.indexOf("crewhaus compile crewhaus.yaml --emit-ir");
    const evalIdx = yaml.indexOf("crewhaus eval ");
    expect(compileIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(compileIdx);
  });

  test("two fresh runs: base spec first (pins the baseline), then PR spec with --gate", () => {
    const baseIdx = yaml.indexOf("crewhaus eval .crewhaus-ci/base/crewhaus.yaml");
    const prIdx = yaml.indexOf("crewhaus eval crewhaus.yaml");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(prIdx).toBeGreaterThan(baseIdx);
    expect(yaml).toContain("--gate");
    // The base spec comes from a second checkout of the base branch.
    expect(yaml).toContain("ref: ${{ github.base_ref }}");
    expect(yaml).toContain("path: .crewhaus-ci/base");
  });

  test("documents the baseline strategy trade-off in the workflow comments", () => {
    expect(yaml).toContain("BASELINE STRATEGY");
    expect(yaml).toContain("baselines.json");
    expect(yaml).toContain("two fresh runs");
  });

  test("budget-conscious defaults: concurrency 1 (30k-TPM tier) and a pinned seed", () => {
    expect(yaml).toContain('EVAL_CONCURRENCY: "1"');
    expect(yaml).toContain("30k-TPM");
    expect(yaml).toContain('EVAL_SEED: "1"');
    expect(yaml).toContain('--concurrency "$EVAL_CONCURRENCY" --seed "$EVAL_SEED"');
  });

  test("posts the score-delta table as a PR comment via gh api + GITHUB_TOKEN", () => {
    expect(yaml).toContain("gh api");
    expect(yaml).toContain("issues/${{ github.event.pull_request.number }}/comments");
    expect(yaml).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(yaml).toContain("pull-requests: write");
    // Comment survives a failing gate; a dedicated step re-fails the check.
    expect(yaml).toContain("continue-on-error: true");
    expect(yaml).toContain("if: steps.gate.outcome == 'failure'");
    expect(yaml).toContain("exit 1");
  });

  test("degrades gracefully on fork PRs (read-only token)", () => {
    expect(yaml).toContain("comment skipped");
  });
});

// -------- CLI surface (spawned) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const SPEC_YAML = "name: hello\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n";

describe("crewhaus init --ci (CLI surface)", () => {
  test("fresh dir: scaffolds the spec AND the workflow", async () => {
    const root = newTempRoot();
    const res = await runCli(["init", "--ci"], root);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, "crewhaus.yaml"))).toBe(true);
    const wfPath = join(root, EVAL_CI_WORKFLOW_RELPATH);
    expect(existsSync(wfPath)).toBe(true);
    expect(readFileSync(wfPath, "utf-8")).toBe(buildEvalCiWorkflowYaml());
    expect(res.stdout).toContain("ANTHROPIC_API_KEY");
  });

  test("existing harness: adds just the workflow, keeps the spec byte-identical", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), SPEC_YAML);
    const res = await runCli(["init", "--ci"], root);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kept");
    expect(readFileSync(join(root, "crewhaus.yaml"), "utf-8")).toBe(SPEC_YAML);
    expect(existsSync(join(root, EVAL_CI_WORKFLOW_RELPATH))).toBe(true);
  });

  test("refuses to overwrite an existing workflow without --force", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), SPEC_YAML);
    await runCli(["init", "--ci"], root);
    const wfPath = join(root, EVAL_CI_WORKFLOW_RELPATH);
    writeFileSync(wfPath, "# hand-edited\n");

    const refused = await runCli(["init", "--ci"], root);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(wfPath, "utf-8")).toBe("# hand-edited\n");

    const forced = await runCli(["init", "--ci", "--force"], root);
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(wfPath, "utf-8")).toBe(buildEvalCiWorkflowYaml());
  });

  test("init [name] --ci scaffolds both into the named subdirectory", async () => {
    const root = newTempRoot();
    const res = await runCli(["init", "myagent", "--ci"], root);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, "myagent", "crewhaus.yaml"))).toBe(true);
    expect(existsSync(join(root, "myagent", EVAL_CI_WORKFLOW_RELPATH))).toBe(true);
  });

  test("bare init is unchanged: no workflow, still refuses an existing spec", async () => {
    const root = newTempRoot();
    const first = await runCli(["init"], root);
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(root, EVAL_CI_WORKFLOW_RELPATH))).toBe(false);
    const second = await runCli(["init"], root);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("refusing to overwrite");
  });
});

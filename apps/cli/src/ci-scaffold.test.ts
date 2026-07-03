/**
 * Unit tests for the item-44 eval-on-PR CI scaffold: the workflow content
 * contract and the `crewhaus init --ci` CLI surface (fresh dir, existing
 * harness, refuse-overwrite/--force). No LLM/credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVAL_CI_WORKFLOW_RELPATH,
  SENTINEL_WORKFLOW_RELPATH,
  buildEvalCiWorkflowYaml,
  buildSentinelDriftWorkflowYaml,
} from "./ci-scaffold";

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

  test("H2a — base-spec-absent: baseline detection skips base eval + gate (first PR goes green)", () => {
    expect(yaml).toContain("id: baseline");
    expect(yaml).toContain('echo "exists=true" >> "$GITHUB_OUTPUT"');
    expect(yaml).toContain('echo "exists=false" >> "$GITHUB_OUTPUT"');
    // BOTH paid steps are guarded on the baseline existing.
    const guarded = yaml.split("if: steps.baseline.outputs.exists == 'true'").length - 1;
    expect(guarded).toBe(2);
    expect(yaml).toContain("first PR introducing the spec");
    expect(yaml).toContain("future PRs will gate");
    // The fail step keys on the gate's own outcome — a skipped gate (no
    // baseline) leaves the check green.
    expect(yaml).toContain("if: steps.gate.outcome == 'failure'");
  });

  test("H2b — fork PRs skip the whole job (no secret access) with an explanatory comment", () => {
    expect(yaml).toContain(
      "if: github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(yaml).toContain("Fork PRs cannot read secrets.ANTHROPIC_API_KEY");
    expect(yaml).toContain("model-client construction");
    expect(yaml).toContain("re-running the eval after merge");
    expect(yaml).toContain("workflow_dispatch");
  });

  test("H2c — the PR comment only labels a FAILING GATE STEP as a regression", () => {
    // Three-way verdict: no baseline / gate success / gate failure, with an
    // explicit infra branch for a gate that never ran.
    expect(yaml).toContain('if [ "$BASELINE" = "false" ]; then');
    expect(yaml).toContain("NO BASELINE ✅");
    expect(yaml).toContain('elif [ "$GATE_STATE" = "failure" ]; then');
    expect(yaml).toContain("FAIL ❌ (regression vs base)");
    expect(yaml).toContain("infra, not a regression");
    // "regression vs base" appears exactly once — only in the gate-failure
    // branch, never as a catch-all for earlier-step failures.
    expect(yaml.split("regression vs base").length - 1).toBe(1);
  });

  test("H2d — header warns about REQUIRED-check deadlock and two-evals-per-push billing", () => {
    expect(yaml).toContain("REQUIRED");
    expect(yaml).toContain("deadlocks");
    expect(yaml).toContain("paths:");
    expect(yaml).toContain("bills TWO evals");
  });

  test("H5 — harnessDir prefixes working-directory, paths filter, and base checkout", () => {
    const nested = buildEvalCiWorkflowYaml({ harnessDir: "agents/concierge" });
    expect(nested).toContain("working-directory: agents/concierge");
    expect(nested).toContain('- "agents/concierge/crewhaus.yaml"');
    expect(nested).toContain('- "agents/concierge/eval/**"');
    // checkout paths resolve from the repo root, not working-directory.
    expect(nested).toContain("path: agents/concierge/.crewhaus-ci/base");
    // The base checkout is a FULL repo copy, so the nested harness's base
    // spec sits below the harness path inside it.
    expect(nested).toContain("crewhaus eval .crewhaus-ci/base/agents/concierge/crewhaus.yaml");
    expect(nested).toContain('[ -f ".crewhaus-ci/base/agents/concierge/crewhaus.yaml" ]');
    // Root scaffold stays unprefixed.
    expect(yaml).toContain('- "crewhaus.yaml"');
    expect(yaml).toContain("crewhaus eval .crewhaus-ci/base/crewhaus.yaml");
  });
});

describe("buildSentinelDriftWorkflowYaml (item 30)", () => {
  const yaml = buildSentinelDriftWorkflowYaml();

  test("runs the drift sentinel on a nightly cron + workflow_dispatch", () => {
    expect(yaml).toContain("name: sentinel-drift");
    expect(yaml).toContain("schedule:");
    expect(yaml).toContain("cron:");
    expect(yaml).toContain("workflow_dispatch: {}");
  });

  test("invokes eval --sentinel --baseline with a pinned seed", () => {
    expect(yaml).toContain("--sentinel --baseline eval/sentinel-baseline");
    expect(yaml).toContain('--seed "$SENTINEL_SEED"');
    expect(yaml).toContain('SENTINEL_SEED: "1"');
  });

  test("documents the committed-baseline rationale + how to freeze it", () => {
    expect(yaml).toContain("FROZEN baseline");
    expect(yaml).toContain("-o eval/sentinel-baseline");
    expect(yaml).toContain("git add");
    expect(yaml).toContain("ANTHROPIC_API_KEY");
  });

  test("harnessDir prefixes the working-directory + doc paths", () => {
    const nested = buildSentinelDriftWorkflowYaml({ harnessDir: "agents/concierge" });
    expect(nested).toContain("working-directory: agents/concierge");
    expect(nested).toContain("crewhaus eval agents/concierge/crewhaus.yaml");
    // Root scaffold stays unprefixed.
    expect(yaml).not.toContain("working-directory:");
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

  test("H5 — init [name] --ci (no repo): spec in the subdir, workflow at the CWD root", async () => {
    const root = newTempRoot();
    const res = await runCli(["init", "myagent", "--ci"], root);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, "myagent", "crewhaus.yaml"))).toBe(true);
    // GitHub only reads .github/workflows at the repo root — not a repo
    // yet, so the cwd (where the user will `git init`) stands in for it.
    expect(existsSync(join(root, EVAL_CI_WORKFLOW_RELPATH))).toBe(true);
    expect(existsSync(join(root, "myagent", EVAL_CI_WORKFLOW_RELPATH))).toBe(false);
    const wf = readFileSync(join(root, EVAL_CI_WORKFLOW_RELPATH), "utf-8");
    expect(wf).toContain("working-directory: myagent");
    expect(wf).toContain('- "myagent/crewhaus.yaml"');
    expect(res.stdout).toContain("repo root");
  });

  test("H5 — init [name] --ci inside a git repo: workflow at the REPO root, prefixed", async () => {
    const root = newTempRoot();
    Bun.spawnSync(["git", "-C", root, "init", "-q"]);
    const nested = join(root, "packages");
    mkdirSync(nested, { recursive: true });

    // cwd = <repo>/packages, harness = <repo>/packages/myagent.
    const res = await runCli(["init", "myagent", "--ci"], nested);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(nested, "myagent", "crewhaus.yaml"))).toBe(true);
    const wfPath = join(root, EVAL_CI_WORKFLOW_RELPATH);
    expect(existsSync(wfPath)).toBe(true);
    expect(existsSync(join(nested, "myagent", EVAL_CI_WORKFLOW_RELPATH))).toBe(false);
    const wf = readFileSync(wfPath, "utf-8");
    expect(wf).toContain("working-directory: packages/myagent");
    expect(wf).toContain('- "packages/myagent/crewhaus.yaml"');
    expect(wf).toContain('- "packages/myagent/eval/**"');
    expect(wf).toContain("path: packages/myagent/.crewhaus-ci/base");
    expect(res.stdout).toContain("repo root");
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

describe("crewhaus init --sentinel (CLI surface, item 30)", () => {
  test("fresh dir: scaffolds the spec AND the sentinel workflow", async () => {
    const root = newTempRoot();
    const res = await runCli(["init", "--sentinel"], root);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, "crewhaus.yaml"))).toBe(true);
    const wfPath = join(root, SENTINEL_WORKFLOW_RELPATH);
    expect(existsSync(wfPath)).toBe(true);
    expect(readFileSync(wfPath, "utf-8")).toBe(buildSentinelDriftWorkflowYaml());
    expect(res.stdout).toContain("sentinel:");
    expect(res.stdout).toContain("eval/sentinel-baseline");
  });

  test("existing harness: adds just the sentinel workflow, keeps the spec", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), SPEC_YAML);
    const res = await runCli(["init", "--sentinel"], root);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kept");
    expect(readFileSync(join(root, "crewhaus.yaml"), "utf-8")).toBe(SPEC_YAML);
    expect(existsSync(join(root, SENTINEL_WORKFLOW_RELPATH))).toBe(true);
  });

  test("refuses to overwrite an existing sentinel workflow without --force", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "crewhaus.yaml"), SPEC_YAML);
    await runCli(["init", "--sentinel"], root);
    const wfPath = join(root, SENTINEL_WORKFLOW_RELPATH);
    writeFileSync(wfPath, "# hand-edited\n");
    const refused = await runCli(["init", "--sentinel"], root);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--force");
    const forced = await runCli(["init", "--sentinel", "--force"], root);
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(wfPath, "utf-8")).toBe(buildSentinelDriftWorkflowYaml());
  });

  test("composes with --ci: both workflows land", async () => {
    const root = newTempRoot();
    const res = await runCli(["init", "--ci", "--sentinel"], root);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, EVAL_CI_WORKFLOW_RELPATH))).toBe(true);
    expect(existsSync(join(root, SENTINEL_WORKFLOW_RELPATH))).toBe(true);
  });
});

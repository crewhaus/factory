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
  DREAM_WORKFLOW_RELPATH,
  EVAL_CI_WORKFLOW_RELPATH,
  SENTINEL_WORKFLOW_RELPATH,
  buildDreamWorkflowYaml,
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

  // NEW-HUNT-8 — the optional nightly tier beside the drift probe.
  test("without --suite the document is byte-identical to the pre-suite scaffold", () => {
    expect(buildSentinelDriftWorkflowYaml({ suite: undefined })).toBe(yaml);
    expect(yaml).not.toContain("eval suite");
  });

  test("--suite appends a nightly-tier step that runs even when the probe failed", () => {
    const withSuite = buildSentinelDriftWorkflowYaml({ suite: "eval/suite.yaml" });
    expect(withSuite.startsWith(yaml)).toBe(true); // purely additive
    expect(withSuite).toContain("crewhaus eval suite eval/suite.yaml --tier nightly --gate");
    expect(withSuite).toContain("if: always()");
  });
});

// -------- NEW-HUNT-8: the tiered CI workflow --------

describe("buildEvalCiWorkflowYaml --suite (NEW-HUNT-8)", () => {
  const plain = buildEvalCiWorkflowYaml();
  const tiered = buildEvalCiWorkflowYaml({ suite: "eval/suite.yaml" });

  test("omitting --suite leaves the single-eval workflow untouched", () => {
    expect(buildEvalCiWorkflowYaml({ suite: undefined })).toBe(plain);
    expect(plain).not.toContain("eval suite");
  });

  test("PR job runs the fast tier twice — base spec pins, PR spec gates", () => {
    expect(tiered).toContain("crewhaus eval suite eval/suite.yaml --tier fast \\");
    expect(tiered).toContain("--spec .crewhaus-ci/base/crewhaus.yaml");
    expect(tiered).toContain("crewhaus eval suite eval/suite.yaml --tier fast --gate \\");
    // The base run comes first — it is what pins each entry's baseline.
    expect(tiered.indexOf("--spec .crewhaus-ci/base/crewhaus.yaml")).toBeLessThan(
      tiered.indexOf("--tier fast --gate"),
    );
  });

  test("a nightly job runs the nightly tier on a cron, not on PRs", () => {
    expect(tiered).toContain("nightly-tier:");
    expect(tiered).toContain("if: github.event_name != 'pull_request'");
    expect(tiered).toContain("crewhaus eval suite eval/suite.yaml --tier nightly --gate");
    expect(tiered).toContain("schedule:");
  });

  test("the suite manifest joins the paths filter", () => {
    expect(tiered).toContain('- "eval/suite.yaml"');
  });

  test("the check fails on tier failure and the comment posts either way", () => {
    expect(tiered).toContain("continue-on-error: true");
    expect(tiered).toContain("if: steps.tier.outcome == 'failure'");
    expect(tiered).toContain("suite.json");
  });

  test("fork PRs are skipped (they cannot read the API-key secret)", () => {
    expect(tiered).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  test("harnessDir prefixes working-directory, paths filter and base checkout", () => {
    const nested = buildEvalCiWorkflowYaml({ suite: "eval/suite.yaml", harnessDir: "agents/bot" });
    expect(nested).toContain("working-directory: agents/bot");
    expect(nested).toContain('- "agents/bot/eval/suite.yaml"');
    expect(nested).toContain("path: agents/bot/.crewhaus-ci/base");
    expect(nested).toContain("--spec .crewhaus-ci/base/agents/bot/crewhaus.yaml");
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

  test("--suite scaffolds the tiered workflow, warns on a missing manifest, and refuses an outside path", async () => {
    const tieredRoot = newTempRoot();
    const outsideRoot = newTempRoot();
    const barePath = newTempRoot();
    writeFileSync(join(tieredRoot, "crewhaus.yaml"), SPEC_YAML);
    writeFileSync(join(outsideRoot, "crewhaus.yaml"), SPEC_YAML);
    writeFileSync(join(barePath, "crewhaus.yaml"), SPEC_YAML);
    // Independent cases → concurrent spawns, with an explicit CI ceiling.
    const [tiered, outside, bare] = await Promise.all([
      runCli(["init", "--ci", "--suite", "eval/suite.yaml"], tieredRoot),
      runCli(["init", "--ci", "--suite", "../elsewhere/suite.yaml"], outsideRoot),
      // --suite without --ci/--sentinel has nothing to scaffold.
      runCli(["init", "--suite", "eval/suite.yaml"], barePath),
    ]);
    expect(tiered.exitCode).toBe(0);
    expect(readFileSync(join(tieredRoot, EVAL_CI_WORKFLOW_RELPATH), "utf-8")).toBe(
      buildEvalCiWorkflowYaml({ suite: "eval/suite.yaml" }),
    );
    expect(tiered.stderr).toContain("does not exist yet");
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toContain("inside the harness directory");
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("--ci");
  }, 60_000);

  test("--suite warns when the manifest declares no tier the workflow runs", async () => {
    // The scaffolded YAML hard-codes `--tier fast` (PR job) and `--tier
    // nightly` (cron). A fast-only manifest therefore gets a nightly cron
    // that dies with "suite declares no nightly tier" EVERY NIGHT — a
    // recurring red scheduled workflow caused purely by scaffold/manifest
    // mismatch. Say it at scaffold time.
    const fastOnly = newTempRoot();
    const bothTiers = newTempRoot();
    const unparseable = newTempRoot();
    for (const dir of [fastOnly, bothTiers, unparseable]) {
      writeFileSync(join(dir, "crewhaus.yaml"), SPEC_YAML);
      mkdirSync(join(dir, "eval"), { recursive: true });
    }
    const FAST_ENTRY =
      "  fast:\n    - name: smoke\n      dataset: eval/d.jsonl\n      graders: eval/g.yaml\n      thresholds: {min_pass_rate: 0.8}\n";
    writeFileSync(join(fastOnly, "eval", "suite.yaml"), `tiers:\n${FAST_ENTRY}`);
    writeFileSync(
      join(bothTiers, "eval", "suite.yaml"),
      `tiers:\n${FAST_ENTRY}  nightly:\n    - name: full\n      dataset: eval/d.jsonl\n      graders: eval/g.yaml\n      gate: true\n`,
    );
    writeFileSync(join(unparseable, "eval", "suite.yaml"), "tiers:\n  smoke: [\n");
    const [fast, both, broken, sentinel] = await Promise.all([
      runCli(["init", "--ci", "--suite", "eval/suite.yaml"], fastOnly),
      runCli(["init", "--ci", "--suite", "eval/suite.yaml"], bothTiers),
      runCli(["init", "--ci", "--suite", "eval/suite.yaml"], unparseable),
      runCli(["init", "--sentinel", "--suite", "eval/suite.yaml"], fastOnly),
    ]);
    expect(fast.exitCode).toBe(0);
    expect(fast.stderr).toContain("--tier nightly");
    expect(fast.stderr).toContain("declares only: fast");
    // A manifest declaring both tiers is silent.
    expect(both.exitCode).toBe(0);
    expect(both.stderr).not.toContain("declares only");
    // An unparseable manifest is a warning too, never a silent scaffold.
    expect(broken.exitCode).toBe(0);
    expect(broken.stderr).toContain("not a valid suite manifest");
    // The sentinel cron only runs the nightly tier — same warning, its tier.
    expect(sentinel.exitCode).toBe(0);
    expect(sentinel.stderr).toContain("--tier nightly");
  }, 60_000);

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

describe("buildDreamWorkflowYaml (v0.3.0 PR 14, §6.3)", () => {
  test("daily-or-slower cadence → nightly odd-minute cron", () => {
    const yaml = buildDreamWorkflowYaml({ specPath: "crewhaus.yaml", everyMs: 86_400_000 });
    expect(yaml).toContain('- cron: "19 4 * * *"');
    expect(yaml).toContain("workflow_dispatch: {}");
    expect(yaml).toContain("crewhaus dream run crewhaus.yaml");
    expect(yaml).toContain("window");
    expect(DREAM_WORKFLOW_RELPATH).toBe(join(".github", "workflows", "crewhaus-dream.yml"));
  });

  test("sub-daily cadence → hourly odd-minute cron", () => {
    const yaml = buildDreamWorkflowYaml({ specPath: "crewhaus.yaml", everyMs: 6 * 3_600_000 });
    expect(yaml).toContain('- cron: "19 * * * *"');
  });

  test("a nested harness gets a working-directory and a relative spec path", () => {
    const yaml = buildDreamWorkflowYaml({
      specPath: "crewhaus.yaml",
      everyMs: 86_400_000,
      harnessDir: "agents/support",
    });
    expect(yaml).toContain("working-directory: agents/support");
    expect(yaml).toContain("crewhaus dream run crewhaus.yaml");
  });
});

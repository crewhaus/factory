/**
 * Item 44 — `crewhaus init --ci`: the eval-on-PR CI gate as a scaffold.
 * Emits `.github/workflows/crewhaus-eval.yml`, which turns the shipped
 * `eval --gate` exit-code plumbing into a required PR check: every pull
 * request touching the spec, dataset, or graders is compiled, evaled, and
 * gated against the base branch — with the score-delta table posted as a
 * PR comment.
 *
 * Baseline strategy (the design decision, also documented in the workflow
 * comments): the job runs TWO fresh evals — the base branch's spec and the
 * PR's spec, both on the PR's dataset+graders, same pinned seed — instead
 * of diffing against a baseline persisted in the repo. Committing
 * `.crewhaus/evals/baselines.json` plus the pinned run directory would
 * save one eval per PR, but the stored transcripts go stale against every
 * provider/model change, force contributors to re-commit run artifacts on
 * every accepted change, and make the gate's "before" unreproducible. The
 * two-run flow needs no persisted state and isolates exactly the PR's
 * change (only the spec differs between the runs); the trade-off is one
 * extra eval per PR and exposure to judge nondeterminism, which the pinned
 * `--seed` and `--concurrency 1` bound as far as the graders allow.
 *
 * Mechanically the gate reuses the item-3 run-history machinery inside the
 * job's FRESH workspace: the first `crewhaus eval` (base spec) pins the
 * (spec, dataset) baseline; the second (PR spec) runs with `--gate`, which
 * diffs against that pin and exits non-zero on any pass-rate drop or
 * sample-level pass→fail flip. A PR that renames the spec or changes the
 * dataset keyset starts a new lineage — the gate passes vacuously and the
 * comment says so.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) mirroring `flywheel.ts`, which owns the shared
 * `scaffoldWorkflowFile` writer.
 */
import { join } from "node:path";
import { normalizeHarnessDir } from "./flywheel";

export const EVAL_CI_WORKFLOW_RELPATH = join(".github", "workflows", "crewhaus-eval.yml");

/**
 * The eval-gated-PR workflow. Model-budget-conscious by default:
 * `--concurrency 1` (the 30k-TPM default provider tier) and a pinned seed
 * for determinism.
 *
 * `harnessDir` (repo-root-relative, "" = root) adapts the scaffold to a
 * nested harness: the job's working-directory, the `paths:` trigger filter,
 * and the base-branch checkout `path:` are all repo-root-anchored, so every
 * one of them needs the prefix (finding 7).
 */
export function buildEvalCiWorkflowYaml(opts: { readonly harnessDir?: string } = {}): string {
  const sub = normalizeHarnessDir(opts.harnessDir);
  const prefix = sub === "" ? "" : `${sub}/`;
  const workingDirLine = sub === "" ? "" : `\n        working-directory: ${sub}`;
  // Working-dir-relative path of the base branch's spec: the base checkout
  // lands at <harness>/.crewhaus-ci/base (a FULL repo copy), so a nested
  // harness's spec sits at .crewhaus-ci/base/<harness>/crewhaus.yaml.
  const baseSpec = `.crewhaus-ci/base/${prefix}crewhaus.yaml`;
  const subdirNote =
    sub === ""
      ? `#   - If your harness lives in a subdirectory, re-run \`crewhaus init --ci\`
#     from the repo (the CLI detects the git root and prefixes everything),
#     or hand-set jobs.eval-gate.defaults.run.working-directory AND prefix
#     the paths: filter and the base-checkout path: — both resolve from the
#     repo root, not the working directory.`
      : `#   - Scaffolded for the harness at ${sub}/ — the job's
#     working-directory, the paths: filter, and the base-checkout path are
#     already prefixed.`;
  return `# crewhaus-eval.yml — scaffolded by \`crewhaus init --ci\`.
#
# Eval-gated spec PRs (the exact chain EP01 proves by hand): on every pull
# request touching the spec, dataset, or graders, this workflow
#   1. compiles the PR's spec (offline gate — a spec that doesn't compile
#      never spends eval budget),
#   2. evals the BASE branch's spec on the PR's dataset+graders (this pins
#      the run-history baseline in the job's fresh workspace),
#   3. evals the PR's spec with --gate, which diffs against that baseline
#      and exits non-zero on any pass-rate drop or per-sample pass→fail
#      flip (the strict gate from apps/cli/src/eval-history.ts),
#   4. posts the score-delta table as a PR comment, and
#   5. fails the check when the gate failed.
#
# BASELINE STRATEGY — why two fresh runs instead of a persisted baseline:
# committing .crewhaus/evals/baselines.json + the pinned run dir to the repo
# would save one eval per PR, but stored run artifacts go stale against
# every provider/model change, must be re-committed after every accepted
# PR, and make the "before" side unreproducible. Two fresh runs need no
# persisted state and isolate exactly the PR's change — only the SPEC
# differs between the runs (both use the PR's dataset+graders). Trade-off:
# one extra eval per PR + judge nondeterminism, bounded by the pinned
# EVAL_SEED and EVAL_CONCURRENCY=1 below.
#
# BRANCH-PROTECTION CAVEAT — read before marking this check REQUIRED:
# this workflow only runs on PRs that touch the paths: filter below. A PR
# that does NOT touch those paths never starts the workflow, so a REQUIRED
# crewhaus-eval check deadlocks it — stuck forever on "Expected — waiting
# for status". Leave the check optional, or enforce it only through
# paths-aware tooling (e.g. a merge queue that understands path filters).
# COST: every push to a matching PR re-runs the job and bills TWO evals
# (base spec + PR spec) against ANTHROPIC_API_KEY.
#
# Notes:
#   - First PR introducing the spec: the base branch has no crewhaus.yaml,
#     so there is no baseline — the base eval and the gate are SKIPPED, the
#     comment says so, and the check goes green; future PRs will gate.
#   - Fork PRs: the whole job is skipped (see jobs.eval-gate.if) — GitHub
#     does not expose the ANTHROPIC_API_KEY secret to fork-triggered runs.
#   - A PR that renames the spec or changes the dataset's sample keyset
#     starts a NEW baseline lineage: the gate passes vacuously (nothing
#     comparable to regress against) and the diff step says so.
#   - EVAL_CONCURRENCY=1 keeps the job under a low provider rate-limit
#     tier (the 30k-TPM default tier); raise it if your key allows.
${subdirNote}
#
# Required repo secret: ANTHROPIC_API_KEY (billed by the two eval runs).

name: crewhaus-eval

on:
  pull_request:
    paths:
      - "${prefix}crewhaus.yaml"
      - "${prefix}eval/**"

permissions:
  contents: read
  pull-requests: write # the score-delta comment

# One eval gate per PR head; a force-push cancels the stale run.
concurrency:
  group: crewhaus-eval-\${{ github.ref }}
  cancel-in-progress: true

env:
  EVAL_SEED: "1" # pinned for determinism across the base/PR runs
  EVAL_CONCURRENCY: "1" # 30k-TPM-tier default; raise if your key allows

jobs:
  eval-gate:
    # Fork PRs cannot read secrets.ANTHROPIC_API_KEY (GitHub withholds
    # secrets from fork-triggered runs), so the evals would fail red at
    # model-client construction — skip the whole job instead (a skipped
    # check is neutral, not a red X). Maintainers can gate a fork's change
    # by pushing its commits to an in-repo branch (same-repo PRs get
    # secrets), by re-running the eval after merge, or via a manual
    # workflow_dispatch wrapper of their own.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 30
    defaults:
      run:
        shell: bash${workingDirLine}
    steps:
      - name: Checkout PR
        uses: actions/checkout@v4

      - name: Checkout base branch (the gate's "before" spec)
        uses: actions/checkout@v4
        with:
          ref: \${{ github.base_ref }}
          # checkout paths resolve from the repo root (working-directory
          # only applies to run steps).
          path: ${prefix}.crewhaus-ci/base

      - name: Install Bun
        uses: oven-sh/setup-bun@v2

      - name: Install crewhaus CLI
        run: |
          bun add -g crewhaus
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"

      - name: Compile gate (offline)
        run: crewhaus compile crewhaus.yaml --emit-ir > /dev/null

      - name: Detect the baseline spec
        id: baseline
        run: |
          # First PR introducing the spec: the base branch has nothing to
          # gate against. Skip the base eval + the gate (green check) — the
          # comment step reports it; future PRs will gate.
          if [ -f "${baseSpec}" ]; then
            echo "exists=true" >> "$GITHUB_OUTPUT"
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
            echo "first PR introducing the spec — no baseline; future PRs will gate"
          fi

      - name: Eval base spec (pins the baseline)
        if: steps.baseline.outputs.exists == 'true'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Base SPEC, PR dataset+graders: only the spec differs between the
          # two runs, so the gate isolates exactly the PR's spec change.
          crewhaus eval ${baseSpec} \\
            --dataset eval/dataset.jsonl \\
            --graders eval/graders.yaml \\
            --concurrency "$EVAL_CONCURRENCY" --seed "$EVAL_SEED" \\
            -o .crewhaus-ci/runs/base

      - name: Eval PR spec (gated against the base run)
        id: gate
        if: steps.baseline.outputs.exists == 'true'
        # The comment must post either way; the last step re-fails the check.
        continue-on-error: true
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          crewhaus eval crewhaus.yaml \\
            --dataset eval/dataset.jsonl \\
            --graders eval/graders.yaml \\
            --concurrency "$EVAL_CONCURRENCY" --seed "$EVAL_SEED" \\
            --gate \\
            -o .crewhaus-ci/runs/pr

      - name: Comment the score delta on the PR
        if: always()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          read_row() { # $1 = run dir → "pass_rate | mean_score" (or n/a)
            bun -e "const r=JSON.parse(require('fs').readFileSync('$1/results.json','utf8'));process.stdout.write((r.aggregates.passRate*100).toFixed(1)+'% | '+r.aggregates.meanScore.toFixed(3))" 2>/dev/null \\
              || printf 'n/a | n/a'
          }
          BASE_ROW="$(read_row .crewhaus-ci/runs/base)"
          PR_ROW="$(read_row .crewhaus-ci/runs/pr)"
          DIFF_LINE="$(crewhaus eval-report diff .crewhaus-ci/runs/base .crewhaus-ci/runs/pr -o .crewhaus-ci/runs/diff 2>/dev/null | tail -n 1 \\
            || echo 'diff unavailable — new baseline lineage (spec renamed / dataset keyset changed) or a run failed')"
          # Only a FAILING GATE STEP is a regression. A gate that never ran
          # (no baseline, or an earlier step blew up) must not be labelled
          # one — its outcome is "skipped", not "failure".
          BASELINE="\${{ steps.baseline.outputs.exists }}"
          GATE_STATE="\${{ steps.gate.outcome }}"
          if [ "$BASELINE" = "false" ]; then
            VERDICT="NO BASELINE ✅ — first PR introducing the spec; future PRs will gate"
          elif [ "$GATE_STATE" = "success" ]; then
            VERDICT="PASS ✅"
          elif [ "$GATE_STATE" = "failure" ]; then
            VERDICT="FAIL ❌ (regression vs base)"
          else
            VERDICT="NOT RUN ⚠️ — an earlier step failed before the gate (infra, not a regression)"
          fi
          BODY="$(printf '## crewhaus eval gate: %s\\n\\n| run | pass_rate | mean_score |\\n| --- | --- | --- |\\n| base (%s) | %s |\\n| PR | %s |\\n\\n%s\\n\\n_seed %s · concurrency %s · gate: any pass-rate drop or per-sample pass→fail flip fails_\\n' \\
            "$VERDICT" "\${{ github.base_ref }}" "$BASE_ROW" "$PR_ROW" "$DIFF_LINE" "$EVAL_SEED" "$EVAL_CONCURRENCY")"
          gh api "repos/\${{ github.repository }}/issues/\${{ github.event.pull_request.number }}/comments" \\
            -f body="$BODY" \\
            || echo "comment skipped (read-only token — fork PR?)"

      - name: Fail the check on gate failure
        if: steps.gate.outcome == 'failure'
        run: |
          echo "eval gate failed — the PR spec regressed against \${{ github.base_ref }}"
          exit 1
`;
}

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

export const EVAL_CI_WORKFLOW_RELPATH = join(".github", "workflows", "crewhaus-eval.yml");

/**
 * The eval-gated-PR workflow. Model-budget-conscious by default:
 * `--concurrency 1` (the 30k-TPM default provider tier) and a pinned seed
 * for determinism.
 */
export function buildEvalCiWorkflowYaml(): string {
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
# Notes:
#   - A PR that renames the spec or changes the dataset's sample keyset
#     starts a NEW baseline lineage: the gate passes vacuously (nothing
#     comparable to regress against) and the diff step says so.
#   - EVAL_CONCURRENCY=1 keeps the job under a low provider rate-limit
#     tier (the 30k-TPM default tier); raise it if your key allows.
#   - Fork PRs get a read-only GITHUB_TOKEN — the comment step degrades
#     gracefully; the gate still gates.
#   - If your harness lives in a subdirectory, set
#     jobs.eval-gate.defaults.run.working-directory and adjust the paths
#     filter — the CLI resolves everything from the working directory.
#
# Required repo secret: ANTHROPIC_API_KEY (billed by the two eval runs).

name: crewhaus-eval

on:
  pull_request:
    paths:
      - "crewhaus.yaml"
      - "eval/**"

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
    runs-on: ubuntu-latest
    timeout-minutes: 30
    defaults:
      run:
        shell: bash
    steps:
      - name: Checkout PR
        uses: actions/checkout@v4

      - name: Checkout base branch (the gate's "before" spec)
        uses: actions/checkout@v4
        with:
          ref: \${{ github.base_ref }}
          path: .crewhaus-ci/base

      - name: Install Bun
        uses: oven-sh/setup-bun@v2

      - name: Install crewhaus CLI
        run: |
          bun add -g crewhaus
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"

      - name: Compile gate (offline)
        run: crewhaus compile crewhaus.yaml --emit-ir > /dev/null

      - name: Eval base spec (pins the baseline)
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Base SPEC, PR dataset+graders: only the spec differs between the
          # two runs, so the gate isolates exactly the PR's spec change.
          crewhaus eval .crewhaus-ci/base/crewhaus.yaml \\
            --dataset eval/dataset.jsonl \\
            --graders eval/graders.yaml \\
            --concurrency "$EVAL_CONCURRENCY" --seed "$EVAL_SEED" \\
            -o .crewhaus-ci/runs/base

      - name: Eval PR spec (gated against the base run)
        id: gate
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
          GATE_STATE="\${{ steps.gate.outcome }}"
          [ "$GATE_STATE" = "success" ] && VERDICT="PASS ✅" || VERDICT="FAIL ❌ (regression vs base)"
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

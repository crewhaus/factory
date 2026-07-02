/**
 * Item 45 — `crewhaus flywheel init|run`: the nightly self-improvement loop
 * as a product one-liner. Productizes the live-verified EP01 demo script
 * (compile gate → baseline eval → optimize → post-patch compile → after
 * eval → diff → acceptance gate → write-back) and its GitHub Actions
 * schedule, keeping the demo's invariants:
 *
 *   - a PR opened by the scaffolded workflow is NEVER auto-merged — a
 *     human is always the last gate;
 *   - the optimizer only ever touches `agent.instructions` (spec-patch's
 *     OPTIMIZABLE_PATHS enforces this — `permissions:` stays exactly as a
 *     human last reviewed it);
 *   - the flywheel refuses to run over uncommitted spec changes
 *     (`--allow-dirty` opts out);
 *   - ACCEPT-THEN-WRITE: `optimize` runs WITHOUT write-back and the patch
 *     is applied to the source spec only after the acceptance gate passes
 *     (pass_rate strictly up AND zero per-sample regressions, via the same
 *     `gateRuns` the eval run-history uses). A rejected patch never
 *     touches disk, so there is no write→reject→revert window at all.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) mirroring `eval-history.ts` / `datasets.ts`: the loop
 * itself takes injected step hooks so accept/reject/dry-run logic is
 * unit-testable with synthetic fitness — no credentials needed.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { gateRuns } from "./eval-history";

/** Thrown on invalid knobs/defaults and scaffold refusals. The CLI entry
 *  file catches it and routes the message through `die()`; tests assert on
 *  `.message` without the process exiting (mirrors DatasetRefError). */
export class FlywheelConfigError extends Error {
  override readonly name = "FlywheelConfigError";
}

// -------- knobs (flag > FLYWHEEL_* env > default) --------

/**
 * The demo's env knob names, kept verbatim for continuity — a repo that ran
 * the EP01 `nightly-flywheel.sh` can point its existing workflow env at
 * `crewhaus flywheel run` without renaming a secret or a variable.
 */
export const FLYWHEEL_ENV_KNOBS = {
  budgetUsd: "FLYWHEEL_BUDGET_USD",
  iterations: "FLYWHEEL_ITERATIONS",
  seed: "FLYWHEEL_SEED",
  concurrency: "FLYWHEEL_CONCURRENCY",
} as const;

export type FlywheelKnobs = {
  /** Hard USD ceiling for the optimizer's model-driven mutation calls. */
  readonly budgetUsd: number;
  readonly iterations: number;
  readonly seed: number;
  /** Eval fan-out. Default 1 keeps the loop under a low provider TPM tier
   *  (the 30k-TPM default tier) — unattended jobs favour reliability. */
  readonly concurrency: number;
};

/** Demo defaults: $2 cap, 3 iterations, seed 1 (reproducible PRs),
 *  concurrency 1 (rate-limit-tier safe). */
export const FLYWHEEL_DEFAULT_KNOBS: FlywheelKnobs = {
  budgetUsd: 2,
  iterations: 3,
  seed: 1,
  concurrency: 1,
};

type KnobSpec = {
  readonly key: keyof FlywheelKnobs;
  readonly flag: string;
  readonly env: string;
  readonly parse: (raw: string, source: string) => number;
};

function parsePositiveFloat(raw: string, source: string): number {
  // Number() instead of parseFloat() so trailing garbage ("2abc") is
  // rejected instead of silently truncated, plus an explicit finite check
  // so "Infinity" (a valid Number) can never become a budget.
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) {
    throw new FlywheelConfigError(`invalid ${source} "${raw}" — must be a positive finite number`);
  }
  return n;
}

function parsePositiveInt(raw: string, source: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || String(n) !== raw.trim()) {
    throw new FlywheelConfigError(`invalid ${source} "${raw}" — must be a positive integer`);
  }
  return n;
}

function parseInteger(raw: string, source: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new FlywheelConfigError(`invalid ${source} "${raw}" — must be an integer`);
  }
  return n;
}

const KNOB_SPECS: ReadonlyArray<KnobSpec> = [
  {
    key: "budgetUsd",
    flag: "budget-usd",
    env: FLYWHEEL_ENV_KNOBS.budgetUsd,
    parse: parsePositiveFloat,
  },
  {
    key: "iterations",
    flag: "iterations",
    env: FLYWHEEL_ENV_KNOBS.iterations,
    parse: parsePositiveInt,
  },
  { key: "seed", flag: "seed", env: FLYWHEEL_ENV_KNOBS.seed, parse: parseInteger },
  {
    key: "concurrency",
    flag: "concurrency",
    env: FLYWHEEL_ENV_KNOBS.concurrency,
    parse: parsePositiveInt,
  },
];

/**
 * Resolve the run knobs with flag > FLYWHEEL_* env > default precedence.
 * The env layer exists so the scaffolded workflow (and the EP01 demo's)
 * can steer a run purely through repository variables/dispatch inputs.
 */
export function resolveFlywheelKnobs(opts: {
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): FlywheelKnobs {
  const knobs = { ...FLYWHEEL_DEFAULT_KNOBS };
  for (const spec of KNOB_SPECS) {
    const flagValue = opts.flags[spec.flag];
    if (typeof flagValue === "string") {
      knobs[spec.key] = spec.parse(flagValue, `--${spec.flag}`);
      continue;
    }
    const envValue = opts.env[spec.env];
    if (envValue !== undefined && envValue !== "") {
      knobs[spec.key] = spec.parse(envValue, spec.env);
    }
  }
  return knobs;
}

// -------- dataset/graders defaults --------

export type FlywheelDataResolution = {
  /** `--dataset` value to use (file path or `registry:` ref). */
  readonly dataset: string;
  /** `--graders` file path to use. */
  readonly graders: string;
  readonly datasetSource: "flag" | "convention" | "ratings-registry";
  readonly gradersSource: "flag" | "convention";
};

/** The standalone-harness convention paths the flywheel defaults to. */
export const CONVENTIONAL_DATASET = join("eval", "dataset.jsonl");
export const CONVENTIONAL_GRADERS = join("eval", "graders.yaml");

/**
 * Resolve where the flywheel's dataset + graders come from when the flags
 * are omitted: the standalone-harness convention (`eval/dataset.jsonl` /
 * `eval/graders.yaml` beside the SPEC — resolved from the spec's directory,
 * matching the dirty-check's spec-dir behavior, so `flywheel run
 * path/to/crewhaus.yaml` from a sibling dir still finds the harness's own
 * files; flag paths stay cwd-relative), and — when the spec declares a
 * `feedback:` block and ratings have been distilled into the registry —
 * the `registry:<spec>-ratings` dataset the autoDistill flywheel feeds.
 */
export function resolveFlywheelData(opts: {
  readonly datasetFlag?: string;
  readonly gradersFlag?: string;
  readonly specName: string;
  /** Directory the spec lives in — the base for the conventional paths. */
  readonly specDir: string;
  readonly hasConventionalDataset: boolean;
  readonly hasConventionalGraders: boolean;
  /** `registry:<specName>-ratings` has at least one version. */
  readonly ratingsRegistered: boolean;
}): FlywheelDataResolution {
  let dataset: string;
  let datasetSource: FlywheelDataResolution["datasetSource"];
  if (opts.datasetFlag !== undefined) {
    dataset = opts.datasetFlag;
    datasetSource = "flag";
  } else if (opts.hasConventionalDataset) {
    dataset = join(opts.specDir, CONVENTIONAL_DATASET);
    datasetSource = "convention";
  } else if (opts.ratingsRegistered) {
    dataset = `registry:${opts.specName}-ratings`;
    datasetSource = "ratings-registry";
  } else {
    throw new FlywheelConfigError(
      `no dataset — pass --dataset <file|registry:name>, create ${CONVENTIONAL_DATASET}, ` +
        `or distill user ratings first (\`crewhaus distill --all-sessions --register ${opts.specName}-ratings\`)`,
    );
  }

  let graders: string;
  let gradersSource: FlywheelDataResolution["gradersSource"];
  if (opts.gradersFlag !== undefined) {
    graders = opts.gradersFlag;
    gradersSource = "flag";
  } else if (opts.hasConventionalGraders) {
    graders = join(opts.specDir, CONVENTIONAL_GRADERS);
    gradersSource = "convention";
  } else {
    throw new FlywheelConfigError(
      `no graders — pass --graders <graders.yaml>, create ${CONVENTIONAL_GRADERS}, or synthesize one from ratings (\`crewhaus distill --all-sessions --graders-out eval/graders.yaml\`)`,
    );
  }

  return { dataset, graders, datasetSource, gradersSource };
}

// -------- git cleanliness (invariant: never run over uncommitted spec edits) --------

/** True when `git status --porcelain -- <spec>` reported any change. */
export function specIsDirty(porcelain: string): boolean {
  return porcelain.trim() !== "";
}

// -------- acceptance gate --------

export type FlywheelVerdict = {
  readonly accepted: boolean;
  readonly reason: string;
  readonly passRateBefore: number;
  readonly passRateAfter: number;
  /** Sample-level pass→fail flips between the before and after runs. */
  readonly regressions: number;
  /** Sample-level fail→pass flips (what the accepted patch bought). */
  readonly recoveries: number;
};

/**
 * The flywheel's acceptance bar: BOTH conditions must hold —
 *   (a) the strict run-history gate passes (`gateRuns`: any pass-rate drop
 *       or sample-level pass→fail flip fails, even when recoveries cancel
 *       it out in the aggregates), and
 *   (b) pass_rate STRICTLY improved (a flat run passes the gate but is not
 *       worth a write-back/PR — taste over averages, per the demo).
 */
export function evaluateFlywheelAcceptance(
  before: EvalRunSummary,
  after: EvalRunSummary,
): FlywheelVerdict {
  const passRateBefore = before.aggregates.passRate;
  const passRateAfter = after.aggregates.passRate;
  const verdict = gateRuns(before, after);
  const base = {
    passRateBefore,
    passRateAfter,
    regressions: verdict.report.regressions.length,
    recoveries: verdict.report.recoveries.length,
  };
  // Fail closed on incomparable pass rates: a NaN/undefined rate (e.g. a
  // 0-sample run) satisfies neither `<=` nor `>`, so a strictly-up check
  // written as `after <= before → reject` would ACCEPT it. Reject
  // explicitly before any comparison runs.
  if (!Number.isFinite(passRateBefore) || !Number.isFinite(passRateAfter)) {
    return {
      accepted: false,
      reason:
        `pass_rate not comparable (before=${String(passRateBefore)}, ` +
        `after=${String(passRateAfter)}) — rejecting fail-closed`,
      ...base,
    };
  }
  if (verdict.verdict === "fail") {
    return { accepted: false, reason: verdict.reason ?? "regression gate failed", ...base };
  }
  // Fail-closed form: only a provable strict improvement accepts — any
  // non-ordered pair (including NaN, belt to the check above) rejects.
  if (!(passRateAfter > passRateBefore)) {
    return {
      accepted: false,
      reason:
        `pass_rate did not strictly improve (${formatPassRate(passRateBefore)} → ` +
        `${formatPassRate(passRateAfter)})`,
      ...base,
    };
  }
  return {
    accepted: true,
    reason: `pass_rate ${formatPassRate(passRateBefore)} → ${formatPassRate(passRateAfter)} with zero regressions`,
    ...base,
  };
}

export function formatPassRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// -------- the loop (injected steps → unit-testable accept/reject/dry-run) --------

/** What the optimize step reports back (the orchestrator's result, narrowed
 *  to what the flywheel needs). `applied` mirrors OptimizeSpecResult.applied:
 *  improvement ≥ threshold — NOT the flywheel acceptance verdict. */
export type FlywheelOptimizeOutcome = {
  readonly applied: boolean;
  /** The patched YAML, NOT yet written anywhere (accept-then-write). */
  readonly patchedYaml: string;
  readonly runId: string;
  /** The optimize artifacts dir (patch.json / report.json / evals/). */
  readonly outDir: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly mutatorName: string;
  readonly iterations: number;
  /** Formatted `$0.0000` spend total from the budget meter. */
  readonly spendUsd: string;
};

export type FlywheelHooks = {
  /** Offline parse→lower gate. Throws to fail the phase. */
  readonly compileCheck: (yaml: string, phase: "pre-optimize" | "post-optimize") => void;
  /** One full eval pass of `yaml` over the flywheel's dataset. */
  readonly evalRun: (label: "before" | "after", yaml: string) => Promise<EvalRunSummary>;
  /** The optimize search, run WITHOUT write-back. */
  readonly optimize: () => Promise<FlywheelOptimizeOutcome>;
  /** Apply the accepted patch: write-back + auto-register + regression pin. */
  readonly applyAccepted: (outcome: FlywheelOptimizeOutcome) => Promise<void>;
};

export type FlywheelOutcome =
  | "accepted"
  | "accepted-dry-run"
  | "rejected"
  | "no-improvement"
  | "patch-compile-failed";

export type FlywheelRunResult = {
  readonly outcome: FlywheelOutcome;
  readonly reason: string;
  readonly verdict?: FlywheelVerdict;
  readonly before?: EvalRunSummary;
  readonly after?: EvalRunSummary;
  readonly optimize?: FlywheelOptimizeOutcome;
};

/**
 * The complete loop with accept-then-write semantics. The source spec is
 * only ever touched by `hooks.applyAccepted`, which runs exactly when the
 * acceptance gate passed AND `dryRun` is false — every other path leaves
 * the working tree byte-identical, so there is nothing to revert. A
 * pre-optimize compile failure propagates (nothing was spent yet); a
 * post-optimize compile failure maps to `"patch-compile-failed"` (the
 * optimizer produced YAML the compiler rejects — an error, but the source
 * is untouched).
 */
export async function runFlywheelLoop(opts: {
  readonly sourceYaml: string;
  readonly dryRun: boolean;
  readonly hooks: FlywheelHooks;
}): Promise<FlywheelRunResult> {
  const { hooks } = opts;
  // 1. Offline sanity gate — a spec that doesn't compile must never reach
  //    the (paid) eval/optimize stages.
  hooks.compileCheck(opts.sourceYaml, "pre-optimize");

  // 2. Baseline eval.
  const before = await hooks.evalRun("before", opts.sourceYaml);

  // 3. Optimize — no write-back; the patch stays in memory.
  const optimize = await hooks.optimize();
  if (!optimize.applied) {
    return {
      outcome: "no-improvement",
      reason: "optimizer found no improvement above its threshold — spec untouched",
      before,
      optimize,
    };
  }

  // 4. Post-patch compile gate: if the winning candidate somehow produced
  //    YAML the parser rejects, stop here — the source was never written.
  try {
    hooks.compileCheck(optimize.patchedYaml, "post-optimize");
  } catch (err) {
    return {
      outcome: "patch-compile-failed",
      reason: `patched spec no longer compiles: ${err instanceof Error ? err.message : String(err)}`,
      before,
      optimize,
    };
  }

  // 5. After-eval on the patched spec (same dataset/graders/seed).
  const after = await hooks.evalRun("after", optimize.patchedYaml);

  // 6. Acceptance gate.
  const verdict = evaluateFlywheelAcceptance(before, after);
  if (!verdict.accepted) {
    return { outcome: "rejected", reason: verdict.reason, verdict, before, after, optimize };
  }

  // 7. Accepted. --dry-run stops here — everything ran, nothing writes.
  if (opts.dryRun) {
    return {
      outcome: "accepted-dry-run",
      reason: `${verdict.reason} (--dry-run: spec NOT written)`,
      verdict,
      before,
      after,
      optimize,
    };
  }
  await hooks.applyAccepted(optimize);
  return { outcome: "accepted", reason: verdict.reason, verdict, before, after, optimize };
}

// -------- report --------

/** One-screen flywheel report, printed after every run. */
export function formatFlywheelReport(
  result: FlywheelRunResult,
  extras: {
    readonly specPath: string;
    readonly datasetName: string;
    readonly sampleCount: number;
    readonly budgetUsd: number;
    readonly artifactsDir: string;
  },
): string[] {
  const lines: string[] = ["── flywheel report ──────────────────────────────"];
  lines.push(`spec:      ${extras.specPath}`);
  lines.push(`dataset:   ${extras.datasetName} (${extras.sampleCount} samples)`);
  if (result.before !== undefined && result.after !== undefined) {
    const b = result.before.aggregates.passRate;
    const a = result.after.aggregates.passRate;
    const delta = ((a - b) * 100).toFixed(1);
    lines.push(
      `pass_rate: ${formatPassRate(b)} → ${formatPassRate(a)} (Δ ${a >= b ? "+" : ""}${delta} pts)`,
    );
  } else if (result.before !== undefined) {
    lines.push(`pass_rate: ${formatPassRate(result.before.aggregates.passRate)} (baseline only)`);
  }
  if (result.verdict !== undefined) {
    lines.push(
      `samples:   ${result.verdict.recoveries} recovered / ${result.verdict.regressions} regressed`,
    );
  }
  if (result.optimize !== undefined) {
    // "optimizer spend/budget", not just "spend/budget": the budget meters
    // ONLY the optimizer's mutation model calls — eval spend (before/after
    // acceptance evals + per-iteration fitness evals) bills outside it.
    lines.push(
      `optimizer: ${result.optimize.mutatorName} · ${result.optimize.iterations} iteration(s) · ` +
        `optimizer spend ${result.optimize.spendUsd} (optimizer budget $${extras.budgetUsd.toFixed(2)})`,
    );
  }
  const verdictLabel: Record<FlywheelOutcome, string> = {
    accepted: "ACCEPTED — patch written back",
    "accepted-dry-run": "ACCEPTED (dry-run) — spec NOT written",
    rejected: "REJECTED — spec untouched",
    "no-improvement": "NO IMPROVEMENT — spec untouched",
    "patch-compile-failed": "PATCH COMPILE FAILED — spec untouched",
  };
  lines.push(`verdict:   ${verdictLabel[result.outcome]}`);
  lines.push(`           ${result.reason}`);
  lines.push(`artifacts: ${extras.artifactsDir}`);
  lines.push("─────────────────────────────────────────────────");
  return lines;
}

// -------- scaffolding (`flywheel init`) --------

export const FLYWHEEL_WORKFLOW_RELPATH = join(".github", "workflows", "crewhaus-flywheel.yml");

export type ScaffoldResult = { readonly path: string; readonly action: "wrote" };

/**
 * Write a workflow scaffold, refusing to overwrite an existing file unless
 * `force` (shared by `flywheel init` and `init --ci`). Throws
 * FlywheelConfigError on refusal so the CLI maps it to a clean `die()`.
 */
export function scaffoldWorkflowFile(opts: {
  readonly rootDir: string;
  readonly relPath: string;
  readonly content: string;
  readonly force: boolean;
}): ScaffoldResult {
  const path = join(opts.rootDir, opts.relPath);
  if (existsSync(path) && !opts.force) {
    throw new FlywheelConfigError(`${path} already exists — pass --force to overwrite`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, opts.content);
  return { path, action: "wrote" };
}

/**
 * Normalize a repo-root-relative harness dir for embedding in a scaffolded
 * workflow: POSIX separators, no leading `./`, no trailing slash; "" means
 * the harness IS the repo root. Shared by both workflow builders.
 */
export function normalizeHarnessDir(dir: string | undefined): string {
  if (dir === undefined) return "";
  const cleaned = dir.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  return cleaned === "." ? "" : cleaned;
}

/**
 * The GitHub Actions schedule, adapted from the EP01 demo's
 * `concierge-flywheel.yml`: nightly cron + manual dispatch, budget knobs as
 * FLYWHEEL_* env, PR creation via `gh` for HUMAN review. It never merges on
 * its own, and `crewhaus flywheel run` never writes an unaccepted patch, so
 * every change that reaches the default branch passed both the acceptance
 * gate and a human.
 *
 * `harnessDir` (repo-root-relative, "" = root) points the job's
 * working-directory at a nested harness AND prefixes the artifact upload
 * `path:` — actions paths resolve from the repo root and do NOT honor
 * `defaults.run.working-directory` (finding 7).
 */
export function buildFlywheelWorkflowYaml(opts: { readonly harnessDir?: string } = {}): string {
  const sub = normalizeHarnessDir(opts.harnessDir);
  const prefix = sub === "" ? "" : `${sub}/`;
  const workingDirLine = sub === "" ? "" : `\n        working-directory: ${sub}`;
  const subdirNote =
    sub === ""
      ? `# If your harness lives in a subdirectory, re-run \`crewhaus flywheel init\`
# from inside it (the CLI detects the git root and prefixes everything), or
# hand-set jobs.flywheel.defaults.run.working-directory AND prefix the
# artifact upload path: — actions paths resolve from the repo root and do
# NOT honor working-directory. The CLI resolves the spec, dataset, graders,
# and .crewhaus state from the working directory (standalone-harness
# convention).`
      : `# Scaffolded for the harness at ${sub}/ — the job's working-directory and
# the artifact upload path: are already pointed there. The CLI resolves the
# spec, dataset, graders, and .crewhaus state from the working directory
# (standalone-harness convention).`;
  return `# crewhaus-flywheel.yml — scaffolded by \`crewhaus flywheel init\`.
#
# The nightly self-improvement loop, unattended:
#   compile gate -> baseline eval -> optimize (budget-capped) -> post-patch
#   compile -> after eval -> acceptance gate (pass_rate strictly up AND zero
#   per-sample regressions) -> on accept, the spec is written back and this
#   workflow opens a PR for HUMAN review.
#
# Invariants (do not weaken):
#   - it NEVER merges on its own — a human is always the last gate;
#   - the optimizer only rewrites agent.instructions (spec-patch's
#     OPTIMIZABLE_PATHS enforces it) — \`permissions:\` stays human-reviewed;
#   - \`crewhaus flywheel run\` applies the patch only AFTER the acceptance
#     gate passes, so a rejected night leaves the tree byte-identical.
#
# Required repo secrets:
#   ANTHROPIC_API_KEY  — billed by eval + optimize. FLYWHEEL_BUDGET_USD caps
#                        ONLY the optimizer's mutation model calls; eval
#                        spend (before/after acceptance evals + the
#                        per-iteration fitness evals) is NOT metered by it.
#   FLYWHEEL_GH_TOKEN  — a PAT (or GitHub App token) with contents:write +
#                        pull-requests:write on this repo. Passed explicitly
#                        instead of the default GITHUB_TOKEN so the opened PR
#                        can trigger downstream CI (default-token pushes don't).
#
${subdirNote}

name: crewhaus-flywheel

on:
  schedule:
    # Nightly. Odd minute on purpose — avoids the top-of-hour stampede when
    # every cron on GitHub fires at once and gets delayed.
    - cron: "13 7 * * *"
  workflow_dispatch:
    inputs:
      optimizer_budget_usd:
        description: "Hard USD cap for the OPTIMIZER's mutation model calls this run (eval spend is billed separately, not metered by this)"
        required: false
        default: "2.00"
      iterations:
        description: "Optimizer iterations"
        required: false
        default: "3"

# Only one flywheel run at a time; a manual dispatch waits for a mid-flight
# nightly run instead of racing on the same crewhaus.yaml.
concurrency:
  group: crewhaus-flywheel
  cancel-in-progress: false

permissions:
  contents: write # push the accepted patch on a branch
  pull-requests: write # open the PR

jobs:
  flywheel:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    defaults:
      run:
        shell: bash${workingDirLine}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.FLYWHEEL_GH_TOKEN }}

      - name: Install Bun
        uses: oven-sh/setup-bun@v2

      - name: Install crewhaus CLI
        run: |
          bun add -g crewhaus
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"

      - name: Run the flywheel
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # Knobs (workflow_dispatch overrides the nightly defaults). The env
          # name is kept verbatim from the EP01 demo for continuity — the
          # dispatch input is named for what it actually meters (see
          # \`crewhaus flywheel --help\`).
          FLYWHEEL_BUDGET_USD: \${{ github.event.inputs.optimizer_budget_usd || '2.00' }}
          FLYWHEEL_ITERATIONS: \${{ github.event.inputs.iterations || '3' }}
          FLYWHEEL_SEED: "1" # deterministic mutator => reproducible PRs
          FLYWHEEL_CONCURRENCY: "1" # low-TPM-tier safe; raise if your key allows
        run: crewhaus flywheel run

      - name: Open a PR when the spec improved
        env:
          GH_TOKEN: \${{ secrets.FLYWHEEL_GH_TOKEN }}
        run: |
          if git diff --quiet -- crewhaus.yaml; then
            echo "no accepted improvement tonight — nothing to open (success-by-doing-nothing)"
            exit 0
          fi
          STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
          BRANCH="flywheel/\${STAMP}"
          git config user.name "crewhaus-flywheel[bot]"
          git config user.email "flywheel@crewhaus.ai"
          git checkout -b "\${BRANCH}"
          git add crewhaus.yaml
          git commit -m "flywheel: nightly self-improvement \${STAMP}"
          git push -u origin "\${BRANCH}"
          # A human reviews the rewritten agent.instructions and merges.
          # NEVER add an auto-merge step here — the human gate is the point.
          gh pr create \\
            --title "flywheel: nightly self-improvement (\${STAMP})" \\
            --body "Opened by the crewhaus flywheel. The acceptance gate passed (pass_rate strictly up, zero per-sample regressions). Review the rewritten \\\`agent.instructions\\\` — \\\`permissions:\\\` were not touched. Run artifacts are attached to this workflow run."

      - name: Upload run artifacts
        # Keep before/after results + the optimize trajectory even on nights
        # the flywheel writes nothing — that history proves the system works.
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flywheel-run-\${{ github.run_id }}
          # Action paths resolve from the repo root — they do NOT honor
          # defaults.run.working-directory, hence the explicit prefix for a
          # nested harness.
          path: ${prefix}.crewhaus/flywheel/
          if-no-files-found: ignore
          retention-days: 30
`;
}

/** Printed after `flywheel init` (and folded into `flywheel --help`): the
 *  env knobs the scaffolded workflow steers the run with. */
export function formatFlywheelKnobsGuide(): string[] {
  return [
    "flywheel env knobs (flag > env > default — same names as the EP01 demo):",
    `  ${FLYWHEEL_ENV_KNOBS.budgetUsd}=<usd>     optimizer model-call budget (default ${FLYWHEEL_DEFAULT_KNOBS.budgetUsd.toFixed(2)})`,
    `  ${FLYWHEEL_ENV_KNOBS.iterations}=<n>      optimizer iterations (default ${FLYWHEEL_DEFAULT_KNOBS.iterations})`,
    `  ${FLYWHEEL_ENV_KNOBS.seed}=<n>            deterministic seed (default ${FLYWHEEL_DEFAULT_KNOBS.seed})`,
    `  ${FLYWHEEL_ENV_KNOBS.concurrency}=<n>     eval fan-out (default ${FLYWHEEL_DEFAULT_KNOBS.concurrency}; 30k-TPM-tier safe)`,
    `  note: ${FLYWHEEL_ENV_KNOBS.budgetUsd} caps ONLY the optimizer's mutation model calls —`,
    "  eval spend (the before/after acceptance evals and the per-iteration fitness",
    "  evals) is NOT metered by this budget.",
  ];
}

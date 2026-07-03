/**
 * Item 30 — nightly model-drift sentinel evals against a FROZEN baseline.
 *
 * `crewhaus eval --sentinel --baseline <run-dir>` re-runs a seed-pinned
 * sentinel dataset against the UNCHANGED spec, then compares the fresh run to
 * a stored baseline run. The premise: when the spec (specHash) AND the dataset
 * (content hash) are BOTH byte-identical to the baseline, ANY pass/fail flip
 * or score shift can only be attributed to the PROVIDER silently changing
 * model behaviour — the one variable the harness did not hold fixed. So the
 * sentinel:
 *
 *   1. asserts `specHash` equality (baseline vs fresh run) — a mismatch means
 *      the spec changed, so this is NOT a clean drift probe: report and exit
 *      non-zero so a mis-pointed sentinel is loud rather than silently green.
 *   2. asserts DATASET-HASH equality. run.json only records `datasetName`, so
 *      the caller sha256's the dataset content itself and passes both hashes;
 *      a mismatch (different sentinel data) is likewise NOT a clean probe.
 *   3. with both hashes equal, diffs the two runs (`diffReports`) and gates on
 *      the strict regression-runner defaults. Any regression or score shift is
 *      flagged as provider drift; the command exits non-zero so a CI cron /
 *      scheduler alerts.
 *
 * Side-effect-free (this package's entry file runs an argv switch on import):
 * the fresh run + baseline load are performed by the caller and passed in as
 * `LoadedRun`s, so the drift logic is unit-testable with seeded run dirs.
 */
import { type LoadedRun, type ReportDiff, ReportError, diffReports } from "@crewhaus/eval-report";

export type SentinelVerdict = "clean" | "drift" | "not-comparable";

export type SentinelResult = {
  readonly verdict: SentinelVerdict;
  /** True when the caller should exit non-zero (drift OR not-comparable). */
  readonly alert: boolean;
  readonly reason: string;
  /** The score/flip diff, present only when the runs were comparable. */
  readonly diff?: ReportDiff;
};

/**
 * Compare a fresh run against a frozen baseline and decide whether the
 * provider drifted. `baselineDatasetHash` / `currentDatasetHash` are the
 * sha256 of the dataset CONTENT (run.json records only `datasetName`), so the
 * caller hashes the dataset file/registry record and passes both in.
 *
 * Verdicts:
 *   - `not-comparable` (alert): specHash or dataset-hash differs — the spec or
 *     the sentinel data changed, so a diff cannot be attributed to the
 *     provider. Loud, not silent: a mis-pointed sentinel must not read green.
 *   - `drift` (alert): both hashes equal AND the diff shows a regression or a
 *     score shift ⇒ the provider silently changed model behaviour.
 *   - `clean` (no alert): both hashes equal AND no regression / no score shift
 *     (recoveries alone are not drift-alerting — a provider getting BETTER on
 *     frozen inputs is still worth noting but is not a failure).
 */
export function evaluateSentinel(opts: {
  readonly baseline: LoadedRun;
  readonly current: LoadedRun;
  readonly baselineDatasetHash: string;
  readonly currentDatasetHash: string;
}): SentinelResult {
  const baseSpecHash = opts.baseline.summary.config.specHash;
  const curSpecHash = opts.current.summary.config.specHash;
  if (baseSpecHash !== curSpecHash) {
    return {
      verdict: "not-comparable",
      alert: true,
      reason: `spec changed since the baseline (specHash ${short(baseSpecHash)} → ${short(curSpecHash)}) — a sentinel probe requires an UNCHANGED spec; re-pin the baseline against the current spec`,
    };
  }
  if (opts.baselineDatasetHash !== opts.currentDatasetHash) {
    return {
      verdict: "not-comparable",
      alert: true,
      reason: `sentinel dataset changed since the baseline (datasetHash ${short(opts.baselineDatasetHash)} → ${short(opts.currentDatasetHash)}) — a sentinel probe requires byte-identical data; re-pin the baseline against the current dataset`,
    };
  }

  let diff: ReportDiff;
  try {
    diff = diffReports(opts.baseline, opts.current).diff;
  } catch (err) {
    if (err instanceof ReportError) {
      // Same specHash + dataset-hash but a keyset mismatch is a contradiction
      // (identical data can't change sample ids) — surface it as not-comparable
      // rather than crash the nightly job.
      return {
        verdict: "not-comparable",
        alert: true,
        reason: `sentinel diff failed despite equal hashes: ${err.message}`,
      };
    }
    throw err;
  }

  const drifted = diff.regressions.length > 0 || diff.scoreShifts.length > 0;
  if (drifted) {
    return {
      verdict: "drift",
      alert: true,
      reason:
        `provider drift on a frozen spec+dataset: ${diff.regressions.length} regression(s), ` +
        `${diff.scoreShifts.length} score-shift(s), ${diff.recoveries.length} recovery(-ies) ` +
        `(specHash ${short(baseSpecHash)}, datasetHash ${short(opts.baselineDatasetHash)} unchanged)`,
      diff,
    };
  }
  return {
    verdict: "clean",
    alert: false,
    reason: `no drift: spec+dataset frozen and every sample held its verdict (${diff.recoveries.length} recovery(-ies), ${diff.unchanged} unchanged)`,
    diff,
  };
}

function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

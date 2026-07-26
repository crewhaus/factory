/**
 * Item 29 — `crewhaus deploy canary <spec> <version> ...`: an eval-gated
 * unattended ramp with auto-rollback, wiring the REAL `regression-runner`
 * gate into the `canary-controller` (which ships dependency-inverted with an
 * always-pass stub only for tests — see `makeRegressionGate`).
 *
 * This module is deliberately side-effect-free (the CLI entry file runs an
 * argv switch on import, so it can't be imported by a test): all I/O — the
 * per-version eval, registry pins, audit appends, and stdout — is injected.
 * `apps/cli/src/index.ts` supplies the real implementations; the tests inject
 * seeded `EvalRunSummary` results plus the real `gate()` and a real
 * file-backed registry + audit log.
 *
 * The ramp drives the DECLARED traffic steps in order (e.g. 5,25,50,100). At
 * each step it evals BOTH the pinned baseline version and the candidate
 * version against the same dataset+graders, feeds the two summaries into
 * `regression-runner.gate()` (pass-rate + p95-latency thresholds), and:
 *   - on PASS at every step, auto-promotes the env pin to the candidate via
 *     the deployment path (`canary-controller.evaluate` re-pins on pass) and
 *     audit-logs a `deployment_action`;
 *   - on the FIRST failing step, auto-rolls-back (re-pins to the baseline)
 *     and audit-logs the regression reason, then stops the ramp.
 *
 * v1 CAVEAT (honest scope): `crewhaus eval` supports `target: cli`, and the
 * canary-controller's `route()` has no serving-path consumer, so the ramp %
 * gates eval SAMPLING/PROMOTION, not a real production traffic split. Each
 * step evals the FULL dataset against both versions and gates promotion on
 * the result — the percentages sequence the confidence ramp, they do not
 * split live requests. A real traffic split matters only for gateway/managed
 * shapes with a serving-path `route()` consumer; that is out of scope here
 * and called out in the CLI `--help`.
 *
 * E50 (`--traffic-split`) does NOT change that caveat — it adds the two
 * halves that ARE reachable: a durable deterministic per-request variant
 * assignment, and per-version outcome accounting built from the ramp's own
 * per-sample eval verdicts ({@link experimentOutcomesFromEvalRun}). Nothing
 * here intercepts a live request.
 *
 * The assignment's LIFECYCLE is part of that honesty: it is written only
 * AFTER a step's gate passes (a split nobody has verified is not a split
 * worth serving), and it is REMOVED when the ramp concludes either way —
 * promotion pins 100% candidate, rollback pins 100% baseline, and in both
 * end states a surviving 50/50 file would keep a compliant integration
 * routing half its keys at a version nobody is running.
 */
import type {
  ExperimentAssignment,
  ExperimentOutcomeRecord,
  RegressionGate,
} from "@crewhaus/canary-controller";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { sampleAbstained, sampleIsCanary } from "@crewhaus/eval-runner";
import { type GateThresholds, gate } from "@crewhaus/regression-runner";

/** Parse a `--traffic 5,25,50,100` list into validated, ordered steps. */
export function parseTrafficSteps(value: string): number[] {
  const raw = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (raw.length === 0) {
    throw new CanaryRampError("--traffic must list at least one percentage (e.g. 5,25,50,100)");
  }
  const steps: number[] = [];
  let last = 0;
  for (const token of raw) {
    const n = Number(token);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 100) {
      throw new CanaryRampError(
        `--traffic step "${token}" must be an integer in 1..100 (e.g. 5,25,50,100)`,
      );
    }
    if (n <= last) {
      throw new CanaryRampError(
        `--traffic steps must strictly increase; "${n}" does not exceed the previous "${last}"`,
      );
    }
    steps.push(n);
    last = n;
  }
  return steps;
}

export class CanaryRampError extends Error {
  override readonly name = "CanaryRampError";
}

/**
 * Build the {@link RegressionGate} closure the controller calls at each step:
 * eval both versions with the injected `evalVersion`, then run the real
 * `regression-runner.gate()` over the two summaries (baseline = prev,
 * candidate = next). Latency gating is ON here (unlike the pass-rate/flip-only
 * eval-history gate): a canary that regresses p95 latency is a real
 * production signal. Thresholds default to regression-runner's own
 * (5-point pass-rate drop, +5000ms p95) and are overridable via CLI flags.
 */
export function makeCanaryEvalGate(opts: {
  readonly evalVersion: (version: string) => Promise<EvalRunSummary>;
  readonly thresholds?: GateThresholds;
  readonly write?: (line: string) => void;
}): RegressionGate {
  const write = opts.write ?? (() => {});
  return async ({ fromVersion, toVersion }) => {
    write(`[canary] evaluating baseline ${fromVersion} and candidate ${toVersion}`);
    // Baseline first, then candidate — sequential so a low-TPM provider tier
    // isn't hit by two concurrent eval runs (the same reason the eval CI
    // scaffold pins --concurrency 1).
    const baseline = await opts.evalVersion(fromVersion);
    const candidate = await opts.evalVersion(toVersion);
    const verdict = gate(baseline, candidate, opts.thresholds ?? {});
    write(
      `[canary]   baseline pass_rate=${(baseline.aggregates.passRate * 100).toFixed(1)}% ` +
        `p95=${baseline.aggregates.p95LatencyMs}ms · ` +
        `candidate pass_rate=${(candidate.aggregates.passRate * 100).toFixed(1)}% ` +
        `p95=${candidate.aggregates.p95LatencyMs}ms`,
    );
    if (verdict.verdict === "fail") {
      return { verdict: "fail", reason: verdict.reason ?? "regression gate failed" };
    }
    return { verdict: "pass" };
  };
}

/**
 * E50 — project one version's eval run into experiment ledger observations:
 * one record per graded sample, attributed to the version that produced it.
 *
 * The sample id rides as `requestKey` because that IS this experiment's
 * stable key — an offline eval's "request" is a dataset sample, and keeping
 * it makes an observation traceable back to the transcript that produced it.
 * An ERRORED sample is a failure (the version did not answer), which is the
 * same convention `test_verdict` uses.
 *
 * A3 ABSTAINED and B18 CANARY samples are SKIPPED, exactly as
 * `eval-runner`'s own aggregator drops them from the pass-rate denominator
 * (`aggregate()`'s `scored` filter). An abstention is an explicit UNKNOWN —
 * its `passed: false` / `score: 0` are documented conservative placeholders,
 * not a verdict — so projecting it as a `failure` would bias this version's
 * success rate below the pass rate of the very run it was built from, which
 * is precisely the "count a guess" behaviour A3 exists to forbid. A canary
 * tripwire is never a measurement of the spec at all.
 */
export function experimentOutcomesFromEvalRun(args: {
  readonly experiment: string;
  readonly version: string;
  readonly summary: EvalRunSummary;
  /** Timestamp stamped on every record (one run = one observation batch). */
  readonly ts: string;
}): ExperimentOutcomeRecord[] {
  return args.summary.samples
    .filter((s) => !sampleAbstained(s) && !sampleIsCanary(s))
    .map((s) => ({
      ts: args.ts,
      experiment: args.experiment,
      version: args.version,
      outcome: s.grades.overall.passed ? "success" : "failure",
      requestKey: s.sampleId,
      score: s.grades.overall.score,
      source: "eval",
    }));
}

/**
 * E50 — the `--traffic-split` side-car for one canary ramp.
 *
 * Every effect is INJECTED (`append` / `writeAssignment` / `removeAssignment`
 * are canary-controller's ledger writers, supplied by `index.ts`) so this
 * module keeps its side-effect-free contract and the whole behaviour — the
 * "a 100% step is a promotion, not a split" rule, the one-batch-per-version
 * flush, the terminal retire, and the never-fail-the-ramp guard — is
 * unit-testable. `driveCanaryRamp` owns the call ORDER (see its docstring).
 *
 * A ramp that dies mid-flight (an exception, not a gate failure) records
 * nothing: the observations are the ramp's CONCLUDED measurement, and half a
 * ramp's worth of samples attributed to a version nobody decided about is
 * worse evidence than none.
 */
export type TrafficSplitRecorder = {
  /**
   * Hold one version's eval run as its LATEST measurement. Buffered, not
   * appended: see {@link makeTrafficSplitRecorder}. Never throws.
   */
  recordVersionRun(version: string, summary: EvalRunSummary): void;
  /**
   * Refresh the durable variant assignment for a ramp step that has PASSED
   * its gate. Never throws.
   */
  writeStepAssignment(trafficPercent: number): void;
  /**
   * Terminal hook, called exactly once when the ramp ends. Flushes the
   * buffered per-version observations (one batch per version) and retires the
   * assignment, because both end states are single-version. Never throws.
   */
  finish(outcome: "promoted" | "rolled-back"): void;
};

export function makeTrafficSplitRecorder(opts: {
  readonly experiment: string;
  readonly dir: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly env?: string;
  /** Stable salt for the bucket hash (the canary's tenant, when scoped). */
  readonly salt?: string;
  readonly append: (records: ReadonlyArray<ExperimentOutcomeRecord>, dir: string) => void;
  readonly writeAssignment: (assignment: ExperimentAssignment, dir: string) => void;
  /** Retire the assignment when the ramp concludes. */
  readonly removeAssignment: (name: string, dir: string) => boolean;
  readonly write?: (line: string) => void;
  readonly now?: () => string;
}): TrafficSplitRecorder {
  const write = opts.write ?? (() => {});
  const now = opts.now ?? (() => new Date().toISOString());
  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      // Accounting is observability, never the gate: a ledger write that
      // fails must not abort a release ramp.
      write(
        `[canary] warning: experiment ${what} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  // Latest measurement per version, in first-recorded order. A ramp evals
  // BOTH versions at EVERY step, over the same fixed dataset — appending each
  // step would put 4 copies of every sample id in the ledger for a default
  // 5,25,50,100 ramp, and `experiment status` would then treat repeat
  // measurements of one sample as independent observations (a ~2× narrower
  // Wilson interval at 4N, and `--min-n 30` cleared by an 8-sample dataset).
  // So the ramp contributes ONE batch per version — its final measurement —
  // flushed by `finish()`. Cross-invocation repeats are caught a second time
  // at read side by `dedupeExperimentOutcomes`.
  const latest = new Map<string, EvalRunSummary>();
  return {
    recordVersionRun(version, summary) {
      latest.set(version, summary);
    },
    writeStepAssignment(trafficPercent) {
      // A 100% step is not a split — it is the promotion, and `finish()`
      // retires the file rather than leaving the previous step's weights on
      // disk as the last word.
      if (trafficPercent >= 100) return;
      guard("assignment write", () => {
        opts.writeAssignment(
          {
            name: opts.experiment,
            updatedAt: now(),
            ...(opts.env !== undefined ? { env: opts.env } : {}),
            ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
            variants: [
              { version: opts.baselineVersion, weight: 100 - trafficPercent },
              { version: opts.candidateVersion, weight: trafficPercent },
            ],
            note:
              "deterministic per-request variant selection only — no CrewHaus serving " +
              "surface consults this file; call `crewhaus experiment assign` (or " +
              "selectExperimentVariant) at your own serving boundary. Written after " +
              "this step's regression gate PASSED, and removed when the ramp concludes " +
              "(promotion or rollback both end at a single pinned version)",
          },
          opts.dir,
        );
      });
    },
    finish(outcome) {
      guard("ledger write", () => {
        const ts = now();
        for (const [version, summary] of latest) {
          opts.append(
            experimentOutcomesFromEvalRun({ experiment: opts.experiment, version, summary, ts }),
            opts.dir,
          );
        }
      });
      guard("assignment retire", () => {
        if (!opts.removeAssignment(opts.experiment, opts.dir)) return;
        const verb =
          outcome === "promoted" ? "promoted the candidate" : "rolled back to the baseline";
        write(
          `[canary] experiment ${opts.experiment}: variant assignment retired — the ramp ${verb}, so the env pin is a single version and there is no split left to serve.`,
        );
      });
    },
  };
}

export type CanaryRampStepResult = {
  readonly trafficPercent: number;
  readonly verdict: "pass" | "fail";
  readonly reason?: string;
  readonly action?: "promote" | "rollback";
};

export type CanaryRampResult = {
  /** True only when every declared step passed and the candidate was promoted. */
  readonly promoted: boolean;
  readonly steps: ReadonlyArray<CanaryRampStepResult>;
  /** The step that failed (and triggered rollback), when any. */
  readonly failedAt?: number;
};

/**
 * Drive the declared traffic steps. `evaluateStep` is
 * `canary-controller.evaluate` bound to a config whose `trafficPercent` this
 * function sets per step; on pass it promotes the env pin, on fail it
 * rolls back. The ramp stops at the first failing step (the controller has
 * already rolled the env pin back to the baseline by then).
 *
 * The optional `recorder` is E50's `--traffic-split` side-car, driven HERE
 * rather than by the caller so the assignment can never disagree with the env
 * pin: a step's split is written only after that step's gate passed, and the
 * terminal `finish()` (which flushes the ledger and retires the assignment)
 * runs on BOTH exits. Wiring it into the loop is what makes the ordering
 * unit-testable without the CLI entry file.
 */
export async function driveCanaryRamp(opts: {
  readonly steps: ReadonlyArray<number>;
  readonly evaluateStep: (trafficPercent: number) => Promise<{
    verdict: "pass" | "fail";
    reason?: string;
    action?: "promote" | "rollback";
  }>;
  readonly recorder?: TrafficSplitRecorder;
  readonly write?: (line: string) => void;
}): Promise<CanaryRampResult> {
  const write = opts.write ?? (() => {});
  const results: CanaryRampStepResult[] = [];
  for (const trafficPercent of opts.steps) {
    write(`[canary] ramp step: ${trafficPercent}% traffic`);
    const outcome = await opts.evaluateStep(trafficPercent);
    const step: CanaryRampStepResult = {
      trafficPercent,
      verdict: outcome.verdict,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.action !== undefined ? { action: outcome.action } : {}),
    };
    results.push(step);
    if (outcome.verdict === "fail") {
      write(`[canary] step ${trafficPercent}% FAILED — ${outcome.reason ?? "regression"}`);
      write("[canary] auto-rolled-back to baseline; ramp aborted");
      opts.recorder?.finish("rolled-back");
      return { promoted: false, steps: results, failedAt: trafficPercent };
    }
    // AFTER the gate, never before: the durable split states a verified
    // ratio, and a failing step leaves nothing on disk to route on.
    opts.recorder?.writeStepAssignment(trafficPercent);
    write(`[canary] step ${trafficPercent}% passed`);
  }
  write("[canary] all ramp steps passed — candidate promoted");
  opts.recorder?.finish("promoted");
  return { promoted: true, steps: results };
}

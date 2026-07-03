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
 */
import type { RegressionGate } from "@crewhaus/canary-controller";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
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
 */
export async function driveCanaryRamp(opts: {
  readonly steps: ReadonlyArray<number>;
  readonly evaluateStep: (trafficPercent: number) => Promise<{
    verdict: "pass" | "fail";
    reason?: string;
    action?: "promote" | "rollback";
  }>;
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
      return { promoted: false, steps: results, failedAt: trafficPercent };
    }
    write(`[canary] step ${trafficPercent}% passed`);
  }
  write("[canary] all ramp steps passed — candidate promoted");
  return { promoted: true, steps: results };
}

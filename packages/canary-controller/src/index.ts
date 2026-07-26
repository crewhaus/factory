/**
 * Section 28 — `canary-controller`. Shifts a configurable percentage of
 * incoming requests to a new version of a spec. Hash routing on
 * `(tenantId, requestId-hash mod 100 < trafficPercent)` so a given user
 * stays on the same side of the canary across requests.
 *
 * After `evalIntervalMs` elapses, runs an eval-spec against both versions
 * in parallel and gates promotion on `regression-runner` (Section 29 —
 * `gate(baseline, candidate)` over two `EvalRunSummary` results).
 *
 * The real gate is wired by the caller (item 29 — `crewhaus deploy canary`):
 * canary-controller stays dependency-inverted (it does NOT import
 * `regression-runner`/`eval-runner`, keeping this a leaf package). Callers
 * build a `RegressionGate` with {@link makeRegressionGate}, injecting the
 * per-step "eval both versions, then compare" closure. {@link PASSING_GATE}
 * is retained ONLY as an explicit always-pass stub for tests and manual
 * dry-runs — it is no longer the wired production default.
 *
 * Without an eval gate (manual mode), the controller waits for an
 * explicit `crewhaus deploy promote` call.
 *
 * E50 — the N-variant generalization (deterministic per-request version
 * selection + per-version outcome accounting) lives in `./experiment`, which
 * shares this module's hash so a two-version canary and an N-variant
 * experiment can never disagree about which side of the split a key is on.
 * Read that module's HONEST BOUNDARY note before describing any of this as
 * live traffic splitting: nothing here intercepts a request.
 */
import type { AuditLog } from "@crewhaus/audit-log";
import type { DeploymentController } from "@crewhaus/deployment-controller";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { CanaryError } from "./errors";
import { requestBucket } from "./experiment";

export { CanaryError };
export {
  DEFAULT_EXPERIMENTS_DIR,
  EXPERIMENT_ASSIGNMENT_SUFFIX,
  EXPERIMENT_LEDGER_SUFFIX,
  appendExperimentOutcome,
  appendExperimentOutcomes,
  dedupeExperimentOutcomes,
  experimentFileName,
  listExperiments,
  readExperimentAssignment,
  readExperimentOutcomes,
  removeExperimentAssignment,
  requestBucket,
  selectExperimentVariant,
  tallyExperimentOutcomes,
  validateExperimentConfig,
  writeExperimentAssignment,
  type ExperimentAssignment,
  type ExperimentConfig,
  type ExperimentOutcomeRecord,
  type ExperimentSelection,
  type ExperimentVariant,
  type VariantTally,
} from "./experiment";

export type CanaryRoutingDecision = {
  readonly version: string;
  /** Whether this request is on the canary side. */
  readonly isCanary: boolean;
  /** Hash bucket value, 0-99. */
  readonly bucket: number;
};

export type RegressionGate = (input: {
  readonly fromVersion: string;
  readonly toVersion: string;
}) => Promise<{ readonly verdict: "pass" | "fail"; readonly reason?: string }>;

/**
 * EXPLICIT always-pass stub. NOT the wired production default anymore
 * (item 29): the CLI builds a real gate via {@link makeRegressionGate} that
 * evals both versions and runs `regression-runner`'s `gate()`. Kept only for
 * tests, `--dry-run`, and manual promotions that deliberately skip the eval
 * gate.
 */
export const PASSING_GATE: RegressionGate = async () => ({ verdict: "pass" });

/**
 * Build a real {@link RegressionGate} from a caller-supplied per-step
 * evaluator. The evaluator is the seam that keeps canary-controller
 * dependency-inverted: it evals BOTH versions and returns the comparison
 * verdict (in the CLI it runs two `eval-runner` passes and feeds the two
 * `EvalRunSummary` results into `regression-runner.gate()`). Any throw from
 * the evaluator is surfaced as a `fail` verdict so a broken eval never
 * silently promotes a candidate — the controller then auto-rolls-back.
 */
export function makeRegressionGate(
  evaluate: (input: {
    readonly fromVersion: string;
    readonly toVersion: string;
  }) => Promise<{ readonly verdict: "pass" | "fail"; readonly reason?: string }>,
): RegressionGate {
  return async (input) => {
    try {
      return await evaluate(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { verdict: "fail", reason: `eval gate errored: ${message}` };
    }
  };
}

export type CanaryConfig = {
  readonly name: string;
  /** Currently-pinned version (control). */
  readonly fromVersion: string;
  /** Candidate version (treatment). */
  readonly toVersion: string;
  /** 0-100. Percent of traffic routed to `toVersion`. */
  readonly trafficPercent: number;
  /** Optional environment to update on promote/rollback. Default: "prod". */
  readonly env?: string;
  /** Optional tenant scope. */
  readonly tenantId?: string;
};

export type CanaryEvalOptions = {
  readonly intervalMs: number;
  readonly gate: RegressionGate;
};

export interface CanaryController {
  /**
   * Decide which version to use for the given request id. Hash bucket
   * computed from `sha256(tenantId|requestId) mod 100`.
   */
  route(config: CanaryConfig, requestId: string): CanaryRoutingDecision;
  /**
   * Run the eval gate. On pass: promote (re-pin env to toVersion). On
   * fail: auto-rollback (re-pin env to fromVersion) and audit-log the
   * regression reason.
   */
  evaluate(
    config: CanaryConfig,
    evalOpts: CanaryEvalOptions,
  ): Promise<{
    readonly verdict: "pass" | "fail";
    readonly reason?: string;
    readonly action?: "promote" | "rollback";
  }>;
}

export type CanaryControllerOptions = {
  readonly registry: RegistryAdapter;
  readonly deploymentController: DeploymentController;
  readonly auditLog?: AuditLog;
  /** Optional override for `now()` to make tests deterministic. */
  readonly now?: () => number;
};

export function createCanaryController(opts: CanaryControllerOptions): CanaryController {
  return {
    route(config, requestId): CanaryRoutingDecision {
      if (
        !Number.isFinite(config.trafficPercent) ||
        config.trafficPercent < 0 ||
        config.trafficPercent > 100
      ) {
        throw new CanaryError(`trafficPercent must be in 0..100; got ${config.trafficPercent}`);
      }
      const bucket = requestBucket(config.tenantId, requestId);
      const isCanary = bucket < config.trafficPercent;
      return {
        version: isCanary ? config.toVersion : config.fromVersion,
        isCanary,
        bucket,
      };
    },

    async evaluate(
      config,
      evalOpts,
    ): Promise<{
      verdict: "pass" | "fail";
      reason?: string;
      action?: "promote" | "rollback";
    }> {
      const env = config.env ?? "prod";
      const result = await evalOpts.gate({
        fromVersion: config.fromVersion,
        toVersion: config.toVersion,
      });
      if (result.verdict === "pass") {
        // Promote: re-pin env to toVersion.
        if (config.tenantId) {
          await opts.registry.pinForTenant(config.tenantId, config.name, env, config.toVersion);
        } else {
          await opts.registry.pin(config.name, env, config.toVersion);
        }
        if (opts.auditLog) {
          await opts.auditLog.append({
            kind: "deployment_action",
            payload: {
              action: "promote",
              name: config.name,
              env,
              fromVersion: config.fromVersion,
              toVersion: config.toVersion,
              ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
              source: "canary-controller",
              ts: (opts.now ?? Date.now)(),
            },
          });
        }
        return {
          verdict: "pass",
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          action: "promote",
        };
      }
      // Rollback: re-pin env to fromVersion.
      if (config.tenantId) {
        await opts.registry.pinForTenant(config.tenantId, config.name, env, config.fromVersion);
      } else {
        await opts.registry.pin(config.name, env, config.fromVersion);
      }
      if (opts.auditLog) {
        await opts.auditLog.append({
          kind: "deployment_action",
          payload: {
            action: "rollback",
            name: config.name,
            env,
            fromVersion: config.toVersion,
            toVersion: config.fromVersion,
            ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
            source: "canary-controller",
            reason: result.reason ?? "regression detected",
            ts: (opts.now ?? Date.now)(),
          },
        });
      }
      return {
        verdict: "fail",
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        action: "rollback",
      };
    },
  };
}

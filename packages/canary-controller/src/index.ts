/**
 * Section 28 — `canary-controller`. Shifts a configurable percentage of
 * incoming requests to a new version of a spec. Hash routing on
 * `(tenantId, requestId-hash mod 100 < trafficPercent)` so a given user
 * stays on the same side of the canary across requests.
 *
 * After `evalIntervalMs` elapses, runs an eval-spec against both versions
 * in parallel and gates promotion on `regression-runner` (Section 29 —
 * but ships pre-§29 with a stub gate that returns "pass" until the real
 * regression-runner lands).
 *
 * Without an eval gate (manual mode), the controller waits for an
 * explicit `crewhaus deploy promote` call.
 */
import { createHash } from "node:crypto";
import type { AuditLog } from "@crewhaus/audit-log";
import type { DeploymentController } from "@crewhaus/deployment-controller";
import { CrewhausError } from "@crewhaus/errors";
import type { RegistryAdapter } from "@crewhaus/spec-registry";

export class CanaryError extends CrewhausError {
  override readonly name = "CanaryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

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

/** Stub gate that always passes. Replaced by §29 regression-runner integration. */
export const PASSING_GATE: RegressionGate = async () => ({ verdict: "pass" });

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
      if (config.trafficPercent < 0 || config.trafficPercent > 100) {
        throw new CanaryError(`trafficPercent must be in 0..100; got ${config.trafficPercent}`);
      }
      const bucket = computeBucket(config.tenantId, requestId);
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

function computeBucket(tenantId: string | undefined, requestId: string): number {
  const seed = `${tenantId ?? ""}|${requestId}`;
  const hash = createHash("sha256").update(seed).digest();
  // Take first 4 bytes as uint32, mod 100.
  const v =
    ((hash[0] ?? 0) << 24) | ((hash[1] ?? 0) << 16) | ((hash[2] ?? 0) << 8) | (hash[3] ?? 0);
  return Math.abs(v) % 100;
}

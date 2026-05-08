/**
 * Section 28 — `deployment-controller`. Promote / rollback over the
 * §28 spec-registry. Records every action to the §20 audit-log under
 * `kind: "deployment_action"` so the chain becomes the deploy history.
 *
 *   promote(name, fromEnv, toEnv)  copies the source-env's pinned
 *                                  version to the destination env.
 *   rollback(name, env, version)   re-pins the env to a known prior version.
 *
 * Both throw cleanly when the source pin doesn't exist or the rollback
 * version isn't in the registry.
 */
import type { AuditLog } from "@crewhaus/audit-log";
import { CrewhausError } from "@crewhaus/errors";
import type { RegistryAdapter } from "@crewhaus/spec-registry";

export class DeploymentError extends CrewhausError {
  override readonly name = "DeploymentError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type DeploymentRecordPayload = {
  readonly action: "promote" | "rollback";
  readonly name: string;
  readonly fromEnv?: string;
  readonly toEnv?: string;
  readonly env?: string;
  readonly fromVersion?: string;
  readonly toVersion: string;
  readonly tenantId?: string;
  readonly actor?: string;
  readonly ts: number;
};

export type DeploymentControllerOptions = {
  readonly registry: RegistryAdapter;
  readonly auditLog?: AuditLog;
  /** Optional tenant scope. */
  readonly tenantId?: string;
  /** Identifier (user / service) audit-logged with each action. */
  readonly actor?: string;
};

export interface DeploymentController {
  promote(name: string, fromEnv: string, toEnv: string): Promise<DeploymentRecordPayload>;
  rollback(name: string, env: string, version: string): Promise<DeploymentRecordPayload>;
}

export function createDeploymentController(
  opts: DeploymentControllerOptions,
): DeploymentController {
  async function audit(payload: DeploymentRecordPayload): Promise<void> {
    if (!opts.auditLog) return;
    await opts.auditLog.append({
      kind: "deployment_action",
      payload,
    });
  }

  return {
    async promote(name, fromEnv, toEnv): Promise<DeploymentRecordPayload> {
      const sourceVersion = opts.tenantId
        ? await opts.registry.aliasForTenant(opts.tenantId, name, fromEnv)
        : await opts.registry.aliasFor(name, fromEnv);
      if (!sourceVersion) {
        throw new DeploymentError(`cannot promote ${name}: ${fromEnv} has no pin to copy from`);
      }
      const previousTo = opts.tenantId
        ? await opts.registry.aliasForTenant(opts.tenantId, name, toEnv)
        : await opts.registry.aliasFor(name, toEnv);
      if (opts.tenantId) {
        await opts.registry.pinForTenant(opts.tenantId, name, toEnv, sourceVersion);
      } else {
        await opts.registry.pin(name, toEnv, sourceVersion);
      }
      const record: DeploymentRecordPayload = {
        action: "promote",
        name,
        fromEnv,
        toEnv,
        ...(previousTo !== undefined ? { fromVersion: previousTo } : {}),
        toVersion: sourceVersion,
        ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
        ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
        ts: Date.now(),
      };
      await audit(record);
      return record;
    },

    async rollback(name, env, version): Promise<DeploymentRecordPayload> {
      const all = await opts.registry.list(name);
      if (!all.includes(version)) {
        throw new DeploymentError(
          `cannot rollback ${name} ${env} → ${version}: version not in registry`,
        );
      }
      const previous = opts.tenantId
        ? await opts.registry.aliasForTenant(opts.tenantId, name, env)
        : await opts.registry.aliasFor(name, env);
      if (opts.tenantId) {
        await opts.registry.pinForTenant(opts.tenantId, name, env, version);
      } else {
        await opts.registry.pin(name, env, version);
      }
      const record: DeploymentRecordPayload = {
        action: "rollback",
        name,
        env,
        ...(previous !== undefined ? { fromVersion: previous } : {}),
        toVersion: version,
        ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
        ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
        ts: Date.now(),
      };
      await audit(record);
      return record;
    },
  };
}

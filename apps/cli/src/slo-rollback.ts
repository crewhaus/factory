/**
 * The `rollback` rung of `crewhaus run`'s SLO mitigation ladder: repoint the "prod" pin at
 * its last-known-good version. Everything it reads is injected, so a test drives it without
 * the entry file (which runs an argv switch on import).
 *
 * A protected "prod" (declared in `.crewhaus/environments.json`) takes the same approval
 * quorum as every other pin move, bound to the content of the version it would restore. Not
 * satisfied, the rung skips with one `[slo]` line naming the verb a person runs instead; the
 * `governance_approval` record is written either way. Alert and pause-intake still apply.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuditLog } from "@crewhaus/audit-log";
import type { SloMitigationEvent } from "@crewhaus/runtime-core";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import {
  buildGovernancePayload,
  candidateSpecHash,
  evaluateProtectedEnvGate,
} from "./approval-gate";
import { lastKnownGoodFromAuditRecords } from "./slo-sink";

/** The environment an SLO rollback moves. */
export const SLO_ROLLBACK_ENV = "prod";

/** The actor an SLO rollback's records name. */
export const SLO_ROLLBACK_ACTOR = "slo-monitor";

export type SloRollbackDeps = {
  /** The harness root: its `.crewhaus/spec-registry`, environments and approvals. */
  readonly cwd: string;
  /** The spec's registry name. */
  readonly name: string;
  readonly audit: AuditLog;
  /** Every record of the audit chain, for the last-known-good predecessor. */
  readonly readAuditRecords: () => unknown[];
  /** One line to stderr. */
  readonly write: (line: string) => void;
  /** Opens the registry at a root. Defaults to `@crewhaus/spec-registry`'s file-backed one. */
  readonly openRegistry?: (rootDir: string) => Promise<RegistryAdapter>;
  /** Moves the pin. Defaults to `@crewhaus/deployment-controller`'s `rollback`. */
  readonly rollbackPin?: (
    registry: RegistryAdapter,
    audit: AuditLog,
    name: string,
    env: string,
    version: string,
  ) => Promise<void>;
  readonly now?: () => number;
};

async function defaultOpenRegistry(rootDir: string): Promise<RegistryAdapter> {
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  return createFileBackedRegistry({ rootDir });
}

async function defaultRollbackPin(
  registry: RegistryAdapter,
  audit: AuditLog,
  name: string,
  env: string,
  version: string,
): Promise<void> {
  const { createDeploymentController } = await import("@crewhaus/deployment-controller");
  const controller = createDeploymentController({
    registry,
    auditLog: audit,
    actor: SLO_ROLLBACK_ACTOR,
  });
  await controller.rollback(name, env, version);
}

/** The rollback rung's handler. */
export function makeSloRollback(
  deps: SloRollbackDeps,
): (event: SloMitigationEvent) => Promise<void> {
  const openRegistry = deps.openRegistry ?? defaultOpenRegistry;
  const rollbackPin = deps.rollbackPin ?? defaultRollbackPin;
  const now = deps.now ?? (() => Date.now());
  return async (event) => {
    // Requires a cwd spec-registry; degrades to an audited no-op (a warning) when none exists.
    const specRootDir = join(deps.cwd, ".crewhaus", "spec-registry");
    if (!existsSync(specRootDir)) {
      deps.write(
        "[slo] rollback requested but no .crewhaus/spec-registry — skipping (alert/pause-intake still applied)",
      );
      return;
    }
    const registry = await openRegistry(specRootDir);
    const current = await registry.aliasFor(deps.name, SLO_ROLLBACK_ENV);
    // LAST-KNOWN-GOOD, not a lexicographic guess: the version that was pinned to prod
    // immediately BEFORE `current`, read from the deployment-controller's
    // `deployment_action` audit history. Never guess when flipping a prod pin.
    const prior = lastKnownGoodFromAuditRecords(
      deps.readAuditRecords(),
      deps.name,
      SLO_ROLLBACK_ENV,
      current,
    );
    if (prior === undefined) {
      deps.write(
        "[slo] rollback: no recorded last-known-good predecessor in deployment_action history — skipping (refusing to guess a prod pin; alert/pause-intake still applied)",
      );
      return;
    }
    // The predecessor must still exist in the registry (a deleted version can't be re-pinned).
    const versions = await registry.list(deps.name);
    if (!versions.includes(prior)) {
      deps.write(`[slo] rollback: last-known-good ${prior} no longer in registry — skipping`);
      return;
    }
    // A protected prod takes the approval quorum for the content it would restore.
    const gate = await evaluateProtectedEnvGate({
      harnessRoot: deps.cwd,
      specName: deps.name,
      toEnv: SLO_ROLLBACK_ENV,
      toVersion: prior,
      specHash: () => candidateSpecHash(registry, deps.name, prior),
    });
    if (gate.protected) {
      await deps.audit.append({
        kind: "governance_approval",
        payload: buildGovernancePayload(gate.input, gate.decision, {
          actor: SLO_ROLLBACK_ACTOR,
          now,
        }),
      });
      if (!gate.decision.satisfied) {
        deps.write(
          `[slo] rollback: ${SLO_ROLLBACK_ENV} is a protected environment and its approval quorum for ${prior} is not met — skipping (alert/pause-intake still applied); a person can run \`crewhaus deploy rollback ${deps.name} ${SLO_ROLLBACK_ENV} ${prior} --require-approval\``,
        );
        return;
      }
    }
    await rollbackPin(registry, deps.audit, deps.name, SLO_ROLLBACK_ENV, prior);
    deps.write(
      `[slo] auto-rolled-back ${deps.name} ${SLO_ROLLBACK_ENV} → ${prior} (last-known-good; SLO breach: ${event.breach.detail})`,
    );
  };
}

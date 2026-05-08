/**
 * Section 28 — `migration-runner`. Walks every spec in a `spec-registry`,
 * applies the registered migration chain, and writes new versions while
 * leaving old versions intact for rollback. Dry-run mode shows the diff
 * per spec before any write happens.
 *
 * Re-running with the same `(fromVersion, toVersion)` is a no-op once the
 * target version exists in the registry — the runner skips specs whose
 * latest version is already at or beyond `toVersion`.
 */
import { CrewhausError } from "@crewhaus/errors";
import type { MigrationEngine, SpecObject } from "@crewhaus/migration-engine";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export class MigrationRunnerError extends CrewhausError {
  override readonly name = "MigrationRunnerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type MigrationPlanItem = {
  readonly name: string;
  readonly latestVersion: string;
  readonly action: "skip" | "migrate" | "validate-fail";
  readonly newVersion?: string;
  readonly diff?: { fromVersion: number; toVersion: number };
  readonly error?: string;
};

export type MigrateAllOptions = {
  readonly registry: RegistryAdapter;
  readonly engine: MigrationEngine;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** When true, no writes happen — only the plan is returned. */
  readonly dryRun?: boolean;
  /**
   * Optional post-migration validator. If provided, the runner refuses to
   * write a spec that fails validation; the plan item carries the error.
   */
  readonly validate?: (spec: SpecObject, name: string) => void;
  /** Custom new-version naming. Default: append `-vN`. */
  readonly newVersionName?: (latest: string, toVersion: number) => string;
};

export type MigrateAllResult = {
  readonly plan: ReadonlyArray<MigrationPlanItem>;
  readonly migrated: number;
  readonly skipped: number;
  readonly failed: number;
};

const DEFAULT_NEW_VERSION = (latest: string, toVersion: number): string => {
  const m = latest.match(/^v(\d+)$/);
  if (m) return `v${(Number.parseInt(m[1] ?? "0", 10) || 0) + 1}`;
  return `${latest}-v${toVersion}`;
};

export async function migrateAll(opts: MigrateAllOptions): Promise<MigrateAllResult> {
  const newVersionName = opts.newVersionName ?? DEFAULT_NEW_VERSION;
  const specs = await opts.registry.listSpecs();
  const plan: MigrationPlanItem[] = [];

  for (const name of specs) {
    const versions = [...(await opts.registry.list(name))].sort();
    if (versions.length === 0) continue;
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    const yaml = await opts.registry.get(name, latest);
    let parsed: SpecObject;
    try {
      parsed = parseYaml(yaml) as SpecObject;
    } catch (err) {
      plan.push({
        name,
        latestVersion: latest,
        action: "validate-fail",
        error: `parse error: ${(err as Error).message}`,
      });
      continue;
    }
    const currentVersion = (parsed.version ?? 0) | 0;
    if (currentVersion >= opts.toVersion) {
      plan.push({ name, latestVersion: latest, action: "skip" });
      continue;
    }
    let migrated: SpecObject;
    try {
      migrated = opts.engine.migrate(parsed, opts.toVersion);
    } catch (err) {
      plan.push({
        name,
        latestVersion: latest,
        action: "validate-fail",
        error: `migration error: ${(err as Error).message}`,
      });
      continue;
    }
    if (opts.validate) {
      try {
        opts.validate(migrated, name);
      } catch (err) {
        plan.push({
          name,
          latestVersion: latest,
          action: "validate-fail",
          error: `validation: ${(err as Error).message}`,
        });
        continue;
      }
    }
    const newVersion = newVersionName(latest, opts.toVersion);
    plan.push({
      name,
      latestVersion: latest,
      action: "migrate",
      newVersion,
      diff: { fromVersion: currentVersion, toVersion: opts.toVersion },
    });
    if (!opts.dryRun) {
      const migratedYaml = stringifyYaml(migrated);
      await opts.registry.put(name, newVersion, migratedYaml);
    }
  }

  // Refuse to apply if any spec failed validation in non-dry-run mode.
  const failed = plan.filter((p) => p.action === "validate-fail").length;
  if (failed > 0 && !opts.dryRun) {
    throw new MigrationRunnerError(
      `${failed} spec(s) failed migration; run with dryRun: true to inspect`,
    );
  }

  return {
    plan,
    migrated: plan.filter((p) => p.action === "migrate").length,
    skipped: plan.filter((p) => p.action === "skip").length,
    failed,
  };
}

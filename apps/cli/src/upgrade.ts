import type { MigrationEngine, SpecObject } from "@crewhaus/migration-engine";
import { type SpecDiffEntry, diffSpecYaml } from "@crewhaus/spec-patch";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Item 43 — `crewhaus upgrade`. The single-spec upgrade assistant: detect the
 * cwd spec's schema version, run the migration-engine chain up to the CLI's
 * current spec version, validate the migrated spec, and show a diff. `--write`
 * applies.
 *
 * Distinct from `crewhaus migrate-all` (which walks the whole spec-REGISTRY):
 * `upgrade` operates on the working spec FILE the author edits. Crucially it
 * passes a `validate` callback — the CLI's `migrate-all` passed none, so a
 * migrated spec was written UNCHECKED; here every migrated spec must parse
 * before it can be written.
 *
 * Side-effect-free: `planUpgrade` is a pure function over the spec text + an
 * injected engine + validator. The CLI wrapper reads/writes the file and prints.
 */

export type UpgradeAction = "up-to-date" | "upgrade" | "ahead" | "validate-fail";

export type UpgradePlan = {
  readonly action: UpgradeAction;
  /** The spec's current schema version (`version ?? 0`). */
  readonly fromVersion: number;
  /** The CLI's current spec-schema version (engine.latestVersion()). */
  readonly toVersion: number;
  /** The migrated YAML — present only for `action: "upgrade"`. */
  readonly migratedYaml?: string;
  /** Field-level diff (old → migrated) — present for `action: "upgrade"`. */
  readonly diff?: ReadonlyArray<SpecDiffEntry>;
  /** Failure detail for `action: "validate-fail"`. */
  readonly error?: string;
};

/**
 * Compute the upgrade plan for a spec's YAML against `engine`.
 *
 *   - `up-to-date`  : the spec is already at the current version → no-op.
 *   - `ahead`       : the spec's version is HIGHER than the CLI supports
 *                     (a newer-CLI-authored spec) → refuse, don't downgrade.
 *   - `upgrade`     : migrate up, validate, and produce the diff.
 *   - `validate-fail`: the migrated spec failed the injected validator (the
 *                     migration produced an invalid spec) — never written.
 *
 * `validate` receives the migrated spec object + throws on invalid (the CLI
 * wires `parseSpec(stringifyYaml(spec))`). Migrations that throw are reported
 * as `validate-fail` too, so a broken migration chain never crashes upgrade.
 */
export function planUpgrade(
  yamlText: string,
  engine: MigrationEngine,
  validate: (spec: SpecObject) => void,
): UpgradePlan {
  const toVersion = engine.latestVersion();
  let parsed: SpecObject;
  try {
    parsed = parseYaml(yamlText) as SpecObject;
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion: 0,
      toVersion,
      error: `spec is not parseable YAML: ${(err as Error).message}`,
    };
  }
  const fromVersion = (parsed?.version ?? 0) | 0;

  if (fromVersion === toVersion) {
    return { action: "up-to-date", fromVersion, toVersion };
  }
  if (fromVersion > toVersion) {
    return { action: "ahead", fromVersion, toVersion };
  }

  let migrated: SpecObject;
  try {
    migrated = engine.migrate(parsed, toVersion);
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion,
      toVersion,
      error: `migration failed: ${(err as Error).message}`,
    };
  }
  // Validate the migrated spec BEFORE offering it for write (the fix for the
  // "migrated specs written unchecked" gap).
  try {
    validate(migrated);
  } catch (err) {
    return {
      action: "validate-fail",
      fromVersion,
      toVersion,
      error: `migrated spec failed validation: ${(err as Error).message}`,
    };
  }
  const migratedYaml = stringifyYaml(migrated);
  const diff = diffSpecYaml(yamlText, migratedYaml);
  return { action: "upgrade", fromVersion, toVersion, migratedYaml, diff };
}

/**
 * Build the validate callback the CLI passes to {@link planUpgrade}: it
 * stringifies the migrated spec object and runs it through the injected
 * `parse` (the CLI wires `parseSpec`). Kept here so the CLI wrapper does not
 * need its own `yaml` import — the fix for `migrate-all` writing migrated specs
 * unchecked is one shared, tested helper.
 */
export function makeSpecValidator(parse: (yaml: string) => unknown): (spec: SpecObject) => void {
  return (spec: SpecObject): void => {
    parse(stringifyYaml(spec));
  };
}

/** Render an upgrade plan as the human-readable report. `write` toggles the
 *  "would apply" vs "applied" wording; returns the block. */
export function formatUpgradePlan(plan: UpgradePlan, write: boolean): string {
  switch (plan.action) {
    case "up-to-date":
      return `upgrade: spec is already at the current version (v${plan.toVersion}) — nothing to do.\n`;
    case "ahead":
      return `upgrade: spec version v${plan.fromVersion} is NEWER than this CLI supports (v${plan.toVersion}).\n  Upgrade the CLI (\`brew upgrade crewhaus\` / \`npm i -g crewhaus\`) rather than downgrading the spec.\n`;
    case "validate-fail":
      return `upgrade: cannot migrate — ${plan.error}\n`;
    case "upgrade": {
      const lines: string[] = [];
      lines.push(`upgrade: v${plan.fromVersion} → v${plan.toVersion}`);
      const diff = plan.diff ?? [];
      if (diff.length === 0) {
        lines.push("  (no field-level changes — a version stamp only)");
      } else {
        for (const d of diff) {
          if (d.kind === "added") lines.push(`  + ${d.path}: ${d.after}`);
          else if (d.kind === "removed") lines.push(`  - ${d.path}: ${d.before}`);
          else lines.push(`  ~ ${d.path}: ${d.before} → ${d.after}`);
        }
      }
      lines.push("");
      lines.push(
        write
          ? "  applied — spec rewritten in place."
          : "  dry-run — re-run with --write to apply.",
      );
      return `${lines.join("\n")}\n`;
    }
  }
}

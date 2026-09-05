/**
 * Section 28 — `migration-runner`. Walks every spec in a `spec-registry`,
 * applies the registered migration chain, and writes new versions while
 * leaving old versions intact for rollback. Dry-run mode shows the diff
 * per spec before any write happens.
 *
 * Re-running with the same `(fromVersion, toVersion)` is a no-op once the
 * target version exists in the registry — the runner skips specs whose
 * latest version is already at `toVersion`.
 *
 * 0.6.0 (§9.2):
 *   - {@link migrateSpecYaml} is the ONE comment-preserving migration writer,
 *     shared with `crewhaus upgrade`: steps that declare `edits()` are
 *     applied on the `yaml` document CST ({@link applyMigrationEdits} — the
 *     same setIn / deleteIn technique as spec-patch's `applySpecEdits`, minus
 *     its unconditional `parseSpec`, because validation is this module's
 *     INJECTED `validate` seam and the CLI wires `parseSpec` there for both
 *     verbs); a step without edits falls back to re-serialising the object,
 *     and the result says which happened.
 *   - the skip branch is split by DIRECTION. An upward run (`fromVersion <=
 *     toVersion`, today's only real usage) keeps skipping specs already at or
 *     above the target. A downward run (`fromVersion > toVersion`) walks specs
 *     above the target DOWN, which is where `Migration.irreversible` becomes
 *     reachable: the engine's `MigrationIrreversibleError` lands on the plan
 *     as a `validate-fail` item instead of a silent skip.
 */
import { CrewhausError } from "@crewhaus/errors";
import type { MigrationEdit, MigrationEngine, SpecObject } from "@crewhaus/migration-engine";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { isSeq, parseDocument, parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
  /**
   * 0.6.0 — true when the written text kept the source's comments and key
   * order (every step supplied `edits()`); false when at least one step was
   * re-serialised object-level. Present for `action: "migrate"` only.
   */
  readonly commentsPreserved?: boolean;
};

export type MigrateAllOptions = {
  readonly registry: RegistryAdapter;
  readonly engine: MigrationEngine;
  /**
   * The version the run starts from. It decides the run's DIRECTION:
   * `fromVersion <= toVersion` is an upward run (specs at or above the
   * target skip); `fromVersion > toVersion` is a downward run (specs above
   * the target are walked down through `Migration.down`, and an
   * `irreversible` step surfaces as `validate-fail`).
   */
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

// ---------------------------------------------------------------------------
// The comment-preserving writer
// ---------------------------------------------------------------------------

export type MigratedSpecYaml = {
  /** The migrated YAML text. */
  readonly yaml: string;
  /** The migrated spec object (the engine's `up()`/`down()` result). */
  readonly spec: SpecObject;
  readonly fromVersion: number;
  readonly toVersion: number;
  /**
   * True when the text was produced ONLY through CST edits (every up-step
   * declared `edits()`), so the source's comments and key order survive.
   * False when any step was re-serialised — including every down-walk,
   * which has no edit seam.
   */
  readonly commentsPreserved: boolean;
};

/**
 * Apply `MigrationEdit`s to YAML text on the document CST so comments, key
 * order and blank lines survive: `value` present → `setIn` (upsert, creating
 * missing intermediate maps); `value` absent → `deleteIn` (idempotent). A
 * numeric segment may only address an EXISTING sequence item or append at
 * `length` — the CST would otherwise null-pad, which no migration means.
 * Pure text → text; the caller validates the result.
 */
export function applyMigrationEdits(yamlText: string, edits: ReadonlyArray<MigrationEdit>): string {
  if (edits.length === 0) return yamlText;
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new MigrationRunnerError(
      `spec YAML is not parseable: ${doc.errors[0]?.message ?? "unknown error"}`,
    );
  }
  edits.forEach((edit, i) => {
    const path = [...edit.path];
    if (path.length === 0) throw new MigrationRunnerError(`edit #${i} has an empty path`);
    if (edit.value === undefined) {
      if (doc.hasIn(path)) doc.deleteIn(path);
      return;
    }
    for (let d = 0; d < path.length; d++) {
      const seg = path[d];
      if (typeof seg !== "number") continue;
      const parent = d === 0 ? doc.contents : doc.getIn(path.slice(0, d), true);
      const length = isSeq(parent) ? parent.items.length : parent === undefined ? 0 : undefined;
      if (length === undefined || seg > length) {
        throw new MigrationRunnerError(
          `edit #${i}: index ${seg} at ${path.slice(0, d).join(".") || "(root)"} is out of bounds`,
        );
      }
    }
    try {
      doc.setIn(path, edit.value);
    } catch (err) {
      throw new MigrationRunnerError(
        `edit #${i} (${path.join(".")}) failed: ${(err as Error).message}`,
        err,
      );
    }
  });
  return doc.toString();
}

/** Order-insensitive structural equality (JSON-comparable values only). */
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => structurallyEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      structurallyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * 0.6.0 §9.2 — migrate a spec's YAML TEXT to `toVersion`, preserving
 * comments and key order wherever the chain allows.
 *
 * Up-walk: each step that declares `edits()` is applied through
 * {@link applyMigrationEdits} on the document CST; a step without edits
 * re-serialises its `up()` object. After a CST step the text is re-parsed and checked
 * against the step's `up()` object, so a migration whose two descriptions
 * disagree fails loudly here instead of writing one thing and reporting
 * another. Down-walk: object-level through the engine (which throws
 * `MigrationIrreversibleError` across a lossy step), then re-serialised.
 *
 * Throws (`MigrationError` / `MigrationRunnerError`)
 * rather than returning a failure: callers turn the message into their own
 * `validate-fail` item.
 */
export function migrateSpecYaml(
  yamlText: string,
  engine: MigrationEngine,
  toVersion: number,
): MigratedSpecYaml {
  const parsed = parseYaml(yamlText) as SpecObject;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MigrationRunnerError("spec YAML must be a mapping at the root");
  }
  const fromVersion = (parsed.version ?? 0) | 0;
  if (fromVersion === toVersion) {
    return { yaml: yamlText, spec: parsed, fromVersion, toVersion, commentsPreserved: true };
  }
  if (fromVersion > toVersion) {
    const spec = engine.migrate(parsed, toVersion);
    return { yaml: stringifyYaml(spec), spec, fromVersion, toVersion, commentsPreserved: false };
  }
  const plan = engine.planUp(parsed, toVersion);
  let yaml = yamlText;
  let commentsPreserved = true;
  for (const step of plan.steps) {
    if (step.edits === undefined) {
      yaml = stringifyYaml(step.spec);
      commentsPreserved = false;
      continue;
    }
    yaml = applyMigrationEdits(yaml, step.edits);
    const reparsed = parseYaml(yaml) as unknown;
    if (!structurallyEqual(reparsed, step.spec)) {
      throw new MigrationRunnerError(
        `migration ${step.from} → ${step.to}: its edits() and up() disagree — the CST-edited text does not parse to the object up() returns`,
      );
    }
  }
  return { yaml, spec: plan.spec, fromVersion, toVersion, commentsPreserved };
}

// ---------------------------------------------------------------------------
// The fleet walk
// ---------------------------------------------------------------------------

export async function migrateAll(opts: MigrateAllOptions): Promise<MigrateAllResult> {
  const newVersionName = opts.newVersionName ?? DEFAULT_NEW_VERSION;
  const downward = opts.fromVersion > opts.toVersion;
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
    const currentVersion = (parsed?.version ?? 0) | 0;
    // Direction gate (0.6.0 §9.2). Upward run: at-or-above the target skips,
    // exactly as before. Downward run: only specs ABOVE the target move, and
    // they walk DOWN — the branch that makes `irreversible` reachable.
    const needsMove = downward ? currentVersion > opts.toVersion : currentVersion < opts.toVersion;
    if (!needsMove) {
      plan.push({ name, latestVersion: latest, action: "skip" });
      continue;
    }
    let migrated: MigratedSpecYaml;
    try {
      migrated = migrateSpecYaml(yaml, opts.engine, opts.toVersion);
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
        opts.validate(migrated.spec, name);
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
      commentsPreserved: migrated.commentsPreserved,
    });
    if (!opts.dryRun) {
      await opts.registry.put(name, newVersion, migrated.yaml);
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

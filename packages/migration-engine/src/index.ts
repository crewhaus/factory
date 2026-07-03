/**
 * Section 28 — `migration-engine`. Versioned spec migrations registered as
 * `{ from, to, up, down }` so rollbacks work both directions. The engine
 * walks the registered chain to bridge any pair of source/target versions
 * (forward when `from < to`, reverse when `from > to`).
 *
 * Spec versions are integer ints (today every spec is `version: 0`). The
 * first migration registered is the no-op skeleton 0 → 1.
 *
 * Specs are passed in as parsed YAML (raw object); migration steps are
 * pure transforms `(spec) → spec` returning the next-version shape. The
 * engine is unaware of YAML serialisation — callers use yaml-js or the
 * spec parser to round-trip.
 */
import { CrewhausError } from "@crewhaus/errors";

export type SpecObject = Record<string, unknown> & {
  readonly version?: number;
};

export type Migration = {
  readonly from: number;
  readonly to: number;
  up(spec: SpecObject): SpecObject;
  down(spec: SpecObject): SpecObject;
};

export class MigrationError extends CrewhausError {
  override readonly name = "MigrationError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class MigrationEngine {
  private readonly migrations: Map<string, Migration>;

  constructor() {
    this.migrations = new Map<string, Migration>();
  }

  register(m: Migration): void {
    if (m.from === m.to) {
      throw new MigrationError(
        `migration ${m.from} → ${m.to} is a no-op (from === to); refusing to register`,
      );
    }
    if (Math.abs(m.to - m.from) !== 1) {
      throw new MigrationError(`migrations must be single-version steps; got ${m.from} → ${m.to}`);
    }
    const key = `${m.from}→${m.to}`;
    if (this.migrations.has(key)) {
      throw new MigrationError(`duplicate migration ${key}`);
    }
    this.migrations.set(key, m);
  }

  /**
   * Walk the registered chain to migrate `spec` from its current version
   * to `toVersion`. Throws MigrationError when a step is missing.
   */
  migrate(spec: SpecObject, toVersion: number): SpecObject {
    const fromVersion = (spec.version ?? 0) | 0;
    if (fromVersion === toVersion) return spec;

    let current = spec;
    if (fromVersion < toVersion) {
      // Walk up
      for (let v = fromVersion; v < toVersion; v++) {
        const key = `${v}→${v + 1}`;
        const step = this.migrations.get(key);
        if (!step) {
          throw new MigrationError(`no migration registered for ${key}`);
        }
        current = step.up(current);
      }
    } else {
      // Walk down
      for (let v = fromVersion; v > toVersion; v--) {
        const key = `${v - 1}→${v}`;
        const step = this.migrations.get(key);
        if (!step) {
          throw new MigrationError(`no migration registered for ${key} (needed for downgrade)`);
        }
        current = step.down(current);
      }
    }
    return current;
  }

  /** Diagnostic: list registered migration keys. */
  list(): ReadonlyArray<string> {
    return [...this.migrations.keys()].sort();
  }

  /**
   * #43 — the highest version this engine can migrate TO, i.e. the current
   * spec-schema version. It is the max `to` across every registered migration
   * (`0` when none are registered — nothing to upgrade to). `crewhaus upgrade`
   * uses this as the drift target so the CLI never hardcodes "1".
   */
  latestVersion(): number {
    let latest = 0;
    for (const m of this.migrations.values()) {
      if (m.to > latest) latest = m.to;
    }
    return latest;
  }

  /** Reset the registry (tests). */
  clear(): void {
    this.migrations.clear();
  }
}

/**
 * Skeleton migration 0 → 1 that today is a no-op. Future schema changes
 * land here and bump the IR version on the up() side.
 */
export const NOOP_0_TO_1: Migration = Object.freeze({
  from: 0,
  to: 1,
  up(spec) {
    return { ...spec, version: 1 };
  },
  down(spec) {
    return { ...spec, version: 0 };
  },
});

/** A pre-built engine with the v0 → v1 skeleton registered. */
export function createDefaultEngine(): MigrationEngine {
  const e = new MigrationEngine();
  e.register(NOOP_0_TO_1);
  return e;
}

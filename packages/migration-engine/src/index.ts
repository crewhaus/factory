/**
 * Section 28 — `migration-engine`. Versioned spec migrations registered as
 * `{ from, to, up, down }` so rollbacks work both directions. The engine
 * walks the registered chain to bridge any pair of source/target versions
 * (forward when `from < to`, reverse when `from > to`).
 *
 * Spec versions are integer ints. The first migration registered is the
 * no-op skeleton 0 → 1; 0.6.0 adds the first REAL migration, 1 → 2
 * (`MIGRATION_1_TO_2`, design §9.2).
 *
 * Specs are passed in as parsed YAML (raw object); migration steps are
 * pure transforms `(spec) → spec` returning the next-version shape. The
 * engine is unaware of YAML serialisation — callers use yaml-js or the
 * spec parser to round-trip.
 *
 * 0.6.0 (§9.2) — two additive seams on `Migration`:
 *
 *   - `edits?(spec)` declares the SAME change `up()` performs as a list of
 *     `SpecEdit`-shaped path/value edits. A caller that owns the YAML TEXT
 *     (`crewhaus upgrade`, `migrate-all`) applies those through the CST
 *     writer (`applySpecEdits` in `@crewhaus/spec-patch`) so comments and
 *     key order survive; `up()` stays the object-level truth for callers
 *     that only hold a parsed object. {@link MigrationEngine.planUp} walks
 *     the chain and hands both back per step.
 *   - `irreversible?: true` marks a lossy step. The DOWN-walk throws
 *     {@link MigrationIrreversibleError} across such a step instead of
 *     calling its `down()` — the marker alone would be decoration.
 */
import { CrewhausError } from "@crewhaus/errors";

export type SpecObject = Record<string, unknown> & {
  readonly version?: number;
};

export type MigrationEditPathSegment = string | number;

/**
 * One comment-preserving edit a migration declares: "make `path` carry
 * `value`" (upsert) or, when `value` is `undefined`, "make `path` absent".
 * Structurally identical to `SpecEdit` in `@crewhaus/spec-patch` — declared
 * here so the engine keeps its one-dependency footprint and stays
 * serialisation-free; callers pass these straight to `applySpecEdits`.
 */
export type MigrationEdit = {
  readonly path: ReadonlyArray<MigrationEditPathSegment>;
  readonly value?: unknown;
  readonly rationale?: string;
};

export type Migration = {
  readonly from: number;
  readonly to: number;
  up(spec: SpecObject): SpecObject;
  down(spec: SpecObject): SpecObject;
  /**
   * 0.6.0 §9.2 — the edit list equivalent to `up(spec)`, for callers that
   * hold the YAML text and want comments + key order preserved. Optional: a
   * step without it is applied object-level and re-serialised (the pre-0.6.0
   * comment-flattening path), which `planUp` reports per step.
   */
  edits?(spec: SpecObject): ReadonlyArray<MigrationEdit>;
  /**
   * 0.6.0 §9.2 — declares the step lossy. The engine refuses to walk DOWN
   * across it (`MigrationIrreversibleError`); `down()` is never called.
   * Reserved for a genuinely lossy future step — `MIGRATION_1_TO_2` is a
   * version stamp plus one explicit default and is NOT marked.
   */
  readonly irreversible?: true;
};

export class MigrationError extends CrewhausError {
  // Widened to `string` so the irreversible subclass can carry its own name.
  override readonly name: string = "MigrationError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** Thrown by the down-walk when it would have to cross an `irreversible` step. */
export class MigrationIrreversibleError extends MigrationError {
  override readonly name = "MigrationIrreversibleError";
  readonly from: number;
  readonly to: number;
  constructor(from: number, to: number) {
    super(
      `migration ${from} → ${to} is irreversible: a spec at v${to} cannot be walked back to v${from} (the step is lossy — restore the pre-migration file from version control or the registry's previous version instead)`,
    );
    this.from = from;
    this.to = to;
  }
}

/** One step of an up-walk as {@link MigrationEngine.planUp} reports it. */
export type MigrationStepPlan = {
  readonly from: number;
  readonly to: number;
  /** The step's declared edits — `undefined` when the migration supplies none. */
  readonly edits?: ReadonlyArray<MigrationEdit>;
  /** The spec object AFTER this step's `up()`. */
  readonly spec: SpecObject;
};

export type MigrationUpPlan = {
  /** The fully migrated spec object (equal to `steps.at(-1).spec`, or the input when no step ran). */
  readonly spec: SpecObject;
  readonly steps: ReadonlyArray<MigrationStepPlan>;
  /** True when EVERY step supplied `edits` — the whole walk can be applied comment-preserving. */
  readonly editsComplete: boolean;
};

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
   * to `toVersion`. Throws MigrationError when a step is missing, and
   * MigrationIrreversibleError when a DOWN-walk would cross an
   * `irreversible` step (checked before any `down()` runs, so a refused
   * downgrade leaves nothing half-applied).
   */
  migrate(spec: SpecObject, toVersion: number): SpecObject {
    const fromVersion = (spec.version ?? 0) | 0;
    if (fromVersion === toVersion) return spec;

    if (fromVersion < toVersion) {
      return this.planUp(spec, toVersion).spec;
    }
    // Walk down. Resolve every step first so an irreversible or missing step
    // is reported before any down() mutates anything.
    const steps: Migration[] = [];
    for (let v = fromVersion; v > toVersion; v--) {
      const key = `${v - 1}→${v}`;
      const step = this.migrations.get(key);
      if (!step) {
        throw new MigrationError(`no migration registered for ${key} (needed for downgrade)`);
      }
      if (step.irreversible === true) {
        throw new MigrationIrreversibleError(step.from, step.to);
      }
      steps.push(step);
    }
    let current = spec;
    for (const step of steps) current = step.down(current);
    return current;
  }

  /**
   * 0.6.0 §9.2 — the up-walk with the edit seam exposed: for each step from
   * the spec's version to `toVersion`, the step's `edits(specBefore)` (when
   * declared) and the object after `up()`. Callers holding YAML text apply
   * `edits` through the CST writer and fall back to re-serialising `spec`
   * only for steps that supply none. Throws MigrationError when a step is
   * missing or `toVersion` is below the spec's version (use `migrate`).
   */
  planUp(spec: SpecObject, toVersion: number): MigrationUpPlan {
    const fromVersion = (spec.version ?? 0) | 0;
    if (toVersion < fromVersion) {
      throw new MigrationError(
        `planUp: target v${toVersion} is below the spec's v${fromVersion} — downgrades go through migrate()`,
      );
    }
    const steps: MigrationStepPlan[] = [];
    let current = spec;
    let editsComplete = true;
    for (let v = fromVersion; v < toVersion; v++) {
      const key = `${v}→${v + 1}`;
      const step = this.migrations.get(key);
      if (!step) {
        throw new MigrationError(`no migration registered for ${key}`);
      }
      const edits = step.edits !== undefined ? step.edits(current) : undefined;
      if (edits === undefined) editsComplete = false;
      current = step.up(current);
      steps.push({
        from: step.from,
        to: step.to,
        ...(edits !== undefined ? { edits } : {}),
        spec: current,
      });
    }
    return { spec: current, steps, editsComplete };
  }

  /** Diagnostic: list registered migration keys. */
  list(): ReadonlyArray<string> {
    return [...this.migrations.keys()].sort();
  }

  /**
   * #43 — the highest version this engine can migrate TO, i.e. the current
   * spec-schema version. It is the max `to` across every registered migration
   * (`0` when none are registered — nothing to upgrade to). `crewhaus upgrade`
   * uses this as the drift target so the CLI never hardcodes a number.
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
 * Skeleton migration 0 → 1 (a version stamp only). Declares its edit list
 * too, so a 0 → 2 walk is comment-preserving end to end.
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
  edits() {
    return [{ path: ["version"], value: 1, rationale: "schema version stamp (0 → 1)" }];
  },
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — MIGRATION_1_TO_2
// ---------------------------------------------------------------------------

/** One `model_pool` block found in a spec object, with the path to it. */
export type ModelPoolSite = {
  /** Path from the spec root to the `model_pool` object (string keys / array indices). */
  readonly path: ReadonlyArray<MigrationEditPathSegment>;
  readonly pool: Record<string, unknown>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every place the spec schema hangs a `model_pool` block: the agent (cli /
 * channel / managed / pipeline / research / batch / browser / voice-less
 * pooled shapes), `agent.sub_agents.<name>`, workflow `steps[i]`, graph
 * `nodes.<name>`, crew `roles.<name>`. Pure structural walk over the parsed
 * object — no schema knowledge beyond the key names, so a spec of any
 * target (or an unparseable-by-zod one) still enumerates.
 */
export function findModelPools(spec: SpecObject): ReadonlyArray<ModelPoolSite> {
  const out: ModelPoolSite[] = [];
  const consider = (path: ReadonlyArray<MigrationEditPathSegment>, block: unknown): void => {
    if (!isRecord(block)) return;
    const pool = block["model_pool"];
    if (isRecord(pool)) out.push({ path: [...path, "model_pool"], pool });
  };
  const agent = spec["agent"];
  consider(["agent"], agent);
  if (isRecord(agent) && isRecord(agent["sub_agents"])) {
    for (const [name, def] of Object.entries(agent["sub_agents"])) {
      consider(["agent", "sub_agents", name], def);
    }
  }
  if (Array.isArray(spec["steps"])) {
    spec["steps"].forEach((step, i) => consider(["steps", i], step));
  }
  for (const mapKey of ["nodes", "roles"] as const) {
    const map = spec[mapKey];
    if (!isRecord(map)) continue;
    for (const [name, block] of Object.entries(map)) consider([mapKey, name], block);
  }
  return out;
}

/** A learned pool whose `reward.quality_source` is not yet explicit. */
function poolNeedsExplicitQualitySource(pool: Record<string, unknown>): boolean {
  if (pool["policy"] !== "learned") return false;
  const reward = pool["reward"];
  if (reward === undefined || reward === null) return true;
  if (!isRecord(reward)) return false; // malformed — leave it for the validator to reject
  return reward["quality_source"] === undefined;
}

/** Immutable deep-set along a string/index path (maps only — pool paths never cross arrays past `steps[i]`). */
function setAtPath(
  root: SpecObject,
  path: ReadonlyArray<MigrationEditPathSegment>,
  value: unknown,
): SpecObject {
  const step = (node: unknown, i: number): unknown => {
    const seg = path[i] as MigrationEditPathSegment;
    if (i === path.length - 1) {
      if (Array.isArray(node)) {
        const copy = [...node];
        copy[Number(seg)] = value;
        return copy;
      }
      return { ...(isRecord(node) ? node : {}), [seg]: value };
    }
    if (Array.isArray(node)) {
      const copy = [...node];
      copy[Number(seg)] = step(node[Number(seg)], i + 1);
      return copy;
    }
    const rec = isRecord(node) ? node : {};
    return { ...rec, [seg]: step(rec[seg as string], i + 1) };
  };
  return step(root, 0) as SpecObject;
}

const QUALITY_SOURCE_RATIONALE =
  "0.6.0: a learned pool's reward quality source is stated explicitly (runtime default `none`)";

/**
 * 0.6.0 §9.2 — the first REAL schema migration. Stamps `version: 2`, and
 * adds `reward: { quality_source: none }` explicitly — but ONLY on a
 * `model_pool` with `policy: learned` that does not already say (so the
 * default that now steers a learned reward is visible in the file). Nothing
 * else changes: every other 0.6.0 key is optional and absent-is-byte-identical.
 *
 * `edits()` and `up()` describe the same change; `planUp` consumers apply
 * `edits` through the CST writer so the file's comments and key order
 * survive. `down()` un-stamps the version and leaves the explicit default in
 * place (it is valid at v1 and harmless) — the step is trivially reversible,
 * so it is NOT marked `irreversible`.
 */
export const MIGRATION_1_TO_2: Migration = Object.freeze({
  from: 1,
  to: 2,
  up(spec) {
    let out: SpecObject = { ...spec, version: 2 };
    for (const site of findModelPools(spec)) {
      if (!poolNeedsExplicitQualitySource(site.pool)) continue;
      out = setAtPath(out, [...site.path, "reward", "quality_source"], "none");
    }
    return out;
  },
  down(spec) {
    return { ...spec, version: 1 };
  },
  edits(spec) {
    const edits: MigrationEdit[] = [
      { path: ["version"], value: 2, rationale: "schema version stamp (1 → 2)" },
    ];
    for (const site of findModelPools(spec)) {
      if (!poolNeedsExplicitQualitySource(site.pool)) continue;
      edits.push({
        path: [...site.path, "reward", "quality_source"],
        value: "none",
        rationale: QUALITY_SOURCE_RATIONALE,
      });
    }
    return edits;
  },
});

/** A pre-built engine with the full chain registered (0 → 1 → 2). */
export function createDefaultEngine(): MigrationEngine {
  const e = new MigrationEngine();
  e.register(NOOP_0_TO_1);
  e.register(MIGRATION_1_TO_2);
  return e;
}

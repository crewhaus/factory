/**
 * Criteria: what a harness's graders are checking for, named and owned, in
 * `graders.yaml` beside the graders themselves.
 *
 *   criteria:
 *     - id: dates-local
 *       title: Dates use the user's local time
 *       description: A date without a time zone is read in the user's local time zone.
 *       severity: high                 # critical | high | medium | low
 *       owner: maintainers             # a display label, never authority
 *       provenance: { source: human }  # human | guided-repair | drafted | imported | scaffold
 *       protected: true                # loosening it needs the harness's owner
 *       mode: observe                  # observe | enforce (default enforce)
 *       scope: { metadata: { family: [csv, import] } }
 *       examples:
 *         acceptable:   [{ text: "1 March 2026, local", case: csv-017 }]
 *         unacceptable: [{ text: "2026-02-28T23:00Z" }]
 *       measured_by: [dates_judge, iso_date_regex]
 *
 * A criterion binds graders by name; each grader is bound by at most one, so
 * its mode and scope are never in doubt. An `observe` criterion's graders
 * record what they would decide without deciding the case; a scoped
 * criterion's graders grade only the cases whose metadata matches, and every
 * other case reads skipped for them, with no call made.
 */
import { z } from "zod";
import { GraderError } from "./errors";
import type { GraderSpec, GradersConfig } from "./graders-config";
import { stableDigest } from "./graders-hash";

/** What a criterion's id looks like: a lower-case slug, 2 to 64 characters. */
export const CRITERION_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export const CRITERION_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CRITERION_SOURCES = [
  "human",
  "guided-repair",
  "drafted",
  "imported",
  "scaffold",
] as const;
export const CRITERION_MODES = ["observe", "enforce"] as const;

const CriterionExampleSchema = z
  .object({
    text: z.string().min(1),
    case: z.string().min(1).optional(),
  })
  .strict();

/** One `criteria:` entry. Strict: a typoed key is an error, never dropped. */
export const CriterionSpecSchema = z
  .object({
    id: z
      .string()
      .regex(CRITERION_ID_PATTERN, "a criterion id is a lower-case slug like dates-local"),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    severity: z.enum(CRITERION_SEVERITIES).optional(),
    owner: z.string().min(1).optional(),
    provenance: z
      .object({
        source: z.enum(CRITERION_SOURCES),
        change: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    protected: z.boolean().optional(),
    mode: z.enum(CRITERION_MODES).optional(),
    // Values are checked after parsing, so the error names the criterion.
    scope: z
      .object({ metadata: z.record(z.unknown()) })
      .strict()
      .optional(),
    examples: z
      .object({
        acceptable: z.array(CriterionExampleSchema).optional(),
        unacceptable: z.array(CriterionExampleSchema).optional(),
      })
      .strict()
      .optional(),
    measured_by: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type CriterionSpec = z.infer<typeof CriterionSpecSchema>;
export type CriterionMode = (typeof CRITERION_MODES)[number];
export type CriterionScope = { readonly metadata: Readonly<Record<string, readonly string[]>> };

/** What a grader is, as far as how far its verdict can be trusted goes. */
export type GraderKind = "deterministic" | "model" | "proof" | "human" | "custom";

/** The criterion a compiled grader measures for. */
export type CompiledCriterion = {
  readonly id: string;
  readonly mode: CriterionMode;
  readonly scope?: CriterionScope;
};

/**
 * The rules a criteria block must meet beyond its schema. Each refusal names
 * the criterion. Throws {@link GraderError}.
 */
export function checkCriteria(config: GradersConfig): void {
  const criteria = config.criteria ?? [];
  const graderNames = new Set(config.graders.map((g) => g.name));
  const ids = new Set<string>();
  const boundBy = new Map<string, string>();
  for (const c of criteria) {
    if (ids.has(c.id)) {
      throw new GraderError(`invalid graders config: criterion "${c.id}" is declared twice`);
    }
    ids.add(c.id);
    const own = new Set<string>();
    for (const name of c.measured_by) {
      if (!graderNames.has(name)) {
        throw new GraderError(
          `invalid graders config: criterion "${c.id}" is measured by "${name}", which is no grader in this file`,
        );
      }
      if (own.has(name)) {
        throw new GraderError(
          `invalid graders config: criterion "${c.id}" names grader "${name}" twice in measured_by`,
        );
      }
      own.add(name);
      const other = boundBy.get(name);
      if (other !== undefined) {
        throw new GraderError(
          `invalid graders config: grader "${name}" is bound by criteria "${other}" and "${c.id}" — a grader measures at most one criterion`,
        );
      }
      boundBy.set(name, c.id);
    }
    if (c.scope !== undefined) {
      for (const [key, values] of Object.entries(c.scope.metadata)) {
        if (key === "") {
          throw new GraderError(
            `invalid graders config: criterion "${c.id}" scopes on an empty metadata key`,
          );
        }
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some((v) => typeof v !== "string")
        ) {
          throw new GraderError(
            `invalid graders config: criterion "${c.id}" scope metadata "${key}" must be a non-empty list of strings`,
          );
        }
      }
    }
  }
}

/** The criterion binding each grader, by grader name. */
export function criterionByGrader(config: GradersConfig): ReadonlyMap<string, CriterionSpec> {
  const out = new Map<string, CriterionSpec>();
  for (const c of config.criteria ?? []) for (const name of c.measured_by) out.set(name, c);
  return out;
}

/** The compiled form of a criterion's measuring fields. */
export function compiledCriterion(c: CriterionSpec): CompiledCriterion {
  return {
    id: c.id,
    mode: c.mode ?? "enforce",
    ...(c.scope !== undefined ? { scope: c.scope as CriterionScope } : {}),
  };
}

/**
 * Whether a case is inside a scope: for every scope key, the case's
 * `metadata[key]` is a string the key's list holds. Non-string metadata is
 * never a match, as with slices. An absent scope covers every case.
 */
export function inCriterionScope(
  scope: CriterionScope | undefined,
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (scope === undefined) return true;
  for (const [key, values] of Object.entries(scope.metadata)) {
    const value = metadata?.[key];
    if (typeof value !== "string" || !values.includes(value)) return false;
  }
  return true;
}

/** The six grader types that compute their verdict without a model. */
const DETERMINISTIC_TYPES: ReadonlySet<GraderSpec["type"]> = new Set([
  "exact_match",
  "contains",
  "expected_contains",
  "regex",
  "json_path",
  "tool_call_sequence",
]);

/** A grader spec's kind, or `undefined` for a registry entry (its pack says). */
export function kindOfGraderSpec(spec: GraderSpec): GraderKind | undefined {
  if (DETERMINISTIC_TYPES.has(spec.type)) return "deterministic";
  if (spec.type === "llm_judge") return "model";
  return undefined;
}

/** sha256 hex of one grader's spec, key order aside. */
export function graderSpecDigest(spec: GraderSpec): string {
  return stableDigest(spec);
}

/** sha256 hex of a criterion with the specs of the graders it binds. */
export function criterionDigest(
  criterion: CriterionSpec,
  boundSpecs: ReadonlyArray<GraderSpec>,
): string {
  return stableDigest({ criterion, graders: boundSpecs });
}

/** The specs a criterion binds, in `measured_by` order (unknown names left out). */
export function boundSpecsOf(
  config: GradersConfig,
  criterion: CriterionSpec,
): ReadonlyArray<GraderSpec> {
  const byName = new Map(config.graders.map((g) => [g.name, g]));
  return criterion.measured_by.flatMap((name) => {
    const spec = byName.get(name);
    return spec !== undefined ? [spec] : [];
  });
}

/**
 * What a run records about the criteria it measured with: each criterion's
 * digest, mode, protection and scope, and the digest of each grader it binds.
 * `undefined` for a file with no criteria, so such a run records nothing new.
 */
export type RunCriterionRecord = {
  readonly id: string;
  readonly digest: string;
  /**
   * sha256 hex of what decides this criterion's verdict beyond its own
   * entry: the criterion, the specs of the graders it binds, and the file's
   * `combine`, `passing_threshold` and `per_model`. A change to the file's
   * policy moves it even when {@link digest} stays. Absent on a record
   * written before it existed.
   */
  readonly measuring?: string;
  readonly mode: CriterionMode;
  readonly protected?: true;
  readonly scope?: CriterionScope;
  readonly graders: ReadonlyArray<{ readonly name: string; readonly digest: string }>;
};

export function runCriteriaRecord(
  config: GradersConfig,
): ReadonlyArray<RunCriterionRecord> | undefined {
  const criteria = config.criteria ?? [];
  if (criteria.length === 0) return undefined;
  return criteria.map((c) => {
    const specs = boundSpecsOf(config, c);
    return {
      id: c.id,
      digest: criterionDigest(c, specs),
      measuring: stableDigest({
        criterion: c,
        graders: specs,
        file: {
          combine: config.combine ?? "all",
          passing_threshold: config.passing_threshold ?? null,
          per_model: config.per_model ?? null,
        },
      }),
      mode: c.mode ?? "enforce",
      ...(c.protected === true ? { protected: true as const } : {}),
      ...(c.scope !== undefined ? { scope: c.scope as CriterionScope } : {}),
      graders: specs.map((s) => ({ name: s.name, digest: graderSpecDigest(s) })),
    };
  });
}

/** One way an edit loosens a protected criterion. */
export type Loosening = {
  readonly criterion: string;
  readonly reason: string;
};

/** A judge's scalar passing score, with the rubric default of 3 when absent. */
function passingScoreOf(spec: GraderSpec | undefined): number | undefined {
  if (spec === undefined || spec.type !== "llm_judge") return undefined;
  if (spec.rubric.kind === "categorical") return undefined;
  return spec.rubric.passing_score ?? 3;
}

/**
 * The protected criteria an edit from `before` to `after` loosens, each with
 * why: the criterion is removed or no longer protected, it moves from
 * enforcing to observing, its scope narrows (a selector value removed, or a
 * key added), a grader it binds is unbound or removed, a bound judge changes
 * in any way but a raised scalar `passing_score`, a bound grader that is not a
 * judge changes, or the file's `combine`, `passing_threshold` (other than
 * raised) or `per_model` changes while it holds a protected criterion. A
 * change that only tightens returns nothing. Pure.
 */
export function loosening(before: GradersConfig, after: GradersConfig): Loosening[] {
  const out: Loosening[] = [];
  const afterById = new Map((after.criteria ?? []).map((c) => [c.id, c]));
  const beforeSpecs = new Map(before.graders.map((g) => [g.name, g]));
  const afterSpecs = new Map(after.graders.map((g) => [g.name, g]));
  for (const was of before.criteria ?? []) {
    if (was.protected !== true) continue;
    const add = (reason: string): void => {
      out.push({ criterion: was.id, reason });
    };
    const now = afterById.get(was.id);
    if (now === undefined) {
      add("the protected criterion is removed");
      continue;
    }
    if (now.protected !== true) add("its protection is removed");
    if ((was.mode ?? "enforce") === "enforce" && now.mode === "observe") {
      add("it moves from enforcing to observing");
    }
    for (const reason of scopeNarrowing(was.scope, now.scope)) add(reason);
    const nowBound = new Set(now.measured_by);
    for (const name of was.measured_by) {
      const wasSpec = beforeSpecs.get(name);
      const nowSpec = afterSpecs.get(name);
      if (!nowBound.has(name) || nowSpec === undefined) {
        add(`grader "${name}" no longer measures it`);
        continue;
      }
      if (wasSpec === undefined) continue;
      if (wasSpec.type === "llm_judge" && nowSpec.type === "llm_judge") {
        // A judge only tightens by a raised scalar passing score: every
        // other change (its rubric, labels, model, panel, target, repeats,
        // per-model cuts or weight) is a loosening until the owner says not.
        const wasCut = passingScoreOf(wasSpec);
        const nowCut = passingScoreOf(nowSpec);
        if (wasCut !== undefined && nowCut !== undefined && nowCut < wasCut) {
          add(`judge "${name}" passes at ${nowCut}, below ${wasCut}`);
        }
        if (declaredCut(wasSpec) === undefined && declaredCut(nowSpec) !== undefined) {
          add(`judge "${name}" declares a passing score in place of its calibrated one`);
        }
        if (stableDigest(withoutCut(wasSpec)) !== stableDigest(withoutCut(nowSpec))) {
          add(`judge "${name}" changes beyond a raised passing score`);
        }
        continue;
      }
      if (stableDigest(wasSpec) !== stableDigest(nowSpec)) {
        add(`grader "${name}" changes`);
      }
    }
  }
  // The file-level policy decides every criterion's verdict, so a file with
  // a protected criterion changes it only with the owner; a raised
  // `passing_threshold` under the same policy is the one tightening.
  const protectedIds = (before.criteria ?? []).filter((c) => c.protected === true).map((c) => c.id);
  if (protectedIds.length > 0) {
    const fileReasons: string[] = [];
    if ((before.combine ?? "all") !== (after.combine ?? "all")) {
      fileReasons.push(
        `the file's combine policy changes from ${before.combine ?? "all"} to ${after.combine ?? "all"}`,
      );
    }
    const wasThreshold = before.passing_threshold;
    const nowThreshold = after.passing_threshold;
    if (
      wasThreshold !== nowThreshold &&
      !(wasThreshold !== undefined && nowThreshold !== undefined && nowThreshold > wasThreshold)
    ) {
      fileReasons.push("the file's passing_threshold changes");
    }
    if (stableDigest(before.per_model ?? null) !== stableDigest(after.per_model ?? null)) {
      fileReasons.push("the file's per_model judge settings change");
    }
    for (const criterion of protectedIds) {
      for (const reason of fileReasons) out.push({ criterion, reason });
    }
  }
  return out;
}

/** A judge's declared scalar passing score, `undefined` when it declares none. */
function declaredCut(spec: GraderSpec): number | undefined {
  if (spec.type !== "llm_judge" || spec.rubric.kind === "categorical") return undefined;
  return spec.rubric.passing_score;
}

/** A judge spec with its scalar passing score left out, for comparing the rest. */
function withoutCut(spec: GraderSpec): unknown {
  if (spec.type !== "llm_judge" || spec.rubric.kind === "categorical") return spec;
  const { passing_score: _cut, ...rubric } = spec.rubric;
  return { ...spec, rubric };
}

/** How a scope narrows from `was` to `now`: a key added, or a value removed. */
function scopeNarrowing(
  was: CriterionSpec["scope"] | undefined,
  now: CriterionSpec["scope"] | undefined,
): string[] {
  if (now === undefined) return [];
  const wasMeta = (was?.metadata ?? {}) as Record<string, unknown>;
  const reasons: string[] = [];
  for (const [key, raw] of Object.entries(now.metadata)) {
    const nowValues = Array.isArray(raw) ? (raw as unknown[]) : [];
    const wasRaw = wasMeta[key];
    if (wasRaw === undefined) {
      reasons.push(`its scope gains the key "${key}"`);
      continue;
    }
    const wasValues = Array.isArray(wasRaw) ? (wasRaw as unknown[]) : [];
    const dropped = wasValues.filter((v) => !nowValues.includes(v));
    if (dropped.length > 0) {
      reasons.push(`its scope drops ${key}: ${dropped.map(String).join(", ")}`);
    }
  }
  return reasons;
}

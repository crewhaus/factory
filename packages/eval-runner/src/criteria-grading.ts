/**
 * How a criterion and a regrade shape one grader's grade.
 *
 * - **Scope.** A grader bound by a scoped criterion grades only the cases
 *   whose metadata matches the scope (every scope key's value a string the
 *   key lists, the slice grammar). Every other case records `skipped`
 *   (`out_of_scope`) and the grader is not called, so an out-of-scope judge
 *   costs nothing.
 * - **Observe.** A grader bound by an observing criterion is called, and its
 *   verdict is recorded with `status: "observing"`: `passed` and `score` are
 *   the grader's own, so the aggregate can say what it would have failed,
 *   and the sample's verdict leaves it out. A grade that already carries a
 *   status (not measured) keeps it. The resolved entry says it observes
 *   (`observing: true`), so a throw from it is recorded as not measured and
 *   the sample's verdict leaves that out too (see `runSample`).
 * - **Regrade.** On a regrade a case the source run cannot supply, and a
 *   grader whose inputs a recorded run does not keep, record `not_measured`
 *   (`not_regradable`) without a call; a grader whose spec is the one the
 *   source run recorded takes its recorded grade (see `./regrade`).
 *
 * The order is scope, then observe, then the regrade: a case outside the
 * scope is skipped before anything is read for it.
 */
import type { CompiledCriterion, CompiledGrader, Grader, GraderKind } from "@crewhaus/eval-grader";
import { inCriterionScope } from "@crewhaus/eval-grader";
import { type RegradePlan, notRegradable } from "./regrade";
import type { GraderEntry, GraderLookup } from "./types";

/** The grade a scoped grader records for a case outside its criterion's scope. */
export function outOfScope(criterionId: string) {
  return {
    passed: false,
    score: 0,
    rationale: `outside criterion ${criterionId}'s cases`,
    status: "skipped" as const,
    statusReason: "out_of_scope" as const,
  };
}

/** Wrap a grader with its criterion's scope and mode. */
export function criterionGrader(criterion: CompiledCriterion, grader: Grader): Grader {
  return async (sample, run) => {
    if (!inCriterionScope(criterion.scope, sample.metadata)) return outOfScope(criterion.id);
    const result = await grader(sample, run);
    if (criterion.mode === "observe" && result.status === undefined) {
      return { ...result, status: "observing" };
    }
    return result;
  };
}

/** Wrap a grader with a regrade's rules for one entry. */
export function regradeGrader(
  plan: RegradePlan,
  name: string,
  regradable: boolean,
  grader: Grader,
): Grader {
  return async (sample, run) => {
    const refusal = plan.caseRefusal(sample.id);
    if (refusal !== undefined) return notRegradable(refusal);
    if (!regradable) {
      return notRegradable(`grader "${name}" reads more than a recorded run keeps`);
    }
    return plan.reuse(sample.id, name) ?? grader(sample, run);
  };
}

/**
 * A resolved entry with its kind and regradability, and its grader wrapped
 * for a regrade and for its criterion. With neither, the grader is the
 * resolved one.
 */
export function finishGraderEntry(
  compiled: CompiledGrader,
  entry: GraderEntry,
  registry: GraderLookup | undefined,
  plan: RegradePlan | undefined,
): GraderEntry {
  const meta =
    compiled.registrySpec !== undefined
      ? registry?.metaOf?.(compiled.registrySpec.grader)
      : undefined;
  const kind: GraderKind =
    compiled.judgeSpec !== undefined
      ? "model"
      : compiled.registrySpec !== undefined
        ? (meta?.kind ?? "custom")
        : (compiled.kind ?? "custom");
  const regradable =
    compiled.judgeSpec !== undefined
      ? true
      : compiled.registrySpec !== undefined
        ? meta?.regradable === true
        : compiled.kind === "deterministic";
  let grader = entry.grader;
  if (plan !== undefined) grader = regradeGrader(plan, entry.name, regradable, grader);
  if (compiled.criterion !== undefined) grader = criterionGrader(compiled.criterion, grader);
  return {
    ...entry,
    grader,
    kind,
    regradable,
    ...(compiled.criterion?.mode === "observe" ? { observing: true } : {}),
  };
}

/**
 * What a run records about its protected criteria, as one digest each.
 *
 * A protected criterion's verdict is decided by more than its own entry in
 * the graders file: by the specs of the graders it binds, the file's
 * `combine`, `passing_threshold` and `per_model` (the record's `measuring`
 * digest), and the judge calibration the run applied to those graders. The
 * digest here covers all of it, so a re-anchor over any change to what
 * decides a protected criterion is seen, wherever the change was made.
 *
 * The run index and every pin carry these digests (`protectedCriteria`), so
 * a pin is checked against the pin it replaces without reading either run's
 * results.
 */
import { createHash } from "node:crypto";
import { type EvalRunSummary, canonicalJson } from "@crewhaus/eval-runner";

/** One protected criterion of a run, by id, and the digest of what decides it. */
export type ProtectedCriterionDigest = {
  readonly id: string;
  readonly digest: string;
};

/**
 * The protected criteria `summary` recorded (`config.criteria`), each with
 * the digest of its record, its `measuring` digest and the calibration the
 * run applied to the graders it binds. Empty when it recorded none.
 */
export function protectedCriteriaOf(summary: EvalRunSummary): ProtectedCriterionDigest[] {
  return (summary.config.criteria ?? [])
    .filter((c) => c.protected === true)
    .map((c) => ({ id: c.id, digest: criterionMeasureDigest(summary, c.id) as string }));
}

/**
 * The digest of what decides criterion `id`'s verdict in `summary` (see
 * {@link protectedCriteriaOf}), protected or not; `undefined` when the run
 * recorded no such criterion.
 */
export function criterionMeasureDigest(summary: EvalRunSummary, id: string): string | undefined {
  const c = (summary.config.criteria ?? []).find((x) => x.id === id);
  if (c === undefined) return undefined;
  const bound = new Set(c.graders.map((g) => g.name));
  const calibration = (summary.config.judgeCalibration?.applied ?? []).filter((a) =>
    bound.has(a.grader),
  );
  return createHash("sha256")
    .update(canonicalJson({ digest: c.digest, measuring: c.measuring ?? null, calibration }))
    .digest("hex");
}

/**
 * How `now` changes the protected criteria `was` recorded: one that is gone
 * (or no longer protected) and one whose digest moved. Empty when nothing
 * protected changed, and when `was` recorded none.
 */
export function protectedDigestChanges(
  was: ReadonlyArray<ProtectedCriterionDigest> | undefined,
  now: ReadonlyArray<ProtectedCriterionDigest> | undefined,
): string[] {
  const current = new Map((now ?? []).map((c) => [c.id, c.digest]));
  const reasons: string[] = [];
  for (const c of was ?? []) {
    const digest = current.get(c.id);
    if (digest === undefined) reasons.push(`protected criterion ${c.id} is gone or unprotected`);
    else if (digest !== c.digest)
      reasons.push(`protected criterion ${c.id} is measured differently`);
  }
  return reasons;
}

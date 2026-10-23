/**
 * A4/A5 — the graders config's `weight` and `passing_threshold` fields are
 * consumed only under `combine: weighted`; declaring them without it parses
 * fine but does nothing. Every surface that parses the graders.yaml grammar
 * (`runEval` and `createExamRunner`) must warn LOUDLY at start instead of
 * silently ignoring validated config — that silent ignore is the exact
 * trust hole A4/A5 exist to close.
 */
import type { CompiledGrader } from "@crewhaus/eval-grader";
import { createLogger } from "@crewhaus/logging";

const logger = createLogger({ bindings: { module: "eval-runner" } });

/**
 * Emit `graders.weight_ignored` / `graders.passing_threshold_ignored`
 * stderr warnings when the compiled graders declare weights or a
 * passing_threshold that the effective combine mode will never consume.
 * The policy rides on the compiled entries (identical on each; absent =
 * the pre-policy `all`).
 */
export function warnUnconsumedCombinePolicy(compiled: ReadonlyArray<CompiledGrader>): void {
  const combine = compiled.find((g) => g.combine !== undefined)?.combine;
  if ((combine?.mode ?? "all") === "weighted") return;
  const weightedNames = compiled.filter((g) => g.weight !== 1).map((g) => g.name);
  if (weightedNames.length > 0) {
    logger.warn("graders.weight_ignored", {
      graders: weightedNames.join(", "),
      combine: combine?.mode ?? "all",
      hint: "grader `weight` only applies under `combine: weighted`",
    });
  }
  if (combine?.passingThreshold !== undefined) {
    logger.warn("graders.passing_threshold_ignored", {
      passingThreshold: combine.passingThreshold,
      combine: combine.mode,
      hint: "`passing_threshold` only gates the overall score under `combine: weighted`",
    });
  }
}

/**
 * 0.8.0 §9.1 (review I32) — a `type: registry` entry naming a
 * `provability.*` grader gates BESIDE the `combine:` policy as a
 * requirement (`costPerProvenClaim`: reported only), so under `combine: any`
 * / `weighted` it is not the vote the file reads as, and its `weight` is
 * never consumed. Say so LOUDLY at start — the A4/A5 posture: validated
 * config never silently means something other than it reads. `roles` is
 * `registryProvabilityRoles`' map. Under the default `all` the verdict is the
 * same either way (a requirement ANDs as the policy does), so nothing is said
 * beyond `weight_ignored`.
 */
export function warnProvabilityOutsidePolicy(
  compiled: ReadonlyArray<CompiledGrader>,
  roles: ReadonlyMap<string, string>,
): void {
  const mode = compiled.find((g) => g.combine !== undefined)?.combine?.mode ?? "all";
  if (mode === "all") return;
  const outside = compiled.flatMap((g) => {
    const role = g.registrySpec !== undefined ? roles.get(g.registrySpec.grader) : undefined;
    return role === undefined
      ? []
      : [`${g.name} (${role}${g.weight !== 1 ? `, weight ${g.weight} unused` : ""})`];
  });
  if (outside.length === 0) return;
  logger.warn("graders.provability_outside_policy", {
    graders: outside.join(", "),
    combine: mode,
    hint: "provability.* graders gate beside `combine:` as requirements (costPerProvenClaim is reported only) — they never vote in the policy and their `weight` is not used, exactly as under --provability",
  });
}

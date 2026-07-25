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

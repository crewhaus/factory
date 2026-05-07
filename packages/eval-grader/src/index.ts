/**
 * Catalog R-eval `eval-grader` — deterministic graders + composers.
 *
 * A `Grader` is `(sample, runResult) → Promise<GradeResult>`. Built-ins:
 *   exactMatch, contains, regex, jsonPath, schema, toolCallSequence.
 *
 * Composers:
 *   all([g1,g2])          → AND-merged: passed iff all pass; score = min.
 *   any([g1,g2])          → OR-merged:  passed iff any pass; score = max.
 *   weighted([{g, w}], t) → score = Σ(score·w)/Σw; passed iff score ≥ t.
 *
 * Reference: build-roadmap.md §16.
 */
import { RuntimeError } from "@crewhaus/errors";

export type { Grader, GradeResult, RunResult, ToolCall } from "./types";
export { GraderError } from "./errors";

export {
  exactMatch,
  contains,
  regex,
  jsonPath,
  schema,
  toolCallSequence,
  all,
  any,
  weighted,
  byName,
} from "./graders";

export { evalJsonPath, type JsonPathError } from "./json-path";
export {
  parseGradersConfig,
  combineCompiledGraders,
  GradersConfigSchema,
  type CompiledGrader,
  type GradersConfig,
  type GraderSpec,
  type RubricSpec,
} from "./graders-config";

// Re-export for convenience so eval-runner consumers don't have to take a
// transitive dep on @crewhaus/eval-dataset.
export type { Sample } from "@crewhaus/eval-dataset";

// Sentinel re-export: makes the top-level errors discoverable for tests.
export { RuntimeError };

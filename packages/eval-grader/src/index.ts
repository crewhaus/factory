/**
 * Catalog R-eval `eval-grader` — deterministic graders + composers.
 *
 * A `Grader` is `(sample, runResult) → Promise<GradeResult>`. Built-ins:
 *   exactMatch, contains, expectedContains, regex, jsonPath, schema,
 *   toolCallSequence.
 *
 * Composers:
 *   all([g1,g2])          → AND-merged: passed iff all pass; score = min.
 *   any([g1,g2])          → OR-merged:  passed iff any pass; score = max.
 *   weighted([{g, w}], t) → score = Σ(score·w)/Σw; passed iff score ≥ t.
 *
 * Reference: build-roadmap.md §16.
 */
import { RuntimeError } from "@crewhaus/errors";

export type {
  GradeResult,
  GradeStatus,
  Grader,
  RunArtifacts,
  RunResult,
  StatusReason,
  ToolCall,
} from "./types";
export { GraderError } from "./errors";

export {
  exactMatch,
  contains,
  expectedContains,
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
  perModelArmKey,
  perModelOverrideFor,
  type PerModelJudgeOverride,
  type CompiledGrader,
  type GraderCombineMode,
  type GraderCombinePolicy,
  type GradersConfig,
  type GraderSpec,
  type RubricSpec,
} from "./graders-config";

// Criteria (what the graders check for), the measuring instrument's hash, and
// structured edits that keep the author's file.
export {
  CRITERION_ID_PATTERN,
  CRITERION_MODES,
  CRITERION_SEVERITIES,
  CRITERION_SOURCES,
  CriterionSpecSchema,
  boundSpecsOf,
  checkCriteria,
  compiledCriterion,
  criterionByGrader,
  criterionDigest,
  graderSpecDigest,
  inCriterionScope,
  kindOfGraderSpec,
  loosening,
  runCriteriaRecord,
  type CompiledCriterion,
  type CriterionMode,
  type CriterionScope,
  type CriterionSpec,
  type GraderKind,
  type Loosening,
  type RunCriterionRecord,
} from "./criteria";
export {
  gradersConfigHash,
  measurementProjection,
  stableDigest,
  stableStringify,
} from "./graders-hash";
export {
  GradersEditSchema,
  GradersEditsSchema,
  applyGradersEdits,
  criteriaChanged,
  type CriterionChange,
  type GradersEdit,
  type GradersEditResult,
} from "./graders-edit";

// Re-export for convenience so eval-runner consumers don't have to take a
// transitive dep on @crewhaus/eval-dataset.
export type { Sample } from "@crewhaus/eval-dataset";

// Sentinel re-export: makes the top-level errors discoverable for tests.
export { RuntimeError };

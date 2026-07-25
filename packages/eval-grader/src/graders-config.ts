/**
 * Parse a graders.yaml config into an array of named `Grader` instances.
 *
 * The config file's shape:
 *
 *   combine: weighted          # all (default) | any | weighted
 *   passing_threshold: 0.7     # weighted-mode pass cut on the combined score (default 0.5)
 *   graders:
 *     - name: math_exact
 *       type: exact_match
 *     - name: gold_included
 *       type: expected_contains  # output contains the sample's expected_output
 *     - name: schema_check
 *       type: regex
 *       pattern: ^The answer is \d+
 *     - name: tool_use
 *       type: tool_call_sequence
 *       expected: [bash, read]
 *       mode: subseq
 *     - name: judge_correct
 *       type: llm_judge
 *       rubric: …
 *       weight: 3              # any grader may declare a positive weight (default 1)
 *
 * Combination modes (how per-grader results merge into the sample's overall):
 *   all       passed iff every grader passed; score = unweighted mean.
 *   any       passed iff any grader passed;   score = max.
 *   weighted  score = Σ(weight·score)/Σweight; passed iff
 *             score >= (passing_threshold ?? 0.5).
 * `weight` and `passing_threshold` only take effect under `combine: weighted`
 * — the runner warns loudly when they are declared without it.
 *
 * The `llm_judge` type returns a placeholder grader that throws — the eval-runner
 * resolves it via `@crewhaus/eval-judge` and substitutes a real grader. This split
 * keeps the grader package free of an Anthropic SDK dep.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GraderError } from "./errors";
import {
  all,
  any,
  contains,
  exactMatch,
  expectedContains,
  jsonPath,
  regex,
  toolCallSequence,
  weighted,
} from "./graders";
import type { Grader } from "./types";

/** Positive per-grader weight for `combine: weighted` (default 1). */
const WeightField = z.number().positive().optional();

const ExactMatchSpec = z.object({
  name: z.string(),
  type: z.literal("exact_match"),
  trim: z.boolean().optional(),
  case_insensitive: z.boolean().optional(),
  weight: WeightField,
});

const ContainsSpec = z.object({
  name: z.string(),
  type: z.literal("contains"),
  substring: z.string(),
  case_insensitive: z.boolean().optional(),
  weight: WeightField,
});

const ExpectedContainsSpec = z.object({
  name: z.string(),
  type: z.literal("expected_contains"),
  case_insensitive: z.boolean().optional(),
  weight: WeightField,
});

const RegexSpec = z.object({
  name: z.string(),
  type: z.literal("regex"),
  pattern: z.string(),
  flags: z.string().optional(),
  weight: WeightField,
});

const JsonPathSpec = z.object({
  name: z.string(),
  type: z.literal("json_path"),
  path: z.string(),
  expected: z.unknown().optional(),
  weight: WeightField,
});

const ToolCallSequenceSpec = z.object({
  name: z.string(),
  type: z.literal("tool_call_sequence"),
  expected: z.array(z.string()),
  mode: z.enum(["exact", "subseq", "set"]).optional(),
  weight: WeightField,
});

const RubricCriterionSpec = z.object({
  name: z.string(),
  description: z.string(),
  anchors: z.object({
    "1": z.string(),
    "2": z.string(),
    "3": z.string(),
    "4": z.string(),
    "5": z.string(),
  }),
});

const RubricSpec = z.object({
  criteria: z.array(RubricCriterionSpec).min(1),
  passing_score: z.number().min(1).max(5).optional(),
});

const LlmJudgeSpec = z.object({
  name: z.string(),
  type: z.literal("llm_judge"),
  rubric: RubricSpec,
  model: z.string().optional(),
  weight: WeightField,
});

/**
 * v0.3.0 §7.3 (PR 19) — opt into a grader BY REGISTRY NAME. `grader` is the
 * name a grader pack registered with `@crewhaus/grader-registry` (e.g.
 * `continuity.reAskRate` after `registerContinuityGraders(registry)`).
 * Mirrors the `llm_judge` split exactly: this package stays free of a
 * grader-registry dep, so compile returns a placeholder carrying
 * `registrySpec` and the eval-runner substitutes the real grader from the
 * registry it was handed (`RunEvalOptions.graderRegistry`).
 */
const RegistryGraderSpec = z.object({
  name: z.string(),
  type: z.literal("registry"),
  grader: z.string().min(1),
  weight: WeightField,
});

const GraderSpec = z.discriminatedUnion("type", [
  ExactMatchSpec,
  ContainsSpec,
  ExpectedContainsSpec,
  RegexSpec,
  JsonPathSpec,
  ToolCallSequenceSpec,
  LlmJudgeSpec,
  RegistryGraderSpec,
]);

export const GradersConfigSchema = z
  .object({
    graders: z.array(GraderSpec).min(1),
    combine: z.enum(["all", "any", "weighted"]).optional(),
    passing_threshold: z.number().min(0).max(1).optional(),
  })
  // A4/A5 hardening — a typoed top-level key (`combined:`, `passing_treshold:`)
  // must fail loudly at parse, not be silently stripped so the run proceeds in
  // default `all` mode with the declared policy ignored. (Per-variant
  // strictness inside GraderSpec is a compat decision deferred to the wave
  // owner — stray keys in individual grader entries still parse.)
  .strict();

export type GradersConfig = z.infer<typeof GradersConfigSchema>;
export type GraderSpec = z.infer<typeof GraderSpec>;
export type RubricSpec = z.infer<typeof RubricSpec>;

export type GraderCombineMode = "all" | "any" | "weighted";

/**
 * The config's top-level combination policy (`combine:` +
 * `passing_threshold:`). Compiled onto every `CompiledGrader` — consumers
 * hand the runner only the compiled array, so the policy must survive that
 * handoff without a parallel config parameter on every call path.
 */
export type GraderCombinePolicy = {
  readonly mode: GraderCombineMode;
  /** The weighted-mode pass cut on the combined score. Only present when
   *  the config declared `passing_threshold` (runner default: 0.5). */
  readonly passingThreshold?: number;
};

export type CompiledGrader = {
  readonly name: string;
  readonly grader: Grader;
  readonly weight: number;
  readonly judgeSpec?: { rubric: RubricSpec; model?: string };
  /** Present for `type: registry` entries — the runner resolves `grader`
   *  against its `graderRegistry` before invoking (see `RegistryGraderSpec`). */
  readonly registrySpec?: { grader: string };
  /** The config's combination policy, identical on every entry. Absent when
   *  the config declared neither `combine` nor `passing_threshold` (⇒ the
   *  pre-policy default, `all`). See {@link GraderCombinePolicy}. */
  readonly combine?: GraderCombinePolicy;
};

/**
 * Parse a graders.yaml file. Returns CompiledGrader objects: deterministic
 * graders are ready-to-run; `llm_judge` entries carry a `judgeSpec` instead
 * of a `grader` (the runner pairs them with `@crewhaus/eval-judge`).
 *
 * The runner overlays its judge graders before invoking, then merges with
 * the deterministic ones into one `all([...])` Grader per sample.
 */
export function parseGradersConfig(yamlText: string): {
  config: GradersConfig;
  compiled: CompiledGrader[];
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new GraderError(`malformed YAML: ${(err as Error).message}`);
  }
  const result = GradersConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new GraderError(`invalid graders config: ${result.error.message}`);
  }
  const config = result.data;
  const combine: GraderCombinePolicy | undefined =
    config.combine !== undefined || config.passing_threshold !== undefined
      ? {
          mode: config.combine ?? "all",
          ...(config.passing_threshold !== undefined
            ? { passingThreshold: config.passing_threshold }
            : {}),
        }
      : undefined;
  const compiled: CompiledGrader[] = config.graders.map((spec) => ({
    ...compile(spec),
    ...(combine !== undefined ? { combine } : {}),
  }));
  return { config, compiled };
}

function compile(spec: GraderSpec): CompiledGrader {
  switch (spec.type) {
    case "exact_match":
      return {
        name: spec.name,
        grader: exactMatch({
          ...(spec.trim !== undefined ? { trim: spec.trim } : {}),
          ...(spec.case_insensitive !== undefined
            ? { caseInsensitive: spec.case_insensitive }
            : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "contains":
      return {
        name: spec.name,
        grader: contains({
          substring: spec.substring,
          ...(spec.case_insensitive !== undefined
            ? { caseInsensitive: spec.case_insensitive }
            : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "expected_contains":
      return {
        name: spec.name,
        grader: expectedContains({
          ...(spec.case_insensitive !== undefined
            ? { caseInsensitive: spec.case_insensitive }
            : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "regex":
      return {
        name: spec.name,
        grader: regex(spec.pattern, spec.flags),
        weight: spec.weight ?? 1,
      };
    case "json_path":
      return {
        name: spec.name,
        grader: jsonPath({
          path: spec.path,
          ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "tool_call_sequence":
      return {
        name: spec.name,
        grader: toolCallSequence({
          expected: spec.expected,
          ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "llm_judge":
      return {
        name: spec.name,
        // Placeholder grader; runner replaces this before invoking.
        grader: async () => {
          throw new GraderError(
            `llm_judge "${spec.name}" must be resolved via @crewhaus/eval-judge before invocation`,
          );
        },
        weight: spec.weight ?? 1,
        judgeSpec: {
          rubric: spec.rubric,
          ...(spec.model !== undefined ? { model: spec.model } : {}),
        },
      };
    case "registry":
      return {
        name: spec.name,
        // Placeholder grader; runner substitutes the registry entry.
        grader: async () => {
          throw new GraderError(
            `registry grader "${spec.name}" (→ "${spec.grader}") must be resolved via the eval-runner's graderRegistry before invocation`,
          );
        },
        weight: spec.weight ?? 1,
        registrySpec: { grader: spec.grader },
      };
  }
}

/**
 * Combine compiled graders into a single Grader honoring the config's
 * `combine:` policy — `all(...)` when none was declared (the pre-policy
 * default), `any(...)`/`weighted(...)` otherwise.
 */
export function combineCompiledGraders(graders: ReadonlyArray<CompiledGrader>): Grader {
  const policy = graders.find((g) => g.combine !== undefined)?.combine;
  const entries = graders.map((g) => ({ name: g.name, grader: g.grader }));
  switch (policy?.mode ?? "all") {
    case "any":
      return any(entries);
    case "weighted":
      return weighted(
        graders.map((g) => ({ name: g.name, grader: g.grader, weight: g.weight })),
        policy?.passingThreshold ?? 0.5,
      );
    default:
      return all(entries);
  }
}

/**
 * Parse a graders.yaml config into an array of named `Grader` instances.
 *
 * The config file's shape:
 *
 *   graders:
 *     - name: math_exact
 *       type: exact_match
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
 *
 * The `llm_judge` type returns a placeholder grader that throws — the eval-runner
 * resolves it via `@crewhaus/eval-judge` and substitutes a real grader. This split
 * keeps the grader package free of an Anthropic SDK dep.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GraderError } from "./errors";
import { all, contains, exactMatch, jsonPath, regex, toolCallSequence } from "./graders";
import type { Grader } from "./types";

const ExactMatchSpec = z.object({
  name: z.string(),
  type: z.literal("exact_match"),
  trim: z.boolean().optional(),
  case_insensitive: z.boolean().optional(),
});

const ContainsSpec = z.object({
  name: z.string(),
  type: z.literal("contains"),
  substring: z.string(),
  case_insensitive: z.boolean().optional(),
});

const RegexSpec = z.object({
  name: z.string(),
  type: z.literal("regex"),
  pattern: z.string(),
  flags: z.string().optional(),
});

const JsonPathSpec = z.object({
  name: z.string(),
  type: z.literal("json_path"),
  path: z.string(),
  expected: z.unknown().optional(),
});

const ToolCallSequenceSpec = z.object({
  name: z.string(),
  type: z.literal("tool_call_sequence"),
  expected: z.array(z.string()),
  mode: z.enum(["exact", "subseq", "set"]).optional(),
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
  weight: z.number().optional(),
});

const GraderSpec = z.discriminatedUnion("type", [
  ExactMatchSpec,
  ContainsSpec,
  RegexSpec,
  JsonPathSpec,
  ToolCallSequenceSpec,
  LlmJudgeSpec,
]);

export const GradersConfigSchema = z.object({
  graders: z.array(GraderSpec).min(1),
  passing_threshold: z.number().min(0).max(1).optional(),
});

export type GradersConfig = z.infer<typeof GradersConfigSchema>;
export type GraderSpec = z.infer<typeof GraderSpec>;
export type RubricSpec = z.infer<typeof RubricSpec>;

export type CompiledGrader = {
  readonly name: string;
  readonly grader: Grader;
  readonly weight: number;
  readonly judgeSpec?: { rubric: RubricSpec; model?: string };
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
  const compiled: CompiledGrader[] = config.graders.map((spec) => compile(spec));
  return { config, compiled };
}

function compile(spec: GraderSpec): CompiledGrader {
  switch (spec.type) {
    case "exact_match":
      return {
        name: spec.name,
        grader: exactMatch({
          ...(spec.trim !== undefined ? { trim: spec.trim } : {}),
          ...(spec.case_insensitive !== undefined ? { caseInsensitive: spec.case_insensitive } : {}),
        }),
        weight: 1,
      };
    case "contains":
      return {
        name: spec.name,
        grader: contains({
          substring: spec.substring,
          ...(spec.case_insensitive !== undefined ? { caseInsensitive: spec.case_insensitive } : {}),
        }),
        weight: 1,
      };
    case "regex":
      return {
        name: spec.name,
        grader: regex(spec.pattern, spec.flags),
        weight: 1,
      };
    case "json_path":
      return {
        name: spec.name,
        grader: jsonPath({
          path: spec.path,
          ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
        }),
        weight: 1,
      };
    case "tool_call_sequence":
      return {
        name: spec.name,
        grader: toolCallSequence({
          expected: spec.expected,
          ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
        }),
        weight: 1,
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
  }
}

/** Combine compiled graders into a single `all(...)` for the runner to invoke. */
export function combineCompiledGraders(graders: ReadonlyArray<CompiledGrader>): Grader {
  return all(graders.map((g) => ({ name: g.name, grader: g.grader })));
}

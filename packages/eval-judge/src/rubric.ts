import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { JudgeError } from "./errors";

export const RubricCriterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  anchors: z.object({
    "1": z.string(),
    "2": z.string(),
    "3": z.string(),
    "4": z.string(),
    "5": z.string(),
  }),
});

export const RubricSchema = z.object({
  // NEW-graders-2 — the scalar rubric may (but need not) declare its kind
  // explicitly. Only "scalar" is legal here: `kind: categorical` must NEVER
  // parse down this branch (it would silently drop the labels), which is
  // exactly what the literal enforces. The categorical-only keys are
  // additionally DENY-LISTED (`z.never`): a half-migrated rubric that keeps
  // `criteria` and adds `labels`/`passing_labels` WITHOUT declaring
  // `kind: categorical` must fail with a pointed error, not silently strip
  // the labels and judge scalar. Other stray keys still parse (compat).
  kind: z.literal("scalar").optional(),
  criteria: z.array(RubricCriterionSchema).min(1),
  passing_score: z.number().min(1).max(5).default(3),
  labels: z
    .never({
      invalid_type_error: "scalar rubrics take no `labels` — did you mean `kind: categorical`?",
    })
    .optional(),
  passing_labels: z
    .never({
      invalid_type_error:
        "scalar rubrics take no `passing_labels` — did you mean `kind: categorical`?",
    })
    .optional(),
});

/** NEW-graders-2 — one categorical label: the judge picks exactly one by
 *  `name`; `score` (0..1, already normalized — no 1–5 projection) becomes
 *  the grade's score when this label is chosen. */
export const CategoricalLabelSchema = z.object({
  name: z.string().min(1),
  score: z.number().min(0).max(1),
  description: z.string().min(1),
});

/**
 * NEW-graders-2 — a categorical judge rubric (OpenAI Fact/ClosedQA-style
 * choice_scores): at least two labels, and `passing_labels` naming the
 * subset whose choice passes the sample. Strict — a stray key (notably a
 * leftover scalar `criteria:` block) is a loud parse error, never silently
 * dropped, because a half-migrated rubric that silently judged on the wrong
 * shape would be a corrupted measurement.
 */
export const CategoricalRubricSchema = z
  .object({
    kind: z.literal("categorical"),
    labels: z.array(CategoricalLabelSchema).min(2),
    passing_labels: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    const names = new Set<string>();
    for (const label of rubric.labels) {
      if (names.has(label.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["labels"],
          message: `duplicate label name "${label.name}"`,
        });
      }
      names.add(label.name);
    }
    const seen = new Set<string>();
    for (const passing of rubric.passing_labels) {
      if (!names.has(passing)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passing_labels"],
          message: `passing label "${passing}" is not a declared label (declared: ${[...names].join(", ")})`,
        });
      }
      if (seen.has(passing)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passing_labels"],
          message: `duplicate passing label "${passing}"`,
        });
      }
      seen.add(passing);
    }
  });

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;
export type CategoricalLabel = z.infer<typeof CategoricalLabelSchema>;
export type CategoricalRubric = z.infer<typeof CategoricalRubricSchema>;
/** NEW-graders-2 — either judge-rubric shape. `createJudgeGrader` accepts
 *  this union and dispatches on `kind` ({@link isCategoricalRubric}). */
export type AnyRubric = Rubric | CategoricalRubric;

/** Narrow an {@link AnyRubric} to its categorical branch. */
export function isCategoricalRubric(rubric: AnyRubric): rubric is CategoricalRubric {
  return rubric.kind === "categorical";
}

function parseYamlOrEcho(yamlOrObject: string | unknown): unknown {
  if (typeof yamlOrObject !== "string") return yamlOrObject;
  try {
    return parseYaml(yamlOrObject);
  } catch (err) {
    throw new JudgeError(`malformed rubric YAML: ${(err as Error).message}`);
  }
}

export function loadRubric(yamlOrObject: string | unknown): Rubric {
  const parsed = parseYamlOrEcho(yamlOrObject);
  // NEW-graders-2 — a categorical rubric handed to the SCALAR loader gets a
  // pointed error, not the scalar schema's confusing "criteria required".
  // Consumers that support both shapes dispatch on `kind` and call
  // `loadCategoricalRubric` for this branch (see eval-runner's resolution).
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === "categorical"
  ) {
    throw new JudgeError(
      "invalid rubric: kind `categorical` — this consumer supports scalar (criteria/anchors) rubrics only; use loadCategoricalRubric / a scalar rubric here",
    );
  }
  const result = RubricSchema.safeParse(parsed);
  if (!result.success) {
    throw new JudgeError(`invalid rubric: ${result.error.message}`);
  }
  return result.data;
}

/** NEW-graders-2 — load + strictly validate a categorical rubric (YAML text
 *  or a pre-parsed object), mirroring {@link loadRubric} for the scalar shape. */
export function loadCategoricalRubric(yamlOrObject: string | unknown): CategoricalRubric {
  const parsed = parseYamlOrEcho(yamlOrObject);
  const result = CategoricalRubricSchema.safeParse(parsed);
  if (!result.success) {
    throw new JudgeError(`invalid categorical rubric: ${result.error.message}`);
  }
  return result.data;
}

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
  criteria: z.array(RubricCriterionSchema).min(1),
  passing_score: z.number().min(1).max(5).default(3),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;

export function loadRubric(yamlOrObject: string | unknown): Rubric {
  let parsed: unknown;
  if (typeof yamlOrObject === "string") {
    try {
      parsed = parseYaml(yamlOrObject);
    } catch (err) {
      throw new JudgeError(`malformed rubric YAML: ${(err as Error).message}`);
    }
  } else {
    parsed = yamlOrObject;
  }
  const result = RubricSchema.safeParse(parsed);
  if (!result.success) {
    throw new JudgeError(`invalid rubric: ${result.error.message}`);
  }
  return result.data;
}

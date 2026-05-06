import { SpecParseError } from "@crewhaus/errors";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * v0 spec schema — a discriminated union over `target`.
 *
 * - `cli`: a single streaming-chat agent (Section 1–5).
 * - `workflow`: a sequence of named steps run in order, threading the prior
 *   step's final assistant text into the next step's user message (Section 6).
 *
 * Will grow into the full catalog spec (channels, eval, deploy) — see
 * docs/MODULE-CATALOG.md PART A Layer F1.
 */
const cliSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("cli"),
    agent: z.object({
      model: z.string().min(1),
      instructions: z.string().min(1),
    }),
    tools: z.array(z.string().min(1)).optional(),
  })
  .strict();

const workflowStepSchema = z
  .object({
    name: z.string().min(1),
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
  })
  .strict();

const workflowSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("workflow"),
    model: z.string().min(1),
    steps: z.array(workflowStepSchema).min(1),
  })
  .strict();

export const Spec = z.discriminatedUnion("target", [cliSchema, workflowSchema]);

export type Spec = z.infer<typeof Spec>;
export type SpecCli = z.infer<typeof cliSchema>;
export type SpecWorkflow = z.infer<typeof workflowSchema>;
export type SpecWorkflowStep = z.infer<typeof workflowStepSchema>;

export { SpecParseError };

export function parseSpec(yamlText: string): Spec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new SpecParseError("invalid YAML", err);
  }
  const result = Spec.safeParse(raw);
  if (!result.success) {
    throw new SpecParseError(
      `spec validation failed:\n${result.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
      result.error,
    );
  }
  return result.data;
}

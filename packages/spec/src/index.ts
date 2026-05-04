import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * v0 spec schema — the absolute minimum to compile a runnable CLI agent.
 * Will grow into the full catalog spec (agents, tools, channels, workflow,
 * eval, deploy) — see docs/MODULE-CATALOG.md PART A Layer F1.
 */
export const Spec = z
  .object({
    name: z.string().min(1),
    target: z.literal("cli"),
    agent: z.object({
      model: z.string().min(1),
      instructions: z.string().min(1),
    }),
  })
  .strict();

export type Spec = z.infer<typeof Spec>;

export class SpecParseError extends Error {
  override readonly name = "SpecParseError";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

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

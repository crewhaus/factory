/**
 * @crewhaus/vscode-extension/spec-schema — Section 35
 *
 * Lowers the @crewhaus/spec Zod discriminated union into JSON Schema
 * Draft-07 so VS Code's `yamlValidation` contribution can drive
 * IntelliSense + lint on every `crewhaus.yaml` file. The full Zod
 * tree has dozens of optional fields per shape; this layer hand-rolls
 * the JSON Schema rather than relying on `zod-to-json-schema` so we
 * don't pull a 60 KB extra dep into the extension bundle.
 *
 * The schema is intentionally permissive on things VS Code can't
 * meaningfully validate (env-var refs, IR-passes config, MCP server
 * config) — the strict parse happens server-side in `parseSpec`. The
 * value we provide here is *autocomplete*, not a parser.
 */

import { specSchemaJson } from "./spec-schema-data";

export type SpecJsonSchema = typeof specSchemaJson;

export function getSpecJsonSchema(): SpecJsonSchema {
  return specSchemaJson;
}

/**
 * The 12 target shapes the schema validates. Mirrors @crewhaus/docker-images'
 * TARGET_SHAPES; we keep this list locally so the extension doesn't have
 * to take a workspace dep on docker-images.
 */
export const TARGET_SHAPES = [
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "eval",
] as const;

/**
 * Validate that the schema we ship covers every target shape the
 * compiler accepts. Used by tests to catch drift if a new shape is
 * added without updating the JSON Schema.
 */
export function targetShapesInSchema(schema: SpecJsonSchema = specSchemaJson): readonly string[] {
  const candidates = schema.oneOf ?? [];
  const shapes = new Set<string>();
  for (const c of candidates) {
    const target = c.properties?.target?.const;
    if (typeof target === "string") shapes.add(target);
  }
  return [...shapes].sort();
}

/** True when the schema covers every TARGET_SHAPES entry. */
export function schemaCoversAllTargetShapes(): boolean {
  const inSchema = new Set(targetShapesInSchema());
  return TARGET_SHAPES.every((s) => inSchema.has(s));
}

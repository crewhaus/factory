import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TARGET_SHAPES,
  getSpecJsonSchema,
  schemaCoversAllTargetShapes,
  targetShapesInSchema,
} from "./spec-schema";

describe("spec-schema (T1)", () => {
  test("returns a JSON Schema with the right $id + draft", () => {
    const schema = getSpecJsonSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.$id).toContain("crewhaus.io");
    expect(schema.oneOf.length).toBeGreaterThanOrEqual(12);
  });

  test("schema covers every target shape (no drift)", () => {
    expect(schemaCoversAllTargetShapes()).toBe(true);
  });

  test("targetShapesInSchema returns the alphabetised list of shapes", () => {
    const inSchema = targetShapesInSchema();
    expect([...inSchema].sort()).toEqual([...TARGET_SHAPES].sort());
  });

  test("the on-disk schemas/spec.json is deterministic JSON and matches inline", () => {
    const onDisk = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "schemas", "spec.json"), "utf8"),
    ) as { oneOf: ReadonlyArray<{ properties?: { target?: { const?: string } } }> };
    const onDiskShapes = (onDisk.oneOf ?? [])
      .map((c) => c.properties?.target?.const)
      .filter((s): s is string => typeof s === "string")
      .sort();
    expect(onDiskShapes).toEqual([...TARGET_SHAPES].sort());
  });

  test("each target shape requires both name + target", () => {
    const schema = getSpecJsonSchema() as unknown as JsonSchemaShape;
    for (const c of schema.oneOf) {
      const required = c.required ?? [];
      expect(required).toContain("name");
      expect(required).toContain("target");
    }
  });

  test("cli shape requires agent.model + agent.instructions", () => {
    const schema = getSpecJsonSchema() as unknown as JsonSchemaShape;
    const cli = schema.oneOf.find((c) => c.properties?.target?.const === "cli");
    expect(cli).toBeDefined();
    expect(cli?.properties?.agent?.required).toEqual(["model", "instructions"]);
  });

  test("workflow shape requires steps as a non-empty array", () => {
    const schema = getSpecJsonSchema() as unknown as JsonSchemaShape;
    const wf = schema.oneOf.find((c) => c.properties?.target?.const === "workflow");
    expect(wf?.properties?.steps?.minItems).toBe(1);
  });

  test("channel shape's channels block enumerates all 5 supported adapters", () => {
    const schema = getSpecJsonSchema() as unknown as JsonSchemaShape;
    const ch = schema.oneOf.find((c) => c.properties?.target?.const === "channel");
    const adapters = Object.keys(ch?.properties?.channels?.properties ?? {});
    expect([...adapters].sort()).toEqual(["discord", "imessage", "slack", "telegram", "whatsapp"]);
  });
});

type JsonSchemaShape = {
  oneOf: ReadonlyArray<{
    required?: readonly string[];
    properties?: {
      target?: { const?: string };
      agent?: { required?: readonly string[] };
      steps?: { minItems?: number };
      channels?: { properties?: Record<string, unknown> };
    };
  }>;
};

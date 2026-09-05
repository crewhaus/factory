/**
 * 0.6.0 §5.1 — `ToolDefinition.requiresModelFeatures` is an optional, typed
 * declaration mirroring Partial<ProviderFeatures>; normalization keeps it
 * optional (absent ⇒ advertised to every candidate).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ModelFeatureRequirement, RegisteredTool, ToolDefinition } from "./index";

describe("ToolDefinition.requiresModelFeatures", () => {
  test("accepts the ProviderFeatures keys and nothing else", () => {
    const req: ModelFeatureRequirement = { vision: true, caching: "automatic" };
    const def: ToolDefinition<{ path: string }> = {
      name: "ReadImage",
      description: "reads an image",
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: "" }),
      requiresModelFeatures: req,
    };
    expect(def.requiresModelFeatures).toEqual({ vision: true, caching: "automatic" });
    // @ts-expect-error — unknown feature keys are rejected at the type level
    const bad: ModelFeatureRequirement = { telepathy: true };
    expect(bad).toBeDefined();
  });

  test("RegisteredTool carries it as an optional field", () => {
    const tool: RegisteredTool = {
      name: "x",
      description: "",
      inputSchema: z.unknown(),
      execute: async () => ({ content: "" }),
      concurrencySafe: false,
      readOnly: false,
      destructive: false,
      requiresSandbox: false,
      classifyOutput: true,
      scope: "internal",
      requireJustification: false,
    };
    expect(tool.requiresModelFeatures).toBeUndefined();
    const withReq: RegisteredTool = { ...tool, requiresModelFeatures: { tool_use: true } };
    expect(withReq.requiresModelFeatures).toEqual({ tool_use: true });
  });
});

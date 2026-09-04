/**
 * 0.6.0 §5.1 — `buildTool` passes `requiresModelFeatures` through verbatim and
 * leaves the key ABSENT (not `undefined`) when the definition omits it, like
 * `ioCapability`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildTool } from "./index";

const base = {
  description: "d",
  inputSchema: z.object({}),
  execute: async () => ({ content: "ok" }),
};

describe("buildTool requiresModelFeatures pass-through", () => {
  test("declared → carried verbatim", () => {
    const tool = buildTool({ ...base, name: "ReadImage", requiresModelFeatures: { vision: true } });
    expect(tool.requiresModelFeatures).toEqual({ vision: true });
  });

  test("omitted → key absent so JSON.stringify of a catalog stays byte-identical", () => {
    const tool = buildTool({ ...base, name: "Read" });
    expect("requiresModelFeatures" in tool).toBe(false);
  });

  test("does not disturb the other fail-closed defaults", () => {
    const tool = buildTool({ ...base, name: "Read", requiresModelFeatures: { tool_use: true } });
    expect(tool.scope).toBe("internal");
    expect(tool.requireJustification).toBe(false);
    expect(tool.classifyOutput).toBe(true);
  });
});

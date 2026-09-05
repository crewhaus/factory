/**
 * 0.6.0 §4.4 — `executeTool` threads the serving model and the per-candidate
 * `tool_config` override from `ExecutionContext` into the tool's
 * `ToolExecuteContext.model` / `.toolConfig`, presence-gated: a call without
 * them hands the tool the exact pre-0.6.0 context keys.
 */
import { describe, expect, test } from "bun:test";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { executeTool } from "./index";

function recorder(): { tool: RegisteredTool; seen: ToolExecuteContext[] } {
  const seen: ToolExecuteContext[] = [];
  const tool: RegisteredTool = {
    name: "Rec",
    description: "records its context",
    inputSchema: z.object({}).strict(),
    execute: async (_input, ctx) => {
      if (ctx !== undefined) seen.push(ctx);
      return "ok";
    },
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    requireJustification: false,
    classifyOutput: true,
    scope: "internal",
  };
  return { tool, seen };
}

describe("executeTool — plan context threading", () => {
  test("model + toolConfig are forwarded verbatim when present", async () => {
    const { tool, seen } = recorder();
    const model = {
      armId: "fast",
      wireModelId: "claude-haiku-4-5",
      specModel: "claude-haiku-4-5",
      profile: "fast",
    };
    const res = await executeTool(
      tool,
      {},
      { toolUseId: "t1", model, toolConfig: { timeoutMs: 8000 } },
    );
    expect(res.isError).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toEqual(model);
    expect(seen[0]?.toolConfig).toEqual({ timeoutMs: 8000 });
  });

  test("absent → the keys are absent on the tool's context (not `undefined` members)", async () => {
    const { tool, seen } = recorder();
    await executeTool(tool, {}, { toolUseId: "t2" });
    expect(seen).toHaveLength(1);
    expect("model" in (seen[0] as object)).toBe(false);
    expect("toolConfig" in (seen[0] as object)).toBe(false);
  });
});

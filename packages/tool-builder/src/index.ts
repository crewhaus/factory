import type { RegisteredTool, ToolDefinition, ToolExecuteContext } from "@crewhaus/tool-catalog";
import type { ZodType } from "zod";

/**
 * Converts a ToolDefinition into a RegisteredTool by applying fail-closed
 * safety defaults. Any flag not explicitly set in the definition defaults to
 * false (the least-privileged stance).
 */
export function buildTool<TInput>(def: ToolDefinition<TInput>): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as ZodType<unknown>,
    execute: def.execute as (input: unknown, ctx?: ToolExecuteContext) => Promise<string>,
    concurrencySafe: def.concurrencySafe ?? false,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
    ...(def.jsonSchema !== undefined ? { jsonSchema: def.jsonSchema } : {}),
  };
}

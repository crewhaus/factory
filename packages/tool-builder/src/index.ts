import type { ZodType } from "zod";
import type { ToolDefinition, RegisteredTool } from "@crewhaus/tool-catalog";

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
    execute: def.execute as (input: unknown) => Promise<string>,
    concurrencySafe: def.concurrencySafe ?? false,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
  };
}

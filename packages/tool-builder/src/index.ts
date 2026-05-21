import type {
  RegisteredTool,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
} from "@crewhaus/tool-catalog";
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
    execute: def.execute as (
      input: unknown,
      ctx?: ToolExecuteContext,
    ) => Promise<ToolExecuteResult>,
    concurrencySafe: def.concurrencySafe ?? false,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
    // Section 18: fail-closed for the sandbox flag and default-on for
    // classification. Tools that legitimately bypass classification must
    // opt out explicitly.
    requiresSandbox: def.requiresSandbox ?? false,
    classifyOutput: def.classifyOutput ?? true,
    // Pillar 3 sink-side fabric: fail-closed at "internal" so tools that
    // actually cross a network/process boundary must opt in to "external"
    // explicitly. egress-classifier reads this flag to decide whether to
    // route the call's payload through its substring scan.
    scope: def.scope ?? "internal",
    // Pillar 3 intent gate: fail-closed at false. Destructive or external
    // tools should opt in explicitly (see tool-fetch, tool-evm-tx,
    // tool-message-channel, federation-router).
    requireJustification: def.requireJustification ?? false,
    ...(def.jsonSchema !== undefined ? { jsonSchema: def.jsonSchema } : {}),
  };
}

import { CrewhausError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";
import { validateToolInput } from "@crewhaus/tool-validate";

export type ToolResult = {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
};

export type ExecutionContext = {
  readonly toolUseId: string;
  /** When present, the tool call must match at least one pattern. Absent = allow all. */
  readonly allowedPatterns?: ReadonlyArray<string>;
  /** Optional cooperative-cancellation signal forwarded to the tool. */
  readonly signal?: AbortSignal;
  /**
   * Section 13 — opaque runtime bridge forwarded into the tool's
   * `ToolExecuteContext.bridge`. Framework-aware tools (the Task tool) cast
   * it; ordinary tools ignore it.
   */
  readonly bridge?: unknown;
};

export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  constructor(toolName: string) {
    super("tool", `tool "${toolName}" is not permitted by the current permission set`);
    this.toolName = toolName;
  }
}

export async function executeTool(
  tool: RegisteredTool,
  rawInput: unknown,
  context: ExecutionContext,
): Promise<ToolResult> {
  const { toolUseId, allowedPatterns } = context;

  const validation = validateToolInput(tool, rawInput);
  if (!validation.ok) {
    return { toolUseId, content: validation.error.message, isError: true };
  }

  if (allowedPatterns !== undefined) {
    const compiled = allowedPatterns.map(compilePattern);
    const permitted = compiled.some((p) => matchesPattern(p, tool.name, rawInput));
    if (!permitted) {
      return {
        toolUseId,
        content: new ToolPermissionError(tool.name).message,
        isError: true,
      };
    }
  }

  try {
    const content = await tool.execute(validation.value, {
      signal: context.signal,
      ...(context.bridge !== undefined ? { bridge: context.bridge } : {}),
    });
    return { toolUseId, content, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolUseId, content: msg, isError: true };
  }
}

import { CrewhausError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

export type ZodIssue = { readonly path: ReadonlyArray<string | number>; readonly message: string };

export class ToolValidationError extends CrewhausError {
  override readonly name = "ToolValidationError";
  readonly issues: ReadonlyArray<ZodIssue>;

  constructor(message: string, issues: ReadonlyArray<ZodIssue>, cause?: unknown) {
    super("tool", message, cause);
    this.issues = issues;
  }
}

export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ToolValidationError };

export function validateToolInput(tool: RegisteredTool, rawInput: unknown): ValidationResult {
  const result = tool.inputSchema.safeParse(rawInput);
  if (result.success) return { ok: true, value: result.data };

  const issues: ZodIssue[] = result.error.issues.map((i) => ({
    path: i.path as ReadonlyArray<string | number>,
    message: i.message,
  }));

  return {
    ok: false,
    error: new ToolValidationError(
      `invalid input for tool "${tool.name}": ${issues.map((i) => i.message).join("; ")}`,
      issues,
      result.error,
    ),
  };
}

import { CrewhausError } from "@crewhaus/errors";
import type { ZodType } from "zod";

/**
 * Per-call context passed as the second argument to `execute`. Tools that
 * support cooperative cancellation (e.g. tool-bash forwarding to Bun.spawn)
 * read `signal` from here; tools that don't care can ignore it entirely.
 */
export interface ToolExecuteContext {
  readonly signal?: AbortSignal;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  execute: (input: TInput, ctx?: ToolExecuteContext) => Promise<string>;
  concurrencySafe?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
}

/** Normalized form stored in the catalog. All flags are required booleans and
 *  execute is type-erased so the registry can hold a homogeneous map. */
export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: ZodType<unknown>;
  execute: (input: unknown, ctx?: ToolExecuteContext) => Promise<string>;
  concurrencySafe: boolean;
  readOnly: boolean;
  destructive: boolean;
}

export class ToolCatalogError extends CrewhausError {
  override readonly name = "ToolCatalogError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export class ToolCatalog {
  private readonly _tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this._tools.has(tool.name)) {
      throw new ToolCatalogError(`tool "${tool.name}" is already registered`);
    }
    this._tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this._tools.get(name);
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  list(): ReadonlyArray<RegisteredTool> {
    return [...this._tools.values()];
  }
}

export const defaultCatalog = new ToolCatalog();

import { CrewhausError } from "@crewhaus/errors";
import type { ZodType } from "zod";

/**
 * Per-call context passed as the second argument to `execute`. Tools that
 * support cooperative cancellation (e.g. tool-bash forwarding to Bun.spawn)
 * read `signal` from here; tools that don't care can ignore it entirely.
 *
 * `bridge` (Section 13) is an opaque payload runtime-core stuffs in once per
 * run. Framework-aware tools — today only the `Task` tool — cast it back to
 * the typed `RuntimeBridge` from `@crewhaus/agent-context-isolation`.
 * Ordinary tools ignore it.
 *
 * Section 18 — `onStreamChunk` is invoked by streaming tools (e.g.
 * tool-code-execution piping container stdout/stderr) so runtime-core can
 * publish `tool_stream_chunk` trace events. The callback is fire-and-forget
 * — tools must not block on it. Optional; tools that don't stream skip it.
 */
export interface ToolExecuteContext {
  readonly signal?: AbortSignal;
  readonly bridge?: unknown;
  readonly onStreamChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
}

/**
 * Section 14 — non-string tool result content. Mirrors the subset of
 * Anthropic's `ToolResultBlockParam.content` we use today: text + base64
 * image blocks. `runtime-core` forwards arrays of these verbatim into the
 * API's `tool_result.content` field, so the model sees them as image
 * inputs rather than as base64 text.
 *
 * Tools that don't return rich content (the majority — fs, bash, todo,
 * mcp, channel, task) keep returning `string` and never construct these.
 */
export interface ToolResultTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ToolResultImageBlock {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    readonly data: string;
  };
}

export type ToolResultContentBlock = ToolResultTextBlock | ToolResultImageBlock;
export type ToolResultContent = ReadonlyArray<ToolResultContentBlock>;
export type ToolExecuteResult = string | ToolResultContent;

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  execute: (input: TInput, ctx?: ToolExecuteContext) => Promise<ToolExecuteResult>;
  concurrencySafe?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  /**
   * Section 18 — declares that the tool MUST run inside a sandbox. The
   * permission engine refuses to grant `allow` in default mode unless an
   * `alwaysAllow` rule matches AND a real sandbox backend is available
   * (see `permission-engine.evaluate`). Tool implementations are
   * responsible for actually using the sandbox; the flag is the policy
   * declaration that the floor enforces.
   */
  requiresSandbox?: boolean;
  /**
   * Section 18 — when explicitly false, the post-tool prompt-injection
   * classifier in runtime-core is skipped for this tool. Default is true
   * (run the classifier on every output). Set to false ONLY for tools whose
   * output is structurally guaranteed not to be attacker-controlled (e.g.
   * the in-process `Task` sub-agent tool wrapper).
   */
  classifyOutput?: boolean;
  /**
   * Authoritative JSON Schema for the tool's input. When set, runtime-core
   * forwards this verbatim to the model instead of running
   * `zodToJsonSchema(inputSchema)`. Used by tools whose canonical schema is
   * already JSON Schema (e.g. MCP tools), where the Zod round-trip would be
   * lossy. The `inputSchema` slot is still required for the validator path
   * (typically `z.unknown()` for MCP).
   */
  jsonSchema?: unknown;
}

/** Normalized form stored in the catalog. All flags are required booleans and
 *  execute is type-erased so the registry can hold a homogeneous map. */
export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: ZodType<unknown>;
  execute: (input: unknown, ctx?: ToolExecuteContext) => Promise<ToolExecuteResult>;
  concurrencySafe: boolean;
  readOnly: boolean;
  destructive: boolean;
  /** Section 18 — fails closed (false) when omitted by `buildTool`. */
  requiresSandbox: boolean;
  /** Section 18 — defaults to true so post-tool classification runs. */
  classifyOutput: boolean;
  /** See ToolDefinition.jsonSchema. Optional; runtime-core falls back to
   *  zodToJsonSchema(inputSchema) when absent. */
  jsonSchema?: unknown;
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

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

/**
 * Pillar 3 sink-side fabric — where a tool's effect lands.
 *
 * - `"internal"`: the tool reads/writes process-local state only
 *   (filesystem, sandboxed code execution, memory, todo, code-graph
 *   index). Egress classifier skips internal tools.
 * - `"external"`: the tool transmits data to a sink the runtime cannot
 *   re-classify after the fact — a URL fetched, a channel message sent,
 *   a federation outbound payload, an MCP tool invocation, an EVM tx
 *   broadcast, an image upload. Every such call routes through
 *   `egress-classifier` first.
 *
 * Default at normalization is `"internal"` (fails closed). Tools that
 * cross a process or network boundary MUST set `"external"` explicitly
 * in their `ToolDefinition`.
 */
export type ToolScope = "internal" | "external";

/**
 * FR-002 — Pillar 3 sink-side io-capability signal.
 *
 * `scope` declares the *policy* (does the egress classifier run); this
 * declares the *fact* (does the tool actually cross a boundary). The two are
 * separable on purpose: the compile-time gate uses the fact to require the
 * policy. A tool that opens a socket or spawns a process is io-capable
 * regardless of what `scope` it was given, so the `crewhaus compile --strict`
 * / `crewhaus doctor --philosophy-alignment` audit can flag an io-capable
 * tool left at a non-`"external"` scope *by name-independent capability*,
 * closing the custom-`buildTool`-tool residual the FR's mechanism 2 targets
 * ("custom buildTool tools that open sockets, spawn processes, touch the
 * network").
 *
 * - `"network"`: the tool issues outbound network requests (HTTP, websocket,
 *   raw socket, RPC, an SDK that does so under the hood).
 * - `"process"`: the tool spawns a child process / shell whose effects the
 *   runtime cannot re-classify after the fact.
 *
 * Author-supplied custom tools that touch the network or spawn processes
 * SHOULD declare this; the six built-in outward tools also declare it so the
 * audit no longer depends solely on their hardcoded names. Omitted ⇒ no
 * declared io-capability (the prior behavior — the audit then falls back to
 * the name heuristic only). This is additive and fail-open *for omission*
 * but fail-closed *for declaration*: declaring io-capability and forgetting
 * `scope: "external"` is exactly what `--strict` refuses.
 */
export type ToolIoCapability = "network" | "process";

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
   * Pillar 3 sink-side — see `ToolScope`. Default `"internal"` at
   * normalization. Set `"external"` for any tool whose effect leaves the
   * process boundary unmonitored.
   */
  scope?: ToolScope;
  /**
   * Pillar 3 sink-side — see `ToolIoCapability`. Declares that this tool
   * actually crosses a network or process boundary, independent of `scope`.
   * Custom tools that open sockets / spawn processes SHOULD set this so the
   * `compile --strict` / `doctor --philosophy-alignment` audit can require
   * `scope: "external"` on them by capability rather than by name. Omitted ⇒
   * no declared io-capability (prior behavior).
   */
  ioCapability?: ToolIoCapability;
  /**
   * Pillar 3 intent gate — when true, runtime-core demands the model
   * supply a `justification` string in the tool's input alongside the
   * declared schema, and `permission-engine` evaluates the justification
   * against the session's stated goal via an LLM-as-judge. Every evaluation
   * (allow OR deny) publishes a `permission_decision` trace event and, when a
   * durable `justificationAuditSink` is wired into `runChatLoop`, appends a
   * `permission_justification_evaluated` record to `@crewhaus/audit-log`; a
   * deny additionally blocks the call.
   *
   * Default at normalization is `false`. Recommended `true` for any tool
   * with destructive or external side effects (evm-tx, message-channel,
   * federation outbound). Independent of `scope` — a tool can be
   * `internal` and still require justification (e.g. a destructive fs
   * delete), and a tool can be `external` without requiring justification
   * (e.g. a read-only public-data fetch).
   */
  requireJustification?: boolean;
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
  /**
   * Pillar 3 sink-side — fails closed (`"internal"`) when omitted. Tools
   * that cross a process or network boundary MUST set `"external"`
   * explicitly in their `ToolDefinition`.
   */
  scope: ToolScope;
  /**
   * Pillar 3 sink-side io-capability fact. Optional: absent ⇒ the tool did
   * not declare crossing a boundary (the audit then relies on the outward-
   * name heuristic only). See `ToolDefinition.ioCapability`.
   */
  ioCapability?: ToolIoCapability;
  /**
   * Pillar 3 intent gate — fails closed (false) when omitted. See
   * `ToolDefinition.requireJustification`.
   */
  requireJustification: boolean;
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

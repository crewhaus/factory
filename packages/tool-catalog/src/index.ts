import { CrewhausError } from "@crewhaus/errors";
import type { RunContext } from "@crewhaus/run-context";
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
 * Pillar 3 sink-side fabric (#160 follow-up) — `runContext` is the run's
 * `RunContext`, supplied so boundary-site tools (tool-mcp, skills-registry)
 * can `tagContent` their external content's provenance into `dataLineage`
 * on EVERY run. It carries the same `RunContext` instance the runtime would
 * otherwise expose only via `bridge.runContext` (which is built lazily). It
 * is optional and additive: tools that don't tag provenance ignore it, and
 * tagging tools read it first but fall back to `bridge.runContext` for
 * back-compat. The runtime always makes the run context reachable through at
 * least one of the two; tagging tools must tolerate both being absent.
 *
 * Section 18 — `onStreamChunk` is invoked by streaming tools (e.g.
 * tool-code-execution piping container stdout/stderr) so runtime-core can
 * publish `tool_stream_chunk` trace events. The callback is fire-and-forget
 * — tools must not block on it. Optional; tools that don't stream skip it.
 */
export interface ToolExecuteContext {
  readonly signal?: AbortSignal;
  readonly bridge?: unknown;
  readonly runContext?: RunContext;
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

/**
 * 0.6.0 §5.1 — the model features a tool needs from the model that calls
 * it. Structurally the `Partial<ProviderFeatures>` of
 * `@crewhaus/adapter-anthropic` (kept as a local twin so the tool contract
 * does not pull a provider SDK); `@crewhaus/cost-tracker`'s
 * `CapabilityRequirement` is the same shape, so one declaration serves
 * both the runtime gate (`adapter.features`) and the offline
 * `compile --strict` twin (`satisfiesCapabilities`). Semantics per key: a
 * `true` boolean requires the feature; `caching: "explicit"` requires
 * explicit caching, `"automatic"` accepts either kind; `false` / absent is a
 * don't-care.
 */
export type ModelFeatureRequirement = {
  readonly caching?: "explicit" | "automatic" | false;
  readonly tool_use?: boolean;
  readonly vision?: boolean;
  readonly thinking?: boolean;
  readonly web_search?: boolean;
};

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
   * The contract is advertised, not just enforced (#386): at request-build
   * time the runtime augments the tool's MODEL-FACING input schema with a
   * required `justification` string property (via
   * `withJustificationField`) unless the tool's own schema already declares
   * one — models conform tightly to advertised schemas and never invent
   * undeclared fields, so an unadvertised requirement would deny every
   * call. When the field was runtime-injected it is stripped from the input
   * again (via `stripJustificationField`) before the input reaches the
   * tool's validator/executor, so remote MCP servers and strict zod schemas
   * never see a field their own schema doesn't allow. A tool that declares
   * the field itself keeps receiving it verbatim.
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
   * 0.6.0 §5.1 — tools declare REQUIREMENTS, not model maps. When set, a
   * model whose `features` do not satisfy this requirement never has the
   * tool advertised to it (`@crewhaus/model-plan`'s `buildAdvertisement`
   * derives `toolsFor(candidate) = profile.tools ∩ tools.filter(t ⊨
   * candidate.features)`), and `compile --strict` checks the same
   * requirement offline against the capability table. A tool that returns
   * image blocks declares `{ vision: true }`; a tool that only makes sense
   * with function calling declares `{ tool_use: true }`. Omitted ⇒ no
   * requirement (advertised to every candidate, the prior behavior).
   */
  requiresModelFeatures?: ModelFeatureRequirement;
  /**
   * Authoritative JSON Schema for the tool's input. When set, runtime-core
   * forwards this verbatim to the model instead of running
   * `zodToJsonSchema(inputSchema)`. Used by tools whose canonical schema is
   * already JSON Schema (e.g. MCP tools), where the Zod round-trip would be
   * lossy. The `inputSchema` slot is still required for the validator path
   * (typically `z.unknown()` for MCP).
   */
  jsonSchema?: unknown;
  /**
   * Optional per-invocation concurrency classifier. When present, the
   * orchestrator calls it with the parsed tool input and the sibling
   * catalog to decide whether THIS specific call may run in parallel with
   * its siblings, overriding the static `concurrencySafe`/`readOnly`/
   * `destructive` flags for partitioning only.
   *
   * `Task` uses it: a static flag can't express that a dispatch's safety
   * depends on WHICH sub-agent it spawns, so Task stays statically
   * `readOnly: false` (never eligible by flags) and opts specific calls
   * back in here iff the resolved sub-agent's entire effective tool set is
   * itself read-only + concurrency-safe + non-destructive.
   *
   * Must be a pure, synchronous check. It is treated fail-closed: throwing
   * or returning `false` routes the call serial.
   */
  concurrencyClassifier?: (input: unknown, catalog: ReadonlyArray<RegisteredTool>) => boolean;
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
  /**
   * 0.6.0 §5.1 — see `ToolDefinition.requiresModelFeatures`. Optional and
   * passed through verbatim by `buildTool` (like `ioCapability`); absent ⇒
   * the tool is advertised to every candidate.
   */
  requiresModelFeatures?: ModelFeatureRequirement;
  /** See ToolDefinition.jsonSchema. Optional; runtime-core falls back to
   *  zodToJsonSchema(inputSchema) when absent. */
  jsonSchema?: unknown;
  /** See ToolDefinition.concurrencyClassifier. Optional; when absent the
   *  orchestrator partitions on the static concurrency flags alone. */
  concurrencyClassifier?: (input: unknown, catalog: ReadonlyArray<RegisteredTool>) => boolean;
}

export class ToolCatalogError extends CrewhausError {
  override readonly name = "ToolCatalogError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

/** Ops item 38 — a tool that has been temporarily withdrawn from the active
 *  catalog (its server is chronically failing). `restore()` returns it. */
export type QuarantinedTool = {
  readonly tool: RegisteredTool;
  readonly reason: string;
  readonly quarantinedAt: number;
};

export class ToolCatalog {
  // Initialized in the constructor body rather than as a field initializer so
  // that Bun's coverage instrumentation can mark it executed. A
  // `= new Map(...)` field initializer is counted in the function denominator
  // but its hit-count is never incremented by Bun, which would otherwise pin
  // function coverage below 100% even though the line runs on every `new`.
  private readonly _tools: Map<string, RegisteredTool>;
  // Ops item 38 — tools withdrawn by `quarantine()`. Kept out of `_tools` (so
  // `has`/`get`/`list` — the model-facing surface — no longer see them) but
  // stashed here so `restore()` can re-admit the exact definition without the
  // caller re-building it. `register()` still throws on a name that is live OR
  // quarantined, so a quarantined name is never silently shadowed.
  private readonly _quarantined: Map<string, QuarantinedTool>;

  constructor() {
    this._tools = new Map<string, RegisteredTool>();
    this._quarantined = new Map<string, QuarantinedTool>();
  }

  register(tool: RegisteredTool): void {
    if (this._tools.has(tool.name)) {
      throw new ToolCatalogError(`tool "${tool.name}" is already registered`);
    }
    if (this._quarantined.has(tool.name)) {
      throw new ToolCatalogError(
        `tool "${tool.name}" is quarantined — restore() it rather than re-registering`,
      );
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

  /**
   * Ops item 38 — remove a live tool from the active catalog entirely. Returns
   * the removed definition (so a caller can re-`register()` it later) or
   * undefined when the name is not live. Unlike `quarantine()` this keeps no
   * stash — it is the plain inverse of `register()` (the `circuit-breaker`
   * wraps ProviderAdapters, never the catalog, so this is a new seam, not a
   * reuse). `register()` throws on re-register today, so a runtime that needs
   * to swap a tool must `unregister()` first.
   */
  unregister(name: string): RegisteredTool | undefined {
    const tool = this._tools.get(name);
    if (tool === undefined) return undefined;
    this._tools.delete(name);
    return tool;
  }

  /**
   * Ops item 38 — temporarily withdraw a live tool (its MCP server is
   * chronically failing) so the model routes around it. The tool leaves the
   * active catalog (`has`/`get`/`list` no longer see it) but its definition is
   * stashed for `restore()`. Idempotent: quarantining an already-quarantined
   * tool is a no-op; quarantining a name that is neither live nor quarantined
   * returns false. This catalog only owns the registration state; producing
   * any "tool unavailable" notice for the model is the caller's job.
   *
   * NOTE: as of v0.2.0 this API has no production caller — the shipped
   * `crewhaus run` quarantine path (apps/cli `runRunCli`) does NOT use it. It
   * reads the failing-server set from `.crewhaus/mcp/quarantine.json` (written
   * by `crewhaus mcp doctor`), filters the plain tools array by the
   * `<server>__` name prefix, and appends a notice built by `mcp-doctor.ts`'s
   * `quarantineNotice()` to the agent instructions. This method + `restore()`
   * + `quarantinedNames()` are a catalog-level API awaiting a caller.
   */
  quarantine(name: string, reason: string, now: number = Date.now()): boolean {
    if (this._quarantined.has(name)) return true;
    const tool = this._tools.get(name);
    if (tool === undefined) return false;
    this._tools.delete(name);
    this._quarantined.set(name, { tool, reason, quarantinedAt: now });
    return true;
  }

  /**
   * Ops item 38 — re-admit a quarantined tool to the active catalog (its server
   * passed a background probe). Returns true when a tool was restored, false
   * when the name was not quarantined. A restore never collides with a live
   * name because a live name can never have been quarantined (quarantine
   * removed it from `_tools`, and `register()` refuses a quarantined name).
   */
  restore(name: string): boolean {
    const entry = this._quarantined.get(name);
    if (entry === undefined) return false;
    this._quarantined.delete(name);
    this._tools.set(name, entry.tool);
    return true;
  }

  /** Ops item 38 — names of every currently-quarantined tool. (Catalog-level
   *  API; the shipped `crewhaus mcp doctor` / `run` path tracks quarantine via
   *  `.crewhaus/mcp/quarantine.json` rather than this method — see `quarantine()`.) */
  quarantinedNames(): ReadonlyArray<string> {
    return [...this._quarantined.keys()];
  }

  /** Ops item 38 — is this tool currently quarantined? */
  isQuarantined(name: string): boolean {
    return this._quarantined.has(name);
  }

  /** Ops item 38 — the full quarantine record for a name (reason + timestamp),
   *  or undefined when not quarantined. */
  quarantineInfo(name: string): QuarantinedTool | undefined {
    return this._quarantined.get(name);
  }
}

// ---------------------------------------------------------------------------
// Pillar 3 intent gate — justification schema advertisement (#386)
// ---------------------------------------------------------------------------

/**
 * The reserved input field the intent gate reads the model's justification
 * from. Runtime loops read `input[JUSTIFICATION_INPUT_FIELD]` on every
 * `requireJustification` tool call and hand it to `permission-engine`'s
 * `evaluateJustification`.
 */
export const JUSTIFICATION_INPUT_FIELD = "justification";

/**
 * Model-facing description attached to a runtime-injected `justification`
 * property. This is the only place the model learns the contract, so it
 * states all three facts: what to write, who evaluates it, and that it is
 * recorded.
 */
export const JUSTIFICATION_FIELD_DESCRIPTION =
  "Required by the runtime's intent gate: one or two sentences explaining how this " +
  "specific call serves the session's stated goal. A justification judge evaluates it " +
  "before the tool runs and it is recorded verbatim in the audit log; calls whose " +
  "justification is missing, too brief, or unrelated to the goal are denied.";

/** Result of {@link withJustificationField}: the schema to advertise, and
 *  whether the `justification` property was injected by the runtime (true) or
 *  was already declared by the tool's own schema (false — schema returned
 *  untouched, by reference). */
export type JustificationSchemaResult = {
  readonly schema: Record<string, unknown>;
  readonly injected: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does this JSON schema itself declare a top-level `justification` property?
 * When it does, the tool (or the remote MCP server behind it) owns the
 * contract: the runtime must neither re-inject the property nor strip the
 * field from the input it forwards.
 */
export function schemaDeclaresJustification(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  const properties = schema["properties"];
  return isPlainObject(properties) && properties[JUSTIFICATION_INPUT_FIELD] !== undefined;
}

/**
 * Augment a model-facing JSON schema with the required `justification`
 * string property the intent gate reads (#386). Pure and non-mutating: the
 * input schema object is never modified — collections are shallow-copied on
 * the injected path, and the untouched path returns the input by reference.
 *
 * - Top-level object schema without a declared `justification` → returns a
 *   copy with the property added and `"justification"` appended to
 *   `required` (`injected: true`).
 * - Schema that already declares the property → returned untouched
 *   (`injected: false`); the tool owns the contract.
 * - Non-object schema (no `type: "object"`) → returned untouched
 *   (`injected: false`). Model providers require an object root for tool
 *   input schemas, and runtime loops coerce degenerate schemas to an object
 *   BEFORE calling this, so this arm only skips schemas the provider would
 *   reject anyway.
 */
export function withJustificationField(schema: Record<string, unknown>): JustificationSchemaResult {
  if (schema["type"] !== "object" || schemaDeclaresJustification(schema)) {
    return { schema, injected: false };
  }
  const baseProperties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
  const properties: Record<string, unknown> = {
    ...baseProperties,
    [JUSTIFICATION_INPUT_FIELD]: {
      type: "string",
      description: JUSTIFICATION_FIELD_DESCRIPTION,
    },
  };
  const baseRequired = Array.isArray(schema["required"])
    ? (schema["required"] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const required = baseRequired.includes(JUSTIFICATION_INPUT_FIELD)
    ? baseRequired
    : [...baseRequired, JUSTIFICATION_INPUT_FIELD];
  return { schema: { ...schema, properties, required }, injected: true };
}

/**
 * Remove a runtime-injected `justification` field from a tool input before
 * it is forwarded to the tool's validator/executor. Callers apply this ONLY
 * when {@link withJustificationField} reported `injected: true` for the
 * tool — a tool whose own schema declares the field keeps receiving it.
 * Non-mutating: returns a shallow copy without the key, or the input
 * unchanged (by reference) when there is nothing to strip.
 */
export function stripJustificationField(input: unknown): unknown {
  if (!isPlainObject(input) || !(JUSTIFICATION_INPUT_FIELD in input)) return input;
  const { [JUSTIFICATION_INPUT_FIELD]: _stripped, ...rest } = input;
  return rest;
}

export const defaultCatalog = new ToolCatalog();

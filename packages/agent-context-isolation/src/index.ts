/**
 * Catalog R10 `agent-context-isolation` — Section 13.
 *
 * Owns the shared types that flow between the runtime, the Task tool, and the
 * sub-agent spawner so no consumer needs to import another consumer.
 *
 * The `RuntimeBridge` is the opaque payload `runtime-core` stuffs into
 * `ToolExecuteContext.bridge` once per run. Framework-aware tools (today only
 * the `Task` tool) cast it back to this shape. Ordinary tools ignore it.
 *
 * `createIsolatedContext(parent, opts)` materialises the per-child resources
 * for a sub-agent run: a fresh `RunContext` (new runId + sessionId), the
 * child's own `EventLog`, an isolated `state-store`, and an `AbortTree` whose
 * root is wrapped under the parent's abort signal. The latter gives the
 * required cascade semantics: SIGINT on the parent aborts the child; the
 * child finishing (or aborting on its own) does NOT touch the parent —
 * `createAbortTree` already enforces this.
 *
 * No event-bus is shipped here (Section 15 introduces a real one). The
 * boundary between parent and child is recorded as `sub_agent_start` /
 * `sub_agent_end` events on the parent's existing `EventLog`; the child's
 * own transcript lives in a separate `<childSessionId>.jsonl` file.
 */
import { type AbortTree, createAbortTree } from "@crewhaus/abort-controller";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import type { HookDef } from "@crewhaus/hooks-engine";
import type { PermissionMode, RuleSet } from "@crewhaus/permission-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { type Store, createStore } from "@crewhaus/state-store";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

/**
 * A sub-agent definition. The `name` field is set from the spec map's key at
 * lower-time so consumers always see it on the value. `permissions` defaults
 * to "inherit" when undefined; `inherit_bypass` to false.
 */
export type SubAgentDefinition = {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly permissions?:
    | "inherit"
    | "scoped"
    | { readonly allow: ReadonlyArray<string>; readonly deny: ReadonlyArray<string> };
  readonly inherit_bypass?: boolean;
};

/**
 * Token usage rolled up across a single sub-agent run. Section 13 leaves the
 * counters at zero; Section 15 (observability) plumbs the real numbers from
 * the SDK's `final.usage`.
 */
export type TokenUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
};

/** A snapshot of one tool call captured from the child's event log. */
export type ToolCallRecord = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

/** Loose Anthropic message shape — kept structural to avoid a hard dep on the SDK here. */
export type SubAgentMessage = {
  readonly role: "user" | "assistant";
  readonly content: unknown;
};

export type SubAgentResult = {
  readonly finalMessage: string;
  readonly transcript: ReadonlyArray<SubAgentMessage>;
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;
  readonly usage: TokenUsage;
};

/**
 * Everything the spawner / Task tool needs from the parent runtime to start
 * a child. The runtime constructs one of these per-`runChatLoop` invocation
 * and passes it through `ToolExecuteContext.bridge`.
 */
export type ParentRunHandle = {
  readonly runContext: RunContext;
  readonly eventLog: EventLog;
  readonly permissionMode: PermissionMode;
  readonly permissionRules: RuleSet;
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly model: string;
  readonly maxTokens: number;
  readonly sessionRootDir?: string;
};

/**
 * Spawner factory signature. Implemented by `@crewhaus/sub-agent-spawner`;
 * runtime-core injects an instance into the bridge so the Task tool can
 * spawn without runtime-core importing the spawner (which would cycle —
 * spawner consumes runChatLoop).
 */
export type SpawnSubAgentFn = (
  parent: ParentRunHandle,
  opts: SpawnSubAgentOptions,
) => Promise<SubAgentResult>;

export type SpawnSubAgentOptions = {
  readonly def: SubAgentDefinition;
  readonly prompt: string;
  readonly permissionMode: PermissionMode;
  readonly permissionRules: RuleSet;
  readonly childTools: ReadonlyArray<RegisteredTool>;
  readonly sessionRootDir?: string;
  /**
   * Test-only escape hatch: an Anthropic SDK client to use for the child
   * `runChatLoop` instead of the env-resolved one. Production callers leave
   * this undefined; tests pass a scripted stub. The bridge does not
   * propagate this — each test injects directly when constructing the
   * `SpawnSubAgentOptions`.
   */
  readonly _client?: unknown;
  readonly _isOAuth?: boolean;
};

/**
 * Opaque bag the runtime hands to framework-aware tools through
 * `ToolExecuteContext.bridge`. The `Task` tool casts the unknown bridge to
 * this shape. Every field is read-only; the bridge is built once per run.
 */
export type RuntimeBridge = ParentRunHandle & {
  readonly hooks: ReadonlyArray<HookDef>;
  readonly subAgents?: ReadonlyMap<string, SubAgentDefinition>;
  readonly spawnSubAgent: SpawnSubAgentFn;
};

/**
 * Per-child resources owned for the duration of one sub-agent run. The
 * spawner pairs these with `runChatLoop({ runContext, … })` so the runtime
 * inherits the same identity surfaces.
 */
export type IsolatedContext = {
  readonly runContext: RunContext;
  readonly eventLog: EventLog;
  readonly state: Store<Record<string, unknown>>;
  readonly abortTree: AbortTree;
  readonly sessionId: string;
  /** Where this child's tool-result-store will write. `.crewhaus/tool-results/<runId>` */
  readonly toolResultDir: string;
  close(): Promise<void>;
};

export type CreateIsolatedContextOptions = {
  readonly name: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly model?: string;
  readonly sessionRootDir?: string;
};

/**
 * Build an `IsolatedContext` rooted under the parent's abort signal.
 *
 * Identity:
 *   - Fresh `runId` (8 hex) and fresh `sessionId` (sess_<16 hex>) via
 *     `createRunContext`.
 *   - The child's `EventLog` is opened against the same `sessionRootDir`
 *     as the parent so logs collocate, but writes to a different file.
 *   - The state container starts empty — no parent state bleeds in.
 *
 * Cancellation:
 *   - `abortTree.signal` cascades the parent's signal. SIGINT on the parent
 *     aborts the child mid-run.
 *   - The reverse direction is intentionally one-way; see
 *     `abort-controller`'s `attachParent` for the proof: the child's
 *     `abort()` only aborts the child's controller, never reaches up.
 */
export async function createIsolatedContext(
  parent: ParentRunHandle,
  opts: CreateIsolatedContextOptions,
): Promise<IsolatedContext> {
  // Wrap parent's abort signal first so a brand-new abort propagates as
  // soon as we mint the child's RunContext.
  const abortTree = createAbortTree(parent.runContext.abortSignal);

  // Fresh identity. createRunContext mints randomBytes(8)→sess_<16hex> and
  // a short runId; we let the parent's logger seed the child's logger so
  // every log line carries the inherited app/session bindings.
  const runContext = createRunContext({
    abortSignal: abortTree.signal,
    logger: parent.runContext.logger,
  });

  const sessionRootDir = opts.sessionRootDir ?? parent.sessionRootDir;
  const eventLog = await openEventLog(
    runContext.sessionId,
    sessionRootDir !== undefined ? { rootDir: sessionRootDir } : {},
  );

  const state: Store<Record<string, unknown>> = createStore({});

  // Mirrors @crewhaus/tool-result-store's namespacing — ".crewhaus/tool-results/<runId>".
  // Exposed for consumers that want to advertise it (e.g., the smoke script).
  const toolResultDir = `.crewhaus/tool-results/${runContext.runId}`;

  return {
    runContext,
    eventLog,
    state,
    abortTree,
    sessionId: runContext.sessionId,
    toolResultDir,
    async close(): Promise<void> {
      await eventLog.close();
    },
  };
}

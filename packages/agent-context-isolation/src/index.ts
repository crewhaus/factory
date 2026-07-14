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
import { randomBytes, randomUUID } from "node:crypto";
import { type AbortTree, createAbortTree } from "@crewhaus/abort-controller";
import type { FailureReport } from "@crewhaus/errors";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import type { HookDef } from "@crewhaus/hooks-engine";
import type { PermissionMode, RuleSet } from "@crewhaus/permission-engine";
import type { NamedFailureClass } from "@crewhaus/recovery-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import type { SkillRef } from "@crewhaus/skills-registry";
import { type Store, createStore } from "@crewhaus/state-store";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { TraceEventBus } from "@crewhaus/trace-event-bus";

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

/**
 * v0.3.0 §7.1 — a child terminal failure, classified at the spawner
 * boundary. `failureClass` is the recovery-engine verdict (or the report's
 * own class when the child loop already halted with a `RunFailedError`);
 * `report` is the same structured shape every terminal surface renders.
 * Carried on the result for NON-fatal classes so the Task tool can surface
 * an honest `{isError: true, failureClass, report}` tool result; fatal
 * classes (billing / auth) never produce a result — the spawner rethrows
 * `RunFailedError` instead so the parent run halts with the child's report.
 */
export type SubAgentFailure = {
  readonly failureClass: string;
  readonly report: FailureReport;
};

export type SubAgentResult = {
  readonly finalMessage: string;
  readonly transcript: ReadonlyArray<SubAgentMessage>;
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;
  readonly usage: TokenUsage;
  /** Present iff the child run failed with a non-fatal classified error. */
  readonly failure?: SubAgentFailure;
};

/**
 * v0.3.0 §7.1 — the parent's memory seam as projected for children:
 * RECALL-ONLY by construction. The capture half (`autoCapture`/`onCapture`)
 * is deliberately unrepresentable here — parents own memory writes
 * (write-path governance); child findings reach the store through the
 * parent's capture pass walking the `sub_agent_start/end` brackets.
 */
export type SubAgentMemorySeam = {
  readonly autoRecall?: boolean;
  readonly recallK?: number;
  readonly recallSeed?: string;
  /** The parent's recall closure — recalled lines inject into the child's
   *  system prompt through the same seam as the parent loop. */
  readonly recall?: (query: string, k: number) => Promise<readonly string[]>;
};

/**
 * v0.3.0 §7.1 — the parent's continuity seam as projected for children:
 * READ-ONLY by construction. Only `loadPlan` crosses the boundary (so the
 * `<current_plan>` tail renders in child loops); `onPlanDirty` / `onHandoff`
 * / the ledger writes are deliberately unrepresentable — a child must not
 * mutate the parent's plan-store state through the seam. (Plan TOOLS still
 * reach children via catalog inheritance under the parent's permissions —
 * that is a tool-permission decision, not a seam leak.)
 */
export type SubAgentContinuitySeam = {
  readonly loadPlan: () => Promise<string | null>;
};

/**
 * Everything the spawner / Task tool needs from the parent runtime to start
 * a child. The runtime constructs one of these per-`runChatLoop` invocation
 * and passes it through `ToolExecuteContext.bridge`.
 *
 * v0.3.0 §7.1 — the four optional seams below thread the parent loop's
 * wiring into child loops: `memory` (recall on, capture off), `skills`
 * (children finally see the skills prompt block, not just the inherited
 * Skill tool), `failureTaxonomy` (child recovery consults the same named
 * classes), and read-only `continuity` (the plan tail renders; no writes).
 * All optional: bridges built by pre-0.3.0 callers behave exactly as before.
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
  readonly memory?: SubAgentMemorySeam;
  readonly skills?: ReadonlyArray<SkillRef>;
  readonly failureTaxonomy?: ReadonlyArray<NamedFailureClass>;
  readonly continuity?: SubAgentContinuitySeam;
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
 * Section 22 — Crew mailbox. Implemented by `crew-orchestrator`; consumed
 * by the `Handoff` tool (`@crewhaus/agent-handoff`) and the in-crew
 * `SendMessage` tool (`@crewhaus/a2a-protocol`). Type-only here so the
 * orchestrator can sit downstream of the bridge surface without cycling
 * back through `agent-context-isolation`.
 *
 * Design notes:
 *   - `requestHandoff` enqueues a baton-pass for the orchestrator to pick
 *     up after the current role's turn ends; the role's tool simply
 *     records intent and lets the model emit a clean end_turn.
 *   - `sendA2A` is a synchronous "RPC to peer" — the orchestrator runs the
 *     target role inline with the payload as input and returns the reply
 *     as the tool result. Depth-limited to prevent infinite recursion.
 *   - `currentRole` lets tools annotate trace events without the
 *     orchestrator having to re-stamp their inputs.
 *   - `currentTraceparent` lets the A2A envelope advertise the W3C trace
 *     context so OTel stitches the entire crew under one trace id.
 */
export interface CrewMailbox {
  /** Roles registered on the crew at compile time. Used by tools for input validation + descriptions. */
  readonly knownRoles: ReadonlyArray<string>;
  /** Role currently running. Set by the orchestrator before each role's runChatLoop turn. */
  currentRole(): string;
  /** W3C `traceparent` for the crew's current span — embedded in every A2A envelope. */
  currentTraceparent(): string;
  /** Queue a handoff. The orchestrator picks it up after the current turn ends. */
  requestHandoff(target: string, reason: string, context?: unknown): void;
  /**
   * Synchronous peer messaging — runs `toRole` inline with `payload` as
   * input and returns the role's terminal assistant text. Throws on
   * unknown role; returns an error string when the per-call recursion
   * limit is hit.
   */
  sendA2A(toRole: string, payload: string): Promise<string>;
}

/**
 * Opaque bag the runtime hands to framework-aware tools through
 * `ToolExecuteContext.bridge`. The `Task` tool casts the unknown bridge to
 * this shape. Every field is read-only; the bridge is built once per run.
 *
 * `spawnSubAgent` is optional because Section 22's CRW orchestrator
 * builds bridges that have no Task-tool wiring (crew uses Handoff +
 * SendMessage instead). Tools that depend on `spawnSubAgent` MUST
 * check for undefined before calling it.
 */
export type RuntimeBridge = ParentRunHandle & {
  readonly hooks: ReadonlyArray<HookDef>;
  readonly subAgents?: ReadonlyMap<string, SubAgentDefinition>;
  readonly spawnSubAgent?: SpawnSubAgentFn;
  readonly crewMailbox?: CrewMailbox;
  /**
   * v0.3.0 Goal 1 (§2.5) — the per-run `state-store` coordination surface,
   * threaded so tools can signal the runtime within one run. First
   * consumer: a plan-mutating tool (PlanUpdate/FocusWrite, PR 7) sets
   * `"plan.dirty": true` here and runtime-core re-renders the mutable
   * `<current_plan>` tail block before the next model call. Optional
   * because pre-0.3.0 bridge builders (the crew orchestrator's role
   * bridges) don't wire it; tools MUST check for undefined.
   */
  readonly runState?: Store<Record<string, unknown>>;
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
  // every log line carries the inherited app/session bindings. The child's
  // event bus inherits the parent's traceId and is rooted under the parent
  // bus's currently-open span, so OpenTelemetry stitches both runs into one
  // trace. The runId/sessionId on the child's events differ from the parent's
  // so subscribers can still distinguish per-run aggregates.
  const childRunId = `run_${randomUUID().slice(0, 8)}`;
  const childSessionId = `sess_${randomBytes(8).toString("hex")}`;
  const childBus = new TraceEventBus({
    runId: childRunId,
    sessionId: childSessionId,
    inheritTraceId: parent.runContext.eventBus.traceId,
    inheritParentSpanId: parent.runContext.eventBus.currentSpanId,
    logger: parent.runContext.logger,
  });
  const runContext = createRunContext({
    runId: childRunId,
    sessionId: childSessionId,
    abortSignal: abortTree.signal,
    logger: parent.runContext.logger,
    eventBus: childBus,
  });
  // Track 10 / v0.3.0 §7.1 — stamp the child's identity at mint time so
  // child-attributed writes (plan_update / wiki_write / audit entries)
  // record WHICH sub-agent acted. `RunContext.agentIdentity` is documented
  // mutable for exactly this shadowing.
  runContext.agentIdentity = { subAgentId: opts.name };

  const sessionRootDir = opts.sessionRootDir ?? parent.sessionRootDir;

  // openEventLog touches the filesystem (mkdirSync) and can reject. If it does,
  // tear down the abortTree first so the listener createAbortTree attached to
  // the parent's signal is removed (see abort-controller's attachParent) —
  // otherwise a parent that survives many failed spawns accumulates dead abort
  // listeners on its signal.
  let eventLog: EventLog;
  try {
    eventLog = await openEventLog(
      runContext.sessionId,
      sessionRootDir !== undefined ? { rootDir: sessionRootDir } : {},
    );
  } catch (err) {
    abortTree.abort();
    throw err;
  }

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

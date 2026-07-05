import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { type AbortTree, createAbortTree } from "@crewhaus/abort-controller";
import {
  type ProviderAdapter,
  type ProviderId,
  collectFinalMessage,
  consumeStream,
} from "@crewhaus/adapter-anthropic";
import type {
  CrewMailbox,
  RuntimeBridge,
  SpawnSubAgentFn,
  SubAgentDefinition,
} from "@crewhaus/agent-context-isolation";
import { classifyBoundary, setDefaultBoundaryLlmClassifier } from "@crewhaus/boundary-classifier";
import { type WrappedAdapter, wrap as wrapWithCircuitBreaker } from "@crewhaus/circuit-breaker";
import { autoCompact } from "@crewhaus/compaction-autocompact";
import { snip } from "@crewhaus/compaction-snip";
import { createCostTracker } from "@crewhaus/cost-tracker";
import {
  type EgressMatcher,
  type EgressVerdict,
  type SinkScope,
  classifyEgress,
  summarizeEgress,
} from "@crewhaus/egress-classifier";
import { ConfigError, RuntimeError } from "@crewhaus/errors";
import { type EventKind, type EventLog, openEventLog } from "@crewhaus/event-log";
import { type HookDef, type HookEvent, aggregateDecisions, runHooks } from "@crewhaus/hooks-engine";
import {
  type FailoverChain,
  type ResolvedTier,
  type TierRouter,
  createFailoverChain,
  createTierRouter,
  parseModelString,
  resolveModel,
} from "@crewhaus/model-router";
import {
  BUILTIN_DEFAULT_RULES,
  type JustificationJudge,
  type PermissionMode,
  type RuleSet,
  emptyRuleSet,
  evaluateJustification,
  evaluateWithReason,
  ruleBasedJustificationJudge,
} from "@crewhaus/permission-engine";
import { manage as manageCacheMarkers } from "@crewhaus/prompt-cache-manager";
import {
  buildRedactionNotice,
  classifyText,
  llmClassifierEnabled,
} from "@crewhaus/prompt-injection-detector";
import type { RateLimiter } from "@crewhaus/rate-limiter";
import {
  type NamedFailureClass,
  type RecoveryState,
  advanceState,
  initialRecoveryState,
  recover,
} from "@crewhaus/recovery-engine";
import { type RunContext, createRunContext, tagContent } from "@crewhaus/run-context";
import { type SessionStore, createSessionStore } from "@crewhaus/session-store";
import { type SkillRef, formatSkillsForPrompt } from "@crewhaus/skills-registry";
import { type SlashCommand, expand as expandSlash } from "@crewhaus/slash-commands";
import { type Store, createStore } from "@crewhaus/state-store";
import { executeStreaming } from "@crewhaus/streaming-tool-executor";
import { currentTenantContext } from "@crewhaus/tenancy";
import { TokenBudget, estimateTokens } from "@crewhaus/token-budget";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { type LoopDetection, detectLoop } from "@crewhaus/tool-loop-detection";
import { partitionToolCalls } from "@crewhaus/tool-orchestrator";
import { storeAndPreview } from "@crewhaus/tool-result-store";
import { type CostAccrualEvent, TraceEventBus, type Unsubscribe } from "@crewhaus/trace-event-bus";
import {
  type ToolUseBlock as TsmToolUseBlock,
  type TurnState,
  initialState,
  transition,
} from "@crewhaus/turn-state-machine";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type StreamRenderer,
  createCliMarkdownRenderer,
  isCliMarkdownEnabled,
} from "./cli-markdown";
import { attachIncidentCollector } from "./incident-collector";
import {
  type AlertSink,
  type AttachedAdvisorPersistence,
  type AttachedMcpStatsPersistence,
  attachAdvisorPersistence,
  attachDefaultSubscribers,
  attachMcpStatsPersistence,
} from "./observability";
import { loadProjectMemory } from "./project-memory";
import type { SloMitigationSink, SloTargets } from "./slo-monitor";
import { type CliOutput, createCliOutput, isSpinnerEnabled } from "./spinner";

/**
 * Slice-scope runtime: a multi-turn streaming chat loop with prompt
 * caching, tool execution, pre-turn context compaction, recovery taxonomy,
 * permission gating, cooperative cancellation, and a partitioned/streaming
 * tool layer. Maps to catalog R1 runtime-orchestrator + R1 recovery-engine
 * + R8 permission-engine + R1 abort-controller + R3 tool-orchestrator /
 * tool-loop-detection / tool-result-store / streaming-tool-executor, plus
 * R2 model-adapter (Anthropic only).
 *
 * Auth resolution: ANTHROPIC_AUTH_TOKEN (Claude Pro/Max OAuth) takes
 * precedence over ANTHROPIC_API_KEY (pay-per-token API key). OAuth tokens
 * are detected by the `sk-ant-oat` prefix and given the beta + identity
 * headers required to route through subscription billing.
 *
 * Tool support: when `tools` is provided, the loop forwards the tool
 * definitions (Zod → JSON Schema) to the model, runs each tool through
 * the permission engine, then executes via @crewhaus/tool-executor before
 * re-calling the model. The state machine reaches Done(no_tools) when the
 * assistant returns no further tool_use blocks for a turn.
 *
 * Tool layer enrichment (Section 8): tool execution is partitioned via
 * `@crewhaus/tool-orchestrator` so concurrency-safe read-only calls run
 * via `Promise.all` while destructive calls run serially. After each
 * batch, `@crewhaus/tool-loop-detection` scans the per-run history; on a
 * hit, a synthetic warning user message is appended (deduped per
 * signature) so the model can self-correct. Every tool result flows
 * through `@crewhaus/tool-result-store` — outputs over 10 KB are
 * persisted to `.crewhaus/tool-results/<runId>/<toolUseId>.txt` and the
 * model sees a preview pointing at the full file. Behind a
 * `streaming: true` option, the loop swaps to
 * `@crewhaus/streaming-tool-executor`, which dispatches tools mid-stream
 * via the SDK's `contentBlock` event.
 *
 * Compaction: at the start of each user turn, estimate the conversation's
 * token count against `contextLimit` (default 200_000). When usage crosses
 * `compactionThreshold` (default 0.85), apply the cheap snip first, then
 * fall back to autocompact if still over. Reactive compaction is also
 * triggered in-turn when the recovery engine returns a `compact` action.
 *
 * Recovery: every model call is wrapped in try/catch. Errors flow through
 * the `recovery-engine` taxonomy: prompt_too_long → reactive compact;
 * max_output_tokens → continue; overloaded/5xx → exponential-backoff
 * retry; invalid_request → tombstone. Budgets enforced per turn.
 *
 * Permissions: every tool_use is evaluated by `permission-engine`. In
 * default and auto modes, an `ask` decision prompts the user via stdin in
 * REPL mode (single-turn mode treats `ask` as deny — non-interactive).
 *
 * Cancellation: the `runContext.abortSignal` becomes the root of an abort
 * tree; each turn gets a child, each tool call gets a grandchild. First
 * SIGINT cancels the current turn; second SIGINT exits the process.
 *
 * Persistence (Section 10): every `runChatLoop` invocation either creates
 * a new session via `@crewhaus/session-store` or resumes an existing one
 * (`opts.resume`); the session's `.json` metadata file lives at
 * `.crewhaus/sessions/<id>.json` alongside an append-only `.jsonl`
 * transcript opened via `@crewhaus/event-log`. Every user input,
 * assistant turn, tool_use, tool_result, recovery error, and compaction
 * is appended as one JSON line. On `--resume`, the runtime walks the
 * `.jsonl` and replays `user_message` + `assistant_message` events into
 * the message history before the loop starts. A per-run
 * `@crewhaus/state-store` is also instantiated as a coordination surface
 * for hooks/skills/tools (consumed by Section 11+). Eviction: any
 * session whose `.json` mtime is older than 30 days is purged on the
 * next `sessionStore.list()` (called once at the top of every
 * `runChatLoop`).
 */

const DEFAULT_CONTEXT_LIMIT = 200_000;
// Hard per-turn cap on model→tool cycles. Generous enough that no realistic
// agentic turn reaches it, low enough to stop a runaway/injected tool loop
// before it burns a provider quota.
const DEFAULT_MAX_TOOL_ITERATIONS = 500;
// Upper bound on how many concurrency-safe tool calls in one turn run at
// once. Bounds parallel sub-agent (`Task`) fan-out so a wide dispatch
// can't open unbounded model connections and trip a provider rate limit;
// also caps parallel reads, whose per-call cost is negligible. Configurable
// via `runChatLoop({ maxConcurrentTools })`.
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const DEFAULT_COMPACTION_THRESHOLD = 0.85;
const DEFAULT_SNIP_KEEP_HEAD = 4;
const DEFAULT_SNIP_KEEP_TAIL = 20;

/**
 * Run `items` through `fn` with at most `limit` in flight at once,
 * preserving input order in the returned results. A pool of `limit`
 * workers pull from a shared cursor, so a slow item never blocks a fast
 * one behind it (unlike fixed-size `Promise.all` chunks). `limit <= 0`
 * is clamped to 1; a limit larger than the batch just runs everything.
 * Exported for unit testing of the concurrency bound.
 */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const bound = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

// Section 17 — `resolveAuth` / `createAnthropicClient` / `ResolvedAuth` /
// `OAUTH_BETAS` / `CLAUDE_CODE_HEADERS` / `CLAUDE_CODE_SYSTEM_PREFIX`
// moved into `@crewhaus/adapter-anthropic`. Re-exported here so legacy
// importers (eval-judge fallback, downstream tests) keep compiling.
export {
  CLAUDE_CODE_HEADERS,
  CLAUDE_CODE_SYSTEM_PREFIX,
  OAUTH_BETAS,
  createAnthropicClient,
  resolveAuth,
} from "@crewhaus/adapter-anthropic";
export type { ResolvedAuth } from "@crewhaus/adapter-anthropic";

// Ops item 36 — boot-time self-heal janitor for daemon shapes. Lives in its
// own module (`./janitor`) but is re-exported here because emitted bundles
// only import the package root.
export { createJanitor } from "./janitor";
export type {
  CreateJanitorOptions,
  Janitor,
  JanitorReservationStore,
  JanitorRunResult,
  JanitorStepName,
  JanitorStepResult,
  JanitorStepStatus,
} from "./janitor";

// Ops item 31 — alert watchdog seams re-exported so the CLI/codegen can build
// the durable + off-box alert sink (audit append + settings.json alert hook /
// webhook) it passes as `RunChatLoopOptions.alertSink`.
export {
  type AlertBreachPayload,
  type AlertSink,
  type AttachDefaultSubscribersOptions,
  attachDefaultSubscribers,
} from "./observability";

// Ops item 37 — SLO monitor seams re-exported so the CLI/codegen can build the
// injected mitigation ladder (audit / pause-intake / rollback) it passes as
// `RunChatLoopOptions.sloSink`, and the doctor probe can share the breach types.
export {
  type AttachedSloMonitor,
  type AttachSloMonitorOptions,
  type SloBreach,
  type SloMitigationEvent,
  type SloMitigationRung,
  type SloMitigationSink,
  type SloTargets,
  type SloWindowMetrics,
  DEFAULT_SLO_WINDOW_MS,
  MIN_SLO_SAMPLES,
  SloWindow,
  attachSloMonitor,
  detectSloBreaches,
} from "./slo-monitor";

// Ops item 32 — incident collector seams re-exported so the CLI can share the
// raw-capture shape + trigger classifier with `incident collect`.
export {
  type AttachIncidentCollectorOptions,
  type IncidentCapture,
  type IncidentTriggerKind,
  attachIncidentCollector,
  classifyIncidentTrigger,
} from "./incident-collector";

/**
 * Reconcile a message history by dropping "orphan" `tool_use` blocks — a
 * `tool_use` with no answering `tool_result` anywhere later in the
 * conversation. The Claude Messages API requires every `tool_use` to be
 * followed by a matching `tool_result`; an orphan makes every subsequent
 * request 400 with `tool_use` ids "found without `tool_result` blocks
 * immediately after". Orphans are born when the model is cut off mid-`tool_use`
 * by `stop_reason: "max_tokens"`: the partial call is never executed (so a
 * result is never logged) and its input is truncated / `__parse_error`
 * garbage, so the only safe reconciliation is to drop it and let the model
 * re-issue the call. An assistant message left empty after stripping is
 * removed entirely.
 *
 * Idempotent and a no-op on healthy histories. Applied on `--resume` replay
 * (so a session bricked by a pre-fix runtime self-heals) and by the
 * `tombstone` recovery action (a universal backstop for any path that still
 * commits an orphan).
 */
export function sanitizeOrphanToolUses(messages: ReadonlyArray<Anthropic.MessageParam>): {
  messages: Anthropic.MessageParam[];
  removed: number;
} {
  const answered = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as { type?: string; tool_use_id?: unknown };
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        answered.add(b.tool_use_id);
      }
    }
  }
  let removed = 0;
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const kept = m.content.filter((block) => {
      const b = block as { type?: string; id?: unknown };
      if (b.type === "tool_use" && typeof b.id === "string" && !answered.has(b.id)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (kept.length === 0) continue;
    out.push(kept.length === m.content.length ? m : { ...m, content: kept });
  }
  return { messages: out, removed };
}

/**
 * Walk an `EventLog` and reconstruct the SDK message history. Only
 * `user_message` and `assistant_message` events contribute — `tool_use`
 * and `tool_result` events are audit-only because the same data already
 * lives inside the assistant/user message content arrays. `error` and
 * `compaction` events are observability-only and skipped.
 *
 * Exported so consumers (the `--resume` path in `apps/cli`, the T4
 * replay test, and any future inspector) can reproduce the same history
 * the runtime would build.
 */
export async function replayMessageHistory(log: EventLog): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [];
  // Crew sessions and sub-agent spawners share one append-only log.
  // Events emitted between a2a_turn_start / a2a_turn_end (Section 22)
  // or sub_agent_start / sub_agent_end (Section 13) are nested
  // transcripts that should NOT bleed into the outer role's history —
  // their `user_message` and `assistant_message` events would otherwise
  // sit between the parent's tool_use and its tool_result, breaking
  // Claude API's adjacency requirement. Track nesting depth and only
  // surface user/assistant events at depth 0.
  let depth = 0;
  for await (const ev of log.read()) {
    if (ev.kind === "a2a_turn_start" || ev.kind === "sub_agent_start") {
      depth += 1;
      continue;
    }
    if (ev.kind === "a2a_turn_end" || ev.kind === "sub_agent_end") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (ev.kind === "user_message") {
      const p = ev.payload as { content: Anthropic.MessageParam["content"] };
      messages.push({ role: "user", content: p.content });
    } else if (ev.kind === "assistant_message") {
      const p = ev.payload as { content: Anthropic.MessageParam["content"] };
      messages.push({ role: "assistant", content: p.content });
    }
  }
  // A session persisted by a pre-fix runtime can carry a dangling `tool_use`
  // the model was cut off mid-emitting (`stop_reason: "max_tokens"`) with no
  // following `tool_result`; replaying it verbatim would 400 the first resumed
  // request. Drop such orphans so `--resume` self-heals. No-op on healthy logs.
  return sanitizeOrphanToolUses(messages).messages;
}

/**
 * Pillar 3 (FR-004) intent gate — the durable audit sink the justification
 * gate appends to. Structurally a subset of `@crewhaus/audit-log`'s
 * `AuditLog` (its `append({ kind, payload })`), declared here as a minimal
 * interface so runtime-core does NOT take a dependency on (or a cycle with)
 * `@crewhaus/audit-log`. The CLI/codegen passes a real `openAuditLog(...)`
 * instance; tests pass an in-memory or tmp-dir-backed one. When omitted (the
 * default for every existing caller), the gate writes nothing durable and the
 * trace-bus `permission_decision` event remains the only surface — i.e. zero
 * behaviour change unless a caller opts in.
 *
 * The `kind` the gate appends is exactly `"permission_justification_evaluated"`,
 * the AuditKind `@crewhaus/audit-log` reserves for this signal; the payload is
 * the documented verbatim shape `{ toolName, justification, verdict, reason,
 * judgeModel, confidence? }` (the justification IS the audit artifact — stored
 * verbatim, never redacted).
 */
export type JustificationAuditSink = {
  append(input: {
    readonly kind: "permission_justification_evaluated";
    readonly payload: unknown;
  }): Promise<unknown>;
};

/**
 * Pillar 3 sink-side fabric — the durable audit sink the egress classifier
 * appends to. Structurally the same subset of `@crewhaus/audit-log`'s
 * `AuditLog` as {@link JustificationAuditSink} (its `append({ kind, payload })`),
 * declared as a minimal interface so runtime-core takes no dependency on (or
 * cycle with) `@crewhaus/audit-log`.
 *
 * BACKGROUND (AUTOMATION-OPPORTUNITIES.md item 20): the `egress_decision`
 * AuditKind was declared but had NO writer — egress verdicts existed ONLY as
 * ephemeral trace-bus `permission_decision` events (outcome: `egress-*`), so
 * nothing could triage egress history offline. This seam closes that: when a
 * caller wires it, every NON-PASS egress verdict (warn OR block) appends one
 * durable `egress_decision` record so `crewhaus egress review` can mine it.
 * The RAW outbound payload is never stored — only the lineage summary the
 * digest documents (`{ sinkId, sinkScope, verdict, originsFound, matchCount }`),
 * exactly as `@crewhaus/audit-log`'s AuditKind header specifies. Pass verdicts
 * are NOT written (they are the overwhelming common case and carry no triage
 * signal). Omitting the sink is zero behaviour change for existing callers.
 */
export type EgressAuditSink = {
  append(input: {
    readonly kind: "egress_decision";
    readonly payload: unknown;
  }): Promise<unknown>;
};

export type RunChatLoopOptions = {
  model: string;
  instructions: string;
  maxTokens?: number;
  /**
   * Section 17 — optional override for the model used by
   * `compaction-autocompact`. When undefined, compaction reuses
   * `opts.model` (and therefore the same adapter). Set to a different
   * model string (or even a different provider via the prefix
   * conventions, e.g. `openai/gpt-4o-mini`) to route compaction
   * elsewhere.
   */
  compactionModel?: string;
  /**
   * Test injection backdoor: pre-built ProviderAdapter that bypasses
   * the model-router. When set, `model` is still the user-facing
   * `agent.model` (used for trace events and as the `req.model` field
   * passed to the adapter), but no router lookup happens.
   *
   * Used by sub-agent-spawner.test.ts and runtime-core.test.ts to
   * inject scripted adapters; replaces the previous `client` /
   * `isOAuth` injection contract.
   */
  _adapter?: ProviderAdapter;
  /**
   * Section 17 — same as `_adapter` but for the compaction model.
   * When omitted, defaults to `_adapter` (or the routed primary).
   */
  _compactionAdapter?: ProviderAdapter;
  /**
   * Item 22 — same injection contract as `_adapter`, for the failover
   * chain's fallback candidates: pre-built adapters keyed by their spec
   * model string, bypassing the model-router. Only consulted when
   * `modelFallbacks` is non-empty. Tests script per-candidate failures
   * through this map; production callers leave it undefined.
   */
  _failoverAdapters?: ReadonlyMap<string, ProviderAdapter>;
  /**
   * Item 27 — test injection for the budget-degrade target: a pre-built
   * adapter used in place of `resolveModel(budget.onExceed.model)` when a
   * `degrade` breach fires. Production callers leave it undefined (the
   * runtime resolves the degrade model through the normal router path).
   */
  _budgetDegradeAdapter?: ProviderAdapter;
  /** Override the input stream (testing). Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Tools the model may invoke. When empty/undefined, tools are not advertised. */
  tools?: ReadonlyArray<RegisteredTool>;
  /** Per-run identity, abort signal, and logger. Defaults to a fresh `createRunContext()`. */
  runContext?: RunContext;
  /** Context-window limit in tokens. Defaults to 200_000 (Claude opus/sonnet 4.x). */
  contextLimit?: number;
  /** Fraction of `contextLimit` at which compaction kicks in. Defaults to 0.85. */
  compactionThreshold?: number;
  /** Number of head messages to keep when snipping. Defaults to 4. */
  snipKeepHead?: number;
  /** Number of tail messages to keep when snipping. Defaults to 20. */
  snipKeepTail?: number;
  /**
   * Pre-loaded conversation history. In `singleTurn` mode this is the
   * entire input; the last entry must be `role: "user"`.
   */
  seedMessages?: ReadonlyArray<Anthropic.MessageParam>;
  /**
   * Single-shot mode: run exactly one user→assistant turn (with the tool
   * inner-loop until Done) using `seedMessages`, then return the terminal
   * assistant text. Skips the stdin REPL entirely. Used by the workflow
   * target to run each step as a discrete turn.
   */
  singleTurn?: boolean;
  /**
   * Permission mode. Defaults to "default" (ask for tools without an
   * explicit allow rule). The `bypass` mode is only legal when supplied
   * directly by the runtime caller (the CLI flag parser); the spec/config
   * loaders reject bypass at parse time.
   */
  permissionMode?: PermissionMode;
  /** Layered rule sources. Defaults to `{ ..., builtin: BUILTIN_DEFAULT_RULES }`. */
  permissionRules?: RuleSet;
  /**
   * Install a SIGINT handler that aborts the current turn on first press
   * and exits on the second. Defaults to true in REPL mode when stdin is
   * a TTY; defaults to false otherwise (singleTurn, piped input, tests).
   */
  installSigintHandler?: boolean;
  /**
   * When true, drive the model stream with `@crewhaus/streaming-tool-executor`
   * so tool execution starts as soon as each `tool_use` block completes
   * (mid-stream) rather than waiting for the full response. Default: false.
   */
  streaming?: boolean;
  /**
   * Animate a "working" indicator (spinner + status label) on the otherwise
   * silent waits — model thinking, tool execution, retry/compaction. When
   * omitted, auto-enables only for an interactive REPL on a TTY with a
   * spinner-friendly env (see `isSpinnerEnabled`); force off with `false`.
   * `singleTurn` and injected-`input` runs never spin.
   */
  spinner?: boolean;
  /**
   * Override the directory under which session metadata `.json` files and
   * event-log `.jsonl` files live. Defaults to `.crewhaus/sessions`.
   */
  sessionRootDir?: string;
  /**
   * Human-readable label for new sessions; persisted to the session JSON.
   * Typically the spec `name`. Defaults to `(unnamed)`.
   */
  sessionName?: string;
  /**
   * Target shape this session belongs to (`"cli"`, `"workflow"`, …); persisted
   * to the session JSON for future filtering. Defaults to `"cli"`.
   */
  sessionTarget?: string;
  /**
   * Resume an existing session: load its metadata, replay its event log
   * into the message history (only `user_message` + `assistant_message`
   * events; tool_use/tool_result are audit-only and already nested inside
   * those messages), then continue the loop. Mutually exclusive with
   * `seedMessages` (the resume payload becomes the seed). When the caller
   * supplies a `runContext`, its `sessionId` must already match
   * `resume.sessionId`; otherwise the runtime reseats the sessionId in
   * the run context for this run.
   */
  resume?: { readonly sessionId: string };
  /**
   * Section 11 — lifecycle hooks discovered from `.crewhaus/settings.json`.
   * The runtime fires events at key moments (session-start, pre/post tool,
   * pre/post model, pre/post compact, pre-slash, stop). A `deny` decision
   * on `pre-tool` short-circuits with the hook's reason as the result; on
   * `pre-model` it appends `[blocked by hook]` and ends the turn.
   */
  hooks?: ReadonlyArray<HookDef>;
  /**
   * Section 11 — discovered skills, advertised in the system prompt. The
   * caller is responsible for adding `createSkillTool(skills)` to the
   * `tools` array; runtime-core only formats them into the system block.
   */
  skills?: ReadonlyArray<SkillRef>;
  /**
   * Section 11 — slash-command registry. When the user input starts with
   * `/<name>` and `<name>` is in this map, the body is expanded with
   * `$ARGUMENTS` substitution before being sent to the model. Fires
   * `pre-slash` first; deny falls through to the original input.
   */
  slashCommands?: ReadonlyMap<string, SlashCommand>;
  /**
   * Feature #53 — cross-session memory auto-recall/auto-capture wiring. When
   * `store` is supplied (the caller builds it from `createMemoryStore`), the
   * runtime honours the auto-* switches:
   *   - `autoRecall`: at session start, recall the top-`recallK` memories for
   *     the current context and inject them into the system prompt (mirrors
   *     the project-memory auto-load block). `recallSeed` is the query used
   *     (defaults to the agent instructions).
   *   - `autoCapture`: at run teardown (in the same finally where the `stop`
   *     hook fires — NOT a credential-stripped hook), the caller-supplied
   *     `onCapture` is invoked with the completed-turn count so it can
   *     summarize the session's durable outcomes into the store.
   * Omitted → no memory injection or capture (Remember/Recall passed via
   * `tools` still work). Kept as an injected seam so runtime-core does not
   * depend on memory-store.
   */
  memory?: {
    readonly autoRecall?: boolean;
    readonly recallK?: number;
    readonly recallSeed?: string;
    /** Return recalled memory lines to inject; runtime wraps them in a block. */
    readonly recall?: (query: string, k: number) => Promise<readonly string[]>;
    readonly autoCapture?: boolean;
    /** Invoked at teardown with the completed user-text turn count and the
     *  run's session id (so the callback can read the transcript to summarize). */
    readonly onCapture?: (completedTurns: number, sessionId: string) => Promise<void>;
  };
  /**
   * Item #56 — absolute paths to per-user preference files injected at run
   * start via the project-memory auto-load path (alongside LESSONS.md, which
   * is now a canonical memory file). The CLI resolves the current user's
   * `.crewhaus/preferences/<user>.md` and threads it here. Absent → no-op.
   */
  preferenceFiles?: ReadonlyArray<string>;
  /**
   * Section 13 — inline sub-agent definitions exposed via the `Task` tool.
   * Threaded into the `RuntimeBridge` and surfaced to framework-aware
   * tools (only `Task` today). Codegen sets this from the IR; ordinary
   * runChatLoop callers leave it undefined.
   */
  subAgents?: ReadonlyMap<string, SubAgentDefinition>;
  /**
   * Section 13 — sub-agent spawner injection. Codegen passes
   * `spawnSubAgent` from `@crewhaus/sub-agent-spawner`. The runtime stamps
   * it onto the bridge; the Task tool dispatches via it. Inverted-DI to
   * avoid a runtime-core → sub-agent-spawner cycle (the spawner consumes
   * runChatLoop).
   */
  spawnSubAgent?: SpawnSubAgentFn;
  /**
   * Section 22 — crew orchestrator injection. The orchestrator
   * implements `CrewMailbox` and threads itself in here per role-turn so
   * the in-band Handoff and A2A SendMessage tools can record intent /
   * make synchronous peer requests through `ctx.bridge.crewMailbox`.
   * Inverted-DI to avoid a runtime-core → crew-orchestrator cycle (the
   * orchestrator consumes runChatLoop).
   */
  crewMailbox?: CrewMailbox;
  /**
   * Section 18 — set true when the bundle has wired a non-noop sandbox
   * backend. The permission engine refuses to grant `allow` for tools
   * with `requiresSandbox: true` unless this is set. Codegen flips this
   * automatically when the spec lists any `requiresSandbox` tool.
   */
  sandboxAvailable?: boolean;
  /**
   * Section 18 — when set, suspicious or malicious tool outputs are
   * classified by an LLM after the regex/structural layers. The runtime
   * supplies the function; the prompt-injection-detector calls it as
   * a best-effort tier-3. When omitted (the common case), the classifier
   * stays at tiers 1-2.
   */
  promptInjectionLlmClassifier?: (
    text: string,
  ) => Promise<{ verdict: "clean" | "suspicious" | "malicious"; rationale?: string } | undefined>;
  /**
   * Pillar 3 intent gate — when supplied, runtime-core wires this judge
   * into `evaluateJustification` for every tool call whose descriptor
   * sets `requireJustification: true`. Defaults to the rule-based judge
   * exported by `permission-engine`. Production deployments should pass
   * an LLM-backed judge that compares the agent's stated justification
   * against the session goal with model-quality reasoning.
   */
  justificationJudge?: JustificationJudge;
  /**
   * Pillar 3 (FR-004) intent gate — durable audit sink. When supplied,
   * every justification-evaluated tool call appends a
   * `permission_justification_evaluated` record (verbatim payload) to this
   * hash-chained sink IN ADDITION to publishing the `permission_decision`
   * trace event. This is the durable, tamper-evident audit artifact the
   * `permission_justification_evaluated` AuditKind was created for; the
   * trace-bus event is ephemeral. Omitting it leaves the trace bus as the
   * only surface (no behaviour change for existing callers). The CLI `run`
   * path wires a real `@crewhaus/audit-log` instance rooted at
   * `.crewhaus/audit`.
   */
  justificationAuditSink?: JustificationAuditSink;
  /**
   * Ops item 31 — durable + off-box delivery for the alert watchdog (gated by
   * CREWHAUS_ALERTS). When supplied, a baseline-threshold breach appends an
   * audit record and/or fires the settings.json `alert` hook / webhook via
   * these callbacks. Omitted → the watchdog still persists its per-session
   * metrics snapshot and publishes the `alert_raised` trace event, it just has
   * no durable/off-box delivery (zero behaviour change for existing callers).
   * The CLI `run` path wires the audit log + settings.json alert hook here.
   */
  alertSink?: AlertSink;
  /** Item 31 — override the per-session metrics-history dir (tests/tenants). */
  alertMetricsDir?: string;
  /**
   * Ops item 37 — lowered `observability.slo` targets (gated by CREWHAUS_SLO).
   * When supplied, the runtime SLO monitor folds live events into rolling
   * windows and walks the declared mitigation ladder on a sustained breach.
   * Omitted → no monitor (zero behaviour change). The CLI `run` path lowers
   * the cwd spec's `observability.slo` block and wires the mitigation sink.
   */
  sloTargets?: SloTargets;
  /** Item 37 — injected SLO mitigation ladder delivery (audit / pause-intake /
   *  rollback), supplied by the CLI so runtime-core owns no deploy/gateway I/O. */
  sloSink?: SloMitigationSink;
  /**
   * Ops item 32 — spec identity stamped into an auto-assembled incident
   * capture (gated by CREWHAUS_INCIDENTS). Absent → the capture records a null
   * spec; the CLI `run` path passes `{ name, version?, hash? }`.
   */
  incidentSpec?: { readonly name: string; readonly version?: string; readonly hash?: string };
  /** Item 32 — override the incidents dir (tests/tenants). */
  incidentsDir?: string;
  /**
   * Pillar 3 sink-side fabric (FR-006) — pluggable egress-matching
   * strategy. When supplied, every external-scope tool call routes its
   * payload through this matcher inside `classifyEgress` instead of the
   * built-in `SubstringEgressMatcher`. The matcher only decides *which*
   * tagged data-lineage entries the payload contains; the per-origin/
   * per-sink policy and the three audit outcomes (`egress-passed |
   * egress-warned | egress-blocked`) are unchanged. Omitting it preserves
   * the substring default (zero behaviour change for existing callers).
   * Production deployments that opt into semantic detection pass an
   * instance of `@crewhaus/egress-matcher-semantic`.
   */
  egressMatcher?: EgressMatcher;
  /**
   * Pillar 3 sink-side fabric — durable egress audit sink (item 20). When
   * supplied, every NON-PASS egress verdict (warn OR block) appends one
   * `egress_decision` record (lineage summary only, never the raw payload) to
   * this hash-chained sink IN ADDITION to the ephemeral `permission_decision`
   * trace event. This is what makes egress history triageable offline by
   * `crewhaus egress review`. Omitting it leaves the trace bus as the only
   * surface (no behaviour change for existing callers). The CLI `run` path
   * wires a real `@crewhaus/audit-log` instance rooted at `.crewhaus/audit`.
   */
  egressAuditSink?: EgressAuditSink;
  /**
   * Pillar 3 sink-side — classify a tool sink as `"external-configured"` (a
   * spec-declared sink → warn on non-user content) or `"external-dynamic"` (a
   * runtime-joined sink → block on non-user content). Defaults to treating
   * `mcp__*` sinks as dynamic and everything else as configured (#144); wire
   * this to mark federation-joined or other runtime-discovered sinks dynamic.
   */
  resolveSinkScope?: (toolName: string) => SinkScope;
  /**
   * Hard cap on the number of model→tool cycles in a single turn. The loop
   * detector is advisory (it only injects a one-time warning and is defeated
   * by trivial argument churn), so this is the ENFORCING bound: a prompt-
   * injected model steered into an unbounded tool loop is aborted here rather
   * than burning tokens/tool calls until a provider quota or OOM trips.
   * Defaults to `DEFAULT_MAX_TOOL_ITERATIONS`; set higher for genuinely long
   * agentic turns, or lower to tighten.
   */
  maxToolIterations?: number;
  /**
   * Max number of concurrency-safe tool calls executed in parallel within
   * a single turn. Chiefly bounds parallel sub-agent (`Task`) fan-out so a
   * wide dispatch can't open unbounded model connections; parallel reads
   * are also capped but their per-call cost is negligible. Defaults to
   * `DEFAULT_MAX_CONCURRENT_TOOLS` (4). `<= 0` is clamped to 1 (serial).
   */
  maxConcurrentTools?: number;
  /**
   * Section 27 / item 22 — wrap the resolved primary `ProviderAdapter` in a
   * circuit breaker before any `stream()` call. When the breaker trips,
   * subsequent model calls reject immediately rather than hammering a
   * degraded upstream. Set by codegen (and the `crewhaus run` path) from the
   * spec's `agent.circuit_breaker` block; field names mirror
   * `CircuitBreakerOptions` in `@crewhaus/circuit-breaker`. When
   * `modelFallbacks` is also set, this tuning applies to EVERY candidate's
   * breaker in the failover chain.
   */
  circuitBreaker?: {
    readonly failureThreshold?: number;
    readonly windowMs?: number;
    readonly cooldownMs?: number;
  };
  /**
   * Item 22 — ordered fallback model strings (spec `agent.model_fallbacks`).
   * When non-empty, the primary adapter is replaced by a
   * `@crewhaus/model-router` failover chain: every candidate (primary
   * first) gets its own circuit breaker, each model call routes to the
   * first candidate whose breaker admits traffic, and routing changes are
   * published as `model_failover` trace events. Fallbacks resolve their
   * credentials lazily via the normal `resolveModel` path — a candidate
   * with a missing key warns at boot (doctor-style, stderr) and is skipped
   * when actually tried, never hard-failing boot. v1 scope: only the
   * primary agent model gets the chain — `compactionModel` (when it names
   * its own model) and judge/grader slots keep their single adapters. When
   * compaction reuses the primary model (no `compactionModel`), it flows
   * through the same chain by construction.
   */
  modelFallbacks?: ReadonlyArray<string>;
  /**
   * Item 26 — opt-in two-tier turn-difficulty router (spec `agent.model_tiers`).
   * When set, BOTH tier adapters resolve at boot (mirroring the compaction
   * second-adapter wiring), and each turn the loop picks a tier from
   * deterministic signals (estimated context tokens, tools-in-play, turn
   * index, prior-turn tool_use density), streams through the chosen tier's
   * adapter, and publishes a `model_tier_route` trace event. A `fast`-tier
   * turn that FAILS is re-run on `default` (misroute recovery). Absent → the
   * single primary adapter path, unchanged. Mutually independent of
   * `modelFallbacks`: when both are set the primary chain still governs the
   * `default` tier; the `fast` tier is its own single adapter (v1 scope).
   */
  modelTiers?: {
    readonly fast: string;
    readonly default: string;
    readonly routing?: {
      readonly contextTokenThreshold?: number;
      readonly toolsToDefault?: boolean;
      readonly firstTurnToDefault?: boolean;
      readonly priorToolDensityThreshold?: number;
    };
  };
  /**
   * Item 26 — test injection for the two tier adapters, keyed by their spec
   * model string (mirrors `_failoverAdapters`). Production callers leave it
   * undefined (the runtime resolves both tiers through the normal router).
   */
  _tierAdapters?: ReadonlyMap<string, ProviderAdapter>;
  /**
   * Section 55 (Track A) / item 23 — the spec's `failure_taxonomy`, lowered
   * from the IR. Consulted by `recovery-engine.recover()` BEFORE its
   * built-in classify+recover flow so user-named error classes take
   * precedence (their declared `recovery` action wins). Item 23 adds the
   * `switch-model` action: a matched entry reroutes the same turn onto the
   * next provider-failover candidate (opening the active breaker) instead
   * of exhausting backoff retries — only meaningful with `modelFallbacks`
   * set; a no-op re-issue otherwise. When absent, recovery is the built-in
   * taxonomy exactly as before (zero behaviour change for existing callers).
   */
  failureTaxonomy?: ReadonlyArray<NamedFailureClass>;
  /**
   * Section 27 — pre-call rate gating. The runtime calls
   * `rateLimiter.acquire(rateLimitKeys, 1)` before each model invocation.
   * Codegen sets `rateLimitKeys` to `[provider, tenant?]` from the
   * spec's tools/permissions/tenancy block. Without `rateLimiter` set,
   * gating is skipped (no allow-list error).
   */
  rateLimiter?: RateLimiter;
  /** Keys to acquire per model call. Default: `[]`. */
  rateLimitKeys?: ReadonlyArray<{
    readonly dimension: "tenant" | "provider" | "tool";
    readonly id: string;
  }>;
  /**
   * Section 27 — when set, the system block array goes through
   * `prompt-cache-manager.manage()` once at run start; if a fresh marker is
   * injected the new `lastRotatedAt` is exposed via the returned bus event.
   * Pass `0` (or omit) to force a refresh on the first turn.
   */
  promptCacheLastRotatedAt?: number;
  /**
   * Item 27 — run-level spend cap with a degradation ladder. Generalizes
   * the optimizer's `BudgetMeter` to normal runs (`crewhaus run
   * --budget-usd` / spec `budget: { usd, on_exceed }`). An always-on cost
   * meter (independent of `CREWHAUS_COST_TRACKING`) accrues per-response
   * spend priced off the WIRE model that actually served, and a PRE-TURN
   * check — beside the token-budget/compaction check — enforces the cap
   * before the next user turn opens:
   *   - `on_exceed.kind: "stop"` ends the run cleanly with a `[budget]`
   *     notice (the current turn always completes; the cap gates the NEXT
   *     turn, so an in-flight turn is never severed mid-tool-call).
   *   - `on_exceed.kind: "degrade"` re-resolves the primary model to
   *     `on_exceed.model` ONCE (the cheaper rung of the ladder) and
   *     continues; a `model_failover` event (reason `budget_degrade`)
   *     records the switch. If spend later crosses the cap AGAIN on the
   *     degraded model, the run stops (the ladder has one rung in v1).
   * `usdMicros` is the ceiling in USD-micros (1 USD = 1_000_000). Absent →
   * no cap (zero behaviour change for existing callers). A model the
   * pricing table can't price accrues $0, so an all-unpriced run degrades
   * to uncapped — same posture as cost-tracker's pricing-miss handling.
   */
  budget?: {
    readonly usdMicros: number;
    readonly onExceed:
      | { readonly kind: "stop" }
      | { readonly kind: "degrade"; readonly model: string };
  };
};

/**
 * Runs the streaming chat loop and returns the terminal assistant text.
 *
 * - REPL mode (default): reads stdin in a loop, prints assistant turns to
 *   stdout, returns `""` when the loop exits.
 * - Single-turn mode (`singleTurn: true`): runs one turn from the seeded
 *   message history and returns the concatenated text content of the final
 *   assistant message. Does not touch stdin.
 */
/**
 * Resolve the root directory for session + event-log persistence (and the
 * sub-agent storage it threads onward).
 *
 * Tenant isolation is MANDATORY at the storage layer, not cooperative: the
 * managed daemon wraps every gateway request in `withTenant(...)`, so when a
 * tenant context is active we use that tenant's path-rebased `sessionRoot`
 * and never fall back to the process-global default — one tenant's prompts
 * and transcripts can no longer land in another tenant's directory (#142).
 *
 * Precedence: an explicit per-call `optsRoot` (set only by trusted callers
 * such as a target emitter or a test) wins; then the active tenant's
 * `sessionRoot`; then `CREWHAUS_SESSION_DIR`; otherwise `undefined` (which
 * lets `session-store` apply its own non-tenant default). The env var and the
 * global default are only consulted OUTSIDE any tenant scope.
 */
export function resolveSessionRootDir(optsRoot: string | undefined): string | undefined {
  if (optsRoot !== undefined) return optsRoot;
  const tenant = currentTenantContext()?.tenant;
  if (tenant !== undefined) return tenant.sessionRoot;
  return process.env["CREWHAUS_SESSION_DIR"] ?? undefined;
}

/**
 * Tenant-scoped root for the tool-result spill store, mirroring
 * resolveSessionRootDir (#150). Inside a tenant scope the tenant's rebased
 * `toolResultRoot` is used so one tenant's persisted tool outputs never share
 * a directory with another's; otherwise `undefined` lets tool-result-store
 * apply its own non-tenant default.
 */
export function resolveToolResultRoot(): string | undefined {
  return currentTenantContext()?.tenant.toolResultRoot;
}

/**
 * Sinks whose DESTINATION is chosen at runtime by the (prompt-injectable)
 * model — a fetched/navigated URL, an on-chain recipient — are effectively
 * dynamic even though they are spec-declared built-in tools: an attacker who
 * steers the model picks where the data goes. So non-user cross-origin content
 * reaching them must reach the egress BLOCK tier, not merely warn. Fixed-
 * destination sinks are intentionally NOT here: `SendMessage` replies to the
 * operator-configured channel, `WebSearch`/`ImageGenerate` hit a fixed provider
 * API — classifying those dynamic would block legitimate replies, so they stay
 * `"external-configured"` (warn) and can be tightened per-deployment via the
 * `resolveSinkScope` override or the spec's egress policy.
 */
const MODEL_DESTINATION_SINKS: ReadonlySet<string> = new Set([
  "Fetch",
  "WebFetch",
  "Navigate",
  "EvmSendTransaction",
]);

/**
 * Default egress sink-scope. Runtime-joined MCP sinks (`mcp__*`) are the
 * canonical dynamically-discovered external sink, and the model-destination
 * built-ins above are dynamic by virtue of their model-chosen target — both
 * classify as `"external-dynamic"` so the egress block tier is reachable for
 * non-user-origin payloads (#144). Other spec-declared built-in sinks stay
 * `"external-configured"` (warn). Override via `runChatLoop({ resolveSinkScope })`
 * to mark federation-joined or other runtime sinks dynamic too.
 */
export function defaultSinkScope(toolName: string): SinkScope {
  if (toolName.startsWith("mcp__")) return "external-dynamic";
  if (MODEL_DESTINATION_SINKS.has(toolName)) return "external-dynamic";
  return "external-configured";
}

/**
 * Neutralize a boundary-block closing delimiter embedded in untrusted content
 * so a poisoned line can't terminate its wrapper block early and inject
 * trailing instructions. Replaces `</tag>` (any casing/whitespace) with a
 * visually-inert `<\/tag>` so the content survives for the model to read but
 * no longer parses as the real closing tag. Used for the recalled-memory block
 * (#53) — recalled memories may carry content shaped by untrusted tool output.
 */
function escapeBoundaryDelimiter(text: string, tag: string): string {
  // Match `</tag>` tolerantly (leading whitespace inside the tag, any casing).
  const re = new RegExp(`</\\s*${tag}\\s*>`, "gi");
  return text.replace(re, `<\\/${tag}>`);
}

/**
 * Strip the model-string provider grammar down to the wire model id
 * (`"bedrock/us.anthropic.claude-..."` → `"us.anthropic.claude-..."`)
 * WITHOUT loading the provider package. Used on the `_adapter` injection
 * path where `resolveModel` is bypassed entirely; synthetic ids that
 * don't parse (`"test-model"`) pass through verbatim so existing test
 * stubs keep their ids untouched.
 */
function bestEffortWireModelId(modelString: string): string {
  try {
    return parseModelString(modelString).modelId;
  } catch {
    return modelString;
  }
}

export async function runChatLoop(opts: RunChatLoopOptions): Promise<string> {
  // Pillar 3 — make the model-backed Layer-3 classifier reachable at EVERY
  // trust boundary (MCP / sub-agent / channel / federation / skill /
  // compaction / chain / orchestrator). Boundary call sites don't thread an
  // `llmClassifier` through, so we register the runtime's classifier as the
  // process-wide default — gated on the same `llmClassifierEnabled` env switch
  // as the post-tool path. Set-or-clear on each entry keeps boundary behaviour
  // consistent with that gate; idempotent re-registration is a no-op.
  setDefaultBoundaryLlmClassifier(
    opts.promptInjectionLlmClassifier !== undefined && llmClassifierEnabled(process.env)
      ? opts.promptInjectionLlmClassifier
      : undefined,
  );
  // Section 17 — resolve the primary adapter via the model-router.
  // The router lazy-loads the matching provider package; an
  // Anthropic-only spec never pulls AWS / OpenAI / Gemini SDKs.
  // Section 17 — resolve the primary adapter via the model-router and
  // capture the *stripped* modelId (the form the provider expects, e.g.
  // `openai/gpt-4o-mini` → `gpt-4o-mini`). When the caller injects an
  // `_adapter`, still strip any provider prefix grammar (best-effort) so
  // trace events carry the same wire model id either way — but fall back
  // to `opts.model` verbatim for the synthetic ids tests typically pass
  // (`"test-model"`), which the stub adapter ignores.
  const primaryResolution = opts._adapter
    ? {
        adapter: opts._adapter,
        modelId: bestEffortWireModelId(opts.model),
        providerId: opts._adapter.providerId,
      }
    : await resolveModel(opts.model);
  // Section 27 / item 22 — resilience wrapping around the primary adapter.
  //   - `modelFallbacks` non-empty → a model-router failover chain: every
  //     candidate (primary first) breaker-wrapped with the `circuitBreaker`
  //     tuning; calls route to the first candidate whose breaker admits
  //     traffic; `model_failover` trace events surface routing changes.
  //   - `circuitBreaker` alone → the single-adapter breaker wrap.
  // The chain publishes through a LATE-BOUND bus getter: the run's real bus
  // is minted below (createRunContext), so `observabilityBus` is re-pointed
  // at it once it exists — a `crewhaus run` without a caller-supplied
  // runContext still surfaces model_failover + circuit_state_changed.
  const baseAdapter: ProviderAdapter = primaryResolution.adapter;
  let breakerWrap: WrappedAdapter | undefined;
  let failoverChain: FailoverChain | undefined;
  let observabilityBus: TraceEventBus | undefined = opts.runContext?.eventBus;
  const modelFallbacks = opts.modelFallbacks ?? [];
  let adapter: ProviderAdapter;
  if (modelFallbacks.length > 0) {
    // Seed the chain with the already-resolved primary (honours `_adapter`
    // injection and avoids a second resolveModel round-trip) plus any
    // test-injected fallback adapters.
    const injectedAdapters = new Map<string, ProviderAdapter>();
    injectedAdapters.set(opts.model, baseAdapter);
    for (const [modelString, injected] of opts._failoverAdapters ?? []) {
      injectedAdapters.set(modelString, injected);
    }
    failoverChain = await createFailoverChain({
      model: opts.model,
      fallbacks: modelFallbacks,
      ...(opts.circuitBreaker !== undefined ? { breaker: opts.circuitBreaker } : {}),
      getBus: () => observabilityBus,
      adapters: injectedAdapters,
    });
    // Doctor-style boot report: fallbacks that failed credential/package
    // resolution are listed once, loudly, on stderr — and stay in the chain
    // (they are re-tried when routing actually reaches them; see item 22).
    for (const warning of failoverChain.warnings()) {
      process.stderr.write(`[failover] ${warning}\n`);
    }
    adapter = failoverChain;
  } else if (opts.circuitBreaker !== undefined) {
    breakerWrap = wrapWithCircuitBreaker(baseAdapter, {
      ...opts.circuitBreaker,
      adapterName: baseAdapter.providerId,
      bus: opts.runContext?.eventBus,
    });
    adapter = breakerWrap;
  } else {
    adapter = baseAdapter;
  }
  void breakerWrap; // exposed via runtime stats once gateway/eval consumers land
  // `let` (item 27): a `budget: { on_exceed: degrade }` breach re-resolves
  // the primary model in place, so these become the degraded model's
  // identity. `degradedSpecModel` overrides `opts.model` as the specModel
  // stamped on model_request/response once a degrade has happened.
  let providerId: ProviderId = primaryResolution.providerId;
  let wireModelId: string = primaryResolution.modelId;
  let degradedSpecModel: string | undefined;
  // Section 17 — feature gate: a spec that declares tools cannot run on an
  // adapter that doesn't speak tool use (e.g. Bedrock Llama/Mistral
  // families). Fail with a clear ConfigError naming the model instead of
  // letting the provider 400 (or silently drop the tools) mid-run.
  if ((opts.tools ?? []).length > 0 && adapter.features.tool_use === false) {
    throw new ConfigError(
      `model "${opts.model}" (provider ${providerId}) does not support tool use — remove tools or pick a tool-capable model`,
    );
  }
  let compactionAdapter: ProviderAdapter;
  let compactionWireModelId: string;
  if (opts._compactionAdapter !== undefined) {
    compactionAdapter = opts._compactionAdapter;
    compactionWireModelId = opts.compactionModel ?? wireModelId;
  } else if (opts.compactionModel !== undefined) {
    const c = await resolveModel(opts.compactionModel);
    compactionAdapter = c.adapter;
    compactionWireModelId = c.modelId;
  } else {
    // Item 22 v1 scope note: with no explicit `compactionModel`, compaction
    // reuses the primary adapter — which IS the failover chain when
    // `modelFallbacks` is set, so compaction inherits the chain by
    // construction. An explicit `compactionModel` keeps its own single
    // adapter (no chain), as do judge/grader slots.
    compactionAdapter = adapter;
    compactionWireModelId = wireModelId;
  }

  // Item 26 — two-tier turn-difficulty router. When `modelTiers` is set, BOTH
  // tier adapters resolve HERE at boot (adapters bind once; the per-turn pick
  // just selects between the two already-resolved adapters — the same
  // discipline as compaction's second adapter and the failover chain's
  // multiple candidates). The `_tierAdapters` map is a test seam mirroring
  // `_failoverAdapters`.
  let tierRouter: TierRouter | undefined;
  if (opts.modelTiers !== undefined) {
    const resolveTier = async (modelString: string): Promise<ResolvedTier> => {
      const injected = opts._tierAdapters?.get(modelString);
      if (injected !== undefined) {
        return { adapter: injected, modelId: bestEffortWireModelId(modelString), modelString };
      }
      const r = await resolveModel(modelString);
      return { adapter: r.adapter, modelId: r.modelId, modelString };
    };
    const fast = await resolveTier(opts.modelTiers.fast);
    const dflt = await resolveTier(opts.modelTiers.default);
    tierRouter = createTierRouter({
      fast,
      default: dflt,
      ...(opts.modelTiers.routing !== undefined ? { config: opts.modelTiers.routing } : {}),
    });
  }
  // Item 26 — tool_use blocks the PREVIOUS turn produced (a tier-routing
  // signal). Persists across `runOneTurn` calls; 0 on the first turn.
  let priorTurnToolUseCount = 0;

  // Default model max OUTPUT tokens for one turn. Callers thread the spec's
  // `agent.max_tokens` here when set (the CLI target's codegen + apps/cli);
  // this fallback applies when the spec is silent. Kept comfortably above the
  // old 4096 floor so a single turn that writes a few files no longer truncates
  // mid-`tool_use` by default — every supported Claude model accepts >= 8192
  // output tokens. A truncation is no longer fatal regardless (see the
  // `max_tokens` recovery + `sanitizeOrphanToolUses`), but a higher ceiling
  // avoids the churn. Raise it per spec with `agent.max_tokens`.
  const maxTokens = opts.maxTokens ?? 8192;

  // Mutual exclusion: resume takes priority and replaces any seedMessages
  // in REPL mode (the resume payload becomes the seed). Section 12 carves
  // out an exception for singleTurn + resume: the seed is the NEW inbound
  // message, the resumed history is the prefix.
  if (opts.resume !== undefined && opts.seedMessages !== undefined && opts.singleTurn !== true) {
    throw new RuntimeError(
      "runChatLoop: `resume` and `seedMessages` are mutually exclusive in REPL mode — the resume payload becomes the seed",
    );
  }
  // Section 12: singleTurn + resume IS supported — used by the channel-bot
  // session-router for "resume the thread, append the inbound message, run
  // one turn". The seed must contain only the new turn's input (a single
  // user message); the replayed event-log history becomes the prefix and
  // is NOT re-logged.
  if (
    opts.runContext !== undefined &&
    opts.resume !== undefined &&
    opts.runContext.sessionId !== opts.resume.sessionId
  ) {
    throw new RuntimeError(
      "runChatLoop: opts.runContext.sessionId must match opts.resume.sessionId when both are supplied",
    );
  }

  // Persistence boot: session create/resume + event log open. Runs first
  // so the run context's sessionId — possibly carried over from a prior
  // run — is the one the rest of the loop logs against.
  const sessionRootDir = resolveSessionRootDir(opts.sessionRootDir);
  const sessionStore: SessionStore = createSessionStore({ rootDir: sessionRootDir });
  // Housekeeping side-effect: evicts any session whose mtime is older than
  // the TTL (default 30 days). The returned list is intentionally discarded.
  await sessionStore.list();

  let sessionId: string;
  let resumedMessages: Anthropic.MessageParam[] | undefined;
  if (opts.resume) {
    const existing = await sessionStore.get(opts.resume.sessionId);
    if (existing === null) {
      throw new RuntimeError(
        `cannot --resume "${opts.resume.sessionId}": session not found in ${sessionRootDir ?? ".crewhaus/sessions"}`,
      );
    }
    sessionId = existing.id;
    const replayLog = await openEventLog(sessionId, { rootDir: sessionRootDir });
    resumedMessages = await replayMessageHistory(replayLog);
    await replayLog.close();
  } else {
    // If the caller supplied a runContext, honour its sessionId (already
    // sess_<16 hex> by construction) so logs and the persisted file agree.
    // Otherwise, let session-store mint a fresh id.
    const created = await sessionStore.create({
      id: opts.runContext?.sessionId,
      name: opts.sessionName ?? "(unnamed)",
      target: opts.sessionTarget ?? "cli",
      model: opts.model,
    });
    sessionId = created.id;
  }

  // Use the supplied runContext as-is when it agrees with the resolved
  // sessionId; otherwise build a fresh context bound to that sessionId.
  // Tests that pass their own runContext rely on observing turnNumber on
  // it after the loop returns, so we never silently swap it out.
  const runContext: RunContext = opts.runContext ?? createRunContext({ sessionId });

  // Section 15 — every observability subscriber (otel, metrics, printer)
  // hangs off this single bus. The default constructor in `createRunContext`
  // mints a no-subscriber bus; here we attach the env-gated set so a fresh
  // run with `OTEL_EXPORTER_OTLP_ENDPOINT` set automatically exports.
  const bus: TraceEventBus = runContext.eventBus;
  void TraceEventBus; // keep type import alive for future direct constructions
  // Item 22 — re-point the failover chain's late-bound bus getter at the
  // run's real bus (see the chain construction above): the chain and its
  // per-candidate breakers publish model_failover / circuit_state_changed
  // through this reference from the first stream() call onward.
  observabilityBus = bus;
  const subscribers = await attachDefaultSubscribers(bus, runContext, process.env, {
    ...(opts.alertSink !== undefined ? { alertSink: opts.alertSink } : {}),
    ...(opts.alertMetricsDir !== undefined ? { metricsDir: opts.alertMetricsDir } : {}),
    ...(opts.sloTargets !== undefined ? { sloTargets: opts.sloTargets } : {}),
    ...(opts.sloSink !== undefined ? { sloSink: opts.sloSink } : {}),
  });

  // Ops item 32 — auto-assemble an incident bundle on the first failure-class
  // trigger (circuit → open, egress-blocked, justification-deny storm). Gated
  // by CREWHAUS_INCIDENTS; writes a raw capture (ring buffer + trigger meta)
  // that `crewhaus incident collect --session <id>` turns into a full bundle.
  const incidentCollector = attachIncidentCollector(bus, runContext, process.env, {
    ...(opts.incidentsDir !== undefined ? { incidentsDir: opts.incidentsDir } : {}),
    ...(opts.incidentSpec !== undefined ? { spec: opts.incidentSpec } : {}),
  });

  // Item 22 — surface each failover on stderr so an operator watching a
  // plain (non-CREWHAUS_TRACE) run still sees provider switches. NOTE: the
  // advisor-events session-log subscriber pattern has NOT landed on main
  // (packages/event-log has no advisor kind) — when it does, failovers
  // should ALSO persist into the session JSONL through it; until then the
  // trace event + this stderr note are the observable surfaces.
  let failoverNoteUnsubscribe: Unsubscribe | undefined;
  if (failoverChain !== undefined) {
    failoverNoteUnsubscribe = bus.subscribe((event): void => {
      if (event.kind !== "model_failover") return;
      process.stderr.write(`[failover] ${event.from} → ${event.to} (${event.reason})\n`);
    });
  }

  // Item 27 — run-level spend cap. An ALWAYS-ON cost meter (independent of
  // the CREWHAUS_COST_TRACKING env flag) accrues per-response spend priced
  // off the wire model that actually served — `suppressEvents` keeps it off
  // the trace surface so it never double-prints beside an env-attached
  // cost-tracker. The pre-turn check (`enforceBudget`, below) reads
  // `budgetMeter.getRunCost(runId).totalUsdMicros`. `budgetDegraded` gates
  // the ladder to a single rung: once we degrade, we never degrade again —
  // a second breach stops the run.
  const budgetMeter =
    opts.budget !== undefined ? createCostTracker(bus, { suppressEvents: true }) : undefined;
  let budgetDegraded = false;

  /**
   * Item 27 — pre-turn budget gate. Returns "stop" when the run must end
   * before the next turn opens; "continue" otherwise. On a `degrade` breach
   * it re-resolves the primary model to the cheaper rung IN PLACE (mutating
   * `adapter`, `providerId`, `wireModelId`) and emits a `model_failover`
   * (reason `budget_degrade`) — so the very next model call, and all cost
   * accrual after it, use the degraded model. The current turn always
   * completes; this only gates the NEXT turn, so an in-flight tool loop is
   * never severed. Never throws — a re-resolution failure logs and stops.
   */
  const enforceBudget = async (): Promise<"continue" | "stop"> => {
    if (opts.budget === undefined || budgetMeter === undefined) return "continue";
    const spent = budgetMeter.getRunCost(bus.runId).totalUsdMicros;
    if (spent < opts.budget.usdMicros) return "continue";
    const spentUsd = (spent / 1_000_000).toFixed(4);
    const capUsd = (opts.budget.usdMicros / 1_000_000).toFixed(4);
    if (opts.budget.onExceed.kind === "stop" || budgetDegraded) {
      const why = budgetDegraded ? "degraded model also reached the cap" : "run budget reached";
      process.stderr.write(
        `[budget] $${spentUsd} spent ≥ $${capUsd} cap — ${why}; ending the run.\n`,
      );
      return "stop";
    }
    // degrade: re-resolve the primary model to the cheaper rung, once.
    const target = opts.budget.onExceed.model;
    try {
      const degraded =
        opts._budgetDegradeAdapter !== undefined
          ? {
              adapter: opts._budgetDegradeAdapter,
              modelId: bestEffortWireModelId(target),
              providerId: opts._budgetDegradeAdapter.providerId,
            }
          : await resolveModel(target);
      const from = opts.model;
      adapter =
        opts.circuitBreaker !== undefined
          ? wrapWithCircuitBreaker(degraded.adapter, {
              ...opts.circuitBreaker,
              adapterName: degraded.adapter.providerId,
              bus,
            })
          : degraded.adapter;
      // The degraded model is now the serving one; keep the trace/pricing
      // identity coherent for the model_request/response events below.
      providerId = degraded.providerId;
      wireModelId = degraded.modelId;
      degradedSpecModel = target;
      // A degrade takes over from the failover chain: subsequent calls hit
      // the degraded adapter directly (v1 keeps one rung, no re-entry to the
      // chain). Null it so the request/response stamping stops consulting it.
      failoverChain = undefined;
      budgetDegraded = true;
      bus.publish({
        ...bus.envelope(),
        kind: "model_failover",
        from,
        to: target,
        reason: "budget_degrade",
      });
      process.stderr.write(
        `[budget] $${spentUsd} spent ≥ $${capUsd} cap — degrading ${from} → ${target}.\n`,
      );
      return "continue";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[budget] $${spentUsd} spent ≥ $${capUsd} cap — degrade to "${target}" failed (${message}); ending the run.\n`,
      );
      return "stop";
    }
  };

  // Working-indicator spinner. Auto-enables only for an interactive REPL on a
  // TTY (see `isSpinnerEnabled`); `singleTurn`/injected-`input`/piped runs stay
  // byte-identical to before. `out.write` is the spinner-aware stdout sink:
  // every interactive write that can land while the animation is live goes
  // through it so the two never collide. `opts.spinner` overrides the auto
  // decision.
  const spinnerEnabled =
    opts.spinner ?? (opts.singleTurn !== true && opts.input === undefined && isSpinnerEnabled());
  const out: CliOutput = createCliOutput({ enabled: spinnerEnabled });

  // M2.1 — CLI markdown renderer (env-gated). When CREWHAUS_CLI_MARKDOWN=1,
  // text-delta chunks flow through a streaming markdown → ANSI transform so
  // the user sees rendered bold/italic/headers/lists/code-fences instead of
  // raw asterisks. The renderer is line-buffered; chunks accumulate until a
  // `\n` arrives, then the rendered line writes to stdout. `end()` is
  // called after the per-turn `\n` to flush any tail content. Its sink is the
  // spinner-aware writer so a flushed line erases any live animation first.
  const mdRenderer: StreamRenderer | undefined = isCliMarkdownEnabled()
    ? createCliMarkdownRenderer({ write: (s) => out.write(s) })
    : undefined;
  const writeText = (chunk: string): void => {
    // First real assistant text ends the "thinking" wait; clear the spinner
    // (idempotent on later chunks) before the answer streams.
    out.spinner.stop();
    if (mdRenderer) mdRenderer.push(chunk);
    else out.write(chunk);
  };
  const endTurn = (): void => {
    // Covers the no-text/no-tool case where the spinner is still up.
    out.spinner.stop();
    if (mdRenderer) mdRenderer.end();
    out.write("\n");
  };

  const eventLog: EventLog = await openEventLog(sessionId, { rootDir: sessionRootDir });

  // Section 27 — mirror per-call cost_accrual events from the trace bus into
  // the session JSONL so `crewhaus cost-summary --session <id>` can sum spend
  // after the run. Gated on the same switch that attaches the cost-tracker
  // (CREWHAUS_COST_TRACKING): no tracker → no accruals to persist, and the
  // message-only transcript stays unchanged by default. Per-call accruals only
  // — skip the FR-003 terminal `summary` aggregate so a run total never
  // double-counts. `append()` writes synchronously, and a persist failure must
  // never abort a turn, so the result is logged rather than thrown.
  let costPersistUnsubscribe: Unsubscribe | undefined;
  if (subscribers.costTracker !== undefined) {
    costPersistUnsubscribe = bus.subscribe((event): void => {
      if (event.kind !== "cost_accrual") return;
      const ev = event as CostAccrualEvent;
      if (ev.summary === true) return;
      void eventLog
        .append({
          kind: "cost_accrual",
          payload: {
            provider: ev.provider,
            modelId: ev.modelId,
            ...(ev.specModel !== undefined ? { specModel: ev.specModel } : {}),
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            cachedReadTokens: ev.cachedReadTokens,
            // Optional on the event (older emitters may omit it) — persist
            // only when present so old-log parsing stays additive-safe.
            ...(ev.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: ev.cacheCreationTokens }
              : {}),
            costUsdMicros: ev.costUsdMicros,
            ...(ev.tenantId !== undefined ? { tenantId: ev.tenantId } : {}),
          },
        })
        .catch((err) => {
          runContext.logger.error("cost_accrual.persist_failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }

  // Advisor groundwork (item 14) — persist the trace-bus-only advisory
  // signals (recovery actions, per-call tool stats, resolved permission
  // decisions, model stop reasons) into the same session JSONL the
  // transcript already writes to, so `crewhaus advise` can mine sessions
  // offline. DEFAULT-ON (the lines are tiny and they are the advisor's
  // food); disable with CREWHAUS_ADVISOR_EVENTS=0. See observability.ts.
  const advisorPersist = attachAdvisorPersistence(bus, eventLog, runContext);

  // Ops item 38 — persist the trace-bus-only `mcp_call_end` events into the
  // session JSONL as the durable `mcp_stats` kind so `crewhaus mcp doctor` can
  // score per-server MCP health offline. Shares the advisor's DEFAULT-ON gate
  // (CREWHAUS_ADVISOR_EVENTS=0 disables both). See observability.ts.
  const mcpStatsPersist = attachMcpStatsPersistence(bus, eventLog, runContext);

  // Per-run state container — coordination surface for hooks/skills/tools
  // landing in Section 11+. Section 10 only ships the plumbing; the
  // underscore prefix marks the intentional non-consumer.
  const _runState: Store<Record<string, unknown>> = createStore({});
  void _runState;

  // Section 13 — RuntimeBridge. Built once per run, handed to every
  // tool execution through the executor's ExecutionContext. Framework-
  // aware tools (only `Task` today) cast `ctx.bridge` to RuntimeBridge.
  // Built lazily inside executeOneToolUse so it captures the latest
  // permission-mode/-rules and tool list — the values themselves are
  // stable for the run, but the closure keeps the call-site at the
  // tool-execute boundary tidy.

  // Tight helper so call sites stay one line. Errors propagate so an I/O
  // failure on the audit trail surfaces rather than silently dropping.
  async function logEvent(kind: EventKind, payload: unknown): Promise<void> {
    await eventLog.append({ kind, payload });
  }

  // Section 11 — fire matching hooks for `event` and aggregate the result.
  // No-ops when no hooks are configured. The aggregated decision exposes
  // `allowed` / `reason` / `mutate`; v1 callers honour `mutate` only for
  // `pre-slash` (the `expanded` field). Errors are caught and surfaced as
  // a deny so a misbehaving hook implementation does not crash the run.
  const hooks = opts.hooks ?? [];
  async function fireHook(
    event: HookEvent,
    payload: unknown,
  ): Promise<{ allowed: boolean; reason?: string; mutate?: Record<string, unknown> }> {
    if (hooks.length === 0) return { allowed: true };
    try {
      const results = await runHooks(event, payload, hooks, {
        logger: runContext.logger,
        eventBus: bus,
      });
      return aggregateDecisions(results);
    } catch (err) {
      runContext.logger.warn("hook firing failed", {
        event,
        error: (err as Error).message,
      });
      return { allowed: true };
    }
  }

  // Feature #53 — auto-capture at teardown. Runs in the same finally where the
  // `stop` hook fires, but is NOT a credential-stripped hook: the caller-
  // supplied `onCapture` (which writes to the memory-store from the CLI's full
  // environment) needs the process env, exactly like the feedback teardown.
  // Best-effort — a capture failure never turns a clean exit into an error.
  const maybeAutoCapture = async (): Promise<void> => {
    if (opts.memory?.autoCapture !== true || opts.memory.onCapture === undefined) return;
    try {
      await opts.memory.onCapture(runContext.turnNumber, sessionId);
    } catch (err) {
      runContext.logger.warn("memory auto-capture failed", { error: (err as Error).message });
    }
  };

  // Section 11 — `session-start` fires once after the persistence + run
  // context boot is complete. Observational only (no deny/block effect).
  await fireHook("session-start", {
    sessionId,
    model: opts.model,
    target: opts.sessionTarget ?? "cli",
    resumed: opts.resume !== undefined,
  });

  const contextLimit = opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const compactionThreshold = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const snipKeepHead = opts.snipKeepHead ?? DEFAULT_SNIP_KEEP_HEAD;
  const snipKeepTail = opts.snipKeepTail ?? DEFAULT_SNIP_KEEP_TAIL;
  const permissionMode: PermissionMode = opts.permissionMode ?? "default";
  const permissionRules: RuleSet = opts.permissionRules ?? {
    ...emptyRuleSet,
    builtin: BUILTIN_DEFAULT_RULES,
  };

  const userInstructions: Anthropic.TextBlockParam = {
    type: "text",
    text: opts.instructions,
    cache_control: { type: "ephemeral" },
  };
  // Section 11 — append a "Available skills:" block to the system prompt
  // when skills are configured. The block lists names + descriptions only;
  // the model reaches each skill's body by calling the `Skill` tool (which
  // the caller is responsible for adding to the tools array).
  const skills = opts.skills ?? [];
  const skillsText = skills.length > 0 ? formatSkillsForPrompt(skills) : "";
  const skillsBlock: Anthropic.TextBlockParam[] =
    skillsText.length > 0
      ? [{ type: "text", text: skillsText, cache_control: { type: "ephemeral" } }]
      : [];
  // M3.1 — auto-load project memory files (AGENTS.md / CLAUDE.md /
  // CODE-COMPANION.md / AGENT.md) from cwd at session start. Follows the
  // vendor-neutral agents.md convention; compatible with Claude Code's
  // CLAUDE.md auto-load behaviour. Pillar 3 compliance: each file's content
  // is classified via boundary-classifier with origin "user" inside
  // loadProjectMemory() (the user's repo is developer-trusted).
  const projectMemory = await loadProjectMemory(
    opts.preferenceFiles !== undefined && opts.preferenceFiles.length > 0
      ? { extraFiles: opts.preferenceFiles }
      : {},
  );
  const projectMemoryBlock: Anthropic.TextBlockParam[] =
    projectMemory.prompt.length > 0
      ? [
          {
            type: "text",
            text: projectMemory.prompt,
            cache_control: { type: "ephemeral" },
          },
        ]
      : [];
  if (projectMemory.files.length > 0) {
    process.stdout.write(
      `[memory] loaded ${projectMemory.files.length} project memory file(s): ${projectMemory.files
        .map((f) => f.filename)
        .join(", ")}\n`,
    );
  }
  // Feature #53 — auto-recall: at session start, pull the top-K relevant
  // cross-session memories and inject them as a system block, mirroring the
  // project-memory auto-load above. The caller supplies the `recall` seam
  // (runtime-core stays independent of memory-store). Best-effort: a recall
  // failure never aborts the run.
  let memoryRecallBlock: Anthropic.TextBlockParam[] = [];
  if (opts.memory?.autoRecall === true && opts.memory.recall !== undefined) {
    try {
      const seed = opts.memory.recallSeed ?? opts.instructions;
      const k = opts.memory.recallK ?? 5;
      const lines = await opts.memory.recall(seed, k);
      if (lines.length > 0) {
        // Pillar 3 — a recalled memory can embed content shaped by untrusted
        // tool output from an earlier session, so it is NOT verbatim-safe like
        // the developer's own repo files. Two defenses, mirroring how the rest
        // of the security fabric treats injected content:
        //   1. Delimiter safety — neutralize any `</recalled_memory>` closing
        //      tag inside a recalled line so a poisoned memory can't break out
        //      of its block and inject trailing instructions.
        //   2. Classification — run the assembled block through the SAME
        //      `classifyBoundary(text, { origin: "user" })` best-effort path
        //      `loadProjectMemory()` uses (pass policy: classify + emit trace
        //      events without mutating), so recalled content flows through the
        //      boundary classifier exactly like every other prompt-bound source.
        const body = lines
          .map((l) => `- ${escapeBoundaryDelimiter(l, "recalled_memory")}`)
          .join("\n");
        const text = `<recalled_memory>\nRelevant facts remembered from earlier sessions:\n${body}\n</recalled_memory>`;
        await classifyBoundary(text, { origin: "user" }).catch(() => undefined);
        memoryRecallBlock = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
        process.stdout.write(`[memory] recalled ${lines.length} memory(ies) into the prompt\n`);
      }
    } catch (err) {
      runContext.logger.warn("memory auto-recall failed", { error: (err as Error).message });
    }
  }
  // Section 17 — runtime-core no longer prepends the Claude Code OAuth
  // prefix; `adapter-anthropic` handles that internally so each adapter
  // owns its provider-specific auth-shape requirements.
  let systemBlocks: Anthropic.TextBlockParam[] = [
    userInstructions,
    ...projectMemoryBlock,
    ...memoryRecallBlock,
    ...skillsBlock,
  ];

  // Section 27 — rotate cache markers on the system block array if the
  // last refresh is older than the rotation interval. Skips automatically
  // when the adapter doesn't support explicit caching (OpenAI / Bedrock
  // Llama / Mistral). This keeps long-running CHN/MGD/RES daemons under
  // Anthropic's 30-day TTL.
  if (adapter.features.caching === "explicit") {
    const cacheManaged = manageCacheMarkers(
      systemBlocks.map((b) => ({
        type: "text" as const,
        text: b.text,
        ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
      })),
      {
        features: adapter.features,
        ...(opts.promptCacheLastRotatedAt !== undefined
          ? { lastRotatedAt: opts.promptCacheLastRotatedAt }
          : {}),
      },
    );
    if (cacheManaged.rotated) {
      systemBlocks = cacheManaged.blocks.map((b) => ({
        type: "text",
        text: b.text,
        ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
      })) as Anthropic.TextBlockParam[];
    }
  }

  const tools = opts.tools ?? [];
  const anthropicTools: Anthropic.Tool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: (t.jsonSchema ??
            zodToJsonSchema(t.inputSchema, {
              $refStrategy: "none",
            })) as Anthropic.Tool.InputSchema,
        }))
      : undefined;
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // Root abort tree for the whole run; each turn gets a child.
  const runAbort = createAbortTree(runContext.abortSignal);
  // Per-turn abort tree, replaced at the start of each turn so a SIGINT
  // during turn N doesn't leave turn N+1 born-aborted.
  let turnAbort: AbortTree = runAbort.child();
  // Latest error captured from a model call, fed to recover() on entry to NeedRecovery.
  let lastErrorForRecovery: unknown = undefined;

  // Permission-ask prompter. Set in REPL mode after the readline interface
  // exists; remains undefined in single-turn mode (where ask collapses to deny).
  // The initial assignment makes the second assignment legal under biome's
  // `useConst` rule (which fires on exactly-one-assignment lets).
  let askApproval: ((toolName: string, input: unknown) => Promise<boolean>) | undefined = undefined;

  // Per-run state for tool-loop detection and warning de-dup. Both span
  // turns within a single `runChatLoop` invocation so cross-turn loops
  // (e.g. "keep running date") get caught and warned at most once per
  // signature.
  const toolUseHistory: TsmToolUseBlock[] = [];
  const warnedLoopSignatures = new Set<string>();

  // Working-indicator bookkeeping for tool execution. A single shared spinner
  // serves the whole loop, so the set tracks which tools are mid-flight to
  // support the concurrent (read-only) partition: the label reflects how many
  // run at once, and the animation only stops when the last one settles.
  const activeToolNames: string[] = [];
  const toolSpinnerLabel = (): string =>
    activeToolNames.length === 1
      ? `running ${activeToolNames[0]}`
      : `running ${activeToolNames.length} tools`;
  const beginToolWork = (name: string): void => {
    activeToolNames.push(name);
    out.spinner.start(toolSpinnerLabel());
  };
  const endToolWork = (name: string): void => {
    const i = activeToolNames.indexOf(name);
    if (i >= 0) activeToolNames.splice(i, 1);
    if (activeToolNames.length === 0) out.spinner.stop();
    else out.spinner.setLabel(toolSpinnerLabel());
  };

  /**
   * Execute one tool_use block end-to-end: permission gate → executeTool
   * with the per-tool abort signal → wrap large output through
   * `tool-result-store`. Returns a fully-formed `ToolResultBlockParam`
   * suitable for appending to message history.
   *
   * Used by both the partitioned (post-stream) path and the streaming
   * path so the permission/abort/store contract is uniform.
   */
  async function executeOneToolUse(tu: TsmToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    // End the "thinking" wait — but only when no tool is already mid-flight.
    // The streaming executor dispatches concurrency-safe tools with overlap, so
    // an unconditional stop here would tear down a sibling tool's live spinner;
    // gate on the ref-count so we stop the thinking animation (none running)
    // without disturbing a running-tools one. The header then goes through the
    // spinner-aware sink, which erases+redraws around it so the persistent
    // `[tool: …]` line sits cleanly above any animation that follows.
    if (activeToolNames.length === 0) out.spinner.stop();
    out.write(`[tool: ${tu.name}]\n`);
    await logEvent("tool_use", { id: tu.id, name: tu.name, input: tu.input });
    const inputBytes = Buffer.byteLength(JSON.stringify(tu.input ?? null), "utf8");
    const toolStartEnvelope = bus.envelope();
    bus.publish({
      ...toolStartEnvelope,
      kind: "tool_call_start",
      toolUseId: tu.id,
      toolName: tu.name,
      inputBytes,
    });
    const t0Tool = performance.now();
    const tool = toolByName.get(tu.name);
    const finish = async (
      result: Anthropic.ToolResultBlockParam,
    ): Promise<Anthropic.ToolResultBlockParam> => {
      await logEvent("tool_result", {
        toolUseId: tu.id,
        content:
          typeof result.content === "string"
            ? result.content
            : summariseNonStringContent(
                result.content as Exclude<
                  Anthropic.ToolResultBlockParam["content"],
                  string | undefined
                >,
              ),
        isError: result.is_error === true,
      });
      const outputContent = result.content;
      const outputBytes =
        typeof outputContent === "string"
          ? Buffer.byteLength(outputContent, "utf8")
          : Buffer.byteLength(JSON.stringify(outputContent ?? null), "utf8");
      bus.publish({
        ...bus.envelope(),
        spanId: toolStartEnvelope.spanId,
        kind: "tool_call_end",
        toolUseId: tu.id,
        toolName: tu.name,
        isError: result.is_error === true,
        outputBytes,
        durationMs: performance.now() - t0Tool,
      });
      // Section 11 — fire post-tool after the result is captured. Decision
      // is observational here: a deny on post-tool logs a warning but does
      // not rewrite the result (the model has already received it once on
      // the prior turn in some streaming scenarios).
      const post = await fireHook("post-tool", {
        id: tu.id,
        name: tu.name,
        isError: result.is_error === true,
      });
      if (!post.allowed) {
        runContext.logger.warn("post-tool hook denied", {
          tool: tu.name,
          reason: post.reason,
        });
      }
      return result;
    };
    if (!tool) {
      return finish({
        type: "tool_result",
        tool_use_id: tu.id,
        content: `unknown tool "${tu.name}"`,
        is_error: true,
      });
    }

    // Section 11 — pre-tool hook: short-circuit with the hook's reason
    // when any matching hook returns deny/block.
    const preHook = await fireHook("pre-tool", { id: tu.id, name: tu.name, input: tu.input });
    if (!preHook.allowed) {
      return finish({
        type: "tool_result",
        tool_use_id: tu.id,
        content: `[blocked by hook] ${preHook.reason ?? "denied"}`,
        is_error: true,
      });
    }

    const decisionDetails = evaluateWithReason(
      {
        toolName: tu.name,
        input: tu.input,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        requiresSandbox: tool.requiresSandbox,
      },
      permissionMode,
      permissionRules,
      { sandboxAvailable: opts.sandboxAvailable === true },
    );
    const decision = decisionDetails.decision;
    bus.publish({
      ...bus.envelope(),
      kind: "permission_decision",
      toolName: tu.name,
      decision,
      mode: permissionMode,
      ...(decisionDetails.reason !== undefined ? { reason: decisionDetails.reason } : {}),
    });
    let approved = decision === "allow";
    let denialMessage: string | undefined;
    if (decision === "deny") {
      denialMessage = decisionDetails.reason ?? "tool denied by permission policy";
    } else if (decision === "ask") {
      if (askApproval !== undefined) {
        approved = await askApproval(tu.name, tu.input);
        if (!approved) denialMessage = "tool denied by user";
      } else {
        denialMessage =
          `tool denied: \`${tu.name}\` defaulted to "ask" and single-turn mode has no interactive surface to prompt on. ` +
          `Add an explicit rule to permissions.rules in your spec, e.g. \`{ type: alwaysAllow, pattern: ${tu.name} }\`, or run in REPL mode where "ask" can prompt.`;
      }
      // Advisor groundwork (item 14) — event the ask RESOLUTION. The publish
      // above fired BEFORE the approval prompt (decision "ask", no outcome);
      // this one fires after `askApproval` resolves — or after the
      // single-turn fallback collapses the ask to a deny — so offline advice
      // mining can measure how each tool's prompts are actually answered.
      // The advisor persistence subscriber (observability.ts) keys on
      // `askOutcome` to persist exactly this resolved form.
      bus.publish({
        ...bus.envelope(),
        kind: "permission_decision",
        toolName: tu.name,
        decision: "ask",
        mode: permissionMode,
        askOutcome: approved ? "approved" : "denied",
      });
    }
    if (!approved) {
      return finish({
        type: "tool_result",
        tool_use_id: tu.id,
        content: denialMessage ?? "tool denied",
        is_error: true,
      });
    }

    // Pillar 3 intent gate — when the tool descriptor demands a justification,
    // require the model to include one in the input and evaluate it via the
    // configured judge (rule-based by default; runtime callers can pass an
    // LLM-backed judge for production). The justification is captured to
    // audit-log verbatim. The session goal we compare against is the spec's
    // `instructions` field — fixed at compile time, not influenced by runtime
    // input, so an attacker who controls the user prompt cannot also
    // re-define the goal under which their justification gets scored.
    if (tool.requireJustification === true) {
      const input = tu.input as Record<string, unknown> | undefined;
      const rawJustification = input?.["justification"];
      const justification = typeof rawJustification === "string" ? rawJustification : "";
      const judge = opts.justificationJudge ?? ruleBasedJustificationJudge;
      const verdict = await evaluateJustification(
        {
          toolName: tu.name,
          justification,
          sessionGoal: opts.instructions ?? "",
          input: tu.input,
        },
        judge,
      );
      bus.publish({
        ...bus.envelope(),
        kind: "permission_decision",
        toolName: tu.name,
        decision: verdict.allow ? "allow" : "deny",
        mode: permissionMode,
        reason: `justification: ${verdict.reason} [judge=${verdict.judgeModel}]`,
        // FR-004 — promote the judge identity (and confidence) to
        // first-class fields on the canonical permission_decision event so
        // the `permission_justification_evaluated` audit story records WHO
        // judged, not just an embedded substring of `reason`. Absent on
        // ordinary (non-justification) permission decisions.
        judgeModel: verdict.judgeModel,
        ...(verdict.confidence !== undefined
          ? { justificationConfidence: verdict.confidence }
          : {}),
      });
      runContext.logger.info("justification evaluated", {
        toolUseId: tu.id,
        toolName: tu.name,
        allow: verdict.allow,
        judgeModel: verdict.judgeModel,
        confidence: verdict.confidence,
      });
      // FR-004 — emit the durable `permission_justification_evaluated` audit
      // record. The trace event above is ephemeral; THIS is the hash-chained,
      // tamper-evident artifact the AuditKind was created for. We append one
      // record per justification-evaluated call (allow OR deny — the audit
      // trail must capture denials too), storing the justification VERBATIM
      // alongside the verdict and the judge identity, exactly the payload
      // shape `@crewhaus/audit-log` documents for this kind. Best-effort but
      // surfaced: an I/O failure on the audit trail is logged and swallowed so
      // a full audit disk does not crash a governed run, mirroring how the
      // egress fabric treats its own audit surface. Absent sink → no-op.
      if (opts.justificationAuditSink !== undefined) {
        try {
          await opts.justificationAuditSink.append({
            kind: "permission_justification_evaluated",
            payload: {
              toolName: tu.name,
              justification,
              verdict: verdict.allow ? "allow" : "deny",
              reason: verdict.reason,
              judgeModel: verdict.judgeModel,
              ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
            },
          });
        } catch (err) {
          runContext.logger.warn("justification audit append failed", {
            toolUseId: tu.id,
            toolName: tu.name,
            error: (err as Error).message,
          });
        }
      }
      if (!verdict.allow) {
        return finish({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `[justification denied] ${verdict.reason}. Reformulate the call with a justification that ties to the session's declared goal, or omit this tool from the call.`,
          is_error: true,
        });
      }
    }

    // Pillar 3 sink-side fabric — for tools that transmit to an external
    // sink, scan the input payload against the run-context's data-lineage
    // map. A `block` verdict means the payload contains content that was
    // tagged from a non-`"user"` origin and policy disallows transmission;
    // we deny the call before it fires. `warn` logs but proceeds.
    //
    // Resolve the sink-scope so the egress block tier is actually reachable
    // (#144): runtime-joined MCP sinks default to `"external-dynamic"` (block
    // non-user-origin content), while spec-declared sinks stay
    // `"external-configured"` (warn). Callers can override via
    // `opts.resolveSinkScope` to mark federation-joined or other dynamic sinks.
    if (tool.scope === "external") {
      const payload = JSON.stringify(tu.input ?? null);
      const sinkScope = (opts.resolveSinkScope ?? defaultSinkScope)(tu.name);
      const egress = await classifyEgress(payload, runContext, {
        sinkId: tu.name,
        sinkScope,
        // FR-006: forward the caller-selected matcher when present. Absent
        // (every existing caller) → classifyEgress defaults to the
        // substring matcher, so the scope gate / sinkScope / policy fold
        // below are byte-for-byte unchanged.
        ...(opts.egressMatcher !== undefined ? { matcher: opts.egressMatcher } : {}),
      });
      const egressOutcome =
        egress.verdict === "pass"
          ? "egress-passed"
          : egress.verdict === "warn"
            ? "egress-warned"
            : "egress-blocked";
      bus.publish({
        ...bus.envelope(),
        kind: "permission_decision",
        toolName: tu.name,
        decision: egress.verdict === "block" ? "deny" : "allow",
        mode: permissionMode,
        outcome: egressOutcome,
        ...(egress.originsFound.length > 0 ? { reason: `egress: ${summarizeEgress(egress)}` } : {}),
      });
      if (egress.verdict !== "pass") {
        runContext.logger.warn("egress classification non-clean", {
          toolUseId: tu.id,
          toolName: tu.name,
          verdict: egress.verdict satisfies EgressVerdict,
          originsFound: egress.originsFound,
          matchCount: egress.matchCount,
        });
        // Item 20 — emit the durable `egress_decision` audit record for every
        // non-pass verdict so egress history is triageable offline (the
        // trace-bus event above is ephemeral). Only the lineage SUMMARY is
        // stored — never the raw outbound payload (which is sensitive and
        // often carries the very tagged content that tripped the classifier),
        // matching the payload shape `@crewhaus/audit-log` documents for this
        // kind. Best-effort but surfaced: an I/O failure on the audit trail is
        // logged and swallowed so a full audit disk does not crash a governed
        // run, mirroring the justification sink above. Absent sink → no-op.
        if (opts.egressAuditSink !== undefined) {
          try {
            await opts.egressAuditSink.append({
              kind: "egress_decision",
              payload: {
                sinkId: egress.sinkId,
                sinkScope: egress.sinkScope,
                verdict: egress.verdict,
                originsFound: egress.originsFound,
                matchCount: egress.matchCount,
              },
            });
          } catch (err) {
            runContext.logger.warn("egress audit append failed", {
              toolUseId: tu.id,
              toolName: tu.name,
              error: (err as Error).message,
            });
          }
        }
      }
      if (egress.verdict === "block") {
        return finish({
          type: "tool_result",
          tool_use_id: tu.id,
          content:
            "[egress denied] outbound payload contains content tagged from a non-user origin under a strict-policy sink. " +
            "Inspect the prior tool/sub-agent results that fed this call's input; the egress classifier's `dataLineage` records which boundary site introduced the flagged substring.",
          is_error: true,
        });
      }
    }

    const toolAbort = turnAbort.child();
    // Build the bridge for this call. Built on EVERY run (#160 follow-up):
    // it carries `runContext`, which Pillar-3 boundary-site tools (tool-mcp,
    // skills-registry) read to tag their external content's provenance under
    // the precise "mcp"/"skill" origin. Previously the bridge was skipped
    // unless `spawnSubAgent`/`crewMailbox` was injected, so a plain top-level
    // run gave those tools no RunContext and their content fell back to the
    // coarse "tool" origin. The Task-tool-only fields (`spawnSubAgent`,
    // `crewMailbox`, `subAgents`) stay conditional — they're omitted when not
    // wired, and the Task tool already checks for undefined before using them.
    const bridge: RuntimeBridge = {
      runContext,
      eventLog,
      permissionMode,
      permissionRules,
      tools,
      model: opts.model,
      maxTokens,
      ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
      hooks,
      ...(opts.subAgents !== undefined ? { subAgents: opts.subAgents } : {}),
      ...(opts.spawnSubAgent !== undefined ? { spawnSubAgent: opts.spawnSubAgent } : {}),
      ...(opts.crewMailbox !== undefined ? { crewMailbox: opts.crewMailbox } : {}),
    };
    // Spin "running <tool>…" for exactly the execution window — started after
    // every gate (permission/justification/egress) so it never overlaps the
    // approval prompt, and torn down in `.finally` on success or throw.
    beginToolWork(tu.name);
    const raw = await executeTool(tool, tu.input, {
      toolUseId: tu.id,
      signal: toolAbort.signal,
      // #160 follow-up — the bridge (built on every run, above) carries
      // `runContext`, which boundary-site tools (tool-mcp, skills-registry)
      // read to tag their external content under the precise "mcp"/"skill"
      // origin. `tool-executor` forwards `bridge` verbatim; those tools read
      // `ctx.runContext` first and fall back to `ctx.bridge.runContext`, so
      // the bridge is what activates the precise tag today. (Threading
      // `runContext` as a first-class field on this call would also require
      // adding it to `tool-executor`'s `ExecutionContext`, which is owned
      // elsewhere; the bridge path needs no such change.)
      bridge,
      // Section 18 — runtime-core wires this so streaming tools
      // (`tool-code-execution`) can publish `tool_stream_chunk` events as
      // they pipe stdout/stderr from the sandbox container.
      onStreamChunk: (stream, chunk) => {
        bus.publish(
          {
            ...bus.envelope(),
            spanId: toolStartEnvelope.spanId,
            kind: "tool_stream_chunk",
            toolUseId: tu.id,
            toolName: tu.name,
            stream,
            bytes: Buffer.byteLength(chunk, "utf8"),
          },
          { ephemeral: true },
        );
      },
    }).finally(() => endToolWork(tu.name));
    const toolResultRoot = resolveToolResultRoot();
    const stored = await storeAndPreview(
      { toolUseId: raw.toolUseId, content: raw.content, isError: raw.isError },
      {
        runId: runContext.runId,
        toolUseId: tu.id,
        ...(toolResultRoot !== undefined ? { rootDir: toolResultRoot } : {}),
      },
    );
    if (stored.persisted) {
      runContext.logger.info("tool result persisted", {
        toolUseId: tu.id,
        toolName: tu.name,
        fullPath: stored.fullPath,
      });
    }
    // Section 18 — post-tool prompt-injection classifier. Runs after the
    // tool result has been stored but before the model sees it. On a
    // malicious verdict the previewContent is replaced with a redaction
    // notice; on suspicious it's kept but the trace event records a
    // warning. Tools opt out by setting `classifyOutput: false` (only the
    // in-process Task wrapper does today).
    const finalPreview = await applyInjectionClassification(tool, tu, stored.previewContent);
    // Pillar 3 sink-side fabric — tag the (post-classification) tool result
    // into run-context's dataLineage so the egress classifier can detect
    // exfiltration of this content on a subsequent external-tool call.
    // Skipped for the in-process Task wrapper (`classifyOutput: false`)
    // because the sub-agent's finalMessage is already tagged at the
    // sub-agent-spawner boundary with the more-specific "subagent" origin.
    // MCP tools additionally tag their FULL response under the more-precise
    // "mcp" origin inside tool-mcp; since #160 follow-up the runtime threads
    // a RunContext (via `bridge`/`ctx.runContext`) on EVERY run, so that
    // precise tag now fires unconditionally. This coarse "tool" tag of the
    // (possibly truncated) preview still fires for them as a redundant
    // backstop so the content has lineage even if the precise tag is missed.
    // ERROR results are tagged too: an `is_error` tool result is just as
    // attacker-controllable and just as exfiltratable as a successful one, so
    // it must carry lineage (the `!raw.isError` skip here used to let the
    // egress fabric lose track of error-sourced content entirely).
    if (tool.classifyOutput !== false) {
      const taggable =
        typeof finalPreview === "string"
          ? finalPreview
          : finalPreview.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      if (taggable.length > 0) {
        tagContent(runContext, taggable, "tool");
      }
    }
    return finish({
      type: "tool_result",
      tool_use_id: tu.id,
      // Section 14 — pass non-string content (image content arrays) through
      // verbatim so the model sees the image. Anthropic's ToolResultBlockParam
      // already accepts string | Array<TextBlockParam | ImageBlockParam>.
      content:
        typeof finalPreview === "string"
          ? finalPreview
          : (finalPreview as ReadonlyArray<
              Anthropic.TextBlockParam | Anthropic.ImageBlockParam
            > as Anthropic.ToolResultBlockParam["content"]),
      is_error: raw.isError,
    });
  }

  /**
   * Section 18 — classify the previewContent we are about to hand to the
   * model. Returns the (possibly rewritten) content. Publishes
   * `permission_decision { outcome }` for any non-clean classification so
   * the audit trail records exactly what was redacted/warned.
   */
  let injectionWarningEmitted = false;
  async function applyInjectionClassification(
    tool: RegisteredTool,
    tu: TsmToolUseBlock,
    previewContent: string | ReadonlyArray<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>,
  ): Promise<string | ReadonlyArray<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>> {
    // Runs on ALL tool results, including `is_error` ones: an error preview is
    // just as prompt-injectable as a successful one (e.g. an MCP error string),
    // so it must be scrubbed before the model sees it.
    if (tool.classifyOutput === false) return previewContent;
    // Concatenate text-only content for classification. Image blocks are
    // never injection vectors at the byte level we examine here.
    const textForClassification =
      typeof previewContent === "string"
        ? previewContent
        : previewContent.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    if (textForClassification.length === 0) return previewContent;

    const llmEnabled =
      opts.promptInjectionLlmClassifier !== undefined && llmClassifierEnabled(process.env);
    const verdict = await classifyText(
      textForClassification,
      llmEnabled ? { llmClassifier: opts.promptInjectionLlmClassifier } : {},
    );
    if (verdict.classification === "clean") return previewContent;

    const ruleIds = [...new Set(verdict.hits.map((h) => h.rule))];
    if (verdict.classification === "malicious") {
      const notice = buildRedactionNotice(verdict.hits);
      bus.publish({
        ...bus.envelope(),
        kind: "permission_decision",
        toolName: tu.name,
        decision: "allow",
        mode: permissionMode,
        outcome: "redacted",
        rules: ruleIds,
        reason: `prompt injection in tool output (${ruleIds.slice(0, 3).join(", ")})`,
      });
      runContext.logger.warn("tool output redacted (prompt injection detected)", {
        toolUseId: tu.id,
        toolName: tu.name,
        rules: ruleIds,
      });
      return notice;
    }
    // suspicious — keep content but emit a once-per-session warning.
    bus.publish({
      ...bus.envelope(),
      kind: "permission_decision",
      toolName: tu.name,
      decision: "allow",
      mode: permissionMode,
      outcome: "warned",
      rules: ruleIds,
      reason: `suspicious tool output (${ruleIds.slice(0, 3).join(", ")})`,
    });
    if (!injectionWarningEmitted) {
      injectionWarningEmitted = true;
      runContext.logger.warn(
        "suspicious tool output — kept but flagged (further suspicious outputs in this session will not be re-warned)",
        { toolUseId: tu.id, toolName: tu.name, rules: ruleIds },
      );
    }
    return previewContent;
  }

  /**
   * Section 14 — short summary used in the audit-log payload when a tool
   * returns a non-string content array (e.g. ReadImage's image block). The
   * full content still reaches the model via tool_result.content above; the
   * audit log just gets a length-aware tag.
   */
  // Takes the non-string member of ToolResultBlockParam["content"] — the
  // sole caller (`finish`) only invokes this on the non-string branch of a
  // `typeof result.content === "string"` ternary, so the string/undefined
  // case is statically excluded here and no dead guard is needed.
  function summariseNonStringContent(
    content: Exclude<Anthropic.ToolResultBlockParam["content"], string | undefined>,
  ): string {
    let images = 0;
    let texts = 0;
    let other = 0;
    let totalChars = 0;
    for (const block of content) {
      if (block.type === "image") {
        images++;
        if (block.source.type === "base64") totalChars += block.source.data.length;
      } else if (block.type === "text") {
        texts++;
        totalChars += block.text.length;
      } else {
        other++;
      }
    }
    const parts: string[] = [];
    if (images > 0) parts.push(`${images} image block${images > 1 ? "s" : ""}`);
    if (texts > 0) parts.push(`${texts} text block${texts > 1 ? "s" : ""}`);
    if (other > 0) parts.push(`${other} other block${other > 1 ? "s" : ""}`);
    return `[${parts.join(", ")}, ${totalChars} chars]`;
  }

  /**
   * Run a list of tool calls honouring the orchestrator's partition:
   * concurrent-safe batches via `Promise.all`, then serial calls one at
   * a time. Results are returned in the original `toolUses` order so
   * they line up with the assistant turn's tool_use blocks.
   */
  async function runToolBatch(
    toolUses: ReadonlyArray<TsmToolUseBlock>,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    // Pass the full catalog so per-call classifiers (Task) can resolve a
    // dispatch's child tool set; without it, classifier-based tools stay
    // serial (fail-closed).
    const partition = partitionToolCalls(toolUses, (n) => toolByName.get(n), tools);
    const maxConcurrentTools = opts.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS;
    runContext.logger.debug("tool partition", {
      concurrent: partition.concurrent.map((b) => b.length),
      serial: partition.serial.length,
      maxConcurrentTools,
    });
    // Map each tool_use's identity to its slot in the original order so
    // results can be placed back in order regardless of the
    // concurrent/serial execution shape. `partitionToolCalls` is total —
    // every input block lands in exactly one partition bucket — and
    // `executeOneToolUse` always resolves to a result, so every slot is
    // filled; there is no missing-result case to defend against.
    const indexByBlock = new Map<TsmToolUseBlock, number>();
    toolUses.forEach((tu, idx) => indexByBlock.set(tu, idx));
    const results = new Array<Anthropic.ToolResultBlockParam>(toolUses.length);
    for (const batch of partition.concurrent) {
      const settled = await mapWithConcurrency(batch, maxConcurrentTools, (tu) =>
        executeOneToolUse(tu),
      );
      batch.forEach((tu, i) => {
        // biome-ignore lint/style/noNonNullAssertion: every block came from toolUses, so its index is registered.
        results[indexByBlock.get(tu)!] = settled[i] as Anthropic.ToolResultBlockParam;
      });
    }
    for (const tu of partition.serial) {
      // biome-ignore lint/style/noNonNullAssertion: every block came from toolUses, so its index is registered.
      results[indexByBlock.get(tu)!] = await executeOneToolUse(tu);
    }
    return results;
  }

  /**
   * Convert a freshly-detected loop into a synthetic user message that
   * nudges the model to break the cycle. Returns `null` if no loop is
   * currently detected, or if this signature has already produced a
   * warning earlier in the run.
   */
  function maybeBuildLoopWarning(): Anthropic.MessageParam | null {
    const detection: LoopDetection | null = detectLoop(toolUseHistory);
    if (detection === null) return null;
    if (warnedLoopSignatures.has(detection.signature)) return null;
    warnedLoopSignatures.add(detection.signature);
    runContext.logger.warn("tool loop detected", {
      signature: detection.signature,
      toolName: detection.toolName,
      count: detection.count,
    });
    return {
      role: "user",
      content: `[runtime] possible loop detected: tool "${detection.toolName}" has been called ${detection.count} times with the same input within the last ${detection.windowSize} calls. Reconsider before repeating; respond with a different approach or final text.`,
    };
  }

  /**
   * Run one user→assistant turn through the state machine. Mutates
   * `messages` in place (pushes the assistant turn and any tool_results).
   * Returns the final assistant content blocks so callers can extract
   * text. Closes over client/model/maxTokens/etc.
   */
  async function runOneTurn(
    messages: Anthropic.MessageParam[],
  ): Promise<{ terminalContent: Anthropic.ContentBlock[] }> {
    let state: TurnState = initialState;
    let terminalContent: Anthropic.ContentBlock[] = [];
    let recovery: RecoveryState = initialRecoveryState;
    const maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let toolIterations = 0;
    // Item 26 — tool_use blocks THIS turn produced (fed to the NEXT turn's
    // tier decision) and the misroute-recovery escalation latch (a fast-tier
    // failure forces `default` for the rest of this turn). `servedFastTier`
    // records whether the LAST attempt streamed on the fast tier, so the
    // error catch only escalates a genuine fast-tier misroute.
    let thisTurnToolUseCount = 0;
    let escalateTier = false;
    let servedFastTier = false;

    while (state.kind !== "Done") {
      if (turnAbort.signal.aborted) {
        state = transition(state, { kind: "Aborted" });
        continue;
      }

      switch (state.kind) {
        case "NeedModel": {
          out.write("agent> ");
          // Section 11 — pre-model hook. Deny short-circuits the turn with
          // a synthetic "[blocked by hook]" assistant message so the loop
          // exits cleanly (state transitions through ModelReturnedText →
          // Done(no_tools)).
          const preModel = await fireHook("pre-model", {
            model: opts.model,
            streaming: opts.streaming === true,
            messageCount: messages.length,
          });
          if (!preModel.allowed) {
            const blockedText = `[blocked by hook] ${preModel.reason ?? "denied"}`;
            out.write(`${blockedText}\n`);
            const blockedBlock: Anthropic.TextBlock = {
              type: "text",
              text: blockedText,
              citations: null,
            };
            messages.push({ role: "assistant", content: [blockedBlock] });
            await logEvent("assistant_message", { content: [blockedBlock] });
            terminalContent = [blockedBlock];
            state = transition(state, { kind: "ModelReturnedText" });
            break;
          }
          // Animate "thinking…" through the model wait. The `agent> ` prefix
          // is kept across redraws and left behind when the spinner stops on
          // the first text delta (`writeText`) or tool header — so the silent
          // gap before the model responds now shows live progress. Cleared in
          // the catch below on any model-call error.
          out.spinner.start("thinking", { prefix: "agent> " });
          try {
            // Section 27 — rate-limit the model call before opening the
            // stream. The keys are caller-configured (typically
            // `[provider, tenant?]`); a missing bucket fails closed and
            // surfaces the RateLimitError up to recovery-engine.
            if (opts.rateLimiter && opts.rateLimitKeys && opts.rateLimitKeys.length > 0) {
              await opts.rateLimiter.acquire(opts.rateLimitKeys, 1);
            }
            const modelStartEnv = bus.envelope();
            // Section 27 — `model` carries the WIRE model id (the stripped
            // form the provider bills against, e.g. `bedrock/us.anthropic.…`
            // → `us.anthropic.…`) so cost-tracker pricing lookups and the
            // OTel `gen_ai.request.model` attribute match; the original
            // spec string rides along as `specModel` when it differs.
            // Item 22 — with a failover chain the serving candidate may not
            // be the primary: stamp the request with the chain's routing
            // plan (best-effort; the response event below uses lastServed(),
            // which is exact, so cost-tracker pricing always keys on the
            // model that actually served).
            const plannedCandidate = failoverChain?.plan();
            let reqWireModelId = plannedCandidate?.modelId ?? wireModelId;
            let reqProviderId = plannedCandidate?.providerId ?? providerId;
            // Item 27 — after a budget degrade, `failoverChain` is null and
            // `degradedSpecModel` is the running spec model.
            let reqSpecModel = plannedCandidate?.modelString ?? degradedSpecModel ?? opts.model;
            // The adapter this turn streams through: the primary/chain by
            // default, or a tier adapter when the two-tier router is active.
            let turnAdapter: ProviderAdapter = adapter;
            // Item 26 — two-tier turn-difficulty router. Pick a tier from
            // DETERMINISTIC per-turn signals (context size, tools-in-play,
            // turn index, prior-turn tool_use density); a fast-tier misroute
            // recovery forces `default` (see the catch below). Publish the
            // decision as a `model_tier_route` event, then stream through the
            // chosen tier's already-resolved adapter.
            if (tierRouter !== undefined) {
              const decision = escalateTier
                ? { tier: "default" as const, reason: "escalated after fast-tier failure" }
                : tierRouter.route({
                    contextTokens: estimateTokens(messages),
                    toolsInPlay: (anthropicTools?.length ?? 0) > 0,
                    // `turnNumber` is 1-based (incremented before the turn
                    // runs); the router wants a 0-based index so its
                    // first-turn check keys on the opening turn.
                    turnIndex: Math.max(0, runContext.turnNumber - 1),
                    priorTurnToolUseCount,
                  });
              const chosen = tierRouter.tier(decision.tier);
              turnAdapter = chosen.adapter;
              reqWireModelId = chosen.modelId;
              reqProviderId = chosen.adapter.providerId;
              reqSpecModel = chosen.modelString;
              servedFastTier = decision.tier === "fast";
              bus.publish({
                ...bus.envelope(),
                kind: "model_tier_route",
                tier: decision.tier,
                model: chosen.modelId,
                reason: decision.reason,
                ...(escalateTier ? { escalated: true } : {}),
              });
            }
            bus.publish({
              ...modelStartEnv,
              kind: "model_request",
              model: reqWireModelId,
              ...(reqSpecModel !== reqWireModelId ? { specModel: reqSpecModel } : {}),
              provider: reqProviderId,
              messageCount: messages.length,
              toolCount: anthropicTools?.length ?? 0,
              streaming: opts.streaming === true,
            });
            const t0Model = performance.now();
            let streamChunkIndex = 0;

            // Section 17 — `adapter.stream(req)` returns
            // `AsyncIterable<StreamEvent>`; we accumulate via
            // `consumeStream` (callbacks for stdout streaming + token
            // telemetry) and pull the final canonical message at the
            // end. The canonical content blocks are wire-compatible
            // with `Anthropic.ContentBlock` so existing message-history
            // bookkeeping continues to work.
            // Note: `messages` is `Anthropic.MessageParam[]` whose
            // content union is structurally a superset of canonical
            // (it includes `document`, deprecated `tool_result`
            // shapes, etc.). Cast to the canonical surface — the
            // bookkeeping is wire-compatible for the block kinds we
            // actually consume (text / image / tool_use / tool_result
            // / thinking).
            // Item 22 — the failover chain rewrites `model` per serving
            // candidate internally; the planned id here is the single-adapter
            // value and the chain's best-effort prediction otherwise.
            const reqStream = turnAdapter.stream({
              model: reqWireModelId,
              system: systemBlocks.map((b) => ({
                type: "text" as const,
                text: b.text,
                ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
              })),
              messages: messages as Parameters<ProviderAdapter["stream"]>[0]["messages"],
              tools:
                anthropicTools !== undefined
                  ? anthropicTools.map((t) => ({
                      name: t.name,
                      description: t.description ?? "",
                      input_schema: t.input_schema as Record<string, unknown>,
                    }))
                  : undefined,
              maxTokens,
              signal: turnAbort.signal,
            });

            if (opts.streaming) {
              // Streaming path: dispatch tools mid-stream via the
              // refactored streaming-tool-executor (now consumes
              // AsyncIterable<StreamEvent> directly).
              void modelStartEnv;
              const onTextDelta = (chunk: string): void => {
                writeText(chunk);
                bus.publish(
                  {
                    ...bus.envelope(),
                    kind: "model_stream_token",
                    chunkIndex: streamChunkIndex++,
                    deltaChars: chunk.length,
                  },
                  { ephemeral: true },
                );
              };
              const { finalContent, toolResults, stopReason, usage } = await executeStreaming(
                reqStream,
                {
                  toolByName,
                  abortSignal: turnAbort.signal,
                  onTextDelta,
                  // Honor the same concurrency bound as the non-streaming
                  // path — otherwise `maxConcurrentTools` would be silently
                  // ignored under `streaming: true`.
                  maxConcurrent: opts.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
                  runTool: (block) =>
                    executeOneToolUse({
                      id: block.id,
                      name: block.name,
                      input: block.input,
                    }),
                  onEvent: (e) => {
                    runContext.logger.debug("streaming-tool", { ...e });
                  },
                },
              );
              endTurn();

              // On `stop_reason: "max_tokens"` the model may have been cut off
              // mid-`tool_use`; the streaming executor only runs a call once its
              // input JSON closes, so a truncated call has no `tool_result`.
              // Strip such orphans before they enter history — an unanswered
              // `tool_use` 400s every later request (see the non-streaming path
              // and `sanitizeOrphanToolUses`).
              const answeredStreamIds = new Set(
                toolResults
                  .map((r) => (r as { tool_use_id?: unknown }).tool_use_id)
                  .filter((id): id is string => typeof id === "string"),
              );
              const committedStreamContent =
                stopReason === "max_tokens"
                  ? finalContent.filter(
                      (b) =>
                        b.type !== "tool_use" ||
                        ((b as { id?: unknown }).id !== undefined &&
                          answeredStreamIds.has((b as { id: string }).id)),
                    )
                  : finalContent;

              if (committedStreamContent.length > 0) {
                messages.push({
                  role: "assistant",
                  content: committedStreamContent as Anthropic.MessageParam["content"],
                });
                await logEvent("assistant_message", { content: committedStreamContent });
              }
              terminalContent = [...committedStreamContent] as Anthropic.ContentBlock[];
              // Item 22 — lastServed() is exact: the candidate that actually
              // streamed this response. Cost-tracker prices off this pair.
              const servedStreaming = failoverChain?.lastServed();
              const respModelIdS = servedStreaming?.modelId ?? wireModelId;
              const respSpecModelS =
                servedStreaming?.modelString ?? degradedSpecModel ?? opts.model;
              bus.publish({
                ...bus.envelope(),
                spanId: modelStartEnv.spanId,
                kind: "model_response",
                // Wire model id, NOT the spec string — cost-tracker resolves
                // pricing on this field (see the model_request publish above).
                model: respModelIdS,
                ...(respSpecModelS !== respModelIdS ? { specModel: respSpecModelS } : {}),
                provider: servedStreaming?.providerId ?? providerId,
                stopReason: stopReason ?? "end_turn",
                usage,
                durationMs: performance.now() - t0Model,
              });
              await fireHook("post-model", {
                streaming: true,
                contentBlocks: finalContent.length,
              });

              const toolUses = committedStreamContent.filter(
                (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
              );
              if (toolUses.length === 0) {
                state = transition(state, { kind: "ModelReturnedText" });
                break;
              }

              // Item 26 — accrue this turn's tool_use count (next-turn tier signal).
              thisTurnToolUseCount += toolUses.length;
              for (const tu of toolUses) {
                toolUseHistory.push({ id: tu.id, name: tu.name, input: tu.input });
              }
              messages.push({ role: "user", content: [...toolResults] });
              await logEvent("user_message", { content: [...toolResults] });
              const warning = maybeBuildLoopWarning();
              if (warning !== null) {
                messages.push(warning);
                await logEvent("user_message", { content: warning.content, synthetic: true });
              }

              // Synthesize the two transitions the state machine expects:
              // tools have already executed during the stream so we
              // collapse ModelReturnedToolUse → ToolsExecuted into a
              // single hop back to NeedModel.
              const tsmBlocks: TsmToolUseBlock[] = toolUses.map((t) => ({
                id: t.id,
                name: t.name,
                input: t.input,
              }));
              state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
              state = transition(state, { kind: "ToolsExecuted" });
              break;
            }

            // Non-streaming path: drain the AsyncIterable into a final
            // `ProviderMessage` while emitting text deltas to stdout.
            const final = await consumeStream(reqStream, {
              onTextDelta: (chunk) => {
                writeText(chunk);
                bus.publish(
                  {
                    ...bus.envelope(),
                    kind: "model_stream_token",
                    chunkIndex: streamChunkIndex++,
                    deltaChars: chunk.length,
                  },
                  { ephemeral: true },
                );
              },
            });
            endTurn();

            // Item 22 — lastServed() is exact: the candidate that actually
            // streamed this response. Cost-tracker prices off this pair.
            const servedCandidate = failoverChain?.lastServed();
            const respWireModelId = servedCandidate?.modelId ?? wireModelId;
            const respSpecModel = servedCandidate?.modelString ?? degradedSpecModel ?? opts.model;
            bus.publish({
              ...bus.envelope(),
              spanId: modelStartEnv.spanId,
              kind: "model_response",
              // Wire model id, NOT the spec string — cost-tracker resolves
              // pricing on this field (see the model_request publish above).
              model: respWireModelId,
              ...(respSpecModel !== respWireModelId ? { specModel: respSpecModel } : {}),
              provider: servedCandidate?.providerId ?? providerId,
              stopReason: final.stopReason,
              usage: final.usage,
              durationMs: performance.now() - t0Model,
            });

            // Persist the assistant turn. On a clean stop the FULL content-block
            // array is committed so subsequent `tool_result` references resolve.
            //
            // On `stop_reason: "max_tokens"` the model was cut off mid-reply, so
            // any `tool_use` it emitted is necessarily un-executed — the
            // truncation routes to recovery below, BEFORE the `NeedTools` state
            // runs a tool — and its input is truncated / `__parse_error`
            // garbage. Committing such an orphan `tool_use` would make every
            // later request 400 ("tool_use ids ... without tool_result blocks
            // immediately after"); the recovery loop cannot clear that by
            // appending a text nudge, so the run bricks once the tombstone
            // budget is spent. Strip the orphan here, before it enters either
            // in-memory history OR the resumable event log.
            const truncatedTurn = final.stopReason === "max_tokens";
            const committedContent = truncatedTurn
              ? final.content.filter((b) => b.type !== "tool_use")
              : final.content;
            if (committedContent.length > 0) {
              messages.push({
                role: "assistant",
                content: committedContent as Anthropic.MessageParam["content"],
              });
              await logEvent("assistant_message", { content: committedContent });
            }
            terminalContent = [...committedContent] as Anthropic.ContentBlock[];
            await fireHook("post-model", {
              streaming: false,
              stopReason: final.stopReason,
              contentBlocks: final.content.length,
            });

            // Synthetic max_output_tokens recovery: route the truncation through
            // the recovery state machine so we ask the model to continue. The
            // orphan `tool_use` (if any) was stripped above, so the `continue`
            // nudge produces an API-valid next request.
            if (truncatedTurn) {
              lastErrorForRecovery = {
                name: "MaxTokensError",
                error: { type: "max_output_tokens" },
                message: "stop_reason: max_tokens",
              };
              state = transition(state, {
                kind: "RecoverableError",
                error: { name: "MaxTokensError", message: "stop_reason: max_tokens" },
              });
              break;
            }

            const toolUses = final.content.filter(
              (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
            );
            if (toolUses.length === 0) {
              state = transition(state, { kind: "ModelReturnedText" });
            } else {
              const tsmBlocks: TsmToolUseBlock[] = toolUses.map((t) => ({
                id: t.id,
                name: t.name,
                input: t.input,
              }));
              for (const tu of tsmBlocks) toolUseHistory.push(tu);
              state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
            }
          } catch (err) {
            // Tear down the "thinking" animation before any error/abort output.
            out.spinner.stop();
            if (isAbortError(err)) {
              state = transition(state, { kind: "Aborted" });
              break;
            }
            lastErrorForRecovery = err;
            // Item 26 — a fast-tier turn that FAILED is a MISROUTE: latch the
            // escalation so the recovery retry re-runs on the `default` tier
            // (the loop re-enters NeedModel via the recovery ladder, which
            // then picks `default`). Composes with the existing recovery
            // actions — a retry/continue now streams on the sturdier tier.
            if (tierRouter !== undefined && servedFastTier) {
              escalateTier = true;
            }
            const errObj = err as { name?: unknown; message?: unknown };
            const errorName = typeof errObj.name === "string" ? errObj.name : "Error";
            const errorMessage = typeof errObj.message === "string" ? errObj.message : String(err);
            await logEvent("error", { name: errorName, message: errorMessage });
            state = transition(state, {
              kind: "RecoverableError",
              error: { name: errorName, message: errorMessage },
            });
          }
          break;
        }

        case "NeedTools": {
          toolIterations += 1;
          if (toolIterations > maxToolIterations) {
            // Enforcing loop bound — the advisory loop-detector can't stop a
            // runaway tool loop (it only warns and is defeated by argument
            // churn), so fail closed here.
            await logEvent("error", {
              name: "ToolLoopLimit",
              message: `aborting turn: exceeded maxToolIterations (${maxToolIterations}) — possible runaway tool loop`,
            });
            runContext.logger.error("tool-iteration cap exceeded — aborting turn", {
              maxToolIterations,
            });
            state = transition(state, { kind: "Aborted" });
            break;
          }
          // Item 26 — accrue this turn's tool_use count (a next-turn tier
          // signal): a dense tool turn marks an active multi-step task.
          thisTurnToolUseCount += state.toolUses.length;
          const toolResults = await runToolBatch(state.toolUses);
          messages.push({ role: "user", content: toolResults });
          await logEvent("user_message", { content: toolResults });
          const warning = maybeBuildLoopWarning();
          if (warning !== null) {
            messages.push(warning);
            await logEvent("user_message", { content: warning.content, synthetic: true });
          }
          state = transition(state, { kind: "ToolsExecuted" });
          break;
        }

        // NOTE: there is no `case "NeedCompaction"` here, and it is
        // unreachable by construction: the turn-state-machine only enters
        // `NeedCompaction` on a `BudgetExceeded` event, and this loop never
        // emits one — pre-turn compaction runs outside the state machine (see
        // `maybeCompact`) and in-turn reactive compaction is handled inline by
        // the `compact` recovery action below. If a future change starts
        // emitting `BudgetExceeded` from `runOneTurn`, restore a
        // `NeedCompaction` → `CompactionDone` arm (and cover it) here.

        case "NeedRecovery": {
          // Item 23 / Section 55 — consult the spec's failure_taxonomy first
          // (named classes take precedence over the built-in flow), so a
          // matched `switch-model` (or retry/compact/…) entry wins.
          const action = recover(lastErrorForRecovery, recovery, opts.failureTaxonomy);
          recovery = advanceState(recovery, action);
          runContext.logger.info("recovery.action", {
            kind: action.kind,
            errorName: state.error.name,
            recoveryDepth: recovery.retryCount + recovery.compactCount + recovery.continueCount,
          });
          bus.publish({
            ...bus.envelope(),
            kind: "error_recovered",
            action: action.kind,
            errorName: state.error.name,
            depth: recovery.retryCount + recovery.compactCount + recovery.continueCount,
          });
          switch (action.kind) {
            case "compact": {
              const before = messages.length;
              await fireHook("pre-compact", { kind: "reactive", before });
              // Reactive compaction summarizes via a model call — show the wait.
              out.spinner.start("compacting context");
              const compacted = await forceCompact({
                messages,
                adapter: compactionAdapter,
                model: compactionWireModelId,
                snipKeepHead,
                snipKeepTail,
                logger: runContext.logger,
              }).finally(() => out.spinner.stop());
              messages.length = 0;
              messages.push(...compacted);
              await logEvent("compaction", {
                kind: "reactive",
                before,
                after: messages.length,
              });
              bus.publish({
                ...bus.envelope(),
                kind: "compaction_fired",
                subKind: "reactive",
                before,
                after: messages.length,
                phase: "reactive",
              });
              await fireHook("post-compact", {
                kind: "reactive",
                before,
                after: messages.length,
              });
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "retry":
              // Surface the back-off wait instead of stalling silently.
              out.spinner.start("retrying");
              await new Promise((resolve) => setTimeout(resolve, action.delayMs));
              out.spinner.stop();
              state = transition(state, { kind: "RecoveryDone" });
              break;
            case "continue": {
              // Runtime-injected user_message events (this nudge, the tombstone
              // retry, and loop warnings) are marked `synthetic: true` in the
              // event log. They are NOT human turns, so they do not increment
              // runContext.turnNumber — and `crewhaus distill`'s deriveTurns
              // skips them so its turn ordinal matches the runtime + web UI.
              const continueMsg = "Please continue from where you left off.";
              messages.push({ role: "user", content: continueMsg });
              await logEvent("user_message", { content: continueMsg, synthetic: true });
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "tombstone": {
              // A tombstone fires on an `invalid_request` (400) from the model
              // call. The dominant cause is a dangling `tool_use` with no
              // answering `tool_result` — an orphan the model left when a
              // `stop_reason: "max_tokens"` cut it off mid-call. (The earlier
              // claim that the assistant stream is "atomic w.r.t. history" was
              // wrong: the `max_tokens` path commits the assistant turn and THEN
              // routes here. The non-streaming path now strips orphans at the
              // source, but a streaming truncation or a resumed pre-fix session
              // can still surface one.) Appending a text nudge alone does NOT
              // clear that 400 — the orphan stays in history and every retry
              // 400s again until the tombstone budget is spent and the run
              // bricks. So reconcile FIRST: drop any orphan `tool_use`, then
              // append the retry nudge. No-op on a healthy history, where the
              // nudge handles a genuinely malformed block as before.
              const reconciled = sanitizeOrphanToolUses(messages);
              if (reconciled.removed > 0) {
                messages.length = 0;
                messages.push(...reconciled.messages);
                runContext.logger.info("recovery.tombstone reconciled orphan tool_use", {
                  removed: reconciled.removed,
                });
              }
              const tombstoneMsg =
                "[previous assistant turn was rejected as invalid; please retry]";
              messages.push({ role: "user", content: tombstoneMsg });
              await logEvent("user_message", { content: tombstoneMsg, synthetic: true });
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "switch-model": {
              // Item 23 — a `switch-model` failure_taxonomy verdict: abandon
              // the active provider candidate FOR THIS TURN and re-issue the
              // same request onto the next failover candidate. Mechanism:
              // force the active candidate's breaker open so the chain
              // reroutes on the next `stream()`; the chain publishes the
              // `model_failover` (reason breaker_open) itself. No message
              // mutation and no backoff sleep — a switch is instant. Without
              // a failover chain (no `modelFallbacks`) there is nothing to
              // switch to: this degrades to a plain re-issue against the same
              // adapter, which the per-turn budget bounds. RecoveryDone loops
              // back to NeedModel, which re-streams.
              const tripped = failoverChain?.tripActive("switch-model recovery");
              if (tripped !== undefined) {
                out.spinner.start("switching model");
                out.spinner.stop();
                runContext.logger.info("recovery.switch-model tripped candidate", {
                  from: tripped,
                });
              } else {
                runContext.logger.warn(
                  "recovery.switch-model: no failover chain — re-issuing on the same model",
                );
              }
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "fail":
              throw new RuntimeError(`recovery failed: ${action.reason}`);
          }
          break;
        }
      }
    }

    // Item 26 — hand this turn's tool_use count to the next turn's tier
    // decision (the prior-tool-density signal).
    priorTurnToolUseCount = thisTurnToolUseCount;
    return { terminalContent };
  }

  // Single-shot path used by the workflow target and (Section 12) the
  // channel-bot session router. Runs one user→assistant turn (with the tool
  // inner-loop until Done), persists the transcript, returns the terminal
  // assistant text. Never reads stdin.
  if (opts.singleTurn) {
    const seed = opts.seedMessages ?? [];
    const last = seed[seed.length - 1];
    if (!last || last.role !== "user") {
      throw new RuntimeError(
        'runChatLoop({ singleTurn: true }) requires `seedMessages` to end with a `role: "user"` entry',
      );
    }
    try {
      // When resuming, the replayed event-log history becomes the prefix
      // (already on disk — never re-logged). The seed is the new turn's
      // input, appended at the end. Without resume (workflow target), the
      // seed IS the entire turn and is logged through.
      const replayed = resumedMessages ?? [];
      let messages: Anthropic.MessageParam[] = [...replayed, ...seed];
      for (const m of seed) {
        if (m.role === "user") {
          await logEvent("user_message", { content: m.content });
        } else if (m.role === "assistant") {
          await logEvent("assistant_message", { content: m.content });
        }
      }
      runContext.turnNumber += 1;
      bus.setTurnNumber(runContext.turnNumber);
      const t0SingleTurn = performance.now();
      bus.publish({
        ...bus.envelope(),
        kind: "turn_start",
        turn: runContext.turnNumber,
        messageCount: messages.length,
      });
      runContext.logger.debug("turn start (single)", {
        turn: runContext.turnNumber,
        messages: messages.length,
      });

      messages = await maybeCompact(
        {
          messages,
          adapter: compactionAdapter,
          model: compactionWireModelId,
          contextLimit,
          compactionThreshold,
          snipKeepHead,
          snipKeepTail,
          logger: runContext.logger,
        },
        async (info) => {
          await logEvent("compaction", info);
          bus.publish({
            ...bus.envelope(),
            kind: "compaction_fired",
            subKind: info.kind,
            before: info.before,
            after: info.after,
            phase: "pre-turn",
          });
          // Fire one pre-compact (info has the before-count from the work
          // that just ran) followed by post-compact. Pre-compact in this
          // path is observational — by the time onCompaction fires the
          // step has already happened — but the pair lets hooks see both
          // events for symmetry with the reactive path.
          await fireHook("pre-compact", { ...info, phase: "pre-turn" });
          await fireHook("post-compact", { ...info, phase: "pre-turn" });
        },
      );

      const { terminalContent } = await runOneTurn(messages);
      bus.publish({
        ...bus.envelope(),
        kind: "turn_end",
        turn: runContext.turnNumber,
        durationMs: performance.now() - t0SingleTurn,
      });
      return terminalContent
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    } finally {
      out.spinner.stop();
      await fireHook("stop", {
        sessionId,
        turnCount: runContext.turnNumber,
        reason: "complete",
      });
      await maybeAutoCapture();
      await subscribers.flushAll();
      await subscribers.shutdownAll();
      costPersistUnsubscribe?.();
      failoverNoteUnsubscribe?.();
      incidentCollector?.unsubscribe();
      budgetMeter?.unsubscribe();
      advisorPersist?.unsubscribe();
      mcpStatsPersist?.unsubscribe();
      printAdvisorDigest(advisorPersist);
      await sessionStore
        .update(sessionId, { lastTurnIndex: runContext.turnNumber })
        .catch((err) => {
          runContext.logger.warn("session-store: lastTurnIndex update failed", {
            error: (err as Error).message,
          });
        });
      await eventLog.close();
    }
  }

  // REPL mode (existing behavior). When resuming, the prior session's
  // transcript becomes the seed; otherwise honour any caller-supplied
  // seedMessages.
  let messages: Anthropic.MessageParam[] = resumedMessages
    ? [...resumedMessages]
    : opts.seedMessages
      ? [...opts.seedMessages]
      : [];

  const rl = readline.createInterface({
    input: opts.input ?? process.stdin,
    output: process.stdout,
  });

  // EOF on stdin (e.g. when input is piped in non-interactively) auto-closes
  // the readline interface. The next `rl.question` call would then crash with
  // ERR_USE_AFTER_CLOSE, so race each prompt against the close event and
  // also catch the post-close throw — close can fire either before we issue
  // the next prompt or while we're already awaiting one.
  const STDIN_CLOSED = Symbol("stdin-closed");
  const closedSignal = new Promise<typeof STDIN_CLOSED>((resolve) => {
    rl.once("close", () => resolve(STDIN_CLOSED));
  });

  // Wire the permission-ask prompter once the readline interface exists.
  // Treats a closed stdin as "deny" so a piped non-interactive input does
  // not stall on the approval prompt.
  askApproval = async (toolName: string, input: unknown): Promise<boolean> => {
    const inputPreview = JSON.stringify(input).slice(0, 200);
    try {
      const result = await Promise.race([
        rl.question(`approve ${toolName} ${inputPreview} [y/N] > `),
        closedSignal,
      ]);
      if (result === STDIN_CLOSED) return false;
      const normalized = result.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return false;
      throw err;
    }
  };

  const providerNote = providerId === "anthropic" ? "" : ` [${providerId}]`;
  process.stdout.write(`agent ready (model: ${opts.model})${providerNote}. type "exit" to quit.\n`);

  // M3.2 — plan-mode UX indicator. When `permissions.mode: plan` is
  // active, the LLM-policy permission engine is the gate; show the
  // user it's on so they know destructive tools will be pushed back on.
  if (permissionMode === "plan") {
    process.stdout.write(
      "\x1b[1m\x1b[33m[plan mode]\x1b[0m destructive tools (Write, Edit, Bash) gate through LLM policy; type a request to plan, then approve before execution.\n",
    );
  } else if (permissionMode === "auto") {
    process.stdout.write(
      "\x1b[1m\x1b[35m[auto mode]\x1b[0m all rules apply, no prompts — the agent acts under your declared permissions.\n",
    );
  } else if (permissionMode === "bypass") {
    process.stdout.write(
      "\x1b[1m\x1b[31m[BYPASS mode]\x1b[0m all permission rules are disabled. Use only on isolated machines.\n",
    );
  }

  // SIGINT handler: first press during a turn aborts the turn; second
  // press exits. Counter resets at the start of each new turn. Default-on
  // whenever the runtime owns process.stdin (i.e. the test option
  // `opts.input` is unset). Tests that supply their own input stream skip
  // installation so they don't interfere with the test runner's signals.
  const shouldInstallSigint = opts.installSigintHandler ?? opts.input === undefined;
  let sigintPresses = 0;
  const sigintHandler = (): void => {
    // Clear any live animation (and restore the cursor) before the notice.
    out.spinner.stop();
    sigintPresses += 1;
    if (sigintPresses === 1) {
      out.write("\n[turn aborted; press Ctrl-C again to exit]\n");
      turnAbort.abort();
    } else {
      out.write("\n[exiting]\n");
      process.exit(130);
    }
  };
  if (shouldInstallSigint) {
    process.on("SIGINT", sigintHandler);
  }

  try {
    while (true) {
      if (runAbort.signal.aborted) break;

      // Fresh turn-abort tree so a previous turn's abort doesn't bleed in.
      turnAbort = runAbort.child();
      sigintPresses = 0;

      let userInput: string;
      try {
        const result = await Promise.race([rl.question("\nyou> "), closedSignal]);
        if (result === STDIN_CLOSED) break;
        userInput = result.trim();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") break;
        throw err;
      }
      if (userInput === "") continue;
      if (userInput === "exit" || userInput === "quit") break;

      // Section 11 — slash-command expansion. When the user input matches
      // a registered slash command, the markdown body (with $ARGUMENTS
      // substitution) becomes the effective user message. A `pre-slash`
      // hook fires first; deny falls through with the original input,
      // mutate.expanded overrides the substituted text.
      let effectiveInput = userInput;
      if (opts.slashCommands && opts.slashCommands.size > 0) {
        const slash = expandSlash(userInput, opts.slashCommands);
        if (slash.handled) {
          const decision = await fireHook("pre-slash", {
            name: slash.command?.name,
            arguments: slash.arguments,
            expanded: slash.expanded,
          });
          if (decision.allowed) {
            const override = decision.mutate?.["expanded"];
            effectiveInput = typeof override === "string" ? override : slash.expanded;
          } else {
            runContext.logger.info("pre-slash hook denied", {
              name: slash.command?.name,
              reason: decision.reason,
            });
          }
        }
      }

      // Item 27 — run-level spend cap. Enforced HERE (a real turn is about
      // to run, input is not exit/blank) so an idle prompt never trips it.
      // On a `stop` breach we break before committing the input — the turn
      // never runs. On a `degrade` breach `enforceBudget` has already
      // swapped the primary adapter, so this turn runs on the cheaper model.
      if ((await enforceBudget()) === "stop") break;

      messages.push({ role: "user", content: effectiveInput });
      await logEvent("user_message", { content: effectiveInput });
      runContext.turnNumber += 1;
      bus.setTurnNumber(runContext.turnNumber);
      const t0Turn = performance.now();
      bus.publish({
        ...bus.envelope(),
        kind: "turn_start",
        turn: runContext.turnNumber,
        messageCount: messages.length,
      });
      runContext.logger.debug("turn start", {
        turn: runContext.turnNumber,
        messages: messages.length,
      });

      // Pre-turn budget check: snip first (free), then autocompact if still over.
      messages = await maybeCompact(
        {
          messages,
          adapter: compactionAdapter,
          model: compactionWireModelId,
          contextLimit,
          compactionThreshold,
          snipKeepHead,
          snipKeepTail,
          logger: runContext.logger,
        },
        async (info) => {
          await logEvent("compaction", info);
          bus.publish({
            ...bus.envelope(),
            kind: "compaction_fired",
            subKind: info.kind,
            before: info.before,
            after: info.after,
            phase: "pre-turn",
          });
          await fireHook("pre-compact", { ...info, phase: "pre-turn" });
          await fireHook("post-compact", { ...info, phase: "pre-turn" });
        },
      );

      try {
        await runOneTurn(messages);
      } catch (err) {
        // Defensive: tear down any animation a thrown turn left spinning.
        out.spinner.stop();
        if (isAbortError(err)) {
          // Already-handled abort; loop back to the prompt.
          out.write("\n[turn aborted]\n");
        } else {
          throw err;
        }
      }

      bus.publish({
        ...bus.envelope(),
        kind: "turn_end",
        turn: runContext.turnNumber,
        durationMs: performance.now() - t0Turn,
      });
      runContext.logger.debug("turn end", {
        turn: runContext.turnNumber,
      });
    }
  } finally {
    out.spinner.stop();
    await fireHook("stop", {
      sessionId,
      turnCount: runContext.turnNumber,
      reason: runAbort.signal.aborted ? "abort" : "exit",
    });
    await maybeAutoCapture();
    await subscribers.flushAll();
    await subscribers.shutdownAll();
    costPersistUnsubscribe?.();
    failoverNoteUnsubscribe?.();
    incidentCollector?.unsubscribe();
    budgetMeter?.unsubscribe();
    advisorPersist?.unsubscribe();
    mcpStatsPersist?.unsubscribe();
    printAdvisorDigest(advisorPersist);
    if (shouldInstallSigint) {
      process.removeListener("SIGINT", sigintHandler);
    }
    rl.close();
    await sessionStore.update(sessionId, { lastTurnIndex: runContext.turnNumber }).catch((err) => {
      runContext.logger.warn("session-store: lastTurnIndex update failed", {
        error: (err as Error).message,
      });
    });
    await eventLog.close();
  }

  return "";
}

/**
 * Item 14 in-run digest — one stderr line at session end when the advisor
 * persistence subscriber's cheap tally tripped a threshold, pointing at
 * `crewhaus advise --session <id>` for the full report. stderr (not stdout)
 * so piped/captured agent output is never polluted; silent on healthy runs
 * and when the subscriber is disabled (CREWHAUS_ADVISOR_EVENTS=0).
 */
function printAdvisorDigest(advisorPersist: AttachedAdvisorPersistence | undefined): void {
  const line = advisorPersist?.digestLine();
  if (line !== undefined) process.stderr.write(`${line}\n`);
}

function isAbortError(err: unknown): boolean {
  // Section 17 — runtime-core no longer imports the Anthropic SDK at
  // runtime, so we name-match instead of `instanceof`. The provider
  // adapters preserve the SDK error names through their normalisation
  // layers, so this catches both Anthropic and OpenAI/Gemini/Bedrock
  // abort errors uniformly.
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && (name === "AbortError" || name === "APIUserAbortError");
}

type CompactionInfo = {
  readonly kind: "snip" | "autocompact";
  readonly before: number;
  readonly after: number;
};

type CompactArgs = {
  messages: Anthropic.MessageParam[];
  adapter: ProviderAdapter;
  model: string;
  contextLimit: number;
  compactionThreshold: number;
  snipKeepHead: number;
  snipKeepTail: number;
  logger: RunContext["logger"];
};

type OnCompaction = (info: CompactionInfo) => Promise<void>;

/**
 * Pre-turn compaction ladder: estimate → snip → re-estimate → autocompact.
 * Returns the (possibly replaced) messages array. Pure with respect to
 * the input array; callers reassign. The optional `onCompaction` callback
 * fires once per applied step so the runtime can append a `compaction`
 * event to the session log without duplicating the cost-estimation logic.
 */
async function maybeCompact(
  args: CompactArgs,
  onCompaction?: OnCompaction,
): Promise<Anthropic.MessageParam[]> {
  const {
    messages,
    adapter,
    model,
    contextLimit,
    compactionThreshold,
    snipKeepHead,
    snipKeepTail,
    logger,
  } = args;

  const initialBudget = new TokenBudget(contextLimit);
  initialBudget.add(estimateTokens(messages), 0);
  if (!initialBudget.isApproachingLimit(compactionThreshold)) {
    return messages;
  }

  const snipped = snip(messages, snipKeepHead, snipKeepTail);
  logger.info("snip applied", { before: messages.length, after: snipped.length });
  if (onCompaction !== undefined) {
    await onCompaction({ kind: "snip", before: messages.length, after: snipped.length });
  }

  const postSnipBudget = new TokenBudget(contextLimit);
  postSnipBudget.add(estimateTokens(snipped), 0);
  if (!postSnipBudget.isApproachingLimit(compactionThreshold)) {
    return snipped;
  }

  logger.info("autocompact triggered", { tokensAfterSnip: postSnipBudget.used });
  const after = await autoCompact(snipped, adapter, model);
  if (onCompaction !== undefined) {
    await onCompaction({ kind: "autocompact", before: snipped.length, after: after.length });
  }
  return after;
}

type ForceCompactArgs = {
  messages: Anthropic.MessageParam[];
  adapter: ProviderAdapter;
  model: string;
  snipKeepHead: number;
  snipKeepTail: number;
  logger: RunContext["logger"];
};

/**
 * Reactive compaction triggered by the recovery engine on a prompt_too_long
 * error. Unlike pre-turn `maybeCompact`, this one runs unconditionally:
 * snip first, then autocompact (whose model summary reliably trims the
 * largest blob).
 */
async function forceCompact(args: ForceCompactArgs): Promise<Anthropic.MessageParam[]> {
  const { messages, adapter, model, snipKeepHead, snipKeepTail, logger } = args;
  const snipped = snip(messages, snipKeepHead, snipKeepTail);
  logger.info("reactive snip applied", { before: messages.length, after: snipped.length });
  return await autoCompact(snipped, adapter, model);
}

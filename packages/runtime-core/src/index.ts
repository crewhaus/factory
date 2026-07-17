import { randomUUID } from "node:crypto";
import { dirname as pathDirname } from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { type AbortTree, createAbortTree } from "@crewhaus/abort-controller";
import {
  EFFORT_THINKING_BUDGET_TOKENS,
  type ProviderAdapter,
  type ProviderId,
  type ReasoningEffort,
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
import {
  type Item as CuratorItem,
  DEFAULT_DEDUPE_THRESHOLD,
  type EmbedderFn,
  curate as curateItems,
} from "@crewhaus/compaction-curator";
import { snip } from "@crewhaus/compaction-snip";
import {
  DEFAULT_PRICING,
  computeCostMicros,
  createCostTracker,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import {
  type EgressMatcher,
  type EgressVerdict,
  type SinkScope,
  classifyEgress,
  summarizeEgress,
} from "@crewhaus/egress-classifier";
import {
  ConfigError,
  EXIT_CODES,
  type FailureReport,
  RunFailedError,
  RuntimeError,
  isRunFailedError,
} from "@crewhaus/errors";
import { type EventKind, type EventLog, openEventLog } from "@crewhaus/event-log";
import { type HookDef, type HookEvent, aggregateDecisions, runHooks } from "@crewhaus/hooks-engine";
import {
  type FailoverChain,
  type PolicyRouter,
  type PoolCandidate,
  type ResolvedTier,
  type TierRouter,
  createFailoverChain,
  createPolicyRouter,
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
import { type BucketConfig, type RateLimiter, createRateLimiter } from "@crewhaus/rate-limiter";
import {
  type NamedFailureClass,
  type RecoveryState,
  advanceState,
  initialRecoveryState,
  recover,
} from "@crewhaus/recovery-engine";
import {
  type RewardConfig,
  type Scoreboard,
  computeReward,
  openScoreboard,
} from "@crewhaus/routing-store";
import { type RunContext, createRunContext, tagContent } from "@crewhaus/run-context";
import {
  type PendingApproval,
  type PendingApprovalStore,
  type SessionStore,
  createSessionStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
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
import {
  type CostAccrualEvent,
  type ModelUsage,
  TraceEventBus,
  type Unsubscribe,
} from "@crewhaus/trace-event-bus";
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

// Explicit optional keys (not a bare index signature) so dot-access stays lint-
// and tsc-clean.
type JsonSchemaLike = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
};

// Convert a registered tool to the Anthropic `input_schema` shape. Anthropic
// requires a JSON-Schema OBJECT at the top level: it rejects a `type`-less
// schema (`input_schema.type: Field required`) AND a top-level `anyOf`/`oneOf`/
// `allOf` (`input_schema does not support oneOf, allOf, or anyOf at the top
// level`). zod-to-json-schema renders a union / discriminatedUnion as exactly
// that top-level `anyOf` — e.g. tool-plan's `PlanUpdate` (an action-discriminated
// union) and tool-evm — so we FLATTEN a top-level union of object branches into
// one object schema (see `flattenUnionToObject`). A schema that is already a
// clean object passes through by reference untouched.
function toAnthropicInputSchema(t: RegisteredTool): Anthropic.Tool.InputSchema {
  const converted = (t.jsonSchema ??
    zodToJsonSchema(t.inputSchema, { $refStrategy: "none" })) as JsonSchemaLike;
  const union = converted.anyOf ?? converted.oneOf ?? converted.allOf;
  // Already a clean top-level object schema (incl. an empty `z.object({})`).
  if (converted.type === "object" && union === undefined) {
    return converted as Anthropic.Tool.InputSchema;
  }
  if (Array.isArray(union)) {
    return flattenUnionToObject(union as JsonSchemaLike[], converted.properties);
  }
  // Degenerate (no object type, no union): coerce to an empty object schema.
  return { type: "object", properties: converted.properties ?? {} } as Anthropic.Tool.InputSchema;
}

// Merge a top-level union of object branches into a single object schema.
// Anthropic forbids a top-level `anyOf`, but a nested `anyOf` on an individual
// property is fine — so each property becomes the union of its per-branch
// shapes, and `required` is the intersection across branches (in practice the
// shared discriminator). The tool's own zod schema still validates the real
// input at execute time, so the looser model-facing schema loses no safety.
function flattenUnionToObject(
  branches: JsonSchemaLike[],
  baseProps: Record<string, unknown> | undefined,
): Anthropic.Tool.InputSchema {
  const perKey = new Map<string, unknown[]>();
  const requiredSets: string[][] = [];
  for (const b of branches) {
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      const seen = perKey.get(k) ?? [];
      if (!seen.some((e) => JSON.stringify(e) === JSON.stringify(v))) seen.push(v);
      perKey.set(k, seen);
    }
    requiredSets.push(Array.isArray(b.required) ? (b.required as string[]) : []);
  }
  const properties: Record<string, unknown> = { ...(baseProps ?? {}) };
  for (const [k, variants] of perKey) {
    properties[k] = variants.length === 1 ? variants[0] : { anyOf: variants };
  }
  const required =
    requiredSets.length > 0
      ? requiredSets.reduce((acc, r) => acc.filter((x) => r.includes(x)))
      : [];
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  } as Anthropic.Tool.InputSchema;
}

// ---------------------------------------------------------------------------
// v0.3.0 Goal 1 — the continuity seam (§2.3 requirements ledger, §2.5 mutable
// tail region). All injected closures: runtime-core stays store-free; the
// composition root (memory-service, PR 10) constructs them over the
// continuity store and target emitters thread them (PR 11).
// ---------------------------------------------------------------------------

/**
 * Hard cap (chars) on the RENDERED mutable tail — the `<current_plan>` +
 * `<requirements_ledger>` blocks appended after the cache-marked frozen
 * prefix on every model call. The spec's `continuity.focusMaxChars` lowers
 * onto this in PR 11; until then the default applies. Enforced in
 * `renderContinuityTail`: the ledger has priority (it is the
 * motivating-failure fix), truncating oldest-first with a marker; the plan
 * yields whatever budget remains.
 */
export const DEFAULT_CONTINUITY_TAIL_MAX_CHARS = 4096;

/**
 * Cap (chars, ~16KB) on the in-run requirements ledger's total entry text.
 * Oldest entries are evicted first and the rendered block gains a
 * `[ledger truncated]` marker — user messages are small, so hitting this
 * means hundreds of evicted requirements.
 */
export const CONTINUITY_LEDGER_MAX_CHARS = 16 * 1024;

/**
 * Key in the per-run `runState` state-store that plan-mutating tools
 * (PlanUpdate/FocusWrite, PR 7) set to `true` after a write. The loop
 * re-reads it before each model call and re-renders the `<current_plan>`
 * tail block via `continuity.onPlanDirty` when set — the state-store's
 * first consumer.
 */
export const PLAN_DIRTY_STATE_KEY = "plan.dirty";

/** Role attribution on an evicted-content record (§2.3): `"user"` for user
 *  text, `"assistant"` for assistant text, `"tool"` for tool_result content
 *  (which the API carries inside user-role messages). */
export type ContextEvictedRole = "user" | "assistant" | "tool";

/** One verbatim evicted-content record — the `context_evicted` event payload
 *  and the requirements-ledger entry shape. */
export type ContinuityLedgerEntry = {
  readonly role: ContextEvictedRole;
  readonly text: string;
  readonly turnNumber?: number;
};

/**
 * §2.5 — the deterministic teardown handoff payload. Built with ZERO model
 * calls from state the run already holds: the last rendered plan snapshot,
 * the in-run ledger entries verbatim, the session id, and why the run
 * stopped (the same reason the `stop` hook receives).
 */
export type HandoffInput = {
  /** Last `<current_plan>` content from `loadPlan`/`onPlanDirty`; null when
   *  the plan store is empty or the seam never produced one. */
  readonly plan: string | null;
  /** The in-run requirements ledger, oldest-first, verbatim. */
  readonly ledger: ReadonlyArray<ContinuityLedgerEntry>;
  readonly sessionId: string;
  readonly stopReason: "complete" | "exit" | "abort";
};

/** compaction-snip's marker message — filtered out of eviction records (it
 *  is runtime scaffolding, not conversation content). */
const SNIP_MARKER_RE = /^\[Context compacted: \d+ messages removed\]$/;

/**
 * §2.3 — decompose one message that compaction is about to drop into
 * verbatim `context_evicted` records. Text-bearing content only: user/
 * assistant text becomes one entry per message (blocks joined with `\n` so
 * the record IS the message, not fragments), each `tool_result`'s text
 * becomes a `"tool"` entry. `tool_use` inputs are skipped — they already
 * persist verbatim as `tool_use` event-log lines. The snip marker is
 * dropped. Exported for tests.
 */
export function extractEvictedEntries(message: Anthropic.MessageParam): ContinuityLedgerEntry[] {
  const textRole: ContextEvictedRole = message.role === "user" ? "user" : "assistant";
  if (typeof message.content === "string") {
    if (message.content.length === 0 || SNIP_MARKER_RE.test(message.content)) return [];
    return [{ role: textRole, text: message.content }];
  }
  const entries: ContinuityLedgerEntry[] = [];
  const texts: string[] = [];
  for (const block of message.content) {
    const b = block as { type?: string; text?: unknown; content?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      texts.push(b.text);
    } else if (b.type === "tool_result") {
      const c = b.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .map((inner) => {
                  const i = inner as { type?: string; text?: unknown };
                  return i.type === "text" && typeof i.text === "string" ? i.text : "";
                })
                .filter((t) => t.length > 0)
                .join("\n")
            : "";
      if (text.length > 0) entries.push({ role: "tool", text });
    }
  }
  if (texts.length > 0) {
    const joined = texts.join("\n");
    if (!SNIP_MARKER_RE.test(joined)) entries.push({ role: textRole, text: joined });
  }
  return entries;
}

const LEDGER_TRUNCATED_MARKER = "[ledger truncated]";
const PLAN_TRUNCATED_MARKER = "[plan truncated to fit the tail cap]";

/**
 * §2.5 — render the mutable tail region: the `<current_plan>` block and the
 * `<requirements_ledger>` block, hard-capped at `maxChars` (default
 * {@link DEFAULT_CONTINUITY_TAIL_MAX_CHARS}). Pure and deterministic;
 * exported for tests.
 *
 * Cap enforcement, in priority order:
 *  1. The ledger block drops its OLDEST entries first (they are the
 *     time-ordered content) until it fits, gaining the
 *     `[ledger truncated]` marker — the newest requirements always survive.
 *  2. The plan gets whatever budget remains; an over-budget plan keeps its
 *     HEAD (focus/next-steps render first in plan documents) and gains a
 *     trailing truncation marker. A remainder too small for any plan
 *     content drops the plan block entirely — the ledger is the
 *     motivating-failure fix and always wins.
 *
 * Closing delimiters inside plan/ledger content are neutralized so
 * embedded `</current_plan>` / `</requirements_ledger>` text cannot
 * terminate its wrapper block early (same defense as `<recalled_memory>`).
 */
export function renderContinuityTail(input: {
  readonly plan: string | null;
  readonly ledger: ReadonlyArray<ContinuityLedgerEntry>;
  readonly ledgerTruncated?: boolean;
  readonly maxChars?: number;
}): string[] {
  const maxChars = input.maxChars ?? DEFAULT_CONTINUITY_TAIL_MAX_CHARS;

  const renderLedger = (
    entries: ReadonlyArray<ContinuityLedgerEntry>,
    truncated: boolean,
  ): string => {
    const lines = entries.map((e) => {
      const attribution = e.turnNumber !== undefined ? `(user, turn ${e.turnNumber})` : "(user)";
      return `- ${attribution} ${escapeBoundaryDelimiter(e.text, "requirements_ledger")}`;
    });
    const body = [...(truncated ? [LEDGER_TRUNCATED_MARKER] : []), ...lines].join("\n");
    return `<requirements_ledger>\nUser requirements preserved verbatim before context compaction — they remain binding even though the original messages were evicted:\n${body}\n</requirements_ledger>`;
  };

  // 1. Ledger block, oldest-first eviction until it fits the cap alone.
  let ledgerBlock: string | undefined;
  if (input.ledger.length > 0) {
    let entries = [...input.ledger];
    let truncated = input.ledgerTruncated === true;
    ledgerBlock = renderLedger(entries, truncated);
    while (ledgerBlock.length > maxChars && entries.length > 1) {
      entries = entries.slice(1);
      truncated = true;
      ledgerBlock = renderLedger(entries, truncated);
    }
    if (ledgerBlock.length > maxChars) {
      // A single entry alone exceeds the cap — keep its NEWEST chars.
      const last = entries[0] as ContinuityLedgerEntry;
      const clipped = last.text.slice(Math.max(0, last.text.length - maxChars));
      ledgerBlock = renderLedger([{ ...last, text: clipped }], true).slice(0, maxChars);
    }
  }

  // 2. Plan block within the remaining budget.
  let planBlock: string | undefined;
  const planText = input.plan;
  if (planText !== null && planText.trim().length > 0) {
    const remaining = maxChars - (ledgerBlock !== undefined ? ledgerBlock.length : 0);
    const escaped = escapeBoundaryDelimiter(planText, "current_plan");
    const wrap = (body: string): string => `<current_plan>\n${body}\n</current_plan>`;
    const overhead = wrap("").length + PLAN_TRUNCATED_MARKER.length + 1;
    if (remaining > overhead) {
      const full = wrap(escaped);
      planBlock =
        full.length <= remaining
          ? full
          : wrap(`${escaped.slice(0, remaining - overhead)}\n${PLAN_TRUNCATED_MARKER}`);
    }
  }

  const blocks: string[] = [];
  if (planBlock !== undefined) blocks.push(planBlock);
  if (ledgerBlock !== undefined) blocks.push(ledgerBlock);
  return blocks;
}

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
export { JANITOR_BUILTIN_STEPS } from "./janitor";
export type {
  CreateJanitorOptions,
  Janitor,
  JanitorBuiltinStepName,
  JanitorReservationStore,
  JanitorRunResult,
  JanitorStep,
  JanitorStepName,
  JanitorStepOutcome,
  JanitorStepResult,
  JanitorStepStatus,
} from "./janitor";

// Loop contract 0.4 (Batch C, item 4) — agent identity generation. Lives in
// its own module (`./identity`) but is re-exported here because emitted
// bundles and the CLI only import the package root. The CLI calls
// `loadOrCreateAgentIdentity()` at boot and threads the resulting `agentId`
// into `RunChatLoopOptions.agentId` (and onto any bus it constructs itself).
export {
  AGENT_IDENTITY_SCHEMA_VERSION,
  DEFAULT_IDENTITY_DIR,
  IDENTITY_FILENAME,
  agentFingerprint,
  loadOrCreateAgentIdentity,
} from "./identity";
export type { AgentIdentityFile } from "./identity";

// Loop contract 0.4 (Batch C, G11) — the pending-approval persistence seam is
// owned by `@crewhaus/session-store`; re-exported here so the CLI/codegen can
// build the store + input hash it passes as `RunChatLoopOptions.approvals`
// without depending on session-store directly.
export {
  type ApprovalDecision,
  type PendingApproval,
  type PendingApprovalStore,
  type PendingApprovalStoreOptions,
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";

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

/**
 * Loop contract 0.4 (G02) — the observable output of ONE completed
 * user→assistant turn, handed to the injected in-loop evaluator. A "turn"
 * here is the whole tool inner-loop until the state machine reaches Done —
 * the evaluator NEVER sees tool-only intermediate iterations.
 */
export type EvaluationTurn = {
  /**
   * Concatenated text of the terminal assistant message (`""` when the
   * turn produced no text blocks). This is exactly the string a
   * `singleTurn` run returns to its caller.
   */
  readonly finalText: string;
  /**
   * The full conversation history as of turn completion (read-only view —
   * evaluators must not mutate it; the runtime owns the array).
   */
  readonly messages: ReadonlyArray<Anthropic.MessageParam>;
  /**
   * Aggregate token usage across every MAIN-turn model call this attempt
   * made (all tool iterations included; compaction/judge side-calls are
   * not main-turn calls and are excluded). On an evaluation-triggered
   * retry the re-run attempt gets a fresh accumulator, so each `evaluate`
   * invocation sees the usage of exactly the attempt it is grading.
   */
  readonly usage: ModelUsage;
};

/** The injected grader's verdict for one graded attempt. */
export type EvaluationResult = {
  /** Score in [0,1]; compared against `threshold` (>= passes). A non-finite
   *  score is treated as 0 (fail) defensively. */
  readonly score: number;
  /** Grader explanation; appended to the retry nudge when `onFail: "retry"`. */
  readonly rationale?: string;
};

/**
 * Loop contract 0.4 (G02) — the in-loop evaluation seam (spec
 * `evaluation:` on cli/channel/managed). See
 * {@link RunChatLoopOptions.evaluation} for semantics.
 */
export type RunEvaluation = {
  /**
   * The grader, INJECTED by the caller (target emitters construct it from
   * the IR's `evaluation.grader` — an llm_judge side-call or a
   * deterministic contains/regex check). runtime-core never constructs a
   * judge itself, so it gains no eval dependency. A grader that throws is
   * treated as grading INFRASTRUCTURE failure, not a verdict: the error is
   * logged (`error` event) and the turn stands un-gated (fail-open) — a
   * flaky judge model must not kill an otherwise healthy run.
   */
  readonly evaluate: (turn: EvaluationTurn) => Promise<EvaluationResult>;
  /** Passing bar: `score >= threshold` passes. (The compiler resolves the
   *  spec default: 0.7 for llm_judge; deterministic graders use 1.) */
  readonly threshold: number;
  /** What a failing verdict does — see the option docblock. */
  readonly onFail: "retry" | "halt" | "note";
  /** Hard cap on evaluation-triggered re-runs (>= 0; resolved default 1). */
  readonly maxRetries: number;
  /**
   * Which grader kind produced the score — stamped verbatim onto every
   * `eval_graded` trace event (the event field is required, and only the
   * caller knows what it built `evaluate` from).
   */
  readonly graderType: "llm_judge" | "contains" | "regex";
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
    /**
     * Loop contract 0.4 (Batch E, G21) — WHEN auto-recall runs, lowered from
     * `IrMemory.recallMode`. `"session-start"` (the implicit default) recalls
     * ONCE at boot into the frozen, cache-marked system prefix — the pre-0.4
     * behaviour. `"per-turn"` instead re-runs `recall` against the LATEST user
     * message every `refreshEvery` turns and swaps a VOLATILE recalled block
     * that sits in the mutable tail region (alongside the continuity tail),
     * NEVER re-injecting into the frozen cache prefix — so a long daemon's
     * recalled evidence tracks the conversation instead of drifting from a
     * stale boot-time snapshot. Requires `recall` + `autoRecall: true`.
     */
    readonly recallMode?: "session-start" | "per-turn";
    /**
     * Loop contract 0.4 (Batch E, G21) — turns between per-turn recall
     * refreshes (`IrMemory.refreshEvery`, int > 0; runtime clamps to >= 1 and
     * defaults to 1). Only meaningful when `recallMode` is `"per-turn"`.
     */
    readonly refreshEvery?: number;
  };
  /**
   * Loop contract 0.4 (Batch E, G19) — the active-context curation pre-pass
   * (spec `compaction.curate`, lowered from `IrCompaction`; presence GATES the
   * pass). Once the pre-turn compaction ladder decides the context is already
   * approaching the limit, the runtime runs `@crewhaus/compaction-curator`
   * BEFORE snip→autocompact: it drops semantically-duplicate transcript
   * messages (embedding cosine when an `embedder` is injected, a BM25-family
   * lexical fallback when not) and — when `relevanceTopK` is set — keeps only
   * the top-K most relevant to the latest user message, re-sorted back into
   * transcript order (the curator's relevance ranking SELECTS survivors; it
   * never scrambles the conversation, and messages carrying tool_use/tool_result
   * pairs or inside the snip-protected head/tail are never touched). When the
   * pass frees enough headroom the expensive summarizer call is skipped
   * entirely. Every pass publishes a `curate` trace event
   * (`before`/`after`/`dropped`/`bytesSaved`/`embedded`). The embedder is
   * INJECTED (runtime-core carries no embedder dependency): callers resolve it
   * from `memory.embedder ?? memory.wiki.embedder`; absent → lexical dedupe
   * (`embedded: false`). Absent block → no curation, byte-identical to a
   * pre-0.4 runtime.
   */
  curate?: {
    readonly embedder?: EmbedderFn;
    readonly dedupeThreshold?: number;
    readonly relevanceTopK?: number;
  };
  /**
   * v0.3.0 Goal 1 — the continuity seam (§2.3 requirements ledger, §2.5
   * mutable tail region, §2.8 handoff). Injected closures exactly like
   * `memory` above: the composition root (memory-service) constructs them
   * over the continuity store; runtime-core never touches a store.
   *
   * When present:
   *  - A VOLATILE TAIL of system blocks (`<current_plan>` +
   *    `<requirements_ledger>`) is rebuilt on every model call and appended
   *    AFTER the cache-marked frozen prefix, so tail edits re-tokenize only
   *    the tail (see prompt-cache-manager's `volatile` flag). The rendered
   *    tail is hard-capped at {@link DEFAULT_CONTINUITY_TAIL_MAX_CHARS}.
   *  - `loadPlan` renders the initial `<current_plan>` content at boot;
   *    `onPlanDirty` re-renders it when a tool has set
   *    `"plan.dirty": true` in the per-run state-store (reachable via the
   *    RuntimeBridge's `runState`); absent `onPlanDirty` falls back to
   *    `loadPlan`.
   *  - `ledger !== false` (the default) turns on the requirements ledger —
   *    the deterministic fix for the release's motivating failure: every
   *    USER message compaction is about to drop is appended VERBATIM to the
   *    session event log as a `context_evicted` event and folded into the
   *    in-run ledger ({@link CONTINUITY_LEDGER_MAX_CHARS} cap, oldest-first
   *    eviction), which re-injects on every model call — the user's answer
   *    survives any number of compactions regardless of summary quality.
   *    Evicted assistant text and tool findings are also persisted as
   *    `context_evicted` events (episodic externalization for a later
   *    recall integration). `--resume` rebuilds the ledger from the logged
   *    events. The autocompact summarizer's prompt receives the ledger text
   *    as an anchor, but nothing depends on the summary being right.
   *  - `onHandoff` fires ONCE at teardown (the same finally slot as
   *    `memory.onCapture`) with a deterministic {@link HandoffInput} — no
   *    model calls.
   *
   * ABSENT → byte-identical behavior to a pre-0.3.0 runtime: no tail
   * blocks, no `context_evicted` events, no ledger anchor in the compaction
   * prompt, no handoff (regression-pinned in continuity.test.ts).
   */
  continuity?: {
    /** Rendered `<current_plan>` tail content, or null when no plan exists. */
    readonly loadPlan: () => Promise<string | null>;
    /** Re-render after a Plan/Goal mutation (the `plan.dirty` flag). */
    readonly onPlanDirty?: () => Promise<string | null>;
    /** `context_evicted` externalization + reinjection. Default: true. */
    readonly ledger?: boolean;
    /** Deterministic teardown handoff write. */
    readonly onHandoff?: (input: HandoffInput) => Promise<void>;
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
   * Adaptive model routing (spec `agent.model_pool`). When set, every
   * candidate adapter resolves at boot and each turn a `PolicyRouter` selects
   * one from deterministic signals (`static`/`heuristic`) or the durable reward
   * scoreboard (`learned`), publishing a `model_route` trace event. After each
   * turn the observed outcome (success, latency, cost) is folded into the
   * scoreboard so selection improves the more the harness runs. Mutually
   * exclusive with `modelTiers`/`modelFallbacks` (enforced in the spec); the
   * pool takes precedence if all are somehow set. Absent → single-model path.
   */
  modelPool?: {
    readonly candidates: ReadonlyArray<{
      readonly model: string;
      readonly tags: readonly string[];
    }>;
    readonly policy: "static" | "heuristic" | "learned";
    readonly objective?: {
      readonly quality?: number;
      readonly cost?: number;
      readonly latency?: number;
    };
    readonly routing?: {
      readonly contextTokenThreshold?: number;
      readonly toolsToDefault?: boolean;
      readonly firstTurnToDefault?: boolean;
      readonly priorToolDensityThreshold?: number;
      readonly strongTag?: string;
      readonly cheapTag?: string;
    };
    readonly learning?: {
      readonly minSamplesPerArm?: number;
      readonly costRefUsd?: number;
      readonly latencyRefMs?: number;
      readonly explorationRate?: number;
      readonly seed?: string;
      readonly bandit?: "epsilon-greedy" | "thompson";
    };
  };
  /**
   * Test injection for the pool candidate adapters, keyed by their spec model
   * string (mirrors `_tierAdapters`). Production callers leave it undefined.
   */
  _poolAdapters?: ReadonlyMap<string, ProviderAdapter>;
  /**
   * Test injection for the reward scoreboard. Production callers leave it
   * undefined (the runtime opens a file-backed scoreboard beside the sessions
   * dir); tests inject an in-memory or tmp-dir instance to assert learning.
   */
  _scoreboard?: Scoreboard;
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
   * `prompt-cache-manager.manage()` once at run start; a valid recent
   * timestamp makes `manage()` skip, so the run REUSES the existing cached
   * prefix instead of force-rotating (and cold-starting the cache) at every
   * boot. Pass `0` (or omit) to force a refresh on the first turn.
   *
   * v0.3.0 Goal 1 (§2.5) — the cross-run bookkeeping is live now: a
   * rotation publishes a `cache_rotation` trace event and invokes
   * `onPromptCacheRotated` with the fresh timestamp so the caller can
   * persist it and thread it back here on the next run (store wiring lands
   * with memory-service/threading, PR 10/11).
   */
  promptCacheLastRotatedAt?: number;
  /**
   * v0.3.0 Goal 1 (§2.5) — invoked once at boot IF `manage()` injected a
   * fresh cache marker, with the `rotatedAt` timestamp to persist. The
   * caller threads the persisted value back as `promptCacheLastRotatedAt`
   * on the next run, which stops the boot-time force-rotation. Best-effort:
   * a persist failure is logged and never aborts the run.
   */
  onPromptCacheRotated?: (rotatedAt: number) => void | Promise<void>;
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
  /**
   * Loop contract 0.4 (G10) — whole-run wall-clock ceiling in ms (spec
   * `limits.deadline_ms`). Armed once at loop start; on fire it aborts the
   * ROOT of the abort tree (`runAbort`) with a branded reason, the in-flight
   * turn winds down through the normal cancellation paths, and the run ends
   * with a classified `run_failed` (class `"timeout"`, exit
   * `EXIT_CODES.timeout`) + `RunFailedError` throw — in REPL mode too (a
   * deadline is terminal everywhere, including while idle at the prompt).
   * Absent → no timer (zero behaviour change).
   */
  deadlineMs?: number;
  /**
   * Loop contract 0.4 (G10) — per-turn wall-clock ceiling in ms (spec
   * `limits.turn_timeout_ms`). Armed when a user→assistant turn starts and
   * cleared when it ends; on fire it aborts the TURN (`turnAbort`) with a
   * branded reason, cancelling the in-flight model call / tool children.
   * In `singleTurn` mode the turn IS the run, so the stop is terminal:
   * classified `run_failed` (class `"timeout"`) + `RunFailedError`. In REPL
   * mode it mirrors the first-SIGINT semantics — the turn aborts with a
   * printed notice and an `error` event (name `"TurnTimeout"`), and the
   * session continues at the prompt (no `run_failed`: the run didn't end).
   */
  turnTimeoutMs?: number;
  /**
   * Loop contract 0.4 (G10) — per-model-call wall-clock ceiling in ms (spec
   * `limits.model_call_timeout_ms`), the hung-stream watchdog. Re-armed
   * before EVERY main-turn stream and cleared when the stream drains; on
   * fire it aborts the turn (`turnAbort` — the turn cannot proceed without
   * its model call) with a branded reason. Terminal/REPL posture identical
   * to `turnTimeoutMs` (error-event name `"ModelCallTimeout"`). Note: under
   * `streaming: true` the drain overlaps mid-stream tool dispatch, so the
   * window covers those tools too — use `turnTimeoutMs` for tool-inclusive
   * bounds and keep this one comfortably above normal stream latency.
   */
  modelCallTimeoutMs?: number;
  /**
   * Loop contract 0.4 (G27) — tool-loop detection tuning + escalation
   * ladder (spec `limits.loop_detection`). `window`/`threshold` thread to
   * `@crewhaus/tool-loop-detection.detectLoop` (defaults 10 / 3). The
   * detector now has a NEAR-DUPLICATE tier — same tool, inputs identical
   * after volatile-substring stripping (numbers/UUIDs/hashes/whitespace),
   * counted at reduced weight — so trivial argument churn no longer defeats
   * it. `escalation` picks what happens when a signature trips detection
   * AGAIN after its one-time warning was ignored:
   *   - `"warn"` (default) — nothing further; byte-identical to the pre-0.4
   *     warn-once behaviour.
   *   - `"justify"` — inject a requireJustification-STYLE demand as a
   *     synthetic user message: the model must state a one-sentence
   *     justification tied to the session goal before repeating the call.
   *     (Deliberately NOT the permission-engine justification gate: that
   *     gate is a per-tool-descriptor compile-time contract whose schema
   *     advertises a `justification` input field — retrofitting descriptors
   *     mid-run would change the advertised tool schema under the model.
   *     The synthetic nudge is the proportionate in-band mechanism.)
   *   - `"abort"` — abort the TURN, ToolLoopLimit-style: an `error` event
   *     (name `"ToolLoopAbort"`) is logged and the state machine takes the
   *     Aborted transition, exactly like the `maxToolIterations` cap.
   */
  loopDetection?: {
    readonly window?: number;
    readonly threshold?: number;
    readonly escalation?: "warn" | "justify" | "abort";
  };
  /**
   * Loop contract 0.4 (G17) — per-tool rate limits (spec
   * `agent.rate_limits`): tool name (or `"*"` for the every-tool default)
   * → sustained `rpm` + optional short-burst allowance. At loop start the
   * runtime builds a `@crewhaus/rate-limiter` with one token bucket per
   * entry (`refillPerSec = rpm/60`, `capacity = burst ?? rpm`) and every
   * tool execution acquires `tool:<name>` BEFORE dispatch (after the
   * permission/justification/egress gates, so denied calls never consume
   * tokens). Tools with neither a named bucket nor a `"*"` default are not
   * gated. An acquire that exhausts the limiter's wait budget fails just
   * that call with an `is_error` tool_result (`[rate-limited] …`) so the
   * model can adapt — it never kills the run. Independent of the
   * model-call `rateLimiter`/`rateLimitKeys` pair above.
   */
  rateLimits?: Readonly<Record<string, { readonly rpm: number; readonly burst?: number }>>;
  /**
   * Loop contract 0.4 (G01) — extended thinking for every MAIN-TURN model
   * stream (spec `thinking`; same two forms as `IrThinking`). Compaction
   * and judge side-calls are deliberately untouched — they build their own
   * `ProviderRequest`s and summarization/grading gains nothing from
   * spending thinking tokens.
   *   - `{ budgetTokens }` → `ProviderRequest.thinking =
   *     { type: "enabled", budget_tokens }` verbatim.
   *   - `{ effort }` → BOTH fields are set: `thinking` converted through
   *     `EFFORT_THINKING_BUDGET_TOKENS` (for budget-style providers:
   *     anthropic/bedrock/gemini) AND `reasoningEffort` passed through (for
   *     native-effort providers: openai). Adapters ignore the field they
   *     don't support; anthropic's translate gives an explicit `thinking`
   *     precedence, so setting both is convergent.
   * When the resolved budget crowds out the output budget (Anthropic
   * requires `max_tokens > thinking.budget_tokens`), the per-request token
   * ceiling is lifted to `budget + maxTokens` so the declared output budget
   * survives intact (logged once at boot).
   */
  thinking?: { readonly budgetTokens: number } | { readonly effort: "low" | "medium" | "high" };
  /**
   * Loop contract 0.4 (G02) — in-loop evaluation of every COMPLETED turn
   * (spec `evaluation:` on cli/channel/managed; both `singleTurn` and REPL
   * paths). After the turn's tool inner-loop reaches Done — never on a
   * tool-only intermediate iteration — the injected `evaluate` grades the
   * terminal assistant text and one `eval_graded` trace event is published
   * per grading pass (`retryIndex` 0 for the original attempt, n for the
   * n-th evaluation-triggered retry). On `score < threshold`:
   *
   *  - `onFail: "retry"` — the grader rationale is appended to history as a
   *    synthetic corrective user message (event-logged `synthetic: true`,
   *    like the recovery/loop nudges) and the turn re-runs, up to
   *    `maxRetries` times. Each re-run makes REAL model calls, so its spend
   *    accrues through the existing cost path (`model_response` → budget
   *    meter) and counts against `budget:` exactly like any other call.
   *    Retries exhausted → the last attempt stands and the run continues
   *    (the failing verdict trail is on the trace bus).
   *  - `onFail: "halt"` — classified terminal stop: `run_failed` (class
   *    `"evaluation"`, exit {@link EXIT_CODES.evaluation}) is published +
   *    event-logged and the matching `RunFailedError` is thrown, in REPL
   *    mode too (a quality-floor halt is terminal everywhere).
   *  - `onFail: "note"` — the failing `eval_graded` event is the whole
   *    story; the turn stands and the run continues.
   *
   * A turn that ABORTED (SIGINT / wall-clock timer) never completed, so it
   * is not evaluated. Absent → zero behaviour change for existing callers.
   */
  evaluation?: RunEvaluation;
  /**
   * Loop contract 0.4 (Batch C, item 4) — the publishing agent's identity
   * fingerprint (the `agentId` from `loadOrCreateAgentIdentity`). When set AND
   * runChatLoop constructs the run context itself (no `opts.runContext`), the
   * run's `TraceEventBus` is built with this `agentId` so every trace envelope
   * carries it and audit sinks can attribute the run to one agent. When the
   * caller supplies `opts.runContext`, they own `agentId` on its bus (a
   * sub-agent spawner threads the parent's `agentId` into the child bus) and
   * this field is ignored — matching how `runContext` overrides the other
   * per-run construction inputs. Absent → no stamping (byte-identical to a
   * pre-0.4 runtime).
   */
  agentId?: string;
  /**
   * Loop contract 0.4 (Batch C, G11) — how a tool permission that resolves to
   * `ask` behaves on a NON-interactive surface (`permissions.ask_mode`,
   * lowered from the IR; absent ⇒ `"pause"`):
   *   - `"pause"` (default) — WITH an `approvals` store, PARK the run: persist
   *     a `PendingApproval`, publish `approval_requested`, and end with the
   *     `approval_pending` failure class so the call can be granted/denied out
   *     of band and re-resolved on the next execution. WITHOUT an `approvals`
   *     store there is nowhere to park, so it collapses to the pre-0.4 deny.
   *   - `"deny"` — the pre-0.4 collapse-in-place: the ask denies immediately
   *     with a note (never parks), regardless of any `approvals` store.
   * The interactive REPL path is unaffected either way — an `ask` there always
   * prompts on stdin.
   */
  askMode?: "pause" | "deny";
  /**
   * Loop contract 0.4 (Batch C, G11) — the pending-approval seam. When
   * supplied AND `askMode` is `"pause"` (the default), a headless `ask`
   * consults `store.get(toolName, inputHash)`:
   *   - a `"grant"` → allow this ONE call (the grant is one-shot: consumed via
   *     `store.persist`, so a later identical call re-asks);
   *   - a `"deny"` → deny with a note;
   *   - nothing yet → persist a fresh `PendingApproval`, fire `notify` (if
   *     given), publish `approval_requested`, and PARK the run.
   * The store is injected (the CLI builds `createPendingApprovalStore`); the
   * `surface` classifier stamps the `approval_requested` event (defaults to
   * `"single-turn"` under `singleTurn`, else `"headless"`). Omitted → no
   * parking (headless `ask` collapses to the pre-0.4 deny).
   */
  approvals?: {
    /**
     * The persistence seam. Only `{ persist, get, resolve }` are contracted;
     * the runtime calls `get` (look up a prior decision) and `persist` (park a
     * fresh request / consume a one-shot grant), while `resolve` is the
     * out-of-band CLI/Slack surface's entry point on the SAME store. Narrowed
     * from the full `PendingApprovalStore` so a caller may inject a minimal
     * store; the concrete `createPendingApprovalStore` satisfies it.
     */
    readonly store: Pick<PendingApprovalStore, "persist" | "get" | "resolve">;
    readonly notify?: (approval: PendingApproval) => Promise<void>;
    readonly surface?: string;
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

/**
 * A short, stable fingerprint of a `model_pool` config, stamped on every
 * `model_route` event as `policyVersion` so a learned decision can be tied back
 * to the exact policy that made it. Deterministic (djb2 over the candidate
 * roster + policy + objective) — no clock, no randomness.
 */
function poolFingerprint(pool: {
  readonly candidates: ReadonlyArray<{ readonly model: string; readonly tags: readonly string[] }>;
  readonly policy: string;
  readonly objective?: {
    readonly quality?: number;
    readonly cost?: number;
    readonly latency?: number;
  };
}): string {
  const canonical = JSON.stringify({
    p: pool.policy,
    c: pool.candidates.map((c) => [c.model, [...c.tags].sort()]),
    o: pool.objective ?? null,
  });
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++)
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
  return `pool-${hash.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Loop contract 0.4 (G10) — wall-clock stops. Three configurable timers
// (`deadlineMs` / `turnTimeoutMs` / `modelCallTimeoutMs`) fire through the
// EXISTING abort tree (`runAbort` for the deadline, `turnAbort` for the two
// turn-scoped limits) with a BRANDED abort reason, so the run winds down
// through the same cancellation paths a SIGINT uses — in-flight model
// streams reject on their `signal`, tool children cascade — and the loop can
// afterwards tell a timeout stop from a user abort and classify it.
// ---------------------------------------------------------------------------

/** Which configured limit fired. `run` = `limits.deadline_ms`,
 *  `turn` = `limits.turn_timeout_ms`, `model_call` = `limits.model_call_timeout_ms`. */
export type TimeoutScope = "run" | "turn" | "model_call";

/** The branded abort reason a G10 timer aborts with. Carried on
 *  `AbortSignal.reason` (the abort tree propagates reasons parent→child, so
 *  a run-deadline reason is visible on the turn signal too). */
export type TimeoutAbortReason = {
  readonly crewhausTimeout: TimeoutScope;
  readonly limitMs: number;
};

/** Read the branded timeout reason off an aborted signal, or undefined when
 *  the signal is not aborted / was aborted for another cause (SIGINT, EOF). */
export function timeoutAbortReason(signal: AbortSignal): TimeoutAbortReason | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason as { crewhausTimeout?: unknown; limitMs?: unknown } | null;
  if (reason === null || typeof reason !== "object") return undefined;
  const scope = reason.crewhausTimeout;
  if (scope !== "run" && scope !== "turn" && scope !== "model_call") return undefined;
  return {
    crewhausTimeout: scope,
    limitMs: typeof reason.limitMs === "number" ? reason.limitMs : 0,
  };
}

/** Spec key each scope lowers from — used in detail/remediation copy. */
const TIMEOUT_SPEC_KEYS: Readonly<Record<TimeoutScope, string>> = {
  run: "limits.deadline_ms",
  turn: "limits.turn_timeout_ms",
  model_call: "limits.model_call_timeout_ms",
};

const TIMEOUT_TITLES: Readonly<Record<TimeoutScope, string>> = {
  run: "run deadline exceeded",
  turn: "turn wall-clock limit exceeded",
  model_call: "model call wall-clock limit exceeded",
};

/**
 * G10 — build the classified terminal report for a fired wall-clock limit.
 * `class: "timeout"` / exit {@link EXIT_CODES.timeout} joins the failure
 * taxonomy beside `crewhaus_budget`: like the spend cap, the stop was
 * CrewHaus's OWN configured ceiling, not a provider failure. Exported for
 * emitters/tests that render or assert on the report.
 */
export function buildTimeoutFailureReport(timeout: TimeoutAbortReason): FailureReport {
  const scope = timeout.crewhausTimeout;
  return {
    class: "timeout",
    title: TIMEOUT_TITLES[scope],
    detail: `the configured ${TIMEOUT_SPEC_KEYS[scope]} (${timeout.limitMs}ms) elapsed before the ${
      scope === "run" ? "run" : scope === "turn" ? "turn" : "model call"
    } completed`,
    remediation: `raise ${TIMEOUT_SPEC_KEYS[scope]} in the spec's limits block (or remove it), then rerun.`,
    exitCode: EXIT_CODES.timeout,
  };
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

  // Item 4 / G28 — the provider's ACTUAL input_tokens (input + cache read +
  // cache create) from the MOST RECENT `model_response`. Updated after every
  // main-turn model call; feeds the pre-turn compaction trigger and the
  // tier/pool routing `contextTokens` signal a real count instead of the
  // chars/4 heuristic. `undefined` before the first response — the heuristic
  // is used only pre-first-call.
  let lastModelInputTokens: number | undefined;
  /** The context-size signal for routing/compaction: the provider's real
   *  last-call input_tokens once available, else the chars/4 estimate. */
  const contextTokenSignal = (msgs: ReadonlyArray<Anthropic.MessageParam>): number =>
    lastModelInputTokens ?? estimateTokens(msgs);

  // Default model max OUTPUT tokens for one turn. Callers thread the spec's
  // `agent.max_tokens` here when set (the CLI target's codegen + apps/cli);
  // this fallback applies when the spec is silent. Kept comfortably above the
  // old 4096 floor so a single turn that writes a few files no longer truncates
  // mid-`tool_use` by default — every supported Claude model accepts >= 8192
  // output tokens. A truncation is no longer fatal regardless (see the
  // `max_tokens` recovery + `sanitizeOrphanToolUses`), but a higher ceiling
  // avoids the churn. Raise it per spec with `agent.max_tokens`.
  const maxTokens = opts.maxTokens ?? 8192;

  // G01 — resolve the extended-thinking request fields ONCE at boot. The
  // budget form maps verbatim; the effort form sets BOTH `thinking`
  // (converted through the shared preset table for budget-style providers)
  // and `reasoningEffort` (passed through for native-effort providers) —
  // adapters ignore whichever field they don't support, and anthropic's
  // translate gives the explicit `thinking` precedence, so the two agree.
  const thinkingRequest:
    | {
        readonly thinking: { readonly type: "enabled"; readonly budgetTokens: number };
        readonly reasoningEffort?: ReasoningEffort;
      }
    | undefined =
    opts.thinking === undefined
      ? undefined
      : "budgetTokens" in opts.thinking
        ? { thinking: { type: "enabled", budgetTokens: opts.thinking.budgetTokens } }
        : {
            thinking: {
              type: "enabled",
              budgetTokens: EFFORT_THINKING_BUDGET_TOKENS[opts.thinking.effort],
            },
            reasoningEffort: opts.thinking.effort,
          };
  // Anthropic (and the other budget-style providers) require
  // `max_tokens > thinking.budget_tokens` — thinking tokens spend from the
  // same output ceiling. When the configured budget crowds the ceiling out,
  // lift the per-request ceiling to `budget + maxTokens` so the declared
  // output budget survives intact instead of 400-ing every call (e.g.
  // `effort: high` = 24576 over the 8192 default). The spec-declared
  // `maxTokens` stays the bridge/sub-agent value — only main-turn requests
  // (the only ones that carry `thinking`) use the lifted ceiling.
  const effectiveMaxTokens =
    thinkingRequest !== undefined && thinkingRequest.thinking.budgetTokens >= maxTokens
      ? thinkingRequest.thinking.budgetTokens + maxTokens
      : maxTokens;

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

  // Adaptive model routing (spec `agent.model_pool`). Resolve every candidate
  // adapter ONCE at boot (mirroring the tier router), open the durable reward
  // scoreboard beside the sessions dir, and build the PolicyRouter. The
  // scoreboard is opened whenever a pool is present — not just for `learned` —
  // so `route status` has data and a later switch to `learned` inherits the
  // accumulated history. `recordPoolOutcome`/`poolCostUsd` fold each turn's
  // observed result back in; they no-op when no pool is active.
  let poolRouter: PolicyRouter | undefined;
  let scoreboard: Scoreboard | undefined;
  let rewardConfig: RewardConfig | undefined;
  let poolPolicyVersion: string | undefined;
  if (opts.modelPool !== undefined) {
    const pool = opts.modelPool;
    const candidates: PoolCandidate[] = [];
    for (const c of pool.candidates) {
      const injected = opts._poolAdapters?.get(c.model);
      if (injected !== undefined) {
        candidates.push({
          adapter: injected,
          modelId: bestEffortWireModelId(c.model),
          modelString: c.model,
          tags: c.tags,
        });
      } else {
        const r = await resolveModel(c.model);
        candidates.push({
          adapter: r.adapter,
          modelId: r.modelId,
          modelString: c.model,
          tags: c.tags,
        });
      }
    }
    const routingRoot = sessionRootDir !== undefined ? pathDirname(sessionRootDir) : ".crewhaus";
    scoreboard = opts._scoreboard ?? openScoreboard(routingRoot);
    const sb = scoreboard;
    rewardConfig = {
      ...(pool.objective !== undefined ? { objective: pool.objective } : {}),
      ...(pool.learning?.costRefUsd !== undefined ? { costRefUsd: pool.learning.costRefUsd } : {}),
      ...(pool.learning?.latencyRefMs !== undefined
        ? { latencyRefMs: pool.learning.latencyRefMs }
        : {}),
    };
    poolPolicyVersion = poolFingerprint(pool);
    poolRouter = createPolicyRouter({
      candidates,
      policy: pool.policy,
      ...(pool.routing !== undefined ? { routing: pool.routing } : {}),
      ...(pool.learning !== undefined
        ? {
            learning: {
              ...(pool.learning.minSamplesPerArm !== undefined
                ? { minSamplesPerArm: pool.learning.minSamplesPerArm }
                : {}),
              ...(pool.learning.explorationRate !== undefined
                ? { explorationRate: pool.learning.explorationRate }
                : {}),
              ...(pool.learning.bandit !== undefined ? { bandit: pool.learning.bandit } : {}),
            },
          }
        : {}),
      // The learned policy reads the live scoreboard; static/heuristic ignore it.
      ...(pool.policy === "learned" ? { score: (rk, m) => sb.score(rk, m) } : {}),
    });
  }
  // Fold one turn's observed outcome into the scoreboard (no-op without a pool).
  const recordPoolOutcome = (
    turn: { readonly modelString: string; readonly routeKey: string } | undefined,
    obs: { readonly success: boolean; readonly latencyMs: number; readonly costUsd?: number },
  ): void => {
    // Capture into consts so the narrowing survives (they are closed-over lets).
    const sb = scoreboard;
    const rc = rewardConfig;
    if (turn === undefined || sb === undefined || rc === undefined) return;
    sb.record(turn.routeKey, turn.modelString, computeReward(obs, rc), obs);
  };
  // Per-turn USD cost from token usage + the static pricing table. Undefined
  // when the served model isn't on the table (the reward then drops the cost
  // term and reweights over quality + latency).
  const poolCostUsd = (
    provider: ProviderId,
    wireModelId: string,
    usage: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  ): number | undefined => {
    const row = resolvePricing(DEFAULT_PRICING, provider, wireModelId);
    if (row === undefined) return undefined;
    return (
      computeCostMicros(
        row,
        usage.input,
        usage.output,
        usage.cacheRead ?? 0,
        usage.cacheCreate ?? 0,
      ) / 1_000_000
    );
  };

  let sessionId: string;
  let resumedMessages: Anthropic.MessageParam[] | undefined;
  // §2.3 — on resume, the requirements ledger rebuilds DETERMINISTICALLY
  // from the `context_evicted` events already on disk (dedup against
  // re-evictions happens at fold time): a resumed session recovers every
  // externalized user requirement without trusting any summary.
  const resumedLedgerSeed: ContinuityLedgerEntry[] = [];
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
    if (opts.continuity !== undefined && opts.continuity.ledger !== false) {
      for await (const ev of replayLog.read()) {
        if (ev.kind !== "context_evicted") continue;
        const p = ev.payload as { role?: unknown; text?: unknown; turnNumber?: unknown };
        if (p.role === "user" && typeof p.text === "string") {
          resumedLedgerSeed.push({
            role: "user",
            text: p.text,
            ...(typeof p.turnNumber === "number" ? { turnNumber: p.turnNumber } : {}),
          });
        }
      }
    }
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
  //
  // Loop contract 0.4 (Batch C, item 4) — when the caller supplies an
  // `agentId` and lets runChatLoop own the context, build the bus with that
  // identity so `envelope()` stamps every trace event with it. runId is minted
  // here (matching run-context's `run_<8 hex>` shape) and threaded into BOTH
  // the bus and the context so their ids stay coherent. When `opts.runContext`
  // is supplied the caller owns `agentId` on its bus, so this is skipped.
  const runContext: RunContext =
    opts.runContext ??
    (opts.agentId !== undefined
      ? (() => {
          const runId = `run_${randomUUID().slice(0, 8)}`;
          const eventBus = new TraceEventBus({ runId, sessionId, agentId: opts.agentId });
          return createRunContext({ runId, sessionId, eventBus });
        })()
      : createRunContext({ sessionId }));

  // G01 — surface the max-tokens lift once, at boot (see `effectiveMaxTokens`).
  if (effectiveMaxTokens !== maxTokens) {
    runContext.logger.info("thinking budget >= max_tokens — lifting the per-request ceiling", {
      thinkingBudgetTokens: thinkingRequest?.thinking.budgetTokens,
      maxTokens,
      effectiveMaxTokens,
    });
  }

  // Adaptive model routing — ε-greedy exploration seed. A spec-fixed
  // `learning.seed` reproduces exploration across runs (tests); otherwise the
  // sessionId seeds it, so each run explores differently yet still replays
  // exactly from its own transcript. Constant per run; the per-turn draw mixes
  // in turnIndex + band (see PolicyRouter.route).
  const poolSeed = opts.modelPool?.learning?.seed ?? sessionId;

  // Section 15 — every observability subscriber (otel, metrics, printer)
  // hangs off this single bus. The default constructor in `createRunContext`
  // mints a no-subscriber bus; here we attach the env-gated set so a fresh
  // run with `OTEL_EXPORTER_OTLP_ENDPOINT` set automatically exports.
  const bus: TraceEventBus = runContext.eventBus;
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

  // Per-run state container — coordination surface for hooks/skills/tools.
  // Shipped as plumbing in Section 10; v0.3.0 Goal 1 (§2.5) lands its first
  // consumer: plan-mutating tools set `PLAN_DIRTY_STATE_KEY` here (via the
  // RuntimeBridge's `runState`) and `buildContinuityTail` below re-reads it
  // before each model call to re-render the `<current_plan>` tail block.
  const runState: Store<Record<string, unknown>> = createStore({});

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

  // -------------------------------------------------------------------------
  // v0.3.0 Goal 1 — continuity wiring (§2.3 ledger, §2.5 tail, §2.8 handoff).
  // Everything below is inert when `opts.continuity` is absent: no tail
  // blocks, no `context_evicted` events, no ledger anchor, no handoff —
  // byte-identical request payloads to a pre-0.3.0 runtime.
  // -------------------------------------------------------------------------
  const continuity = opts.continuity;
  const continuityLedgerEnabled = continuity !== undefined && continuity.ledger !== false;
  // The in-run requirements ledger: evicted USER messages, oldest-first,
  // verbatim. `ledgerTruncated` flags that oldest entries were dropped at
  // the CONTINUITY_LEDGER_MAX_CHARS cap so the rendered block says so.
  const ledgerEntries: ContinuityLedgerEntry[] = [];
  let ledgerTruncated = false;
  // The last rendered plan snapshot (loadPlan at boot, onPlanDirty on a
  // `plan.dirty` refresh) — also the deterministic handoff's plan field.
  let lastPlanText: string | null = null;
  let handoffFired = false;

  /** Fold one evicted user message into the ledger. Dedupe (role, text) —
   *  a resume seed followed by a live re-eviction of the same replayed
   *  message must not double an entry — then evict oldest-first past the
   *  cap. A single over-cap entry is clipped to its newest chars. */
  const foldLedgerEntry = (entry: ContinuityLedgerEntry): void => {
    if (ledgerEntries.some((e) => e.role === entry.role && e.text === entry.text)) return;
    ledgerEntries.push(entry);
    let total = ledgerEntries.reduce((n, e) => n + e.text.length, 0);
    while (total > CONTINUITY_LEDGER_MAX_CHARS && ledgerEntries.length > 1) {
      const dropped = ledgerEntries.shift() as ContinuityLedgerEntry;
      total -= dropped.text.length;
      ledgerTruncated = true;
    }
    const sole = ledgerEntries[0];
    if (total > CONTINUITY_LEDGER_MAX_CHARS && ledgerEntries.length === 1 && sole !== undefined) {
      ledgerEntries[0] = {
        ...sole,
        text: sole.text.slice(sole.text.length - CONTINUITY_LEDGER_MAX_CHARS),
      };
      ledgerTruncated = true;
    }
  };
  for (const seeded of resumedLedgerSeed) foldLedgerEntry(seeded);

  /**
   * §2.3 — the eviction chokepoint, called by the compaction ladder with
   * the messages a step is ABOUT to drop, before the drop commits. Every
   * text-bearing record is appended verbatim to the session event log as
   * `context_evicted` (zero model trust — the recall integration comes in a
   * later PR); user records additionally fold into the in-run ledger for
   * per-call reinjection.
   */
  const externalizeEvicted = async (
    evicted: ReadonlyArray<Anthropic.MessageParam>,
  ): Promise<void> => {
    if (!continuityLedgerEnabled) return;
    for (const message of evicted) {
      for (const entry of extractEvictedEntries(message)) {
        await logEvent("context_evicted", {
          role: entry.role,
          text: entry.text,
          ...(entry.turnNumber !== undefined ? { turnNumber: entry.turnNumber } : {}),
        });
        if (entry.role === "user") foldLedgerEntry(entry);
      }
    }
  };

  /** §2.3 — the ledger text handed to the autocompact summarizer as an
   *  anchor. Evaluated lazily AFTER the current step's evictions folded, so
   *  the requirements at risk in THIS compaction anchor THIS summary. */
  const ledgerAnchorText = (): string | undefined => {
    if (!continuityLedgerEnabled || ledgerEntries.length === 0) return undefined;
    return ledgerEntries.map((e) => `- ${e.text}`).join("\n");
  };

  /**
   * §2.5 — build the volatile tail for one model call. Re-reads the
   * `plan.dirty` flag from the per-run state-store (set by plan-mutating
   * tools through the RuntimeBridge) and re-renders the plan via
   * `onPlanDirty` (falling back to `loadPlan`) when set. The returned
   * blocks carry NO cache_control — they sit AFTER the cache-marked frozen
   * prefix, so per-call edits re-tokenize only the tail (the
   * prompt-cache-manager `volatile` contract).
   */
  const buildContinuityTail = async (): Promise<Anthropic.TextBlockParam[]> => {
    if (continuity === undefined) return [];
    if (runState.get()[PLAN_DIRTY_STATE_KEY] === true) {
      try {
        lastPlanText = await (continuity.onPlanDirty ?? continuity.loadPlan)();
      } catch (err) {
        runContext.logger.warn("continuity plan refresh failed", {
          error: (err as Error).message,
        });
      }
      runState.set({ [PLAN_DIRTY_STATE_KEY]: false });
    }
    return renderContinuityTail({
      plan: lastPlanText,
      ledger: ledgerEntries,
      ledgerTruncated,
    }).map((text) => ({ type: "text" as const, text }));
  };

  /** §2.8 — the deterministic teardown handoff: fired exactly once, in the
   *  same finally slot as `memory.onCapture`, with no model calls.
   *  Best-effort — a handoff failure never turns a clean exit into an
   *  error. */
  const maybeHandoff = async (stopReason: HandoffInput["stopReason"]): Promise<void> => {
    if (continuity?.onHandoff === undefined || handoffFired) return;
    handoffFired = true;
    try {
      await continuity.onHandoff({
        plan: lastPlanText,
        ledger: [...ledgerEntries],
        sessionId,
        stopReason,
      });
    } catch (err) {
      runContext.logger.warn("continuity handoff failed", { error: (err as Error).message });
    }
  };

  // Boot-time plan snapshot. Best-effort: a store failure degrades to no
  // plan block rather than aborting the run (memory-backend failures
  // degrade; provider failures halt).
  if (continuity !== undefined) {
    try {
      lastPlanText = await continuity.loadPlan();
    } catch (err) {
      runContext.logger.warn("continuity loadPlan failed", { error: (err as Error).message });
    }
  }

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

  // Item 1 / G19 — active-context curation config (present ⇒ the pre-pass
  // runs, gated by the emitter on `ir.compaction.curate`) and the shared
  // extra `maybeCompact` args threaded at both call sites: the injected
  // curate config, the `curate`-event publisher, and the real-token trigger.
  const curateConfig: CurateConfig | undefined = opts.curate;
  const publishCurate = async (info: CurateInfo): Promise<void> => {
    bus.publish({
      ...bus.envelope(),
      kind: "curate",
      before: info.before,
      after: info.after,
      dropped: info.dropped,
      bytesSaved: info.bytesSaved,
      embedded: info.embedded,
    });
  };
  /** The extra `maybeCompact` args (Item 1 curation + Item 4 real tokens),
   *  recomputed per call so `realInputTokens` reflects the newest response. */
  const compactionExtras = (): Pick<CompactArgs, "realInputTokens" | "curate" | "onCurate"> => ({
    ...(lastModelInputTokens !== undefined ? { realInputTokens: lastModelInputTokens } : {}),
    ...(curateConfig !== undefined ? { curate: curateConfig, onCurate: publishCurate } : {}),
  });
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
  // v0.3.0 §7.1 — child-seam projections for the RuntimeBridge, computed once
  // per run. The spawner threads these into child loops via the Task tool:
  //   - memory: RECALL-ONLY. `autoCapture`/`onCapture` are dropped at the
  //     projection so no write closure can reach a child (parents own memory
  //     writes; child findings arrive through the capture pass walking the
  //     sub_agent_start/end brackets). Projected only when a recall closure
  //     exists — a capture-only seam gives children nothing.
  //   - continuity: READ-ONLY. Only `loadPlan` crosses; `onPlanDirty` /
  //     `onHandoff` / the ledger stay parent-side so a child cannot mutate
  //     the parent's plan-store state through the seam.
  const bridgeMemorySeam =
    opts.memory?.recall !== undefined
      ? {
          ...(opts.memory.autoRecall !== undefined ? { autoRecall: opts.memory.autoRecall } : {}),
          ...(opts.memory.recallK !== undefined ? { recallK: opts.memory.recallK } : {}),
          ...(opts.memory.recallSeed !== undefined ? { recallSeed: opts.memory.recallSeed } : {}),
          recall: opts.memory.recall,
        }
      : undefined;
  const bridgeContinuitySeam =
    opts.continuity !== undefined ? { loadPlan: opts.continuity.loadPlan } : undefined;
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
  // Feature #53 / Item 2 (G21) — cross-session auto-recall. `recallMode`
  // decides WHERE the recalled evidence lives:
  //   - "session-start" (default): pull the top-K relevant memories ONCE at
  //     boot and inject them into the frozen, cache-marked system prefix
  //     below — the pre-0.4 behaviour.
  //   - "per-turn": leave the frozen prefix empty and instead refresh a
  //     VOLATILE recalled block every `refreshEvery` turns (see
  //     `maybePerTurnRecall`), so a long daemon's evidence tracks the
  //     conversation instead of drifting from a stale boot-time snapshot.
  // The caller supplies the `recall` seam (runtime-core stays independent of
  // memory-store). Best-effort: a recall failure never aborts the run.
  const recallMode = opts.memory?.recallMode ?? "session-start";
  const autoRecallOn = opts.memory?.autoRecall === true && opts.memory?.recall !== undefined;
  let memoryRecallBlock: Anthropic.TextBlockParam[] = [];
  if (autoRecallOn && recallMode !== "per-turn" && opts.memory?.recall !== undefined) {
    try {
      const seed = opts.memory.recallSeed ?? opts.instructions;
      const k = opts.memory.recallK ?? 5;
      // Pillar 3 — a recalled memory can embed content shaped by untrusted
      // tool output from an earlier session; `renderRecalledMemory` applies
      // the same delimiter-safety + boundary-classification defenses the
      // security fabric uses for every other prompt-bound source (#53).
      const lines = await opts.memory.recall(seed, k);
      const text = await renderRecalledMemory(lines);
      if (text !== undefined) {
        memoryRecallBlock = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
        process.stdout.write(`[memory] recalled ${lines.length} memory(ies) into the prompt\n`);
      }
    } catch (err) {
      runContext.logger.warn("memory auto-recall failed", { error: (err as Error).message });
    }
  }

  // Item 2 (G21) — per-turn recall state. The volatile block sits in the
  // mutable tail region (never the frozen prefix), so swapping it each turn
  // re-tokenizes only the tail and never busts the cached system prefix. The
  // refresh cadence counter starts "due" so the first applicable turn recalls.
  const perTurnRecallEnabled = autoRecallOn && recallMode === "per-turn";
  const perTurnRefreshEvery = Math.max(1, opts.memory?.refreshEvery ?? 1);
  let volatileRecallBlocks: Anthropic.TextBlockParam[] = [];
  let turnsSinceRecall = perTurnRefreshEvery;
  const maybePerTurnRecall = async (msgs: ReadonlyArray<Anthropic.MessageParam>): Promise<void> => {
    if (!perTurnRecallEnabled) return;
    if (turnsSinceRecall < perTurnRefreshEvery) {
      turnsSinceRecall++;
      return;
    }
    turnsSinceRecall = 1;
    const recall = opts.memory?.recall;
    if (recall === undefined) return;
    // Recall against the LATEST user message (the interactive cadence), falling
    // back to the seed/instructions when the tail carries no human text.
    const query = latestUserText(msgs) ?? opts.memory?.recallSeed ?? opts.instructions;
    const k = opts.memory?.recallK ?? 5;
    try {
      const lines = await recall(query, k);
      const text = await renderRecalledMemory(lines);
      volatileRecallBlocks = text !== undefined ? [{ type: "text", text }] : [];
      if (lines.length > 0) {
        process.stdout.write(
          `[memory] refreshed ${lines.length} recalled memory(ies) for this turn\n`,
        );
      }
    } catch (err) {
      // Keep the prior volatile block on a transient recall failure.
      runContext.logger.warn("per-turn memory recall failed", {
        error: (err as Error).message,
      });
    }
  };
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
  // Anthropic's 30-day TTL. A caller-supplied `promptCacheLastRotatedAt`
  // that is still fresh makes `manage()` skip — the run reuses the cached
  // prefix instead of force-rotating at every boot (§2.5 bookkeeping fix).
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
      // v0.3.0 §2.5 — surface the rotation so the caller can persist
      // `rotatedAt` and thread it back next run. The trace event is the
      // observable half; `onPromptCacheRotated` is the persistence seam
      // (best-effort — a persist failure never aborts the run).
      bus.publish({
        ...bus.envelope(),
        kind: "cache_rotation",
        rotatedAt: cacheManaged.rotatedAt,
      });
      if (opts.onPromptCacheRotated !== undefined) {
        try {
          await opts.onPromptCacheRotated(cacheManaged.rotatedAt);
        } catch (err) {
          runContext.logger.warn("prompt-cache rotatedAt persist failed", {
            error: (err as Error).message,
          });
        }
      }
    }
  }

  const tools = opts.tools ?? [];
  const anthropicTools: Anthropic.Tool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: toAnthropicInputSchema(t),
        }))
      : undefined;
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // G17 — per-tool rate limiter, built once at loop start from the lowered
  // `agent.rate_limits` map. One token bucket per entry: `rpm` is the
  // sustained refill (per-minute → per-second), `burst` the instantaneous
  // capacity (defaults to `rpm`, the standard token-bucket parameterization
  // where a full window's allowance may burst). The `"*"` key becomes the
  // limiter's per-dimension `tool:*` default, which `acquire` falls back to
  // for any tool without a named bucket — each such tool still gets its OWN
  // bucket instance (state keys on the specific `tool:<name>`), so the
  // default is a per-tool limit, not one shared pool. `hasToolRateBucket`
  // gates the acquire call site: tools outside the map (no named entry, no
  // `"*"`) are not rate-gated at all — the limiter itself is fail-closed on
  // unknown keys, so the guard is what keeps unlisted tools ungated.
  const rateLimitEntries = Object.entries(opts.rateLimits ?? {});
  let toolRateLimiter: RateLimiter | undefined;
  if (rateLimitEntries.length > 0) {
    const buckets = new Map<string, BucketConfig>();
    for (const [name, limit] of rateLimitEntries) {
      buckets.set(`tool:${name}`, {
        kind: "token-bucket",
        capacity: limit.burst ?? limit.rpm,
        refillPerSec: limit.rpm / 60,
      });
    }
    toolRateLimiter = createRateLimiter({ buckets });
  }
  const hasToolRateBucket = (toolName: string): boolean =>
    opts.rateLimits !== undefined &&
    (opts.rateLimits[toolName] !== undefined || opts.rateLimits["*"] !== undefined);

  // Root abort tree for the whole run; each turn gets a child.
  const runAbort = createAbortTree(runContext.abortSignal);
  // Per-turn abort tree, replaced at the start of each turn so a SIGINT
  // during turn N doesn't leave turn N+1 born-aborted.
  let turnAbort: AbortTree = runAbort.child();
  // Latest error captured from a model call, fed to recover() on entry to NeedRecovery.
  let lastErrorForRecovery: unknown = undefined;

  // -------------------------------------------------------------------------
  // G10 — wall-clock stop timers. All three fire through the abort tree with
  // a branded {@link TimeoutAbortReason} so downstream code can tell a
  // timeout from a SIGINT (`timeoutAbortReason(signal)`), and all three are
  // torn down via `clearTimeout` on every exit path (per-turn finally + the
  // mode-level finally) — plus `unref()` so a long pending deadline never
  // pins the process by itself. The fire callback stops any live spinner
  // and prints a one-line notice, mirroring the SIGINT handler.
  // -------------------------------------------------------------------------
  type Timer = ReturnType<typeof setTimeout>;
  const fireTimeout = (tree: AbortTree, scope: TimeoutScope, limitMs: number): void => {
    out.spinner.stop();
    const noun =
      scope === "run" ? "run deadline" : scope === "turn" ? "turn timeout" : "model call timeout";
    out.write(`\n[${noun}: ${limitMs}ms elapsed — aborting]\n`);
    runContext.logger.warn("wall-clock limit fired", { scope, limitMs });
    tree.abort({ crewhausTimeout: scope, limitMs } satisfies TimeoutAbortReason);
  };
  const armTimer = (tree: AbortTree, scope: TimeoutScope, limitMs: number): Timer => {
    const timer = setTimeout(() => fireTimeout(tree, scope, limitMs), limitMs);
    timer.unref();
    return timer;
  };
  let deadlineTimer: Timer | undefined;
  if (opts.deadlineMs !== undefined && opts.deadlineMs > 0) {
    deadlineTimer = armTimer(runAbort, "run", opts.deadlineMs);
  }
  let turnTimer: Timer | undefined;
  const armTurnTimer = (): void => {
    if (opts.turnTimeoutMs === undefined || opts.turnTimeoutMs <= 0) return;
    turnTimer = armTimer(turnAbort, "turn", opts.turnTimeoutMs);
  };
  const clearTurnTimer = (): void => {
    if (turnTimer !== undefined) clearTimeout(turnTimer);
    turnTimer = undefined;
  };
  let modelCallTimer: Timer | undefined;
  const armModelCallTimer = (): void => {
    if (opts.modelCallTimeoutMs === undefined || opts.modelCallTimeoutMs <= 0) return;
    modelCallTimer = armTimer(turnAbort, "model_call", opts.modelCallTimeoutMs);
  };
  const clearModelCallTimer = (): void => {
    if (modelCallTimer !== undefined) clearTimeout(modelCallTimer);
    modelCallTimer = undefined;
  };
  const clearAllTimers = (): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    clearTurnTimer();
    clearModelCallTimer();
  };

  // Permission-ask prompter. Set in REPL mode after the readline interface
  // exists; remains undefined in single-turn mode (where ask collapses to deny).
  // The initial assignment makes the second assignment legal under biome's
  // `useConst` rule (which fires on exactly-one-assignment lets).
  let askApproval: ((toolName: string, input: unknown) => Promise<boolean>) | undefined = undefined;

  // Loop contract 0.4 (Batch C, G11) — headless ask-approval parking. `askMode`
  // is the lowered `permissions.ask_mode` (absent ⇒ "pause"); `approvals` is
  // the injected persistence seam. Parking is active only when BOTH a store is
  // present AND the mode is "pause" — otherwise a headless `ask` collapses to
  // the pre-0.4 deny. `approvalSurface` classifies the `approval_requested`
  // event; it never affects the REPL path (which prompts on stdin).
  const askMode = opts.askMode ?? "pause";
  const approvals = opts.approvals;
  const approvalSurface =
    approvals?.surface ?? (opts.singleTurn === true ? "single-turn" : "headless");

  // Per-run state for tool-loop detection and warning de-dup. Both span
  // turns within a single `runChatLoop` invocation so cross-turn loops
  // (e.g. "keep running date") get caught and warned at most once per
  // signature.
  //
  // G27 — `loopSignatureStage` replaces the old warned-signature Set with a
  // two-stage ladder per signature: first detection → `"warned"` (the
  // pre-0.4 one-time warning, all escalation modes), a REPEAT detection of
  // the same signature → the configured escalation (`justify` demand or
  // turn `abort`), recorded as `"escalated"` so it fires at most once per
  // signature too. In the default `"warn"` mode the second stage is a
  // no-op — byte-identical behaviour to the pre-0.4 runtime.
  const toolUseHistory: TsmToolUseBlock[] = [];
  const loopSignatureStage = new Map<string, "warned" | "escalated">();
  const loopEscalation = opts.loopDetection?.escalation ?? "warn";

  // Loop contract 0.4 (Batch C, item 7) — per-tool cost attribution. When a
  // NON-streaming model response that emitted tool_use blocks is priceable, the
  // response's cost is split evenly across those calls and stashed here by
  // tool_use id, then stamped as `attributedCostUsdMicros` on each `tool_use`
  // event-log record. Keyed by id (unique per call) and consumed (deleted) on
  // read to bound growth. The streaming path dispatches tools BEFORE the
  // response's usage is known, so it never populates this map — precisely the
  // "where the model usage split is computable" boundary: absent ⇒ no field.
  const toolCostAttribution = new Map<string, number>();
  // Response cost in USD-micros, or undefined when the served model isn't on the
  // pricing table (the split is then not computable — no attribution stamped).
  const responseCostMicros = (
    provider: ProviderId,
    wireModelId: string,
    usage: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  ): number | undefined => {
    const row = resolvePricing(DEFAULT_PRICING, provider, wireModelId);
    if (row === undefined) return undefined;
    return computeCostMicros(
      row,
      usage.input,
      usage.output,
      usage.cacheRead ?? 0,
      usage.cacheCreate ?? 0,
    );
  };

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
    // Item 7 — stamp the per-tool cost attribution when the producing response
    // was priceable (non-streaming path only; see `toolCostAttribution`).
    // Consume the entry so the map stays bounded across a long run.
    const attributedCostUsdMicros = toolCostAttribution.get(tu.id);
    if (attributedCostUsdMicros !== undefined) toolCostAttribution.delete(tu.id);
    await logEvent("tool_use", {
      id: tu.id,
      name: tu.name,
      input: tu.input,
      ...(attributedCostUsdMicros !== undefined ? { attributedCostUsdMicros } : {}),
    });
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
        // Interactive REPL path — unchanged: prompt on stdin.
        approved = await askApproval(tu.name, tu.input);
        if (!approved) denialMessage = "tool denied by user";
      } else if (approvals !== undefined && askMode === "pause") {
        // G11 headless parking/resume. Consult the store for a prior decision
        // on this exact (toolName, inputHash).
        const inputHash = hashApprovalInput(tu.name, tu.input);
        const existing = await approvals.store.get(tu.name, inputHash);
        if (existing?.decision === "grant") {
          // One-shot allow: consume the grant so a later identical call re-asks.
          approved = true;
          await approvals.store.persist({ ...existing, consumedAt: new Date().toISOString() });
        } else if (existing?.decision === "deny") {
          approved = false;
          denialMessage = `tool denied: \`${tu.name}\` approval was denied${
            existing.decidedBy !== undefined ? ` by ${existing.decidedBy}` : ""
          }.`;
        } else {
          // No decision yet. Reuse an existing pending record for this key
          // (idempotent re-park across resumed runs) or persist a fresh one,
          // fire the out-of-band notification, publish `approval_requested`,
          // and PARK: throw the classified `approval_pending` report. The
          // NeedTools catch (non-streaming) publishes `run_failed` + rethrows;
          // the streaming path reaches the same halt through recovery's
          // classified-report passthrough. On the next execution the store
          // carries a grant/deny and the call re-resolves pre-decided.
          const pending: PendingApproval = existing ?? {
            id: generateApprovalId(),
            toolName: tu.name,
            inputHash,
            input: tu.input,
            runId: bus.runId,
            sessionId,
            surface: approvalSurface,
            createdAt: new Date().toISOString(),
          };
          if (existing === null) await approvals.store.persist(pending);
          if (approvals.notify !== undefined) {
            await approvals.notify(pending).catch((err) => {
              runContext.logger.warn("approvals.notify failed", {
                approvalId: pending.id,
                error: (err as Error).message,
              });
            });
          }
          bus.publish({
            ...bus.envelope(),
            kind: "approval_requested",
            approvalId: pending.id,
            toolName: tu.name,
            surface: approvalSurface,
          });
          runContext.logger.info("tool approval parked", {
            approvalId: pending.id,
            toolName: tu.name,
            surface: approvalSurface,
          });
          throw new RunFailedError({
            class: "approval_pending",
            title: "awaiting tool approval",
            detail: `\`${tu.name}\` requires approval on a non-interactive surface (${approvalSurface}); the run is parked as approval ${pending.id}`,
            remediation: `grant or deny approval ${pending.id} out of band (e.g. \`crewhaus approvals grant ${pending.id}\`), then rerun`,
            exitCode: EXIT_CODES.approval_pending,
          });
        }
      } else {
        // Pre-0.4 collapse-to-deny: no interactive surface, and either
        // `ask_mode: "deny"` or no approvals store is wired to park against.
        denialMessage =
          `tool denied: \`${tu.name}\` defaulted to "ask" and this non-interactive surface has no way to prompt` +
          `${approvals === undefined ? " (no approvals store wired)" : ' (ask_mode: "deny")'}. ` +
          `Add an explicit rule to permissions.rules in your spec, e.g. \`{ type: alwaysAllow, pattern: ${tu.name} }\`, run in REPL mode where "ask" can prompt, or set ask_mode: pause with an approvals store to park for out-of-band approval.`;
      }
      // Advisor groundwork (item 14) — event the ask RESOLUTION. The publish
      // above fired BEFORE the approval resolved (decision "ask", no outcome);
      // this one fires after the REPL prompt / store decision / collapse
      // resolves — so offline advice mining can measure how each tool's prompts
      // are actually answered. The advisor persistence subscriber
      // (observability.ts) keys on `askOutcome` to persist exactly this resolved
      // form. Unreached on the PARK path, which throws above.
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

    // G17 — per-tool rate gate. Sits AFTER every deny-capable gate
    // (permission / justification / egress) so a denied call never burns a
    // token, and BEFORE dispatch so the pacing wait is what the model
    // experiences as tool latency. Only tools with a named bucket or under
    // a `"*"` default are gated (the limiter is fail-closed on unknown
    // keys, so the guard is what keeps unlisted tools ungated). Exhausting
    // the limiter's wait budget fails just THIS call with an `is_error`
    // result the model can adapt to — never the run.
    if (toolRateLimiter !== undefined && hasToolRateBucket(tu.name)) {
      try {
        await toolRateLimiter.acquire([{ dimension: "tool", id: tu.name }], 1);
      } catch (err) {
        runContext.logger.warn("tool rate limit exhausted", {
          toolUseId: tu.id,
          toolName: tu.name,
          error: (err as Error).message,
        });
        return finish({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `[rate-limited] ${(err as Error).message}. Wait before retrying "${tu.name}", or proceed another way.`,
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
      // v0.3.0 §2.5 — the per-run state-store, so plan-mutating tools can
      // set PLAN_DIRTY_STATE_KEY and the loop re-renders the plan tail
      // before the next model call.
      runState,
      ...(opts.subAgents !== undefined ? { subAgents: opts.subAgents } : {}),
      ...(opts.spawnSubAgent !== undefined ? { spawnSubAgent: opts.spawnSubAgent } : {}),
      ...(opts.crewMailbox !== undefined ? { crewMailbox: opts.crewMailbox } : {}),
      // v0.3.0 §7.1 — the four child seams (projected above: recall-only
      // memory, skills list, failure taxonomy, read-only continuity) so the
      // Task tool can hand them to the spawner. All conditional: a run
      // without them builds the exact pre-0.3.0 bridge shape.
      ...(bridgeMemorySeam !== undefined ? { memory: bridgeMemorySeam } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(opts.failureTaxonomy !== undefined ? { failureTaxonomy: opts.failureTaxonomy } : {}),
      ...(bridgeContinuitySeam !== undefined ? { continuity: bridgeContinuitySeam } : {}),
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
   * G27 — evaluate the per-run tool-use history against the loop detector
   * and walk the escalation ladder. Outcomes:
   *   - `none` — no loop, or this signature already exhausted its ladder.
   *   - `message` — a synthetic user message to inject: the one-time
   *     warning (`stage: "warn"`, all modes — the pre-0.4 behaviour), or
   *     the justification demand (`stage: "justify"`) when a warned
   *     signature trips again under `escalation: "justify"`.
   *   - `abort` — a warned signature tripped again under
   *     `escalation: "abort"`: the caller aborts the TURN,
   *     ToolLoopLimit-style (error event + Aborted transition).
   * The near-duplicate tier flows through the same ladder; its warning copy
   * names the volatile-stripped grouping so the model understands why
   * "different" inputs were counted together.
   */
  type LoopOutcome =
    | { readonly kind: "none" }
    | {
        readonly kind: "message";
        readonly stage: "warn" | "justify";
        readonly message: Anthropic.MessageParam;
        readonly detection: LoopDetection;
      }
    | { readonly kind: "abort"; readonly detection: LoopDetection };

  function evaluateToolLoop(): LoopOutcome {
    const detection: LoopDetection | null = detectLoop(
      toolUseHistory,
      opts.loopDetection?.window,
      opts.loopDetection?.threshold,
    );
    if (detection === null) return { kind: "none" };
    const stage = loopSignatureStage.get(detection.signature);
    if (stage === undefined) {
      loopSignatureStage.set(detection.signature, "warned");
      runContext.logger.warn("tool loop detected", {
        signature: detection.signature,
        toolName: detection.toolName,
        count: detection.count,
        tier: detection.tier,
        escalation: loopEscalation,
      });
      const how =
        detection.tier === "exact"
          ? "with the same input"
          : "with near-identical inputs (differing only in numbers/ids)";
      return {
        kind: "message",
        stage: "warn",
        detection,
        message: {
          role: "user",
          content: `[runtime] possible loop detected: tool "${detection.toolName}" has been called ${detection.count} times ${how} within the last ${detection.windowSize} calls. Reconsider before repeating; respond with a different approach or final text.`,
        },
      };
    }
    if (stage !== "warned") return { kind: "none" };
    if (loopEscalation === "justify") {
      loopSignatureStage.set(detection.signature, "escalated");
      runContext.logger.warn("tool loop persists — demanding justification", {
        signature: detection.signature,
        toolName: detection.toolName,
        count: detection.count,
        tier: detection.tier,
      });
      return {
        kind: "message",
        stage: "justify",
        detection,
        message: {
          role: "user",
          content: `[runtime] the loop on tool "${detection.toolName}" persists after a warning. Before calling "${detection.toolName}" again you MUST state, in one sentence, a justification tying the repeat to the session goal and the NEW outcome you expect (the same discipline requireJustification-gated tools demand). If you cannot, do not repeat the call — take a different approach or answer with final text.`,
        },
      };
    }
    if (loopEscalation === "abort") {
      loopSignatureStage.set(detection.signature, "escalated");
      return { kind: "abort", detection };
    }
    // escalation "warn" — the warning already fired once; stay quiet.
    return { kind: "none" };
  }

  /**
   * G27 `escalation: "abort"` bookkeeping — the ToolLoopLimit-style
   * classified error record (named `error` event + logger line), shared by
   * the streaming and non-streaming tool-batch call sites. The caller takes
   * the `Aborted` state transition itself (the two sites sit at different
   * points in the state machine).
   */
  async function recordLoopAbort(detection: LoopDetection): Promise<void> {
    await logEvent("error", {
      name: "ToolLoopAbort",
      message: `aborting turn: tool "${detection.toolName}" still looping (${detection.count}x in the last ${detection.windowSize} calls) after a warning — limits.loop_detection.escalation is "abort"`,
    });
    runContext.logger.error("tool loop escalation — aborting turn", {
      toolName: detection.toolName,
      signature: detection.signature,
      tier: detection.tier,
    });
  }

  /**
   * Run one user→assistant turn through the state machine. Mutates
   * `messages` in place (pushes the assistant turn and any tool_results).
   * Returns the final assistant content blocks so callers can extract
   * text. Closes over client/model/maxTokens/etc.
   */
  // v0.3.0 Goal 6 — one structured report on every terminal path, published
  // to the bus AND appended to the session event log BEFORE the throw (a
  // throw is invisible to structured consumers; the event is what the UI
  // host, printers, exporters, and incident capture render). Used by the
  // recovery `halt`/`fail` arms, the §7.1 sub-agent escalation path in
  // `NeedTools`, and (G10) the wall-clock timeout stops — including the REPL
  // deadline-at-prompt path, which is why this lives at run scope rather
  // than inside `runOneTurn`.
  const publishRunFailed = async (report: FailureReport): Promise<void> => {
    const failureMessage = `${report.title}: ${report.detail}`;
    bus.publish({
      ...bus.envelope(),
      kind: "run_failed",
      class: report.class,
      message: failureMessage,
      ...(report.remediation !== undefined ? { remediation: report.remediation } : {}),
      exitCode: report.exitCode,
    });
    await logEvent("run_failed", {
      class: report.class,
      message: failureMessage,
      ...(report.remediation !== undefined ? { remediation: report.remediation } : {}),
      exitCode: report.exitCode,
    });
  };

  /**
   * G10 — convert a fired wall-clock limit into the classified terminal
   * stop: publish + log the `run_failed` report (class `"timeout"`), then
   * throw the matching `RunFailedError`. Callers invoke this only on the
   * paths where a timeout IS terminal (any scope in `singleTurn` mode; the
   * run deadline everywhere).
   */
  const throwTimeout = async (timeout: TimeoutAbortReason): Promise<never> => {
    const report = buildTimeoutFailureReport(timeout);
    await publishRunFailed(report);
    throw new RunFailedError(report);
  };

  async function runOneTurn(
    messages: Anthropic.MessageParam[],
  ): Promise<{ terminalContent: Anthropic.ContentBlock[]; usage: ModelUsage }> {
    let state: TurnState = initialState;
    let terminalContent: Anthropic.ContentBlock[] = [];
    // G02 — aggregate token usage across every MAIN-turn model call this
    // turn makes (each tool iteration streams once). Handed to the in-loop
    // evaluator so a judge can weigh cost/verbosity; side-calls (compaction,
    // the injected judge itself) publish no accumulation here.
    const turnUsage: { input: number; output: number; cacheRead: number; cacheCreate: number } = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    };
    const accrueTurnUsage = (u: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead?: number;
      readonly cacheCreate?: number;
    }): void => {
      turnUsage.input += u.input;
      turnUsage.output += u.output;
      turnUsage.cacheRead += u.cacheRead ?? 0;
      turnUsage.cacheCreate += u.cacheCreate ?? 0;
    };
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
    // Adaptive model routing — once a pool candidate fails, stick with the
    // strongest candidate for the rest of the run (misroute recovery, mirroring
    // the tier router's fast→default escalation latch).
    let escalatePool = false;

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
          // Adaptive model routing — declared OUTSIDE the try so the catch can
          // read the chosen candidate + start time to record a failure reward.
          let poolTurn: { readonly modelString: string; readonly routeKey: string } | undefined;
          let modelCallStartMs = performance.now();
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
            // Adaptive model routing — the PolicyRouter picks a pool candidate
            // this turn (static / heuristic / learned) from the SAME
            // deterministic signals as the tier router. `escalatePool` forces
            // the strongest candidate after a prior pool failure (misroute
            // recovery). Publish a `model_route` event and stream through the
            // chosen candidate; the outcome is folded into the reward
            // scoreboard post-turn. Takes precedence over the tier router (the
            // two are mutually exclusive in the spec).
            if (poolRouter !== undefined) {
              const base = poolRouter.route(
                {
                  contextTokens: contextTokenSignal(messages),
                  toolsInPlay: (anthropicTools?.length ?? 0) > 0,
                  turnIndex: Math.max(0, runContext.turnNumber - 1),
                  priorTurnToolUseCount,
                },
                poolSeed,
                // Monotonic exploration sequence: the transcript length keeps
                // advancing across `--resume` (and a channel-bot's resume-per-
                // message), so ε-greedy draws a fresh coin per decision instead
                // of freezing on the reset-to-0 turnIndex. Deterministic on
                // replay (the same transcript reconstructs the same length).
                messages.length,
              );
              const decision = escalatePool
                ? {
                    ...base,
                    candidate: poolRouter.escalation(),
                    reason: `escalated to strongest candidate after a pool failure (was: ${base.reason})`,
                    explored: false,
                  }
                : base;
              turnAdapter = decision.candidate.adapter;
              reqWireModelId = decision.candidate.modelId;
              reqProviderId = decision.candidate.adapter.providerId;
              reqSpecModel = decision.candidate.modelString;
              poolTurn = {
                modelString: decision.candidate.modelString,
                routeKey: decision.routeKey,
              };
              bus.publish({
                ...bus.envelope(),
                kind: "model_route",
                routeKey: decision.routeKey,
                model: decision.candidate.modelId,
                policy: decision.policy,
                reason: decision.reason,
                ...(decision.explored ? { explored: true } : {}),
                ...(poolPolicyVersion !== undefined ? { policyVersion: poolPolicyVersion } : {}),
              });
              // Persist the decision so `crewhaus route explain <session>` can
              // replay per-turn routing after the fact. Non-conversational, so
              // `replayMessageHistory` ignores it and `--resume` is unaffected.
              await logEvent("model_route", {
                turnNumber: runContext.turnNumber,
                routeKey: decision.routeKey,
                model: decision.candidate.modelId,
                policy: decision.policy,
                reason: decision.reason,
                explored: decision.explored,
                ...(poolPolicyVersion !== undefined ? { policyVersion: poolPolicyVersion } : {}),
              });
            } else if (tierRouter !== undefined) {
              // Item 26 — two-tier turn-difficulty router. Pick a tier from
              // DETERMINISTIC per-turn signals (context size, tools-in-play,
              // turn index, prior-turn tool_use density); a fast-tier misroute
              // recovery forces `default` (see the catch below). Publish the
              // decision as a `model_tier_route` event, then stream through the
              // chosen tier's already-resolved adapter.
              const decision = escalateTier
                ? { tier: "default" as const, reason: "escalated after fast-tier failure" }
                : tierRouter.route({
                    contextTokens: contextTokenSignal(messages),
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
            modelCallStartMs = t0Model;
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
            // v0.3.0 §2.5 — the volatile continuity tail is rebuilt for
            // EVERY model call and appended AFTER the frozen cache-marked
            // prefix, so a plan/ledger edit re-tokenizes only the tail.
            // `[]` when the seam is absent — the request payload is then
            // byte-identical to a pre-0.3.0 runtime.
            const continuityTail = await buildContinuityTail();
            // G10 — arm the per-model-call watchdog for exactly the stream's
            // lifetime: cleared right after each drain below and (throw
            // paths) at the top of the catch. G01 — every MAIN-turn request
            // (and only these: compaction/judge side-calls build their own
            // requests) carries the resolved thinking fields, and the token
            // ceiling is the thinking-aware `effectiveMaxTokens`.
            armModelCallTimer();
            // Item 9 / G79 — cache the settled transcript prefix when the
            // serving adapter supports explicit caching. A request-local copy;
            // the persisted `messages` array never carries the marker.
            const reqMessages =
              turnAdapter.features.caching === "explicit"
                ? withMessageCacheBreakpoint(messages)
                : messages;
            const reqStream = turnAdapter.stream({
              model: reqWireModelId,
              system: [
                ...systemBlocks.map((b) => ({
                  type: "text" as const,
                  text: b.text,
                  ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
                })),
                // Item 2 / G21 — the volatile recalled-memory block: rebuilt
                // per-turn in per-turn recall mode, NO cache marker, sits in
                // the mutable tail so a swap never busts the frozen prefix.
                ...volatileRecallBlocks.map((b) => ({ type: "text" as const, text: b.text })),
                ...continuityTail.map((b) => ({ type: "text" as const, text: b.text })),
              ],
              messages: reqMessages as Parameters<ProviderAdapter["stream"]>[0]["messages"],
              tools:
                anthropicTools !== undefined
                  ? anthropicTools.map((t) => ({
                      name: t.name,
                      description: t.description ?? "",
                      input_schema: t.input_schema as Record<string, unknown>,
                    }))
                  : undefined,
              maxTokens: effectiveMaxTokens,
              ...(thinkingRequest !== undefined ? thinkingRequest : {}),
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
              clearModelCallTimer();
              endTurn();
              accrueTurnUsage(usage);

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
              // With a pool, the served identity is the chosen candidate (no
              // failover chain when pooling), so cost-tracker prices on it.
              const respModelIdS =
                poolTurn !== undefined ? reqWireModelId : (servedStreaming?.modelId ?? wireModelId);
              const respSpecModelS =
                poolTurn !== undefined
                  ? poolTurn.modelString
                  : (servedStreaming?.modelString ?? degradedSpecModel ?? opts.model);
              const respProviderS =
                poolTurn !== undefined
                  ? reqProviderId
                  : (servedStreaming?.providerId ?? providerId);
              bus.publish({
                ...bus.envelope(),
                spanId: modelStartEnv.spanId,
                kind: "model_response",
                // Wire model id, NOT the spec string — cost-tracker resolves
                // pricing on this field (see the model_request publish above).
                model: respModelIdS,
                ...(respSpecModelS !== respModelIdS ? { specModel: respSpecModelS } : {}),
                provider: respProviderS,
                stopReason: stopReason ?? "end_turn",
                usage,
                durationMs: performance.now() - t0Model,
              });
              // Item 4 / G28 — record the provider's real input_tokens for the
              // next pre-turn compaction trigger + routing signal. A response
              // that reports NO usage (sum 0) means "unknown", not "empty":
              // keep the last known count (undefined pre-first-call) so both the
              // trigger and the router fall back to the chars/4 estimate instead
              // of reading the context as empty and silently disabling compaction.
              const reportedInputTokens = responseInputTokens(usage);
              if (reportedInputTokens > 0) lastModelInputTokens = reportedInputTokens;
              // Adaptive model routing — fold this successful turn into the
              // reward scoreboard so the learned policy improves next run.
              if (poolTurn !== undefined) {
                const costUsd = poolCostUsd(respProviderS, respModelIdS, usage);
                recordPoolOutcome(poolTurn, {
                  success: true,
                  latencyMs: performance.now() - t0Model,
                  ...(costUsd !== undefined ? { costUsd } : {}),
                });
              }
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
              const loopOutcome = evaluateToolLoop();
              if (loopOutcome.kind === "message") {
                messages.push(loopOutcome.message);
                await logEvent("user_message", {
                  content: loopOutcome.message.content,
                  synthetic: true,
                });
              }

              // Synthesize the two transitions the state machine expects:
              // tools have already executed during the stream so we
              // collapse ModelReturnedToolUse → ToolsExecuted into a
              // single hop back to NeedModel. (G27: on an `abort` loop
              // escalation the second hop is the Aborted transition — the
              // NeedTools state accepts it — ending the turn instead.)
              const tsmBlocks: TsmToolUseBlock[] = toolUses.map((t) => ({
                id: t.id,
                name: t.name,
                input: t.input,
              }));
              state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
              if (loopOutcome.kind === "abort") {
                await recordLoopAbort(loopOutcome.detection);
                state = transition(state, { kind: "Aborted" });
                break;
              }
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
            clearModelCallTimer();
            endTurn();
            accrueTurnUsage(final.usage);

            // Item 22 — lastServed() is exact: the candidate that actually
            // streamed this response. Cost-tracker prices off this pair.
            const servedCandidate = failoverChain?.lastServed();
            // With a pool, the served identity is the chosen candidate.
            const respWireModelId =
              poolTurn !== undefined ? reqWireModelId : (servedCandidate?.modelId ?? wireModelId);
            const respSpecModel =
              poolTurn !== undefined
                ? poolTurn.modelString
                : (servedCandidate?.modelString ?? degradedSpecModel ?? opts.model);
            const respProvider =
              poolTurn !== undefined ? reqProviderId : (servedCandidate?.providerId ?? providerId);
            bus.publish({
              ...bus.envelope(),
              spanId: modelStartEnv.spanId,
              kind: "model_response",
              // Wire model id, NOT the spec string — cost-tracker resolves
              // pricing on this field (see the model_request publish above).
              model: respWireModelId,
              ...(respSpecModel !== respWireModelId ? { specModel: respSpecModel } : {}),
              provider: respProvider,
              stopReason: final.stopReason,
              usage: final.usage,
              durationMs: performance.now() - t0Model,
            });
            // Item 4 / G28 — record the provider's real input_tokens for the
            // next pre-turn compaction trigger + routing signal. A response that
            // reports NO usage (sum 0) means "unknown", not "empty": keep the
            // last known count (undefined pre-first-call) so both the trigger and
            // the router fall back to the chars/4 estimate instead of reading the
            // context as empty and silently disabling compaction.
            const reportedInputTokens = responseInputTokens(final.usage);
            if (reportedInputTokens > 0) lastModelInputTokens = reportedInputTokens;
            // Adaptive model routing — fold this successful turn into the
            // reward scoreboard so the learned policy improves next run.
            if (poolTurn !== undefined) {
              const costUsd = poolCostUsd(respProvider, respWireModelId, final.usage);
              recordPoolOutcome(poolTurn, {
                success: true,
                latencyMs: performance.now() - t0Model,
                ...(costUsd !== undefined ? { costUsd } : {}),
              });
            }

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
              // Item 7 — the response fully drained (usage known) before these
              // calls dispatch in `NeedTools`, so the split IS computable here:
              // split the priceable response cost evenly across its tool_use
              // blocks, keyed by id for `executeOneToolUse` to stamp. Skipped
              // (no attribution) when the model isn't on the pricing table.
              const respCost = responseCostMicros(respProvider, respWireModelId, final.usage);
              if (respCost !== undefined) {
                const perTool = Math.round(respCost / toolUses.length);
                for (const tu of tsmBlocks) toolCostAttribution.set(tu.id, perTool);
              }
              state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
            }
          } catch (err) {
            // G10 — the watchdog must not outlive the call it watched.
            clearModelCallTimer();
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
            // Adaptive model routing — record the failed candidate as a
            // negative reward (drops the cost term: no usage on a throw) and
            // latch the escalation so the recovery retry re-runs on the
            // strongest candidate, unless the failed candidate WAS already the
            // strongest (then escalation buys nothing).
            if (poolRouter !== undefined && poolTurn !== undefined) {
              recordPoolOutcome(poolTurn, {
                success: false,
                latencyMs: performance.now() - modelCallStartMs,
              });
              if (poolTurn.modelString !== poolRouter.escalation().modelString) {
                escalatePool = true;
              }
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
          let toolResults: Anthropic.ToolResultBlockParam[];
          try {
            toolResults = await runToolBatch(state.toolUses);
          } catch (err) {
            // v0.3.0 §7.1 — a RunFailedError escaping the tool batch is a
            // sub-agent's terminal report escalated through the spawner
            // (tool-executor deliberately lets it pass). Publish the same
            // structured run_failed surface as the recovery halt path, then
            // rethrow: both the singleTurn and REPL paths propagate non-abort
            // errors to the caller's catch-wrapper, which renders the
            // child's report and exits with its coded status. (The streaming
            // path reaches the identical halt through recovery — the
            // streaming executor rethrows after its drain and `recover()`
            // passes an already-classified report through verbatim.)
            if (isRunFailedError(err)) await publishRunFailed(err.report);
            throw err;
          }
          messages.push({ role: "user", content: toolResults });
          await logEvent("user_message", { content: toolResults });
          const loopOutcome = evaluateToolLoop();
          if (loopOutcome.kind === "message") {
            messages.push(loopOutcome.message);
            await logEvent("user_message", {
              content: loopOutcome.message.content,
              synthetic: true,
            });
          } else if (loopOutcome.kind === "abort") {
            // G27 escalation "abort" — the warned signature tripped again:
            // end the TURN, ToolLoopLimit-style (see recordLoopAbort).
            await recordLoopAbort(loopOutcome.detection);
            state = transition(state, { kind: "Aborted" });
            break;
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
            // v0.3.0 Goal 6 — `halt` is published first-class now that the
            // action union carries it (PR 1 mapped it to "fail" as a
            // stopgap). alert-watchdog and the SLO monitor count BOTH
            // `fail` and `halt` as unrecovered, so terminal-failure
            // accounting is unchanged.
            action: action.kind,
            errorName: state.error.name,
            depth: recovery.retryCount + recovery.compactCount + recovery.continueCount,
          });
          // Non-terminal actions publish no run_failed report here — only
          // the terminal `fail`/`halt` arms below call `publishRunFailed`
          // (hoisted to runOneTurn scope; also used by the §7.1 sub-agent
          // escalation path in `NeedTools`).
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
                onEvict: externalizeEvicted,
                getLedgerText: ledgerAnchorText,
              }).finally(() => out.spinner.stop());
              // §2.3 — persist the summary text alongside the counts (the
              // reactive path always ends in autocompact's [marker, summary]).
              const reactiveSummary =
                compacted.length === 2 && typeof compacted[1]?.content === "string"
                  ? compacted[1].content
                  : undefined;
              messages.length = 0;
              messages.push(...compacted);
              await logEvent("compaction", {
                kind: "reactive",
                before,
                after: messages.length,
                ...(reactiveSummary !== undefined ? { summary: reactiveSummary } : {}),
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
            case "fail": {
              // Generic terminal fail — synthesize a best-effort report
              // (class "unknown", exit 1) so even the unclassified path
              // leaves a structured `run_failed` behind, then throw the
              // byte-identical pre-0.3.0 RuntimeError (die()'s one-liner
              // for non-RunFailedError CrewhausErrors is unchanged).
              await publishRunFailed({
                class: "unknown",
                title: "recovery failed",
                detail: action.reason,
                exitCode: EXIT_CODES.generic,
              });
              throw new RuntimeError(`recovery failed: ${action.reason}`);
            }
            case "halt":
              // v0.3.0 Goal 6 — classified terminal stop (billing / auth /
              // rate-limit exhaustion / hinted taxonomy entries). The report
              // carries title, raw provider text, remediation, and the coded
              // exit status; RunFailedError extends RuntimeError so existing
              // CrewhausError catch sites (e.g. `crewhaus run`'s die())
              // still work. Every terminal surface renders the SAME report:
              // die() and the bundle catch-wrappers print formatRunFailure()
              // and exit with report.exitCode.
              await publishRunFailed(action.report);
              throw new RunFailedError(action.report, lastErrorForRecovery);
          }
          break;
        }
      }
    }

    // Item 26 — hand this turn's tool_use count to the next turn's tier
    // decision (the prior-tool-density signal).
    priorTurnToolUseCount = thisTurnToolUseCount;

    // G10 — the turn wound down through the Aborted transition; if a
    // wall-clock timer (not a SIGINT) is what aborted it, classify the stop.
    // The abort tree propagates reasons parent→child, so a run-deadline
    // reason is readable off the TURN signal too; checking both covers the
    // window where the deadline fires between turns. Terminal when the
    // deadline fired (any mode) or in `singleTurn` mode (the turn IS the
    // run); in REPL mode a turn/model-call timeout already printed its
    // notice at fire time — record the named error and hand control back to
    // the prompt, mirroring the first-SIGINT semantics.
    const timedOut = timeoutAbortReason(turnAbort.signal) ?? timeoutAbortReason(runAbort.signal);
    if (timedOut !== undefined) {
      if (timedOut.crewhausTimeout === "run" || opts.singleTurn === true) {
        await throwTimeout(timedOut);
      }
      await logEvent("error", {
        name: timedOut.crewhausTimeout === "turn" ? "TurnTimeout" : "ModelCallTimeout",
        message: `turn aborted: the configured ${TIMEOUT_SPEC_KEYS[timedOut.crewhausTimeout]} (${timedOut.limitMs}ms) elapsed`,
      });
    }
    return { terminalContent, usage: turnUsage };
  }

  /** Concatenated text of a terminal content-block array (the same
   *  projection the `singleTurn` return value uses). */
  const terminalText = (blocks: ReadonlyArray<Anthropic.ContentBlock>): string =>
    blocks
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

  /**
   * G02 — one COMPLETED turn plus its in-loop evaluation gate. Wraps
   * `runOneTurn` so evaluation fires only at turn completion (the tool
   * inner-loop lives INSIDE `runOneTurn`, so tool-only intermediate
   * iterations can never reach the grader by construction), on both the
   * `singleTurn` and REPL paths. Without `opts.evaluation` this is exactly
   * `runOneTurn` — zero behaviour change.
   *
   * The retry ladder: grade attempt 0 (`retryIndex` 0); a failing verdict
   * with `onFail: "retry"` appends the grader rationale as a synthetic
   * corrective user message and re-runs the turn, re-grading each re-run
   * (`retryIndex` n) up to `maxRetries`. Every re-run streams real model
   * calls through the normal `NeedModel` path, so its spend is metered by
   * the always-on budget cost path exactly like any other call. `halt`
   * publishes + logs the classified `run_failed` (class `"evaluation"`)
   * and throws; `note` and an exhausted retry cap leave the last attempt
   * standing. An ABORTED (SIGINT / wall-clock) attempt never completed —
   * it is returned un-graded.
   */
  async function runEvaluatedTurn(
    messages: Anthropic.MessageParam[],
  ): Promise<{ terminalContent: Anthropic.ContentBlock[]; usage: ModelUsage }> {
    const evaluation = opts.evaluation;
    let attempt = await runOneTurn(messages);
    if (evaluation === undefined) return attempt;
    const maxRetries = Math.max(0, Math.floor(evaluation.maxRetries));
    for (let retryIndex = 0; ; retryIndex += 1) {
      // A turn the abort tree stopped (SIGINT, turn/model-call/run timer)
      // did not COMPLETE — grading its partial output would be noise, and
      // a retry would fight the very signal that stopped it.
      if (turnAbort.signal.aborted || runAbort.signal.aborted) return attempt;
      let graded: EvaluationResult;
      out.spinner.start("evaluating");
      try {
        graded = await evaluation.evaluate({
          finalText: terminalText(attempt.terminalContent),
          messages,
          usage: attempt.usage,
        });
      } catch (err) {
        // Grading INFRASTRUCTURE failure (judge model down, evaluator bug)
        // is not a verdict. Fail open: record it and let the turn stand —
        // a flaky judge must not kill an otherwise healthy run.
        const errObj = err as { name?: unknown; message?: unknown };
        const name = typeof errObj.name === "string" ? errObj.name : "EvaluationError";
        const message = typeof errObj.message === "string" ? errObj.message : String(err);
        runContext.logger.warn("evaluation: grader threw — turn stands un-graded", {
          name,
          message,
        });
        await logEvent("error", { name, message: `evaluation grader failed: ${message}` });
        return attempt;
      } finally {
        out.spinner.stop();
      }
      // A rogue evaluator returning NaN/±Infinity must not poison the
      // trace surface; treat non-finite as 0 (an unambiguous fail).
      const score = Number.isFinite(graded.score) ? graded.score : 0;
      const rationale = graded.rationale;
      const verdict: "pass" | "fail" = score >= evaluation.threshold ? "pass" : "fail";
      bus.publish({
        ...bus.envelope(),
        kind: "eval_graded",
        score,
        threshold: evaluation.threshold,
        verdict,
        graderType: evaluation.graderType,
        retryIndex,
      });
      if (verdict === "pass" || evaluation.onFail === "note") return attempt;
      const rationaleNote =
        rationale !== undefined && rationale.trim().length > 0 ? ` — ${rationale.trim()}` : "";
      if (evaluation.onFail === "halt") {
        const detail = `the ${evaluation.graderType} grader scored the final answer ${score.toFixed(2)}, below the required ${evaluation.threshold} threshold${rationaleNote}`;
        const report: FailureReport = {
          class: "evaluation",
          title: "in-loop evaluation gate failed",
          detail,
          remediation:
            "improve the agent (instructions/model), lower evaluation.threshold, or soften evaluation.on_fail to retry/note",
          exitCode: EXIT_CODES.evaluation,
        };
        await publishRunFailed(report);
        throw new RunFailedError(report);
      }
      // onFail: "retry" — bounded by the resolved cap; when spent, the last
      // attempt stands (the failing eval_graded trail tells the story).
      if (retryIndex >= maxRetries) return attempt;
      const feedback =
        rationale !== undefined && rationale.trim().length > 0
          ? ` Grader feedback: ${rationale.trim()}`
          : "";
      const correction = `[evaluation failed: scored ${score.toFixed(2)}, threshold ${evaluation.threshold}]${feedback}\nPlease revise your previous answer to address the feedback, then give the corrected answer in full.`;
      messages.push({ role: "user", content: correction });
      await logEvent("user_message", { content: correction, synthetic: true });
      attempt = await runOneTurn(messages);
    }
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
          onEvict: externalizeEvicted,
          getLedgerText: ledgerAnchorText,
          ...compactionExtras(),
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

      // Item 2 / G21 — refresh the volatile recalled block against this turn's
      // latest user message (no-op unless per-turn recall is enabled + due).
      await maybePerTurnRecall(messages);

      // G10 — the single turn IS the run: arm the per-turn ceiling around
      // it (the deadline timer is already live from boot). Fired timers
      // surface as a classified RunFailedError out of runOneTurn; the
      // finally below tears every timer down on all paths. (G02 — the
      // evaluated wrapper re-runs the turn on a failing verdict, all
      // attempts inside the same armed window: a retried turn is still ONE
      // turn against `turn_timeout_ms`.)
      armTurnTimer();
      const { terminalContent } = await runEvaluatedTurn(messages);
      clearTurnTimer();
      bus.publish({
        ...bus.envelope(),
        kind: "turn_end",
        turn: runContext.turnNumber,
        durationMs: performance.now() - t0SingleTurn,
      });
      return terminalText(terminalContent);
    } finally {
      clearAllTimers();
      out.spinner.stop();
      await fireHook("stop", {
        sessionId,
        turnCount: runContext.turnNumber,
        reason: "complete",
      });
      await maybeAutoCapture();
      // §2.8 — deterministic handoff, same teardown slot as onCapture.
      await maybeHandoff("complete");
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

  // G10 — a fired run deadline must also interrupt an IDLE `rl.question`
  // wait (the loop-top abort check only runs once input arrives), so each
  // prompt races this alongside the stdin-close sentinel.
  const RUN_ABORTED = Symbol("run-aborted");
  const runAbortedSignal = new Promise<typeof RUN_ABORTED>((resolve) => {
    if (runAbort.signal.aborted) {
      resolve(RUN_ABORTED);
    } else {
      runAbort.signal.addEventListener("abort", () => resolve(RUN_ABORTED), { once: true });
    }
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
        const result = await Promise.race([rl.question("\nyou> "), closedSignal, runAbortedSignal]);
        if (result === STDIN_CLOSED || result === RUN_ABORTED) break;
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

      // Pre-turn budget check: (curate) → snip → autocompact if still over.
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
          onEvict: externalizeEvicted,
          getLedgerText: ledgerAnchorText,
          ...compactionExtras(),
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

      // Item 2 / G21 — refresh the volatile recalled block against this turn's
      // latest user message (no-op unless per-turn recall is enabled + due).
      await maybePerTurnRecall(messages);

      // G10 — per-turn wall-clock ceiling: armed for exactly the
      // `runOneTurn` window, torn down on every exit (finally). A fired
      // turn/model-call timer aborts the turn and (REPL posture) control
      // returns to the prompt below — mirroring the first-SIGINT semantics;
      // a fired run deadline makes `runOneTurn` throw the classified
      // RunFailedError, which the catch rethrows.
      armTurnTimer();
      try {
        await runEvaluatedTurn(messages);
      } catch (err) {
        // Defensive: tear down any animation a thrown turn left spinning.
        out.spinner.stop();
        if (isAbortError(err)) {
          // Already-handled abort; loop back to the prompt.
          out.write("\n[turn aborted]\n");
        } else {
          throw err;
        }
      } finally {
        clearTurnTimer();
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

    // G10 — the loop exited on an aborted run root: when the RUN DEADLINE
    // (not a SIGINT/EOF) is what aborted it, the stop is terminal and
    // classified. Published here — still inside the try, BEFORE the finally
    // tears the bus subscribers down — then thrown so `crewhaus run`/bundle
    // wrappers render the report and exit with EXIT_CODES.timeout. (A
    // deadline that fired MID-turn already threw from inside runOneTurn and
    // never reaches this check.)
    const runTimeout = timeoutAbortReason(runAbort.signal);
    if (runTimeout !== undefined) {
      await throwTimeout(runTimeout);
    }
  } finally {
    clearAllTimers();
    out.spinner.stop();
    await fireHook("stop", {
      sessionId,
      turnCount: runContext.turnNumber,
      reason: runAbort.signal.aborted ? "abort" : "exit",
    });
    await maybeAutoCapture();
    // §2.8 — deterministic handoff, same teardown slot as onCapture.
    await maybeHandoff(runAbort.signal.aborted ? "abort" : "exit");
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

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch E) — shared helpers for active-context curation
// (Item 1 / G19), per-turn recall (Item 2 / G21) and message-level cache
// breakpoints (Item 9 / G79).
// ---------------------------------------------------------------------------

/** Item 4 / G28 — the provider's real INPUT token count for one response:
 *  fresh input + cache-read + cache-create (the whole prompt the provider
 *  counted), the accurate context-size signal chars/4 approximates. */
function responseInputTokens(u: ModelUsage): number {
  return u.input + (u.cacheRead ?? 0) + (u.cacheCreate ?? 0);
}

/**
 * The latest USER *text* message — the relevance query for the curator
 * (Item 1) and the per-turn recall refresh (Item 2). Tool-result user
 * messages carry no human words, so they're skipped: the query is what the
 * person actually said, not a tool payload. Returns `undefined` when no
 * text-bearing user message exists (a bare tool-result tail).
 */
function latestUserText(messages: ReadonlyArray<Anthropic.MessageParam>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    if (typeof m.content === "string") {
      if (m.content.length > 0) return m.content;
      continue;
    }
    const text = m.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Item 1 / G19 — a message is CURATABLE (safe for the curator to drop) only
 * when it is pure conversational text: no `tool_use` / `tool_result` blocks,
 * whose pairing the Anthropic API enforces (a dropped half orphans the other
 * and 400s the request). Removing a pure-text message can never orphan a pair
 * — consecutive same-role messages are merged server-side, exactly the
 * tolerance the snip marker path already relies on.
 */
function isCuratableMessage(m: Anthropic.MessageParam): boolean {
  const c = m.content;
  if (typeof c === "string") return true;
  for (const b of c) {
    if (b.type === "tool_use" || b.type === "tool_result") return false;
  }
  return true;
}

/** Item 1 / G19 — flatten a message's text for curator similarity + the
 *  `bytesSaved` accounting. Non-text blocks contribute nothing (they never
 *  reach the curator — only pure-text messages are curatable). */
function curatorItemText(m: Anthropic.MessageParam): string {
  const c = m.content;
  if (typeof c === "string") return c;
  return c
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

const LEXICAL_TOKEN_RE = /[a-z0-9]+/gi;

/** Item 1 / G19 — token set for the BM25-family lexical fallback. */
function lexicalTokens(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(LEXICAL_TOKEN_RE);
  if (matches !== null) for (const t of matches) out.add(t);
  return out;
}

/** Jaccard overlap of two token sets (the lexical similarity used by the
 *  no-embedder curation path). Two empty sets are identical (1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Item 1 / G19 — order-preserving lexical dedupe, the BM25-family fallback
 * when no embedder resolves (a vector store is unavailable). Mirrors the
 * curator's cosine `dedupeBySimilarity` structure but over token-set Jaccard:
 * an item is dropped when a PRIOR kept item's Jaccard >= threshold, so the
 * first occurrence (the head of the conversation, which carries goal-setting
 * context) always wins.
 */
function lexicalDedupe(
  texts: ReadonlyArray<string>,
  threshold: number,
): { kept: number[]; dropped: number[] } {
  const tokenSets = texts.map(lexicalTokens);
  const kept: number[] = [];
  const dropped: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    let isDuplicate = false;
    const ti = tokenSets[i];
    if (ti !== undefined) {
      for (const k of kept) {
        const tk = tokenSets[k];
        if (tk !== undefined && jaccard(ti, tk) >= threshold) {
          isDuplicate = true;
          break;
        }
      }
    }
    (isDuplicate ? dropped : kept).push(i);
  }
  return { kept, dropped };
}

type CurateConfig = {
  readonly embedder?: EmbedderFn;
  readonly dedupeThreshold?: number;
  readonly relevanceTopK?: number;
};

type CurateOutcome = {
  readonly messages: Anthropic.MessageParam[];
  readonly before: number;
  readonly after: number;
  readonly dropped: number;
  readonly bytesSaved: number;
  readonly embedded: boolean;
};

/**
 * Item 1 / G19 — the active-context curation pass. Runs `curate()` (cosine,
 * when an embedder is injected) or the lexical fallback over the CURATABLE
 * middle messages (pure-text, outside the snip-protected head/tail), then
 * REBUILDS the transcript keeping survivors in their original order. The
 * curator's relevance ranking is used only to SELECT which messages survive a
 * `relevanceTopK` trim — never to reorder the conversation, which would
 * scramble role alternation and tool pairing. Returns `null` when nothing was
 * eligible or nothing changed, so the caller skips the trace event. Best-
 * effort at the call site: an embedder throw propagates and the caller
 * degrades to the plain snip→autocompact ladder.
 */
async function curateActiveContext(
  messages: ReadonlyArray<Anthropic.MessageParam>,
  snipKeepHead: number,
  snipKeepTail: number,
  cfg: CurateConfig,
): Promise<CurateOutcome | null> {
  const firstCuratable = Math.max(0, snipKeepHead);
  const lastCuratable = messages.length - Math.max(0, snipKeepTail);
  const curatableIdx: number[] = [];
  for (let i = firstCuratable; i < lastCuratable; i++) {
    const m = messages[i];
    if (m !== undefined && isCuratableMessage(m)) curatableIdx.push(i);
  }
  // Need at least two comparable items for a dedupe/relevance decision.
  if (curatableIdx.length < 2) return null;

  const texts = curatableIdx.map((i) => curatorItemText(messages[i] as Anthropic.MessageParam));
  const threshold = cfg.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const query = latestUserText(messages);
  const embedded = cfg.embedder !== undefined;

  // `keepLocal` — indices INTO `curatableIdx`/`texts` that survive, ascending
  // (transcript order).
  let keepLocal: number[];
  if (embedded) {
    const items: CuratorItem[] = texts.map((t) => ({ text: t }));
    const result = await curateItems(items, {
      dedupeThreshold: threshold,
      embedder: cfg.embedder,
      // A query only matters for the topK trim — the relevance re-order is
      // undone by the re-sort below. Skip it (and its embedder call) unless a
      // topK cap is actually set.
      ...(cfg.relevanceTopK !== undefined && query !== undefined
        ? { query, relevanceTopK: cfg.relevanceTopK }
        : {}),
    });
    keepLocal = [...result.originalIndices].sort((a, b) => a - b);
  } else {
    const { kept } = lexicalDedupe(texts, threshold);
    let survivors = kept;
    if (
      cfg.relevanceTopK !== undefined &&
      query !== undefined &&
      survivors.length > cfg.relevanceTopK
    ) {
      const q = lexicalTokens(query);
      survivors = [...survivors]
        .sort((a, b) => {
          const sa = jaccard(q, lexicalTokens(texts[a] ?? ""));
          const sb = jaccard(q, lexicalTokens(texts[b] ?? ""));
          if (sa !== sb) return sb - sa;
          return a - b;
        })
        .slice(0, cfg.relevanceTopK)
        .sort((a, b) => a - b);
    }
    keepLocal = survivors;
  }

  const before = curatableIdx.length;
  const after = keepLocal.length;
  if (after >= before) return null; // dedupe + topK dropped nothing

  const textByGlobal = new Map<number, string>();
  curatableIdx.forEach((g, l) => textByGlobal.set(g, texts[l] as string));
  const keepGlobal = new Set(keepLocal.map((l) => curatableIdx[l] as number));
  const curatableSet = new Set(curatableIdx);

  const out: Anthropic.MessageParam[] = [];
  let bytesSaved = 0;
  for (let i = 0; i < messages.length; i++) {
    if (curatableSet.has(i) && !keepGlobal.has(i)) {
      bytesSaved += Buffer.byteLength(textByGlobal.get(i) ?? "", "utf8");
      continue; // curated away
    }
    out.push(messages[i] as Anthropic.MessageParam);
  }
  return { messages: out, before, after, dropped: before - after, bytesSaved, embedded };
}

/**
 * Item 2 / G21 — render the recalled-memory system block body with the SAME
 * two defenses the session-start recall uses (#53): neutralize any
 * `</recalled_memory>` breakout delimiter inside a recalled line, and run the
 * assembled block through `classifyBoundary` with origin `"user"` (recalled
 * lines may embed content shaped by untrusted tool output in an earlier
 * session). Returns `undefined` when there is nothing to recall.
 */
async function renderRecalledMemory(lines: readonly string[]): Promise<string | undefined> {
  if (lines.length === 0) return undefined;
  const body = lines.map((l) => `- ${escapeBoundaryDelimiter(l, "recalled_memory")}`).join("\n");
  const text = `<recalled_memory>\nRelevant facts remembered from earlier sessions:\n${body}\n</recalled_memory>`;
  await classifyBoundary(text, { origin: "user" }).catch(() => undefined);
  return text;
}

/**
 * Item 9 / G79 — stamp ONE message-level cache breakpoint so the settled
 * transcript prefix is a cache read on the next call instead of full-price
 * input every turn/tool-iteration. Marks the last message that carries
 * ARRAY content (an assistant turn or a tool_result) — never a bare string,
 * so the freshest user input stays OUTSIDE the cached prefix and a new turn
 * EXTENDS the cache rather than rebuilding it (Anthropic's recommended
 * incremental pattern), and string-content messages round-trip untouched.
 * A request-local copy: the persisted `messages` array never carries a
 * marker. One breakpoint here plus the single frozen system-prefix marker is
 * two — well under Anthropic's four. Caller gates on
 * `adapter.features.caching === "explicit"`.
 */
function withMessageCacheBreakpoint(
  messages: ReadonlyArray<Anthropic.MessageParam>,
): Anthropic.MessageParam[] {
  let target = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (Array.isArray(c) && c.length > 0) {
      target = i;
      break;
    }
  }
  if (target === -1) return [...messages];
  return messages.map((m, i) => (i === target ? stampCacheControlTail(m) : m));
}

/** Add `cache_control: { type: "ephemeral" }` to the last cache-eligible block
 *  of an ARRAY-content message. Walks back past `thinking`/`redacted_thinking`
 *  blocks (which reject the marker). */
function stampCacheControlTail(m: Anthropic.MessageParam): Anthropic.MessageParam {
  const content = m.content;
  if (typeof content === "string" || content.length === 0) return m;
  let idx = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    const t = content[i]?.type;
    if (t !== "thinking" && t !== "redacted_thinking") {
      idx = i;
      break;
    }
  }
  if (idx === -1) return m;
  const next = content.map((b, i) =>
    i === idx ? ({ ...b, cache_control: { type: "ephemeral" } } as typeof b) : b,
  );
  return { ...m, content: next as Anthropic.MessageParam["content"] };
}

type CompactionInfo = {
  readonly kind: "snip" | "autocompact";
  readonly before: number;
  readonly after: number;
  /** v0.3.0 §2.3 — the verbatim autocompact summary TEXT that replaced the
   *  history (additive; absent on snip steps), persisted into the
   *  `compaction` event-log payload so post-mortems can check WHAT the
   *  summary claimed survived — counts alone said nothing. */
  readonly summary?: string;
};

/** Item 1 / G19 — one active-context curation pass, reported so the caller
 *  publishes the `curate` trace event (mirrors {@link CompactionInfo}). */
type CurateInfo = {
  readonly before: number;
  readonly after: number;
  readonly dropped: number;
  readonly bytesSaved: number;
  readonly embedded: boolean;
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
  /** v0.3.0 §2.3 — invoked with the messages a step is about to drop,
   *  BEFORE the drop commits (and, for autocompact, before the summarizer
   *  model call — so the externalization survives even a summarizer
   *  failure). Absent → no externalization (pre-0.3.0 behavior). */
  onEvict?: (evicted: ReadonlyArray<Anthropic.MessageParam>) => Promise<void>;
  /** v0.3.0 §2.3 — lazily-rendered requirements-ledger text used to anchor
   *  the autocompact summarizer. Read AFTER `onEvict` folded this step's
   *  evictions, so the requirements at risk in THIS compaction anchor THIS
   *  summary. `undefined` keeps the summarizer prompt byte-identical. */
  getLedgerText?: () => string | undefined;
  /**
   * Item 4 / G28 — the provider's ACTUAL input_tokens from the last
   * `model_response` (input + cache read + cache create). When set it is the
   * trigger base (a real count, not the chars/4 heuristic) AND calibrates the
   * heuristic for the post-stage rechecks (`realInputTokens` minus the
   * ESTIMATED tokens each stage freed). Absent (pre-first-call, before any
   * response is on the bus) → the pure chars/4 heuristic, unchanged.
   */
  realInputTokens?: number;
  /**
   * Item 1 / G19 — active-context curation config (opt-in; presence runs the
   * pre-pass, gated by the caller on `ir.compaction.curate`). Embedder is
   * injected by the caller; absent → the BM25-family lexical fallback.
   */
  curate?: CurateConfig;
  /** Item 1 / G19 — reports one curation pass so the caller publishes the
   *  `curate` trace event (mirrors `onCompaction`). */
  onCurate?: (info: CurateInfo) => Promise<void>;
};

type OnCompaction = (info: CompactionInfo) => Promise<void>;

/** The messages `snip` dropped: input entries absent (by reference — snip
 *  copies references) from the output. The inserted marker is a fresh
 *  object, so it never shows up as "kept". */
function snippedAway(
  before: ReadonlyArray<Anthropic.MessageParam>,
  after: ReadonlyArray<Anthropic.MessageParam>,
): Anthropic.MessageParam[] {
  const kept = new Set<Anthropic.MessageParam>(after);
  return before.filter((m) => !kept.has(m));
}

/** Extract the summary text out of autoCompact's `[marker, summary]` tuple. */
function summaryTextOf(tuple: ReadonlyArray<Anthropic.MessageParam>): string | undefined {
  const summary = tuple[1];
  return summary !== undefined && typeof summary.content === "string" ? summary.content : undefined;
}

/**
 * Pre-turn compaction ladder: (curate) → estimate → snip → re-estimate →
 * autocompact. Returns the (possibly replaced) messages array. Pure with
 * respect to the input array; callers reassign. The optional `onCompaction`
 * callback fires once per applied step so the runtime can append a
 * `compaction` event to the session log without duplicating the
 * cost-estimation logic.
 *
 * Item 1 / G19 — when `args.curate` is set, the active-context curation pass
 * runs FIRST (only once the context is already approaching the limit): it
 * dedupes/relevance-trims the transcript, and when that alone frees enough
 * headroom the snip→autocompact ladder is skipped entirely (the whole point —
 * cheap dedupe before an expensive summarizer call). Item 4 / G28 — the
 * trigger + every re-check use the provider's real `input_tokens`
 * (`args.realInputTokens`) as the base, calibrating the chars/4 heuristic for
 * the post-stage deltas; absent (pre-first-call) → the pure heuristic.
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
    onEvict,
    getLedgerText,
    realInputTokens,
    curate: curateCfg,
    onCurate,
  } = args;

  // Item 4 / G28 — real-token calibration. The initial array's real size is
  // `realInputTokens` (the provider's count); every later stage subtracts the
  // ESTIMATED tokens it freed. Pre-first-call (`realInputTokens` undefined) →
  // the pure chars/4 estimate, byte-identical to the pre-0.4 trigger.
  const baseEstimate = estimateTokens(messages);
  const effectiveTokens = (msgs: ReadonlyArray<Anthropic.MessageParam>): number => {
    const est = estimateTokens(msgs);
    if (realInputTokens === undefined) return est;
    return Math.max(0, realInputTokens - (baseEstimate - est));
  };
  const approaching = (msgs: ReadonlyArray<Anthropic.MessageParam>): boolean => {
    const budget = new TokenBudget(contextLimit);
    budget.add(effectiveTokens(msgs), 0);
    return budget.isApproachingLimit(compactionThreshold);
  };

  if (!approaching(messages)) {
    return messages;
  }

  // Item 1 / G19 — active-context curation pre-pass. Dedupe + relevance-trim
  // the transcript before the snip→autocompact ladder; if it frees enough,
  // the ladder (and the summarizer model call) is skipped. Best-effort: an
  // embedder/curator failure degrades to the plain ladder below.
  let working = messages;
  if (curateCfg !== undefined) {
    try {
      const outcome = await curateActiveContext(working, snipKeepHead, snipKeepTail, curateCfg);
      if (outcome !== null) {
        working = outcome.messages;
        logger.info("active-context curation applied", {
          before: outcome.before,
          after: outcome.after,
          dropped: outcome.dropped,
          bytesSaved: outcome.bytesSaved,
          embedded: outcome.embedded,
        });
        if (onCurate !== undefined) {
          await onCurate({
            before: outcome.before,
            after: outcome.after,
            dropped: outcome.dropped,
            bytesSaved: outcome.bytesSaved,
            embedded: outcome.embedded,
          });
        }
        if (!approaching(working)) {
          return working; // curation alone freed enough — no snip/autocompact
        }
      }
    } catch (err) {
      logger.warn("active-context curation failed; falling back to snip/autocompact", {
        error: (err as Error).message,
      });
    }
  }

  const snipped = snip(working, snipKeepHead, snipKeepTail);
  // §2.3 — externalize what snip is about to drop BEFORE the drop commits.
  if (onEvict !== undefined) {
    const evicted = snippedAway(working, snipped);
    if (evicted.length > 0) await onEvict(evicted);
  }
  logger.info("snip applied", { before: working.length, after: snipped.length });
  if (onCompaction !== undefined) {
    await onCompaction({ kind: "snip", before: working.length, after: snipped.length });
  }

  if (!approaching(snipped)) {
    return snipped;
  }

  logger.info("autocompact triggered", { tokensAfterSnip: effectiveTokens(snipped) });
  // §2.3 — autocompact replaces the ENTIRE history; externalize all of it
  // before the summarizer model call so the records survive even a
  // summarizer failure. The ledger anchor is read afterwards so this
  // step's evictions are part of it.
  if (onEvict !== undefined && snipped.length > 0) await onEvict(snipped);
  const ledgerText = getLedgerText?.();
  const after = await autoCompact(
    snipped,
    adapter,
    model,
    ledgerText !== undefined ? { ledgerText } : {},
  );
  if (onCompaction !== undefined) {
    const summary = summaryTextOf(after);
    await onCompaction({
      kind: "autocompact",
      before: snipped.length,
      after: after.length,
      ...(summary !== undefined ? { summary } : {}),
    });
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
  /** See CompactArgs.onEvict — same contract on the reactive path. */
  onEvict?: (evicted: ReadonlyArray<Anthropic.MessageParam>) => Promise<void>;
  /** See CompactArgs.getLedgerText. */
  getLedgerText?: () => string | undefined;
};

/**
 * Reactive compaction triggered by the recovery engine on a prompt_too_long
 * error. Unlike pre-turn `maybeCompact`, this one runs unconditionally:
 * snip first, then autocompact (whose model summary reliably trims the
 * largest blob).
 */
async function forceCompact(args: ForceCompactArgs): Promise<Anthropic.MessageParam[]> {
  const { messages, adapter, model, snipKeepHead, snipKeepTail, logger, onEvict, getLedgerText } =
    args;
  const snipped = snip(messages, snipKeepHead, snipKeepTail);
  // §2.3 — same externalize-before-drop contract as the pre-turn ladder:
  // the snip diff first, then the full remaining history autocompact is
  // about to replace (disjoint sets, so no record is written twice).
  if (onEvict !== undefined) {
    const evicted = snippedAway(messages, snipped);
    if (evicted.length > 0) await onEvict(evicted);
  }
  logger.info("reactive snip applied", { before: messages.length, after: snipped.length });
  if (onEvict !== undefined && snipped.length > 0) await onEvict(snipped);
  const ledgerText = getLedgerText?.();
  return await autoCompact(snipped, adapter, model, ledgerText !== undefined ? { ledgerText } : {});
}

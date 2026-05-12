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
import { type WrappedAdapter, wrap as wrapWithCircuitBreaker } from "@crewhaus/circuit-breaker";
import { autoCompact } from "@crewhaus/compaction-autocompact";
import { snip } from "@crewhaus/compaction-snip";
import { RuntimeError } from "@crewhaus/errors";
import { type EventKind, type EventLog, openEventLog } from "@crewhaus/event-log";
import { type HookDef, type HookEvent, aggregateDecisions, runHooks } from "@crewhaus/hooks-engine";
import { resolveModel } from "@crewhaus/model-router";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type RuleSet,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
import { manage as manageCacheMarkers } from "@crewhaus/prompt-cache-manager";
import {
  buildRedactionNotice,
  classifyText,
  llmClassifierEnabled,
} from "@crewhaus/prompt-injection-detector";
import type { RateLimiter } from "@crewhaus/rate-limiter";
import {
  type RecoveryState,
  advanceState,
  initialRecoveryState,
  recover,
} from "@crewhaus/recovery-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { type SessionStore, createSessionStore } from "@crewhaus/session-store";
import { type SkillRef, formatSkillsForPrompt } from "@crewhaus/skills-registry";
import { type SlashCommand, expand as expandSlash } from "@crewhaus/slash-commands";
import { type Store, createStore } from "@crewhaus/state-store";
import { executeStreaming } from "@crewhaus/streaming-tool-executor";
import { TokenBudget, estimateTokens } from "@crewhaus/token-budget";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { type LoopDetection, detectLoop } from "@crewhaus/tool-loop-detection";
import { partitionToolCalls } from "@crewhaus/tool-orchestrator";
import { storeAndPreview } from "@crewhaus/tool-result-store";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  type ToolUseBlock as TsmToolUseBlock,
  type TurnState,
  initialState,
  transition,
} from "@crewhaus/turn-state-machine";
import { zodToJsonSchema } from "zod-to-json-schema";
import { attachDefaultSubscribers } from "./observability";

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
const DEFAULT_COMPACTION_THRESHOLD = 0.85;
const DEFAULT_SNIP_KEEP_HEAD = 4;
const DEFAULT_SNIP_KEEP_TAIL = 20;

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
  for await (const ev of log.read()) {
    if (ev.kind === "user_message") {
      const p = ev.payload as { content: Anthropic.MessageParam["content"] };
      messages.push({ role: "user", content: p.content });
    } else if (ev.kind === "assistant_message") {
      const p = ev.payload as { content: Anthropic.MessageParam["content"] };
      messages.push({ role: "assistant", content: p.content });
    }
  }
  return messages;
}

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
   * Section 27 — wrap the resolved primary `ProviderAdapter` in a circuit
   * breaker before any `stream()` call. When the breaker trips, subsequent
   * model calls reject immediately rather than hammering a degraded
   * upstream. Set via codegen when the spec lists `circuit_breaker:` opts.
   */
  circuitBreaker?: {
    readonly failureThreshold?: number;
    readonly windowMs?: number;
    readonly cooldownMs?: number;
  };
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
export async function runChatLoop(opts: RunChatLoopOptions): Promise<string> {
  // Section 17 — resolve the primary adapter via the model-router.
  // The router lazy-loads the matching provider package; an
  // Anthropic-only spec never pulls AWS / OpenAI / Gemini SDKs.
  // Section 17 — resolve the primary adapter via the model-router and
  // capture the *stripped* modelId (the form the provider expects, e.g.
  // `openai/gpt-4o-mini` → `gpt-4o-mini`). When the caller injects an
  // `_adapter`, default to `opts.model` for the wire model id — tests
  // typically pass synthetic ids the stub adapter ignores.
  const primaryResolution = opts._adapter
    ? { adapter: opts._adapter, modelId: opts.model, providerId: opts._adapter.providerId }
    : await resolveModel(opts.model);
  // Section 27 — wrap the primary adapter in a circuit breaker when
  // `circuitBreaker` opts are set (or by default in production codegen).
  // The breaker is hung off the run-context's bus so state-change events
  // surface for audit-log + structured-event-printer + OTel.
  const baseAdapter: ProviderAdapter = primaryResolution.adapter;
  let breakerWrap: WrappedAdapter | undefined;
  const adapter: ProviderAdapter = (() => {
    if (opts.circuitBreaker === undefined) return baseAdapter;
    breakerWrap = wrapWithCircuitBreaker(baseAdapter, {
      ...opts.circuitBreaker,
      adapterName: baseAdapter.providerId,
      bus: opts.runContext?.eventBus,
    });
    return breakerWrap;
  })();
  void breakerWrap; // exposed via runtime stats once gateway/eval consumers land
  const providerId: ProviderId = primaryResolution.providerId;
  const wireModelId: string = primaryResolution.modelId;
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
    compactionAdapter = adapter;
    compactionWireModelId = wireModelId;
  }
  const maxTokens = opts.maxTokens ?? 4096;

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
  const sessionRootDir = opts.sessionRootDir ?? process.env["CREWHAUS_SESSION_DIR"] ?? undefined;
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
  const subscribers = await attachDefaultSubscribers(bus, runContext);

  const eventLog: EventLog = await openEventLog(sessionId, { rootDir: sessionRootDir });

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
  // Section 17 — runtime-core no longer prepends the Claude Code OAuth
  // prefix; `adapter-anthropic` handles that internally so each adapter
  // owns its provider-specific auth-shape requirements.
  let systemBlocks: Anthropic.TextBlockParam[] = [userInstructions, ...skillsBlock];

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
    process.stdout.write(`[tool: ${tu.name}]\n`);
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
            : summariseNonStringContent(result.content),
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
    }
    if (!approved) {
      return finish({
        type: "tool_result",
        tool_use_id: tu.id,
        content: denialMessage ?? "tool denied",
        is_error: true,
      });
    }

    const toolAbort = turnAbort.child();
    // Build the bridge for this call. Skipped (left undefined) when no
    // spawnSubAgent injection is provided — non-Task tools don't need it.
    const bridge: RuntimeBridge | undefined =
      opts.spawnSubAgent !== undefined || opts.crewMailbox !== undefined
        ? {
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
          }
        : undefined;
    const raw = await executeTool(tool, tu.input, {
      toolUseId: tu.id,
      signal: toolAbort.signal,
      ...(bridge !== undefined ? { bridge } : {}),
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
    });
    const stored = await storeAndPreview(
      { toolUseId: raw.toolUseId, content: raw.content, isError: raw.isError },
      { runId: runContext.runId, toolUseId: tu.id },
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
    const finalPreview = await applyInjectionClassification(
      tool,
      tu,
      stored.previewContent,
      raw.isError,
    );
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
    isError: boolean,
  ): Promise<string | ReadonlyArray<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>> {
    if (tool.classifyOutput === false) return previewContent;
    if (isError) return previewContent;
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
  function summariseNonStringContent(
    content: ReadonlyArray<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> | undefined,
  ): string {
    if (content === undefined) return "[no content]";
    let images = 0;
    let texts = 0;
    let totalChars = 0;
    for (const block of content) {
      if (block.type === "image") {
        images++;
        if (block.source.type === "base64") totalChars += block.source.data.length;
      } else if (block.type === "text") {
        texts++;
        totalChars += block.text.length;
      }
    }
    const parts: string[] = [];
    if (images > 0) parts.push(`${images} image block${images > 1 ? "s" : ""}`);
    if (texts > 0) parts.push(`${texts} text block${texts > 1 ? "s" : ""}`);
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
    const partition = partitionToolCalls(toolUses, (n) => toolByName.get(n));
    runContext.logger.debug("tool partition", {
      concurrent: partition.concurrent.map((b) => b.length),
      serial: partition.serial.length,
    });
    const byId = new Map<string, Anthropic.ToolResultBlockParam>();
    for (const batch of partition.concurrent) {
      const settled = await Promise.all(batch.map((tu) => executeOneToolUse(tu)));
      for (const r of settled) byId.set(r.tool_use_id, r);
    }
    for (const tu of partition.serial) {
      const r = await executeOneToolUse(tu);
      byId.set(r.tool_use_id, r);
    }
    return toolUses.map((tu) => {
      const r = byId.get(tu.id);
      if (r === undefined) {
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: "internal error: missing tool result",
          is_error: true,
        };
      }
      return r;
    });
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

    while (state.kind !== "Done") {
      if (turnAbort.signal.aborted) {
        state = transition(state, { kind: "Aborted" });
        continue;
      }

      switch (state.kind) {
        case "NeedModel": {
          process.stdout.write("agent> ");
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
            process.stdout.write(`${blockedText}\n`);
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
          try {
            // Section 27 — rate-limit the model call before opening the
            // stream. The keys are caller-configured (typically
            // `[provider, tenant?]`); a missing bucket fails closed and
            // surfaces the RateLimitError up to recovery-engine.
            if (opts.rateLimiter && opts.rateLimitKeys && opts.rateLimitKeys.length > 0) {
              await opts.rateLimiter.acquire(opts.rateLimitKeys, 1);
            }
            const modelStartEnv = bus.envelope();
            bus.publish({
              ...modelStartEnv,
              kind: "model_request",
              model: opts.model,
              provider: providerId,
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
            const reqStream = adapter.stream({
              model: wireModelId,
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
                process.stdout.write(chunk);
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
              process.stdout.write("\n");

              messages.push({
                role: "assistant",
                content: finalContent as Anthropic.MessageParam["content"],
              });
              await logEvent("assistant_message", { content: finalContent });
              terminalContent = [...finalContent] as Anthropic.ContentBlock[];
              bus.publish({
                ...bus.envelope(),
                spanId: modelStartEnv.spanId,
                kind: "model_response",
                model: opts.model,
                provider: providerId,
                stopReason: stopReason ?? "end_turn",
                usage,
                durationMs: performance.now() - t0Model,
              });
              await fireHook("post-model", {
                streaming: true,
                contentBlocks: finalContent.length,
              });

              const toolUses = finalContent.filter(
                (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
              );
              if (toolUses.length === 0) {
                state = transition(state, { kind: "ModelReturnedText" });
                break;
              }

              for (const tu of toolUses) {
                toolUseHistory.push({ id: tu.id, name: tu.name, input: tu.input });
              }
              messages.push({ role: "user", content: [...toolResults] });
              await logEvent("user_message", { content: [...toolResults] });
              const warning = maybeBuildLoopWarning();
              if (warning !== null) {
                messages.push(warning);
                await logEvent("user_message", { content: warning.content });
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
                process.stdout.write(chunk);
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
            process.stdout.write("\n");

            bus.publish({
              ...bus.envelope(),
              spanId: modelStartEnv.spanId,
              kind: "model_response",
              model: opts.model,
              provider: providerId,
              stopReason: final.stopReason,
              usage: final.usage,
              durationMs: performance.now() - t0Model,
            });

            // Persist the assistant turn with the FULL content-block array;
            // tool_use blocks must survive into history so subsequent
            // tool_result references resolve.
            messages.push({
              role: "assistant",
              content: final.content as Anthropic.MessageParam["content"],
            });
            await logEvent("assistant_message", { content: final.content });
            terminalContent = [...final.content] as Anthropic.ContentBlock[];
            await fireHook("post-model", {
              streaming: false,
              stopReason: final.stopReason,
              contentBlocks: final.content.length,
            });

            // Synthetic max_output_tokens recovery: stop_reason "max_tokens"
            // means the model was cut off mid-reply. Route through the
            // recovery state machine so we ask it to continue.
            if (final.stopReason === "max_tokens") {
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
            if (isAbortError(err)) {
              state = transition(state, { kind: "Aborted" });
              break;
            }
            lastErrorForRecovery = err;
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
          const toolResults = await runToolBatch(state.toolUses);
          messages.push({ role: "user", content: toolResults });
          await logEvent("user_message", { content: toolResults });
          const warning = maybeBuildLoopWarning();
          if (warning !== null) {
            messages.push(warning);
            await logEvent("user_message", { content: warning.content });
          }
          state = transition(state, { kind: "ToolsExecuted" });
          break;
        }

        case "NeedCompaction":
          // Reserved: pre-turn compaction is run outside the state machine;
          // the recovery branch handles in-turn reactive compaction inline.
          state = transition(state, { kind: "CompactionDone" });
          break;

        case "NeedRecovery": {
          const action = recover(lastErrorForRecovery, recovery);
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
              const compacted = await forceCompact({
                messages,
                adapter: compactionAdapter,
                model: compactionWireModelId,
                snipKeepHead,
                snipKeepTail,
                logger: runContext.logger,
              });
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
              await new Promise((resolve) => setTimeout(resolve, action.delayMs));
              state = transition(state, { kind: "RecoveryDone" });
              break;
            case "continue": {
              const continueMsg = "Please continue from where you left off.";
              messages.push({ role: "user", content: continueMsg });
              await logEvent("user_message", { content: continueMsg });
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "tombstone": {
              const lastIdx = messages.length - 1;
              if (lastIdx >= 0 && messages[lastIdx]?.role === "assistant") {
                messages.pop();
              }
              const tombstoneMsg =
                "[previous assistant turn was rejected as invalid; please retry]";
              messages.push({ role: "user", content: tombstoneMsg });
              await logEvent("user_message", { content: tombstoneMsg });
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
      await fireHook("stop", {
        sessionId,
        turnCount: runContext.turnNumber,
        reason: "complete",
      });
      await subscribers.flushAll();
      await subscribers.shutdownAll();
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

  // SIGINT handler: first press during a turn aborts the turn; second
  // press exits. Counter resets at the start of each new turn. Default-on
  // whenever the runtime owns process.stdin (i.e. the test option
  // `opts.input` is unset). Tests that supply their own input stream skip
  // installation so they don't interfere with the test runner's signals.
  const shouldInstallSigint = opts.installSigintHandler ?? opts.input === undefined;
  let sigintPresses = 0;
  const sigintHandler = (): void => {
    sigintPresses += 1;
    if (sigintPresses === 1) {
      process.stdout.write("\n[turn aborted; press Ctrl-C again to exit]\n");
      turnAbort.abort();
    } else {
      process.stdout.write("\n[exiting]\n");
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
        if (isAbortError(err)) {
          // Already-handled abort; loop back to the prompt.
          process.stdout.write("\n[turn aborted]\n");
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
    await fireHook("stop", {
      sessionId,
      turnCount: runContext.turnNumber,
      reason: runAbort.signal.aborted ? "abort" : "exit",
    });
    await subscribers.flushAll();
    await subscribers.shutdownAll();
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

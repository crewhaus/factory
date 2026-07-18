// @crewhaus/worker-runtime — the platform-neutral agent loop.
//
// `runWorkerLoop` is the PURE core that `@crewhaus/runtime-core`'s
// `runChatLoop` mixes with node-coupled services: the turn finite-state
// machine, model-stream orchestration, tool dispatch+validation+permission
// gating, tool_result feedback, budget/limit enforcement, loop detection, and
// trace emission — with every host capability injected via `WorkerPlatform`.
// It composes the SAME already-platform-neutral engine packages the Node loop
// uses (`turn-state-machine`, `tool-executor`, `token-budget`,
// `tool-loop-detection`) and streams through the SAME `ProviderAdapter`
// interface, defaulting to the built-in edge Anthropic adapter over
// `platform.fetch`.
//
// v1 SCOPE (per the agent-loops plan): tools + budget + limits + trace.
// Compaction and recovery are deliberately OUT — they are Node-only services
// in `runtime-core`. On the edge a run that outgrows its context window ends
// with a classified `context_overflow` frame rather than compacting; there is
// no mid-run summariser. The loop runs one user→assistant turn with its tool
// inner-loop (the `singleTurn` shape), so a stateless worker serves one
// request→response and the client re-POSTs history for the next turn.

import type {
  CanonicalContentBlock,
  CanonicalContentBlockParam,
  CanonicalMessage,
  CanonicalTextBlockParam,
  CanonicalTool,
  CanonicalToolResultBlockParam,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import {
  EXIT_CODES,
  type FailureClass,
  type FailureReport,
  isRunFailedError,
} from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { DEFAULT_THRESHOLD, DEFAULT_WINDOW_SIZE, detectLoop } from "@crewhaus/tool-loop-detection";
import {
  type ToolUseBlock,
  type TurnState,
  initialState,
  transition,
} from "@crewhaus/turn-state-machine";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createEdgeAnthropicAdapter } from "./edge-anthropic";
import type { WorkerPlatform } from "./platform";
import { type TraceSink, noopTraceSink } from "./trace";

/** Default max OUTPUT tokens per model call (mirrors the inlined cf-worker client). */
export const DEFAULT_MAX_TOKENS = 4096;
/** Default hard cap on model→tool cycles in one turn (mirrors runtime-core's
 *  `DEFAULT_MAX_TOOL_ITERATIONS`). */
export const DEFAULT_MAX_TOOL_ITERATIONS = 50;
/** Default context-window ceiling in tokens (Claude opus/sonnet 4.x). */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Extended-thinking selector — the same two portable forms as the spec's
 *  `thinking:` block. */
export type WorkerThinking =
  | { readonly budgetTokens: number }
  | { readonly effort: "low" | "medium" | "high" };

/** Runtime ceilings, lowered from the spec's `limits:` block (the v1 subset). */
export type WorkerLimits = {
  /** Hard cap on model→tool cycles. Default {@link DEFAULT_MAX_TOOL_ITERATIONS}. */
  readonly maxToolIterations?: number;
  /** Context-window token ceiling; crossing it ends the run
   *  `context_overflow` (no compaction on the edge). Default
   *  {@link DEFAULT_CONTEXT_LIMIT}. */
  readonly contextLimit?: number;
  /** Whole-run wall-clock ceiling in ms, checked at each turn boundary
   *  against `platform.now()`. Absent → no deadline. */
  readonly deadlineMs?: number;
  /** Tool-loop detector tuning + escalation. */
  readonly loopDetection?: {
    readonly window?: number;
    readonly threshold?: number;
    /** `"warn"` (default) notes the loop on the trace bus; `"abort"` ends the
     *  turn when the signature trips again after its one-time warning. */
    readonly escalation?: "warn" | "abort";
  };
};

export type RunWorkerLoopOptions = {
  /** Injected host services — clock, id, fetch, optional KV. REQUIRED. */
  readonly platform: WorkerPlatform;
  /** The Anthropic model id the run streams through. */
  readonly model: string;
  /** System instructions (rendered as a single cache-eligible text block). */
  readonly instructions: string;
  /** The seed conversation; the last entry SHOULD be a `role: "user"` message. */
  readonly messages: ReadonlyArray<CanonicalMessage>;
  /** Tools the model may call. Empty/undefined → tools are not advertised. */
  readonly tools?: ReadonlyArray<RegisteredTool>;
  /** Max OUTPUT tokens per model call. Default {@link DEFAULT_MAX_TOKENS}. */
  readonly maxTokens?: number;
  /** Extended thinking. When set, the per-call token ceiling is lifted so the
   *  declared output budget survives beside the thinking budget. */
  readonly thinking?: WorkerThinking;
  /** Provider adapter. Defaults to the built-in edge Anthropic adapter built
   *  over `platform.fetch` with {@link RunWorkerLoopOptions.apiKey}. */
  readonly adapter?: ProviderAdapter;
  /** API key for the built-in edge adapter (ignored when `adapter` is passed). */
  readonly apiKey?: string;
  /** Runtime ceilings (the v1 `limits:` subset). */
  readonly limits?: WorkerLimits;
  /** Permission allow-patterns forwarded to `executeTool` (tool name / input
   *  globs). Absent → every advertised tool is permitted. */
  readonly allowedToolPatterns?: ReadonlyArray<string>;
  /** Cooperative-cancellation signal; forwarded to the model call and tools. */
  readonly signal?: AbortSignal;
  /** Trace sink for core (un-enveloped) events. Default: no-op. */
  readonly emitTrace?: TraceSink;
};

/** Why the loop ended. */
export type WorkerStopReason =
  | "done"
  | "max_iterations"
  | "timeout"
  | "context_overflow"
  | "aborted"
  | "error";

export type WorkerLoopResult = {
  /** Concatenated text of the terminal assistant message. */
  readonly text: string;
  /** The full message history after the run (seed + assistant + tool_result turns). */
  readonly messages: ReadonlyArray<CanonicalMessage>;
  /** Why the loop ended. */
  readonly stopReason: WorkerStopReason;
  /** Cumulative token usage across every model call this run. */
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreate: number;
  };
  /** Model→tool cycles executed. */
  readonly iterations: number;
  /** The classified failure when `stopReason` is a failing stop; absent on a
   *  clean `done` / `max_iterations` return. */
  readonly failure?: FailureReport;
};

/**
 * Run the loop and resolve with the terminal text + classified stop. NEVER
 * throws for a stop condition (deadline, budget, context overflow, loop
 * abort, provider error, unexpected tool throw) — every terminal condition
 * resolves as a {@link WorkerLoopResult} carrying a `stopReason` and, for the
 * failing stops, a `FailureReport` — so a stateless worker serialises a
 * classified frame instead of a 500.
 */
export async function runWorkerLoop(options: RunWorkerLoopOptions): Promise<WorkerLoopResult> {
  const { platform } = options;
  const emit = options.emitTrace ?? noopTraceSink;
  const baseMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxIterations = options.limits?.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const contextLimit = options.limits?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const loopWindow = options.limits?.loopDetection?.window ?? DEFAULT_WINDOW_SIZE;
  const loopThreshold = options.limits?.loopDetection?.threshold ?? DEFAULT_THRESHOLD;
  const loopEscalation = options.limits?.loopDetection?.escalation ?? "warn";
  const deadlineMs = options.limits?.deadlineMs;
  const startedAt = platform.now();

  const adapter =
    options.adapter ?? createEdgeAnthropicAdapter(platform, { apiKey: options.apiKey ?? "" });
  const tools = options.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t] as const));
  const canonicalTools: readonly CanonicalTool[] | undefined =
    tools.length > 0 ? tools.map(toCanonicalTool) : undefined;
  const system: readonly CanonicalTextBlockParam[] = [
    { type: "text", text: options.instructions, cache_control: { type: "ephemeral" } },
  ];

  const messages: CanonicalMessage[] = [...options.messages];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const toolHistory: ToolUseBlock[] = [];
  const warnedSignatures = new Set<string>();
  let iterations = 0;
  let terminalText = "";
  let lastStopReason = "end_turn";
  let failure: FailureReport | undefined;
  let stop: WorkerStopReason = "done";

  emit({ kind: "turn_start", turn: 1, messageCount: messages.length });

  let state: TurnState = initialState;
  try {
    while (state.kind !== "Done") {
      if (options.signal?.aborted) {
        stop = "aborted";
        state = transition(state, { kind: "Aborted" });
        continue;
      }
      switch (state.kind) {
        case "NeedModel": {
          if (deadlineMs !== undefined && platform.now() - startedAt >= deadlineMs) {
            failure = buildFailure(
              "timeout",
              "run deadline exceeded",
              `the run exceeded its ${deadlineMs}ms deadline`,
            );
            stop = "timeout";
            state = transition(state, { kind: "Aborted" });
            break;
          }
          const contextTokens = adapter.estimateTokens(messages);
          if (contextTokens >= contextLimit) {
            failure = buildFailure(
              "context_overflow",
              "context window exceeded",
              `estimated ${contextTokens} tokens meets the ${contextLimit}-token ceiling; compaction is unavailable on this target`,
              "shorten the conversation or raise limits.context_limit",
            );
            stop = "context_overflow";
            state = transition(state, { kind: "Aborted" });
            break;
          }
          const { maxTokens, thinking, reasoningEffort } = resolveThinking(
            options.thinking,
            baseMaxTokens,
          );
          const request: ProviderRequest = {
            model: options.model,
            system,
            messages,
            maxTokens,
            ...(canonicalTools !== undefined
              ? { tools: canonicalTools, toolChoice: { type: "auto" } }
              : {}),
            ...(thinking !== undefined ? { thinking } : {}),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          };
          emit({
            kind: "model_request",
            model: options.model,
            provider: "anthropic",
            messageCount: messages.length,
            toolCount: canonicalTools?.length ?? 0,
            streaming: true,
          });
          const callStarted = platform.now();
          const collected = await collectFinalMessage(adapter.stream(request));
          const durationMs = platform.now() - callStarted;
          if (collected.error !== undefined) {
            failure = classifyStreamError(collected.error);
            stop = "error";
            state = transition(state, { kind: "Aborted" });
            break;
          }
          usage.input += collected.usage.input;
          usage.output += collected.usage.output;
          usage.cacheRead += collected.usage.cacheRead;
          usage.cacheCreate += collected.usage.cacheCreate;
          lastStopReason = collected.stopReason;
          emit({
            kind: "model_response",
            model: options.model,
            provider: "anthropic",
            stopReason: collected.stopReason,
            usage: {
              input: collected.usage.input,
              output: collected.usage.output,
              cacheRead: collected.usage.cacheRead,
              cacheCreate: collected.usage.cacheCreate,
            },
            durationMs,
          });
          emit({
            kind: "cost_accrual",
            provider: "anthropic",
            modelId: options.model,
            inputTokens: collected.usage.input,
            outputTokens: collected.usage.output,
            cachedReadTokens: collected.usage.cacheRead,
            cacheCreationTokens: collected.usage.cacheCreate,
            costUsdMicros: 0,
            unpriced: true,
          });
          messages.push({ role: "assistant", content: collected.content });
          terminalText = extractText(collected.content);
          const toolUses = collectToolUses(collected.content);
          state =
            toolUses.length === 0
              ? transition(state, { kind: "ModelReturnedText" })
              : transition(state, { kind: "ModelReturnedToolUse", toolUses });
          break;
        }
        case "NeedTools": {
          iterations += 1;
          const toolUses = state.toolUses;
          for (const tu of toolUses) toolHistory.push(tu);

          const detection = detectLoop(toolHistory, loopWindow, loopThreshold);
          if (detection !== null) {
            if (!warnedSignatures.has(detection.signature)) {
              warnedSignatures.add(detection.signature);
              // First trip: a one-time note on the trace bus (the pre-0.4
              // warn-once behaviour); the turn proceeds.
            } else if (loopEscalation === "abort") {
              failure = buildFailure(
                "tool",
                "tool loop aborted",
                `tool "${detection.toolName}" repeated ${detection.count}x (${detection.tier}) within the detection window`,
              );
              stop = "error";
              state = transition(state, { kind: "Aborted" });
              break;
            }
          }

          if (iterations > maxIterations) {
            // A bounded stop, not a classified failure: the terminal text
            // stands and the run returns (mirrors runtime-core aborting the
            // turn at the iteration cap).
            stop = "max_iterations";
            state = transition(state, { kind: "Aborted" });
            break;
          }

          const results: CanonicalToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            emit({
              kind: "tool_call_start",
              toolUseId: tu.id,
              toolName: tu.name,
              inputBytes: byteLength(JSON.stringify(tu.input ?? {})),
            });
            const toolStarted = platform.now();
            const tool = toolMap.get(tu.name);
            let result: CanonicalToolResultBlockParam;
            let isError: boolean;
            if (tool === undefined) {
              isError = true;
              result = {
                type: "tool_result",
                tool_use_id: tu.id,
                content: `tool "${tu.name}" is not available on this worker`,
                is_error: true,
              };
            } else {
              const executed = await executeTool(tool, tu.input, {
                toolUseId: tu.id,
                ...(options.allowedToolPatterns !== undefined
                  ? { allowedPatterns: options.allowedToolPatterns }
                  : {}),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
              });
              isError = executed.isError;
              result = {
                type: "tool_result",
                tool_use_id: tu.id,
                content: executed.content as CanonicalToolResultBlockParam["content"],
                is_error: executed.isError,
              };
            }
            results.push(result);
            emit({
              kind: "tool_call_end",
              toolUseId: tu.id,
              toolName: tu.name,
              isError,
              outputBytes: byteLength(toolResultText(result.content)),
              durationMs: platform.now() - toolStarted,
            });
          }
          messages.push({ role: "user", content: results });
          state = transition(state, { kind: "ToolsExecuted" });
          break;
        }
        case "NeedCompaction":
        case "NeedRecovery": {
          // v1 excludes compaction/recovery — the loop never emits the events
          // that reach these states, so arriving here is an internal invariant
          // break. Fail closed with a classified frame rather than loop.
          failure = buildFailure(
            "config",
            "unsupported loop state",
            `reached ${state.kind}, which this target does not implement`,
          );
          stop = "error";
          state = transition(state, { kind: "Aborted" });
          break;
        }
      }
    }
  } catch (err) {
    failure = isRunFailedError(err) ? err.report : coerceFailure(err);
    stop = "error";
  }

  emit({
    kind: "turn_end",
    turn: 1,
    stopReason: lastStopReason,
    durationMs: platform.now() - startedAt,
  });
  if (failure !== undefined) {
    emit({
      kind: "run_failed",
      class: failure.class,
      message: `${failure.title}: ${failure.detail}`,
      ...(failure.remediation !== undefined ? { remediation: failure.remediation } : {}),
      exitCode: failure.exitCode,
    });
  }

  return {
    text: terminalText,
    messages,
    stopReason: stop,
    usage,
    iterations,
    ...(failure !== undefined ? { failure } : {}),
  };
}

// --------------------------------------------------------------------------
// Model-stream collection
// --------------------------------------------------------------------------

type CollectedUsage = { input: number; output: number; cacheRead: number; cacheCreate: number };
type CollectedMessage = {
  readonly content: CanonicalContentBlockParam[];
  readonly stopReason: string;
  readonly usage: CollectedUsage;
  readonly error?: { readonly type: string; readonly message: string };
};

type MutableBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; jsonBuf: string; seed: unknown }
  | { kind: "thinking"; thinking: string; signature: string };

/**
 * Accumulate a canonical stream into the final assistant message: text and
 * thinking deltas concatenate, `tool_use` input JSON accumulates across
 * `input_json_delta` frames and parses once at the end, and usage is
 * harvested from `message_start` (input/cache) + `message_delta` (final
 * output). A terminal `error` frame short-circuits with `{ error }`.
 */
async function collectFinalMessage(stream: AsyncIterable<StreamEvent>): Promise<CollectedMessage> {
  const blocks = new Map<number, MutableBlock>();
  const usage: CollectedUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let stopReason = "end_turn";
  for await (const ev of stream) {
    switch (ev.kind) {
      case "message_start":
        if (ev.usage !== undefined) {
          usage.input = ev.usage.input;
          usage.output = ev.usage.output;
          usage.cacheRead = ev.usage.cacheRead ?? 0;
          usage.cacheCreate = ev.usage.cacheCreate ?? 0;
        }
        break;
      case "content_block_start":
        blocks.set(ev.index, startBlock(ev.block));
        break;
      case "content_block_delta": {
        const block = blocks.get(ev.index);
        if (block !== undefined) applyDelta(block, ev.delta);
        break;
      }
      case "content_block_stop":
        break;
      case "message_delta":
        if (ev.stopReason !== undefined) stopReason = ev.stopReason;
        // Anthropic's message_delta usage carries only the final output count.
        if (ev.usage !== undefined && ev.usage.output > 0) usage.output = ev.usage.output;
        break;
      case "message_stop":
        break;
      case "error":
        return { content: [], stopReason, usage, error: ev.error };
    }
  }
  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => finalizeBlock(block))
    .filter((b): b is CanonicalContentBlockParam => b !== undefined);
  return { content, stopReason, usage };
}

function startBlock(block: CanonicalContentBlock): MutableBlock {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "tool_use":
      return { kind: "tool_use", id: block.id, name: block.name, jsonBuf: "", seed: block.input };
    case "thinking":
      return { kind: "thinking", thinking: block.thinking, signature: block.signature ?? "" };
  }
}

function applyDelta(
  block: MutableBlock,
  delta: (StreamEvent & { kind: "content_block_delta" })["delta"],
): void {
  switch (delta.type) {
    case "text_delta":
      if (block.kind === "text") block.text += delta.text;
      break;
    case "input_json_delta":
      if (block.kind === "tool_use") block.jsonBuf += delta.partial_json;
      break;
    case "thinking_delta":
      if (block.kind === "thinking") block.thinking += delta.thinking;
      break;
    case "signature_delta":
      if (block.kind === "thinking") block.signature += delta.signature;
      break;
  }
}

function finalizeBlock(block: MutableBlock): CanonicalContentBlockParam | undefined {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use": {
      let input: unknown = block.seed ?? {};
      if (block.jsonBuf.length > 0) {
        try {
          input = JSON.parse(block.jsonBuf);
        } catch {
          input = block.seed ?? {};
        }
      }
      return { type: "tool_use", id: block.id, name: block.name, input };
    }
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature.length > 0 ? { signature: block.signature } : {}),
      };
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function toCanonicalTool(tool: RegisteredTool): CanonicalTool {
  const inputSchema =
    tool.jsonSchema !== undefined
      ? (tool.jsonSchema as Record<string, unknown>)
      : (zodToJsonSchema(tool.inputSchema) as Record<string, unknown>);
  return { name: tool.name, description: tool.description, input_schema: inputSchema };
}

function collectToolUses(content: readonly CanonicalContentBlockParam[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const block of content) {
    if (block.type === "tool_use") out.push({ id: block.id, name: block.name, input: block.input });
  }
  return out;
}

function extractText(content: readonly CanonicalContentBlockParam[]): string {
  return content
    .filter((b): b is CanonicalTextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolResultText(content: CanonicalToolResultBlockParam["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
}

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Resolve the thinking selector into a wire `thinking` / `reasoningEffort`
 *  pair, lifting the per-call token ceiling so the declared output budget
 *  survives beside the thinking budget (Anthropic requires
 *  `max_tokens > thinking.budget_tokens`). */
function resolveThinking(
  thinking: WorkerThinking | undefined,
  baseMaxTokens: number,
): {
  maxTokens: number;
  thinking?: { readonly type: "enabled"; readonly budgetTokens: number };
  reasoningEffort?: "low" | "medium" | "high";
} {
  if (thinking === undefined) return { maxTokens: baseMaxTokens };
  if ("budgetTokens" in thinking) {
    return {
      maxTokens: baseMaxTokens + thinking.budgetTokens,
      thinking: { type: "enabled", budgetTokens: thinking.budgetTokens },
    };
  }
  const budget = EFFORT_BUDGET[thinking.effort];
  return { maxTokens: baseMaxTokens + budget, reasoningEffort: thinking.effort };
}

const EFFORT_BUDGET: Readonly<Record<"low" | "medium" | "high", number>> = {
  low: 2048,
  medium: 8192,
  high: 24576,
};

function buildFailure(
  cls: FailureClass,
  title: string,
  detail: string,
  remediation?: string,
): FailureReport {
  return {
    class: cls,
    title,
    detail,
    exitCode: EXIT_CODE_BY_CLASS[cls] ?? EXIT_CODES.generic,
    ...(remediation !== undefined ? { remediation } : {}),
  };
}

const EXIT_CODE_BY_CLASS: Partial<Record<FailureClass, number>> = {
  timeout: EXIT_CODES.timeout,
  crewhaus_budget: EXIT_CODES.crewhaus_budget,
  context_overflow: EXIT_CODES.config,
  auth: EXIT_CODES.auth,
  billing: EXIT_CODES.billing,
  rate_limit: EXIT_CODES.rate_limit,
  config: EXIT_CODES.config,
  tool: EXIT_CODES.tool,
  unknown: EXIT_CODES.generic,
};

/** Map a provider stream error to a classified failure by HTTP status. */
function classifyStreamError(error: {
  readonly type: string;
  readonly message: string;
}): FailureReport {
  const detail = `Anthropic said: ${JSON.stringify(error.message)}`;
  if (error.type === "http_401" || error.type === "http_403") {
    return buildFailure(
      "auth",
      "provider rejected the credentials",
      detail,
      "check the worker's ANTHROPIC_API_KEY secret",
    );
  }
  if (error.type === "http_402") {
    return buildFailure("billing", "provider account out of funding", detail);
  }
  if (error.type === "http_429") {
    return buildFailure("rate_limit", "provider rate limit exhausted", detail);
  }
  return buildFailure("unknown", "model call failed", detail);
}

function coerceFailure(err: unknown): FailureReport {
  const message = err instanceof Error ? err.message : String(err);
  return buildFailure("unknown", "worker loop crashed", message);
}

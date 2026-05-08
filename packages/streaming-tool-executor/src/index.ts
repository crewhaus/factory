import type Anthropic from "@anthropic-ai/sdk";
/**
 * Catalog R3 `streaming-tool-executor` — dispatch tool execution mid-
 * stream so the first tool can start running before `message_stop`.
 * Latency-sensitive turns (e.g. "read 5 files in parallel") finish
 * noticeably faster than the post-stream serial path.
 *
 * Section 17 refactor: this module previously consumed Anthropic's
 * SDK event-emitter (`AnthropicLikeStream` with `on("contentBlock")`).
 * It now consumes `AsyncIterable<StreamEvent>` directly so any
 * `ProviderAdapter` (Anthropic, OpenAI, Gemini, Bedrock) drives it.
 *
 * The dispatch logic is unchanged:
 *
 *   - No tools currently running → run.
 *   - Currently-running set is all concurrency-safe AND this entry is
 *     concurrency-safe → run.
 *   - Otherwise → wait for the running set to drain.
 *
 * Concurrency-safety follows the same triple-conjunction as
 * `tool-orchestrator`: `concurrencySafe && readOnly && !destructive`.
 *
 * Sibling abort: a per-call `AbortController` (`siblingAbortController`)
 * is signalled when a tool result errors AND `shouldAbortOnError` says
 * the failure is fatal. Pending queued tools are then short-circuited
 * with a synthetic error result. In-flight tools that don't honour the
 * signal complete normally — the abort affects what gets dispatched
 * next, not what is already mid-flight.
 */
import type { CanonicalContentBlock, StreamEvent, TokenUsage } from "@crewhaus/adapter-anthropic";
import { RuntimeError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";

export type StreamingToolEvent =
  | { kind: "tool-started"; toolUseId: string; toolName: string; startedAt: number }
  | {
      kind: "tool-finished";
      toolUseId: string;
      toolName: string;
      durationMs: number;
      isError: boolean;
    }
  | { kind: "sibling-aborted"; reason: string; failedToolName: string };

/** A reconstructed `tool_use` block — what `runTool` callbacks receive. */
export type CompletedToolUseBlock = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

export type StreamingExecuteOptions = {
  readonly toolByName: Map<string, RegisteredTool>;
  readonly onEvent?: (e: StreamingToolEvent) => void;
  readonly onTextDelta?: (chunk: string, blockIndex: number) => void;
  readonly abortSignal?: AbortSignal;
  /**
   * Decide whether a sibling tool failure should abort still-running
   * tools. Default: abort when the failing tool was destructive
   * (mirrors claude-code's Bash-only abort, but generalised).
   */
  readonly shouldAbortOnError?: (
    failedToolName: string,
    tool: RegisteredTool | undefined,
  ) => boolean;
  /**
   * Per-tool execution function used in place of the bare `executeTool`
   * call. The runtime supplies one that adds permission gating, per-tool
   * abort signals, and result-store wrapping so the streaming path
   * shares the same contract as the post-stream batch path.
   *
   * Must return a fully-formed `ToolResultBlockParam`; the streaming
   * executor uses it as-is. When omitted, falls back to a minimal
   * `executeTool`-only invocation (no permission gate, no result
   * persistence).
   */
  readonly runTool?: (block: CompletedToolUseBlock) => Promise<Anthropic.ToolResultBlockParam>;
};

export type StreamingExecuteResult = {
  readonly finalContent: ReadonlyArray<CanonicalContentBlock>;
  readonly toolResults: ReadonlyArray<Anthropic.ToolResultBlockParam>;
  readonly stopReason: string;
  readonly usage: TokenUsage;
};

type AccumulatedBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; jsonBuffer: string }
  | { kind: "thinking"; thinking: string; signature?: string };

type QueueEntry = {
  readonly block: CompletedToolUseBlock;
  readonly tool: RegisteredTool | undefined;
  status: "queued" | "running" | "done" | "aborted";
};

function defaultShouldAbortOnError(
  _failedToolName: string,
  tool: RegisteredTool | undefined,
): boolean {
  return tool?.destructive === true;
}

function isConcurrencySafe(tool: RegisteredTool | undefined): boolean {
  return tool?.concurrencySafe === true && tool.readOnly && !tool.destructive;
}

/**
 * Drive an `AsyncIterable<StreamEvent>` and dispatch `tool_use` blocks
 * as they complete. Resolves once the stream finalises AND every
 * dispatched (or aborted) tool settles. The returned `toolResults`
 * are sorted to match the order of `tool_use` blocks in
 * `finalContent` so downstream code can pair results back to their
 * original blocks by index.
 */
export async function executeStreaming(
  stream: AsyncIterable<StreamEvent>,
  opts: StreamingExecuteOptions,
): Promise<StreamingExecuteResult> {
  const queue: QueueEntry[] = [];
  const results = new Map<string, Anthropic.ToolResultBlockParam>();
  const inFlight = new Set<Promise<void>>();
  const siblingAbort = new AbortController();
  const shouldAbortOnError = opts.shouldAbortOnError ?? defaultShouldAbortOnError;
  const blocks = new Map<number, AccumulatedBlock>();
  // Order content blocks were OPENED in — tool_use ordering must
  // follow open-order for downstream pairing to work.
  const openOrder: number[] = [];
  let stopReason = "end_turn";
  let usage: TokenUsage = { input: 0, output: 0 };

  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      siblingAbort.abort("external_abort");
    } else {
      opts.abortSignal.addEventListener(
        "abort",
        () => {
          siblingAbort.abort("external_abort");
        },
        { once: true },
      );
    }
  }

  const fire = (e: StreamingToolEvent) => {
    if (opts.onEvent) opts.onEvent(e);
  };

  const dispatch = (entry: QueueEntry): void => {
    if (entry.status !== "queued") return;
    if (siblingAbort.signal.aborted) {
      entry.status = "aborted";
      results.set(entry.block.id, {
        type: "tool_result",
        tool_use_id: entry.block.id,
        content: "aborted: sibling tool failed",
        is_error: true,
      });
      return;
    }
    if (entry.tool === undefined && opts.runTool === undefined) {
      entry.status = "done";
      results.set(entry.block.id, {
        type: "tool_result",
        tool_use_id: entry.block.id,
        content: `unknown tool "${entry.block.name}"`,
        is_error: true,
      });
      return;
    }
    entry.status = "running";
    const startedAt = Date.now();
    fire({
      kind: "tool-started",
      toolUseId: entry.block.id,
      toolName: entry.block.name,
      startedAt,
    });
    const dispatchPromise: Promise<Anthropic.ToolResultBlockParam> = opts.runTool
      ? opts.runTool(entry.block)
      : entry.tool === undefined
        ? Promise.resolve<Anthropic.ToolResultBlockParam>({
            type: "tool_result",
            tool_use_id: entry.block.id,
            content: `unknown tool "${entry.block.name}"`,
            is_error: true,
          })
        : executeTool(entry.tool, entry.block.input, { toolUseId: entry.block.id }).then(
            (res): Anthropic.ToolResultBlockParam => ({
              type: "tool_result",
              tool_use_id: entry.block.id,
              content:
                typeof res.content === "string"
                  ? res.content
                  : (res.content as ReadonlyArray<
                      Anthropic.TextBlockParam | Anthropic.ImageBlockParam
                    > as Anthropic.ToolResultBlockParam["content"]),
              is_error: res.isError,
            }),
          );
    const promise = dispatchPromise
      .then((res) => {
        entry.status = "done";
        results.set(entry.block.id, res);
        const isError = res.is_error ?? false;
        fire({
          kind: "tool-finished",
          toolUseId: entry.block.id,
          toolName: entry.block.name,
          durationMs: Date.now() - startedAt,
          isError,
        });
        if (
          isError &&
          !siblingAbort.signal.aborted &&
          shouldAbortOnError(entry.block.name, entry.tool)
        ) {
          siblingAbort.abort("sibling_error");
          fire({
            kind: "sibling-aborted",
            reason: "sibling_error",
            failedToolName: entry.block.name,
          });
        }
      })
      .catch((err: unknown) => {
        entry.status = "done";
        const msg = err instanceof Error ? err.message : String(err);
        results.set(entry.block.id, {
          type: "tool_result",
          tool_use_id: entry.block.id,
          content: msg,
          is_error: true,
        });
      })
      .finally(() => {
        inFlight.delete(promise);
        processQueue();
      });
    inFlight.add(promise);
  };

  const processQueue = (): void => {
    for (const entry of queue) {
      if (entry.status !== "queued") continue;
      if (siblingAbort.signal.aborted) {
        entry.status = "aborted";
        results.set(entry.block.id, {
          type: "tool_result",
          tool_use_id: entry.block.id,
          content: "aborted: sibling tool failed",
          is_error: true,
        });
        continue;
      }
      if (inFlight.size === 0) {
        dispatch(entry);
        continue;
      }
      const runningAllSafe = queue.every(
        (e) => e.status !== "running" || isConcurrencySafe(e.tool),
      );
      if (runningAllSafe && isConcurrencySafe(entry.tool)) {
        dispatch(entry);
      } else {
        return;
      }
    }
  };

  // Walk the stream, accumulating blocks; on content_block_stop for a
  // tool_use, reconstruct it and enqueue.
  try {
    for await (const ev of stream) {
      switch (ev.kind) {
        case "message_start":
          if (ev.usage) usage = ev.usage;
          break;
        case "content_block_start":
          openOrder.push(ev.index);
          switch (ev.block.type) {
            case "text":
              blocks.set(ev.index, { kind: "text", text: ev.block.text });
              break;
            case "tool_use":
              blocks.set(ev.index, {
                kind: "tool_use",
                id: ev.block.id,
                name: ev.block.name,
                jsonBuffer: "",
              });
              break;
            case "thinking":
              blocks.set(ev.index, {
                kind: "thinking",
                thinking: ev.block.thinking,
                ...(ev.block.signature !== undefined ? { signature: ev.block.signature } : {}),
              });
              break;
          }
          break;
        case "content_block_delta": {
          const block = blocks.get(ev.index);
          if (block === undefined) break;
          if (ev.delta.type === "text_delta" && block.kind === "text") {
            block.text += ev.delta.text;
            opts.onTextDelta?.(ev.delta.text, ev.index);
          } else if (ev.delta.type === "input_json_delta" && block.kind === "tool_use") {
            block.jsonBuffer += ev.delta.partial_json;
          } else if (ev.delta.type === "thinking_delta" && block.kind === "thinking") {
            block.thinking += ev.delta.thinking;
          } else if (ev.delta.type === "signature_delta" && block.kind === "thinking") {
            block.signature = ev.delta.signature;
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(ev.index);
          if (block === undefined) break;
          if (block.kind === "tool_use") {
            let input: unknown = {};
            if (block.jsonBuffer.length > 0) {
              try {
                input = JSON.parse(block.jsonBuffer);
              } catch {
                input = { __parse_error: true, raw: block.jsonBuffer };
              }
            }
            const completed: CompletedToolUseBlock = {
              id: block.id,
              name: block.name,
              input,
            };
            // Persist the parsed input on the block so finalContent
            // reflects what we passed to runTool.
            (block as { jsonBuffer: string }).jsonBuffer = JSON.stringify(input);
            queue.push({
              block: completed,
              tool: opts.toolByName.get(completed.name),
              status: "queued",
            });
            processQueue();
          }
          break;
        }
        case "message_delta":
          if (ev.stopReason !== undefined) stopReason = ev.stopReason;
          if (ev.usage !== undefined) {
            usage = {
              input: ev.usage.input > 0 ? ev.usage.input : usage.input,
              output: ev.usage.output > 0 ? ev.usage.output : usage.output,
              ...(ev.usage.cacheRead !== undefined
                ? { cacheRead: ev.usage.cacheRead }
                : usage.cacheRead !== undefined
                  ? { cacheRead: usage.cacheRead }
                  : {}),
              ...(ev.usage.cacheCreate !== undefined
                ? { cacheCreate: ev.usage.cacheCreate }
                : usage.cacheCreate !== undefined
                  ? { cacheCreate: usage.cacheCreate }
                  : {}),
            };
          }
          break;
        case "message_stop":
          break;
        case "error":
          throw new RuntimeError(`streaming-tool-executor: stream error: ${ev.error.message}`);
      }
    }
  } catch (err) {
    throw new RuntimeError(
      `streaming-tool-executor: stream failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // Drain any tools still in flight or queued.
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }
  processQueue();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }

  // Build the final content array in open-order so tool_use blocks
  // surface in the same order they came down the wire (matching the
  // Anthropic-shaped final message historically returned).
  const finalContent: CanonicalContentBlock[] = [];
  const seen = new Set<number>();
  for (const idx of openOrder) {
    if (seen.has(idx)) continue;
    seen.add(idx);
    const b = blocks.get(idx);
    if (b === undefined) continue;
    if (b.kind === "text") {
      finalContent.push({ type: "text", text: b.text });
    } else if (b.kind === "tool_use") {
      let input: unknown = {};
      try {
        input = JSON.parse(b.jsonBuffer);
      } catch {
        input = { __parse_error: true, raw: b.jsonBuffer };
      }
      finalContent.push({ type: "tool_use", id: b.id, name: b.name, input });
    } else {
      finalContent.push({
        type: "thinking",
        thinking: b.thinking,
        ...(b.signature !== undefined ? { signature: b.signature } : {}),
      });
    }
  }

  // Sort tool results to match tool_use block order in finalContent.
  const ordered: Anthropic.ToolResultBlockParam[] = [];
  for (const block of finalContent) {
    if (block.type !== "tool_use") continue;
    const r = results.get(block.id);
    if (r !== undefined) ordered.push(r);
  }

  return { finalContent, toolResults: ordered, stopReason, usage };
}

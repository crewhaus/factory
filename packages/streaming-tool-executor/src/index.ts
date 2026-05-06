/**
 * Catalog R3 `streaming-tool-executor` — dispatch tool execution mid-
 * stream so the first tool can start running before the model emits
 * `message_stop`. Latency-sensitive turns (e.g. "read 5 files in
 * parallel") finish noticeably faster than the post-stream serial path.
 *
 * The Anthropic SDK fires a `contentBlock` event when each content
 * block in the stream completes (with parsed input already on the
 * block — see `MessageStream.d.ts:15`). We subscribe, enqueue any
 * `tool_use` blocks, and gate dispatch through `canExecute()`:
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
 *
 * Reference: `claude-code/services/tools/StreamingToolExecutor.ts` —
 * uses an internal scheduler with the same canExecute gate, plus a
 * Bash-only sibling-abort heuristic. We generalise via the catalog's
 * `destructive` flag and let callers override `shouldAbortOnError`.
 */
import type Anthropic from "@anthropic-ai/sdk";
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

export type StreamingExecuteOptions = {
  readonly toolByName: Map<string, RegisteredTool>;
  readonly onEvent?: (e: StreamingToolEvent) => void;
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
  readonly runTool?: (block: Anthropic.ToolUseBlock) => Promise<Anthropic.ToolResultBlockParam>;
};

export type StreamingExecuteResult = {
  readonly finalContent: ReadonlyArray<Anthropic.ContentBlock>;
  readonly toolResults: ReadonlyArray<Anthropic.ToolResultBlockParam>;
};

/**
 * Minimal shape of `Anthropic.MessageStream` that this executor
 * depends on. Tests supply a fake event-emitter conforming to this
 * surface so the load test (T7) can fire 50 synthetic `contentBlock`
 * events without spinning a real HTTP connection.
 */
export interface AnthropicLikeStream {
  on(event: "contentBlock", handler: (block: Anthropic.ContentBlock) => void): unknown;
  on(event: "text", handler: (chunk: string) => void): unknown;
  on(event: "end", handler: () => void): unknown;
  finalMessage(): Promise<{ content: ReadonlyArray<Anthropic.ContentBlock> }>;
}

type QueueEntry = {
  readonly block: Anthropic.ToolUseBlock;
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
 * Drive an `AnthropicLikeStream` and dispatch `tool_use` blocks as
 * they complete. Resolves once the stream finalises AND every
 * dispatched (or aborted) tool settles. The returned `toolResults`
 * are sorted to match the order of `tool_use` blocks in
 * `finalContent` so downstream code can pair results back to their
 * original blocks by index.
 */
export async function executeStreaming(
  stream: AnthropicLikeStream,
  opts: StreamingExecuteOptions,
): Promise<StreamingExecuteResult> {
  const queue: QueueEntry[] = [];
  const results = new Map<string, Anthropic.ToolResultBlockParam>();
  const inFlight = new Set<Promise<void>>();
  const siblingAbort = new AbortController();
  const shouldAbortOnError = opts.shouldAbortOnError ?? defaultShouldAbortOnError;

  // External abort propagates into the sibling controller so any
  // tools that DO honour the signal can wind down on user interrupt.
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
      // Without a custom runTool we cannot dispatch unknown tools. With a
      // runTool the caller decides what to do (e.g. emit a "not permitted"
      // result), so we delegate even when the local catalog has no entry.
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
        : executeTool(entry.tool, entry.block.input, { toolUseId: entry.block.id }).then((res) => ({
            type: "tool_result",
            tool_use_id: entry.block.id,
            content: res.content,
            is_error: res.isError,
          }));
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
        // executeTool catches its own throws and returns isError; this
        // catch is defence in depth.
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
        // Mark all remaining queued entries as aborted in one pass.
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
      // Currently running: only dispatch this entry if it AND every
      // currently-running entry are concurrency-safe.
      const runningAllSafe = queue.every(
        (e) => e.status !== "running" || isConcurrencySafe(e.tool),
      );
      if (runningAllSafe && isConcurrencySafe(entry.tool)) {
        dispatch(entry);
      } else {
        // Stop scanning: this entry must wait for the running set to
        // drain, and anything past it must wait for at least us.
        return;
      }
    }
  };

  stream.on("contentBlock", (block) => {
    if (block.type !== "tool_use") return;
    queue.push({
      block,
      tool: opts.toolByName.get(block.name),
      status: "queued",
    });
    processQueue();
  });

  let final: { content: ReadonlyArray<Anthropic.ContentBlock> };
  try {
    final = await stream.finalMessage();
  } catch (err) {
    throw new RuntimeError(
      `streaming-tool-executor: stream failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  // Some `tool_use` blocks may arrive only at message_stop (the SDK
  // emits them right before resolving finalMessage). Reconcile the
  // queue against the final content so nothing is missed.
  for (const block of final.content) {
    if (block.type !== "tool_use") continue;
    if (queue.some((e) => e.block.id === block.id)) continue;
    queue.push({
      block,
      tool: opts.toolByName.get(block.name),
      status: "queued",
    });
  }
  processQueue();

  // Wait for everything in flight to settle. processQueue drains
  // pending entries as in-flight tools resolve.
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }
  // Re-process once more in case the very last drain unlocked a
  // queued non-safe tool.
  processQueue();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }

  // Sort results by the order of tool_use blocks in finalContent.
  const ordered: Anthropic.ToolResultBlockParam[] = [];
  for (const block of final.content) {
    if (block.type !== "tool_use") continue;
    const r = results.get(block.id);
    if (r !== undefined) ordered.push(r);
  }

  return { finalContent: final.content, toolResults: ordered };
}

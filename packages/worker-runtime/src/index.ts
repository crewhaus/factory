/**
 * @crewhaus/worker-runtime — a platform-neutral agent-loop runtime.
 *
 * The PURE loop core `@crewhaus/runtime-core`'s `runChatLoop` mixes with
 * node-coupled services (event-log, session-store, compaction, recovery,
 * audit sinks), extracted so it can run anywhere `fetch` exists — most
 * importantly a Cloudflare Worker. Every host capability (clock, unique ids,
 * outbound HTTP, durable KV) is injected via {@link WorkerPlatform}; the
 * package imports NO `node:*` builtin and calls neither `Date.now()` nor
 * `Math.random()` (a source-grep test enforces both).
 *
 * v1 covers tools + budget + limits + trace. Compaction and recovery stay
 * Node-only in `runtime-core`; on the edge a context overflow ends the run
 * with a classified frame rather than compacting.
 *
 * @example A stateless Cloudflare Worker
 * ```ts
 * const result = await runWorkerLoop({
 *   platform: {
 *     now: () => Date.now(),
 *     randomId: () => crypto.randomUUID(),
 *     fetch: fetch.bind(globalThis),
 *   },
 *   model: "claude-sonnet-4-5",
 *   instructions: CONFIG.instructions,
 *   messages: [{ role: "user", content: userText }],
 *   apiKey: env.ANTHROPIC_API_KEY,
 *   tools: edgeSafeTools,
 *   emitTrace: (e) => sseEmit("trace", e),
 * });
 * ```
 */

export type { KVLike, WorkerPlatform } from "./platform";
export {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TOOL_ITERATIONS,
  type RunWorkerLoopOptions,
  runWorkerLoop,
  type WorkerLimits,
  type WorkerLoopResult,
  type WorkerStopReason,
  type WorkerThinking,
} from "./loop";
export {
  createEdgeAnthropicAdapter,
  EDGE_EFFORT_THINKING_BUDGET_TOKENS,
  type EdgeAnthropicAdapterOptions,
} from "./edge-anthropic";
export { noopTraceSink, type TraceSink, type WorkerTraceEvent } from "./trace";
// The cf-worker edge-safety tool policy is ALSO available at the
// `@crewhaus/worker-runtime/tool-policy` subpath, which the compiler imports
// so its offline gate never drags the loop into the compiler-worker's CF
// bundle. Re-exported here for runtime consumers.
export {
  classifyEdgeTool,
  EDGE_SAFE_TOOLS,
  type EdgeToolPartition,
  type EdgeToolVerdict,
  HOST_ONLY_TOOLS,
  isEdgeSafeTool,
  MCP_TOOL_PREFIX,
  partitionEdgeTools,
} from "./tool-policy";

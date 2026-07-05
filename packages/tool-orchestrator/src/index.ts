/**
 * Catalog R3 `tool-orchestrator` — partition a flat list of `tool_use`
 * blocks into concurrent batches and serial calls based on catalog
 * metadata. The runtime runs the concurrent batches via `Promise.all`
 * and the serial calls one-at-a-time, recovering most of the wall-clock
 * latency of read-heavy turns without ever paralleling side effects.
 *
 * A call is **concurrent-safe** iff its registered tool has all three
 * flags set the right way:
 *   `concurrencySafe && readOnly && !destructive`
 * — i.e. the tool author explicitly opted into parallelism AND the
 * call is read-only AND not destructive. Any single negation falls
 * through to serial. Unknown tool names also go serial (fail-closed).
 *
 * A tool whose per-call safety can't be captured by static flags (e.g.
 * `Task`, whose safety depends on which sub-agent it spawns) may instead
 * ship a `concurrencyClassifier(input, catalog)`; when present it decides
 * per invocation and overrides the static flags. `partitionToolCalls`
 * takes the sibling `catalog` so those classifiers can resolve what they
 * need — see {@link isCallConcurrencySafe}.
 *
 * The returned shape `{ concurrent: ToolUseBlock[][], serial: ToolUseBlock[] }`
 * deliberately drops interleaving information between batch and serial
 * groups. The runtime executes all concurrent batches first via
 * `Promise.all`, then serial sequentially. This is sound for the typical
 * "read N files, then mutate one" pattern. If a turn truly needs an
 * `[Read, Write, Read]` order with the second Read seeing post-Write
 * state, the model should split it across turns.
 *
 * Reference: `claude-code/services/tools/toolOrchestration.ts`
 * `partitionToolCalls` (returns a `Batch[]` of consecutive groups). We
 * mirror its concurrency-safety predicate but flatten to the
 * spec-prescribed two-bucket return.
 */
import type { RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import type { ToolUseBlock } from "@crewhaus/turn-state-machine";

export type ToolPartition = {
  readonly concurrent: ReadonlyArray<ReadonlyArray<ToolUseBlock>>;
  readonly serial: ReadonlyArray<ToolUseBlock>;
};

/**
 * Function or `ToolCatalog` that resolves a tool name to its registered
 * metadata. Returning `undefined` is treated as "unknown tool" and the
 * call is routed serial so the executor can produce a clear error result.
 */
export type ToolLookup = ToolCatalog | ((name: string) => RegisteredTool | undefined);

/**
 * Decide whether a registered tool's call is safe to run in parallel
 * with sibling calls. Concurrency-safety is a triple-conjunction so a
 * tool author has to opt into BOTH the concurrency contract and the
 * read-only contract — destructive flag is the killswitch.
 */
export function isConcurrencySafe(tool: RegisteredTool): boolean {
  return tool.concurrencySafe && tool.readOnly && !tool.destructive;
}

/**
 * Per-CALL concurrency safety. Most tools decide this from their static
 * flags via {@link isConcurrencySafe}, but some (notably `Task`) can only
 * decide per invocation — a sub-agent dispatch is parallel-safe iff the
 * specific sub-agent it spawns is itself read-only. Such a tool ships a
 * `concurrencyClassifier(input, catalog)`; when present it wins over the
 * static flags. The classifier is treated fail-closed: a missing tool, a
 * throw, or a `false` return all route the call serial.
 *
 * `catalog` is the sibling tool set the classifier may need (Task uses it
 * to resolve the child's effective tool catalog). Callers that can't
 * supply it pass `[]`, which keeps classifier-based tools serial — the
 * pre-existing behavior — while leaving flag-based tools unaffected.
 */
export function isCallConcurrencySafe(
  call: ToolUseBlock,
  tool: RegisteredTool | undefined,
  catalog: ReadonlyArray<RegisteredTool>,
): boolean {
  if (tool === undefined) return false;
  if (tool.concurrencyClassifier !== undefined) {
    try {
      return tool.concurrencyClassifier(call.input, catalog);
    } catch {
      return false;
    }
  }
  return isConcurrencySafe(tool);
}

function asLookup(lookup: ToolLookup): (name: string) => RegisteredTool | undefined {
  if (typeof lookup === "function") return lookup;
  return (name) => lookup.get(name);
}

/**
 * Walk `calls` in order, grouping consecutive concurrency-safe calls
 * into the same batch. A non-safe call breaks the run and is appended
 * to `serial`. The order of returned concurrent batches mirrors the
 * order in which they appeared in `calls`.
 */
export function partitionToolCalls(
  calls: ReadonlyArray<ToolUseBlock>,
  lookup: ToolLookup,
  catalog: ReadonlyArray<RegisteredTool> = [],
): ToolPartition {
  const get = asLookup(lookup);
  const concurrent: ToolUseBlock[][] = [];
  const serial: ToolUseBlock[] = [];

  let currentBatch: ToolUseBlock[] | null = null;
  for (const call of calls) {
    const tool = get(call.name);
    const safe = isCallConcurrencySafe(call, tool, catalog);
    if (safe) {
      if (currentBatch === null) {
        currentBatch = [call];
        concurrent.push(currentBatch);
      } else {
        currentBatch.push(call);
      }
    } else {
      currentBatch = null;
      serial.push(call);
    }
  }

  return { concurrent, serial };
}

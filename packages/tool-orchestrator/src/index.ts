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
): ToolPartition {
  const get = asLookup(lookup);
  const concurrent: ToolUseBlock[][] = [];
  const serial: ToolUseBlock[] = [];

  let currentBatch: ToolUseBlock[] | null = null;
  for (const call of calls) {
    const tool = get(call.name);
    const safe = tool !== undefined && isConcurrencySafe(tool);
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

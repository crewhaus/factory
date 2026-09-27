/**
 * Catalog R3 `tool-orchestrator` — group a turn's `tool_use` blocks into
 * concurrent batches and serial calls based on catalog metadata. The
 * runtime runs a concurrent batch in parallel and a serial call alone,
 * recovering most of the wall-clock latency of read-heavy turns without
 * ever parallelising side effects or reordering them.
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
 * The partition's `groups` keep the model's order: a maximal run of
 * consecutive concurrency-safe calls is one `concurrent` group, and every
 * other call is its own `serial` group, in the order the model issued them.
 * A batch never crosses a serial call, so in `[Read, Write, Read]` the second
 * Read runs after the Write and sees what it wrote. The runtime runs the
 * groups in order (a concurrent group's calls in parallel, up to its cap),
 * which is also the dispatch rule the streaming executor follows, so a turn
 * gives the same results with and without `agent.streaming`.
 *
 * `concurrent` and `serial` are the pre-0.7.1 flat views of the same
 * partition, derived from `groups`. They drop the interleaving, so running
 * them bucket by bucket reorders a turn; they stay only for callers that
 * read them as data.
 *
 * Reference: `claude-code/services/tools/toolOrchestration.ts`
 * `partitionToolCalls` (returns a `Batch[]` of consecutive groups) — the
 * same predicate and the same ordered-groups shape.
 */
import type { RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import type { ToolUseBlock } from "@crewhaus/turn-state-machine";

/**
 * One step of a turn's execution plan: a run of consecutive
 * concurrency-safe calls that may run in parallel, or one call that runs
 * alone.
 */
export type ToolGroup =
  | { readonly kind: "concurrent"; readonly calls: ReadonlyArray<ToolUseBlock> }
  | { readonly kind: "serial"; readonly call: ToolUseBlock };

export type ToolPartition = {
  /** The calls in the model's order, grouped; run these in order. */
  readonly groups: ReadonlyArray<ToolGroup>;
  /**
   * @deprecated The concurrent groups' calls, without their position
   * relative to the serial calls. Run {@link ToolPartition.groups} instead.
   */
  readonly concurrent: ReadonlyArray<ReadonlyArray<ToolUseBlock>>;
  /**
   * @deprecated The serial calls, without their position relative to the
   * concurrent groups. Run {@link ToolPartition.groups} instead.
   */
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
 * Walk `calls` in order, grouping consecutive concurrency-safe calls into
 * one concurrent group. A non-safe call ends the run and becomes its own
 * serial group, so the groups flatten back to `calls` in the same order.
 */
export function groupToolCalls(
  calls: ReadonlyArray<ToolUseBlock>,
  lookup: ToolLookup,
  catalog: ReadonlyArray<RegisteredTool> = [],
): ReadonlyArray<ToolGroup> {
  const get = asLookup(lookup);
  const groups: ToolGroup[] = [];
  let currentBatch: ToolUseBlock[] | null = null;
  for (const call of calls) {
    const tool = get(call.name);
    if (isCallConcurrencySafe(call, tool, catalog)) {
      if (currentBatch === null) {
        currentBatch = [call];
        groups.push({ kind: "concurrent", calls: currentBatch });
      } else {
        currentBatch.push(call);
      }
    } else {
      currentBatch = null;
      groups.push({ kind: "serial", call });
    }
  }
  return groups;
}

/**
 * {@link groupToolCalls}, plus the flat `concurrent` / `serial` views
 * earlier releases returned. Each concurrent batch in `concurrent` is the
 * same array as its group's `calls`.
 */
export function partitionToolCalls(
  calls: ReadonlyArray<ToolUseBlock>,
  lookup: ToolLookup,
  catalog: ReadonlyArray<RegisteredTool> = [],
): ToolPartition {
  const groups = groupToolCalls(calls, lookup, catalog);
  const concurrent: ReadonlyArray<ToolUseBlock>[] = [];
  const serial: ToolUseBlock[] = [];
  for (const group of groups) {
    if (group.kind === "concurrent") concurrent.push(group.calls);
    else serial.push(group.call);
  }
  return { groups, concurrent, serial };
}

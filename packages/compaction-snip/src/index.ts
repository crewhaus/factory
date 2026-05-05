/**
 * Catalog R6 `compaction-snip` — pure transformation that drops middle
 * messages and inserts a one-line marker at the snip point. No model
 * call. The Anthropic API rejects a tool_result whose tool_use_id has
 * no matching tool_use earlier in the array, so the snip boundary is
 * widened when the naive cut would orphan a pair.
 *
 * Reference: claude-code/services/compact/snipCompact.ts
 */
import type Anthropic from "@anthropic-ai/sdk";

const MARKER_PREFIX = "[Context compacted: ";
const MARKER_SUFFIX = " messages removed]";

/**
 * Keep the first `keepHead` and last `keepTail` messages, replace
 * everything in between with one assistant marker. Returns a copy
 * (does not mutate the input).
 *
 * If the requested boundary would split a tool_use/tool_result pair,
 * the head boundary advances forward and the tail boundary retreats
 * backward until both halves are self-contained. Worst case the input
 * is returned unchanged.
 */
export function snip(
  messages: ReadonlyArray<Anthropic.MessageParam>,
  keepHead: number,
  keepTail: number,
): Anthropic.MessageParam[] {
  if (keepHead < 0 || keepTail < 0) {
    throw new RangeError(`keepHead/keepTail must be >= 0 (got ${keepHead}, ${keepTail})`);
  }
  const total = messages.length;
  if (total <= keepHead + keepTail) {
    return [...messages];
  }

  // Naive cut: keep [0, headEnd), drop [headEnd, tailStart), keep [tailStart, total).
  let headEnd = keepHead;
  let tailStart = total - keepTail;

  // Defend against orphaning: ensure no tool_result in the kept tail
  // references a tool_use that was dropped, and no tool_use in the
  // kept head has its tool_result inside the dropped middle.
  const adjusted = adjustForToolPairing(messages, headEnd, tailStart);
  headEnd = adjusted.headEnd;
  tailStart = adjusted.tailStart;

  if (headEnd >= tailStart) {
    // Adjustment collapsed the snip — nothing to remove.
    return [...messages];
  }

  const removed = tailStart - headEnd;
  const marker: Anthropic.MessageParam = {
    role: "assistant",
    content: `${MARKER_PREFIX}${removed}${MARKER_SUFFIX}`,
  };
  return [...messages.slice(0, headEnd), marker, ...messages.slice(tailStart)];
}

function adjustForToolPairing(
  messages: ReadonlyArray<Anthropic.MessageParam>,
  initialHeadEnd: number,
  initialTailStart: number,
): { headEnd: number; tailStart: number } {
  let headEnd = initialHeadEnd;
  let tailStart = initialTailStart;

  // Iterate until both boundaries stop moving. Each pass either pulls
  // a stranded tool_use/tool_result back into the kept range or stops.
  for (let i = 0; i < messages.length; i++) {
    const headIds = collectToolUseIds(messages.slice(0, headEnd));
    const tailIds = collectToolResultIds(messages.slice(tailStart));

    // tool_use in head whose tool_result lives in dropped middle —
    // pull tailStart back so the result is preserved.
    let moved = false;
    for (const id of headIds) {
      const resultIdx = findToolResultIndex(messages, id);
      if (resultIdx >= 0 && resultIdx >= headEnd && resultIdx < tailStart) {
        // Pull the boundary back to include up through resultIdx.
        tailStart = resultIdx;
        moved = true;
      }
    }

    // tool_result in tail whose tool_use lives in dropped middle —
    // pull headEnd forward so the use is preserved.
    for (const id of tailIds) {
      const useIdx = findToolUseIndex(messages, id);
      if (useIdx >= 0 && useIdx >= headEnd && useIdx < tailStart) {
        headEnd = useIdx + 1;
        moved = true;
      }
    }

    if (!moved) break;
    if (headEnd >= tailStart) break;
  }

  return { headEnd, tailStart };
}

function collectToolUseIds(messages: ReadonlyArray<Anthropic.MessageParam>): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") ids.push(block.id);
    }
  }
  return ids;
}

function collectToolResultIds(messages: ReadonlyArray<Anthropic.MessageParam>): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") ids.push(block.tool_use_id);
    }
  }
  return ids;
}

function findToolUseIndex(messages: ReadonlyArray<Anthropic.MessageParam>, id: string): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use" && block.id === id) return i;
    }
  }
  return -1;
}

function findToolResultIndex(messages: ReadonlyArray<Anthropic.MessageParam>, id: string): number {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_result" && block.tool_use_id === id) return i;
    }
  }
  return -1;
}

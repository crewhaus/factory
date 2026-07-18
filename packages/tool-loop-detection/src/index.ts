/**
 * Catalog R3 `tool-loop-detection` — flag when the model gets stuck
 * making the same `(toolName, input)` call over and over. The runtime
 * runs `detectLoop()` after every batch of tool executions; on a hit
 * it injects a synthetic warning message so the model can self-correct.
 *
 * Detection is a simple sliding-window count. Take the last
 * `windowSize` tool calls, compute a canonical signature for each
 * (`toolName + ":" + canonicalJson(input)`), and return the first
 * signature whose count meets `threshold`. Canonical JSON sorts object
 * keys recursively so `{a:1,b:2}` and `{b:2,a:1}` collapse to the same
 * signature.
 *
 * Loop contract 0.4 (G27) adds a NEAR-DUPLICATE tier: calls to the same
 * tool whose inputs differ only in volatile substrings (numbers, UUIDs,
 * hashes, whitespace — the classic "retry with page 2 / a fresh id"
 * churn that defeats exact matching) are grouped under a normalized
 * signature and counted at {@link NEAR_DUPLICATE_WEIGHT} weight. The
 * exact tier is checked first and its behaviour is byte-identical to the
 * pre-0.4 detector; only when no exact signature trips does the weighted
 * near pass run. Deliberately cheap: pure string normalization — no
 * embeddings, no edit distance.
 *
 * No hashing — plain string signatures keep memory tiny (a single
 * detection map per check) and make debug output readable. Cross-turn:
 * the runtime feeds its full per-run tool-use history, so loops that
 * span turns get caught.
 *
 * Reference: `openclaw/agents/tool-loop-detection.ts` — uses SHA-256
 * over a stable-stringified params object plus a 30-call window with
 * tiered thresholds (10 warning / 20 critical). We collapse to one
 * threshold and skip the hash.
 */
import type { ToolUseBlock } from "@crewhaus/turn-state-machine";

export type LoopDetection = {
  readonly signature: string;
  readonly toolName: string;
  /** How many times the signature appeared inside the window. For the
   *  `"near"` tier this is the RAW occurrence count of the normalized
   *  group (the weighted score is what crossed `threshold`). */
  readonly count: number;
  readonly windowSize: number;
  readonly threshold: number;
  /**
   * G27 — which detector tripped: `"exact"` for byte-identical
   * `(toolName, input)` repeats (the pre-0.4 behaviour), `"near"` for
   * same-tool calls whose inputs collapse to one normalized signature
   * after volatile-substring stripping, counted at
   * {@link NEAR_DUPLICATE_WEIGHT} weight.
   */
  readonly tier: "exact" | "near";
};

export const DEFAULT_WINDOW_SIZE = 10;
export const DEFAULT_THRESHOLD = 3;

/**
 * G27 — weight of one near-duplicate occurrence relative to an exact
 * repeat. Within a normalized group the score is
 * `maxExact + (groupSize - maxExact) * NEAR_DUPLICATE_WEIGHT`, so at the
 * default threshold (3) five near-duplicates (`1 + 4×0.5`) trip the
 * detector where three exact repeats already would — near matches are
 * suggestive, not conclusive, so they must accumulate more evidence.
 */
export const NEAR_DUPLICATE_WEIGHT = 0.5;

/**
 * Look for a `(toolName, input)` pair that occurs at least `threshold`
 * times in the last `windowSize` entries of `history`. Returns the
 * first hit found while scanning the window left-to-right, or `null`
 * if no signature reaches the threshold.
 *
 * Two passes (G27):
 *  1. **exact** — identical to the pre-0.4 detector: first canonical
 *     signature whose count reaches `threshold` wins (`tier: "exact"`).
 *  2. **near** — only when pass 1 found nothing: group the window by
 *     {@link nearToolCallSignature} (volatile substrings stripped) and
 *     return the first group whose weighted score
 *     (`maxExact + others × `{@link NEAR_DUPLICATE_WEIGHT}) reaches
 *     `threshold` (`tier: "near"`). A group that is all-identical calls
 *     never lands here — pass 1 would have caught it.
 */
export function detectLoop(
  history: ReadonlyArray<ToolUseBlock>,
  windowSize: number = DEFAULT_WINDOW_SIZE,
  threshold: number = DEFAULT_THRESHOLD,
): LoopDetection | null {
  if (history.length === 0 || threshold <= 0) return null;

  const window = history.length > windowSize ? history.slice(history.length - windowSize) : history;

  const counts = new Map<string, { count: number; toolName: string }>();
  for (const call of window) {
    const sig = toolCallSignature(call.name, call.input);
    const entry = counts.get(sig);
    if (entry) {
      entry.count += 1;
      if (entry.count >= threshold) {
        return {
          signature: sig,
          toolName: entry.toolName,
          count: entry.count,
          windowSize,
          threshold,
          tier: "exact",
        };
      }
    } else {
      counts.set(sig, { count: 1, toolName: call.name });
      if (threshold === 1) {
        return {
          signature: sig,
          toolName: call.name,
          count: 1,
          windowSize,
          threshold,
          tier: "exact",
        };
      }
    }
  }

  // Near pass — group by normalized signature, score exact-vs-near split.
  // `counts` already holds the per-exact-signature tallies from pass 1.
  const nearGroups = new Map<
    string,
    { count: number; toolName: string; exactCounts: Map<string, number> }
  >();
  for (const call of window) {
    const nearSig = nearToolCallSignature(call.name, call.input);
    const exactSig = toolCallSignature(call.name, call.input);
    let group = nearGroups.get(nearSig);
    if (!group) {
      group = { count: 0, toolName: call.name, exactCounts: new Map() };
      nearGroups.set(nearSig, group);
    }
    group.count += 1;
    group.exactCounts.set(exactSig, (group.exactCounts.get(exactSig) ?? 0) + 1);
    // A group of ONE distinct exact signature is pass-1 territory (it did
    // not trip there, so it cannot trip here either at <= weight 1).
    if (group.exactCounts.size < 2) continue;
    const maxExact = Math.max(...group.exactCounts.values());
    const score = maxExact + (group.count - maxExact) * NEAR_DUPLICATE_WEIGHT;
    if (score >= threshold) {
      return {
        signature: nearSig,
        toolName: group.toolName,
        count: group.count,
        windowSize,
        threshold,
        tier: "near",
      };
    }
  }
  return null;
}

/**
 * G27 — strip the volatile substrings that make near-identical tool
 * inputs hash apart: UUIDs, long hex ids (16–64 chars), digit runs, and
 * whitespace runs each collapse to a fixed placeholder. Pure string →
 * string; exported for tests and for the runtime's warning copy.
 */
export function stripVolatile(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "«uuid»")
    .replace(/\b[0-9a-f]{16,64}\b/gi, "«hex»")
    .replace(/\d+/g, "«n»")
    .replace(/\s+/g, " ");
}

/**
 * G27 — the near-tier signature: the same canonical JSON encoding as
 * {@link toolCallSignature} but with every string leaf (and every
 * number, which stringifies to a digit run) passed through
 * {@link stripVolatile}. Joined with `~` instead of `:` so a near
 * signature can never collide with an exact one in a caller's dedup set.
 */
export function nearToolCallSignature(name: string, input: unknown): string {
  return `${name}~${stripVolatile(canonicalJson(input))}`;
}

/**
 * Canonical signature for a tool call. The JSON encoding sorts object
 * keys recursively so the same logical input always produces the same
 * string regardless of property order. Arrays preserve order; primitive
 * leaves use `JSON.stringify` (which already escapes quotes/newlines/
 * unicode safely).
 */
export function toolCallSignature(name: string, input: unknown): string {
  return `${name}:${canonicalJson(input)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  // bigint, symbol, function — fall through to a stable but obviously-tagged
  // representation so detection still works.
  return JSON.stringify(String(value));
}

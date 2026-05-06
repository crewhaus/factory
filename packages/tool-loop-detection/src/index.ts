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
  /** How many times the signature appeared inside the window. */
  readonly count: number;
  readonly windowSize: number;
  readonly threshold: number;
};

export const DEFAULT_WINDOW_SIZE = 10;
export const DEFAULT_THRESHOLD = 3;

/**
 * Look for a `(toolName, input)` pair that occurs at least `threshold`
 * times in the last `windowSize` entries of `history`. Returns the
 * first hit found while scanning the window left-to-right, or `null`
 * if no signature reaches the threshold.
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
        };
      }
    }
  }
  return null;
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

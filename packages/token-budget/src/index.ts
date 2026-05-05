/**
 * Catalog R2 `token-budget` — heuristic token estimator plus a running
 * budget tracker. The estimator uses the standard char-count / 4
 * approximation; for production accuracy a real tokenizer would replace
 * `estimateTokens()` here. The budget class tracks running input/output
 * totals and answers "are we approaching the limit" against a
 * configurable threshold (default 0.85).
 *
 * Reference: claude-code/utils/tokenBudget.ts (parsing) and
 * claude-code/services/tokenEstimation.ts (heuristic with image
 * stripping). We deliberately drop the API-token-count path and the
 * diminishing-returns logic — out of scope for the slice.
 */
import type Anthropic from "@anthropic-ai/sdk";

const CHARS_PER_TOKEN = 4;

/**
 * Heuristic token estimate over a message array. Sums the character
 * count of all text-bearing fields and divides by 4. Image / document
 * blocks are intentionally ignored — they're stripped before we'd send
 * any compaction-style prompt anyway.
 */
export function estimateTokens(messages: ReadonlyArray<Anthropic.MessageParam>): number {
  let chars = 0;
  for (const msg of messages) {
    chars += contentChars(msg.content);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function contentChars(content: Anthropic.MessageParam["content"]): number {
  if (typeof content === "string") return content.length;
  let total = 0;
  for (const block of content) {
    total += blockChars(block);
  }
  return total;
}

function blockChars(block: Anthropic.ContentBlockParam): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "tool_use":
      return JSON.stringify(block.input ?? {}).length + block.name.length;
    case "tool_result": {
      const c = block.content;
      if (c === undefined) return 0;
      if (typeof c === "string") return c.length;
      let total = 0;
      for (const inner of c) {
        if (inner.type === "text") total += inner.text.length;
      }
      return total;
    }
    default:
      // image, document, thinking, etc. — not counted by the heuristic.
      return 0;
  }
}

/**
 * Running token tally with a configurable budget. `add()` accumulates
 * input + output usage; `isApproachingLimit(threshold)` reports whether
 * the total has crossed `limit * threshold` (default 0.85).
 */
export class TokenBudget {
  private inputUsed = 0;
  private outputUsed = 0;

  constructor(private readonly _limit: number) {
    if (_limit <= 0) {
      throw new RangeError(`TokenBudget limit must be positive (got ${_limit})`);
    }
  }

  add(inputTokens: number, outputTokens: number): void {
    this.inputUsed += inputTokens;
    this.outputUsed += outputTokens;
  }

  isApproachingLimit(threshold = 0.85): boolean {
    if (threshold <= 0 || threshold > 1) {
      throw new RangeError(`threshold must be in (0, 1] (got ${threshold})`);
    }
    return this.used >= this._limit * threshold;
  }

  get used(): number {
    return this.inputUsed + this.outputUsed;
  }

  get limit(): number {
    return this._limit;
  }
}

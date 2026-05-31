/**
 * FR-003 — budget-gate unit tests. Pure, fully offline: no model calls,
 * no filesystem. Asserts the estimate/actual pricing math and the
 * `BudgetMeter` accumulate-and-trip behaviour against the real
 * `DEFAULT_PRICING` table (claude-sonnet-4-5: $3/M in, $15/M out).
 */
import { describe, expect, test } from "bun:test";
import { BudgetMeter, actualCallMicros, estimateCallMicros } from "./budget-gate";

const MODEL = "claude-sonnet-4-5"; // $3/M input, $15/M output, cachedRead = $0.3/M

describe("estimateCallMicros", () => {
  test("prices the chars/4 input estimate + maxOutputTokens ceiling at the model's rates", () => {
    // promptChars 4000 + overhead 0 → 1000 input tokens; output ceiling 2000.
    // input 1000 * $3/M = 3000 micros; output 2000 * $15/M = 30000 micros.
    const micros = estimateCallMicros(4000, 0, 2000, "anthropic", MODEL);
    expect(micros).toBe(3000 + 30000);
  });

  test("folds the meta-prompt overhead into the input estimate", () => {
    // (0 + 800)/4 = 200 input tokens * $3/M = 600 micros; output 0 → 0.
    const micros = estimateCallMicros(0, 800, 0, "anthropic", MODEL);
    expect(micros).toBe(600);
  });

  test("returns 0 for an unknown model id (cannot price → do not block)", () => {
    const micros = estimateCallMicros(100000, 800, 2048, "anthropic", "no-such-model-9");
    expect(micros).toBe(0);
  });
});

describe("actualCallMicros", () => {
  test("prices a known input/output usage via computeCostMicros", () => {
    // input 1000 * $3/M = 3000; output 500 * $15/M = 7500.
    const micros = actualCallMicros({ input: 1000, output: 500 }, "anthropic", MODEL);
    expect(micros).toBe(3000 + 7500);
  });

  test("folds cacheRead tokens in at the cached-read rate ($0.3/M)", () => {
    // input 0, output 0, cacheRead 10000 * $0.3/M = 3000 micros.
    const micros = actualCallMicros({ input: 0, output: 0, cacheRead: 10000 }, "anthropic", MODEL);
    expect(micros).toBe(3000);
  });

  test("returns 0 for an unknown model id", () => {
    const micros = actualCallMicros({ input: 9999, output: 9999 }, "anthropic", "__rule-based__");
    expect(micros).toBe(0);
  });
});

describe("BudgetMeter", () => {
  test("wouldExceed is always false when no budget is configured", () => {
    const meter = new BudgetMeter(undefined, "anthropic", MODEL, 2048);
    // Even a huge prompt never trips an unbudgeted meter.
    expect(meter.wouldExceed(10_000_000)).toBe(false);
  });

  test("record() accumulates spend and builds the per-iteration breakdown", () => {
    const meter = new BudgetMeter(undefined, "anthropic", MODEL, 2048);
    meter.record(1, { input: 1000, output: 500 }); // 3000 + 7500 = 10500
    meter.record(2, { input: 2000, output: 0 }); // 6000
    expect(meter.spentMicros).toBe(10500 + 6000);
    const summary = meter.summary("iterations-cap");
    expect(summary.totalUsdMicros).toBe(16500);
    expect(summary.totalUsd).toBe("$0.0165");
    expect(summary.perIteration).toHaveLength(2);
    expect(summary.perIteration[0]).toEqual({
      iteration: 1,
      costUsdMicros: 10500,
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(summary.stopped).toBe("iterations-cap");
  });

  test("wouldExceed flips true once spent + next-call estimate crosses the cap", () => {
    // Budget $0.05 = 50000 micros. metaOverhead 0 for a clean estimate.
    // Estimate for a 4000-char prompt at 2000 output tokens =
    //   input 1000 * $3/M = 3000 + output 2000 * $15/M = 30000 = 33000 micros.
    const meter = new BudgetMeter(50000, "anthropic", MODEL, 2000, 0);
    // Before any spend: 0 + 33000 <= 50000 → allowed.
    expect(meter.wouldExceed(4000)).toBe(false);
    // Record a 33000-micros call (input 1000 / output 2000).
    meter.record(1, { input: 1000, output: 2000 });
    expect(meter.spentMicros).toBe(33000);
    // Now 33000 + 33000 = 66000 > 50000 → must stop before the next call.
    expect(meter.wouldExceed(4000)).toBe(true);
  });

  test("an unpriceable placeholder model never trips even with a tiny budget", () => {
    // Mirrors the rule-based path: resolveMutatorModel returns "__rule-based__".
    const meter = new BudgetMeter(1, "anthropic", "__rule-based__", 2048, 0);
    expect(meter.wouldExceed(1_000_000)).toBe(false);
    meter.record(1, { input: 1_000_000, output: 1_000_000 });
    expect(meter.spentMicros).toBe(0);
    expect(meter.summary("iterations-cap").totalUsd).toBe("$0.0000");
  });
});

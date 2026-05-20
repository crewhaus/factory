/**
 * Unit tests for `formatCostInlineLine` — the CLI-target cost ribbon
 * emitted when `CREWHAUS_COST_INLINE=1` and `CREWHAUS_COST_TRACKING=1`
 * are both set. The integration path is exercised by the T3 trace-event
 * test in observability.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { CostAccrualEvent } from "@crewhaus/trace-event-bus";
import { formatCostInlineLine } from "./observability";

function makeEvent(overrides: Partial<CostAccrualEvent> = {}): CostAccrualEvent {
  return {
    kind: "cost_accrual",
    traceId: "trace_a",
    runId: "run_a",
    sessionId: "sess_0000000000000001",
    timestamp: 0,
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    inputTokens: 12_345,
    outputTokens: 678,
    cachedReadTokens: 0,
    costUsdMicros: 4_200, // $0.0042
    ...overrides,
  } as CostAccrualEvent;
}

describe("formatCostInlineLine", () => {
  test("renders the dollar amount with 4-digit precision", () => {
    expect(formatCostInlineLine(makeEvent({ costUsdMicros: 4_200 }))).toContain("$0.0042");
    expect(formatCostInlineLine(makeEvent({ costUsdMicros: 1_500_000 }))).toContain("$1.5000");
    expect(formatCostInlineLine(makeEvent({ costUsdMicros: 0 }))).toContain("$0.0000");
  });

  test("formats token counts above 1k with one decimal place", () => {
    const line = formatCostInlineLine(
      makeEvent({ inputTokens: 12_345, outputTokens: 678 }),
    );
    expect(line).toContain("12.3k in");
    expect(line).toContain("678 out"); // below 1k stays raw
  });

  test("includes the model id for visibility on model swaps", () => {
    const claudeLine = formatCostInlineLine(makeEvent({ modelId: "claude-opus-4-7" }));
    expect(claudeLine).toContain("model=claude-opus-4-7");

    const gptLine = formatCostInlineLine(makeEvent({ modelId: "gpt-4o-2024-11-20" }));
    expect(gptLine).toContain("model=gpt-4o-2024-11-20");
  });

  test("output is a single line (no embedded newlines)", () => {
    const line = formatCostInlineLine(makeEvent());
    expect(line).not.toContain("\n");
  });

  test("starts with the dollar emoji marker so users can grep for it", () => {
    const line = formatCostInlineLine(makeEvent());
    expect(line.startsWith("[💸 ")).toBe(true);
  });
});

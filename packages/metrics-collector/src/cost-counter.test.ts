/**
 * Loop contract 0.4 (Batch C, G57) — the labeled cost counter fed by
 * `cost_accrual` trace events. Verifies the counter accrues microdollars
 * labeled by provider + model, skips the aggregate `summary` accrual (so it
 * never double-counts the per-call events it sums), and tolerates an
 * `unpriced` (cost 0) accrual.
 */
import { describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { attachMetricsCollector } from "./index";

const env = (bus: TraceEventBus, overrides: Partial<TraceEvent> = {}) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("metrics-collector cost counter (G57)", () => {
  test("cost_accrual events accrue microdollars labeled by provider + model", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const metrics = await attachMetricsCollector(bus, {
      sink: { kind: "stdout" },
      stdoutWrite: () => {},
    });

    // Two priced accruals for the same (provider, model) sum on one series.
    bus.publish({
      ...env(bus),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 30,
      cachedReadTokens: 0,
      costUsdMicros: 4200,
    });
    bus.publish({
      ...env(bus),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      inputTokens: 40,
      outputTokens: 10,
      cachedReadTokens: 0,
      costUsdMicros: 1800,
    });
    // A different model lands on its own labeled series.
    bus.publish({
      ...env(bus),
      kind: "cost_accrual",
      provider: "openai",
      modelId: "gpt-4o-mini",
      inputTokens: 20,
      outputTokens: 5,
      cachedReadTokens: 0,
      costUsdMicros: 500,
    });
    // An unpriced accrual carries real tokens but $0 — a harmless no-op add.
    bus.publish({
      ...env(bus),
      kind: "cost_accrual",
      provider: "openai",
      modelId: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 2,
      cachedReadTokens: 0,
      costUsdMicros: 0,
      unpriced: true,
    });
    // The aggregate run-total (summary: true) must NOT be counted — it would
    // double the per-call spend it sums over.
    bus.publish({
      ...env(bus),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      inputTokens: 140,
      outputTokens: 40,
      cachedReadTokens: 0,
      costUsdMicros: 6000,
      summary: true,
    });

    const snap = metrics.registry.jsonSnapshot();
    const series = snap.counters["crewhaus_cost_usd_micros_total"] ?? [];
    const anthropic = series.find(
      (s) => s.labels.provider === "anthropic" && s.labels.model === "claude-opus-4-7",
    );
    const openai = series.find(
      (s) => s.labels.provider === "openai" && s.labels.model === "gpt-4o-mini",
    );
    expect(anthropic?.value).toBe(6000); // 4200 + 1800, summary excluded
    expect(openai?.value).toBe(500); // 500 + 0 (unpriced)

    const text = metrics.registry.prometheus();
    expect(text).toContain("# TYPE crewhaus_cost_usd_micros_total counter");
    expect(text).toContain(
      'crewhaus_cost_usd_micros_total{model="claude-opus-4-7",provider="anthropic"} 6000',
    );

    await metrics.shutdown();
  });
});

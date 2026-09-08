/**
 * Loop contract 0.4 (Batch C, G57) — the labeled cost counter fed by
 * `cost_accrual` trace events. Verifies the counter accrues microdollars
 * labeled by provider + model, skips the ROLE-LESS aggregate `summary`
 * accrual (so it never double-counts the per-call events it sums), counts a
 * ROLE-bearing one (a nested run's roll-up, whose per-call events were
 * published on a child bus this collector never saw), and tolerates an
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
    // The ROLE-LESS aggregate run-total (summary: true) must NOT be counted —
    // it would double the per-call spend it sums over.
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
    // 0.6.0 — an accrual with no role folds under `primary`.
    expect(text).toContain(
      'crewhaus_cost_usd_micros_total{model="claude-opus-4-7",provider="anthropic",role="primary"} 6000',
    );

    await metrics.shutdown();
  });

  test("a ROLE-bearing summary roll-up IS counted — its per-call events were on a child bus", async () => {
    const bus = new TraceEventBus({ runId: "run_b", sessionId: "sess_2" });
    const metrics = await attachMetricsCollector(bus, {
      sink: { kind: "stdout" },
      stdoutWrite: () => {},
    });

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
    // `@crewhaus/sub-agent-spawner` re-publishes a child run's total here.
    // Nothing else on this bus records that spend, so skipping it would pin
    // `role="subagent"` at zero while Hangar and `cost-summary` report it —
    // the split `@crewhaus/cost-tracker` already makes on this same bus.
    bus.publish({
      ...env(bus),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      role: "subagent",
      summary: true,
      inputTokens: 40,
      outputTokens: 8,
      cachedReadTokens: 0,
      costUsdMicros: 900,
    });

    const series = metrics.registry.jsonSnapshot().counters["crewhaus_cost_usd_micros_total"] ?? [];
    expect(series.find((s) => s.labels.role === "subagent")?.value).toBe(900);
    expect(series.find((s) => s.labels.role === "primary")?.value).toBe(4200);

    await metrics.shutdown();
  });
});

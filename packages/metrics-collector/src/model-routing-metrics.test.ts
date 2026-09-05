/**
 * 0.6.0 (design §8.4) — the routing metrics: `crewhaus_model_route_total`
 * label sets, `crewhaus_model_escalations_total` sources, and the `role`
 * label on `crewhaus_cost_usd_micros_total`.
 */
import { describe, expect, test } from "bun:test";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { EventToMetrics } from "./handlers";
import { Registry } from "./registry";

const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: "t".repeat(32),
  spanId: "s".repeat(16),
  timestamp: "2026-09-04T12:00:00.000Z",
  ...overrides,
});

function fold(events: ReadonlyArray<Record<string, unknown>>): Registry {
  const registry = new Registry();
  const handler = new EventToMetrics(registry);
  for (const ev of events) handler.handle(ev as unknown as TraceEvent);
  return registry;
}

describe("crewhaus_model_route_total", () => {
  test("labels: scope, routeKey, profile, policy, explored — with `-` for absent scope/profile", () => {
    const r = fold([
      {
        ...env(),
        kind: "model_route",
        routeKey: "hard",
        model: "claude-opus-5",
        policy: "learned",
        reason: "best arm",
        scope: "main",
        profile: "strong",
      },
      {
        ...env(),
        kind: "model_route",
        routeKey: "hard",
        model: "claude-opus-5",
        policy: "learned",
        reason: "best arm",
        scope: "main",
        profile: "strong",
      },
      {
        ...env(),
        kind: "model_route",
        routeKey: "easy",
        model: "claude-haiku-4-5",
        policy: "learned",
        reason: "exploring",
        explored: true,
        scope: "main",
        profile: "fast",
      },
      // A 0.5.x-shaped decision: inline candidate, no scope.
      {
        ...env(),
        kind: "model_route",
        routeKey: "easy",
        model: "claude-haiku-4-5",
        policy: "heuristic",
        reason: "no tools",
      },
    ]);
    const series = r.jsonSnapshot().counters["crewhaus_model_route_total"] ?? [];
    expect(series).toHaveLength(3);
    const strong = series.find((s) => s.labels["profile"] === "strong");
    expect(strong?.value).toBe(2);
    expect(strong?.labels).toEqual({
      scope: "main",
      routeKey: "hard",
      profile: "strong",
      policy: "learned",
      explored: "false",
    });
    const explored = series.find((s) => s.labels["explored"] === "true");
    expect(explored?.labels["profile"]).toBe("fast");
    const legacy = series.find((s) => s.labels["policy"] === "heuristic");
    expect(legacy?.labels).toEqual({
      scope: "-",
      routeKey: "easy",
      profile: "-",
      policy: "heuristic",
      explored: "false",
    });
    expect(r.prometheus()).toContain("# TYPE crewhaus_model_route_total counter");
  });
});

describe("crewhaus_model_escalations_total", () => {
  test("counts an escalation stage once (on start) and a tier misroute recovery, by source", () => {
    const stage = (outcome: string, role = "escalation") => ({
      ...env(),
      kind: "model_stage",
      stage: "escalate",
      strategy: "cascade",
      role,
      model: "claude-opus-5",
      outcome,
    });
    const r = fold([
      stage("started"),
      stage("done"),
      stage("started"),
      stage("failed"),
      // A draft stage is not an escalation.
      stage("started", "draft"),
      {
        ...env(),
        kind: "model_tier_route",
        tier: "default",
        model: "m",
        reason: "escalated after fast-tier failure",
        escalated: true,
      },
      { ...env(), kind: "model_tier_route", tier: "fast", model: "m", reason: "no tools" },
    ]);
    const series = r.jsonSnapshot().counters["crewhaus_model_escalations_total"] ?? [];
    const byStage = series.find((s) => s.labels["source"] === "stage");
    const byTier = series.find((s) => s.labels["source"] === "tier");
    expect(byStage?.value).toBe(2);
    expect(byStage?.labels["strategy"]).toBe("cascade");
    expect(byTier?.value).toBe(1);
    expect(series.reduce((n, s) => n + s.value, 0)).toBe(3);
  });

  test("no escalation events ⇒ the counter renders with no series (never a phantom zero)", () => {
    const r = fold([{ ...env(), kind: "turn_end", turn: 1, durationMs: 10 }]);
    expect(r.jsonSnapshot().counters["crewhaus_model_escalations_total"]).toEqual([]);
  });
});

describe("crewhaus_cost_usd_micros_total{role}", () => {
  test("splits spend by role; an absent role is primary", () => {
    const accrual = (micros: number, role?: string) => ({
      ...env(),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 0,
      costUsdMicros: micros,
      ...(role !== undefined ? { role } : {}),
    });
    const r = fold([
      accrual(100),
      accrual(200, "primary"),
      accrual(50, "judge"),
      accrual(25, "shadow"),
    ]);
    const series = r.jsonSnapshot().counters["crewhaus_cost_usd_micros_total"] ?? [];
    const by = (role: string) => series.find((s) => s.labels["role"] === role)?.value;
    expect(by("primary")).toBe(300);
    expect(by("judge")).toBe(50);
    expect(by("shadow")).toBe(25);
    expect(series.every((s) => s.labels["provider"] === "anthropic")).toBe(true);
  });
});

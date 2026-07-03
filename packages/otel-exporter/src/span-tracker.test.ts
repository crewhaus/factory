/**
 * SpanTracker — lifecycle pairing tests, plus the F1 regression: item 14
 * (advisor groundwork) added a SECOND `permission_decision` publish for the
 * ask RESOLUTION (`askOutcome` set) alongside the pre-existing pre-prompt
 * publish (`decision: "ask"`, no `askOutcome`). `ingest` must still emit
 * exactly one span per ask — the resolved one, mirroring the advisor
 * persistence subscriber's de-dupe in runtime-core/observability.ts.
 */
import { describe, expect, test } from "bun:test";
import type { PermissionDecisionEvent } from "@crewhaus/trace-event-bus";
import { SpanTracker } from "./span-tracker";
import type { OtelSpan } from "./types";

const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-05-07T12:00:00.000Z",
  ...overrides,
});

function tracked(): { tracker: SpanTracker; spans: OtelSpan[] } {
  const spans: OtelSpan[] = [];
  const tracker = new SpanTracker((span) => spans.push(span));
  return { tracker, spans };
}

describe("SpanTracker permission_decision de-dupe", () => {
  test("interactive-resolution ask path: pre-prompt + resolution → exactly one span", () => {
    const { tracker, spans } = tracked();
    // Pre-prompt publish (runtime-core/index.ts ~:1216) — decision "ask",
    // no askOutcome yet.
    const prePrompt: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
    };
    // Resolution publish (runtime-core/index.ts ~:1242) — same ask, now
    // carrying askOutcome after askApproval() resolves.
    const resolution: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
      askOutcome: "approved",
    };
    tracker.ingest(prePrompt);
    tracker.ingest(resolution);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("permission.ask");
  });

  test("single-turn collapse-to-deny path: pre-prompt + denied resolution → exactly one span", () => {
    const { tracker, spans } = tracked();
    const prePrompt: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Write",
      decision: "ask",
      mode: "default",
    };
    // Single-turn mode has no interactive surface, so the ask collapses to
    // a denial — the resolution still carries askOutcome: "denied".
    const resolution: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Write",
      decision: "ask",
      mode: "default",
      askOutcome: "denied",
    };
    tracker.ingest(prePrompt);
    tracker.ingest(resolution);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("permission.ask");
  });

  test("allow/deny decisions (no askOutcome) still emit exactly one span each", () => {
    const { tracker, spans } = tracked();
    const allow: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Read",
      decision: "allow",
      mode: "default",
    };
    const deny: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "deny",
      mode: "default",
      reason: "blocked by rule",
    };
    tracker.ingest(allow);
    tracker.ingest(deny);

    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name).sort()).toEqual(["permission.allow", "permission.deny"]);
  });
});

describe("SpanTracker turn pairing", () => {
  test("turn_start + turn_end emits one turn span", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({ ...env(), kind: "turn_start", turn: 1, messageCount: 0 });
    tracker.ingest({ ...env(), kind: "turn_end", turn: 1, durationMs: 5 });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("turn");
  });
});

/**
 * Item 32 — runtime incident-collector tests: env gate, trigger classification,
 * the first-trigger raw capture (events.jsonl + incident.json), and one-bundle-
 * per-session behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunContext } from "@crewhaus/run-context";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import {
  DENY_STORM_THRESHOLD,
  attachIncidentCollector,
  classifyIncidentTrigger,
  incidentDirName,
} from "./incident-collector";

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "incident-collector-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newBus(): TraceEventBus {
  return new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
}

function publishCircuitOpen(bus: TraceEventBus): void {
  bus.publish({
    ...bus.envelope(),
    kind: "circuit_state_changed",
    adapter: "anthropic",
    fromState: "closed",
    toState: "open",
    reason: "5 consecutive 429s",
  } as TraceEvent);
}

describe("classifyIncidentTrigger", () => {
  test("circuit → open", () => {
    const t = classifyIncidentTrigger(
      {
        kind: "circuit_state_changed",
        adapter: "anthropic",
        fromState: "closed",
        toState: "open",
      } as TraceEvent,
      0,
    );
    expect(t?.kind).toBe("circuit_open");
  });
  test("egress-blocked", () => {
    const t = classifyIncidentTrigger(
      {
        kind: "permission_decision",
        toolName: "fetch",
        decision: "deny",
        mode: "auto",
        outcome: "egress-blocked",
      } as TraceEvent,
      0,
    );
    expect(t?.kind).toBe("egress_blocked");
  });
  test("deny storm only past the threshold", () => {
    const denial = {
      kind: "permission_decision",
      toolName: "bash",
      decision: "deny",
      mode: "auto",
      judgeModel: "claude-haiku",
    } as TraceEvent;
    expect(classifyIncidentTrigger(denial, DENY_STORM_THRESHOLD - 2)).toBeUndefined();
    expect(classifyIncidentTrigger(denial, DENY_STORM_THRESHOLD - 1)?.kind).toBe(
      "justification_deny_storm",
    );
  });
});

describe("incidentDirName", () => {
  test("sortable + safe", () => {
    expect(incidentDirName("2026-07-02T18:07:03.412Z", "circuit_open")).toBe(
      "20260702T180703-circuit_open",
    );
  });
});

describe("attachIncidentCollector", () => {
  test("no-op without CREWHAUS_INCIDENTS", () => {
    const bus = newBus();
    const ctx = createRunContext();
    const c = attachIncidentCollector(bus, ctx, {}, { incidentsDir: join(tmpRoot, "i") });
    expect(c).toBeUndefined();
  });

  test("captures a circuit_open incident on first trigger", () => {
    const bus = newBus();
    const ctx = createRunContext();
    const incidentsDir = join(tmpRoot, "i");
    const c = attachIncidentCollector(
      bus,
      ctx,
      { CREWHAUS_INCIDENTS: "1" },
      {
        incidentsDir,
        spec: { name: "hello", version: "v2", hash: "h" },
        now: () => new Date("2026-07-02T18:07:03.000Z"),
      },
    );
    // Some prior traffic so the ring buffer has content.
    bus.publish({ ...bus.envelope(), kind: "turn_end", turn: 1, durationMs: 10 } as TraceEvent);
    publishCircuitOpen(bus);

    const dir = join(incidentsDir, "20260702T180703-circuit_open");
    expect(existsSync(dir)).toBe(true);
    const capture = JSON.parse(readFileSync(join(dir, "incident.json"), "utf-8"));
    expect(capture.kind).toBe("circuit_open");
    expect(capture.sessionId).toBe(ctx.sessionId);
    expect(capture.spec.name).toBe("hello");
    // events.jsonl carries the ring buffer (turn_end + circuit event).
    const events = readFileSync(join(dir, "events.jsonl"), "utf-8").trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(2);
    c?.unsubscribe();
  });

  test("only ONE bundle per session even with multiple triggers", () => {
    const bus = newBus();
    const ctx = createRunContext();
    const incidentsDir = join(tmpRoot, "i");
    let n = 0;
    attachIncidentCollector(
      bus,
      ctx,
      { CREWHAUS_INCIDENTS: "1" },
      { incidentsDir, now: () => new Date(`2026-07-02T18:07:0${n++}.000Z`) },
    );
    publishCircuitOpen(bus);
    publishCircuitOpen(bus);
    publishCircuitOpen(bus);
    // Exactly one incident dir was created.
    expect(readdirSync(incidentsDir)).toHaveLength(1);
  });

  test("a non-trigger event never captures", () => {
    const bus = newBus();
    const ctx = createRunContext();
    const incidentsDir = join(tmpRoot, "i");
    attachIncidentCollector(bus, ctx, { CREWHAUS_INCIDENTS: "1" }, { incidentsDir });
    bus.publish({ ...bus.envelope(), kind: "turn_end", turn: 1, durationMs: 10 } as TraceEvent);
    expect(existsSync(incidentsDir)).toBe(false);
  });
});

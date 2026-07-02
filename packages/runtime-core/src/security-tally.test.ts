/**
 * Item 48 — unit tests for the per-run security tally (the live half of
 * `crewhaus security digest`): event classification, the env gate on
 * `attachDefaultSubscribers`, and the single end-of-run stderr line.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createRunContext } from "@crewhaus/run-context";
import type {
  CircuitStateChangedEvent,
  HookFiredEvent,
  PermissionDecisionEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  attachDefaultSubscribers,
  createSecurityTally,
  formatSecurityTallyLine,
  securityTallyTotal,
  tallySecurityEvent,
} from "./observability";

const envelope = {
  traceId: "trace_a",
  runId: "run_a",
  sessionId: "sess_0000000000000001",
  timestamp: 0,
} as const;

function permissionEvent(
  overrides: Partial<PermissionDecisionEvent> = {},
): PermissionDecisionEvent {
  return {
    ...envelope,
    kind: "permission_decision",
    toolName: "send_message",
    decision: "allow",
    mode: "default",
    ...overrides,
  } as PermissionDecisionEvent;
}

function hookEvent(allowed: boolean): HookFiredEvent {
  return {
    ...envelope,
    kind: "hook_fired",
    event: "pre-tool",
    allowed,
    durationMs: 1,
  } as HookFiredEvent;
}

function circuitEvent(
  fromState: CircuitStateChangedEvent["fromState"],
  toState: CircuitStateChangedEvent["toState"],
): CircuitStateChangedEvent {
  return {
    ...envelope,
    kind: "circuit_state_changed",
    adapter: "anthropic",
    fromState,
    toState,
  } as CircuitStateChangedEvent;
}

describe("tallySecurityEvent", () => {
  test("classifies egress warn/block outcomes without double-counting the deny", () => {
    const tally = createSecurityTally();
    expect(tallySecurityEvent(tally, permissionEvent({ outcome: "egress-warned" }))).toBe(true);
    expect(
      tallySecurityEvent(tally, permissionEvent({ decision: "deny", outcome: "egress-blocked" })),
    ).toBe(true);
    expect(tally.egressWarned).toBe(1);
    expect(tally.egressBlocked).toBe(1);
    // The egress-blocked event carried decision "deny" but must NOT also
    // count as a plain permission denial.
    expect(tally.permissionDenials).toBe(0);
  });

  test("egress-passed is clean and does not count", () => {
    const tally = createSecurityTally();
    expect(tallySecurityEvent(tally, permissionEvent({ outcome: "egress-passed" }))).toBe(false);
    expect(securityTallyTotal(tally)).toBe(0);
  });

  test("injection redactions and warns accumulate rule-id hit counts", () => {
    const tally = createSecurityTally();
    tallySecurityEvent(
      tally,
      permissionEvent({ outcome: "redacted", rules: ["exfil-url", "b64-blob"] }),
    );
    tallySecurityEvent(tally, permissionEvent({ outcome: "warned", rules: ["exfil-url"] }));
    expect(tally.injectionRedactions).toBe(1);
    expect(tally.injectionWarnings).toBe(1);
    expect(tally.injectionRuleHits).toEqual({ "exfil-url": 2, "b64-blob": 1 });
  });

  test("a judgeModel deny is a justification denial; a bare deny is a permission denial", () => {
    const tally = createSecurityTally();
    tallySecurityEvent(
      tally,
      permissionEvent({ decision: "deny", judgeModel: "claude-haiku-4-5" }),
    );
    tallySecurityEvent(tally, permissionEvent({ decision: "deny" }));
    expect(tally.justificationDenials).toBe(1);
    expect(tally.permissionDenials).toBe(1);
  });

  test('an "ask" decision and a plain allow are not incidents', () => {
    const tally = createSecurityTally();
    expect(tallySecurityEvent(tally, permissionEvent({ decision: "ask" }))).toBe(false);
    expect(tallySecurityEvent(tally, permissionEvent({ decision: "allow" }))).toBe(false);
    expect(securityTallyTotal(tally)).toBe(0);
  });

  test("hook denials count; allowed hooks do not", () => {
    const tally = createSecurityTally();
    expect(tallySecurityEvent(tally, hookEvent(false))).toBe(true);
    expect(tallySecurityEvent(tally, hookEvent(true))).toBe(false);
    expect(tally.hookDenials).toBe(1);
  });

  test("circuit opens and recoveries count; half-open probes do not", () => {
    const tally = createSecurityTally();
    expect(tallySecurityEvent(tally, circuitEvent("closed", "open"))).toBe(true);
    expect(tallySecurityEvent(tally, circuitEvent("open", "half_open"))).toBe(false);
    expect(tallySecurityEvent(tally, circuitEvent("half_open", "closed"))).toBe(true);
    expect(tallySecurityEvent(tally, circuitEvent("closed", "closed"))).toBe(false);
    expect(tally.circuitOpens).toBe(1);
    expect(tally.circuitRecoveries).toBe(1);
  });

  test("unrelated event kinds are ignored", () => {
    const tally = createSecurityTally();
    const turnStart = { ...envelope, kind: "turn_start", turn: 1 } as unknown as TraceEvent;
    expect(tallySecurityEvent(tally, turnStart)).toBe(false);
    expect(securityTallyTotal(tally)).toBe(0);
  });
});

describe("formatSecurityTallyLine", () => {
  test("renders only non-zero segments plus ranked rule hits", () => {
    const tally = createSecurityTally();
    tally.justificationDenials = 2;
    tally.egressBlocked = 1;
    tally.injectionRedactions = 1;
    tally.injectionRuleHits = { "exfil-url": 2, "b64-blob": 1 };
    const line = formatSecurityTallyLine(tally);
    expect(line.startsWith("[security] ")).toBe(true);
    expect(line).toContain("2 justification denial(s)");
    expect(line).toContain("1 egress block(s)");
    expect(line).toContain("1 injection redaction(s)");
    expect(line).toContain("[rules: exfil-url ×2, b64-blob ×1]");
    expect(line).toContain("crewhaus security digest");
    expect(line).not.toContain("permission denial");
    expect(line).not.toContain("\n");
  });
});

describe("attachDefaultSubscribers — CREWHAUS_SECURITY_DIGEST gate", () => {
  test("tally is off (undefined) without the env var — zero overhead default", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const subs = await attachDefaultSubscribers(bus, ctx, {});
    expect(subs.securityTally).toBeUndefined();
    await subs.flushAll();
    await subs.shutdownAll();
  });

  test("tallies security events during a run and prints ONE stderr line at flush", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const subs = await attachDefaultSubscribers(bus, ctx, { CREWHAUS_SECURITY_DIGEST: "1" });
    expect(subs.securityTally).toBeDefined();

    bus.publish(permissionEvent({ decision: "deny", judgeModel: "rule-based" }));
    bus.publish(permissionEvent({ outcome: "egress-warned" }));
    bus.publish(permissionEvent({ outcome: "redacted", rules: ["exfil-url"] }));
    bus.publish(hookEvent(false));
    bus.publish(circuitEvent("closed", "open"));

    const writes: string[] = [];
    const writeSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await subs.flushAll();
      await subs.flushAll(); // a double flush must not double-print
      await subs.shutdownAll(); // nor shutdown after flush
    } finally {
      writeSpy.mockRestore();
    }

    const securityLines = writes.filter((w) => w.includes("[security]"));
    expect(securityLines.length).toBe(1);
    const line = securityLines[0] as string;
    expect(line).toContain("1 justification denial(s)");
    expect(line).toContain("1 egress warn(s)");
    expect(line).toContain("1 injection redaction(s)");
    expect(line).toContain("1 hook denial(s)");
    expect(line).toContain("1 circuit open(s)");
    expect(line).toContain("exfil-url ×1");
  });

  test("prints nothing when the run tripped nothing", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const subs = await attachDefaultSubscribers(bus, ctx, { CREWHAUS_SECURITY_DIGEST: "true" });
    bus.publish(permissionEvent({ decision: "allow" })); // clean event

    const writes: string[] = [];
    const writeSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await subs.flushAll();
      await subs.shutdownAll();
    } finally {
      writeSpy.mockRestore();
    }
    expect(writes.filter((w) => w.includes("[security]")).length).toBe(0);
  });

  test("shutdownAll without a prior flush still prints the one line", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const subs = await attachDefaultSubscribers(bus, ctx, { CREWHAUS_SECURITY_DIGEST: "1" });
    bus.publish(permissionEvent({ decision: "deny" }));

    const writes: string[] = [];
    const writeSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      await subs.shutdownAll();
    } finally {
      writeSpy.mockRestore();
    }
    expect(writes.filter((w) => w.includes("[security]")).length).toBe(1);
  });
});

/**
 * Ops item 37 — tests for the SLO mitigation sink builder: rung routing, the
 * audit-every-attempt record, best-effort failure isolation (a throwing rung is
 * warned, never rethrown), and the intake-gate payload shape.
 */
import { describe, expect, test } from "bun:test";
import type { SloMitigationEvent } from "@crewhaus/runtime-core";
import { buildSloSink, intakeGatePayload } from "./slo-sink";

function event(rung: SloMitigationEvent["rung"]): SloMitigationEvent {
  return {
    sessionId: "sess_0000000000000001",
    rung,
    breach: {
      metric: "ttft_ms",
      observed: 2000,
      target: 1400,
      detail: "ttft_ms 2000ms exceeded SLO target 1400ms",
    },
    windowMs: 300_000,
  };
}

describe("buildSloSink", () => {
  test("returns undefined when no channel is configured", () => {
    expect(buildSloSink({})).toBeUndefined();
  });

  test("routes each rung to its handler and audits the attempt", async () => {
    const seen: string[] = [];
    const sink = buildSloSink({
      audit: {
        append: async (rec) => {
          seen.push(`audit:${(rec.payload as SloMitigationEvent).rung}`);
        },
      },
      alert: async () => {
        seen.push("alert");
      },
      pauseIntake: async (paused, reason) => {
        seen.push(`pause:${paused}:${reason.includes("SLO breach")}`);
      },
      rollback: async () => {
        seen.push("rollback");
      },
    });
    expect(sink).not.toBeUndefined();
    await sink?.audit?.(event("alert"));
    await sink?.alert?.(event("alert"));
    await sink?.pauseIntake?.(event("pause-intake"));
    await sink?.rollback?.(event("rollback"));
    expect(seen).toEqual(["audit:alert", "alert", "pause:true:true", "rollback"]);
  });

  test("a throwing rung is warned, never rethrown (best-effort)", async () => {
    const warnings: string[] = [];
    const sink = buildSloSink({
      rollback: async () => {
        throw new Error("registry down");
      },
      warn: (l) => warnings.push(l),
    });
    // Must resolve, not reject.
    await sink?.rollback?.(event("rollback"));
    expect(warnings.some((w) => w.includes("rollback failed") && w.includes("registry down"))).toBe(
      true,
    );
  });

  test("an unconfigured rung is simply absent from the sink", () => {
    const sink = buildSloSink({ alert: async () => {} });
    expect(sink?.alert).toBeDefined();
    expect(sink?.rollback).toBeUndefined();
    expect(sink?.pauseIntake).toBeUndefined();
  });
});

describe("intakeGatePayload", () => {
  test("builds a versioned durable gate record", () => {
    expect(intakeGatePayload(true, "SLO breach: x", 1234)).toEqual({
      version: 1,
      paused: true,
      reason: "SLO breach: x",
      ts: 1234,
    });
  });

  test("omits an empty reason", () => {
    expect(intakeGatePayload(false, "", 1)).toEqual({ version: 1, paused: false, ts: 1 });
  });
});

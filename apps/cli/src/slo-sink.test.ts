/**
 * Ops item 37 — tests for the SLO mitigation sink builder: rung routing, the
 * audit-every-attempt record, best-effort failure isolation (a throwing rung is
 * warned, never rethrown), the intake-gate pause/resume, the intake-gate payload
 * shape, and last-known-good rollback resolution from audit history.
 */
import { describe, expect, test } from "bun:test";
import type { SloMitigationEvent } from "@crewhaus/runtime-core";
import { buildSloSink, intakeGatePayload, lastKnownGoodFromAuditRecords } from "./slo-sink";

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
    expect(sink?.resumeIntake).toBeUndefined();
  });

  test("configuring pauseIntake also wires resumeIntake (paused:false)", async () => {
    const flips: Array<{ paused: boolean; reason: string }> = [];
    const sink = buildSloSink({
      pauseIntake: async (paused, reason) => {
        flips.push({ paused, reason });
      },
    });
    expect(sink?.pauseIntake).toBeDefined();
    expect(sink?.resumeIntake).toBeDefined();
    await sink?.pauseIntake?.(event("pause-intake"));
    await sink?.resumeIntake?.(event("pause-intake"));
    expect(flips.map((f) => f.paused)).toEqual([true, false]);
    expect(flips[0]?.reason).toContain("SLO breach");
    expect(flips[1]?.reason).toContain("SLO recovered");
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

describe("lastKnownGoodFromAuditRecords", () => {
  /** Build a `deployment_action` audit record as read off the chain. */
  function deployRec(payload: {
    action: "promote" | "rollback";
    name: string;
    env?: string;
    toEnv?: string;
    fromVersion?: string;
    toVersion: string;
    ts: number;
  }): unknown {
    return { kind: "deployment_action", ts: payload.ts, payload };
  }

  test("rolls back to the ACTUAL predecessor, not the lexicographic pick", () => {
    // versions exist as v1,v2,v9,v10; prod was promoted v1 → v2 → v9. A
    // lexicographic "last non-current version" over [v1,v2,v9,v10] filtered of
    // v9 would pick v2 by luck here, so use a case where they DIFFER: prod went
    // v1 → v10 → v9, so the true predecessor of v9 is v10, while a lexicographic
    // ascending pick of the last non-current would be v2.
    const records = [
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v1",
        toVersion: "v10",
        ts: 100,
      }),
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v10",
        toVersion: "v9",
        ts: 200,
      }),
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBe("v10");
  });

  test("the prompt scenario: prod=v9 predecessor is v2 (not lexicographic v10)", () => {
    // versions [v1,v2,v9,v10], prod=v9, promoted v1 → v2 → v9. The lexicographic
    // .at(-1) over a sorted [v1,v10,v2,v9] minus v9 would be v2 OR v10 depending
    // on sort — here we assert the audited predecessor is exactly v2.
    const records = [
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v1",
        toVersion: "v2",
        ts: 10,
      }),
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v2",
        toVersion: "v9",
        ts: 20,
      }),
      // v10 exists in the registry but was NEVER promoted to prod.
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBe("v2");
  });

  test("picks the NEWEST action when an env flip-flopped", () => {
    // prod: v1 → v9 → v1 → v9. The most recent action that set prod=v9 came
    // from v1, so that is the last-known-good — not the ancient first v9 pin.
    const records = [
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v1",
        toVersion: "v9",
        ts: 100,
      }),
      deployRec({
        action: "rollback",
        name: "bot",
        env: "prod",
        fromVersion: "v9",
        toVersion: "v1",
        ts: 200,
      }),
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v1",
        toVersion: "v9",
        ts: 300,
      }),
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBe("v1");
  });

  test("honors the target env (a staging promote does not decide prod's rollback)", () => {
    const records = [
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v2",
        toVersion: "v9",
        ts: 10,
      }),
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "staging",
        fromVersion: "v8",
        toVersion: "v9",
        ts: 20,
      }),
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBe("v2");
  });

  test("returns undefined when no history records the current pin (refuse to guess)", () => {
    const records = [
      deployRec({
        action: "promote",
        name: "other",
        toEnv: "prod",
        fromVersion: "v1",
        toVersion: "v9",
        ts: 10,
      }),
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBeUndefined();
  });

  test("returns undefined when the recorded predecessor equals current", () => {
    const records = [
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v9",
        toVersion: "v9",
        ts: 10,
      }),
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBeUndefined();
  });

  test("ignores non-deployment_action records", () => {
    const records = [
      {
        kind: "model_call",
        ts: 1,
        payload: { fromVersion: "vX", toVersion: "v9", toEnv: "prod", name: "bot" },
      },
      deployRec({
        action: "promote",
        name: "bot",
        toEnv: "prod",
        fromVersion: "v2",
        toVersion: "v9",
        ts: 2,
      }),
    ];
    expect(lastKnownGoodFromAuditRecords(records, "bot", "prod", "v9")).toBe("v2");
  });
});

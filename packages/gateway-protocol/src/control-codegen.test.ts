/**
 * The control.v1 codegen renderers. These exist so the five daemon-emitting
 * targets cannot drift; the assertions here pin the emitted TEXT, and the
 * per-target `index.test.ts` files assert that each target actually splices it.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTROL_RUNTIME_MODULE,
  renderControlDrain,
  renderControlImports,
  renderControlLane,
  renderControlPlaneBoot,
  renderControlStart,
  renderControlTimer,
  renderPublicGateFetch,
} from "./control-codegen";

describe("renderControlImports", () => {
  test("imports the runtime from the control SUBPATH, not the wire-contract root", () => {
    expect(renderControlImports()).toBe(
      `import { createControlPlane } from "${CONTROL_RUNTIME_MODULE}";\n`,
    );
    expect(CONTROL_RUNTIME_MODULE).toBe("@crewhaus/gateway-protocol/control");
  });

  test("pulls the non-mutating approval counter in only when the shape needs it", () => {
    expect(renderControlImports({ pendingApprovals: true })).toContain(
      "countPendingApprovals, createControlPlane",
    );
    expect(renderControlImports({ pendingApprovals: false })).not.toContain(
      "countPendingApprovals",
    );
  });

  test("pulls the drain sweep and the log flattener in only when the shape needs them", () => {
    expect(renderControlImports({ drainSweep: true })).toBe(
      `import { createControlPlane, runDrainSweep } from "${CONTROL_RUNTIME_MODULE}";\n`,
    );
    expect(renderControlImports({ logSafe: true })).toBe(
      `import { createControlPlane, sanitizeControlText } from "${CONTROL_RUNTIME_MODULE}";\n`,
    );
    expect(
      renderControlImports({ pendingApprovals: true, drainSweep: true, logSafe: true }),
    ).toContain("countPendingApprovals, createControlPlane, runDrainSweep, sanitizeControlText");
    // A bundle that needs neither still imports exactly what it did before.
    expect(renderControlImports({ drainSweep: false, logSafe: false })).not.toContain(
      "runDrainSweep",
    );
  });
});

describe("renderControlPlaneBoot", () => {
  test("renders name + target and omits every optional seam by default", () => {
    const out = renderControlPlaneBoot({ name: "acme-bot", target: "channel" });
    expect(out).toContain("const __control = createControlPlane({");
    expect(out).toContain('name: "acme-bot",');
    expect(out).toContain('target: "channel",');
    expect(out).not.toContain("channels:");
    expect(out).not.toContain("pendingApprovals:");
    expect(out).not.toContain("audit:");
  });

  test("threads the channel / approvals / audit expressions verbatim", () => {
    const out = renderControlPlaneBoot({
      name: "n",
      target: "channel",
      channelsExpr: '["slack"]',
      pendingApprovalsExpr: "countPendingApprovals(P)",
      auditLogExpr: "__securityAudit",
    });
    expect(out).toContain('channels: () => ["slack"],');
    expect(out).toContain("pendingApprovals: async () => countPendingApprovals(P),");
    // The audit seam is nullable — a daemon booted with
    // CREWHAUS_SECURITY_AUDIT=0 keeps a working control plane.
    expect(out).toContain("const __log = __securityAudit;");
    expect(out).toContain("if (__log !== undefined) await __log.append(__rec);");
  });

  test("indents every line so a caller can splice at any depth", () => {
    const out = renderControlPlaneBoot({ name: "n", target: "crew", indent: "  " });
    for (const line of out.split("\n")) {
      if (line !== "") expect(line.startsWith("  ")).toBe(true);
    }
  });

  test("honours a custom plane variable", () => {
    expect(renderControlPlaneBoot({ name: "n", target: "voice", varName: "__ctl" })).toContain(
      "const __ctl = createControlPlane({",
    );
  });
});

describe("renderControlLane", () => {
  test("wraps the tick body so the timer and the operator wake share ONE function", () => {
    const out = renderControlLane({
      lane: "heartbeat",
      varName: "__hb",
      cadence: "every 1000ms",
      everyMs: 1000,
      body: "doWork(__tick.sessionId);",
    });
    expect(out).toContain("const __hb = __control.lane({");
    expect(out).toContain('lane: "heartbeat",');
    expect(out).toContain('cadence: "every 1000ms",');
    expect(out).toContain("everyMs: 1000,");
    expect(out).toContain("run: async (__tick) => {");
    expect(out).toContain("    doWork(__tick.sessionId);");
    expect(out).not.toContain("nextDueAt:");
  });

  test("a cron lane supplies its own nextDueAt instead of an interval projection", () => {
    const out = renderControlLane({
      lane: "schedule",
      varName: "__s",
      cadence: 'cron "0 * * * *" UTC',
      nextDueAtExpr: "computeNext()",
      body: "await go();",
    });
    expect(out).toContain("nextDueAt: () => computeNext(),");
    expect(out).not.toContain("everyMs:");
  });

  test("a lane that owns no session says so, and one that does stays silent", () => {
    const base = { lane: "schedule", varName: "__s", cadence: "every 1000ms" } as const;
    // The managed fan-out / batch producer: the tick id is never threaded into
    // a session, so the 202 must not advertise one.
    expect(renderControlLane({ ...base, ownsSession: false, body: "await go();" })).toContain(
      "  ownsSession: false,",
    );
    // Default (and an explicit true) emit nothing — pre-existing bundles keep
    // their bytes.
    expect(renderControlLane({ ...base, body: "await go();" })).not.toContain("ownsSession");
    expect(renderControlLane({ ...base, ownsSession: true, body: "await go();" })).not.toContain(
      "ownsSession",
    );
  });
});

describe("renderControlTimer / renderControlDrain / renderControlStart", () => {
  test("a read-only timer row is registered, not poked", () => {
    expect(renderControlTimer({ expr: '{ lane: "janitor", cadence: "x" }' })).toBe(
      '__control.timer(() => ({ lane: "janitor", cadence: "x" }));\n',
    );
  });

  test("drain steps are async and indented into the callback", () => {
    const out = renderControlDrain({ body: "await stop();\nawait flush();", indent: "  " });
    expect(out).toContain("  __control.onDrain(async () => {");
    expect(out).toContain("    await stop();");
    expect(out).toContain("    await flush();");
    expect(out).toContain("  });");
  });

  test("start is awaited — binding happens after every lane and drain step is in", () => {
    expect(renderControlStart({})).toBe("await __control.start();\n");
  });
});

describe("renderPublicGateFetch", () => {
  test("the gate runs BEFORE the daemon's own handler and falls through otherwise", () => {
    const out = renderPublicGateFetch({ innerExpr: "(req: Request) => gateway.handle(req)" });
    expect(out).toBe(
      "(__req) => __control.publicGate(__req) ?? ((req: Request) => gateway.handle(req))(__req)",
    );
  });
});

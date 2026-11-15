/**
 * The control.v1 codegen renderers. These exist so the five daemon-emitting
 * targets cannot drift; the assertions here pin the emitted TEXT, and the
 * per-target `index.test.ts` files assert that each target actually splices it.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTROL_RUNTIME_MODULE,
  type ScheduleLaneEmit,
  renderControlDrain,
  renderControlImports,
  renderControlLane,
  renderControlPlaneBoot,
  renderControlStart,
  renderControlTimer,
  renderPublicGateFetch,
  renderScheduleLanes,
  scheduleLaneCadence,
  scheduleNextDueAtExpr,
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

describe("renderScheduleLanes (#514)", () => {
  const TRICKY = 'Say "hi", `x` and ${y}\nthen stop.';
  const lanes: ReadonlyArray<ScheduleLaneEmit> = [
    {
      name: "weekly-report",
      kind: "cron",
      cron: "0 17 * * 5",
      timezone: "Europe/Berlin",
      jitterMs: 60_000,
      instructions: TRICKY,
    },
    { name: "discovery", kind: "interval", everyMs: 7_200_000, instructions: "Look around." },
  ];
  const render = (input: ReadonlyArray<ScheduleLaneEmit>): string =>
    renderScheduleLanes({
      lanes: input,
      body: ({ laneId, index, instructionsVar }) =>
        `await run(${JSON.stringify(laneId)}, ${index}, ${instructionsVar});`,
      onErrorBody: "report(__err, __name);",
      indent: "  ",
    });
  const out = render(lanes);
  const count = (needle: string): number => out.split(needle).length - 1;

  test("is deterministic, and writes lanes in name order whatever the input order", () => {
    expect(render(lanes)).toBe(out);
    expect(render([...lanes].reverse())).toBe(out);
    const discovery = out.indexOf('lane: "schedule:discovery"');
    expect(discovery).toBeGreaterThan(-1);
    expect(out.indexOf('lane: "schedule:weekly-report"')).toBeGreaterThan(discovery);
  });

  test("one registration per lane, each bound by index, and one armScheduleLanes call", () => {
    expect(out).toContain("const __scheduleLane0 = __control.lane({");
    expect(out).toContain("const __scheduleLane1 = __control.lane({");
    expect(count("__control.lane({")).toBe(2);
    expect(count("armScheduleLanes(")).toBe(1);
    expect(out).toContain('await run("schedule:discovery", 0, __scheduleLanes[0].instructions);');
    expect(out).toContain(
      'nextDueAt: () => ((__at: number | undefined) => (__at === undefined || !(Math.abs(__at) <= 8.64e15) ? undefined : new Date(__at).toISOString()))(__scheduleLanesArmed?.nextAt("weekly-report")),',
    );
    expect(out).toContain(
      "let __scheduleLanesArmed: { cancel(): void; nextAt(name: string): number | undefined } | undefined;",
    );
    expect(out).not.toContain("nextWakeDelayMs");
    expect(out).toContain('["weekly-report", __scheduleLane1],');
    expect(out).toContain("report(__err, __name);");
  });

  test("quotes every string: the prompt appears only as a JSON literal", () => {
    expect(count(JSON.stringify(TRICKY))).toBe(1);
    expect(count("${y}")).toBe(1);
    expect(out).not.toContain(TRICKY);
    expect(out).toContain('cadence: "cron \\"0 17 * * 5\\" Europe/Berlin +/-60000ms jitter"');
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(out)).not.toThrow();
  });

  test("a guard registers the lanes but arms them only while it holds", () => {
    const guarded = renderScheduleLanes({
      lanes,
      body: () => "noop();",
      onErrorBody: "",
      armGuard: 'process.env.X !== "0"',
    });
    const guard = guarded.indexOf('if (process.env.X !== "0") {');
    expect(guard).toBeGreaterThan(-1);
    expect(guarded.indexOf("__control.lane({")).toBeGreaterThan(-1);
    expect(guarded.indexOf("__control.lane({")).toBeLessThan(guard);
    expect(guarded.indexOf("armScheduleLanes(")).toBeGreaterThan(guard);
  });

  test("the cadence text matches the single lane's", () => {
    expect(scheduleLaneCadence({ name: "a", kind: "interval", everyMs: 5, instructions: "" })).toBe(
      "every 5ms",
    );
    expect(
      scheduleLaneCadence({ name: "a", kind: "cron", cron: "* * * * *", instructions: "" }),
    ).toBe('cron "* * * * *" UTC');
  });

  test("the next-wake expression reads only the recorded fire time", () => {
    expect(scheduleNextDueAtExpr("__schedule.nextAt()")).toBe(
      "((__at: number | undefined) => (__at === undefined || !(Math.abs(__at) <= 8.64e15) ? undefined : new Date(__at).toISOString()))(__schedule.nextAt())",
    );
  });

  test("the next wake is an ISO time, or absent when none is pending or the time is past what a Date holds", () => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
      `export default (__value: number | undefined) => ${scheduleNextDueAtExpr("__value")};`,
    );
    const read = new Function(`${js.replace("export default", "return")}`)() as (
      v: number | undefined,
    ) => string | undefined;
    expect(read(Date.parse("2026-11-20T16:00:00Z"))).toBe("2026-11-20T16:00:00.000Z");
    expect(read(8.64e15)).toBe(new Date(8.64e15).toISOString());
    expect(read(undefined)).toBeUndefined();
    expect(read(8.64e15 + 1)).toBeUndefined();
    expect(read(86_400_000 * 999_999_999_999)).toBeUndefined();
    expect(read(Number.NaN)).toBeUndefined();
  });

  const outside: ReadonlyArray<readonly [string, string]> = [
    ["a backtick", "a`b"],
    ["a template placeholder", "a${x}"],
    ["a double quote", 'a"b'],
    ["an underscore", "a_b"],
    ["an upper-case letter", "A"],
    ["nothing", ""],
    ["33 characters", `a${"b".repeat(32)}`],
  ];
  for (const [label, name] of outside) {
    test(`a name with ${label} is outside the lane grammar and is refused before anything renders`, () => {
      let bodies = 0;
      const attempt = (): string =>
        renderScheduleLanes({
          lanes: [lanes[1] as ScheduleLaneEmit, { ...(lanes[0] as ScheduleLaneEmit), name }],
          body: () => {
            bodies += 1;
            return "noop();";
          },
          onErrorBody: "",
        });
      expect(attempt).toThrow(TypeError);
      expect(attempt).toThrow(JSON.stringify(name));
      expect(bodies).toBe(0);
    });
  }

  test("a 32-character name is inside the lane grammar", () => {
    const name = `a${"b".repeat(31)}`;
    const ok = renderScheduleLanes({
      lanes: [{ ...(lanes[1] as ScheduleLaneEmit), name }],
      body: () => "noop();",
      onErrorBody: "",
    });
    expect(ok).toContain(`lane: "schedule:${name}"`);
  });
});

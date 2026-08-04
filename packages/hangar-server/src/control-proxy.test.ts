/**
 * The control.v1 proxy, driven against a STUB that speaks the real wire
 * contract (a tiny `Bun.serve` in the testkit answering exactly the bodies
 * `createControlPlane` answers). A mock of our own idea of the protocol
 * would pass while the real daemon 404s.
 *
 * What must hold:
 *   - the bearer is read off `<harness>/.crewhaus/run/control-token` on the
 *     SERVER and never appears in any response body;
 *   - 404 `lane_not_armed` and 409 `draining` are EXPECTED facts (render
 *     disabled-with-reason), 409 `tick_in_flight` is RETRYABLE, and the two
 *     409s never collapse into one "conflict";
 *   - no control port at all is `no_control_port`, not an error.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlClient } from "./control-client";
import { makeFixtureHarness } from "./fixture";
import { bootTestServer, startStubControlPlane } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");

/** Never a realistic-shaped literal in a fixture: built from parts. */
const STUB_TOKEN = ["c0ntrol", "test", "bearer", "0123456789abcdef"].join("-");

function controlHarness(root: string, name: string): string {
  return makeFixtureHarness(join(root, name), {
    specName: name,
    target: "channel",
    specExtra: ["heartbeat:", "  every: 60s", "  instructions: check in"].join("\n"),
    controlToken: STUB_TOKEN,
    bundle: { entry: "daemon.ts" },
  });
}

describe("control.v1 proxy", () => {
  test("wake/status/drain reach the daemon, and the bearer never crosses the API boundary", async () => {
    const stub = startStubControlPlane(STUB_TOKEN);
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = controlHarness(t.harnessesRoot, "ctl-ok");
      const id = (
        (await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) })).body[
          "entry"
        ] as { id: string }
      ).id;
      // Point the harness at the stub the way a real boot would: the port
      // lands in the runfile, which is where `controlPort()` reads it.
      mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "run", "daemon.json"),
        JSON.stringify({
          v: 1,
          pid: process.pid,
          pidStartTimeMs: NOW,
          argvFingerprint: "x",
          controlPort: stub.port,
          entry: "daemon.ts",
          bundleDir: join(dir, "dist"),
          runId: "run_00000000000000cc",
          startedAt: new Date(NOW).toISOString(),
          managerVersion: "test",
        }),
      );
      stub.status = {
        protocol: "crewhaus.control.v1",
        name: "ctl-ok",
        target: "channel",
        pid: 1,
        startedAt: new Date(NOW).toISOString(),
        draining: false,
        counters: { turns: 3, heartbeatTicks: 2, scheduleWakes: 0, janitorRuns: 1 },
        timers: [
          {
            lane: "heartbeat",
            cadence: "every 60000ms",
            lastFiredAt: new Date(NOW - 1000).toISOString(),
            lastOutcome: "ok",
            nextDueAt: new Date(NOW + 59_000).toISOString(),
          },
        ],
        channels: ["slack"],
        pendingApprovals: 0,
      };

      const status = await t.api(`/api/h/${id}/control/status`);
      expect(status.status).toBe(200);
      expect(status.body["ok"]).toBe(true);
      expect((status.body["counters"] as { turns: number }).turns).toBe(3);

      const wake = await t.api(`/api/h/${id}/control/wake`, {
        method: "POST",
        body: JSON.stringify({ lane: "heartbeat", reason: "operator poke" }),
      });
      expect(wake.status).toBe(200);
      expect(wake.body["ok"]).toBe(true);
      expect(wake.body["sessionId"]).toBe("sess_00000000000000ff");

      // The stub saw a real bearer…
      expect(stub.calls.every((c) => c.authorization === `Bearer ${STUB_TOKEN}`)).toBe(true);
      // …and NOTHING the API returned contains it.
      const serialized = JSON.stringify([status.body, wake.body]);
      expect(serialized.includes(STUB_TOKEN)).toBe(false);

      // The four-lane timeline picks up the phase only control can know.
      const schedulers = await t.api(`/api/h/${id}/schedulers`);
      expect(schedulers.body["controlReachable"]).toBe(true);
      const heartbeat = (schedulers.body["lanes"] as Array<Record<string, unknown>>).find(
        (l) => l["lane"] === "heartbeat",
      );
      expect(heartbeat?.["nextDueAt"]).toBe(new Date(NOW + 59_000).toISOString());
      expect(heartbeat?.["pokeable"]).toBe(true);
      // Cadence still comes from the SPEC (offline-knowable), not control.
      expect(heartbeat?.["cadenceSource"]).toBe("spec");
    } finally {
      await t.stop();
      await stub.stop();
    }
  }, 20_000);

  test("404 lane_not_armed, 409 tick_in_flight and 409 draining stay three distinct answers", async () => {
    const stub = startStubControlPlane(STUB_TOKEN);
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = controlHarness(t.harnessesRoot, "ctl-refusals");
      const id = (
        (await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) })).body[
          "entry"
        ] as { id: string }
      ).id;
      mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "run", "daemon.json"),
        JSON.stringify({
          v: 1,
          pid: process.pid,
          pidStartTimeMs: NOW,
          argvFingerprint: "x",
          controlPort: stub.port,
          entry: "daemon.ts",
          bundleDir: join(dir, "dist"),
          runId: "run_00000000000000cd",
          startedAt: new Date(NOW).toISOString(),
          managerVersion: "test",
        }),
      );

      const wake = (lane: string): Promise<{ status: number; body: Record<string, unknown> }> =>
        t.api(`/api/h/${id}/control/wake`, { method: "POST", body: JSON.stringify({ lane }) });

      // The spec armed heartbeat only — `schedule` 404s with lane_not_armed.
      const notArmed = await wake("schedule");
      expect(notArmed.status).toBe(200);
      expect(notArmed.body["code"]).toBe("lane_not_armed");
      expect(notArmed.body["expected"]).toBe(true);
      expect(notArmed.body["retryable"]).toBe(false);

      stub.busy = true;
      const inFlight = await wake("heartbeat");
      expect(inFlight.body["code"]).toBe("tick_in_flight");
      // The whole point of splitting the two 409s: this one retries.
      expect(inFlight.body["retryable"]).toBe(true);
      expect(inFlight.body["expected"]).toBe(false);

      stub.busy = false;
      stub.draining = true;
      const draining = await wake("heartbeat");
      expect(draining.body["code"]).toBe("draining");
      expect(draining.body["retryable"]).toBe(false);
      expect(draining.body["expected"]).toBe(true);
    } finally {
      await t.stop();
      await stub.stop();
    }
  }, 20_000);

  test("a stale token on disk surfaces as unauthorized, not as a generic error", async () => {
    const stub = startStubControlPlane(STUB_TOKEN);
    try {
      const client = createControlClient({
        readToken: () => ["stale", "token", "0123456789abcdef"].join("-"),
      });
      const result = await client.status({ harnessDir: "/nonexistent", controlPort: stub.port });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toContain("reminted");
    } finally {
      await stub.stop();
    }
  }, 20_000);

  test("no control port is a FACT about the bundle, not an error", async () => {
    const client = createControlClient();
    const result = await client.wake(
      { harnessDir: "/nonexistent", controlPort: undefined },
      { lane: "heartbeat" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("no_control_port");
    expect(result.expected).toBe(true);
    expect(result.reason).toContain("crewhaus.control.v1");
  });

  test("the token is re-read per call — a daemon that reminted it is not cached out", async () => {
    const stub = startStubControlPlane(STUB_TOKEN);
    const root = process.env["TMPDIR"] ?? "/tmp";
    const dir = makeFixtureHarness(join(root, `hangar-ctl-remint-${process.pid}`), {
      specName: "remint",
      controlToken: ["old", "token", "0123456789abcdef"].join("-"),
    });
    try {
      const client = createControlClient();
      const first = await client.status({ harnessDir: dir, controlPort: stub.port });
      expect(first.ok).toBe(false);

      // The daemon rebooted and minted a fresh token; the very next call
      // must pick it up off disk.
      writeFileSync(join(dir, ".crewhaus", "run", "control-token"), `${STUB_TOKEN}\n`, {
        mode: 0o600,
      });
      expect(readFileSync(join(dir, ".crewhaus", "run", "control-token"), "utf8").trim()).toBe(
        STUB_TOKEN,
      );
      const second = await client.status({ harnessDir: dir, controlPort: stub.port });
      expect(second.ok).toBe(true);
    } finally {
      await stub.stop();
    }
  }, 20_000);
});

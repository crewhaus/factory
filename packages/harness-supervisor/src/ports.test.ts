import { describe, expect, test } from "bun:test";
import { PortCollisionError, createPortLedger, defaultPortProbe, runfilePortClaims } from "./ports";

const busy = (taken: readonly number[]) => async (port: number) => !taken.includes(port);

describe("createPortLedger", () => {
  test("hands out the preferred port when it is free", async () => {
    const ledger = createPortLedger({ probe: busy([]) });
    const claim = await ledger.allocate({ preferred: 3000, role: "daemon", harnessDir: "/h" });
    expect(claim.port).toBe(3000);
    expect(ledger.claimFor(3000)?.role).toBe("daemon");
  });

  test("skips ports the OS says are taken", async () => {
    const ledger = createPortLedger({ probe: busy([3000, 3001]) });
    const claim = await ledger.allocate({ preferred: 3000, role: "daemon", harnessDir: "/h" });
    expect(claim.port).toBe(3002);
  });

  test("skips ports the LEDGER holds even when the OS says they are free", async () => {
    // A daemon that is still booting has not bound its port yet — the
    // ledger is what stops a second allocation racing onto it.
    const ledger = createPortLedger({ probe: busy([]) });
    await ledger.allocate({ preferred: 4000, role: "daemon", harnessDir: "/a", runId: "run_a" });
    const second = await ledger.allocate({ preferred: 4000, role: "daemon", harnessDir: "/b" });
    expect(second.port).toBe(4001);
  });

  test("an exhausted span throws rather than handing out a busy port", async () => {
    const ledger = createPortLedger({ probe: async () => false });
    await expect(
      ledger.allocate({ preferred: 5000, role: "control", harnessDir: "/h", span: 3 }),
    ).rejects.toThrow(/no free port in 5000\.\.5002/);
  });

  test("an exact claim collides across harnesses", () => {
    const ledger = createPortLedger();
    ledger.claim({ port: 9000, role: "gateway", harnessDir: "/a", runId: "run_a" });
    expect(() =>
      ledger.claim({ port: 9000, role: "gateway", harnessDir: "/b", runId: "run_b" }),
    ).toThrow(PortCollisionError);
    // Re-claiming for the SAME harness+run is a refresh, not a collision.
    expect(() =>
      ledger.claim({ port: 9000, role: "gateway", harnessDir: "/a", runId: "run_a" }),
    ).not.toThrow();
  });

  test("a collision names the current holder", () => {
    const ledger = createPortLedger();
    ledger.claim({ port: 9100, role: "daemon", harnessDir: "/a", runId: "run_a" });
    try {
      ledger.claim({ port: 9100, role: "daemon", harnessDir: "/b" });
      throw new Error("expected a collision");
    } catch (err) {
      expect(err).toBeInstanceOf(PortCollisionError);
      expect((err as PortCollisionError).existing.harnessDir).toBe("/a");
      expect((err as PortCollisionError).message).toContain("run_a");
    }
  });

  test("releasing a run frees every port it held", async () => {
    const ledger = createPortLedger({ probe: busy([]) });
    await ledger.allocate({ preferred: 6000, role: "daemon", harnessDir: "/h", runId: "run_x" });
    await ledger.allocate({ preferred: 6001, role: "control", harnessDir: "/h", runId: "run_x" });
    await ledger.allocate({ preferred: 6002, role: "ui-host", harnessDir: "/h", runId: "run_y" });
    ledger.releaseRun("run_x");
    expect(ledger.claims().map((c) => c.port)).toEqual([6002]);
    ledger.release(6002);
    expect(ledger.claims()).toEqual([]);
  });

  test("adoption rebuilds the picture from runfiles and marks it adopted", () => {
    const ledger = createPortLedger();
    ledger.adopt(
      runfilePortClaims("/h", {
        runId: "run_a",
        port: 3000,
        gatewayPort: 8080,
        controlPort: 3001,
      }),
    );
    expect(ledger.claims().map((c) => [c.port, c.role, c.adopted])).toEqual([
      [3000, "daemon", true],
      [8080, "gateway", true],
      [3001, "control", true],
    ]);
  });

  test("an adopted port is not re-allocated to someone else", async () => {
    const ledger = createPortLedger({ probe: busy([]) });
    ledger.adopt(runfilePortClaims("/adopted", { runId: "run_a", port: 3000 }));
    const claim = await ledger.allocate({ preferred: 3000, role: "daemon", harnessDir: "/new" });
    expect(claim.port).toBe(3001);
  });

  test("runfilePortClaims ignores absent and nonsense ports", () => {
    expect(runfilePortClaims("/h", { runId: "run_a" })).toEqual([]);
    expect(runfilePortClaims("/h", { runId: "run_a", port: 0, controlPort: -1 })).toEqual([]);
  });
});

describe("defaultPortProbe", () => {
  test("reports a bindable port free and a bound one taken", async () => {
    const { createServer } = await import("node:net");
    const server = createServer();
    const port: number = await new Promise((resolve) => {
      server.listen({ port: 0, host: "127.0.0.1" }, () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    expect(await defaultPortProbe(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await defaultPortProbe(port)).toBe(true);
  }, 10_000);
});

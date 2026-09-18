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
  /**
   * 20000..28063 sits BELOW every default ephemeral range in play (Linux
   * 32768-60999, macOS and Windows 49152-65535), so the kernel never hands one
   * of these out by itself — not to a `listen(0)` in a suite running beside us
   * and not to an outbound loopback connection. The only way a neighbour can
   * hold one is by naming that exact number, and nothing in this repo binds a
   * fixed port. The pid offset keeps two concurrent runs of this file (two
   * worktrees, two CI jobs on one box) out of each other's window.
   *
   * So whichever candidate we manage to bind stays ours for the whole test:
   * the test decides when the port is taken and when it is free, instead of
   * borrowing an ephemeral port and hoping nobody claims it once it lets go.
   */
  const PORT_BASE = 20_000 + (process.pid % 8_000);
  const PORT_TRIES = 64;

  /** Bind the first candidate we can hold, and return it still listening. */
  async function holdPrivatePort(): Promise<{
    readonly server: import("node:net").Server;
    readonly port: number;
  }> {
    const { createServer } = await import("node:net");
    for (let port = PORT_BASE; port < PORT_BASE + PORT_TRIES; port++) {
      const server = createServer();
      const bound = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(true));
      });
      if (bound) return { server, port };
    }
    throw new Error(`no bindable port in ${PORT_BASE}..${PORT_BASE + PORT_TRIES - 1}`);
  }

  test("reports a bindable port free and a bound one taken", async () => {
    const { server, port } = await holdPrivatePort();
    try {
      expect(await defaultPortProbe(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await defaultPortProbe(port)).toBe(true);
  }, 10_000);
});

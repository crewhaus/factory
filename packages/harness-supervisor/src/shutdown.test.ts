/**
 * Manager-shutdown tests. Every seam is injected — fake supervisors, a fake
 * job queue, a fake clock — so nothing here spawns a process; the one real
 * case (a manager that has to EXIT while children live) is the fixture test
 * in `spawn-integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { JobRecord } from "./queue";
import {
  SHUTDOWN_DEADLINE_MS,
  type ShutdownJobs,
  type ShutdownSupervisor,
  type SupervisedChild,
  runManagerShutdown,
  shutdownFate,
  shutdownReportLines,
} from "./shutdown";
import type { StopResult } from "./supervisor";
import { createFakeClock } from "./testkit";

function child(over: Partial<SupervisedChild> = {}): SupervisedChild {
  return {
    harnessDir: "/h/one",
    target: "channel",
    state: "running",
    kind: "daemon",
    runId: "run_0123456789abcdef",
    pid: 4242,
    adopted: false,
    detached: true,
    reAdoptable: true,
    ...over,
  };
}

type FakeSupervisor = ShutdownSupervisor & {
  readonly stops: Array<number | undefined>;
  closed: number;
};

function fakeSupervisor(
  live: SupervisedChild | undefined,
  stop: (graceMs: number | undefined) => Promise<StopResult> = async () => ({
    stopped: true,
    forced: false,
  }),
): FakeSupervisor {
  const stops: Array<number | undefined> = [];
  const supervisor: FakeSupervisor = {
    stops,
    closed: 0,
    liveChild: () => live,
    stop: (options) => {
      stops.push(options?.graceMs);
      return stop(options?.graceMs);
    },
    close: () => {
      supervisor.closed += 1;
    },
  };
  return supervisor;
}

function jobRecord(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "job_a",
    harnessDir: "/h/one",
    kind: "eval",
    argv: ["eval"],
    mutating: true,
    state: "running",
    enqueuedAt: "2026-08-04T00:00:00.000Z",
    ...over,
  };
}

describe("shutdownFate — a run survives iff the next manager can find it", () => {
  test("a runfile-tracked detached daemon detaches", () => {
    expect(shutdownFate(child())).toBe("detach");
    // Adoption changes nothing: the runfile is the claim, not who spawned it.
    expect(shutdownFate(child({ adopted: true }))).toBe("detach");
  });

  test("an attached interactive run is stopped — its pipes die with us", () => {
    expect(shutdownFate(child({ kind: "interactive", detached: false, reAdoptable: false }))).toBe(
      "stop",
    );
  });

  test("a detached run with no runfile is stopped — nobody could ever find it again", () => {
    // The mcp-server projection and a manager-spawned one-shot are both
    // detached and both write NO runfile. Leaving them up is orphaning them.
    expect(shutdownFate(child({ kind: "mcp-server", reAdoptable: false }))).toBe("stop");
    expect(shutdownFate(child({ kind: "job", reAdoptable: false }))).toBe("stop");
  });

  test("a daemon whose runfile went missing is stopped, not left behind", () => {
    expect(shutdownFate(child({ kind: "daemon", reAdoptable: false }))).toBe("stop");
  });
});

describe("runManagerShutdown", () => {
  test("stops the orphanable children, leaves the adoptable daemons, closes every supervisor", async () => {
    const daemon = fakeSupervisor(child({ harnessDir: "/h/daemon" }));
    const cli = fakeSupervisor(
      child({ harnessDir: "/h/cli", kind: "interactive", detached: false, reAdoptable: false }),
    );
    const idle = fakeSupervisor(undefined);

    const report = await runManagerShutdown({
      supervisors: [daemon, cli, idle],
      graceMs: 250,
    });

    expect(report.survived.map((c) => c.harnessDir)).toEqual(["/h/daemon"]);
    expect(report.stopped.map((c) => c.harnessDir)).toEqual(["/h/cli"]);
    // The daemon is never signalled…
    expect(daemon.stops).toEqual([]);
    // …and the stop carries the shutdown grace, not the 15 s interactive one.
    expect(cli.stops).toEqual([250]);
    // Every supervisor is released, including the idle one — a live restart
    // timer is a spawn scheduled to land after the manager is gone.
    expect([daemon.closed, cli.closed, idle.closed]).toEqual([1, 1, 1]);
  });

  test("a forced stop is reported as forced", async () => {
    const cli = fakeSupervisor(
      child({ kind: "interactive", detached: false, reAdoptable: false }),
      async () => ({ stopped: true, forced: true }),
    );
    const report = await runManagerShutdown({ supervisors: [cli] });
    expect(report.stopped[0]?.forced).toBe(true);
    expect(report.stopped[0]?.timedOut).toBe(false);
  });

  test("a stop that never returns times out — the manager still shuts down", async () => {
    const clock = createFakeClock();
    const wedged = fakeSupervisor(
      child({ kind: "interactive", detached: false, reAdoptable: false }),
      () => new Promise<StopResult>(() => {}),
    );
    const done = runManagerShutdown({ supervisors: [wedged], clock });
    // Nothing resolves until the deadline fires; then the shutdown completes
    // and says honestly that it never saw the exit.
    clock.advance(SHUTDOWN_DEADLINE_MS);
    const report = await done;
    expect(report.stopped[0]?.timedOut).toBe(true);
    expect(report.stopped[0]?.forced).toBe(false);
    expect(wedged.closed).toBe(1);
  });

  test("a stop that throws is reported, not propagated", async () => {
    const boom = fakeSupervisor(child({ kind: "job", detached: false, reAdoptable: false }), () =>
      Promise.reject(new Error("signal failed")),
    );
    const report = await runManagerShutdown({ supervisors: [boom] });
    expect(report.stopped[0]?.timedOut).toBe(true);
    expect(boom.closed).toBe(1);
  });

  test("a liveChild() that throws does not abort the rest of the shutdown", async () => {
    const broken: ShutdownSupervisor = {
      liveChild: () => {
        throw new Error("unreadable");
      },
      stop: async () => ({ stopped: true, forced: false }),
      close: () => {},
    };
    const cli = fakeSupervisor(child({ kind: "interactive", detached: false, reAdoptable: false }));
    const report = await runManagerShutdown({ supervisors: [broken, cli] });
    expect(report.stopped).toHaveLength(1);
    expect(cli.closed).toBe(1);
  });

  test("running jobs are signalled and reported as left-open for restore()", async () => {
    const abandoned = [jobRecord({ jobId: "job_eval" })];
    const seen: Array<{ graceMs?: number; deadlineMs?: number }> = [];
    const jobs: ShutdownJobs = {
      running: () => abandoned,
      terminateRunning: async (options) => {
        seen.push({ ...options });
        return abandoned;
      },
    };
    const report = await runManagerShutdown({ supervisors: [], jobs, graceMs: 300 });
    expect(report.abandonedJobs.map((j) => j.jobId)).toEqual(["job_eval"]);
    expect(seen[0]?.graceMs).toBe(300);
  });

  test("a job queue that throws never blocks the exit", async () => {
    const jobs: ShutdownJobs = {
      running: () => [],
      terminateRunning: () => Promise.reject(new Error("queue is wedged")),
    };
    const report = await runManagerShutdown({ supervisors: [], jobs });
    expect(report.abandonedJobs).toEqual([]);
  });
});

describe("shutdownReportLines", () => {
  test("says nothing when there was nothing to say", () => {
    expect(shutdownReportLines({ survived: [], stopped: [], abandonedJobs: [] })).toEqual([]);
  });

  test("names what survived, what the next manager does with it, and the CLI twin", () => {
    const text = shutdownReportLines({
      survived: [child({ harnessDir: "/h/chat", target: "channel", pid: 900 })],
      stopped: [
        {
          ...child({ harnessDir: "/h/cli", target: "cli", kind: "interactive" }),
          forced: true,
          timedOut: false,
        },
        {
          ...child({ harnessDir: "/h/stuck", target: "workflow", kind: "job" }),
          forced: false,
          timedOut: true,
        },
      ],
      abandonedJobs: [jobRecord({ kind: "eval" }), jobRecord({ jobId: "job_b", kind: "compile" })],
    }).join("\n");

    expect(text).toContain("stopped 2 supervised run(s)");
    expect(text).toContain("cli /h/cli");
    expect(text).toContain("forced (SIGKILL after the grace period)");
    expect(text).toContain("did NOT confirm its exit");
    expect(text).toContain("left 1 daemon(s) running");
    expect(text).toContain("the next `crewhaus hangar` adopts them");
    // Every UI/console action shows its CLI twin.
    expect(text).toContain("crewhaus daemon stop '/h/chat'");
    expect(text).toContain("signalled 2 running job(s) (compile, eval)");
    expect(text).toContain("`interrupted`");
  });
});

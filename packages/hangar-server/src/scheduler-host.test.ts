/**
 * Home's tick, under a fake clock and fake timers: sweeps run when due, never twice at
 * once, a throw stops nothing else, every sweep runs under its own system principal, and
 * stopping leaves no timer armed.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { requestAllows, visibleToRequest } from "./access";
import { type HomeJobQueue, JobRefusedError } from "./process";
import { type SchedulerTimers, type SweepJobs, createSchedulerHost } from "./scheduler-host";

function fakeTimers(): SchedulerTimers & {
  readonly armed: number;
  readonly cleared: number;
  readonly live: number;
  fire(): void;
} {
  let seq = 0;
  const live = new Map<number, () => void>();
  let armed = 0;
  let cleared = 0;
  return {
    setTimeout: (fn) => {
      seq += 1;
      armed += 1;
      live.set(seq, fn);
      return seq;
    },
    clearTimeout: (handle) => {
      if (live.delete(handle as number)) cleared += 1;
    },
    get armed() {
      return armed;
    },
    get cleared() {
      return cleared;
    },
    get live() {
      return live.size;
    },
    fire: () => {
      const due = [...live.entries()];
      live.clear();
      for (const [, fn] of due) fn();
    },
  };
}

const noJobs: SweepJobs = {
  submit: () => {
    throw new Error("no jobs here");
  },
  check: () => undefined,
};

function host(jobs: SweepJobs = noJobs) {
  let now = 1_000_000;
  const warnings: string[] = [];
  const timers = fakeTimers();
  const scheduler = createSchedulerHost({
    now: () => now,
    home: {},
    jobs,
    onWarn: (m) => warnings.push(m),
    timers,
  });
  return {
    scheduler,
    timers,
    warnings,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the scheduler host", () => {
  test("two sweeps at different periods run when they are due", async () => {
    const h = host();
    const ran: string[] = [];
    h.scheduler.register({ name: "fast", everyMs: 10_000, run: () => void ran.push("fast") });
    h.scheduler.register({ name: "slow", everyMs: 60_000, run: () => void ran.push("slow") });
    await h.scheduler.tick();
    expect(ran).toEqual(["fast", "slow"]);
    h.advance(10_000);
    await h.scheduler.tick();
    expect(ran).toEqual(["fast", "slow", "fast"]);
    h.advance(5_000);
    expect((await h.scheduler.tick()).ran).toEqual([]);
    h.advance(45_000);
    expect((await h.scheduler.tick()).ran).toEqual(["fast", "slow"]);
  });

  test("a sweep still running when it is due again is skipped and counted, never run twice", async () => {
    const h = host();
    let open: () => void = () => undefined;
    let runs = 0;
    h.scheduler.register({
      name: "slow",
      everyMs: 1000,
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          open = resolve;
        });
      },
    });
    const first = h.scheduler.tick();
    h.advance(5000);
    const second = await h.scheduler.tick();
    expect(second.skipped).toEqual(["slow"]);
    expect(runs).toBe(1);
    expect(h.scheduler.skippedCounts().get("slow")).toBe(1);
    open();
    await first;
  });

  test("a sweep that throws is warned about once per message and stops none of the others", async () => {
    const h = host();
    const ran: string[] = [];
    h.scheduler.register({
      name: "broken",
      everyMs: 1000,
      run: () => {
        throw new Error("the records cannot be read");
      },
    });
    h.scheduler.register({ name: "fine", everyMs: 1000, run: () => void ran.push("fine") });
    const report = await h.scheduler.tick();
    expect(report.failed).toEqual([{ name: "broken", message: "the records cannot be read" }]);
    h.advance(1000);
    await h.scheduler.tick();
    expect(ran).toEqual(["fine", "fine"]);
    expect(h.warnings).toEqual(["hangar-server: the broken sweep: the records cannot be read"]);
  });

  test("inside a sweep every harness is readable, and no write is allowed", async () => {
    const h = host();
    const seen: unknown[] = [];
    h.scheduler.register({
      name: "reconcile",
      everyMs: 1000,
      run: () => {
        seen.push(
          visibleToRequest("hrn_00000000000000aa"),
          requestAllows("h.read", "hrn_00000000000000aa"),
          requestAllows("h.control", "hrn_00000000000000aa"),
          requestAllows("home.access.manage"),
        );
      },
    });
    await h.scheduler.tick();
    expect(seen).toEqual([true, true, false, false]);
    // Outside the sweep, nothing is visible.
    expect(visibleToRequest("hrn_00000000000000aa")).toBe(false);
  });

  test("a sweep reaches only the checked job queue: a job into the home directory is refused", async () => {
    const refused: unknown[] = [];
    const checked: HomeJobQueue["check"] = ({ harnessDir }) => {
      if (harnessDir === homedir()) {
        throw new JobRefusedError({
          id: "workspace.holds-home",
          area: "workspace",
          level: "fail",
          message: "this directory holds your home directory",
        } as never);
      }
    };
    const jobs: SweepJobs = {
      check: checked,
      submit: (input) => {
        checked(input);
        throw new Error("not reached in this test");
      },
    };
    const h = host(jobs);
    h.scheduler.register({
      name: "jobs",
      everyMs: 1000,
      run: ({ jobs: given }) => {
        expect(Object.keys(given).sort()).toEqual(["check", "submit"]);
        try {
          given.submit({ harnessDir: homedir(), kind: "eval", argv: ["eval"] } as never);
        } catch (err) {
          refused.push(err);
        }
      },
    });
    await h.scheduler.tick();
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(JobRefusedError);
  });

  test("stop() leaves no timer armed, and nothing runs after it", async () => {
    const h = host();
    const ran: string[] = [];
    h.scheduler.register({ name: "a", everyMs: 10_000, run: () => void ran.push("a") });
    h.scheduler.start();
    expect(h.timers.live).toBe(1);
    h.timers.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual(["a"]);
    // The chain re-armed after the tick.
    expect(h.timers.live).toBe(1);
    h.scheduler.stop();
    expect(h.timers.live).toBe(0);
    expect(h.timers.cleared).toBe(h.timers.armed - 1);
    expect((await h.scheduler.tick()).ran).toEqual([]);
    expect(ran).toEqual(["a"]);
  });

  test("a name registered twice is refused", () => {
    const h = host();
    h.scheduler.register({ name: "a", everyMs: 1000, run: () => undefined });
    expect(() => h.scheduler.register({ name: "a", everyMs: 1000, run: () => undefined })).toThrow(
      "registered twice",
    );
  });
});

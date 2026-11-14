/**
 * Home's tick: one timer chain that runs the composed sweeps while Home runs, in a window
 * or as the installed service. Not to be confused with `schedulers.ts`, a harness's own
 * schedulers view.
 *
 * - A sweep runs when it is due (`everyMs` after its last start), in registration order;
 *   `tick()` runs every sweep that is due now, and the chain re-arms after each tick for
 *   the earliest one due next. The timer is `unref`'d, so it never keeps a process alive.
 * - Each sweep runs inside `withRequestAccess(systemAccess(name), …)`: it reads every
 *   harness under its own `sys:<name>` principal and is refused every write permission,
 *   so nothing a sweep does is authorized on its own say-so.
 * - A sweep still running when it is due again is skipped and counted, never run twice at
 *   once. A throw is caught and warned once per distinct message per sweep, and never
 *   stops the others.
 * - A sweep's context carries Home's checked job queue (`submit` and `check`, which run
 *   the check a start makes of where a job runs) and no other job API.
 *
 * Timers are injectable, so a test drives `tick()` with a fake clock and counts every
 * timer armed and cleared.
 */
import { systemAccess, withRequestAccess } from "./access";
import type { HomeJobQueue } from "./process";

/** The job API a sweep may use: the checked queue's own two calls, nothing else. */
export type SweepJobs = Pick<HomeJobQueue, "submit" | "check">;

export type SweepContext<P> = {
  /** The tick's clock reading, epoch ms. */
  readonly now: number;
  readonly jobs: SweepJobs;
  /** What Home lends its sweeps. */
  readonly home: P;
  /** A warning from inside the sweep: said once per distinct message. */
  warn(message: string): void;
};

export type Sweep<P> = {
  /** The sweep's name, which is also its principal's: `sys:<name>`. */
  readonly name: string;
  readonly everyMs: number;
  run(ctx: SweepContext<P>): Promise<void> | void;
};

export type TickReport = {
  /** The tick's clock reading, ISO. */
  readonly at: string;
  /** The sweeps that ran, in order. */
  readonly ran: readonly string[];
  /** The sweeps that were due and still running from before. */
  readonly skipped: readonly string[];
  /** The sweeps that threw, with their message. */
  readonly failed: ReadonlyArray<{ readonly name: string; readonly message: string }>;
};

export type SchedulerTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SchedulerHost<P> = {
  register(sweep: Sweep<P>): void;
  /** Run every sweep that is due now. */
  tick(): Promise<TickReport>;
  /** Run one sweep now, due or not (a write that must see its effect at once). */
  runNow(name: string): Promise<TickReport>;
  /** Arm the timer chain. */
  start(): void;
  /** Disarm it: no timer stays armed, and no tick starts after. */
  stop(): void;
  /** Resolves once no sweep is running. */
  idle(): Promise<void>;
  /** How many times each sweep was skipped because it was still running. */
  skippedCounts(): ReadonlyMap<string, number>;
};

const SYSTEM_TIMERS: SchedulerTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Slot<P> = {
  readonly sweep: Sweep<P>;
  nextDue: number;
  running: boolean;
  skipped: number;
  readonly warned: Set<string>;
};

export function createSchedulerHost<P>(options: {
  readonly now: () => number;
  readonly home: P;
  readonly jobs: SweepJobs;
  readonly onWarn: (message: string) => void;
  readonly timers?: SchedulerTimers;
}): SchedulerHost<P> {
  const timers = options.timers ?? SYSTEM_TIMERS;
  const slots: Slot<P>[] = [];
  let handle: unknown;
  let armed = false;
  let started = false;
  let stopped = false;
  const inFlight = new Set<Promise<unknown>>();
  // The checked queue's two calls, re-bound so a sweep can reach nothing else on it.
  const jobs: SweepJobs = {
    submit: (input) => options.jobs.submit(input),
    check: (input) => options.jobs.check(input),
  };

  const warnOnce = (slot: Slot<P>, message: string): void => {
    if (slot.warned.has(message)) return;
    slot.warned.add(message);
    options.onWarn(`hangar-server: the ${slot.sweep.name} sweep: ${message}`);
  };

  const runSlot = async (slot: Slot<P>, at: number): Promise<string | undefined> => {
    slot.running = true;
    slot.nextDue = at + slot.sweep.everyMs;
    try {
      const running = Promise.resolve(
        withRequestAccess(systemAccess(slot.sweep.name), () =>
          slot.sweep.run({
            now: at,
            jobs,
            home: options.home,
            warn: (message) => warnOnce(slot, message),
          }),
        ),
      );
      inFlight.add(running);
      try {
        await running;
      } finally {
        inFlight.delete(running);
      }
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnOnce(slot, message);
      return message;
    } finally {
      slot.running = false;
    }
  };

  const runSlots = async (chosen: readonly Slot<P>[], at: number): Promise<TickReport> => {
    const ran: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ name: string; message: string }> = [];
    for (const slot of chosen) {
      if (slot.running) {
        slot.skipped += 1;
        skipped.push(slot.sweep.name);
        continue;
      }
      const message = await runSlot(slot, at);
      ran.push(slot.sweep.name);
      if (message !== undefined) failed.push({ name: slot.sweep.name, message });
    }
    return { at: new Date(at).toISOString(), ran, skipped, failed };
  };

  const disarm = (): void => {
    if (!armed) return;
    timers.clearTimeout(handle);
    armed = false;
    handle = undefined;
  };

  const arm = (): void => {
    disarm();
    if (stopped || !started || slots.length === 0) return;
    const next = Math.min(...slots.map((slot) => slot.nextDue));
    const delay = Math.max(0, next - options.now());
    armed = true;
    handle = timers.setTimeout(() => {
      armed = false;
      handle = undefined;
      void tick().finally(arm);
    }, delay);
  };

  const tick = async (): Promise<TickReport> => {
    const at = options.now();
    if (stopped) return { at: new Date(at).toISOString(), ran: [], skipped: [], failed: [] };
    return await runSlots(
      slots.filter((slot) => slot.nextDue <= at),
      at,
    );
  };

  return {
    register: (sweep) => {
      if (slots.some((slot) => slot.sweep.name === sweep.name)) {
        throw new Error(`hangar-server: the ${sweep.name} sweep is registered twice`);
      }
      // Due at once: the first tick runs every sweep.
      slots.push({ sweep, nextDue: options.now(), running: false, skipped: 0, warned: new Set() });
      if (started) arm();
    },
    tick,
    runNow: async (name) => {
      const at = options.now();
      const slot = slots.find((candidate) => candidate.sweep.name === name);
      if (stopped || slot === undefined) {
        return { at: new Date(at).toISOString(), ran: [], skipped: [], failed: [] };
      }
      return await runSlots([slot], at);
    },
    start: () => {
      if (started || stopped) return;
      started = true;
      arm();
    },
    stop: () => {
      stopped = true;
      disarm();
    },
    skippedCounts: () => new Map(slots.map((slot) => [slot.sweep.name, slot.skipped])),
    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * Test seams: a controllable clock and a fake {@link ProcessOps}.
 *
 * Shipped from the package (not hidden in a test file) because the manager
 * server and the CLI verbs need exactly these to test THEIR supervision
 * wiring without spawning harnesses either. Nothing here touches a real
 * process; the only I/O is appending to a log file a fake child "wrote",
 * which is what a real fd-redirected daemon does.
 */
import { appendFileSync } from "node:fs";
import type { ProcessOps, SpawnRequest, SpawnedProcess } from "./process-ops";
import type { Clock } from "./types";

export type FakeClock = Clock & {
  /** Advance time and fire every timer due at or before the new now. */
  advance(ms: number): void;
  /** Fire every pending timer regardless of its deadline. */
  runAll(): void;
  pendingCount(): number;
  setNow(ms: number): void;
};

/** A clock whose time only moves when a test says so. */
export function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const fire = (predicate: (at: number) => boolean): void => {
    // Re-scan after each callback: a timer may schedule another timer.
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => predicate(t.at))
        .sort((a, b) => a[1].at - b[1].at);
      const next = due[0];
      if (next === undefined) return;
      timers.delete(next[0]);
      next[1].fn();
    }
  };
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: nowMs + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance: (ms) => {
      nowMs += ms;
      fire((at) => at <= nowMs);
    },
    runAll: () => {
      fire(() => true);
    },
    pendingCount: () => timers.size,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

export type FakeChild = {
  readonly pid: number;
  readonly request: SpawnRequest;
  /** Signals the supervisor sent, in order. */
  readonly signals: string[];
  /** Resolve the child's exit. */
  exit(code: number | null, signal?: string | null): void;
  /** Append text as if the child had written it to its log fd. */
  writeLog(text: string): void;
  /** Ignore SIGTERM (the escalation fixture, in-process). */
  ignoreTerm: boolean;
  alive: boolean;
};

export type FakeProcessOps = ProcessOps & {
  readonly children: FakeChild[];
  /** The most recently spawned child. */
  last(): FakeChild | undefined;
  /** Pretend a pid exists with this start time / command line — for
   *  adoption tests where no child was ever spawned here. */
  register(pid: number, startTimeMs: number, commandLine?: string): void;
  /** Pretend the pid died. */
  unregister(pid: number): void;
};

export type FakeProcessOpsOptions = {
  readonly now?: () => number;
  readonly firstPid?: number;
  /** Platform reported by the fake. */
  readonly platform?: "posix" | "windows";
};

/** A ProcessOps whose every effect is observable and whose every child is
 *  driven by the test. */
export function createFakeProcessOps(options: FakeProcessOpsOptions = {}): FakeProcessOps {
  const now = options.now ?? Date.now;
  let nextPid = options.firstPid ?? 4_242;
  const children: FakeChild[] = [];
  const registry = new Map<number, { startTimeMs: number; commandLine?: string }>();

  const childFor = (pid: number): FakeChild | undefined => children.find((c) => c.pid === pid);

  const ops: FakeProcessOps = {
    platform: options.platform ?? "posix",
    children,
    last: () => children[children.length - 1],
    register: (pid, startTimeMs, commandLine) => {
      registry.set(pid, { startTimeMs, ...(commandLine !== undefined ? { commandLine } : {}) });
    },
    unregister: (pid) => {
      registry.delete(pid);
      const child = childFor(pid);
      if (child !== undefined) child.alive = false;
    },
    spawn: (request: SpawnRequest): SpawnedProcess => {
      const pid = nextPid;
      nextPid += 1;
      let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        resolveExit = resolve;
      });
      const logPath = request.stdio.mode === "file" ? request.stdio.path : undefined;
      const child: FakeChild = {
        pid,
        request,
        signals: [],
        ignoreTerm: false,
        alive: true,
        exit: (code, signal = null) => {
          if (!child.alive) return;
          child.alive = false;
          registry.delete(pid);
          resolveExit({ code, signal });
        },
        writeLog: (text) => {
          if (logPath !== undefined) appendFileSync(logPath, text);
        },
      };
      children.push(child);
      registry.set(pid, {
        startTimeMs: now(),
        commandLine: request.argv.join(" "),
      });
      return {
        pid,
        exited,
        write: () => {},
        closeStdin: () => {},
        unref: () => {},
      };
    },
    isAlive: (pid) => registry.has(pid),
    startTimeMs: (pid) => registry.get(pid)?.startTimeMs,
    commandLine: (pid) => registry.get(pid)?.commandLine,
    terminate: (pid) => {
      const child = childFor(pid);
      child?.signals.push("SIGTERM");
      if (child !== undefined && !child.ignoreTerm) child.exit(null, "SIGTERM");
    },
    forceKill: (pid) => {
      const child = childFor(pid);
      child?.signals.push("SIGKILL");
      child?.exit(null, "SIGKILL");
    },
  };
  return ops;
}

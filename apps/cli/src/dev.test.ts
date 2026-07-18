import { describe, expect, test } from "bun:test";
import {
  type DevChildHandle,
  type DevRecompileResult,
  type DevSpawn,
  createDevSupervisor,
  devEntrypointFor,
  formatDevTurnSummary,
  isDevDaemonTarget,
  scanTurnEvent,
  stripAnsi,
} from "./dev";
import type { TimerSeam, Watcher } from "./watch";

const ESC = String.fromCharCode(27);

describe("devEntrypointFor / isDevDaemonTarget", () => {
  test("daemon shapes launch daemon.ts, others agent.ts", () => {
    for (const t of ["channel", "managed", "crew", "voice"]) {
      expect(devEntrypointFor(t)).toBe("daemon.ts");
    }
    for (const t of [
      "cli",
      "workflow",
      "graph",
      "batch",
      "browser",
      "pipeline",
      "research",
      "eval",
    ]) {
      expect(devEntrypointFor(t)).toBe("agent.ts");
    }
  });

  test("long-running shapes are restart-on-crash", () => {
    for (const t of ["channel", "managed", "crew", "voice", "batch"]) {
      expect(isDevDaemonTarget(t)).toBe(true);
    }
    for (const t of ["cli", "workflow", "graph", "browser"]) {
      expect(isDevDaemonTarget(t)).toBe(false);
    }
  });
});

describe("stripAnsi", () => {
  test("removes SGR escapes, keeps text", () => {
    expect(stripAnsi(`${ESC}[32mhello${ESC}[0m`)).toBe("hello");
    expect(stripAnsi("[turn_end] plain")).toBe("[turn_end] plain");
  });
});

describe("scanTurnEvent", () => {
  test("parses a pretty turn_end line (with color)", () => {
    const line = `${ESC}[2m12:00:00${ESC}[0m ${ESC}[36m[turn_end]           ${ESC}[0m turn=3 duration=1200ms tools=1`;
    expect(scanTurnEvent(line)).toEqual({ turn: 3, durationMs: 1200 });
  });

  test("parses a pretty turn_end without duration", () => {
    expect(scanTurnEvent("12:00:00 [turn_end]           turn=7")).toEqual({ turn: 7 });
  });

  test("parses a JSON turn_end line", () => {
    const line = JSON.stringify({ kind: "turn_end", turn: 5, durationMs: 42.7, foo: 1 });
    expect(scanTurnEvent(line)).toEqual({ turn: 5, durationMs: 42.7 });
  });

  test("ignores non-turn lines", () => {
    expect(scanTurnEvent("12:00:00 [turn_start]         turn=3 messages=4")).toBeUndefined();
    expect(scanTurnEvent(JSON.stringify({ kind: "model_response", turn: 3 }))).toBeUndefined();
    expect(scanTurnEvent("just some agent output")).toBeUndefined();
    expect(scanTurnEvent("")).toBeUndefined();
  });
});

describe("formatDevTurnSummary", () => {
  test("renders the turn + rounded duration", () => {
    expect(formatDevTurnSummary(3, 1200.4)).toBe("[dev] ✓ turn 3 complete (1200ms)");
    expect(formatDevTurnSummary(1)).toBe("[dev] ✓ turn 1 complete");
  });
});

// -------- supervisor harness --------

type FakeChild = DevChildHandle & {
  killed: boolean;
  feed: (line: string) => void;
  triggerExit: (code: number | null) => void;
};

function makeHarness(opts: {
  isDaemon: boolean;
  recompile: () => DevRecompileResult;
  maxRestarts?: number;
}) {
  const children: FakeChild[] = [];
  let nextPid = 1000;
  const spawn: DevSpawn = ({ onLine, onExit }) => {
    const child: FakeChild = {
      pid: nextPid++,
      killed: false,
      feed: (line) => onLine(line),
      triggerExit: (code) => onExit(code),
      kill() {
        if (this.killed) return;
        this.killed = true;
        onExit(0);
      },
    };
    children.push(child);
    return child;
  };

  const pending: Array<{ fn: () => void; handle: number }> = [];
  let hid = 1;
  const timer: TimerSeam = {
    set(fn) {
      const handle = hid++;
      pending.push({ fn, handle });
      return handle;
    },
    clear(h) {
      const i = pending.findIndex((p) => p.handle === h);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const flushTimers = (): void => {
    for (const p of pending.splice(0)) p.fn();
  };

  let changeCb: (() => void) | undefined;
  let watcherClosed = false;
  const watcher: Watcher = {
    subscribe(cb) {
      changeCb = cb;
    },
    close() {
      watcherClosed = true;
    },
  };

  const prints: string[] = [];
  const supervisor = createDevSupervisor({
    entry: "agent.ts",
    isDaemon: opts.isDaemon,
    initialCwd: "/tmp/build-0",
    spawn,
    recompile: opts.recompile,
    watcher,
    timer,
    debounceMs: 100,
    print: (l) => prints.push(l),
    ...(opts.maxRestarts !== undefined ? { maxRestarts: opts.maxRestarts } : {}),
    restartBackoffMs: 10,
  });

  return {
    supervisor,
    children,
    prints,
    flushTimers,
    emitChange: () => changeCb?.(),
    isWatcherClosed: () => watcherClosed,
    pendingTimers: () => pending.length,
  };
}

describe("createDevSupervisor", () => {
  test("launches the child at start", () => {
    const h = makeHarness({ isDaemon: false, recompile: () => ({ ok: true, cwd: "/x" }) });
    expect(h.children.length).toBe(1);
    expect(h.prints.some((l) => l.startsWith("[dev] launched agent.ts"))).toBe(true);
  });

  test("a clean recompile relaunches the child (old killed, one new)", () => {
    let build = 0;
    const h = makeHarness({
      isDaemon: false,
      recompile: () => ({ ok: true, cwd: `/build-${++build}` }),
    });
    h.emitChange();
    h.flushTimers();
    expect(h.children.length).toBe(2);
    expect(h.children[0]?.killed).toBe(true);
    expect(h.children[1]?.killed).toBe(false);
    expect(h.prints).toContain("[dev] change detected — recompiling");
    expect(h.prints).toContain("[dev] recompiled ✓");
    expect(h.prints).toContain("[dev] relaunching");
  });

  test("a broken recompile keeps the running child", () => {
    const h = makeHarness({ isDaemon: false, recompile: () => ({ ok: false, error: "bad spec" }) });
    h.emitChange();
    h.flushTimers();
    expect(h.children.length).toBe(1);
    expect(h.children[0]?.killed).toBe(false);
    expect(h.prints.some((l) => l.includes("compile ✗ — bad spec"))).toBe(true);
  });

  test("a daemon child crash triggers a bounded restart", () => {
    const h = makeHarness({ isDaemon: true, recompile: () => ({ ok: true, cwd: "/x" }) });
    // Simulate a crash: an exit we did NOT initiate.
    h.children[0]?.triggerExit(1);
    expect(h.prints.some((l) => l.includes("child exited (code 1)"))).toBe(true);
    expect(h.prints.some((l) => l.includes("restarting (1/5)"))).toBe(true);
    h.flushTimers(); // run the backoff
    expect(h.children.length).toBe(2);
  });

  test("a one-shot child exit is not restarted", () => {
    const h = makeHarness({ isDaemon: false, recompile: () => ({ ok: true, cwd: "/x" }) });
    h.children[0]?.triggerExit(0);
    expect(h.prints.some((l) => l.includes("child exited"))).toBe(true);
    expect(h.prints.some((l) => l.includes("restarting"))).toBe(false);
    expect(h.pendingTimers()).toBe(0);
    expect(h.children.length).toBe(1);
  });

  test("the crash-restart cap is honoured", () => {
    const h = makeHarness({
      isDaemon: true,
      recompile: () => ({ ok: true, cwd: "/x" }),
      maxRestarts: 2,
    });
    // Crash → restart, three times; the third should hit the cap.
    h.children[0]?.triggerExit(1);
    h.flushTimers();
    h.children[1]?.triggerExit(1);
    h.flushTimers();
    h.children[2]?.triggerExit(1);
    h.flushTimers();
    expect(h.prints.some((l) => l.includes("restart cap reached (2)"))).toBe(true);
    // 1 initial + 2 restarts = 3 children; the capped crash spawns none.
    expect(h.children.length).toBe(3);
  });

  test("per-turn summary prints as the child completes turns", () => {
    const h = makeHarness({ isDaemon: false, recompile: () => ({ ok: true, cwd: "/x" }) });
    h.children[0]?.feed("12:00:00 [turn_end]           turn=1 duration=500ms");
    expect(h.prints).toContain("[dev] ✓ turn 1 complete (500ms)");
  });

  test("stop() kills the child and stops watching", () => {
    const h = makeHarness({ isDaemon: true, recompile: () => ({ ok: true, cwd: "/x" }) });
    h.supervisor.stop();
    expect(h.isWatcherClosed()).toBe(true);
    expect(h.children[0]?.killed).toBe(true);
    // A crash after stop must not restart.
    const before = h.children.length;
    h.flushTimers();
    expect(h.children.length).toBe(before);
  });
});

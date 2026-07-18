/**
 * Loop contract 0.4 (Batch F, item 2) — `crewhaus dev <spec>`. The develop loop:
 * compile the spec in memory, run the emitted bundle as a SUPERVISED child, and
 * on every spec/authoring-dir change recompile + relaunch it — with
 * `CREWHAUS_TRACE=pretty` on by default so each turn streams, and a per-turn
 * `[dev]` summary line as the child completes turns.
 *
 * The supervision state machine (launch → relaunch-on-change → restart-on-crash
 * → teardown) is factored out here as a pure controller driven by INJECTED
 * spawn / recompile / watcher / timer seams, so it is unit-testable without real
 * child processes, fs watches, or wall-clock waits. The CLI wrapper wires the
 * real Bun.spawn + fs.watch + setTimeout behind the seams. The trace-line
 * scanner + entry-point map are pure helpers, tested directly.
 */

import type { TimerSeam, Watcher } from "./watch";

/** Target shapes whose runnable bundle entry is `daemon.ts` (a long-lived
 *  server/loop); everything else runs from `agent.ts`. Matches the target
 *  emitters' emitted file set. */
const DAEMON_ENTRY_TARGETS = new Set(["channel", "managed", "crew", "voice"]);

/** The long-running shapes `dev` restarts on an unexpected crash (a one-shot
 *  shape exiting is normal — it ran to completion — so it is not restarted). */
const DAEMON_TARGETS = new Set(["channel", "managed", "crew", "voice", "batch"]);

/** The bundle file `crewhaus dev` launches for a given target shape. */
export function devEntrypointFor(target: string): string {
  return DAEMON_ENTRY_TARGETS.has(target) ? "daemon.ts" : "agent.ts";
}

/** True for a long-running shape — one `dev` restarts if it crashes. */
export function isDevDaemonTarget(target: string): boolean {
  return DAEMON_TARGETS.has(target);
}

// ANSI SGR escapes the pretty printer wraps its lines in (ESC `[` … `m`);
// stripped before the turn-line match so a colorized `turn_end` still parses.
// Built from the ESC code point so the source carries no control-char literal.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export type TurnSummary = {
  readonly turn: number;
  readonly durationMs?: number;
};

/**
 * Recognize a `turn_end` in one line of the child's trace stream — either the
 * structured-event-printer's PRETTY line (`… [turn_end]  turn=N duration=Xms …`)
 * or a raw JSON trace line (`{"kind":"turn_end","turn":N,"durationMs":X,…}`),
 * so the per-turn summary works whether the child traces pretty (the dev
 * default) or json. Returns the turn number (+ duration when present), or
 * `undefined` for any other line.
 */
export function scanTurnEvent(line: string): TurnSummary | undefined {
  const clean = stripAnsi(line).trim();
  if (clean.length === 0) return undefined;

  // JSON trace line.
  if (clean.startsWith("{") && clean.includes('"turn_end"')) {
    try {
      const obj = JSON.parse(clean) as { kind?: unknown; turn?: unknown; durationMs?: unknown };
      if (obj.kind === "turn_end" && typeof obj.turn === "number") {
        return typeof obj.durationMs === "number"
          ? { turn: obj.turn, durationMs: obj.durationMs }
          : { turn: obj.turn };
      }
    } catch {
      // Not a turn_end JSON line — fall through to the pretty matcher.
    }
    return undefined;
  }

  // Pretty line: the `[turn_end]` kind tag followed by `turn=N [duration=Xms]`.
  if (!clean.includes("[turn_end]")) return undefined;
  const turnMatch = clean.match(/\bturn=(\d+)\b/);
  if (turnMatch === null) return undefined;
  const turn = Number.parseInt(turnMatch[1] as string, 10);
  const durMatch = clean.match(/\bduration=(\d+(?:\.\d+)?)ms\b/);
  return durMatch !== null
    ? { turn, durationMs: Number.parseFloat(durMatch[1] as string) }
    : { turn };
}

/** The `[dev]` per-turn summary line printed as the child completes a turn. */
export function formatDevTurnSummary(turn: number, durationMs?: number): string {
  const dur = durationMs !== undefined ? ` (${Math.round(durationMs)}ms)` : "";
  return `[dev] ✓ turn ${turn} complete${dur}`;
}

/** A spawned child the supervisor controls. */
export type DevChildHandle = {
  readonly pid: number | undefined;
  /** Terminate the child (idempotent). */
  kill(): void;
};

/** Spawn one child. The wrapper forwards the child's stdio to the user AND
 *  calls `onLine` for each complete output line (for turn scanning); `onExit`
 *  fires once with the exit code (or null on a signal). */
export type DevSpawn = (opts: {
  readonly entry: string;
  readonly cwd: string;
  readonly onLine: (line: string) => void;
  readonly onExit: (code: number | null) => void;
}) => DevChildHandle;

/** Recompile the spec in memory + emit to a fresh dir. `ok:false` carries the
 *  error message (a broken edit); the supervisor keeps the running child. */
export type DevRecompileResult =
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly error: string };

export type DevRecompile = () => DevRecompileResult;

export type DevSupervisorDeps = {
  /** The bundle entry file (stable across recompiles of one spec). */
  readonly entry: string;
  /** Restart this child if it crashes (long-running shapes only). */
  readonly isDaemon: boolean;
  /** The emitted-bundle dir for the initial launch. */
  readonly initialCwd: string;
  readonly spawn: DevSpawn;
  readonly recompile: DevRecompile;
  readonly watcher: Watcher;
  readonly timer: TimerSeam;
  /** Coalesce a burst of fs events into one relaunch after this many ms. */
  readonly debounceMs: number;
  /** Supervisor status sink (`[dev] …` lines → stderr in the CLI). */
  readonly print: (line: string) => void;
  /** Crash-restart cap for daemon shapes. Default 5. */
  readonly maxRestarts?: number;
  /** Backoff before a crash restart, in ms. Default 500. */
  readonly restartBackoffMs?: number;
};

/**
 * The dev supervisor. Launches the child, and:
 *  - a debounced watch event RECOMPILES; a clean compile relaunches the child
 *    (old killed, new spawned once the old exits — never two at once); a broken
 *    compile prints the error and keeps the running child.
 *  - an UNEXPECTED child exit restarts a daemon shape (bounded, backed off) and
 *    is reported-only for a one-shot shape.
 *  - each child output line is scanned for `turn_end` → a `[dev]` per-turn line.
 *  - `stop()` (Ctrl-C) kills the child and stops watching.
 *
 * Returns `{ stop, idle }`; `idle()` (tests) resolves when no relaunch/restart
 * is pending.
 */
export function createDevSupervisor(deps: DevSupervisorDeps): {
  stop(): void;
  idle(): Promise<void>;
} {
  const maxRestarts = deps.maxRestarts ?? 5;
  const backoff = deps.restartBackoffMs ?? 500;

  let child: DevChildHandle | undefined;
  let lastGoodCwd = deps.initialCwd;
  let restarts = 0;
  let stopped = false;
  // Set while we intentionally kill the child (relaunch / stop), so its exit is
  // not misread as a crash.
  let killing = false;
  // The cwd to launch once the current child exits (a relaunch in flight).
  let pendingCwd: string | undefined;
  let debounceHandle: unknown;
  let backoffHandle: unknown;
  let recompiling = false;
  const idleWaiters: Array<() => void> = [];

  const settleIfIdle = (): void => {
    if (
      debounceHandle === undefined &&
      backoffHandle === undefined &&
      pendingCwd === undefined &&
      !recompiling
    ) {
      for (const w of idleWaiters.splice(0)) w();
    }
  };

  const launch = (cwd: string): void => {
    if (stopped) return;
    lastGoodCwd = cwd;
    killing = false;
    child = deps.spawn({
      entry: deps.entry,
      cwd,
      onLine: (line) => {
        const summary = scanTurnEvent(line);
        if (summary !== undefined) {
          deps.print(formatDevTurnSummary(summary.turn, summary.durationMs));
        }
      },
      onExit: (code) => {
        child = undefined;
        if (killing) {
          // Intentional kill (relaunch or stop).
          killing = false;
          if (pendingCwd !== undefined && !stopped) {
            const next = pendingCwd;
            pendingCwd = undefined;
            deps.print("[dev] relaunching");
            launch(next);
          }
          settleIfIdle();
          return;
        }
        // Unexpected exit.
        deps.print(`[dev] child exited (code ${code ?? "signal"})`);
        if (stopped) return;
        if (deps.isDaemon && restarts < maxRestarts) {
          restarts += 1;
          deps.print(`[dev] restarting (${restarts}/${maxRestarts}) after crash`);
          backoffHandle = deps.timer.set(() => {
            backoffHandle = undefined;
            if (!stopped) launch(lastGoodCwd);
            settleIfIdle();
          }, backoff);
        } else if (deps.isDaemon) {
          deps.print(`[dev] restart cap reached (${maxRestarts}) — edit the spec to relaunch`);
          settleIfIdle();
        } else {
          // One-shot shape: exiting is normal; wait for the next edit.
          settleIfIdle();
        }
      },
    });
    deps.print(`[dev] launched ${deps.entry} (pid ${child.pid ?? "?"}) in ${cwd}`);
  };

  const relaunch = (cwd: string): void => {
    // Reset the crash counter — a fresh build is a clean slate.
    restarts = 0;
    if (backoffHandle !== undefined) {
      deps.timer.clear(backoffHandle);
      backoffHandle = undefined;
    }
    if (child !== undefined) {
      pendingCwd = cwd;
      killing = true;
      child.kill();
    } else {
      launch(cwd);
    }
  };

  const runRecompile = (): void => {
    if (stopped) return;
    recompiling = true;
    deps.print("[dev] change detected — recompiling");
    const result = deps.recompile();
    recompiling = false;
    if (result.ok) {
      deps.print("[dev] recompiled ✓");
      relaunch(result.cwd);
    } else {
      deps.print(`[dev] compile ✗ — ${result.error} (keeping the running child)`);
      settleIfIdle();
    }
  };

  const onChange = (): void => {
    if (stopped) return;
    // Trailing debounce: reset the timer on every event in the window.
    if (debounceHandle !== undefined) deps.timer.clear(debounceHandle);
    debounceHandle = deps.timer.set(() => {
      debounceHandle = undefined;
      runRecompile();
    }, deps.debounceMs);
  };

  deps.watcher.subscribe(onChange);
  launch(deps.initialCwd);

  return {
    stop: (): void => {
      stopped = true;
      if (debounceHandle !== undefined) {
        deps.timer.clear(debounceHandle);
        debounceHandle = undefined;
      }
      if (backoffHandle !== undefined) {
        deps.timer.clear(backoffHandle);
        backoffHandle = undefined;
      }
      pendingCwd = undefined;
      deps.watcher.close();
      if (child !== undefined) {
        killing = true;
        child.kill();
      }
      settleIfIdle();
    },
    idle: (): Promise<void> =>
      new Promise<void>((resolveIdle) => {
        idleWaiters.push(resolveIdle);
        settleIfIdle();
      }),
  };
}

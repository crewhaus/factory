/**
 * The supervision state machine — one instance per harness.
 *
 * ```
 * stopped → preflight → starting → running → (draining) →
 *   stopped | crashed | parked | terminal | crash-looping
 * ```
 *
 * What it guarantees:
 *
 *   - **Preflight before every spawn.** A blocking finding refuses the
 *     spawn and returns the typed report; missing channel secrets can never
 *     be forced (the compiled daemon exits 2 on exactly that set).
 *   - **Singleton daemons.** The runfile is the lock: a verified-live
 *     runfile makes `start()` a no-op rather than a second process.
 *   - **Honest exits.** Our own SIGTERM reads as `stopped`; exit 0 from a
 *     long-running shape reads as "exited cleanly (unexpected)"; 20/21/30/
 *     31/33 are terminal and NEVER auto-restart; 36 parks; everything else
 *     backs off 500 ms → 30 s and gives up into `crash-looping` after 5
 *     restarts in a rolling 10-minute window, with forensics attached.
 *   - **One capture path.** Attached runs tee their pipes into the same
 *     `logs/<runId>.log` a detached daemon writes with an fd, and BOTH are
 *     read back through the cursor-driven pump. Durable history, live feed,
 *     and post-restart adoption are then the same mechanism, and the
 *     scrubber sits on it exactly once.
 *   - **Stop means stop.** SIGTERM, then SIGKILL after a 15 s grace, with
 *     `forced: true` recorded in the ledger.
 *
 * Every side-effecting dependency is injected — process ops, clock, plan
 * builder, gate, scrubber, id minter — so the whole machine is exercised in
 * unit tests without spawning a harness.
 */
import { appendFileSync } from "node:fs";
import { adoptRunning, verifyRunfile } from "./adoption";
import type { GateDecision, GateOptions } from "./gate";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  type ExitClassification,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  STOP_GRACE_MS,
  backoffDelayMs,
  classifyExit,
  createRestartWindow,
} from "./policy";
import { type PortLedger, runfilePortClaims } from "./ports";
import { type ProcessOps, argvFingerprint } from "./process-ops";
import {
  appendRunLedger,
  clearRunfile,
  ensureRunDir,
  newRunId,
  patchRunLedger,
  pruneRuns,
  readRetentionPolicy,
  readRunfile,
  runCursorPath,
  runEventsPath,
  runLogPath,
  writeRunfile,
} from "./runfiles";
import { type Scrubber, createEnvScrubber } from "./scrub";
import { type SpawnPlan, isSupervisedClass, loadEnvChain, runClassFor } from "./spawn-contracts";
import { type LogPump, createLogPump, readLogTail } from "./trace-pump";
import {
  type Clock,
  type DaemonRunfile,
  RUNFILE_VERSION,
  type RetentionPolicy,
  type SupervisionState,
  systemClock,
} from "./types";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type RunForensics = {
  /** The run's last `run_failed` trace event, when one was seen — always
   *  better than a raw tail. */
  readonly lastRunFailed?: Record<string, unknown>;
  /** Trailing log lines, scrubbed, for when there was no structured event. */
  readonly tail: readonly string[];
  readonly exitCode?: number;
  readonly signal?: string;
};

export type SupervisorSnapshot = {
  readonly state: SupervisionState;
  readonly harnessDir: string;
  readonly target: string;
  readonly runId?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly sessionId?: string;
  /** Restarts inside the rolling window. */
  readonly restartsInWindow: number;
  /** Epoch ms of the scheduled restart, when one is pending. */
  readonly nextRestartAtMs?: number;
  readonly lastExit?: ExitClassification;
  readonly forensics?: RunForensics;
  /** True when the run was adopted rather than spawned by this manager. */
  readonly adopted?: boolean;
  readonly ports?: SpawnPlan["ports"];
};

export type SupervisorEvent =
  | { readonly type: "state"; readonly snapshot: SupervisorSnapshot }
  | {
      readonly type: "output";
      readonly runId: string;
      readonly prose: string;
      readonly events: ReadonlyArray<Record<string, unknown>>;
    }
  | {
      readonly type: "exit";
      readonly runId: string;
      readonly classification: ExitClassification;
    };

export type StartResult =
  | { readonly ok: true; readonly runId: string; readonly pid: number | undefined }
  | { readonly ok: false; readonly reason: "already-running"; readonly runfile?: DaemonRunfile }
  | { readonly ok: false; readonly reason: "preflight-blocked"; readonly gate: GateDecision }
  | { readonly ok: false; readonly reason: "plan-failed"; readonly error: Error };

export type StopResult = {
  readonly stopped: boolean;
  /** True when the grace period expired and SIGKILL was used. */
  readonly forced: boolean;
};

export type SupervisorOptions = {
  readonly harnessDir: string;
  /** Spec target — decides the run class and the entry file. */
  readonly target: string;
  readonly ops: ProcessOps;
  /** Built fresh on every start so a recompile or a spec edit is picked up
   *  without recreating the supervisor. */
  readonly plan: () => SpawnPlan | Promise<SpawnPlan>;
  /** The preflight gate. Omit to skip preflight (tests, and the explicit
   *  `crewhaus daemon start --no-preflight` escape hatch). */
  readonly gate?: (options: GateOptions) => Promise<GateDecision>;
  readonly clock?: Clock;
  readonly managerVersion?: string;
  /** Built from the spawn env when omitted — every captured byte is
   *  scrubbed of known credential values before it leaves the process. */
  readonly scrub?: Scrubber;
  readonly ports?: PortLedger;
  readonly newRunId?: () => string;
  readonly retention?: RetentionPolicy;
  /** How often the pump drains a detached run's log. Default 250 ms. */
  readonly pumpIntervalMs?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly stopGraceMs?: number;
  /** Restart a long-running shape that exited 0 unasked. Default true. */
  readonly restartUnexpectedCleanExit?: boolean;
};

export type HarnessSupervisor = {
  snapshot(): SupervisorSnapshot;
  start(options?: GateOptions): Promise<StartResult>;
  stop(options?: { readonly graceMs?: number }): Promise<StopResult>;
  restart(options?: GateOptions): Promise<StartResult>;
  /** Graceful intake-stop: the caller performs the control.v1 `drain` call;
   *  this only drives the state and waits for the exit. */
  drain(request: () => Promise<void>, timeoutMs?: number): Promise<StopResult>;
  /** Re-attach to a runfile written by a previous manager. */
  adopt(): Promise<"adopted" | "lost" | "none">;
  /** Drain the log once, now (tests; also the manual Refresh action). */
  pumpNow(): void;
  subscribe(listener: (event: SupervisorEvent) => void): () => void;
  /** Resolves when no restart is scheduled and no start is in flight. */
  idle(): Promise<void>;
  /** Release timers and listeners without touching the child. */
  close(): void;
};

export const DEFAULT_PUMP_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createHarnessSupervisor(options: SupervisorOptions): HarnessSupervisor {
  const clock = options.clock ?? systemClock;
  const managerVersion = options.managerVersion ?? "0.0.0";
  const mintRunId = options.newRunId ?? (() => newRunId());
  const pumpInterval = options.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  const graceMs = options.stopGraceMs ?? STOP_GRACE_MS;
  const window = createRestartWindow(
    clock,
    options.maxRestarts ?? MAX_RESTARTS_PER_WINDOW,
    options.restartWindowMs ?? RESTART_WINDOW_MS,
  );

  let state: SupervisionState = "stopped";
  let runId: string | undefined;
  let pid: number | undefined;
  let startedAt: string | undefined;
  let sessionId: string | undefined;
  let lastExit: ExitClassification | undefined;
  let forensics: RunForensics | undefined;
  let adopted = false;
  let currentPlan: SpawnPlan | undefined;
  let pump: LogPump | undefined;
  let pumpTimer: unknown;
  let restartTimer: unknown;
  let nextRestartAtMs: number | undefined;
  let operatorStop = false;
  let forcedStopInFlight = false;
  let starting = false;
  let closed = false;
  let lastRunFailed: Record<string, unknown> | undefined;
  // Default to a scrubber over the harness's own `.env` chain so even an
  // adopted run — where no spawn env was ever built here — is scrubbed.
  let scrub: Scrubber = options.scrub ?? createEnvScrubber(loadEnvChain(options.harnessDir).vars);
  const listeners = new Set<(event: SupervisorEvent) => void>();
  const idleWaiters: Array<() => void> = [];

  const snapshot = (): SupervisorSnapshot => ({
    state,
    harnessDir: options.harnessDir,
    target: options.target,
    ...(runId !== undefined ? { runId } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    restartsInWindow: window.count(),
    ...(nextRestartAtMs !== undefined ? { nextRestartAtMs } : {}),
    ...(lastExit !== undefined ? { lastExit } : {}),
    ...(forensics !== undefined ? { forensics } : {}),
    ...(adopted ? { adopted: true } : {}),
    ...(currentPlan !== undefined ? { ports: currentPlan.ports } : {}),
  });

  const emit = (event: SupervisorEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber's bug must never take the supervisor down.
      }
    }
  };

  const setState = (next: SupervisionState): void => {
    state = next;
    emit({ type: "state", snapshot: snapshot() });
  };

  const settleIfIdle = (): void => {
    if (!starting && restartTimer === undefined) {
      for (const w of idleWaiters.splice(0)) w();
    }
  };

  const drainPump = (): void => {
    if (pump === undefined || runId === undefined) return;
    const result = pump.pumpOnce();
    if (result.prose === "" && result.events.length === 0) return;
    for (const event of result.events) {
      const kind = event["kind"];
      const sid = event["sessionId"];
      if (sessionId === undefined && typeof sid === "string" && sid !== "") {
        sessionId = sid;
        patchRunLedger(options.harnessDir, { runId, sessionId: sid });
      }
      if (kind === "run_failed") lastRunFailed = event;
    }
    emit({ type: "output", runId, prose: result.prose, events: result.events });
  };

  const schedulePump = (): void => {
    if (closed) return;
    pumpTimer = clock.setTimeout(() => {
      pumpTimer = undefined;
      drainPump();
      // An ADOPTED run is not ours to await — we never held its exit
      // promise — so the pump tick doubles as its liveness poll.
      if (adopted && pid !== undefined && !options.ops.isAlive(pid)) {
        onExit(null, null);
        return;
      }
      if (state === "running" || state === "draining" || state === "starting") schedulePump();
    }, pumpInterval);
  };

  const stopPump = (): void => {
    if (pumpTimer !== undefined) {
      clock.clearTimeout(pumpTimer);
      pumpTimer = undefined;
    }
  };

  const finishRun = (classification: ExitClassification, forced: boolean): void => {
    const endedRunId = runId;
    stopPump();
    // Final flush: release any held-back partial as prose so the last line
    // of a crashing run is never swallowed.
    if (pump !== undefined && endedRunId !== undefined) {
      const tailResult = pump.flush();
      if (tailResult.prose !== "" || tailResult.events.length > 0) {
        for (const event of tailResult.events) {
          if (event["kind"] === "run_failed") lastRunFailed = event;
        }
        emit({
          type: "output",
          runId: endedRunId,
          prose: tailResult.prose,
          events: tailResult.events,
        });
      }
    }
    lastExit = classification;
    if (endedRunId !== undefined) {
      forensics = {
        ...(lastRunFailed !== undefined ? { lastRunFailed } : {}),
        tail: readLogTail(runLogPath(options.harnessDir, endedRunId), scrub),
        ...(classification.exitCode !== undefined ? { exitCode: classification.exitCode } : {}),
        ...(classification.signal !== undefined ? { signal: classification.signal } : {}),
      };
      patchRunLedger(options.harnessDir, {
        runId: endedRunId,
        endedAt: new Date(clock.now()).toISOString(),
        ...(classification.exitCode !== undefined ? { exitCode: classification.exitCode } : {}),
        ...(classification.failureClass !== undefined
          ? { failureClass: classification.failureClass }
          : {}),
        ...(forced ? { forced: true } : {}),
      });
      emit({ type: "exit", runId: endedRunId, classification });
    }
    if (currentPlan !== undefined && currentPlan.kind === "daemon") {
      clearRunfile(options.harnessDir);
    }
    if (options.ports !== undefined && endedRunId !== undefined) {
      options.ports.releaseRun(endedRunId);
    }
    pid = undefined;
    pump = undefined;
    // Retention runs on rotation, protecting the run that just ended so its
    // forensics survive long enough to be read.
    try {
      pruneRuns(
        options.harnessDir,
        options.retention ?? readRetentionPolicy(options.harnessDir),
        endedRunId !== undefined ? [endedRunId] : [],
      );
    } catch {
      // Retention is housekeeping — never fail a run over it.
    }
  };

  /** Cancel a scheduled auto-restart (an operator gesture supersedes it). */
  const cancelPendingRestart = (): void => {
    if (restartTimer === undefined) return;
    clock.clearTimeout(restartTimer);
    restartTimer = undefined;
    nextRestartAtMs = undefined;
  };

  const scheduleRestart = (): void => {
    const attempt = window.record();
    const delay = backoffDelayMs(
      attempt,
      options.backoffBaseMs ?? BACKOFF_BASE_MS,
      options.backoffCapMs ?? BACKOFF_CAP_MS,
    );
    nextRestartAtMs = clock.now() + delay;
    setState("crashed");
    restartTimer = clock.setTimeout(() => {
      restartTimer = undefined;
      nextRestartAtMs = undefined;
      void start().finally(settleIfIdle);
    }, delay);
  };

  const onExit = (code: number | null, signal: string | null): void => {
    const wasOperatorStop = operatorStop;
    operatorStop = false;
    // An adopted run has no plan of ours; the target's run class still says
    // whether it is long-running, so supervision survives a manager restart.
    const longRunning = currentPlan?.supervised ?? isSupervisedClass(runClassFor(options.target));
    const base = classifyExit({
      exitCode: code,
      signal,
      operatorStop: wasOperatorStop,
      longRunning,
      ...(options.restartUnexpectedCleanExit !== undefined
        ? { restartUnexpectedCleanExit: options.restartUnexpectedCleanExit }
        : {}),
    });
    const classification: ExitClassification =
      adopted && code === null && signal === null && !wasOperatorStop
        ? { ...base, title: "exited while unobserved — exit code unknown (adopted run)" }
        : base;
    finishRun(classification, forcedStopInFlight);
    forcedStopInFlight = false;

    switch (classification.disposition) {
      case "terminal":
        setState("terminal");
        break;
      case "parked":
        setState("parked");
        break;
      case "clean":
        if (classification.restartable && !closed) {
          // A long-running shape that returned 0 unasked has lost its
          // listener; the same backoff and window apply.
          if (window.exhausted()) setState("crash-looping");
          else scheduleRestart();
        } else {
          setState("stopped");
        }
        break;
      default:
        if (!classification.restartable || closed) {
          setState("crashed");
        } else if (window.exhausted()) {
          // Manual start only from here — with the forensics attached.
          setState("crash-looping");
        } else {
          scheduleRestart();
        }
        break;
    }
    settleIfIdle();
  };

  const startPump = (id: string, spawnEnv: Record<string, string>): void => {
    if (options.scrub === undefined) scrub = createEnvScrubber(spawnEnv);
    pump = createLogPump({
      logFile: runLogPath(options.harnessDir, id),
      eventsFile: runEventsPath(options.harnessDir, id),
      cursorFile: runCursorPath(options.harnessDir, id),
      scrub,
      now: clock.now,
    });
    schedulePump();
  };

  const start = async (gateOptions: GateOptions = {}): Promise<StartResult> => {
    if (closed) {
      return { ok: false, reason: "plan-failed", error: new Error("supervisor is closed") };
    }
    if (state === "running" || state === "starting" || starting) {
      return { ok: false, reason: "already-running" };
    }
    // `crash-looping` is manual-start-only, and an operator calling start()
    // IS the manual start — only the automatic path is blocked, and it is
    // blocked by never scheduling a restart timer in that state.
    // A manual start supersedes a scheduled auto-restart; leaving the timer
    // armed would spawn a second child moments later.
    cancelPendingRestart();
    starting = true;
    try {
      let plan: SpawnPlan;
      try {
        plan = await options.plan();
      } catch (err) {
        return {
          ok: false,
          reason: "plan-failed",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
      currentPlan = plan;

      // Singleton guard: a verified-live runfile means the daemon is
      // already up, whoever started it. The argv is deliberately NOT part of
      // this check — a daemon started from an older spec is still a running
      // daemon for this harness, and starting a second one is the failure
      // mode the runfile exists to prevent.
      if (plan.kind === "daemon") {
        const existing = readRunfile(options.harnessDir);
        const verdict = verifyRunfile(existing, options.ops);
        if (verdict.live && existing !== undefined) {
          return { ok: false, reason: "already-running", runfile: existing };
        }
      }

      if (options.gate !== undefined) {
        setState("preflight");
        const decision = await options.gate(gateOptions);
        if (!decision.allowed) {
          setState("stopped");
          return { ok: false, reason: "preflight-blocked", gate: decision };
        }
      }

      setState("starting");
      const id = mintRunId();
      runId = id;
      sessionId = undefined;
      lastRunFailed = undefined;
      adopted = false;
      ensureRunDir(options.harnessDir);
      const logFile = runLogPath(options.harnessDir, id);
      // Touch the log so the pump has a file to stat from the first tick,
      // and so an fd-redirected child appends rather than creates.
      appendFileSync(logFile, "", { mode: 0o600 });

      const child = options.ops.spawn({
        argv: plan.argv,
        cwd: plan.cwd,
        env: plan.env,
        stdio: plan.stdio === "file" ? { mode: "file", path: logFile } : { mode: "pipe" },
        detached: plan.detached,
      });
      pid = child.pid;
      startedAt = new Date(clock.now()).toISOString();
      appendRunLedger(options.harnessDir, {
        runId: id,
        kind: plan.kind,
        argv: [...plan.argv],
        startedAt,
        logFile: `logs/${id}.log`,
      });

      if (plan.kind === "daemon") {
        const observedStart = pid !== undefined ? options.ops.startTimeMs(pid) : undefined;
        writeRunfile(options.harnessDir, {
          v: RUNFILE_VERSION,
          pid: pid ?? 0,
          pidStartTimeMs: observedStart ?? clock.now(),
          argvFingerprint: argvFingerprint(plan.cwd, plan.argv),
          ...(plan.ports.port !== undefined ? { port: plan.ports.port } : {}),
          ...(plan.ports.gatewayPort !== undefined ? { gatewayPort: plan.ports.gatewayPort } : {}),
          ...(plan.ports.controlPort !== undefined ? { controlPort: plan.ports.controlPort } : {}),
          ...(plan.controlTokenPath !== undefined
            ? { controlTokenPath: plan.controlTokenPath }
            : {}),
          entry: plan.entry,
          bundleDir: plan.bundleDir,
          runId: id,
          startedAt,
          managerVersion,
        });
      }
      if (options.ports !== undefined) {
        for (const claim of runfilePortClaims(plan.cwd, {
          runId: id,
          ...(plan.ports.port !== undefined ? { port: plan.ports.port } : {}),
          ...(plan.ports.gatewayPort !== undefined ? { gatewayPort: plan.ports.gatewayPort } : {}),
          ...(plan.ports.controlPort !== undefined ? { controlPort: plan.ports.controlPort } : {}),
        })) {
          options.ports.claim(claim);
        }
      }

      startPump(id, plan.env);
      if (plan.detached) child.unref?.();
      // Attached runs tee their pipes into the SAME log file the pump reads,
      // so both modes share one extraction and one scrubbing path.
      if (plan.stdio === "pipe") {
        void teePipe(child.stdout, logFile);
        void teePipe(child.stderr, logFile);
      }
      void child.exited.then(({ code, signal }) => onExit(code, signal));
      setState("running");
      return { ok: true, runId: id, pid };
    } finally {
      starting = false;
      settleIfIdle();
    }
  };

  const stop = async (stopOptions: { graceMs?: number } = {}): Promise<StopResult> => {
    // An operator stop always cancels a scheduled auto-restart — otherwise
    // the backoff timer would resurrect the daemon after the stop.
    cancelPendingRestart();
    if (pid === undefined) {
      // Nothing of ours is running; clear a stale runfile so the next start
      // is not refused by a ghost.
      if (currentPlan?.kind === "daemon") clearRunfile(options.harnessDir);
      setState("stopped");
      return { stopped: true, forced: false };
    }
    const target = pid;
    operatorStop = true;
    const exited = onceExit();
    options.ops.terminate(target);
    let forced = false;
    // The grace timer is the escalation: a child that ignores SIGTERM (or
    // wedges inside its shutdown path) is SIGKILLed and the run is recorded
    // `forced: true` so the operator sees it was not a clean stop.
    const handle = clock.setTimeout(() => {
      if (pid === undefined) return;
      forced = true;
      forcedStopInFlight = true;
      options.ops.forceKill(target);
    }, stopOptions.graceMs ?? graceMs);
    await exited;
    clock.clearTimeout(handle);
    return { stopped: true, forced };
  };

  /** Resolve on the next `exit` event. */
  const onceExit = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const unsubscribe = subscribe((event) => {
        if (event.type === "exit") {
          unsubscribe();
          resolve();
        }
      });
    });

  const subscribe = (listener: (event: SupervisorEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    snapshot,
    start,
    stop,
    restart: async (gateOptions) => {
      await stop();
      return start(gateOptions);
    },
    drain: async (request, timeoutMs) => {
      if (pid === undefined) return { stopped: true, forced: false };
      // Subscribe BEFORE the control call: a daemon that drains promptly can
      // exit inside `request()`, and a subscription taken afterwards would
      // wait forever for an event that already fired.
      const exited = onceExit();
      setState("draining");
      operatorStop = true;
      try {
        await request();
      } catch {
        // The daemon has no control.v1 (a 0.4.x bundle) or refused —
        // fall through to the signal path rather than hang.
        operatorStop = false;
        return stop();
      }
      let deadlineHandle: unknown;
      const deadline = new Promise<"timeout">((resolve) => {
        deadlineHandle = clock.setTimeout(() => resolve("timeout"), timeoutMs ?? graceMs);
      });
      const outcome = await Promise.race([exited.then(() => "exited" as const), deadline]);
      clock.clearTimeout(deadlineHandle);
      if (outcome === "timeout") {
        operatorStop = true;
        return stop();
      }
      return { stopped: true, forced: false };
    },
    adopt: async () => {
      const result = adoptRunning(options.harnessDir, {
        ops: options.ops,
        scrub,
        now: clock.now,
      });
      if (result.status === "none") {
        setState("stopped");
        return "none";
      }
      if (result.status === "lost") {
        forensics = { tail: result.tail };
        lastExit = {
          disposition: "crash",
          title: `daemon is gone (${result.reason}) — the manager was not running when it exited`,
          restartable: false,
          unexpectedClean: false,
        };
        setState("crashed");
        return "lost";
      }
      runId = result.runfile.runId;
      pid = result.runfile.pid;
      startedAt = result.runfile.startedAt;
      adopted = true;
      pump = result.pump;
      if (options.ports !== undefined) {
        options.ports.adopt(runfilePortClaims(options.harnessDir, result.runfile));
      }
      schedulePump();
      setState("running");
      return "adopted";
    },
    pumpNow: drainPump,
    subscribe,
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIfIdle();
      }),
    close: () => {
      closed = true;
      stopPump();
      if (restartTimer !== undefined) {
        clock.clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      listeners.clear();
      settleIfIdle();
    },
  };
}

/** Copy a piped stream into the run log. Attached runs must end up with the
 *  same durable artifact a detached daemon writes, or "open an old run"
 *  would work for daemons only. */
async function teePipe(
  stream: AsyncIterable<Uint8Array> | undefined,
  logFile: string,
): Promise<void> {
  if (stream === undefined) return;
  try {
    for await (const chunk of stream) {
      appendFileSync(logFile, chunk);
    }
  } catch {
    // The pipe closed with the child — nothing left to tee.
  }
}

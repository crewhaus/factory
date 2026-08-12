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
 *   - **Operator prep is part of the start, not a convention beside it.**
 *     The optional `prepare` seam runs compile-if-stale and the harness's
 *     own `postCompile` hook inside the start slot (so preflight sees the
 *     bundle that will be spawned), and its `preSpawn` hook immediately
 *     before the spawn. Either refusing stops the start exactly like a
 *     blocking preflight finding, with the step's own output attached.
 *   - **Singleton daemons.** Two claims, because one is not enough: a
 *     `daemon.lock` (O_EXCL) is held from before preflight until the runfile
 *     exists, and the runfile itself is the claim from then on. A
 *     verified-live runfile makes `start()` a no-op rather than a second
 *     process, and a start already in flight in another manager loses the
 *     lock rather than racing it through preflight.
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
 *     `forced: true` recorded in the ledger — and a stop that holds no pid
 *     while a LIVE runfile exists says so (`reason: "not-adopted"`) instead
 *     of reporting a success it did not perform.
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
import type { PrepareRefusal, PrepareRunner } from "./prepare";
import { type ProcessOps, type SpawnedProcess, argvFingerprint } from "./process-ops";
import {
  acquireStartLock,
  appendRunLedger,
  clearRunfile,
  ensureRunDir,
  newRunId,
  patchRunLedger,
  pruneRuns,
  readRetentionPolicy,
  readRunLedger,
  readRunfile,
  readStartLock,
  recentRuns,
  releaseStartLock,
  runCursorPath,
  runEventsPath,
  runLogPath,
  runfileExists,
  startLockIsStale,
  writeRunfile,
} from "./runfiles";
import { type Scrubber, createEnvScrubber, scrubbableEnvKeys } from "./scrub";
import type { SupervisedChild } from "./shutdown";
import { type SpawnPlan, isSupervisedClass, loadEnvChain, runClassFor } from "./spawn-contracts";
import {
  type LogPump,
  createLogPump,
  parseAnnouncedControlPort,
  readLogTail,
  replayRunEvents,
} from "./trace-pump";
import {
  type Clock,
  type DaemonRunfile,
  RUNFILE_VERSION,
  type RetentionPolicy,
  type RunKind,
  type StartLock,
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
  /** The control.v1 port this run is really serving on, once it is known:
   *  announced on stdout (the plan asks for a kernel-assigned 0) or read
   *  from the runfile at adoption. */
  readonly controlPort?: number;
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
  | {
      readonly ok: true;
      readonly runId: string;
      readonly pid: number | undefined;
      /** What the prepare seams did on the way in ("recompiled dist/",
       *  "preSpawn hook ok") — nothing to act on, but an operator who asked
       *  for a recompile deserves to be told it happened. */
      readonly prepared?: readonly string[];
    }
  | { readonly ok: false; readonly reason: "already-running"; readonly runfile?: DaemonRunfile }
  | { readonly ok: false; readonly reason: "preflight-blocked"; readonly gate: GateDecision }
  | {
      /** A compile or an operator hook refused. Blocking exactly like a
       *  preflight finding: a prep step that cannot run must not be waved
       *  past into a spawn that misbehaves in a way nobody connects back. */
      readonly ok: false;
      readonly reason: "prepare-refused";
      readonly refusal: PrepareRefusal;
    }
  | {
      readonly ok: false;
      readonly reason: "plan-failed";
      readonly error: Error;
      /** Which half of `start()` failed. `plan` is a spec/bundle problem the
       *  operator can fix; `spawn` is the machine refusing to launch
       *  (EMFILE, ENOSPC, EACCES on the run dir) — same shape, different
       *  remedy, and the caller can say so. */
      readonly stage?: "plan" | "spawn";
    };

export type StopResult = {
  readonly stopped: boolean;
  /** True when the grace period expired and SIGKILL was used. */
  readonly forced: boolean;
  /** Why nothing was stopped. `not-adopted` means a LIVE daemon holds the
   *  runfile but this supervisor never adopted it, so it has no pid to
   *  signal — the caller must `adoptIfRunfile()` first. Reporting
   *  `stopped: true` here is what let a Restart delete a live daemon's lock
   *  and spawn a second one beside it. */
  readonly reason?: "not-adopted";
  /** The live runfile, on `not-adopted`. */
  readonly runfile?: DaemonRunfile;
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
  /**
   * The prepare seams: compile-if-stale + the operator's hooks. Built fresh
   * per start by the caller (`createPrepareRunner`), because the settings
   * they read are edited between starts like the spec is.
   *
   * `prepare` runs after the start slot is claimed and BEFORE preflight, so
   * preflight sees the bundle that will actually be spawned; `preSpawn` runs
   * after preflight, immediately before the spawn. Either refusing stops the
   * start with the step's own output attached.
   */
  readonly prepare?: () => PrepareRunner;
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
  /** The MANAGER process id recorded in the start lock. Defaults to
   *  `process.pid`; injected in tests so two "managers" can race. */
  readonly ownerPid?: number;
};

export type HarnessSupervisor = {
  snapshot(): SupervisorSnapshot;
  /**
   * The live supervised child, or undefined when this supervisor holds no
   * pid. A pure read — it never signals, never adopts, never writes.
   *
   * This is the enumeration manager shutdown needs: a snapshot says what
   * STATE a harness is in, but shutdown has to decide a FATE, and that turns
   * on facts the snapshot does not carry — whether the child is detached,
   * and whether a runfile makes it re-adoptable by the next manager. Without
   * it the only honest shutdown was to print what survived and hope.
   */
  liveChild(): SupervisedChild | undefined;
  start(options?: GateOptions): Promise<StartResult>;
  stop(options?: { readonly graceMs?: number }): Promise<StopResult>;
  restart(options?: GateOptions): Promise<StartResult>;
  /** Graceful intake-stop: the caller performs the control.v1 `drain` call;
   *  this only drives the state and waits for the exit. */
  drain(request: () => Promise<void>, timeoutMs?: number): Promise<StopResult>;
  /** Re-attach to a runfile written by a previous manager. */
  adopt(): Promise<"adopted" | "lost" | "none">;
  /**
   * Adopt ONLY when there is a runfile and this supervisor holds no pid —
   * otherwise a cheap `existsSync` and out. Safe (and intended) at the top
   * of every request: adoption at boot alone is not enough, because the
   * other head can start a daemon at any moment afterwards and a supervisor
   * that never noticed will happily spawn a second one.
   */
  adoptIfRunfile(): Promise<"adopted" | "lost" | "none">;
  /**
   * Record that the NEXT exit was asked for by an operator — the exit then
   * classifies as a clean stop and no restart is scheduled. For the drain
   * path, where the daemon exits on its own after a control.v1 call and
   * would otherwise read as a crash-and-restart. Idempotent; consumed by
   * the next exit or cleared by a successful start.
   */
  markOperatorStop(): void;
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
  /** The run kind of the CURRENT run, however it started. `currentPlan` is
   *  undefined for an adopted run — gating the runfile cleanup on it meant a
   *  deliberately stopped daemon left its runfile behind and read back as a
   *  crash on the next boot. */
  let currentKind: RunKind | undefined;
  let currentPorts: SpawnPlan["ports"] | undefined;
  let controlPort: number | undefined;
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
  const ownerPid = options.ownerPid ?? process.pid;

  /** A port of 0 means "kernel, pick one" — not-known-yet, never reachable. */
  const knownPort = (port: number | undefined): number | undefined =>
    port !== undefined && Number.isInteger(port) && port > 0 ? port : undefined;

  const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

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
    ...(currentPorts !== undefined ? { ports: currentPorts } : {}),
    ...(controlPort !== undefined ? { controlPort } : {}),
  });

  /**
   * Describe the live child for shutdown planning.
   *
   * Two fields carry the whole decision:
   *
   *   - `detached` — an ADOPTED run has no plan of ours, but a runfile only
   *     ever describes a detached daemon, so `true` is the fact rather than
   *     a guess.
   *   - `reAdoptable` — a runfile has to still be THERE. A daemon whose
   *     claim was deleted underneath it cannot be found again by anyone, so
   *     leaving it up would orphan it exactly like an mcp-server projection.
   */
  const liveChild = (): SupervisedChild | undefined => {
    if (pid === undefined || currentKind === undefined) return undefined;
    return {
      harnessDir: options.harnessDir,
      target: options.target,
      state,
      kind: currentKind,
      ...(runId !== undefined ? { runId } : {}),
      pid,
      adopted,
      detached: currentPlan?.detached ?? true,
      reAdoptable: currentKind === "daemon" && runfileExists(options.harnessDir),
    };
  };

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

  /**
   * Learn the control.v1 port from the daemon's own boot announcement and
   * write it into the runfile.
   *
   * The plan asks for `CREWHAUS_CONTROL_PORT=0`, so the port is chosen by
   * the kernel and announced on stdout — this line is the ONLY place it
   * exists. Capturing it here rather than in the console is what makes
   * `crewhaus daemon wake/drain` work against a daemon the shell started:
   * whoever pumps the log records the port, and every other head reads it
   * back out of the runfile.
   */
  const noteControlAnnouncement = (prose: string): void => {
    if (prose === "") return;
    const port = parseAnnouncedControlPort(prose);
    if (port === undefined || port === controlPort) return;
    controlPort = port;
    const runfile = readRunfile(options.harnessDir);
    if (runfile === undefined || runfile.controlPort === port) return;
    try {
      writeRunfile(options.harnessDir, { ...runfile, controlPort: port });
    } catch {
      // The port is still in memory, so THIS head can still reach control.v1;
      // a runfile we cannot write is not a reason to fail the run.
    }
  };

  const drainPump = (): void => {
    if (pump === undefined || runId === undefined) return;
    const result = pump.pumpOnce();
    if (result.prose === "" && result.events.length === 0) return;
    noteControlAnnouncement(result.prose);
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

  /**
   * Remove the runfile IF it is still the one this run wrote.
   *
   * Ownership matters: a daemon that loses a start race and dies seconds
   * later must not delete the WINNER's runfile — that would leave a live
   * daemon nothing claims, invisible to `daemon status` and duplicated by
   * the next start.
   */
  const clearOwnRunfile = (endedRunId: string | undefined): void => {
    const existing = readRunfile(options.harnessDir);
    if (existing === undefined) return;
    const ours =
      (endedRunId !== undefined && existing.runId === endedRunId) ||
      (pid !== undefined && existing.pid === pid);
    if (!ours) return;
    clearRunfile(options.harnessDir);
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
    // Cleanup is gated on the run KIND, not on `currentPlan`: an adopted run
    // has no plan of ours, and skipping the cleanup for it left a dead
    // runfile behind after every deliberate stop — which the next boot read
    // back as a crash and stamped `interrupted` over a clean ledger row.
    if (currentKind === "daemon") clearOwnRunfile(endedRunId);
    if (options.ports !== undefined && endedRunId !== undefined) {
      options.ports.releaseRun(endedRunId);
    }
    pid = undefined;
    pump = undefined;
    controlPort = undefined;
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
      // `start()` returns its failures rather than throwing — but this call
      // runs on a TIMER, outside every caller's try/catch, so anything that
      // did escape would land on `unhandledRejection` and take the whole
      // manager down over one harness's bad day.
      // `automatic: true` is what keeps the rolling window intact: a manual
      // start clears it, an auto-restart must not (that would make the
      // 5-in-10-minutes rule unreachable).
      void start({}, { automatic: true })
        .catch((err: unknown) => {
          lastExit = {
            disposition: "crash",
            title: `automatic restart failed: ${toError(err).message}`,
            restartable: false,
            unexpectedClean: false,
          };
          setState("crashed");
        })
        .finally(settleIfIdle);
    }, delay);
  };

  /**
   * Recover the exit code of a run whose death we only inferred (an adopted
   * run, noticed by pid-polling). Three sources, best first:
   *
   *   1. the `run_failed` trace event this manager already saw;
   *   2. the same event in the run's DURABLE `.events.jsonl` — the case that
   *      matters, because a manager that restarted mid-run has an empty
   *      in-memory record while the evidence sits on disk;
   *   3. the ledger row, if some other writer closed it with a code.
   *
   * Returns undefined only when there is genuinely nothing, so the honest
   * "exit code unknown" title is still told when it is true.
   */
  const recoverExitCode = (): { readonly exitCode: number } | undefined => {
    const fromEvent = (event: Record<string, unknown> | undefined): number | undefined => {
      const value = event?.["exitCode"];
      return typeof value === "number" && Number.isInteger(value) ? value : undefined;
    };
    const inMemory = fromEvent(lastRunFailed);
    if (inMemory !== undefined) return { exitCode: inMemory };
    if (runId !== undefined) {
      try {
        const durable = replayRunEvents(runEventsPath(options.harnessDir, runId));
        for (let i = durable.length - 1; i >= 0; i -= 1) {
          const event = durable[i];
          if (event?.["kind"] !== "run_failed") continue;
          const code = fromEvent(event);
          if (code !== undefined) {
            // Keep it for the forensics panel too — this manager never saw
            // the event live, but the operator still wants the remediation.
            if (lastRunFailed === undefined) lastRunFailed = event;
            return { exitCode: code };
          }
        }
      } catch {
        // Unreadable events file — fall through to the ledger.
      }
      const row = readRunLedger(options.harnessDir).find((entry) => entry.runId === runId);
      if (typeof row?.exitCode === "number") return { exitCode: row.exitCode };
    }
    return undefined;
  };

  const onExit = (code: number | null, signal: string | null): void => {
    const wasOperatorStop = operatorStop;
    operatorStop = false;
    // An adopted run has no plan of ours; the target's run class still says
    // whether it is long-running, so supervision survives a manager restart.
    const longRunning = currentPlan?.supervised ?? isSupervisedClass(runClassFor(options.target));
    // An adopted run's death is noticed by pid-polling, so the OS exit code
    // never reaches us. Recovering it is not a nicety: without it a billing
    // (31) or budget (33) exit classifies as a plain crash and gets
    // RESTARTED — restarting the one class of failure a restart cannot fix,
    // and re-arming spend the budget cap just stopped. The daemon told us
    // what happened on its way out; the pump already wrote it down.
    const recovered = code === null && signal === null ? recoverExitCode() : undefined;
    const base = classifyExit({
      exitCode: recovered?.exitCode ?? code,
      signal,
      operatorStop: wasOperatorStop,
      longRunning,
      ...(options.restartUnexpectedCleanExit !== undefined
        ? { restartUnexpectedCleanExit: options.restartUnexpectedCleanExit }
        : {}),
    });
    const classification: ExitClassification =
      adopted && code === null && signal === null && !wasOperatorStop && recovered === undefined
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

  /**
   * Take the cross-process claim on the daemon slot.
   *
   * The runfile is written after the spawn, so it cannot be the lock for the
   * window that matters — the one that spans preflight. `O_EXCL` create is
   * atomic, so exactly one starter wins; an abandoned lock (its manager was
   * killed, or its pid was recycled, or it is simply older than any start
   * can take) is broken and retaken once.
   */
  const claimStartSlot = (): boolean => {
    const observedStart = options.ops.startTimeMs(ownerPid);
    const lock: StartLock = {
      pid: ownerPid,
      ...(observedStart !== undefined ? { pidStartTimeMs: observedStart } : {}),
      at: clock.now(),
    };
    if (acquireStartLock(options.harnessDir, lock)) return true;
    if (!startLockIsStale(readStartLock(options.harnessDir), options.ops, clock.now())) {
      return false;
    }
    releaseStartLock(options.harnessDir);
    return acquireStartLock(options.harnessDir, lock);
  };

  /**
   * Unwind a start that threw AFTER `setState("starting")`.
   *
   * Everything between the spawn and `child.exited.then(onExit)` is a real
   * failure surface on a long-lived manager — EMFILE on the log fd, ENOSPC
   * on the ledger, EACCES on the run dir. Left unhandled it wedged the
   * supervisor in `starting` (which the entry guard reads as
   * "already-running" forever) and, worse, left a SPAWNED child with no exit
   * handler: its exit was never observed and `stop()` awaited an event that
   * could never fire. So: kill the orphan, drop the claim, close the ledger
   * row, and hand the caller a typed failure.
   */
  const abandonStart = (
    id: string,
    child: SpawnedProcess | undefined,
    ledgerOpened: boolean,
    err: unknown,
  ): StartResult => {
    const error = toError(err);
    if (child?.pid !== undefined) {
      try {
        options.ops.forceKill(child.pid);
      } catch {
        // Already gone, or not ours to signal — nothing better to do.
      }
      // Nobody is awaiting this child; make sure its promise cannot reject
      // into the void.
      void child.exited.then(
        () => {},
        () => {},
      );
    }
    stopPump();
    pump = undefined;
    pid = undefined;
    // We still hold the start lock here, so any runfile present is one we
    // just wrote (or a stale one we already verified dead) — never a live
    // daemon's claim.
    if (currentKind === "daemon") clearRunfile(options.harnessDir);
    if (options.ports !== undefined) options.ports.releaseRun(id);
    if (ledgerOpened) {
      patchRunLedger(options.harnessDir, {
        runId: id,
        endedAt: new Date(clock.now()).toISOString(),
        failureClass: "interrupted",
      });
    }
    runId = undefined;
    startedAt = undefined;
    controlPort = undefined;
    lastExit = {
      disposition: "crash",
      title: `could not launch: ${error.message}`,
      restartable: false,
      unexpectedClean: false,
    };
    setState("crashed");
    return { ok: false, reason: "plan-failed", stage: "spawn", error };
  };

  const start = async (
    gateOptions: GateOptions = {},
    internal: { readonly automatic?: boolean } = {},
  ): Promise<StartResult> => {
    if (closed) {
      return {
        ok: false,
        reason: "plan-failed",
        stage: "plan",
        error: new Error("supervisor is closed"),
      };
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
    // …and a MANUAL start clears the rolling window. An operator who reaches
    // for Start after a crash-loop has usually just fixed something; leaving
    // the count at its cap would drop the very next crash straight back into
    // `crash-looping` with no backoff ladder at all. An automatic restart
    // must never reset it — that would make the 5-in-10-minutes rule
    // unreachable.
    if (internal.automatic !== true) window.reset();
    starting = true;
    let heldLock = false;
    try {
      let plan: SpawnPlan;
      try {
        plan = await options.plan();
      } catch (err) {
        return { ok: false, reason: "plan-failed", stage: "plan", error: toError(err) };
      }

      // Claim the slot BEFORE the liveness check and before preflight. The
      // check-then-spawn ordering made the runfile a check rather than a
      // lock: two managers starting the same harness within the same second
      // both read "no runfile", both passed preflight, and both spawned —
      // and the second runfile overwrote the first, orphaning a live channel
      // daemon that nothing could stop and that answered every inbound
      // message twice.
      if (plan.kind === "daemon") {
        if (!claimStartSlot()) {
          return { ok: false, reason: "already-running" };
        }
        heldLock = true;

        // Singleton guard: a verified-live runfile means the daemon is
        // already up, whoever started it. The argv is deliberately NOT part
        // of this check — a daemon started from an older spec is still a
        // running daemon for this harness, and starting a second one is the
        // failure mode the runfile exists to prevent.
        const existing = readRunfile(options.harnessDir);
        const verdict = verifyRunfile(existing, options.ops);
        if (verdict.live && existing !== undefined) {
          return { ok: false, reason: "already-running", runfile: existing };
        }
      }

      // Only now is this plan the current one: a refused start must not arm
      // the cleanup paths with a run it never made.
      currentPlan = plan;
      currentKind = plan.kind;
      currentPorts = plan.ports;

      const prepared: string[] = [];
      const runner = options.prepare?.();
      if (runner !== undefined) {
        // Inside the start slot, so two managers cannot recompile the same
        // bundle at once — a half-written `dist/` is exactly the state a
        // spawn must never meet.
        const outcome = await runner.prepare();
        if (!outcome.ok) {
          setState("stopped");
          return { ok: false, reason: "prepare-refused", refusal: outcome.refusal };
        }
        prepared.push(...outcome.notes);
        if (outcome.replan) {
          // The bundle moved. Re-resolve it, or the spawn launches the entry
          // that was resolved BEFORE the compile — the silent staleness the
          // recompile was asked for to prevent, one level down.
          try {
            plan = await options.plan();
          } catch (err) {
            return { ok: false, reason: "plan-failed", stage: "plan", error: toError(err) };
          }
          currentPlan = plan;
          currentKind = plan.kind;
          currentPorts = plan.ports;
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

      if (runner !== undefined) {
        // LAST. Everything the operator's own step depends on — the fresh
        // bundle, a passed preflight — is true by now, and nothing else
        // happens between this and the spawn.
        const outcome = await runner.preSpawn();
        if (!outcome.ok) {
          setState("stopped");
          return { ok: false, reason: "prepare-refused", refusal: outcome.refusal };
        }
        prepared.push(...outcome.notes);
      }

      // Mint BEFORE announcing `starting`: the entry guard treats that state
      // as "already-running", so a state we enter must always be a state we
      // can leave.
      const id = mintRunId();
      setState("starting");
      runId = id;
      sessionId = undefined;
      lastRunFailed = undefined;
      adopted = false;
      controlPort = knownPort(plan.ports.controlPort);
      // Everything from here to the exit handler can fail on a machine that
      // is out of fds, out of disk, or has had its run dir chmodded — and a
      // throw here used to escape as an unhandled rejection.
      let child: SpawnedProcess | undefined;
      let ledgerOpened = false;
      try {
        ensureRunDir(options.harnessDir);
        const logFile = runLogPath(options.harnessDir, id);
        // Touch the log so the pump has a file to stat from the first tick,
        // and so an fd-redirected child appends rather than creates.
        appendFileSync(logFile, "", { mode: 0o600 });

        child = options.ops.spawn({
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
        ledgerOpened = true;

        if (plan.kind === "daemon") {
          const observedStart = pid !== undefined ? options.ops.startTimeMs(pid) : undefined;
          writeRunfile(options.harnessDir, {
            v: RUNFILE_VERSION,
            pid: pid ?? 0,
            pidStartTimeMs: observedStart ?? clock.now(),
            argvFingerprint: argvFingerprint(plan.cwd, plan.argv),
            ...(plan.ports.port !== undefined ? { port: plan.ports.port } : {}),
            ...(plan.ports.gatewayPort !== undefined
              ? { gatewayPort: plan.ports.gatewayPort }
              : {}),
            ...(plan.ports.controlPort !== undefined
              ? { controlPort: plan.ports.controlPort }
              : {}),
            ...(plan.controlTokenPath !== undefined
              ? { controlTokenPath: plan.controlTokenPath }
              : {}),
            entry: plan.entry,
            bundleDir: plan.bundleDir,
            runId: id,
            startedAt,
            managerVersion,
            // Names only — so a manager that adopts this daemon later can
            // rebuild the same scrubber instead of seeing only the harness
            // `.env` chain and writing process-env secrets to disk in
            // cleartext.
            scrubKeys: scrubbableEnvKeys(plan.env),
          });
        }
        if (options.ports !== undefined) {
          for (const claim of runfilePortClaims(plan.cwd, {
            runId: id,
            ...(plan.ports.port !== undefined ? { port: plan.ports.port } : {}),
            ...(plan.ports.gatewayPort !== undefined
              ? { gatewayPort: plan.ports.gatewayPort }
              : {}),
            ...(plan.ports.controlPort !== undefined
              ? { controlPort: plan.ports.controlPort }
              : {}),
          })) {
            options.ports.claim(claim);
          }
        }

        startPump(id, plan.env);
        if (plan.detached) child.unref?.();
        // Attached runs tee their pipes into the SAME log file the pump
        // reads, so both modes share one extraction and one scrubbing path.
        if (plan.stdio === "pipe") {
          void teePipe(child.stdout, logFile);
          void teePipe(child.stderr, logFile);
        }
        void child.exited.then(({ code, signal }) => onExit(code, signal));
        // A run that started supersedes any armed operator-stop: the mark is
        // for the exit of the run it was made against, not the next one.
        operatorStop = false;
        setState("running");
        return {
          ok: true,
          runId: id,
          pid,
          ...(prepared.length > 0 ? { prepared } : {}),
        };
      } catch (err) {
        return abandonStart(id, child, ledgerOpened, err);
      }
    } finally {
      // The claim is released on EVERY path out — refusal, preflight block,
      // spawn failure, success (the runfile is the claim from here on).
      if (heldLock) releaseStartLock(options.harnessDir);
      starting = false;
      settleIfIdle();
    }
  };

  const stop = async (stopOptions: { graceMs?: number } = {}): Promise<StopResult> => {
    // An operator stop always cancels a scheduled auto-restart — otherwise
    // the backoff timer would resurrect the daemon after the stop.
    cancelPendingRestart();
    if (pid === undefined) {
      // We hold no pid — but that does NOT mean nothing is running. The
      // other head (`crewhaus daemon start`) may have started the daemon
      // after this manager booted, and a supervisor that never adopted it
      // has no pid for it. Deleting that live daemon's runfile and reporting
      // `stopped: true` is exactly how a Restart click ended up with two
      // channel daemons on the same credentials: the lock was gone, so the
      // start that followed sailed through the singleton guard.
      const existing = readRunfile(options.harnessDir);
      if (existing !== undefined) {
        if (verifyRunfile(existing, options.ops).live) {
          return { stopped: false, forced: false, reason: "not-adopted", runfile: existing };
        }
        // Verified dead: clearing it is what keeps a ghost from refusing the
        // next start.
        clearRunfile(options.harnessDir);
      }
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

  const adopt = async (): Promise<"adopted" | "lost" | "none"> => {
    // Rebuild the spawning manager's scrubber BEFORE the pump exists, or the
    // first drained bytes go out under the weaker `.env`-only default. The
    // runfile carries the NAMES it scrubbed against; resolving them here
    // against our own environment restores the strength a spawned run has.
    // Without this, a secret held in `process.env` rather than the harness
    // `.env` stopped being scrubbed the moment a manager restarted — and the
    // pump wrote it in cleartext into the durable events file.
    if (options.scrub === undefined) {
      const runfile = readRunfile(options.harnessDir);
      const keys = runfile?.scrubKeys ?? [];
      if (keys.length > 0) {
        const base: Record<string, string | undefined> = {
          ...loadEnvChain(options.harnessDir).vars,
        };
        for (const key of keys) {
          const value = process.env[key];
          if (typeof value === "string" && base[key] === undefined) base[key] = value;
        }
        scrub = createEnvScrubber(base);
      }
    }
    const result = adoptRunning(options.harnessDir, {
      ops: options.ops,
      scrub,
      now: clock.now,
    });
    if (result.status === "none") {
      // No live runfile — but the harness's own ledger outlives this
      // process, and it is the only record of how the last run ended. A
      // manager restart must not blank the fleet's failure board, so fold
      // the newest CLOSED ledger entry into `lastExit`, flagged as
      // ledger-derived so callers never imply we watched it happen.
      if (lastExit === undefined) {
        const [last] = recentRuns(options.harnessDir, 1);
        // A closed row needs an ending, but NOT necessarily an exit code: the
        // stale-runfile path closes a run with `failureClass: "interrupted"`
        // and no code at all — which is precisely the case this fold exists
        // for. Requiring a code left the failure board blank exactly when a
        // manager had died mid-run.
        if (last !== undefined && last.endedAt !== undefined) {
          if (last.exitCode !== undefined) {
            lastExit = {
              ...classifyExit({
                exitCode: last.exitCode,
                // We were not running when it ended, so we cannot claim the
                // stop was ours; `longRunning` follows the run's kind.
                operatorStop: false,
                longRunning: last.kind === "daemon",
              }),
              fromLedger: true,
              endedAt: last.endedAt,
            };
          } else if (last.failureClass !== undefined) {
            // Never restartable: we did not watch this end and have no code
            // to judge it by, so the operator decides. `failureClass` is left
            // unset — the ledger's marker (`interrupted`) is ours, not one of
            // the provider classes `ExitClassification.failureClass` names.
            lastExit = {
              disposition: "crash",
              title:
                last.failureClass === "interrupted"
                  ? "interrupted — the manager was not running when it ended"
                  : `ended as ${last.failureClass}`,
              restartable: false,
              unexpectedClean: false,
              fromLedger: true,
              endedAt: last.endedAt,
            };
          }
        }
      }
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
    // A runfile only ever describes a daemon-kind run, so this IS the run
    // kind — and recording it is what makes a clean stop of an adopted run
    // clear the runfile instead of leaving a corpse for the next boot to
    // misread as a crash.
    currentKind = "daemon";
    currentPorts = {
      ...(result.runfile.port !== undefined ? { port: result.runfile.port } : {}),
      ...(result.runfile.gatewayPort !== undefined
        ? { gatewayPort: result.runfile.gatewayPort }
        : {}),
      ...(result.runfile.controlPort !== undefined
        ? { controlPort: result.runfile.controlPort }
        : {}),
    };
    controlPort = knownPort(result.runfile.controlPort);
    if (options.ports !== undefined) {
      options.ports.adopt(runfilePortClaims(options.harnessDir, result.runfile));
    }
    schedulePump();
    setState("running");
    return "adopted";
  };

  const adoptIfRunfile = async (): Promise<"adopted" | "lost" | "none"> => {
    // Cheap enough to sit at the top of every request: one `existsSync` in
    // the common case.
    if (closed || starting || pid !== undefined) return "none";
    if (!runfileExists(options.harnessDir)) return "none";
    return adopt();
  };

  return {
    snapshot,
    liveChild,
    start,
    stop,
    markOperatorStop: () => {
      operatorStop = true;
    },
    restart: async (gateOptions) => {
      // Adopt first: the daemon may have been started by the other head, and
      // "stop" without a pid is a no-op that used to delete a LIVE daemon's
      // runfile and spawn a duplicate beside it.
      await adoptIfRunfile();
      await stop();
      return start(gateOptions);
    },
    drain: async (request, timeoutMs) => {
      if (pid === undefined) {
        const existing = readRunfile(options.harnessDir);
        if (existing !== undefined && verifyRunfile(existing, options.ops).live) {
          return { stopped: false, forced: false, reason: "not-adopted", runfile: existing };
        }
        return { stopped: true, forced: false };
      }
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
    adopt,
    adoptIfRunfile,
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

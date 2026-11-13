/**
 * The core's own runtime: daemon control. Each executor acts through the supervisor's verbs
 * with their default options (preflight runs, nothing is forced), adopting a daemon this
 * process did not start before it signals one, as `crewhaus daemon stop` does. One
 * reconciler serves start and restart, the two kinds that are not safe to repeat blindly.
 *
 * Activation's reconciler reads the deployment records, and the decision service's kinds
 * observe their own records (`./decision-runtime`). The operator record and run creation
 * get theirs with their writers. One run sweep closes a channel message whose daemon died
 * before its turn started ({@link channelRunSweep}).
 */
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  type LedgerRecord,
  newestRunRows,
  runsLedger,
  settleUnstartedRun,
} from "@crewhaus/control-records";
import {
  START_TIME_TOLERANCE_MS,
  type StartResult,
  type StopResult,
  readRunfile,
} from "@crewhaus/harness-supervisor";
import { DECISION_EXECUTORS, DECISION_RECONCILERS } from "./decision-runtime";
import { protectedEnvironmentGate, reconcileActivation } from "./deployments";
import {
  type AreaRuntime,
  type Executor,
  type ReconcileContext,
  type Reconciliation,
  type RunSweep,
  type Settlement,
  executorDead,
} from "./executor";
import { NEEDS_DECISION, outcomeOf } from "./refusal";

/** A restart refused before it stopped anything: the daemon it would replace still runs. */
const KEPT_RUNNING = { kind: "daemon", status: "skipped", note: "kept running" } as const;

/** A start or restart's answer, as a settlement. */
export function settleStart(result: StartResult): Settlement {
  if (result.ok) {
    return {
      state: "succeeded",
      effects: [{ kind: "daemon", status: "done", observed: "started" }],
    };
  }
  if (result.kept === true) {
    return {
      state: "rejected",
      effects: [KEPT_RUNNING],
      outcome: outcomeOf(result.reason === "already-running" ? "conflict" : "precondition_failed"),
    };
  }
  switch (result.reason) {
    case "already-running":
      return { state: "rejected", outcome: outcomeOf("conflict") };
    case "preflight-blocked":
    case "prepare-refused":
    case "build-not-active":
      return { state: "rejected", outcome: outcomeOf("precondition_failed") };
    case "plan-failed":
      return {
        state: "failed",
        effects: [{ kind: "daemon", status: "failed" }],
        outcome: outcomeOf("precondition_failed"),
      };
  }
}

/** A stop or drain's answer, as a settlement. */
export function settleStop(result: StopResult): Settlement {
  if (result.stopped) {
    return {
      state: "succeeded",
      effects: [{ kind: "daemon", status: "done", observed: "stopped" }],
    };
  }
  if (result.reason === "not-adopted") {
    return {
      state: "failed",
      effects: [{ kind: "daemon", status: "failed", note: "not adopted; nothing was signalled" }],
      outcome: outcomeOf("conflict"),
    };
  }
  return {
    state: "succeeded",
    effects: [{ kind: "daemon", status: "skipped", note: "not running" }],
  };
}

/** A daemon command with no supervisor lent: never run. */
const NO_SUPERVISOR: Settlement = { state: "failed", outcome: outcomeOf("unavailable") };

const start: Executor = async ({ supervisor }) => {
  if (supervisor === undefined) return NO_SUPERVISOR;
  await supervisor.adoptIfRunfile();
  return settleStart(await supervisor.start());
};

const restart: Executor = async ({ supervisor }) => {
  if (supervisor === undefined) return NO_SUPERVISOR;
  await supervisor.adoptIfRunfile();
  return settleStart(await supervisor.restart());
};

const stop: Executor = async ({ supervisor }) => {
  if (supervisor === undefined) return NO_SUPERVISOR;
  await supervisor.adoptIfRunfile();
  return settleStop(await supervisor.stop());
};

const drain: Executor = async ({ supervisor, drainRequest }) => {
  if (supervisor === undefined) return NO_SUPERVISOR;
  await supervisor.adoptIfRunfile();
  return settleStop(await supervisor.drain(drainRequest));
};

/**
 * Did a start or restart happen? A live runfile whose daemon started after the command was
 * accepted is `done`; no runfile, or a recorded daemon that is gone or whose pid now names
 * another process, is `not-done`; anything else, including a probe that cannot answer and
 * a daemon that started before the command, is `unknown`.
 */
export function reconcileDaemonStart(
  receipt: CommandReceipt,
  ctx: ReconcileContext,
): Reconciliation {
  const runfile = readRunfile(ctx.harnessDir);
  if (runfile === undefined) return "not-done";
  const alive = ctx.probe.isAlive(runfile.pid);
  if (alive === false) return "not-done";
  if (alive === undefined) return "unknown";
  const observed = ctx.probe.startTimeMs(runfile.pid);
  if (observed === undefined) return "unknown";
  if (Math.abs(observed - runfile.pidStartTimeMs) > START_TIME_TOLERANCE_MS) return "not-done";
  const acceptedAt = Date.parse(receipt.acceptedAt);
  if (!Number.isFinite(acceptedAt)) return "unknown";
  return runfile.pidStartTimeMs >= acceptedAt ? "done" : "unknown";
}

/**
 * An activation run again by recovery. A person's activation names its environment and
 * autostart, and a receipt keeps no argument, so recovery cannot repeat it as asked: once
 * the reconciler finds the deployment still prepared, the command is left for a person.
 */
const activate: Executor = async () => ({ state: "unknown", outcome: NEEDS_DECISION });

/** A holder as a run row records it, when the row has one that names a process. */
function holderOf(
  row: LedgerRecord,
): { pid: number; host: string; startedAt?: string } | undefined {
  const holder = row["holder"];
  if (typeof holder !== "object" || holder === null) return undefined;
  const { pid, host, startedAt } = holder as Record<string, unknown>;
  if (typeof pid !== "number" || typeof host !== "string") return undefined;
  return { pid, host, ...(typeof startedAt === "string" ? { startedAt } : {}) };
}

/**
 * A chat message a channel daemon accepted and whose turn never started: the run's newest
 * row, among the ledger's newest 256 lines, is `preparing`, its trigger is `channel`, and
 * the process that held it is provably gone (by the lease's rule, or because it started
 * before the machine booted). It is closed `interrupted {reason: "not-processed", by:
 * "sys:reconcile"}`, under the ledger's lock with the row read again. A holder that is
 * alive, or that the probe cannot judge, is left; so is a run the runtime has started.
 */
export const channelRunSweep: RunSweep = async (harnessDir, ctx) => {
  const ledger = runsLedger(harnessDir);
  const left = (row: LedgerRecord): boolean => {
    if (row["state"] !== "preparing") return false;
    const trigger = row["trigger"];
    if (typeof trigger !== "object" || trigger === null) return false;
    if ((trigger as Record<string, unknown>)["kind"] !== "channel") return false;
    const holder = holderOf(row);
    return holder !== undefined && executorDead(holder, ctx.probe, ctx.host, ctx.hostBootedAt);
  };
  const at = new Date(ctx.now).toISOString();
  let closed = 0;
  for (const [id, row] of newestRunRows(ledger)) {
    if (!left(row)) continue;
    const settled = await settleUnstartedRun(
      ledger,
      id,
      { state: "interrupted", at, fields: { reason: "not-processed", by: "sys:reconcile" } },
      left,
    );
    if (!settled.ok) throw new Error(settled.reason);
    if (settled.settled) closed += 1;
  }
  return closed;
};

export const CORE_RUNTIME: AreaRuntime = {
  area: "core",
  executors: {
    "controls.start": start,
    "controls.stop": stop,
    "controls.restart": restart,
    "controls.drain": drain,
    "deployments.activate": activate,
    ...DECISION_EXECUTORS,
  },
  reconcilers: {
    "controls.start": reconcileDaemonStart,
    "controls.restart": reconcileDaemonStart,
    "deployments.activate": (receipt, ctx) => reconcileActivation(receipt, ctx),
    ...DECISION_RECONCILERS,
  },
  unsupervised: Object.keys(DECISION_EXECUTORS),
  activationGates: [protectedEnvironmentGate],
  runSweeps: [channelRunSweep],
};

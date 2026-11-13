/**
 * The core's own runtime: daemon control. Each executor acts through the supervisor's verbs
 * with their default options (preflight runs, nothing is forced), adopting a daemon this
 * process did not start before it signals one, as `crewhaus daemon stop` does. One
 * reconciler serves start and restart, the two kinds that are not safe to repeat blindly.
 *
 * Activation's reconciler reads the deployment records, and the decision service's kinds
 * observe their own records (`./decision-runtime`). The operator record and run creation
 * get theirs with their writers.
 */
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  START_TIME_TOLERANCE_MS,
  type StartResult,
  type StopResult,
  readRunfile,
} from "@crewhaus/harness-supervisor";
import { DECISION_EXECUTORS, DECISION_RECONCILERS } from "./decision-runtime";
import { protectedEnvironmentGate, reconcileActivation } from "./deployments";
import type {
  AreaRuntime,
  Executor,
  ReconcileContext,
  Reconciliation,
  Settlement,
} from "./executor";
import { NEEDS_DECISION, outcomeOf } from "./refusal";

/** A start or restart's answer, as a settlement. */
export function settleStart(result: StartResult): Settlement {
  if (result.ok) {
    return {
      state: "succeeded",
      effects: [{ kind: "daemon", status: "done", observed: "started" }],
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
};

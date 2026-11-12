/**
 * Executors and reconcilers: the code that performs a command kind's effect, and the code
 * that looks for it afterwards. An executor acts only through the owning library (for a
 * daemon, the supervisor's verbs), and a reconciler answers `unknown` whenever it cannot
 * observe the effect: nothing becomes `succeeded` without an observation.
 */
import type { CommandReceipt, ReceiptEffect, ReceiptExecutor } from "@crewhaus/control-contract";
import { type LeaseProbe, holderProvablyDead } from "@crewhaus/control-records";
import type { HarnessSupervisor } from "@crewhaus/harness-supervisor";
import type { Outcome } from "./refusal";

/**
 * How a command ended, as its executor or inline effect says. `rejected` and `cancelled`
 * apply only to a command that never ran: from `running` each is recorded `failed`.
 */
export type Settlement = {
  readonly state: "succeeded" | "failed" | "unknown" | "rejected" | "cancelled";
  readonly effects?: readonly ReceiptEffect[];
  readonly outcome?: Outcome;
};

export type ExecutorContext = {
  readonly receipt: CommandReceipt;
  readonly harnessDir: string;
  readonly supervisor: HarnessSupervisor;
  /** The control.v1 drain call `supervisor.drain` takes. */
  readonly drainRequest: () => Promise<void>;
  readonly now: () => number;
};

export type Executor = (ctx: ExecutorContext) => Promise<Settlement>;

export type ReconcileContext = {
  readonly harnessDir: string;
  readonly probe: LeaseProbe;
  readonly now: () => number;
};

export type Reconciliation = "done" | "not-done" | "unknown";

export type Reconciler = (
  receipt: CommandReceipt,
  ctx: ReconcileContext,
) => Reconciliation | Promise<Reconciliation>;

/** What an activation gate is shown: the deployment as it would be activated. */
export type ActivationGateContext = {
  readonly harnessDir: string;
  /** The prepared record, with the environment the activation names. */
  readonly deployment: Readonly<Record<string, unknown>>;
  /** The stored actor ref that activates. */
  readonly actor: string;
  readonly now: number;
};

/** A check every activation passes, in composition order. */
export type ActivationGate = {
  readonly name: string;
  check(
    ctx: ActivationGateContext,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly verb?: string }
  >;
};

/** An area's running code for the command kinds it owns. Later slots join this type. */
export type AreaRuntime = {
  /** The area's name, as its module in control-contract declares it. */
  readonly area: string;
  readonly executors?: Readonly<Record<string, Executor>>;
  readonly reconcilers?: Readonly<Record<string, Reconciler>>;
  /** Checks every activation passes; the core's protected-environment gate runs first. */
  readonly activationGates?: readonly ActivationGate[];
};

/** An executor stamp, with `probed: false` when the probe could not say when it started. */
export type ExecutorStamp = ReceiptExecutor & { readonly probed?: false };

/**
 * Whether the process that owned a receipt is gone, by the mutating lease's own rule, or
 * because it started before the machine last booted, whatever its pid answers now.
 * A stamp the probe never confirmed is judged by its pid alone. A receipt with no stamp
 * has no owner.
 */
export function executorDead(
  executor: unknown,
  probe: LeaseProbe,
  host: string,
  hostBootedAt: number,
): boolean {
  if (typeof executor !== "object" || executor === null) return true;
  const stamp = executor as Partial<ExecutorStamp>;
  if (typeof stamp.pid !== "number" || typeof stamp.host !== "string") return true;
  const started = typeof stamp.startedAt === "string" ? Date.parse(stamp.startedAt) : Number.NaN;
  if (stamp.host === host && Number.isFinite(started) && started < hostBootedAt) return true;
  return holderProvablyDead(
    {
      pid: stamp.pid,
      ...(stamp.probed !== false && Number.isFinite(started) ? { startedAtMs: started } : {}),
      host: stamp.host,
    },
    probe,
    host,
  );
}

/**
 * A probe that answers this process's own start time from its own clock and asks `probe`
 * about every other pid. A head stamps its receipts with its own start, and asking an OS
 * probe for it can mean starting a helper program (`powershell` on Windows); the clock's
 * answer is within the 2-second tolerance of what any probe later reads for this pid.
 *
 * First consumers: Home and the CLI's direct mode, for `wireControl`'s `probe`.
 */
export function withOwnStartTime(probe: LeaseProbe, pid: number = process.pid): LeaseProbe {
  const started = Date.now() - process.uptime() * 1000;
  return {
    isAlive: (other) => probe.isAlive(other),
    startTimeMs: (other) => (other === pid ? started : probe.startTimeMs(other)),
  };
}

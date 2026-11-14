/** What every part of the service shares once `wireControl` has resolved its inputs. */
import type { LocalIdentity } from "@crewhaus/access-control";
import type { CommandReceipt } from "@crewhaus/control-contract";
import type { LeaseProbe } from "@crewhaus/control-records";
import type { HarnessSupervisor } from "@crewhaus/harness-supervisor";
import type { Executor, ExecutorStamp, Reconciler } from "./executor";

/**
 * Where the control plane runs: Home in a window (`server`), Home as the installed
 * service (`resident`), or the CLI acting on one harness (`direct`).
 */
export type ControlMode = "server" | "resident" | "direct";

export type ControlCore = {
  readonly mode: ControlMode;
  readonly hangarRoot: string;
  readonly identity: LocalIdentity;
  readonly now: () => number;
  readonly probe: LeaseProbe;
  readonly host: string;
  readonly hostBootedAt: () => number;
  readonly executors: ReadonlyMap<string, Executor>;
  readonly reconcilers: ReadonlyMap<string, Reconciler>;
  /** Kinds dispatched without a supervisor: their executors act on records alone. */
  readonly unsupervised: ReadonlySet<string>;
  readonly harnessDirOf: (hrn: string) => string | undefined;
  readonly harnessDirs: () => readonly string[];
  readonly supervisorFor: (harnessDir: string) => HarnessSupervisor | undefined;
  readonly releaseSupervisor: (harnessDir: string, supervisor: HarnessSupervisor) => void;
  readonly drainRequest: (harnessDir: string) => () => Promise<void>;
  readonly warn: (message: string) => void;
  /** Whether a receipt's actor has lost the authority to do what it asked: checked before it runs. */
  actorRefused(receipt: CommandReceipt): boolean;
  /** This process, as a receipt's executor. Stamped once. */
  selfExecutor(): ExecutorStamp;
};

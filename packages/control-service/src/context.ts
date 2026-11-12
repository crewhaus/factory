/** What every part of the service shares once `wireControl` has resolved its inputs. */
import type { LocalIdentity } from "@crewhaus/access-control";
import type { LeaseProbe } from "@crewhaus/control-records";
import type { HarnessSupervisor } from "@crewhaus/harness-supervisor";
import type { Executor, ExecutorStamp, Reconciler } from "./executor";

export type ControlMode = "server" | "direct";

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
  readonly harnessDirOf: (hrn: string) => string | undefined;
  readonly harnessDirs: () => readonly string[];
  readonly supervisorFor: (harnessDir: string) => HarnessSupervisor | undefined;
  readonly releaseSupervisor: (harnessDir: string, supervisor: HarnessSupervisor) => void;
  readonly drainRequest: (harnessDir: string) => () => Promise<void>;
  readonly warn: (message: string) => void;
  /** This process, as a receipt's executor. Stamped once. */
  selfExecutor(): ExecutorStamp;
};

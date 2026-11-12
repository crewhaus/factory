/**
 * `wireControl(deps, {mode, areas})`: the control plane's composition root. One call
 * builds what a head needs: the commands, the job adapter and recovery. A mode changes
 * where calls land and what runs in the background, never what a call does, so a CLI verb
 * and the matching Home control write the same receipt to the same ledger.
 *
 * | Mode | Head | What it adds |
 * |---|---|---|
 * | `server` | Home | recovery over every registered harness and Home's own ledger, at boot |
 * | `direct` | the CLI | recovery of the one harness a verb acts on, before its first change |
 */
import { hostname, uptime } from "node:os";
import { type LocalIdentity, loadAccessSnapshot } from "@crewhaus/access-control";
import { COMMAND_KINDS, type CommandReceipt, isId } from "@crewhaus/control-contract";
import type { LeaseProbe } from "@crewhaus/control-records";
import type { HarnessSupervisor } from "@crewhaus/harness-supervisor";
import { AREA_RUNTIMES, compositionProblems } from "./areas";
import { type Commands, createCommands } from "./commands";
import type { ControlCore, ControlMode } from "./context";
import type { AreaRuntime, Executor, ExecutorStamp, Reconciler } from "./executor";
import { type JobAdapter, createJobAdapter } from "./jobs";
import { type LedgerChoice, commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import { type RecoverCounts, type RecoverScope, createRecover } from "./recover";

export type ControlDeps = {
  /** Home's root: its own command ledger and the access records. */
  readonly hangarRoot: string;
  /** The live directory of a registered harness. */
  readonly harnessDirOf?: (hrn: string) => string | undefined;
  /** Every registered harness's live directory, for Home's recovery. The CLI has none. */
  readonly harnessDirs?: () => readonly string[];
  /** The supervisor an executor acts through. Home lends its own; the CLI builds one. */
  readonly supervisorFor: (harnessDir: string) => HarnessSupervisor | undefined;
  /** Called after an executor is done with a supervisor (the CLI closes the one it built). */
  readonly releaseSupervisor?: (harnessDir: string, supervisor: HarnessSupervisor) => void;
  /** The control.v1 drain call a drain executor hands `supervisor.drain`. */
  readonly drainRequest: (harnessDir: string) => () => Promise<void>;
  /** The local OS user this head acts as. */
  readonly identity: LocalIdentity;
  readonly now?: () => number;
  /** Judges executors and daemons: the head's own `ProcessOps`. */
  readonly probe: LeaseProbe;
  /** When the machine last booted, epoch ms. */
  readonly hostBootedAt?: () => number;
  readonly pid?: number;
  readonly host?: string;
  readonly head?: "server" | "cli";
  readonly onWarn?: (message: string) => void;
  /**
   * Whether `actor` (a `prn_…`) still holds `permission` on what `target` (a ref) names:
   * `true`, `false`, or `undefined` when it could not be determined. Home passes one over
   * `authorize()` and a fresh access snapshot; without one, every command runs as accepted.
   */
  readonly authorizeActor?: (
    actor: string,
    permission: string,
    target: string,
  ) => boolean | undefined;
};

export type ControlService = {
  readonly mode: ControlMode;
  readonly commands: Commands & {
    recover(scope: RecoverScope): Promise<RecoverCounts>;
  };
  readonly jobs: JobAdapter;
  readonly ledgers: {
    harness(harnessDir: string): ReturnType<typeof commandsLedgerOf>;
    workspace(): ReturnType<typeof workspaceCommandsLedger>;
    of(choice: LedgerChoice): ReturnType<typeof commandsLedgerOf>;
  };
};

export type WireOptions = {
  readonly mode: ControlMode;
  readonly areas?: readonly AreaRuntime[];
};

export function wireControl(deps: ControlDeps, options: WireOptions): ControlService {
  const areas = options.areas ?? AREA_RUNTIMES;
  const problems = compositionProblems(areas);
  if (problems.length > 0) {
    throw new Error(
      `control-service: the area composition is refused:\n  ${problems.join("\n  ")}`,
    );
  }
  const executors = new Map<string, Executor>();
  const reconcilers = new Map<string, Reconciler>();
  for (const area of areas) {
    for (const [kind, run] of Object.entries(area.executors ?? {})) executors.set(kind, run);
    for (const [kind, check] of Object.entries(area.reconcilers ?? {}))
      reconcilers.set(kind, check);
  }

  const now = deps.now ?? (() => Date.now());
  const warn = deps.onWarn ?? ((message: string) => console.warn(message));
  let warnedUndetermined = false;
  /**
   * A queued or recovered command's actor, checked again before it runs. A system actor, an
   * unlinked local user and the Home's owner pass; a member whose authority is gone does not.
   * An answer that could not be determined runs the command, with one warning.
   */
  const actorRefused = (receipt: CommandReceipt): boolean => {
    const authorizeActor = deps.authorizeActor;
    if (authorizeActor === undefined || !isId("prn", receipt.actor)) return false;
    const permission = (COMMAND_KINDS as Readonly<Record<string, { permission: string }>>)[
      receipt.kind
    ]?.permission;
    if (permission === undefined || permission === "public") return false;
    const read = loadAccessSnapshot(deps.hangarRoot);
    if (read.state === "present" && read.snapshot.owner === receipt.actor) return false;
    let answer: boolean | undefined;
    try {
      answer = authorizeActor(receipt.actor, permission, receipt.target);
    } catch {
      answer = undefined;
    }
    if (answer === undefined) {
      if (!warnedUndetermined) {
        warnedUndetermined = true;
        warn(
          "control-service: whether a queued command's actor may still run it could not be determined; it runs as accepted",
        );
      }
      return false;
    }
    return answer === false;
  };
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? hostname();
  const head = deps.head ?? (options.mode === "server" ? "server" : "cli");
  let self: ExecutorStamp | undefined;

  const core: ControlCore = {
    mode: options.mode,
    hangarRoot: deps.hangarRoot,
    identity: deps.identity,
    now,
    probe: deps.probe,
    host,
    hostBootedAt: deps.hostBootedAt ?? (() => Date.now() - uptime() * 1000),
    executors,
    reconcilers,
    harnessDirOf: deps.harnessDirOf ?? (() => undefined),
    harnessDirs: deps.harnessDirs ?? (() => []),
    supervisorFor: deps.supervisorFor,
    releaseSupervisor: deps.releaseSupervisor ?? (() => undefined),
    drainRequest: deps.drainRequest,
    warn,
    actorRefused,
    selfExecutor: () => {
      if (self !== undefined) return self;
      // Asked once: a start time does not change, and on some systems the probe is slow.
      const started = deps.probe.startTimeMs(pid);
      self =
        started !== undefined
          ? { pid, startedAt: new Date(started).toISOString(), host, head }
          : {
              pid,
              startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
              host,
              head,
              probed: false,
            };
      return self;
    },
  };

  const commands = createCommands(core);
  const jobs = createJobAdapter(core, commands);
  const recover = createRecover(core, commands, jobs);
  return {
    mode: options.mode,
    commands: { submit: commands.submit, get: commands.get, recover },
    jobs,
    ledgers: {
      harness: commandsLedgerOf,
      workspace: () => workspaceCommandsLedger(deps.hangarRoot),
      of: (choice) => commands.ledgerOf(choice),
    },
  };
}

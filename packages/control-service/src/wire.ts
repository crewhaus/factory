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
 *
 * Both modes get the same decision service (`decisions`, `rules`): a decision from Home
 * and one from the CLI are made by the same code against the same records.
 */
import { hostname, uptime } from "node:os";
import { type LocalIdentity, loadAccessSnapshot } from "@crewhaus/access-control";
import {
  COMMAND_KINDS,
  type CommandReceipt,
  type CursorPosition,
  MACHINES,
  isId,
} from "@crewhaus/control-contract";
import type { LeaseProbe } from "@crewhaus/control-records";
import type { HarnessSupervisor } from "@crewhaus/harness-supervisor";
import { AREA_RUNTIMES, compositionProblems } from "./areas";
import { type Commands, createCommands, receiptOf } from "./commands";
import type { ControlCore, ControlMode } from "./context";
import { type Decisions, createDecisions } from "./decisions";
import type { AreaRuntime, Executor, ExecutorStamp, Reconciler } from "./executor";
import { type JobAdapter, createJobAdapter } from "./jobs";
import { type LedgerChoice, commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import { type ObjectPage, pageObjects } from "./pages";
import { type RecoverCounts, type RecoverScope, createRecover } from "./recover";
import { type Rules, createRules } from "./rules";

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
   * Whether `actor` (a `prn_…`) still holds `permission` on what `target` (a ref) names,
   * through exactly `credentialRef` (a `crd_…`) when the receipt names one: `true`, `false`,
   * or `undefined` when it could not be determined. Home passes one over a fresh access
   * snapshot; without one, a command whose receipt names a credential does not run, and
   * recovery leaves such a receipt for a head that has one.
   */
  readonly authorizeActor?: (
    actor: string,
    permission: string,
    target: string,
    credentialRef?: string,
  ) => boolean | undefined;
};

export type ControlService = {
  readonly mode: ControlMode;
  /** One way a decision is made, from every surface. */
  readonly decisions: Decisions;
  /** The standing rules a head lists and ends. */
  readonly rules: Rules;
  readonly commands: Commands & {
    recover(scope: RecoverScope): Promise<RecoverCounts>;
    /** One page of a ledger's receipts, newest first, each at its current state. A read. */
    list(
      choice: LedgerChoice,
      options: { readonly limit: number; readonly before?: CursorPosition },
    ): ObjectPage<CommandReceipt>;
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
  const unsupervised = new Set<string>();
  for (const area of areas) {
    for (const [kind, run] of Object.entries(area.executors ?? {})) executors.set(kind, run);
    for (const [kind, check] of Object.entries(area.reconcilers ?? {}))
      reconcilers.set(kind, check);
    for (const kind of area.unsupervised ?? []) unsupervised.add(kind);
  }

  const now = deps.now ?? (() => Date.now());
  const warn = deps.onWarn ?? ((message: string) => console.warn(message));
  let warnedUndetermined = false;
  /**
   * A command dispatched from its receipt, when it is submitted or recovered, runs only
   * while the credential that submitted it, or for a receipt without one its actor, may
   * still do it. A system actor and an unlinked local user
   * pass, and so does the Home's owner on a receipt that names no credential; a receipt that
   * names one is checked against it whoever submitted it. An answer that could not be
   * determined runs the command, with one warning. A head with no `authorizeActor` runs no
   * command whose receipt names a credential.
   */
  const actorRefused = (receipt: CommandReceipt): boolean => {
    if (!isId("prn", receipt.actor)) return false;
    const permission = (COMMAND_KINDS as Readonly<Record<string, { permission: string }>>)[
      receipt.kind
    ]?.permission;
    if (permission === undefined || permission === "public" || permission === "authenticated") {
      return false;
    }
    const credentialRef = receipt.credentialRef;
    const authorizeActor = deps.authorizeActor;
    // A head that cannot check a credential does not run a command that names one.
    if (authorizeActor === undefined) return credentialRef !== undefined;
    if (credentialRef === undefined) {
      const read = loadAccessSnapshot(deps.hangarRoot);
      if (read.state === "present" && read.snapshot.owner === receipt.actor) return false;
    }
    let answer: boolean | undefined;
    try {
      answer =
        credentialRef === undefined
          ? authorizeActor(receipt.actor, permission, receipt.target)
          : authorizeActor(receipt.actor, permission, receipt.target, credentialRef);
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
    unsupervised,
    harnessDirOf: deps.harnessDirOf ?? (() => undefined),
    harnessDirs: deps.harnessDirs ?? (() => []),
    supervisorFor: deps.supervisorFor,
    releaseSupervisor: deps.releaseSupervisor ?? (() => undefined),
    drainRequest: deps.drainRequest,
    warn,
    checksActors: deps.authorizeActor !== undefined,
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
  const recover = createRecover(
    core,
    commands,
    jobs,
    areas.flatMap((area) => area.runSweeps ?? []),
  );
  const decisions = createDecisions({ hangarRoot: deps.hangarRoot, identity: deps.identity, now });
  return {
    mode: options.mode,
    decisions,
    rules: createRules(decisions, now),
    commands: {
      submit: commands.submit,
      get: commands.get,
      recover,
      list: (choice, page) =>
        pageObjects(commands.ledgerOf(choice), {
          limit: page.limit,
          ...(page.before !== undefined ? { before: page.before } : {}),
          entry: MACHINES.command.entry,
          view: receiptOf,
        }),
    },
    jobs,
    ledgers: {
      harness: commandsLedgerOf,
      workspace: () => workspaceCommandsLedger(deps.hangarRoot),
      of: (choice) => commands.ledgerOf(choice),
    },
  };
}

/**
 * Executors and reconcilers: the code that performs a command kind's effect, and the code
 * that looks for it afterwards. An executor acts only through the owning library (for a
 * daemon, the supervisor's verbs), and a reconciler answers `unknown` whenever it cannot
 * observe the effect: nothing becomes `succeeded` without an observation.
 */
import type {
  CommandReceipt,
  DelegableDecisionKind,
  DelegationAction,
  DelegationLogLine,
  DelegationScope,
  DelegationSubject,
  DelegationTerms,
  ReceiptEffect,
  ReceiptExecutor,
} from "@crewhaus/control-contract";
import type {
  ConsequenceLine,
  GateId,
  GateVerdict,
  RollbackPlan,
  ScopeFieldCheck,
  SignalId,
  SignalReading,
  Watch,
} from "@crewhaus/control-contract/delegation";
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
  /**
   * The supervisor the head lends for this harness. Absent only for a kind its area
   * declares `unsupervised`: those act on records alone.
   */
  readonly supervisor?: HarnessSupervisor;
  /** The control.v1 drain call `supervisor.drain` takes. */
  readonly drainRequest: () => Promise<void>;
  readonly now: () => number;
  /** The head's probe, for an executor that asks whether a recorded daemon is alive. */
  readonly probe?: LeaseProbe;
};

export type Executor = (ctx: ExecutorContext) => Promise<Settlement>;

export type ReconcileContext = {
  /**
   * The harness's live directory, when it has one. A receipt in Home's own ledger whose
   * harness is gone (a retire's, after the harness was archived) has none: a reconciler
   * that reads a directory then answers `unknown`.
   */
  readonly harnessDir: string | undefined;
  readonly probe: LeaseProbe;
  readonly now: () => number;
  /** Home's root, for a kind whose effect is recorded there (retire's lifecycle line). */
  readonly hangarRoot?: string;
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

/** What a retire shows each revoker: the harness, who retires it, and when. */
export type RetireRevokerContext = {
  readonly harnessDir: string;
  /** The harness's `hrn_` id, when it has one. */
  readonly harnessId?: string;
  /** The stored actor ref that retires it. */
  readonly actor: string;
  readonly now: number;
  /** The retire's receipt, which a revoker's own records name. */
  readonly cmd?: string;
};

/** One thing a revoker will end, as a retire's plan lists it. */
export type RetireItem = {
  readonly kind: string;
  /** `manual`: a person does this by hand, where it was issued. */
  readonly status: "planned" | "manual";
  readonly note?: string;
};

/**
 * What an area ends when a harness is retired: its grants, leases or connections. `plan`
 * reads and changes nothing; `revoke` ends them and answers one receipt effect each.
 */
export type RetireRevoker = {
  readonly name: string;
  /**
   * `true` when this revoker ends channel or service credentials. While none that ran
   * does, a retire still tells the person to revoke those where they were issued.
   */
  readonly connections?: boolean;
  plan(ctx: RetireRevokerContext): Promise<readonly RetireItem[]>;
  revoke(ctx: RetireRevokerContext): Promise<readonly ReceiptEffect[]>;
};

/** What a run sweep is given: the head's probe and clock, and when the machine booted. */
export type RunSweepContext = {
  readonly probe: LeaseProbe;
  readonly host: string;
  readonly hostBootedAt: number;
  readonly now: number;
};

/**
 * A recovery step over one harness's run ledger: it closes the runs a process that died
 * left open where nothing else will, and answers how many it closed. It writes; a read
 * never runs one.
 */
export type RunSweep = (harnessDir: string, ctx: RunSweepContext) => Promise<number>;

/** What a delegated action's code is shown: the harness, and the time. */
export type DelegatedActionContext = {
  readonly harnessDir: string;
  readonly now: number;
};

/** What a gate is asked to check: the exact revision a verdict binds to. */
export type GateContext = DelegatedActionContext & {
  readonly bindTo: string;
};

/**
 * One held-out gate, evaluated by the control plane over evidence the agent cannot write.
 * Fail-closed: only `pass` passes; a gate with no data answers `unknown` or `not-run`.
 */
export type Gate = {
  evaluate(subject: DelegationSubject, ctx: GateContext): Promise<GateVerdict>;
};

/**
 * What one action is narrowed to inside the active ceiling: the scope fields a rule may
 * set, each with its check. Absent (`scopeOf` answers `undefined`): the ceiling does not
 * allow the action at all.
 */
export type DelegatedActionScope = {
  readonly fields: Readonly<Record<string, ScopeFieldCheck>>;
  /** The ceiling's own members for this action, as the action reads them. */
  readonly ceiling: Readonly<Record<string, unknown>>;
};

/**
 * An action a delegation rule may cover: the decision kind it resolves, the gates it
 * requires (never droppable, never read from a rule's terms), how it narrows to a scope,
 * how it undoes itself and what it watches afterwards, and the two command kinds that act
 * (`executeKind`) and undo (`rollbackKind`), whose executors the same composition
 * registers. An area registers one; nothing is delegable until one is.
 */
export type DelegatedAction = {
  readonly action: DelegationAction;
  readonly decisionKind: DelegableDecisionKind;
  readonly gates: Partial<Record<GateId, Gate>>;
  readonly requiredGates: readonly GateId[];
  /** The action's scope inside the active ceiling, or `undefined` when it allows none. */
  scopeOf(ceiling: Readonly<Record<string, unknown>>): DelegatedActionScope | undefined;
  /** Whether a rule's terms, inside the scope, hold this subject. */
  inScope(terms: DelegationTerms, scope: DelegatedActionScope, subject: DelegationSubject): boolean;
  /**
   * The action's one-at-a-time condition, read from the application log. Asked by the
   * pass before a decision is taken, and again at the effect from the log as it is then,
   * when the log also holds this decision's own `planned` and `decided` lines.
   */
  oneAtATime(log: readonly DelegationLogLine[], subject: DelegationSubject): boolean;
  /** How the action would be undone; `undefined` when it cannot be planned. */
  planRollback(
    subject: DelegationSubject,
    ctx: DelegatedActionContext,
  ): Promise<RollbackPlan | undefined>;
  /** The subject's revision now, read where the action reads it; `undefined` when unknown. */
  currentRevision(
    subject: DelegationSubject,
    ctx: DelegatedActionContext,
  ): Promise<string | undefined>;
  /** What a watch's signals say on one read. A signal with no data is `unknown`. */
  signals(watch: Watch, ctx: DelegatedActionContext): Promise<SignalReading>;
  /** The signals a watch reads. */
  readonly signalIds: readonly SignalId[];
  /** How long a watch stays open after the action. */
  watchMs(terms: DelegationTerms, scope: DelegationScope): number;
  /** The host facts the consequences page states, from closed templates. */
  previewTerms(
    scope: DelegatedActionScope,
    ctx: DelegatedActionContext,
  ): Promise<readonly ConsequenceLine[]>;
  readonly executeKind: string;
  readonly rollbackKind: string;
};

/** An area's running code for the command kinds it owns. Later slots join this type. */
export type AreaRuntime = {
  /** The area's name, as its module in control-contract declares it. */
  readonly area: string;
  readonly executors?: Readonly<Record<string, Executor>>;
  readonly reconcilers?: Readonly<Record<string, Reconciler>>;
  /**
   * Kinds whose executor reads and writes records only, never a daemon: they are
   * dispatched without asking the head for a supervisor.
   */
  readonly unsupervised?: readonly string[];
  /** Checks every activation passes; the core's protected-environment gate runs first. */
  readonly activationGates?: readonly ActivationGate[];
  /** What the area ends when a harness is retired, run in composition order. */
  readonly retireRevokers?: readonly RetireRevoker[];
  /** Run once per harness each recovery visits, in composition order. */
  readonly runSweeps?: readonly RunSweep[];
  /** The actions a delegation rule may cover, each served by this composition. */
  readonly delegatedActions?: readonly DelegatedAction[];
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

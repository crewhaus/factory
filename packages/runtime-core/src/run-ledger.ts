/**
 * Run rows: every top-level loop appends a few content-free lines to the
 * harness's run ledger, `.crewhaus/run/control/runs/`, when its run starts,
 * when it parks on an approval and when it ends. A row holds ids, a state,
 * what started the run and its cost, never a message.
 *
 * Where and when. The ledger lives under `RunChatLoopOptions.runLedgerDir`
 * when it is a string (`null` writes nothing), else under the harness root
 * the settings load reads when the loop names one, else under the working
 * directory: the harness root, as the settings load reads it. Rows are written only for a loop that persists
 * its session, whose context names no `parent` (a sub-agent's and a side
 * call's context do), outside a tenant context, and while
 * `CREWHAUS_RUN_LEDGER` is not `0`. A failed append never fails or slows the
 * run: the first one logs one warning naming its code, later ones nothing.
 *
 * Lifecycle, per run id in this process:
 *  - `running`, by the first loop that opens (`openRunRows`), with the
 *    session, its byte length before this loop (`sessionAt`), the resume
 *    scope, what started the run, and the root run, work item, parked run,
 *    execution and a keyed digest of the subject (`subjectRef`) when known;
 *  - `waiting-for-approval {decision}` at a park (`recordRunPark`), after
 *    which this process writes nothing more for the run: the park is durable.
 *    A park inside a sub-agent is the top-level run's park: the sub-agent's
 *    context names its parent, and the park is recorded on the run it
 *    descends from;
 *  - a terminal row once the run is idle (its last hold released, see
 *    run-context's `retainRun`): `cancelled` when the context's signal was
 *    aborted by `cancelRun`, whether the loop returned or threw; otherwise
 *    from how the run ended: the outcome a holder said on its release (a
 *    graph or a crew that drives several loops ends the run as it ended
 *    itself), else the last loop's. An `approval_pending` stop, or a holder's
 *    pause, is `waiting-for-approval` when no park row was written yet, and
 *    nothing more when one was; `failed {failureClass, cause?}` for another
 *    classified stop and `failed {failureClass: "unknown"}` for any other
 *    throw; `succeeded` otherwise. A terminal row carries `cost`, where an
 *    unpriced run is never $0, and spend a sub-agent could not price is
 *    counted as unpriced;
 *  - a process that exits while a run is still open (`process.exit` skips
 *    every `finally`, as a second Ctrl-C in the REPL does) ends it in the
 *    exit handler, by the exit code: `0` or `130` (a person ending their
 *    session) is `succeeded`, `36` is `waiting-for-approval`, another code
 *    the exit-code table names is `failed` with its class, and any other is
 *    `failed {failureClass: "unknown"}`.
 *
 * A verified root. A supervisor that starts a one-shot job writes its root
 * run's `queued` and `preparing` rows and hands the child `CREWHAUS_RUN_ID`
 * and `CREWHAUS_EXECUTION_ID`. The value is honoured only when the ledger's
 * newest row for that id, in its newest 256 lines, is `queued` or `preparing`
 * for this execution; then the root's `running` row is written once and every
 * top-level loop names the root as its `parent`. A canonical run id that is not
 * such a root is ignored with one warning, and the loops' rows use their own
 * ids. A value that is not shaped like a run id (a workflow's own durable-resume
 * key, which `target-workflow` documents setting here) is ignored silently.
 *
 * What a grant binds to. A park records the run the ledger marks waiting
 * (`parkingRunIdOf`: the top run, so a park inside a sub-agent binds to the run a
 * resume continues) and the scope that run was opened in (`resumeScopeOf`), and a
 * spend reads both again, with `continuesOf`. They answer the same with the ledger
 * off, from the context alone, which binds a supervised job to its session:
 * stricter, never weaker.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  EXECUTION_RUN_ID_RE,
  type RunCause,
  TRIGGER_KINDS,
  type Trigger,
  formatResumeScope,
  isId,
} from "@crewhaus/control-contract";
import {
  type Ledger,
  append,
  controlPaths,
  readPage,
  runsLedger,
  subjectRefOf,
} from "@crewhaus/control-records";
import { type CostTracker, createCostTracker } from "@crewhaus/cost-tracker";
import { EXIT_CODES, type FailureClass, RunFailedError } from "@crewhaus/errors";
import { DEFAULT_ROOT_DIR } from "@crewhaus/event-log";
import {
  type RunContext,
  type RunHoldOutcome,
  currentSubject,
  isCancelReason,
  onRunIdle,
  retainRun,
} from "@crewhaus/run-context";
import { currentTenantContext } from "@crewhaus/tenancy";
import type { CostAccrualEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

type Logger = RunContext["logger"];

/** The run ledger's directory, relative to the harness root. */
export const RUN_LEDGER_DIR = join(controlPaths(".").controlDir, "runs");

/** The run ledger of the harness at `root`: control-records' `runsLedger`. */
export function runLedgerAt(root: string): Ledger {
  return runsLedger(root);
}

/** How many newest lines the root check reads. A capped read can only refuse. */
const ROOT_PAGE_LINES = 256;
/** How many ended run ids this process remembers, so a reused context writes nothing. */
const CLOSED_RUNS_KEPT = 1024;

/** The options a loop's rows read. `RunChatLoopOptions` satisfies it. */
export type RunRowsLoopOptions = {
  readonly runLedgerDir?: string | null;
  readonly sessionTarget?: string;
  readonly subject?: string;
};

type LoopOutcome = { readonly threw: false } | { readonly threw: true; readonly error: unknown };

type VerifiedRoot = {
  readonly id: string;
  readonly trigger: Trigger;
  readonly execution: string;
  readonly workItem?: string;
};

/** One run this process has opened and not yet ended. */
type OpenRun = {
  readonly runId: string;
  readonly ledger: Ledger;
  readonly ctx: RunContext;
  readonly bus: TraceEventBus;
  readonly trigger: Trigger;
  readonly tracker: CostTracker;
  /** Nested roll-ups (a sub-agent's spend) seen on the bus, by whether they were priced. */
  readonly rollups: { priced: number; unpriced: number };
  readonly stopRollups: () => void;
  /** The scope its `running` row recorded: what a grant parked in it is bound to. */
  readonly resumeScope?: string;
  /** The verified root, work item and execution its `running` row recorded. */
  readonly parent?: string;
  readonly workItem?: string;
  readonly execution?: string;
  parked: boolean;
  last?: LoopOutcome;
};

/** One `runChatLoop` invocation: what it took, so it releases only that. */
type RunRowsSlot = {
  readonly opts: object;
  run?: OpenRun;
  release?: () => void;
  /** The run id this loop linked to the open run it descends from. */
  linked?: string;
  /** Called once, before the release, when the loop's run was cancelled. */
  onCancel?: { readonly ctx: RunContext; readonly fn: () => Promise<void> };
};

const slots = new AsyncLocalStorage<RunRowsSlot>();
const openRuns = new Map<string, OpenRun>();
const closedRuns = new Set<string>();
const verifiedRoots = new Map<string, VerifiedRoot | null>();
/**
 * A running sub-run's id (a sub-agent's, a side call's) to the open run it
 * descends from, so a park inside it lands on that run. A link lives while the
 * sub-run's loop runs.
 */
const descendsFrom = new Map<string, string>();
let appendWarned = false;
let subjectWarned = false;
let exitHandlerSet = false;

/** Whether this `runChatLoop` invocation already runs under {@link withRunRows}. */
export function hasRunRows(opts: object): boolean {
  return slots.getStore()?.opts === opts;
}

/**
 * Run one `runChatLoop` invocation under its own slot, record how it ended
 * (its value or its throw, both passed through unchanged) for the run's
 * terminal row, and release the hold its open took, if it took one.
 */
export async function withRunRows<T>(opts: object, fn: () => Promise<T>): Promise<T> {
  const slot: RunRowsSlot = { opts };
  let outcome: LoopOutcome = { threw: false };
  try {
    return await slots.run(slot, fn);
  } catch (err) {
    outcome = { threw: true, error: err };
    throw err;
  } finally {
    // Before the release, which can end the run and forget it: what the hook
    // reads (`parkingRunIdOf`) must still find the top run.
    const cancelled = slot.onCancel;
    if (cancelled !== undefined && isCancelReason(cancelled.ctx.abortSignal)) {
      try {
        await cancelled.fn();
      } catch {
        // The hook reports its own failure; a cancel never fails the loop.
      }
    }
    if (slot.linked !== undefined) descendsFrom.delete(slot.linked);
    if (slot.run !== undefined) slot.run.last = outcome;
    slot.release?.();
  }
}

/**
 * Run `fn` once when this loop ends with its run cancelled (`cancelRun`), whether
 * or not the ledger records: what the run was waiting on is withdrawn there. Only
 * the current `runChatLoop` invocation's slot holds it; outside one it does nothing.
 */
export function onCancelledRun(ctx: RunContext, fn: () => Promise<void>): void {
  const slot = slots.getStore();
  if (slot === undefined) return;
  slot.onCancel = { ctx, fn };
}

/**
 * The run a park inside `ctx` is recorded on: the open top run it is or descends
 * from, else its own. A resume continues this id.
 */
export function parkingRunIdOf(ctx: RunContext): string {
  return openRunOf(ctx.runId)?.runId ?? ctx.runId;
}

/**
 * The parked run `ctx`'s top run continues. A child context never inherits
 * `continues`, so a call inside a sub-agent of a resumed run reads it from the top.
 */
export function continuesOf(ctx: RunContext): string | undefined {
  return openRunOf(ctx.runId)?.ctx.continues ?? ctx.continues;
}

/**
 * The scope a grant parked in `ctx` is bound to: the open run's recorded scope,
 * else the context's own, else the session's.
 */
export function resumeScopeOf(ctx: RunContext, sessionId: string): string {
  return openRunOf(ctx.runId)?.resumeScope ?? ctx.resumeScope ?? `session:${sessionId}`;
}

/** What started a run and the lineage it records. */
export type RunFacts = {
  readonly trigger: Trigger;
  readonly parent?: string;
  readonly continues?: string;
  readonly resumeScope?: string;
  readonly workItem?: string;
  readonly execution?: string;
};

/**
 * A run's facts as its run records have them: from the `running` row this
 * process wrote for `ctx`'s run when there is one, so the two never disagree;
 * else from the context, with the defaults that row would have taken (the
 * trigger the shape implies, the execution the environment names, the
 * session's resume scope). Reads only: it verifies no root and writes no row,
 * so it answers with the ledger off. A sub-agent's facts name its parent run.
 */
export function runFactsOf(ctx: RunContext, opts: RunRowsLoopOptions, sessionId: string): RunFacts {
  const run = openRuns.get(ctx.runId);
  if (run !== undefined) {
    const continues = run.ctx.continues;
    return {
      trigger: run.trigger,
      ...(run.parent !== undefined ? { parent: run.parent } : {}),
      ...(continues !== undefined ? { continues } : {}),
      ...(run.resumeScope !== undefined ? { resumeScope: run.resumeScope } : {}),
      ...(run.workItem !== undefined ? { workItem: run.workItem } : {}),
      ...(run.execution !== undefined ? { execution: run.execution } : {}),
    };
  }
  const resumeScope = ctx.resumeScope ?? defaultResumeScope(undefined, sessionId);
  const execution = executionId();
  return {
    trigger: ctx.trigger ?? defaultTrigger(opts.sessionTarget),
    ...(ctx.parent !== undefined ? { parent: ctx.parent } : {}),
    ...(ctx.continues !== undefined ? { continues: ctx.continues } : {}),
    ...(resumeScope !== undefined ? { resumeScope } : {}),
    ...(ctx.workItem !== undefined ? { workItem: ctx.workItem } : {}),
    ...(execution !== undefined ? { execution } : {}),
  };
}

/** The open run `runId` is, or descends from. */
function openRunOf(runId: string): OpenRun | undefined {
  const run = openRuns.get(runId);
  if (run !== undefined) return run;
  const top = descendsFrom.get(runId);
  return top === undefined ? undefined : openRuns.get(top);
}

/** Whether this loop's {@link openRunRows} appends the run's `running` row. */
function opensRunningRow(
  ctx: RunContext,
  opts: RunRowsLoopOptions,
  persistSession: boolean,
): boolean {
  const slot = slots.getStore();
  if (slot === undefined || slot.opts !== opts || slot.release !== undefined) return false;
  if (!persistSession || opts.runLedgerDir === null) return false;
  if (process.env["CREWHAUS_RUN_LEDGER"] === "0") return false;
  if (ctx.parent !== undefined || currentTenantContext() !== undefined) return false;
  return !closedRuns.has(ctx.runId) && !openRuns.has(ctx.runId);
}

/**
 * The keyed digest of who the run serves, for its `running` row: of
 * `opts.subject`, else of the ambient scope's subject (run-context's
 * `currentSubject`), under the harness's subject key (`subjectRefOf`). Made
 * only when this loop appends the `running` row, so a loop that records no
 * rows of its own, a managed tenant's among them, makes no key. A key that
 * cannot be made omits the field, with one warning; the run goes on.
 */
export async function runSubjectRef(args: {
  readonly runContext: RunContext;
  readonly opts: RunRowsLoopOptions;
  /** The harness root the loop's settings load reads, when it names one. */
  readonly harnessRoot: string | null | undefined;
  readonly persistSession: boolean;
}): Promise<string | undefined> {
  const subject = args.opts.subject ?? currentSubject();
  if (subject === undefined || subject === "") return undefined;
  if (!opensRunningRow(args.runContext, args.opts, args.persistSession)) return undefined;
  try {
    return await subjectRefOf(ledgerRoot(args.opts, args.harnessRoot), subject);
  } catch {
    if (!subjectWarned) {
      subjectWarned = true;
      args.runContext.logger.warn(
        "the run's subject key could not be made; run records leave the subject out",
      );
    }
    return undefined;
  }
}

/**
 * Open the loop's rows, right before its session log opens: hold the run, set
 * its idle handler, verify a root, and append `running` once per run id, with
 * `subjectRef` when {@link runSubjectRef} gave one. Writes nothing when the
 * loop is not one that records (see the module docblock), or when this
 * process already ended the run.
 */
export function openRunRows(args: {
  readonly runContext: RunContext;
  readonly opts: RunRowsLoopOptions;
  /** The harness root the loop's settings load reads, when it names one. */
  readonly harnessRoot: string | null | undefined;
  readonly sessionId: string;
  readonly sessionRootDir: string | undefined;
  readonly persistSession: boolean;
  readonly bus: TraceEventBus;
  readonly subjectRef?: string;
}): void {
  const { runContext: ctx, opts } = args;
  const slot = slots.getStore();
  if (slot === undefined || slot.opts !== opts || slot.release !== undefined) return;
  // A sub-run records no rows of its own, but a park inside it is its top
  // run's park: link it to the open run it descends from while it runs.
  if (ctx.parent !== undefined && slot.linked === undefined) {
    const top = openRunOf(ctx.parent);
    if (top !== undefined) {
      descendsFrom.set(ctx.runId, top.runId);
      slot.linked = ctx.runId;
    }
  }
  if (!args.persistSession || opts.runLedgerDir === null) return;
  if (process.env["CREWHAUS_RUN_LEDGER"] === "0") return;
  if (ctx.parent !== undefined || currentTenantContext() !== undefined) return;
  if (closedRuns.has(ctx.runId)) {
    ctx.logger.debug("this run already ended in this process; this loop records no rows");
    return;
  }
  let run = openRuns.get(ctx.runId);
  if (run === undefined) {
    const ledger = runLedgerAt(ledgerRoot(opts, args.harnessRoot));
    const root = verifiedRoot(ledger, ctx.logger);
    const trigger = ctx.trigger ?? root?.trigger ?? defaultTrigger(opts.sessionTarget);
    const resumeScope = ctx.resumeScope ?? defaultResumeScope(root, args.sessionId);
    const workItem = ctx.workItem ?? root?.workItem;
    const execution = executionId();
    const sessionAt = sessionBytes(args.sessionRootDir, args.sessionId);
    const written = append(ledger, {
      id: ctx.runId,
      state: "running",
      at: new Date().toISOString(),
      trigger,
      session: args.sessionId,
      ...(sessionAt !== undefined ? { sessionAt } : {}),
      ...(resumeScope !== undefined ? { resumeScope } : {}),
      ...(root !== undefined ? { parent: root.id } : {}),
      ...(ctx.continues !== undefined ? { continues: ctx.continues } : {}),
      ...(workItem !== undefined ? { workItem } : {}),
      ...(execution !== undefined ? { execution } : {}),
      ...(args.subjectRef !== undefined ? { subjectRef: args.subjectRef } : {}),
    });
    if (!written.ok) {
      warnAppend(ctx.logger, written.code);
      return;
    }
    const rollups = { priced: 0, unpriced: 0 };
    run = {
      runId: ctx.runId,
      ledger,
      ctx,
      bus: args.bus,
      trigger,
      tracker: createCostTracker(args.bus, { suppressEvents: true }),
      rollups,
      stopRollups: countRollups(args.bus, rollups),
      ...(resumeScope !== undefined ? { resumeScope } : {}),
      ...(root !== undefined ? { parent: root.id } : {}),
      ...(workItem !== undefined ? { workItem } : {}),
      ...(execution !== undefined ? { execution } : {}),
      parked: false,
    };
    openRuns.set(ctx.runId, run);
    setExitHandler();
  }
  const opened = run;
  slot.run = opened;
  slot.release = retainRun(ctx);
  onRunIdle(ctx.runId, (ended) => closeRun(opened, ended));
}

/**
 * Count the nested roll-ups the bus carries (a sub-agent's spend, a side
 * call's): the cost tracker folds their dollars, but a roll-up its publisher
 * could not price adds no pricing miss there, so it is counted here.
 */
function countRollups(
  bus: TraceEventBus,
  rollups: { priced: number; unpriced: number },
): () => void {
  return bus.subscribe((event) => {
    if (event.kind !== "cost_accrual") return;
    const accrual = event as CostAccrualEvent;
    if (accrual.summary !== true || accrual.role === undefined) return;
    if (accrual.unpriced === true) rollups.unpriced += 1;
    else rollups.priced += 1;
  });
}

/**
 * Record a park: `waiting-for-approval` with the approval's id, once. The run
 * then gets no terminal row from this process; a resume continues it.
 */
export function recordRunPark(ctx: RunContext, decision: string): void {
  const run = openRunOf(ctx.runId);
  if (run === undefined || run.parked) return;
  run.parked = true;
  const written = append(run.ledger, {
    id: run.runId,
    state: "waiting-for-approval",
    at: new Date().toISOString(),
    trigger: run.trigger,
    decision,
  });
  if (!written.ok) warnAppend(ctx.logger, written.code);
}

/** The run's idle handler: its terminal row, unless it parked. */
function closeRun(run: OpenRun, ended: RunHoldOutcome | undefined): void {
  endRun(run, () => terminalState(run, ended));
}

/** Forget an open run and write the row `ending` answers, if any. */
function endRun(run: OpenRun, ending: () => Ending | undefined): void {
  openRuns.delete(run.runId);
  closedRuns.add(run.runId);
  if (closedRuns.size > CLOSED_RUNS_KEPT) {
    const oldest = closedRuns.values().next().value;
    if (oldest !== undefined) closedRuns.delete(oldest);
  }
  try {
    if (run.parked) return;
    const row = ending();
    if (row === undefined) return;
    // A park row is written at the park, with no cost: a resume goes on spending.
    const written = append(run.ledger, {
      id: run.runId,
      at: new Date().toISOString(),
      trigger: run.trigger,
      ...row,
      ...(row.state === "waiting-for-approval" ? {} : { cost: runCost(run) }),
    });
    if (!written.ok) warnAppend(run.ctx.logger, written.code);
  } finally {
    run.tracker.unsubscribe();
    run.stopRollups();
  }
}

type Ending =
  | { readonly state: "cancelled" | "succeeded" | "waiting-for-approval" }
  | { readonly state: "failed"; readonly failureClass: string; readonly cause?: RunCause };

/**
 * How the run ended: its signal first, then the outcome a holder said on its
 * release, then its last loop's. `undefined`: nothing to write.
 */
function terminalState(run: OpenRun, ended: RunHoldOutcome | undefined): Ending | undefined {
  // An aborted loop can return normally, so the cancel is read first.
  if (isCancelReason(run.ctx.abortSignal)) return { state: "cancelled" };
  if (ended?.outcome === "succeeded") return { state: "succeeded" };
  // A holder's pause (a graph's `hitl_pause`) waits on a person, like a park.
  if (ended?.outcome === "paused") return { state: "waiting-for-approval" };
  if (ended?.outcome === "failed") return endingOfThrow(ended.error);
  const last = run.last;
  if (last === undefined) return { state: "failed", failureClass: "unknown" };
  if (!last.threw) return { state: "succeeded" };
  return endingOfThrow(last.error);
}

/**
 * The row a thrown stop ends a run with. An `approval_pending` stop whose park
 * row was not written (a park this process could not attribute) is still a
 * park, never a success and never a failure.
 */
function endingOfThrow(error: unknown): Ending {
  const failureClass = failureClassOf(error);
  if (failureClass === undefined) return { state: "failed", failureClass: "unknown" };
  return endingOfClass(failureClass);
}

function endingOfClass(failureClass: FailureClass): Ending {
  if (failureClass === "approval_pending") return { state: "waiting-for-approval" };
  const cause = causeOf(failureClass);
  return { state: "failed", failureClass, ...(cause !== undefined ? { cause } : {}) };
}

/** The failure class the exit-code table gives `code`, when it names one. */
const CLASS_OF_EXIT_CODE: ReadonlyMap<number, FailureClass> = new Map(
  Object.entries(EXIT_CODES)
    .filter(([name]) => name !== "ok" && name !== "generic")
    .map(([name, code]) => [code, name as FailureClass]),
);

/** How a run still open when the process exits ends, by the exit code. */
function exitState(run: OpenRun, code: number): Ending {
  if (isCancelReason(run.ctx.abortSignal)) return { state: "cancelled" };
  // 130 is SIGINT: a person ending their session (the REPL's second Ctrl-C).
  if (code === 0 || code === 130) return { state: "succeeded" };
  const failureClass = CLASS_OF_EXIT_CODE.get(code);
  return failureClass === undefined
    ? { state: "failed", failureClass: "unknown" }
    : endingOfClass(failureClass);
}

/**
 * Once per process: on exit, end every run still open. `process.exit` runs no
 * `finally`, so without this a run ended that way would read `running`
 * forever. `append` is one synchronous write, so it lands before the exit.
 */
function setExitHandler(): void {
  if (exitHandlerSet) return;
  exitHandlerSet = true;
  process.once("exit", (code) => {
    for (const run of [...openRuns.values()]) endRun(run, () => exitState(run, code));
  });
}

function failureClassOf(error: unknown): FailureClass | undefined {
  return error instanceof RunFailedError ? error.report.class : undefined;
}

const CAUSE_KINDS: Partial<Record<FailureClass, RunCause["kind"]>> = {
  billing: "provider",
  auth: "provider",
  rate_limit: "provider",
  context_overflow: "provider",
  crewhaus_budget: "budget",
  mcp_boot: "mcp",
  tool: "tool",
  spec: "spec",
  config: "config",
};

/** Why a classified stop happened, by name only: the kind and the failure class. */
function causeOf(failureClass: FailureClass): RunCause | undefined {
  const kind = CAUSE_KINDS[failureClass];
  return kind === undefined ? undefined : { kind, ref: failureClass };
}

/** The run's spend. A run whose every call was unpriced has no dollar figure: `null`, never 0. */
function runCost(run: OpenRun): { readonly usdMicros: number | null; readonly unpriced: number } {
  const unpriced = run.tracker.pricingMisses() + run.rollups.unpriced;
  const priced = run.tracker.observed() + run.rollups.priced;
  const usdMicros =
    unpriced > 0 && priced === 0
      ? null
      : Math.round(run.tracker.getRunCost(run.bus.runId).totalUsdMicros);
  return { usdMicros, unpriced };
}

/**
 * The harness root a loop's control records live under: `runLedgerDir` when it is
 * a string, else the root the settings load reads, else the working directory.
 * The run ledger and the approver projection a spend reads are both found here.
 */
export function ledgerRoot(
  opts: RunRowsLoopOptions,
  harnessRoot: string | null | undefined,
): string {
  if (typeof opts.runLedgerDir === "string") return opts.runLedgerDir;
  if (typeof harnessRoot === "string") return harnessRoot;
  return process.cwd();
}

function defaultTrigger(sessionTarget: string | undefined): Trigger {
  if (sessionTarget === "channel") return { kind: "channel" };
  if (sessionTarget === "managed") return { kind: "managed" };
  return { kind: "cli" };
}

/** `work:<wi>` or `run:<root>` under a verified root, else `session:<id>`; absent when it would not parse. */
function defaultResumeScope(root: VerifiedRoot | undefined, sessionId: string): string | undefined {
  try {
    if (root?.workItem !== undefined) return formatResumeScope({ kind: "work", id: root.workItem });
    if (root !== undefined) return formatResumeScope({ kind: "run", id: root.id });
    return formatResumeScope({ kind: "session", id: sessionId });
  } catch {
    return undefined;
  }
}

function executionId(): string | undefined {
  const value = process.env["CREWHAUS_EXECUTION_ID"];
  return value !== undefined && EXECUTION_RUN_ID_RE.test(value) ? value : undefined;
}

/** The session log's length before this loop appends to it; 0 when it does not exist yet. */
function sessionBytes(sessionRootDir: string | undefined, sessionId: string): number | undefined {
  try {
    return statSync(resolve(sessionRootDir ?? DEFAULT_ROOT_DIR, `${sessionId}.jsonl`)).size;
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? 0 : undefined;
  }
}

function warnAppend(logger: Logger, code: string): void {
  if (appendWarned) return;
  appendWarned = true;
  logger.warn("run records could not be written; the run goes on without them", { code });
}

/**
 * The root run `CREWHAUS_RUN_ID` names, when this harness's supervisor queued
 * it for this execution. Decided once per process for each ledger and value;
 * accepting writes the root's `running` row.
 */
function verifiedRoot(ledger: Ledger, logger: Logger): VerifiedRoot | undefined {
  const named = process.env["CREWHAUS_RUN_ID"];
  if (named === undefined || named === "") return undefined;
  const execution = process.env["CREWHAUS_EXECUTION_ID"] ?? "";
  const key = `${ledger.root}\u0000${named}\u0000${execution}`;
  const known = verifiedRoots.get(key);
  if (known !== undefined) return known ?? undefined;
  // Not shaped like a run id: another tool's own key (a workflow's durable-resume
  // key), never a root a supervisor queued. Ignored without a word.
  if (!CANONICAL_RUN_ID_RE.test(named)) {
    verifiedRoots.set(key, null);
    return undefined;
  }
  const root = acceptRoot(ledger, named, execution);
  verifiedRoots.set(key, root ?? null);
  if (root === undefined) {
    logger.warn(
      "CREWHAUS_RUN_ID names no run this harness's supervisor started; run records use their own ids",
    );
    return undefined;
  }
  const written = append(ledger, {
    id: root.id,
    state: "running",
    at: new Date().toISOString(),
    trigger: root.trigger,
    execution: root.execution,
  });
  if (!written.ok) warnAppend(logger, written.code);
  return root;
}

function acceptRoot(ledger: Ledger, id: string, execution: string): VerifiedRoot | undefined {
  if (!CANONICAL_RUN_ID_RE.test(id) || !EXECUTION_RUN_ID_RE.test(execution)) return undefined;
  let newest: Readonly<Record<string, unknown>> | undefined;
  try {
    newest = readPage(ledger, { limit: ROOT_PAGE_LINES }).items.find(
      (item) => item.record["id"] === id,
    )?.record;
  } catch {
    return undefined;
  }
  if (newest === undefined) return undefined;
  const state = newest["state"];
  if (state !== "queued" && state !== "preparing") return undefined;
  if (newest["execution"] !== execution) return undefined;
  const workItem = newest["workItem"];
  return {
    id,
    trigger: triggerOf(newest["trigger"]) ?? { kind: "cli" },
    execution,
    ...(isId("wi", workItem) ? { workItem: workItem as string } : {}),
  };
}

function triggerOf(value: unknown): Trigger | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return (TRIGGER_KINDS as readonly unknown[]).includes(kind) ? (value as Trigger) : undefined;
}

/** Test seam: forget the open runs, the roots, the ended runs and the one warning. */
export function _resetRunLedgerForTest(): void {
  for (const run of openRuns.values()) {
    run.tracker.unsubscribe();
    run.stopRollups();
  }
  openRuns.clear();
  closedRuns.clear();
  descendsFrom.clear();
  verifiedRoots.clear();
  appendWarned = false;
  subjectWarned = false;
}

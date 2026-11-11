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
 *    scope, what started the run, and the root run, work item, parked run
 *    and execution when known;
 *  - `waiting-for-approval {decision}` at a park (`recordRunPark`), after
 *    which this process writes nothing more for the run: the park is durable;
 *  - a terminal row once the run is idle (its last hold released, see
 *    run-context's `retainRun`), from the last loop's outcome: `cancelled`
 *    when the context's signal was aborted by `cancelRun`, whether the loop
 *    returned or threw; nothing more for an `approval_pending` stop; `failed
 *    {failureClass, cause?}` for another classified stop and `failed
 *    {failureClass: "unknown"}` for any other throw; `succeeded` otherwise.
 *    A terminal row carries `cost`, where an unpriced run is never $0.
 *
 * A verified root. A supervisor that starts a one-shot job writes its root
 * run's `queued` and `preparing` rows and hands the child `CREWHAUS_RUN_ID`
 * and `CREWHAUS_EXECUTION_ID`. The value is honoured only when the ledger's
 * newest row for that id, in its newest 256 lines, is `queued` or `preparing`
 * for this execution; then the root's `running` row is written once and every
 * top-level loop names the root as its `parent`. Any other value is ignored
 * with one warning, and the loops' rows use their own ids.
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
  harnessLedger,
  readPage,
} from "@crewhaus/control-records";
import { type CostTracker, createCostTracker } from "@crewhaus/cost-tracker";
import { type FailureClass, RunFailedError } from "@crewhaus/errors";
import { DEFAULT_ROOT_DIR } from "@crewhaus/event-log";
import { type RunContext, isCancelReason, onRunIdle, retainRun } from "@crewhaus/run-context";
import { currentTenantContext } from "@crewhaus/tenancy";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

type Logger = RunContext["logger"];

/** The run ledger's directory, relative to the harness root. */
export const RUN_LEDGER_DIR = join(controlPaths(".").controlDir, "runs");

/** The run ledger of the harness at `root`. */
export function runLedgerAt(root: string): Ledger {
  return harnessLedger(root, { dir: RUN_LEDGER_DIR }, { machine: "run" });
}

/** How many newest lines the root check reads. A capped read can only refuse. */
const ROOT_PAGE_LINES = 256;
/** How many ended run ids this process remembers, so a reused context writes nothing. */
const CLOSED_RUNS_KEPT = 1024;

/** The options a loop's rows read. `RunChatLoopOptions` satisfies it. */
export type RunRowsLoopOptions = {
  readonly runLedgerDir?: string | null;
  readonly sessionTarget?: string;
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
  parked: boolean;
  last?: LoopOutcome;
};

/** One `runChatLoop` invocation: what it took, so it releases only that. */
type RunRowsSlot = {
  readonly opts: object;
  run?: OpenRun;
  release?: () => void;
};

const slots = new AsyncLocalStorage<RunRowsSlot>();
const openRuns = new Map<string, OpenRun>();
const closedRuns = new Set<string>();
const verifiedRoots = new Map<string, VerifiedRoot | null>();
let appendWarned = false;

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
    if (slot.run !== undefined) slot.run.last = outcome;
    slot.release?.();
  }
}

/**
 * Open the loop's rows, right before its session log opens: hold the run, set
 * its idle handler, verify a root, and append `running` once per run id.
 * Writes nothing when the loop is not one that records (see the module
 * docblock), or when this process already ended the run.
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
}): void {
  const { runContext: ctx, opts } = args;
  const slot = slots.getStore();
  if (slot === undefined || slot.opts !== opts || slot.release !== undefined) return;
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
    });
    if (!written.ok) {
      warnAppend(ctx.logger, written.code);
      return;
    }
    run = {
      runId: ctx.runId,
      ledger,
      ctx,
      bus: args.bus,
      trigger,
      tracker: createCostTracker(args.bus, { suppressEvents: true }),
      parked: false,
    };
    openRuns.set(ctx.runId, run);
  }
  const opened = run;
  slot.run = opened;
  slot.release = retainRun(ctx);
  onRunIdle(ctx.runId, () => closeRun(opened));
}

/**
 * Record a park: `waiting-for-approval` with the approval's id, once. The run
 * then gets no terminal row from this process; a resume continues it.
 */
export function recordRunPark(ctx: RunContext, decision: string): void {
  const run = openRuns.get(ctx.runId);
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
function closeRun(run: OpenRun): void {
  openRuns.delete(run.runId);
  closedRuns.add(run.runId);
  if (closedRuns.size > CLOSED_RUNS_KEPT) {
    const oldest = closedRuns.values().next().value;
    if (oldest !== undefined) closedRuns.delete(oldest);
  }
  try {
    if (run.parked) return;
    const ending = terminalState(run);
    if (ending === undefined) return;
    const written = append(run.ledger, {
      id: run.runId,
      at: new Date().toISOString(),
      trigger: run.trigger,
      ...ending,
      cost: runCost(run),
    });
    if (!written.ok) warnAppend(run.ctx.logger, written.code);
  } finally {
    run.tracker.unsubscribe();
  }
}

type Ending =
  | { readonly state: "cancelled" | "succeeded" }
  | { readonly state: "failed"; readonly failureClass: string; readonly cause?: RunCause };

/** How the run ended, from its signal and its last loop. `undefined`: a park stands. */
function terminalState(run: OpenRun): Ending | undefined {
  // An aborted loop can return normally, so the cancel is read first.
  if (isCancelReason(run.ctx.abortSignal)) return { state: "cancelled" };
  const last = run.last;
  if (last === undefined) return { state: "failed", failureClass: "unknown" };
  if (!last.threw) return { state: "succeeded" };
  const failureClass = failureClassOf(last.error);
  if (failureClass === undefined) return { state: "failed", failureClass: "unknown" };
  if (failureClass === "approval_pending") return undefined;
  const cause = causeOf(failureClass);
  return { state: "failed", failureClass, ...(cause !== undefined ? { cause } : {}) };
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
  const unpriced = run.tracker.pricingMisses();
  const priced = run.tracker.observed();
  const usdMicros =
    unpriced > 0 && priced === 0
      ? null
      : Math.round(run.tracker.getRunCost(run.bus.runId).totalUsdMicros);
  return { usdMicros, unpriced };
}

function ledgerRoot(opts: RunRowsLoopOptions, harnessRoot: string | null | undefined): string {
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

/** Test seam: forget the roots, the ended runs and the one warning. */
export function _resetRunLedgerForTest(): void {
  openRuns.clear();
  closedRuns.clear();
  verifiedRoots.clear();
  appendWarned = false;
}

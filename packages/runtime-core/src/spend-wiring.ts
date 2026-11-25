/**
 * The spend meter as `runChatLoop` uses it (`@crewhaus/cost-tracker/spend`):
 * one meter per run tree, a reservation before each model call, a settle on
 * its response, a settle when it was sent and failed (at the usage its stream
 * reported, else at its worst case), and a release only when it was never
 * sent.
 *
 * - One meter per run tree. Loops that share a caller-owned `budgetMeter`
 *   (a workflow's steps) share one spend meter, keyed on that meter; a loop
 *   handed a meter (`spendMeter`, a sub-agent's) uses it as is; any other
 *   budgeted loop meters itself, as its own cap check does. A loop with
 *   neither a meter nor a `budget` has none: nothing is reserved. Each loop's
 *   meter is also found from its `RunContext` ({@link spendMeterOf}), so a
 *   side call it makes spends from it.
 * - A loop nested inside a call never waits on that call. Every handle a
 *   nested loop gets (a side call's meter, a tool's `bridge.spend`) is a view
 *   (`within`) naming the reservation of the loop's call in progress when the
 *   handle was made; that call settles only after the nested loop returns, so
 *   a cap it fills is a final refusal, never a wait.
 * - The run cap refuses a reservation under `on_exceed: stop` only. Under
 *   `degrade` the cap is the degrade ladder's (the per-call cap check moves
 *   the run to the cheaper model), so the meter holds the run's spend, and
 *   still refuses for a sub-agent's share and for the harness's period.
 * - A declared `budget.period` hands the meter a ledger port over the
 *   harness's period ledger (`@crewhaus/control-records/budget`), rooted where
 *   loop admission roots (the control plane's harness), else the harness
 *   directory the caller names (`crewhaus run`: the spec's directory), else
 *   the working directory. No period, no ledger, no file.
 * - Unknown cost is never $0: a model with no price reserves nothing, its
 *   settle counts an unknown call, and a budgeted run publishes one
 *   `budget_unpriced` per wire model ({@link settleModelCall}, the one site).
 */
import type { ProviderRequest, StreamEvent, TokenUsage } from "@crewhaus/adapter-anthropic";
import { intakeRoot } from "@crewhaus/control-records";
import { type BudgetPeriodDef, openBudgetLedger } from "@crewhaus/control-records/budget";
import {
  DEFAULT_PRICING,
  type DeclaredPricing,
  type PricingTable,
  mergeDeclaredPricing,
} from "@crewhaus/cost-tracker";
import {
  type SpendMeter,
  type SpendReserveMeta,
  type SpendScope,
  createSpendMeter,
  estimateCallMicros,
} from "@crewhaus/cost-tracker/spend";
import type { RunContext } from "@crewhaus/run-context";
import type { ModelRole, ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";

/**
 * The meter of the loop that last ran on each context, for its side calls,
 * and that loop's call in progress (its reservation id), if any.
 */
const meters = new WeakMap<
  RunContext,
  { readonly meter: SpendMeter; readonly inFlight: () => string | undefined }
>();
/** One meter per caller-owned budget meter, so loops that share one share this too. */
const shared = new WeakMap<object, SpendMeter>();
/** Wire models a run already published `budget_unpriced` for. */
const unpricedSeen = new WeakMap<RunContext, Set<string>>();

/**
 * The spend meter of the budgeted loop running on `runContext`, when it has
 * one. A side call's nested loop spends from it. The answer is a view naming
 * the loop's call in progress at this moment as an ancestor, so a side call
 * made from inside that call's tools never waits on it; ask once per side call.
 */
export function spendMeterOf(runContext: RunContext | undefined): SpendMeter | undefined {
  const found = runContext === undefined ? undefined : meters.get(runContext);
  return found === undefined ? undefined : found.meter.within(found.inFlight());
}

/** The loop's meter: the one it was given, the one its shared budget meter has, or a new one. */
export function attachSpendMeter(args: {
  readonly runContext: RunContext;
  readonly given: SpendMeter | undefined;
  readonly budget:
    | {
        readonly usdMicros: number;
        readonly onExceed: { readonly kind: "stop" | "degrade" };
        readonly period?: BudgetPeriodDef;
      }
    | undefined;
  /** The caller-owned budget meter loops of one run share, when there is one. */
  readonly sharedWith: object | undefined;
  /** Spend already counted (a session-scoped budget's resume seed). */
  readonly seedMicros: number;
  readonly pricing: PricingTable;
  /** What started the run, recorded on the period ledger. */
  readonly trigger: string | undefined;
  /** The loop's call in progress: its reservation id, while it is reserved. */
  readonly inFlight?: () => string | undefined;
  /** The harness directory a declared period's ledger lives in, when loop admission names none. */
  readonly ledgerRoot?: string;
}): SpendMeter | undefined {
  const inFlight = args.inFlight ?? (() => undefined);
  if (args.given !== undefined) {
    meters.set(args.runContext, { meter: args.given, inFlight });
    return args.given;
  }
  if (args.budget === undefined) return undefined;
  const existing = args.sharedWith !== undefined ? shared.get(args.sharedWith) : undefined;
  if (existing !== undefined) {
    meters.set(args.runContext, { meter: existing, inFlight });
    return existing;
  }
  const period = args.budget.period;
  const meter = createSpendMeter({
    ...(args.budget.onExceed.kind === "stop" ? { capMicros: args.budget.usdMicros } : {}),
    seedMicros: args.seedMicros,
    pricing: args.pricing,
    ...(period !== undefined
      ? { ledger: periodLedger(period, args.trigger, args.ledgerRoot) }
      : {}),
  });
  if (args.sharedWith !== undefined) shared.set(args.sharedWith, meter);
  meters.set(args.runContext, { meter, inFlight });
  return meter;
}

/**
 * The harness's period ledger, rooted where loop admission roots, else `root` (a
 * caller's harness directory), else the working directory.
 */
function periodLedger(period: BudgetPeriodDef, trigger: string | undefined, root?: string) {
  return openBudgetLedger(intakeRoot() ?? root ?? process.cwd(), period, {
    ...(trigger !== undefined ? { trigger } : {}),
  });
}

/**
 * A meter with no cap of its own over the harness's period ledger, for a
 * caller that runs many loops under one budget of its own (an eval's samples)
 * and hands each loop this meter as `spendMeter`: every call they make
 * reserves and settles on the period, as a run's calls do.
 *
 * First consumer: eval-runner's sample loops.
 */
export function openPeriodSpendMeter(args: {
  readonly period: BudgetPeriodDef;
  /** The spec's declared prices, merged over the installed table as a run merges them. */
  readonly declaredPricing?: DeclaredPricing;
  /** What started the spend, recorded on the ledger. */
  readonly trigger?: string;
  /** The harness directory, when loop admission has none (the spec's own directory). */
  readonly root?: string;
}): SpendMeter {
  return createSpendMeter({
    pricing: mergeDeclaredPricing(DEFAULT_PRICING, args.declaredPricing),
    ledger: periodLedger(args.period, args.trigger, args.root),
  });
}

/** Characters of what a request sends: its system, messages and tools, serialized. */
export function requestInputChars(req: ProviderRequest): number {
  return JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools ?? [] })
    .length;
}

/** A call's worst case: its request at the input rate, `maxTokens` at the output rate. */
export function estimateRequestMicros(
  meter: SpendMeter,
  req: ProviderRequest,
  provider: ProviderId,
  wireModelId: string,
): number | undefined {
  return estimateCallMicros(
    requestInputChars(req),
    0,
    req.maxTokens,
    provider,
    wireModelId,
    meter.pricing,
  );
}

/** The error an aborted wait for a reservation ends with: the loop reads it as an abort. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error("the run was stopped while its model call waited for budget");
  err.name = "AbortError";
  return err;
}

/** `settled`, or the signal's abort, whichever comes first; throws on the abort. */
function untilSettledOrAborted(settled: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    settled.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Reserve call `id` before it is dispatched. Waits while only other calls'
 * reservations stand in the way and asks again; answers which cap refused
 * when spend so far reaches one, and `inFlight` when it is reached counting a
 * call this one runs inside (never a wait: that call settles only after this
 * one returns). The wait ends when `signal` aborts (the
 * run's stop, its deadline, the turn's timeout), throwing an `AbortError`;
 * and the period ledger itself answers finally once only reservations past
 * their lease are left (`held`), so the wait is bounded by those leases.
 */
export async function reserveModelCall(
  meter: SpendMeter,
  id: string,
  estimateMicros: number | undefined,
  meta: SpendReserveMeta,
  signal: AbortSignal,
): Promise<
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly scope: SpendScope;
      readonly held?: true;
      readonly inFlight?: true;
    }
> {
  for (;;) {
    if (signal.aborted) throw abortError(signal);
    const answer = await meter.reserve(id, estimateMicros, meta);
    if (answer.admit) {
      if (!signal.aborted) return { admitted: true };
      await meter.release(id);
      throw abortError(signal);
    }
    if (answer.on === "spent") {
      return {
        admitted: false,
        scope: answer.scope ?? "run",
        ...(answer.held === true ? { held: true as const } : {}),
        ...(answer.inFlight === true ? { inFlight: true as const } : {}),
      };
    }
    await untilSettledOrAborted(answer.settled, signal);
  }
}

/** A call's usage as its stream reports it: `usage` is set once the final counts arrive. */
export type StreamReport = { usage?: TokenUsage };

/**
 * `stream`, unchanged, noting on `report` the usage it reported once the counts
 * are final: a closing `message_delta` (one with a stop reason), or the
 * `message_stop` after a delta that carried counts. The counts merge as the
 * stream's consumers merge them. A stream that ends before that, or that counted
 * nothing, leaves `report.usage` undefined: its output is not known.
 */
export async function* notingUsage(
  stream: AsyncIterable<StreamEvent>,
  report: StreamReport,
): AsyncGenerator<StreamEvent> {
  let seen: TokenUsage = { input: 0, output: 0 };
  let counted = false;
  for await (const ev of stream) {
    if (ev.kind === "message_start" && ev.usage !== undefined) seen = ev.usage;
    if (ev.kind === "message_delta" && ev.usage !== undefined) {
      const { input, output, cacheRead, cacheCreate } = ev.usage;
      seen = {
        ...seen,
        ...(input > 0 ? { input } : {}),
        ...(output > 0 ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheCreate !== undefined ? { cacheCreate } : {}),
      };
      counted = output > 0 || input > 0;
    }
    const closing =
      ev.kind === "message_stop" || (ev.kind === "message_delta" && ev.stopReason !== undefined);
    if (closing && counted) report.usage = seen;
    yield ev;
  }
}

/**
 * Settle call `id` with its response's usage. The first unpriced settle of a
 * wire model in a budgeted run publishes `budget_unpriced` once: never a
 * stop, never a degrade.
 */
export async function settleModelCall(args: {
  readonly meter: SpendMeter;
  readonly id: string;
  readonly runContext: RunContext;
  readonly bus: TraceEventBus;
  readonly budgeted: boolean;
  readonly provider: ProviderId;
  readonly wireModelId: string;
  readonly role: ModelRole | undefined;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheCreate?: number;
  };
  readonly meta: SpendReserveMeta;
}): Promise<void> {
  const settled = await args.meter.settle(
    args.id,
    {
      provider: args.provider,
      modelId: args.wireModelId,
      input: args.usage.input,
      output: args.usage.output,
      ...(args.usage.cacheRead !== undefined ? { cacheRead: args.usage.cacheRead } : {}),
      ...(args.usage.cacheCreate !== undefined ? { cacheCreate: args.usage.cacheCreate } : {}),
    },
    args.meta,
  );
  if (settled.usdMicros !== undefined || !args.budgeted) return;
  let seen = unpricedSeen.get(args.runContext);
  if (seen === undefined) {
    seen = new Set();
    unpricedSeen.set(args.runContext, seen);
  }
  const key = `${args.provider}\u0000${args.wireModelId}`;
  if (seen.has(key)) return;
  seen.add(key);
  args.bus.publish({
    ...args.bus.envelope(),
    kind: "budget_unpriced",
    provider: args.provider,
    modelId: args.wireModelId,
    ...(args.role !== undefined ? { role: args.role } : {}),
  });
}

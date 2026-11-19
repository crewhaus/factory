/**
 * The spend meter as `runChatLoop` uses it (`@crewhaus/cost-tracker/spend`):
 * one meter per run tree, a reservation before each model call, a settle on
 * its response and a release when it fails.
 *
 * - One meter per run tree. Loops that share a caller-owned `budgetMeter`
 *   (a workflow's steps) share one spend meter, keyed on that meter; a loop
 *   handed a meter (`spendMeter`, a sub-agent's) uses it as is; any other
 *   budgeted loop meters itself, as its own cap check does. A loop with
 *   neither a meter nor a `budget` has none: nothing is reserved. Each loop's
 *   meter is also found from its `RunContext` ({@link spendMeterOf}), so a
 *   side call it makes spends from it.
 * - The run cap refuses a reservation under `on_exceed: stop` only. Under
 *   `degrade` the cap is the degrade ladder's (the per-call cap check moves
 *   the run to the cheaper model), so the meter holds the run's spend, and
 *   still refuses for a sub-agent's share and for the harness's period.
 * - A declared `budget.period` hands the meter a ledger port over the
 *   harness's period ledger (`@crewhaus/control-records/budget`), rooted where
 *   loop admission roots (the control plane's harness), else the working
 *   directory a harness runs from. No period, no ledger, no file.
 * - Unknown cost is never $0: a model with no price reserves nothing, its
 *   settle counts an unknown call, and a budgeted run publishes one
 *   `budget_unpriced` per wire model ({@link settleModelCall}, the one site).
 */
import type { ProviderRequest } from "@crewhaus/adapter-anthropic";
import { intakeRoot } from "@crewhaus/control-records";
import { type BudgetPeriodDef, openBudgetLedger } from "@crewhaus/control-records/budget";
import type { PricingTable } from "@crewhaus/cost-tracker";
import {
  type SpendMeter,
  type SpendReserveMeta,
  type SpendScope,
  createSpendMeter,
  estimateCallMicros,
} from "@crewhaus/cost-tracker/spend";
import type { RunContext } from "@crewhaus/run-context";
import type { ModelRole, ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";

/** The meter of the loop that last ran on each context, for its side calls. */
const meters = new WeakMap<RunContext, SpendMeter>();
/** One meter per caller-owned budget meter, so loops that share one share this too. */
const shared = new WeakMap<object, SpendMeter>();
/** Wire models a run already published `budget_unpriced` for. */
const unpricedSeen = new WeakMap<RunContext, Set<string>>();

/**
 * The spend meter of the budgeted loop running on `runContext`, when it has
 * one. A side call's nested loop spends from it.
 */
export function spendMeterOf(runContext: RunContext | undefined): SpendMeter | undefined {
  return runContext === undefined ? undefined : meters.get(runContext);
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
}): SpendMeter | undefined {
  if (args.given !== undefined) {
    meters.set(args.runContext, args.given);
    return args.given;
  }
  if (args.budget === undefined) return undefined;
  const existing = args.sharedWith !== undefined ? shared.get(args.sharedWith) : undefined;
  if (existing !== undefined) {
    meters.set(args.runContext, existing);
    return existing;
  }
  const period = args.budget.period;
  const meter = createSpendMeter({
    ...(args.budget.onExceed.kind === "stop" ? { capMicros: args.budget.usdMicros } : {}),
    seedMicros: args.seedMicros,
    pricing: args.pricing,
    ...(period !== undefined
      ? {
          ledger: openBudgetLedger(intakeRoot() ?? process.cwd(), period, {
            ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
          }),
        }
      : {}),
  });
  if (args.sharedWith !== undefined) shared.set(args.sharedWith, meter);
  meters.set(args.runContext, meter);
  return meter;
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

/**
 * Reserve call `id` before it is dispatched. Waits while only other calls'
 * reservations stand in the way (each ends on its own deadline) and asks
 * again; answers which cap refused when spend so far reaches one.
 */
export async function reserveModelCall(
  meter: SpendMeter,
  id: string,
  estimateMicros: number | undefined,
  meta: SpendReserveMeta,
): Promise<{ readonly admitted: true } | { readonly admitted: false; readonly scope: SpendScope }> {
  for (;;) {
    const answer = await meter.reserve(id, estimateMicros, meta);
    if (answer.admit) return { admitted: true };
    if (answer.on === "spent") return { admitted: false, scope: answer.scope ?? "run" };
    await answer.settled;
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

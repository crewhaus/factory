/**
 * What the provability gate cost a sample (design/0.8.0-provability-release.md
 * §9.1 `provability.costPerProvenClaim`, the `continuity.costPerProvenOutcome`
 * precedent): the spend the gate CAUSED, read from the run's own trace events,
 * never estimated.
 *
 *   - re-runs — every model call inside a turn AFTER a failing
 *     `provability_graded` pass and BEFORE that turn's next pass: the retry
 *     (or escalation) the failing verdict triggered. Calls with
 *     `role: "judge"` are left out of the window: the waiver judge is counted
 *     from the gate's own report below (counting both would double it), and
 *     an `evaluation:` judge re-grading the re-run is that gate's spend;
 *   - the waiver judge — `judgeCostUsdMicros` on every `provability_graded`
 *     pass (the bundle's `spentUsdMicros` when the run carried no pass
 *     events, e.g. a hand-wired invoker that supplied only the bundle);
 *   - checker time — `durationMs` of every `proof_checked` event. Time, not
 *     money: reported beside the spend, never added to it.
 *
 * How a re-run call is priced depends on whether the run was METERED:
 *
 *   - a run whose cost-tracker was attached (`CREWHAUS_COST_TRACKING=1`, or a
 *     session-scoped budget) publishes one `cost_accrual` per call, so the
 *     window's accruals ARE the price; an accrual the tracker could not price
 *     (`unpriced: true`) adds its tokens to the unpriced count;
 *   - an unmetered run (a plain `crewhaus eval` attaches no tracker) prices
 *     the window's `model_response` usage through the caller's `pricing`
 *     seam (the eval runner's `RunEvalOptions.pricing` — the same lookup the
 *     run's budget cap uses); a call it cannot price, or every call when no
 *     seam was given, is unpriced.
 *
 * Unpriced tokens are reported as UNPRICED, never as free: the grader marks
 * the ratio a lower bound and the roll-up counts it apart.
 */
import type { ProofBundle } from "@crewhaus/provability";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

/**
 * Prices one model call in USD micro-dollars, or `undefined` when the model
 * has no pricing row. Structurally the eval runner's `EvalPricingFn`.
 */
export type GatePricing = (
  model: string,
  tokens: { readonly input: number; readonly output: number },
) => number | undefined;

export type GateSpend = {
  /** Gate-triggered re-runs: agent/escalation calls inside a retry window, as priced. */
  readonly rerunUsdMicros: number;
  /** The opt-in paraphrase-waiver judge, as the gate reported it. */
  readonly judgeUsdMicros: number;
  /** `rerunUsdMicros + judgeUsdMicros` — a LOWER BOUND when {@link unpriced}. */
  readonly totalUsdMicros: number;
  /** Verification passes after the first, across every turn. */
  readonly reruns: number;
  /** Input + output tokens of the re-run calls (priced or not). */
  readonly rerunTokens: number;
  /** Re-run tokens nothing priced (an unpriced accrual, or a call the seam could not price). */
  readonly unpricedTokens: number;
  /** `unpricedTokens > 0`: the spend above is a lower bound. */
  readonly unpriced: boolean;
  /** `ProofCheck` checker runs and their summed wall-clock time. */
  readonly checks: number;
  readonly checkerMs: number;
};

type Pass = { readonly index: number; readonly failing: boolean };

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A per-call accrual (not the role-less optimizer roll-up, which re-sums per-call ones). */
const isCallAccrual = (event: TraceEvent): boolean =>
  event.kind === "cost_accrual" && event.summary !== true;

/** The spend the gate caused across `events` (see the module doc). */
export function gateSpendOf(
  events: ReadonlyArray<TraceEvent>,
  bundle?: Pick<ProofBundle, "spentUsdMicros">,
  opts: { readonly pricing?: GatePricing } = {},
): GateSpend {
  // Passes per turn, in publish order: a window opens after a FAILING pass
  // and closes at the turn's next pass.
  const passesByTurn = new Map<number, Pass[]>();
  let judgeUsdMicros = 0;
  let sawPass = false;
  let checks = 0;
  let checkerMs = 0;
  events.forEach((event, index) => {
    if (event.kind === "provability_graded") {
      sawPass = true;
      judgeUsdMicros += finite(event.judgeCostUsdMicros);
      const passes = passesByTurn.get(event.turnNumber) ?? [];
      passes.push({ index, failing: event.verdict === "fail" });
      passesByTurn.set(event.turnNumber, passes);
    } else if (event.kind === "proof_checked") {
      checks += 1;
      checkerMs += finite(event.durationMs);
    }
  });
  if (!sawPass) judgeUsdMicros = finite(bundle?.spentUsdMicros);

  /** Whether event `index` of turn `turn` sits inside a retry window. */
  const inWindow = (turn: number, index: number): boolean => {
    const passes = passesByTurn.get(turn);
    if (passes === undefined) return false;
    for (let i = 0; i + 1 < passes.length; i++) {
      const open = passes[i] as Pass;
      const close = passes[i + 1] as Pass;
      if (open.failing && index > open.index && index < close.index) return true;
    }
    return false;
  };

  // A tracker publishes an accrual for EVERY call, so one per-call accrual
  // anywhere means the accruals are the price; without one, the seam prices.
  const metered = events.some(isCallAccrual);
  let rerunUsdMicros = 0;
  let rerunTokens = 0;
  let unpricedTokens = 0;
  events.forEach((event, index) => {
    if (event.kind === "cost_accrual") {
      if (event.role === "judge" || !inWindow(event.turnNumber, index)) return;
      // The role-less optimizer total re-sums per-call accruals; a ROLED
      // summary is a nested run (a Task child) whose calls this bus never saw.
      if (event.summary === true && event.role === undefined) return;
      if (event.unpriced === true) {
        unpricedTokens += finite(event.inputTokens) + finite(event.outputTokens);
      } else {
        rerunUsdMicros += finite(event.costUsdMicros);
      }
    } else if (event.kind === "model_response") {
      if (event.role === "judge" || !inWindow(event.turnNumber, index)) return;
      const input = finite(event.usage.input);
      const output = finite(event.usage.output);
      rerunTokens += input + output;
      if (metered) return;
      const priced = opts.pricing?.(event.specModel ?? event.model, { input, output });
      if (typeof priced === "number" && Number.isFinite(priced)) rerunUsdMicros += priced;
      else unpricedTokens += input + output;
    }
  });

  let reruns = 0;
  for (const passes of passesByTurn.values()) reruns += Math.max(0, passes.length - 1);

  return {
    rerunUsdMicros,
    judgeUsdMicros,
    totalUsdMicros: rerunUsdMicros + judgeUsdMicros,
    reruns,
    rerunTokens,
    unpricedTokens,
    unpriced: unpricedTokens > 0,
    checks,
    checkerMs,
  };
}

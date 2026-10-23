/**
 * The opt-in paraphrase-waiver judge (design §6.2, `provability.judge`): the
 * one model-backed step in the whole provability ladder, and the only one
 * `@crewhaus/provability` cannot make itself — it takes this closure as
 * `VerifyOptions.judgeWaiver` and calls it only for a `grounded` binding that
 * failed on paraphrase coverage alone (the body was fetched, the words were
 * partly found). It can flip that one binding, marked `judgeWaived: true`,
 * and nothing else.
 *
 * One yes/no call through `@crewhaus/eval-judge`'s `judgeCategorical`: the
 * passage and its source go in the sentinel-wrapped INPUT block, the claim
 * in the sentinel-wrapped OUTPUT block — both are untrusted (the passage is
 * fetched content, the claim is model output), and the judge's system
 * framing reads both as data. The answer is a forced `submit_label` call
 * over a closed two-label vocabulary, so the judge classifies and never
 * writes prose the gate would have to read. An abstention is a "no".
 *
 * Decoding is pinned to temperature 0, over a judge profile's own
 * `temperature` if it pins one: a waiver must be as reproducible as the
 * deterministic checks around it. The profile's other params
 * (`max_tokens`, `thinking`) apply as on every auxiliary slot (0.6.0 §4.2).
 *
 * Metering: the call publishes `model_request` / `model_response` with
 * `role: "judge"` on the RUN bus the turn carries — the mechanism
 * `gradeWithJudgePanel` uses — so it is priced, shown in `cost-summary` and
 * counted under `budget.judge_share`; the wire model and priced spend come
 * back on the verdict and land on the bundle (`judgeModel`, `spentUsdMicros`).
 *
 * Past the share the waiver is SKIPPED, not guessed (design §6.2): the
 * runtime's live read of the share (`ProvabilityTurn.judgeShareExhausted`)
 * is asked before every call, and once it says spent the closure answers
 * "not supported" without a model call — the binding keeps the miss the
 * deterministic check found, exactly as with no judge at all. (The
 * runtime's total cap is the stop; the share is what keeps a gate's
 * bookkeeping judge from spending the answer's budget.)
 */
import {
  type CategoricalJudgeOptions,
  type CategoricalRubric,
  judgeCategorical,
} from "@crewhaus/eval-judge";
import type { IrProvability } from "@crewhaus/ir";
import type { JudgeWaiverVerdict } from "@crewhaus/provability";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

/** The label that waives the binding. */
export const WAIVER_SUPPORTED = "supported";
/** The label that keeps it unmet. */
export const WAIVER_NOT_SUPPORTED = "not_supported";

/** The waiver's two-label vocabulary. Scores are the grader mapping, never shown to the judge. */
export const WAIVER_RUBRIC: CategoricalRubric = {
  kind: "categorical",
  labels: [
    {
      name: WAIVER_SUPPORTED,
      score: 1,
      description:
        "The source passage (the sample input) states everything the claim (the agent output) asserts, possibly in other words: every fact, figure and qualifier in the claim is in the passage.",
    },
    {
      name: WAIVER_NOT_SUPPORTED,
      score: 0,
      description:
        "The passage does not state the claim: it states only part of it, says something different or the opposite, or is about something else.",
    },
  ],
  passing_labels: [WAIVER_SUPPORTED],
};

export type WaiverJudgeOptions = {
  /** The lowered `provability.judge` slot. */
  readonly judge: NonNullable<IrProvability["judge"]>;
  /** The run bus the call meters on (the turn's). */
  readonly bus?: TraceEventBus;
  /** Test seam: a pre-built adapter that bypasses the model-router. */
  readonly adapter?: CategoricalJudgeOptions["adapter"];
  /** The run's live `budget.judge_share` read; true ⇒ the call is skipped (see the module doc). */
  readonly exhausted?: () => boolean;
};

/** Whether the share is spent; a read that throws cannot say it is. */
function shareSpent(exhausted: (() => boolean) | undefined): boolean {
  try {
    return exhausted?.() === true;
  } catch {
    return false;
  }
}

/** The judge-slot params with the temperature pin restored (see the module doc). */
function waiverParams(
  params: NonNullable<IrProvability["judge"]>["params"],
): CategoricalJudgeOptions["params"] {
  if (params === undefined) return undefined;
  const { temperature: _pinned, ...rest } = params;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The `VerifyOptions.judgeWaiver` closure for one turn. */
export function createWaiverJudge(opts: WaiverJudgeOptions): (input: {
  readonly claim: string;
  readonly excerpt: string;
  readonly source: string;
}) => Promise<JudgeWaiverVerdict> {
  const params = waiverParams(opts.judge.params);
  return async ({ claim, excerpt, source }) => {
    if (shareSpent(opts.exhausted)) return { supported: false };
    const verdict = await judgeCategorical({
      rubric: WAIVER_RUBRIC,
      sample: {
        id: "provability-waiver",
        input: `Source: ${source}\n\nPassage:\n${excerpt}`,
      },
      agentOutput: claim,
      model: opts.judge.model,
      temperature: 0,
      ...(params !== undefined ? { params } : {}),
      ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
      ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
      role: "judge",
    });
    return {
      supported: verdict.label === WAIVER_SUPPORTED && !verdict.abstain,
      model: verdict.usage.model,
      ...(verdict.usage.costUsdMicros !== undefined
        ? { costUsdMicros: verdict.usage.costUsdMicros }
        : {}),
    };
  };
}

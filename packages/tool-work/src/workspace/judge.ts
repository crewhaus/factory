/**
 * The acceptance check's judge, over `@crewhaus/eval-judge`: one call that answers one of two
 * labels. What the change must do is the sample's input and what the change adds is the output
 * being judged; both are wrapped in the judge's own markers and read as data. Decoding is
 * pinned to temperature 0, and the call is metered on the run's bus as a judge's.
 *
 * The model is the spec's own in-loop judge when it declares one, else the judge's default.
 * `eval-judge` is loaded when a judgment is made, so a reader of these records never loads a
 * model provider.
 */
import type { RunContext } from "@crewhaus/run-context";
import type { AcceptanceJudge } from "./acceptance";
import { ACCEPTANCE_DOES_NOT_MEET, ACCEPTANCE_MEETS } from "./acceptance";
import type { AcceptanceJudgeConfig } from "./bindings";

/** The judge's two labels, in the words it reads. */
export const ACCEPTANCE_RUBRIC = Object.freeze({
  kind: "categorical" as const,
  labels: [
    {
      name: ACCEPTANCE_MEETS,
      score: 1,
      description:
        "The change (the output) does what every line of the request (the input) asks. When the input says what the harness is for, the change fits it and is none of what it excludes.",
    },
    {
      name: ACCEPTANCE_DOES_NOT_MEET,
      score: 0,
      description:
        "The change leaves out something the request asks for, does something else instead, does not fit what the harness is for, or the change shown is not enough to tell.",
    },
  ],
  passing_labels: [ACCEPTANCE_MEETS],
});

/** The default judge for one run. */
export function createAcceptanceJudge(opts: {
  readonly config?: AcceptanceJudgeConfig;
  readonly rc?: RunContext;
}): AcceptanceJudge {
  return async ({ input, output }) => {
    const { judgeCategorical } = await import("@crewhaus/eval-judge");
    const params = opts.config?.params as Record<string, unknown> | undefined;
    const { temperature: _pinned, ...rest } = params ?? {};
    const verdict = await judgeCategorical({
      rubric: ACCEPTANCE_RUBRIC as Parameters<typeof judgeCategorical>[0]["rubric"],
      sample: { id: "work-acceptance", input },
      agentOutput: output,
      ...(opts.config !== undefined ? { model: opts.config.model } : {}),
      temperature: 0,
      ...(Object.keys(rest).length > 0 ? { params: rest } : {}),
      ...(opts.rc !== undefined ? { bus: opts.rc.eventBus } : {}),
      role: "judge",
    });
    return { label: verdict.label, abstain: verdict.abstain, rationale: verdict.rationale };
  };
}

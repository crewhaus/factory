/**
 * The in-loop `evaluation:` gate (loop contract 0.4, G02; 0.6.0 §6.2 / §7.3),
 * built ONCE, here, from the lowered `IrEvaluation`.
 *
 * Until 0.8.0 this closure existed four times: the three `renderEvaluation`
 * copies in target-cli / target-channel-bot / target-managed rendered it as
 * inline source, and `apps/cli`'s `buildRunEvaluation` built it for `crewhaus
 * run`. They had to agree knob for knob and were kept in step by hand. Design
 * §4.4 collapses them into this function — the `wireMemory` / `wireModels`
 * rule applied to in-loop gates — and the emitters render one
 * `wireEvaluation(…)` call instead. The behaviour is exactly the one the four
 * copies had:
 *
 *   - `llm_judge` grades through `@crewhaus/eval-judge`'s `gradeWithJudgePanel`
 *     (one `createJudgeGrader` fan-out), honouring a declared `judges` panel,
 *     `repeats`, `temperature`, `target` and the judge profile's pinned
 *     `params`; the judge model defaults to the shape's primary when the spec
 *     omitted `grader.model`. Every judge call publishes on the RUN bus the
 *     runtime hands the grader (`role: "judge"`), so it is priced and counted
 *     under `budget.judge_share`; the verdict's wire model and priced spend
 *     come back as `EvaluationResult.judge`. `judgeModel` names the
 *     INSTRUMENT up front (a panel is its members joined with `+`), so the
 *     pool's per-arm quality lineage folds the judge's identity. An
 *     abstaining judge scores 0 (`gradeWithJudgePanel` already says so).
 *   - `contains` / `regex` are pure (score 1|0, no model spend, threshold 1);
 *     the regex's `lastIndex` is reset per call so a global/sticky flag can
 *     never flip a verdict between turns.
 *
 * `threshold`, `onFail` and `maxRetries` are the IR's resolved values, and the
 * cascade's lower-time `escalateTo` is threaded only under `on_fail: escalate`.
 */
import { type JudgePanelKnobs, gradeWithJudgePanel, inLoopRunResult } from "@crewhaus/eval-judge";
import type { IrEvaluation } from "@crewhaus/ir";
import { judgeInstrumentId } from "@crewhaus/model-service";
import type { RunEvaluation } from "@crewhaus/runtime-core";

/** The `llm_judge` rubric every in-loop judge grades against: one criterion, the spec's text. */
function inLoopRubric(criteria: string) {
  return {
    criteria: [
      {
        name: "criteria",
        description: criteria,
        anchors: {
          "1": "fails the criteria entirely",
          "2": "mostly fails the criteria",
          "3": "partially meets the criteria",
          "4": "meets the criteria with minor gaps",
          "5": "fully meets the criteria",
        },
      },
    ],
    passing_score: 3,
  };
}

export type EvaluationGateOptions = {
  /** Test seam: a pre-built judge adapter that bypasses the model-router. */
  readonly judgeAdapter?: JudgePanelKnobs["adapter"];
};

/** The `RunEvaluation` for a lowered `evaluation:` block (see the module doc). */
export function buildRunEvaluation(
  ev: IrEvaluation,
  primaryModel: string,
  opts: EvaluationGateOptions = {},
): RunEvaluation {
  const grader = ev.grader;
  // 0.6.0 §7.3 (PR 9c) — the cascade's escalation rung, resolved at lower
  // time; carried only under `on_fail: escalate`.
  const escalate = ev.escalateTo !== undefined ? { escalateTo: ev.escalateTo } : {};
  if (grader.type === "llm_judge") {
    const model = grader.model ?? primaryModel;
    const rubric = inLoopRubric(grader.criteria);
    const panel = { ...grader, model };
    return {
      graderType: "llm_judge",
      judgeModel: judgeInstrumentId(panel, primaryModel),
      // The lowered default is 0.7; the floor guards hand-built IR.
      threshold: ev.threshold ?? 0.7,
      onFail: ev.onFail,
      maxRetries: ev.maxRetries,
      ...escalate,
      evaluate: async ({ finalText, messages, isSynthetic, bus }) => {
        const verdict = await gradeWithJudgePanel({
          rubric,
          sample: { id: "in-loop-evaluation", input: "" },
          run: inLoopRunResult({ finalText, messages, isSynthetic }),
          model,
          ...(grader.judges !== undefined ? { judges: grader.judges } : {}),
          ...(grader.repeats !== undefined ? { repeats: grader.repeats } : {}),
          ...(grader.temperature !== undefined ? { temperature: grader.temperature } : {}),
          ...(grader.target !== undefined ? { target: grader.target } : {}),
          ...(grader.params !== undefined ? { params: grader.params } : {}),
          ...(opts.judgeAdapter !== undefined ? { adapter: opts.judgeAdapter } : {}),
          // Judge spend rides the run bus (role "judge") — every panelist and
          // every repeat publishes its own model_request / model_response.
          bus,
        });
        return {
          score: verdict.score,
          rationale: verdict.rationale,
          judge: {
            model: verdict.judgeModel,
            ...(verdict.costUsdMicros !== undefined
              ? { costUsdMicros: verdict.costUsdMicros }
              : {}),
          },
        };
      },
    };
  }
  const value = grader.value;
  if (grader.type === "contains") {
    return {
      graderType: "contains",
      threshold: 1,
      onFail: ev.onFail,
      maxRetries: ev.maxRetries,
      ...escalate,
      evaluate: async ({ finalText }) =>
        finalText.includes(value)
          ? { score: 1, rationale: `output contains "${value}"` }
          : { score: 0, rationale: `output missing "${value}"` },
    };
  }
  // The pattern was validated compilable at parse time.
  const regex = new RegExp(value);
  return {
    graderType: "regex",
    threshold: 1,
    onFail: ev.onFail,
    maxRetries: ev.maxRetries,
    ...escalate,
    evaluate: async ({ finalText }) => {
      regex.lastIndex = 0;
      return regex.test(finalText)
        ? { score: 1, rationale: `output matches /${value}/` }
        : { score: 0, rationale: `output does not match /${value}/` };
    },
  };
}

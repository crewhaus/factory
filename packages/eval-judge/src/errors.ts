import { RuntimeError } from "@crewhaus/errors";

export class JudgeError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(`eval-judge: ${message}`, cause);
  }
}

/** Which budget refused a judge call. */
export type JudgeBudgetRefusal = {
  /** The run's cap, a sub-agent's share of it, or the harness's period. */
  readonly scope: "run" | "share" | "period";
  /** The period is filled only by reservations whose holders never finished. */
  readonly held?: true;
  /** The cap is reached counting the call still in progress this one runs inside. */
  readonly inFlight?: true;
};

/**
 * A judge call the spend meter refused: nothing was sent. `budgetRefused`
 * says which budget, so a caller that gates on the verdict can stop as any
 * refused model call stops; it is not a grader outage.
 */
export class JudgeBudgetError extends JudgeError {
  override readonly name = "JudgeBudgetError";
  readonly budgetRefused: JudgeBudgetRefusal;
  constructor(refused: JudgeBudgetRefusal) {
    super(budgetRefusalText(refused));
    this.budgetRefused = refused;
  }
}

function budgetRefusalText(r: JudgeBudgetRefusal): string {
  const whose =
    r.scope === "period"
      ? "the harness's budget for this period"
      : r.scope === "share"
        ? "this sub-agent's share of the budget"
        : "the run's budget";
  const why =
    r.held === true
      ? "is held by calls that never finished"
      : r.inFlight === true
        ? "is used up counting the call still in progress"
        : "is used up";
  return `${whose} ${why}; the judge call was not sent`;
}

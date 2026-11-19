/**
 * `budget.period` (#514, #516) as lowered: a harness-wide limit per day, week
 * or month, in USD-micros. `starts` (an ISO anchor date) and `timezone` (an
 * IANA zone, UTC when absent) are carried only when declared.
 */
export type IrBudgetPeriod = {
  readonly every: "day" | "week" | "month";
  readonly usdMicros: number;
  readonly starts?: string;
  readonly timezone?: string;
};

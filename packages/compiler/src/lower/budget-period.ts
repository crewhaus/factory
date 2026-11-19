import type { IrBudgetPeriod } from "@crewhaus/ir";

/** `budget.period` as the spec spells it. */
export type SpecBudgetPeriod = {
  readonly every: "day" | "week" | "month";
  readonly usd: number;
  readonly starts?: string;
  readonly timezone?: string;
};

/**
 * Lower `budget.period`: the limit to USD-micros (rounded, as `budget.usd`
 * is), `starts` and `timezone` only when declared. Returns `{}` when the spec
 * declares no period, so `JSON.stringify(ir.budget)` keeps its bytes.
 */
export function lowerBudgetPeriod(period: SpecBudgetPeriod | undefined): {
  period?: IrBudgetPeriod;
} {
  if (period === undefined) return {};
  return {
    period: {
      every: period.every,
      usdMicros: Math.round(period.usd * 1_000_000),
      ...(period.starts !== undefined ? { starts: period.starts } : {}),
      ...(period.timezone !== undefined ? { timezone: period.timezone } : {}),
    },
  };
}

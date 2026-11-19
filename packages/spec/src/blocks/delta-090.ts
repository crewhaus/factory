import type { Spec } from "../index";
import { budgetPeriodIssues } from "./budget-period";
import { intentIssues } from "./intent";
import { modelPriceIssues } from "./model-price";
import { pluginsIssues } from "./plugins";
import { scheduleIssues, scheduleWakeIssues } from "./schedule";

/** Reports one cross-field issue: where it is, and what to do about it. */
export type SpecAddIssue = (path: (string | number)[], message: string) => void;

/**
 * The cross-field checks of the keys added since 0.9.0, in the order
 * `crossFieldIssues` runs them, after every older check. `parseSpec` throws the
 * first issue, so the order decides which error a spec reports and a new check
 * cannot move an existing spec's first error. Append, never reorder.
 */
export const DELTA_090_ISSUES: ReadonlyArray<(data: Spec, custom: SpecAddIssue) => void> =
  Object.freeze([
    intentIssues,
    scheduleIssues,
    pluginsIssues,
    scheduleWakeIssues,
    modelPriceIssues,
    budgetPeriodIssues,
  ]);

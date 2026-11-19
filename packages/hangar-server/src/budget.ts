/**
 * A harness's budget period as Home reads it (#516, module brief 324): the period its
 * spec declares (`budget.period`), the fold of its spend ledger
 * (`@crewhaus/control-records/budget`), and the share of the period used, for the
 * harness signal. Reads only: nothing here writes a file.
 */
import {
  type BudgetFold,
  type BudgetPeriodDef,
  type BudgetPeriodSummary,
  budgetPeriodProblem,
  foldBudget,
  readBudgetPeriods,
} from "@crewhaus/control-records/budget";
import { parseYamlOnly } from "@crewhaus/spec-patch/commit";

/** The period a spec text declares, or `undefined` for none (or one it cannot use). */
export function declaredBudgetPeriod(yamlText: string): BudgetPeriodDef | undefined {
  let doc: unknown;
  try {
    doc = parseYamlOnly(yamlText);
  } catch {
    return undefined;
  }
  const period = (doc as { budget?: { period?: Record<string, unknown> } } | null)?.budget?.period;
  if (typeof period !== "object" || period === null) return undefined;
  const every = period["every"];
  const usd = period["usd"];
  if ((every !== "day" && every !== "week" && every !== "month") || typeof usd !== "number") {
    return undefined;
  }
  const def: BudgetPeriodDef = {
    every,
    usdMicros: Math.round(usd * 1_000_000),
    ...(typeof period["starts"] === "string" ? { starts: period["starts"] } : {}),
    ...(typeof period["timezone"] === "string" ? { timezone: period["timezone"] } : {}),
  };
  return budgetPeriodProblem(def) === undefined ? def : undefined;
}

/** How long a harness's fold is reused for the fleet-wide signal. */
export const BUDGET_SIGNAL_TTL_MS = 30_000;

const signalCache = new Map<string, { readonly at: number; readonly key: string; ratio: number }>();

/** How many folds the signal has made (a test counts them). */
let signalFolds = 0;

/** Folds the signal made since the process started. */
export function budgetSignalFolds(): number {
  return signalFolds;
}

/**
 * The share of the current period used, `(spent + reserved) / (cap + extensions)`, or
 * `null` when the spec declares no period. A harness's fold is reused for
 * {@link BUDGET_SIGNAL_TTL_MS}, so a fleet-wide poll never re-reads every ledger.
 */
export function budgetUsedRatio(
  harnessDir: string,
  yamlText: string,
  nowMs: number,
): number | null {
  const def = declaredBudgetPeriod(yamlText);
  if (def === undefined) {
    signalCache.delete(harnessDir);
    return null;
  }
  const key = JSON.stringify(def);
  const cached = signalCache.get(harnessDir);
  if (cached !== undefined && cached.key === key && nowMs - cached.at < BUDGET_SIGNAL_TTL_MS) {
    return cached.ratio;
  }
  signalFolds += 1;
  const fold = foldBudget(harnessDir, def, nowMs);
  const cap = fold.capUsdMicros + fold.extensionsUsdMicros;
  const ratio = cap > 0 ? (fold.spentUsdMicros + fold.reservedUsdMicros) / cap : 1;
  signalCache.set(harnessDir, { at: nowMs, key, ratio });
  return ratio;
}

/** The CLI twin of each budget read and of the raise. */
export const BUDGET_VERBS = {
  show: "crewhaus budget show",
  history: "crewhaus budget history",
  extend: "crewhaus budget extend --usd <amount> --reason <code>",
} as const;

/** `budget.get`: the current period's fold, or why there is none. */
export type BudgetRead =
  | {
      readonly present: true;
      readonly note: string;
      readonly verb: string;
      readonly fold: BudgetFold;
    }
  | { readonly present: false; readonly note: string; readonly verb: string };

/** The current period's fold for Home, answered `{present, note, verb}`. Reads only. */
export function readBudget(harnessDir: string, yamlText: string, nowMs: number): BudgetRead {
  const def = declaredBudgetPeriod(yamlText);
  if (def === undefined) {
    return {
      present: false,
      note: "No spending limit for a period: each run keeps only its own cap.",
      verb: BUDGET_VERBS.show,
    };
  }
  const fold = foldBudget(harnessDir, def, nowMs);
  return {
    present: true,
    note: fold.exhausted
      ? "This period's limit is used up: new work waits until it renews."
      : fold.unknownCalls > 0
        ? "Some calls have no price, so the spend shown is a lower bound."
        : "Spend so far this period.",
    verb: BUDGET_VERBS.show,
    fold,
  };
}

/** `budget.periods`: the closed periods' summaries, newest first. Reads only. */
export function readBudgetHistory(harnessDir: string):
  | {
      readonly present: true;
      readonly note: string;
      readonly verb: string;
      readonly periods: readonly BudgetPeriodSummary[];
      readonly gaps: number;
    }
  | { readonly present: false; readonly note: string; readonly verb: string } {
  const read = readBudgetPeriods(harnessDir);
  if (read.periods.length === 0) {
    return {
      present: false,
      note: "No period has closed yet.",
      verb: BUDGET_VERBS.history,
    };
  }
  return {
    present: true,
    note:
      read.gaps > 0 ? "Some summary lines could not be read and are left out." : "Closed periods.",
    verb: BUDGET_VERBS.history,
    periods: [...read.periods].reverse(),
    gaps: read.gaps,
  };
}

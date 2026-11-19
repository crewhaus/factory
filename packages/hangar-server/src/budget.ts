/**
 * A harness's budget period as Home reads it (#516, module brief 324): the period its
 * spec declares (`budget.period`), the fold of its spend ledger
 * (`@crewhaus/control-records/budget`), and the share of the period used, for the
 * harness signal. Reads only: nothing here writes a file.
 */
import { BUDGET_EXTEND_REASONS } from "@crewhaus/control-contract";
import {
  type BudgetFold,
  type BudgetPeriodDef,
  type BudgetPeriodSummary,
  budgetPeriodProblem,
  foldBudget,
  readBudgetPeriods,
} from "@crewhaus/control-records/budget";
import { parseYamlOnly } from "@crewhaus/spec-patch/commit";

/**
 * What a spec text says about its period. "Could not tell" is not "none": a spec that
 * could not be read (`undefined`), does not parse, or declares a period the runtime
 * cannot use answers `unreadable`; only a readable spec without `budget.period` answers
 * `none`.
 */
export type SpecBudgetPeriod =
  | { readonly kind: "period"; readonly def: BudgetPeriodDef }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

/** The period a spec text declares; `undefined` text is a spec that could not be read. */
export function budgetPeriodOf(yamlText: string | undefined): SpecBudgetPeriod {
  if (yamlText === undefined) return { kind: "unreadable" };
  let doc: unknown;
  try {
    doc = parseYamlOnly(yamlText);
  } catch {
    return { kind: "unreadable" };
  }
  const budget = (doc as { budget?: unknown } | null)?.budget;
  if (typeof budget !== "object" || budget === null) return { kind: "none" };
  if (!Object.hasOwn(budget, "period")) return { kind: "none" };
  const period = (budget as { period?: unknown }).period;
  if (typeof period !== "object" || period === null) return { kind: "unreadable" };
  const fields = period as Record<string, unknown>;
  const every = fields["every"];
  const usd = fields["usd"];
  if ((every !== "day" && every !== "week" && every !== "month") || typeof usd !== "number") {
    return { kind: "unreadable" };
  }
  const def: BudgetPeriodDef = {
    every,
    usdMicros: Math.round(usd * 1_000_000),
    ...(typeof fields["starts"] === "string" ? { starts: fields["starts"] } : {}),
    ...(typeof fields["timezone"] === "string" ? { timezone: fields["timezone"] } : {}),
  };
  return budgetPeriodProblem(def) === undefined ? { kind: "period", def } : { kind: "unreadable" };
}

/** The period a spec text declares, or `undefined` for none or one that cannot be read. */
export function declaredBudgetPeriod(yamlText: string): BudgetPeriodDef | undefined {
  const read = budgetPeriodOf(yamlText);
  return read.kind === "period" ? read.def : undefined;
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

/**
 * The exact CLI twin of each budget read and of the raise, for the harness `harness`
 * names (its id): run from anywhere, each reaches that harness, not the working
 * directory.
 */
export function budgetVerbs(harness: string): {
  readonly show: string;
  readonly history: string;
  readonly extend: string;
} {
  const at = `--harness ${harness}`;
  const reasons = `<${BUDGET_EXTEND_REASONS.join("|")}>`;
  return {
    show: `crewhaus budget show ${at}`,
    history: `crewhaus budget history ${at}`,
    extend: `crewhaus budget extend ${at} --usd <amount> --reason ${reasons}`,
  };
}

/** `budget.get`: the current period's fold, or why there is none. */
export type BudgetRead =
  | {
      readonly present: true;
      readonly note: string;
      readonly verb: string;
      readonly fold: BudgetFold;
    }
  | {
      readonly present: false;
      readonly note: string;
      readonly verb: string;
      /** Why there is no fold: no period declared, or a spec that could not be read. */
      readonly why: "no_period" | "spec_unreadable";
    };

/**
 * The current period's fold for Home, answered `{present, note, verb}`. `yamlText` is
 * `undefined` when the spec could not be read. Reads only.
 */
export function readBudget(
  harnessDir: string,
  yamlText: string | undefined,
  nowMs: number,
  harness: string,
): BudgetRead {
  const verbs = budgetVerbs(harness);
  const read = budgetPeriodOf(yamlText);
  if (read.kind === "unreadable") {
    return {
      present: false,
      why: "spec_unreadable",
      note: "The harness's spec could not be read, so its spending limit is unknown. Lint it in the harness's directory to see why.",
      verb: "crewhaus lint crewhaus.yaml",
    };
  }
  if (read.kind === "none") {
    return {
      present: false,
      why: "no_period",
      note: "No spending limit for a period: each run keeps only its own cap.",
      verb: verbs.show,
    };
  }
  const fold = foldBudget(harnessDir, read.def, nowMs);
  return {
    present: true,
    note: fold.exhausted
      ? "This period's limit is used up: new work waits until it renews."
      : fold.unknownCalls > 0
        ? "Some calls have no price, so the spend shown is a lower bound."
        : "Spend so far this period.",
    verb: verbs.show,
    fold,
  };
}

/** `budget.periods`: the closed periods' summaries, newest first. Reads only. */
export function readBudgetHistory(
  harnessDir: string,
  harness: string,
):
  | {
      readonly present: true;
      readonly note: string;
      readonly verb: string;
      readonly periods: readonly BudgetPeriodSummary[];
      readonly gaps: number;
    }
  | { readonly present: false; readonly note: string; readonly verb: string } {
  const verbs = budgetVerbs(harness);
  const read = readBudgetPeriods(harnessDir);
  if (read.periods.length === 0) {
    return {
      present: false,
      note: "No period has closed yet.",
      verb: verbs.history,
    };
  }
  return {
    present: true,
    note:
      read.gaps > 0 ? "Some summary lines could not be read and are left out." : "Closed periods.",
    verb: verbs.history,
    periods: [...read.periods].reverse(),
    gaps: read.gaps,
  };
}

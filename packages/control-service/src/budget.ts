/**
 * A raise of a harness's current budget period (#516, module brief 324): the
 * `budget.extend` command's effect. One `topup` line on the period's ledger, carrying the
 * receipt's id and its actor, applied to the current period only; a raise for any other
 * period is refused as stale (412). The exhaustion record is cleared once the raised
 * limit is above the spend. The same effect serves Home and the CLI in direct mode.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandReceipt } from "@crewhaus/control-contract";
import { type Ledger, readPage } from "@crewhaus/control-records";
import {
  type BudgetFold,
  type BudgetPeriodDef,
  budgetLedger,
  budgetPaths,
  extendBudget,
  isPeriodId,
} from "@crewhaus/control-records/budget";
import type { Settlement } from "./executor";
import { outcomeOf } from "./refusal";

/** What a raise asks for. */
export type BudgetExtendInput = {
  /** In dollars, as a person types it. */
  readonly usd: number;
  readonly reasonCode: string;
  /** The period the raise is for. */
  readonly expect: string;
};

export type BudgetExtendAnswer =
  | { readonly ok: true; readonly fold: BudgetFold }
  | { readonly ok: false; readonly code: "stale"; readonly periodId: string }
  | { readonly ok: false; readonly code: "refused"; readonly detail: string };

/**
 * Raise the current period by `input.usd` under `receipt`. Settles `succeeded` with the
 * new fold, `rejected` (`precondition_failed`) when `expect` names another period, and
 * `failed` when the ledger cannot take the line.
 *
 * First consumers: `crewhaus budget extend` and Home's `budget.extend`.
 */
export async function applyBudgetExtend(
  ctx: {
    readonly receipt: CommandReceipt;
    readonly harnessDir: string;
    readonly def: BudgetPeriodDef;
    readonly nowMs: number;
  },
  input: BudgetExtendInput,
): Promise<{ readonly settle: Settlement; readonly value: BudgetExtendAnswer }> {
  const done = await extendBudget(ctx.harnessDir, ctx.def, {
    usdMicros: Math.round(input.usd * 1_000_000),
    reasonCode: input.reasonCode,
    expect: input.expect,
    cmd: ctx.receipt.id,
    by: ctx.receipt.actor,
    nowMs: ctx.nowMs,
  });
  if (done.ok) {
    return {
      settle: { state: "succeeded", effects: [{ kind: "budget", status: "done" }] },
      value: { ok: true, fold: done.fold },
    };
  }
  if (done.reason === "stale") {
    return {
      settle: { state: "rejected", outcome: outcomeOf("precondition_failed") },
      value: { ok: false, code: "stale", periodId: done.periodId },
    };
  }
  return {
    settle: { state: "failed", outcome: outcomeOf("unavailable") },
    value: { ok: false, code: "refused", detail: done.detail },
  };
}

/** Lines read per page while looking for a receipt's topup. */
const PAGE = 512;

function ledgerNames(ledger: Ledger, cmd: string): boolean {
  let before: Parameters<typeof readPage>[1]["before"];
  for (;;) {
    const page = readPage(ledger, { limit: PAGE, ...(before !== undefined ? { before } : {}) });
    if (page.items.some((item) => item.record["cmd"] === cmd)) return true;
    if (page.next === undefined) return false;
    before = page.next;
  }
}

/**
 * Whether some period's ledger holds the topup a receipt wrote. A raw read; a period
 * directory that cannot be listed or read says no.
 *
 * First consumer: the `budget.extend` executor and reconciler.
 */
export function budgetTopupWritten(harnessDir: string, cmd: string): boolean {
  let names: string[];
  try {
    names = readdirSync(join(harnessDir, budgetPaths(harnessDir).budgetDir));
  } catch {
    return false;
  }
  return names.filter(isPeriodId).some((periodId) => {
    try {
      return ledgerNames(budgetLedger(harnessDir, periodId), cmd);
    } catch {
      return false;
    }
  });
}

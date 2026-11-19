/**
 * A raise of the current budget period (#516): one topup carrying the receipt's id and
 * actor, refused as stale for another period, and observable for recovery.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandReceipt, mintId } from "@crewhaus/control-contract";
import {
  foldBudget,
  openBudgetLedger,
  periodOf,
  readBudgetState,
} from "@crewhaus/control-records/budget";
import { applyBudgetExtend, budgetTopupWritten } from "./budget";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const harness = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "control-budget-"));
  roots.push(dir);
  return dir;
};

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const DEF = { every: "month", usdMicros: 1_000_000 } as const;
const receipt = (): CommandReceipt => ({
  id: mintId("cmd"),
  v: 1,
  kind: "budget.extend",
  target: "home/harness/hrn_0123456789abcdef",
  actor: mintId("prn"),
  via: "cli",
  fingerprint: "ab",
  state: "running",
  acceptedAt: new Date(NOW).toISOString(),
  effects: [],
  retry: { retryable: false, safety: "never" },
});

describe("applyBudgetExtend", () => {
  test("a raise for the current period is one topup with the receipt and its actor; the state clears", async () => {
    const dir = harness();
    const ledger = openBudgetLedger(dir, DEF, { now: () => NOW });
    await ledger.reserve({ id: "rsv_a", usdMicros: 10 });
    await ledger.settle({ id: "rsv_a", usdMicros: 1_000_000 });
    // The cap is used up: the next reservation writes the exhaustion record.
    expect((await ledger.reserve({ id: "rsv_b", usdMicros: 10 })).admit).toBe(false);
    expect(readBudgetState(dir).state).toBe("present");
    const r = receipt();
    const { settle, value } = await applyBudgetExtend(
      { receipt: r, harnessDir: dir, def: DEF, nowMs: NOW },
      { usd: 0.5, reasonCode: "planned-work", expect: periodOf(DEF, NOW).periodId },
    );
    expect(settle.state).toBe("succeeded");
    expect(value.ok).toBe(true);
    if (value.ok) expect(value.fold.extensionsUsdMicros).toBe(500_000);
    expect(foldBudget(dir, DEF, NOW).exhausted).toBe(false);
    expect(readBudgetState(dir).state).toBe("absent");
    expect(budgetTopupWritten(dir, r.id)).toBe(true);
    expect(budgetTopupWritten(dir, mintId("cmd"))).toBe(false);
  });

  test("a stale expect is refused as a precondition, and writes nothing", async () => {
    const dir = harness();
    const r = receipt();
    const { settle, value } = await applyBudgetExtend(
      { receipt: r, harnessDir: dir, def: DEF, nowMs: NOW },
      { usd: 1, reasonCode: "incident", expect: "month-2026-10-01" },
    );
    expect(settle.state).toBe("rejected");
    expect(settle.outcome?.code).toBe("precondition_failed");
    expect(value).toEqual({ ok: false, code: "stale", periodId: "month-2026-11-01" });
    expect(budgetTopupWritten(dir, r.id)).toBe(false);
    expect(foldBudget(dir, DEF, NOW).extensionsUsdMicros).toBe(0);
  });
});

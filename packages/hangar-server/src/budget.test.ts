/**
 * A harness's budget period as Home reads it (#516): the signal is `null` without a
 * declared period and the fold's share with one, reused between polls; every read
 * answers `{present, note, verb}` and writes nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openBudgetLedger } from "@crewhaus/control-records/budget";
import {
  BUDGET_SIGNAL_TTL_MS,
  budgetPeriodOf,
  budgetSignalFolds,
  budgetUsedRatio,
  budgetVerbs,
  declaredBudgetPeriod,
  readBudget,
  readBudgetHistory,
} from "./budget";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const harness = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hangar-budget-"));
  roots.push(dir);
  return dir;
};
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const PERIOD_SPEC = "name: h\ntarget: cli\nbudget:\n  usd: 5\n  period: {every: month, usd: 10}\n";
const NO_PERIOD_SPEC = "name: h\ntarget: cli\nbudget:\n  usd: 5\n";

/** Every path under `dir` with its size and mtime: a write anywhere changes it. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const st = statSync(path);
      out.push(`${relative(dir, path)}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out.sort();
}

describe("the harness signal", () => {
  test("null without a declared period, however much a run spent", () => {
    expect(budgetUsedRatio(harness(), NO_PERIOD_SPEC, NOW)).toBeNull();
    expect(declaredBudgetPeriod(NO_PERIOD_SPEC)).toBeUndefined();
  });

  test("(spent + reserved) / (cap + extensions) with a period, from a fold reused within its window", async () => {
    const dir = harness();
    const def = declaredBudgetPeriod(PERIOD_SPEC);
    expect(def).toEqual({ every: "month", usdMicros: 10_000_000 });
    const ledger = openBudgetLedger(dir, def as NonNullable<typeof def>, { now: () => NOW });
    await ledger.reserve({ id: "rsv_a", usdMicros: 2_000_000 });
    await ledger.settle({ id: "rsv_a", usdMicros: 1_000_000 });
    await ledger.reserve({ id: "rsv_b", usdMicros: 3_000_000 });
    const before = budgetSignalFolds();
    expect(budgetUsedRatio(dir, PERIOD_SPEC, NOW)).toBeCloseTo(0.4);
    // A second poll inside the window reads the cache; one past it folds again.
    expect(budgetUsedRatio(dir, PERIOD_SPEC, NOW + 1)).toBeCloseTo(0.4);
    expect(budgetSignalFolds()).toBe(before + 1);
    budgetUsedRatio(dir, PERIOD_SPEC, NOW + BUDGET_SIGNAL_TTL_MS);
    expect(budgetSignalFolds()).toBe(before + 2);
  });
});

describe("the budget reads", () => {
  test("without a period: present false, the reason, and the verb", () => {
    const dir = harness();
    expect(readBudget(dir, NO_PERIOD_SPEC, NOW, "h_1")).toEqual({
      present: false,
      why: "no_period",
      note: "No spending limit for a period: each run keeps only its own cap.",
      verb: "crewhaus budget show --harness h_1",
    });
    expect(readBudgetHistory(dir, "h_1")).toMatchObject({
      present: false,
      verb: "crewhaus budget history --harness h_1",
    });
  });

  test("a spec that could not be read, does not parse or declares a period it cannot use is unknown, never no limit", () => {
    const dir = harness();
    for (const text of [
      undefined,
      "budget: [unclosed",
      "budget:\n  usd: 5\n  period: {every: fortnight, usd: 10}\n",
      "budget:\n  usd: 5\n  period: {every: month, usd: 10, timezone: Mars/Olympus}\n",
      "budget:\n  usd: 5\n  period: {every: month, usd: 10, starts: 2026-01-30}\n",
    ]) {
      expect([text, budgetPeriodOf(text).kind]).toEqual([text, "unreadable"]);
      const read = readBudget(dir, text, NOW, "h_1");
      expect(read).toMatchObject({ present: false, why: "spec_unreadable" });
      expect(read.note).not.toContain("No spending limit");
    }
    expect(budgetPeriodOf(NO_PERIOD_SPEC).kind).toBe("none");
    expect(budgetPeriodOf("name: h\n").kind).toBe("none");
    expect(budgetPeriodOf(PERIOD_SPEC).kind).toBe("period");
  });

  test("each twin names the harness, and the raise names its reasons", () => {
    expect(budgetVerbs("h_1")).toEqual({
      show: "crewhaus budget show --harness h_1",
      history: "crewhaus budget history --harness h_1",
      extend:
        "crewhaus budget extend --harness h_1 --usd <amount> --reason <planned-work|incident|one-off|other>",
    });
  });

  test("with a period: the fold; and no read writes a byte", async () => {
    const dir = harness();
    const def = declaredBudgetPeriod(PERIOD_SPEC) as NonNullable<
      ReturnType<typeof declaredBudgetPeriod>
    >;
    const ledger = openBudgetLedger(dir, def, { now: () => NOW });
    await ledger.reserve({ id: "rsv_a", usdMicros: 100 });
    await ledger.settle({ id: "rsv_a", usdMicros: null });
    const before = tree(dir);
    const read = readBudget(dir, PERIOD_SPEC, NOW, "h_1");
    expect(read.present).toBe(true);
    if (read.present) {
      expect(read.fold.unknownCalls).toBe(1);
      expect(read.note).toContain("lower bound");
    }
    readBudgetHistory(dir, "h_1");
    budgetUsedRatio(dir, PERIOD_SPEC, NOW + 10 * BUDGET_SIGNAL_TTL_MS);
    expect(tree(dir)).toEqual(before);
  });
});

/**
 * Overview › Budget (#516): every state says what it is in words beside its colour, a
 * period with unpriced spend says "+ unknown" and names the verb, a used-up period names
 * its renewal, and the card and its raise form are built by `createElement` only, with
 * labelled controls and a CLI twin for every action.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGET_COPY,
  REASONS,
  budgetModel,
  shortDate,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/budget.js";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "budget.js"),
  "utf8",
);

const fold = (over: Record<string, unknown> = {}) => ({
  present: true,
  note: "",
  verb: "crewhaus budget show",
  fold: {
    periodId: "month-2026-11-01",
    every: "month",
    startsAt: "2026-11-01T00:00:00.000Z",
    renewsAt: "2026-12-01T00:00:00.000Z",
    capUsdMicros: 50_000_000,
    extensionsUsdMicros: 0,
    spentUsdMicros: 12_400_000,
    reservedUsdMicros: 0,
    unknownCalls: 0,
    exhausted: false,
    asOf: "2026-11-18T00:00:00.000Z",
    truncated: false,
    gaps: 0,
    ...over,
  },
});

describe("the budget card's model", () => {
  test("no period: each run keeps its own cap, with the verb", () => {
    const m = budgetModel({ present: false, note: "", verb: "crewhaus budget show" });
    expect(m).toMatchObject({
      state: "none",
      words: BUDGET_COPY.noPeriod,
      verb: "crewhaus budget show",
    });
  });

  test("under the limit: the spend, the limit and the renewal, in words", () => {
    const m = budgetModel(fold());
    expect(m.state).toBe("ok");
    expect(m.words).toBe("$12.40 of $50.00 used this month. Renews on 1 Dec.");
    expect(m.ratio).toBeCloseTo(0.248);
  });

  test("unpriced spend reads + unknown and is flagged, never as a whole", () => {
    const m = budgetModel(fold({ unknownCalls: 2 }));
    expect(m.state).toBe("unknown");
    expect(m.tone).toBe("warn");
    expect(m.words).toContain("$12.40 + unknown of $50.00");
  });

  test("used up: new work waits until the renewal date", () => {
    const m = budgetModel(fold({ spentUsdMicros: 50_000_000, exhausted: true }));
    expect(m.state).toBe("used-up");
    expect(m.words).toContain("New work waits until 1 Dec.");
    expect(BUDGET_COPY.raise("this month")).toBe("Raise this month's limit");
  });

  test("an unreadable answer is not a zero", () => {
    expect(budgetModel(null).state).toBe("unreadable");
    expect(shortDate("not a date")).toBe("its renewal");
  });
});

describe("the card's markup", () => {
  test("no HTML strings, every control labelled, a word beside every tone, and the twins", () => {
    expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // Each input and select is paired with a <label for>.
    expect(SOURCE).toContain('el("label", { for: amount.id');
    expect(SOURCE).toContain('el("label", { for: reason.id');
    expect(SOURCE).toContain('"aria-live": "polite"');
    expect(SOURCE).toContain("TONE_WORD[model.tone]");
    for (const verb of [
      BUDGET_COPY.extendVerb,
      BUDGET_COPY.auditVerb,
      BUDGET_COPY.compileVerb,
      BUDGET_COPY.noPeriodVerb,
    ]) {
      expect(verb.startsWith("crewhaus ")).toBe(true);
    }
    expect(REASONS.map(([code]: [string]) => code)).toEqual([
      "planned-work",
      "incident",
      "one-off",
      "other",
    ]);
    expect(BUDGET_COPY.askMaintainer).toBe("Ask a maintainer to raise the limit.");
  });
});

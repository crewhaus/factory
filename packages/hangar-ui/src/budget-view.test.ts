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
  budgetVerbs,
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
  test("no period: each run keeps its own cap, with the verb for this harness", () => {
    const m = budgetModel(
      { present: false, why: "no_period", note: "", verb: "crewhaus budget show" },
      "h_abc",
    );
    expect(m).toMatchObject({
      state: "none",
      words: BUDGET_COPY.noPeriod,
      verb: "crewhaus budget show --harness h_abc",
    });
  });

  test("a spec that could not be read is unknown, never no limit", () => {
    const m = budgetModel({
      present: false,
      why: "spec_unreadable",
      note: "The harness's spec could not be read, so its spending limit is unknown.",
      verb: "crewhaus lint crewhaus.yaml",
    });
    expect(m.state).toBe("unreadable");
    expect(m.tone).toBe("warn");
    expect(m.words).not.toContain("No limit");
    expect(m.verb).toBe("crewhaus lint crewhaus.yaml");
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

  test("the raise is offered only to a caller the server says may raise it", () => {
    const usedUp = { spentUsdMicros: 50_000_000, exhausted: true };
    expect(budgetModel({ ...fold(usedUp), you: { extend: true } }).canExtend).toBe(true);
    expect(budgetModel({ ...fold(usedUp), you: { extend: false } }).canExtend).toBe(false);
    // An answer that does not say is not a yes.
    expect(budgetModel(fold(usedUp)).canExtend).toBe(false);
    expect(SOURCE).toContain("model.canExtend === true");
    expect(SOURCE).toContain("BUDGET_COPY.askMaintainer");
  });

  test("a renewal day is read in the period's own zone", () => {
    // A Berlin month renews at local midnight on 1 Dec, which is 23:00 UTC on 30 Nov.
    const berlinMonth = budgetModel(
      fold({ timezone: "Europe/Berlin", renewsAt: "2026-11-30T23:00:00.000Z" }),
    );
    expect(berlinMonth.words).toContain("Renews on 1 Dec.");
    // A Berlin day on 19 Nov renews at the start of 20 Nov there.
    const berlinDay = budgetModel(
      fold({
        every: "day",
        timezone: "Europe/Berlin",
        renewsAt: "2026-11-19T23:00:00.000Z",
        spentUsdMicros: 50_000_000,
        exhausted: true,
      }),
    );
    expect(berlinDay.words).toContain("New work waits until 20 Nov.");
    expect(shortDate("2026-11-30T23:00:00.000Z", "Asia/Tokyo")).toBe("1 Dec");
    // No zone, or one the browser does not know, reads in UTC.
    expect(shortDate("2026-11-30T23:00:00.000Z")).toBe("30 Nov");
    expect(shortDate("2026-11-30T23:00:00.000Z", "Mars/Olympus")).toBe("30 Nov");
  });

  test("a capped or damaged ledger read says its totals are lower bounds", () => {
    for (const over of [{ truncated: true }, { gaps: 2 }]) {
      const m = budgetModel(fold(over));
      expect(m.lowerBound).toBe(true);
      expect(m.tone).toBe("warn");
      expect(m.words).toContain(BUDGET_COPY.lowerBound);
    }
    const whole = budgetModel(fold());
    expect(whole.lowerBound).toBe(false);
    expect(whole.words).not.toContain(BUDGET_COPY.lowerBound);
    const usedUp = budgetModel(fold({ exhausted: true, gaps: 1 }));
    expect(usedUp.words).toContain(BUDGET_COPY.lowerBound);
  });

  test("used up with unpriced calls keeps the unknown part and its action", () => {
    const m = budgetModel(fold({ spentUsdMicros: 50_000_000, exhausted: true, unknownCalls: 1 }));
    expect(m.state).toBe("used-up");
    expect(m.unknown).toBe(true);
    expect(m.words).toContain("+ unknown");
    // The unknown sentence and "Add a price" are drawn from `model.unknown`, in every state.
    expect(SOURCE).toContain("if (model.unknown === true)");
    expect(SOURCE).toContain("twin(BUDGET_COPY.auditVerb, BUDGET_COPY.addPrice)");
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
    for (const verb of [BUDGET_COPY.auditVerb, BUDGET_COPY.compileVerb]) {
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

describe("the card's CLI twins", () => {
  test("each names this harness, and the raise's follows the amount and the reason", () => {
    const verbs = budgetVerbs("h_abc");
    expect(verbs.show).toBe("crewhaus budget show --harness h_abc");
    expect(verbs.extend()).toBe(
      "crewhaus budget extend --harness h_abc --usd <amount> --reason <planned-work|incident|one-off|other>",
    );
    expect(verbs.extend(50, "incident")).toBe(
      "crewhaus budget extend --harness h_abc --usd 50.00 --reason incident",
    );
    // A reason outside the closed list never reaches the twin.
    expect(verbs.extend(5, "rm -rf")).toContain("--reason <planned-work|");
  });
});

describe("after a raise", () => {
  test("the sentence stays outside the redrawn part, is announced once, and focus goes to the heading", () => {
    // The redraw replaces `content` only; `done` is the card's own, after it.
    expect(SOURCE).toContain("content.replaceChildren(...children)");
    expect(SOURCE).not.toContain("section.replaceChildren");
    expect(SOURCE).toContain("done.textContent = words");
    expect(SOURCE).toContain('tabindex: "-1"');
    expect(SOURCE).toContain("heading?.focus()");
    // One announcement: the global region, never the form's status line as well.
    expect(SOURCE.match(/announce\(/g)?.length).toBe(1);
    expect(SOURCE).not.toContain("status.textContent = words");
    // A refusal keeps focus on the amount and marks it.
    expect(SOURCE).toContain('amount.setAttribute("aria-invalid", "true")');
    expect(SOURCE).toContain('"aria-describedby": status.id');
  });
});

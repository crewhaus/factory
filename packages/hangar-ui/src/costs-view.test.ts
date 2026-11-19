/**
 * Costs: a call with no price is unknown, never $0 (#516). The total says "+ unknown",
 * a model with no price says so and names the verb that lists them, and a day whose
 * calls all had no price gets no bar. DOM only by `createElement` and `textContent`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRICE_AUDIT_VERB,
  UNPRICED_COST,
  dayRow,
  totalText,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/views/costs.js";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "assets", "js", "views", "costs.js"),
  "utf8",
);

describe("unknown cost in the costs view", () => {
  test("a total with unknown parts reads + unknown; a priced one does not", () => {
    expect(totalText(1_200_000, 2)).toBe("$1.20 + unknown");
    expect(totalText(1_200_000, 0)).toBe("$1.20");
  });

  test("a day of only unpriced calls is unknown, a partly unpriced one is marked, a priced one is plain", () => {
    expect(
      dayRow({ day: "2026-11-18", usdMicros: 0, calls: 2, unpricedCalls: 2 }).value,
    ).toBeNull();
    expect(dayRow({ day: "2026-11-18", usdMicros: 1000, calls: 3, unpricedCalls: 1 })).toEqual({
      label: "2026-11-18",
      value: 0.001,
      unknownPart: true,
    });
    expect(dayRow({ day: "2026-11-18", usdMicros: 1000, calls: 3 })).toEqual({
      label: "2026-11-18",
      value: 0.001,
    });
  });

  test("a model with no price says so and names the verb, in words, never by colour alone", () => {
    expect(UNPRICED_COST).toBe("Unknown: no price");
    expect(PRICE_AUDIT_VERB).toBe("crewhaus models audit");
    expect(SOURCE).toContain("UNPRICED_COST");
    expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

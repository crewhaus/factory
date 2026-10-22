import { describe, expect, test } from "bun:test";
import { BUILTIN_LIMITS, Budget, CheckFailure } from "./budget";
import { domainValues, evalFormula, explainFalse } from "./evaluate";
import { parseFormula } from "./syntax";

const ev = (s: string, budget = new Budget(5_000)): boolean =>
  evalFormula(parseFormula(s), undefined, budget);

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CheckFailure) return err.message;
    throw err;
  }
  throw new Error("expected a CheckFailure");
}

describe("evaluation — exact arithmetic", () => {
  test("rationals, not floats", () => {
    expect(ev("0.1 + 0.2 = 0.3")).toBe(true);
    expect(ev("1/3 + 1/3 + 1/3 = 1")).toBe(true);
    expect(ev("1284.50 = 1000 + 284.5")).toBe(true);
  });

  test("functions and powers", () => {
    expect(ev("abs(-2.5) = 2.5 and min(3, 1, 2) = 1 and max(-1, -7) = -1")).toBe(true);
    expect(ev("2^10 = 1024 and (1/2)^3 = 0.125 and 7^0 = 1")).toBe(true);
    expect(ev("-2^2 = -4 and (-2)^2 = 4")).toBe(true);
  });

  test("every comparison operator", () => {
    expect(ev("1 = 1 and 1 != 2 and 1 < 2 and 2 <= 2 and 3 > 2 and 3 >= 3")).toBe(true);
    expect(ev("1 > 2")).toBe(false);
  });

  test("errors are errors, not values", () => {
    expect(failure(() => ev("1 / 0 = 1"))).toMatch(/division by zero/);
    expect(failure(() => ev("2^(1/2) = 1"))).toMatch(/non-negative integer/);
    expect(failure(() => ev("let s = [1, 2] in s[2] = 1"))).toMatch(/index 2 is outside/);
    expect(failure(() => ev("let s = [1, 2] in s[0.5] = 1"))).toMatch(/index 0.5 is outside/);
    expect(failure(() => ev("x = 1"))).toMatch(/`x` has no value/);
  });

  test("and/or/-> stop early, so a guard protects a division", () => {
    expect(ev("forall x in {0, 1, 2}: x = 0 or 1/x <= 1")).toBe(true);
    expect(ev("forall x in {0, 1}: x != 0 -> 1/x = 1")).toBe(true);
    expect(ev("false and 1/0 = 1")).toBe(false);
    expect(failure(() => ev("true and 1/0 = 1"))).toMatch(/division by zero/);
  });

  test("connectives", () => {
    expect(ev("not false and (false or true) and (false -> false) and (true <-> true)")).toBe(true);
    expect(ev("true -> false")).toBe(false);
    expect(ev("true <-> false")).toBe(false);
  });
});

describe("evaluation — quantifiers and domains", () => {
  test("ranges are inclusive; an empty range makes forall true and exists false", () => {
    expect(ev("forall i in 0..3: i <= 3")).toBe(true);
    expect(ev("exists i in 0..3: i = 3")).toBe(true);
    expect(ev("forall i in 3..2: false")).toBe(true);
    expect(ev("exists i in 3..2: true")).toBe(false);
  });

  test("domains may depend on outer variables", () => {
    expect(ev("forall i in 0..4: forall j in i..4: i <= j")).toBe(true);
  });

  test("set domains keep their values as written", () => {
    const vals = domainValues(
      (parseFormula("forall x in {1/2, 3}: true") as { dom: never }).dom,
      undefined,
      new Budget(1_000),
    );
    expect(vals.map((v) => v.term.k)).toEqual(["div", "num"]);
  });

  test("range bounds must be integers", () => {
    expect(failure(() => ev("forall i in 0..2.5: true"))).toMatch(/integer bounds/);
  });

  test("a domain above the cap is refused", () => {
    expect(failure(() => ev(`forall i in 1..${BUILTIN_LIMITS.maxDomainSize + 1}: true`))).toMatch(
      /the cap is 10000/,
    );
    expect(ev(`forall i in 1..${BUILTIN_LIMITS.maxDomainSize}: i > 0`)).toBe(true);
  });

  test("total enumeration is capped across nested quantifiers", () => {
    const budget = new Budget(60_000);
    expect(failure(() => ev("forall i in 1..10000: forall j in 1..10000: true", budget))).toMatch(
      /more than 1000000 quantifier cases/,
    );
  });

  test("the deadline and the abort signal stop a long evaluation", () => {
    expect(
      failure(() => ev("forall i in 1..10000: forall j in 1..99: i * j > 0", new Budget(0))),
    ).toMatch(/ran out of time/);
    const ac = new AbortController();
    ac.abort();
    expect(
      failure(() =>
        ev("forall i in 1..10000: forall j in 1..99: i * j > 0", new Budget(60_000, ac.signal)),
      ),
    ).toMatch(/cancelled/);
  });
});

describe("counterexamples", () => {
  test("a false forall names the falsifying assignment and the failing comparisons", () => {
    const f = parseFormula(
      "let s = [9, 10.5, 10], e = [10, 11, 12] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]",
    );
    const budget = new Budget(5_000);
    expect(evalFormula(f, undefined, budget)).toBe(false);
    expect(explainFalse(f, undefined, budget)).toBe(
      "i = 1, j = 2: 1 = 2 is false; 11 <= 10 is false; 12 <= 10.5 is false",
    );
  });

  test("a true exists under not names its witness", () => {
    const f = parseFormula("not (exists x in {1, 4, 9}: x > 3)");
    expect(explainFalse(f, undefined, new Budget(1_000))).toBe("x = 4: 4 > 3 is true");
  });

  test("a false exists says no value satisfies it", () => {
    const f = parseFormula("exists x in {1, 2}: x > 3");
    expect(explainFalse(f, undefined, new Budget(1_000))).toMatch(/no x in the domain/);
  });

  test("conjunctions point at the false conjunct; implications at the conclusion", () => {
    expect(explainFalse(parseFormula("1 = 1 and 2 = 3"), undefined, new Budget(1_000))).toBe(
      "2 = 3 is false",
    );
    expect(explainFalse(parseFormula("1 = 1 -> 2 > 3"), undefined, new Budget(1_000))).toBe(
      "2 > 3 is false",
    );
    expect(explainFalse(parseFormula("true <-> false"), undefined, new Budget(1_000))).toMatch(
      /left side of `<->` is true and the right side is false/,
    );
  });
});

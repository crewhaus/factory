import { describe, expect, test } from "bun:test";
import { BUILTIN_LIMITS, Budget, CheckFailure } from "./budget";
import {
  type Formula,
  formulaEq,
  freeVars,
  parseFormula,
  parseValue,
  printFormula,
  subst,
} from "./syntax";

const budget = (): Budget => new Budget(5_000);
const p = (s: string): Formula => parseFormula(s);
const roundTrip = (s: string): string => printFormula(p(s));

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CheckFailure) return err.message;
    throw err;
  }
  throw new Error("expected a CheckFailure");
}

describe("parser — precedence and associativity", () => {
  test("arithmetic binds tighter than comparison, comparison than not, not than and", () => {
    expect(roundTrip("not 1 + 2 * 3 = 7 and true")).toBe("not 1 + 2 * 3 = 7 and true");
    expect(roundTrip("(1 + 2) * 3 = 9")).toBe("(1 + 2) * 3 = 9");
  });

  test("and > or > -> > <->", () => {
    const f = p("a = 1 or b = 1 and c = 1 -> d = 1 <-> e = 1");
    expect(f.k).toBe("iff");
    if (f.k !== "iff") return;
    expect(f.a.k).toBe("imp");
    if (f.a.k !== "imp") return;
    expect(f.a.a.k).toBe("or");
    if (f.a.a.k !== "or") return;
    expect(f.a.a.b.k).toBe("and");
  });

  test("-> is right-associative", () => {
    const f = p("a = 1 -> b = 1 -> c = 1");
    expect(f.k === "imp" && f.b.k === "imp").toBe(true);
    expect(printFormula(f)).toBe("a = 1 -> b = 1 -> c = 1");
    expect(roundTrip("(a = 1 -> b = 1) -> c = 1")).toBe("(a = 1 -> b = 1) -> c = 1");
  });

  test("^ is right-associative and binds tighter than unary minus", () => {
    expect(roundTrip("2^3^2 = 512")).toBe("2^3^2 = 512");
    expect(roundTrip("-x^2 = 0 - x^2")).toBe("-x^2 = 0 - x^2");
    expect(roundTrip("(2^3)^2 = 64")).toBe("(2^3)^2 = 64");
  });

  test("subtraction and division are left-associative", () => {
    expect(roundTrip("a - (b - c) = a - b + c")).toBe("a - (b - c) = a - b + c");
    expect(roundTrip("a / b / c = a / (b * c)")).toBe("a / b / c = a / (b * c)");
  });

  test("comparisons and <-> do not chain", () => {
    expect(failure(() => p("1 < 2 < 3"))).toMatch(/do not chain/);
    expect(failure(() => p("true <-> true <-> true"))).toMatch(/does not chain/);
  });

  test("a binder body runs to the end; printing re-adds parentheses where needed", () => {
    const f = p("x = 1 and forall i in 0..2: i >= 0 or i < 0");
    expect(f.k).toBe("and");
    expect(printFormula(f)).toBe("x = 1 and (forall i in 0..2: i >= 0 or i < 0)");
    expect(formulaEq(p(printFormula(f)), f, budget())).toBe(true);
  });

  test("Unicode and ASCII aliases read as the canonical spelling", () => {
    expect(
      formulaEq(
        p("∀ x ∈ {1, 2}: x ≥ 1 ∧ ¬(x ≠ x) → x ≤ 2"),
        p("forall x in {1, 2}: x >= 1 and not (x != x) -> x <= 2"),
        budget(),
      ),
    ).toBe(true);
    expect(
      formulaEq(p("a == 1 && b = 2 || !c = 3"), p("a = 1 and b = 2 or not c = 3"), budget()),
    ).toBe(true);
    expect(formulaEq(p("2 × 3 = 6 <=> 6 ÷ 2 = 3"), p("2 * 3 = 6 <-> 6 / 2 = 3"), budget())).toBe(
      true,
    );
  });

  test("numbers: decimals are exact literals, -n is a literal", () => {
    expect(formulaEq(p("10.50 = 10.5"), p("10.5 = 10.50"), budget())).toBe(true);
    expect(formulaEq(p("-3 = x"), p("-(3) = x"), budget())).toBe(true);
    expect(roundTrip("x = -3")).toBe("x = -3");
    // `0..5` is a range, not the decimal `0.`
    expect(roundTrip("forall i in 0..5: i >= 0")).toBe("forall i in 0..5: i >= 0");
  });

  test("abs, min, max and multi-variable quantifiers", () => {
    expect(roundTrip("abs(-2) + min(1, 2, 3) = max(3, 0)")).toBe(
      "abs(-2) + min(1, 2, 3) = max(3, 0)",
    );
    expect(
      formulaEq(
        p("forall i, j in 0..1: i + j >= 0"),
        p("forall i in 0..1: forall j in 0..1: i + j >= 0"),
        budget(),
      ),
    ).toBe(true);
  });
});

describe("parser — let and arrays", () => {
  test("let expands at parse time; data names do not matter to equality", () => {
    expect(
      formulaEq(
        p("let s = [9, 10.5], e = [10, 12] in e[0] <= s[1]"),
        p("let a = [9, 10.5], b = [10, 12] in b[0] <= a[1]"),
        budget(),
      ),
    ).toBe(true);
    expect(printFormula(p("let s = [9, 10.5] in s[1] > s[0]"))).toBe("[9, 10.5][1] > [9, 10.5][0]");
  });

  test("let is sequential and scalar values substitute", () => {
    expect(formulaEq(p("let a = 2, b = a * 3 in b = 6"), p("2 * 3 = 6"), budget())).toBe(true);
  });

  test("an array must be indexed and only an array can be", () => {
    expect(failure(() => p("let s = [1, 2] in s = 1"))).toMatch(/array cannot be used/);
    expect(failure(() => p("x[0] = 1"))).toMatch(/only an array can be indexed/);
    expect(failure(() => p("let s = [1] in s + 1 = 2"))).toMatch(/array cannot be used/);
  });

  test("a let value whose variable a quantifier inside its scope rebinds is refused (capture)", () => {
    expect(failure(() => p("let a = i in forall i in 0..2: a = i"))).toMatch(/rebinds/);
  });

  test("shadowing a bound or let name is refused", () => {
    expect(failure(() => p("forall i in 0..1: forall i in 0..1: i = i"))).toMatch(/already bound/);
    expect(failure(() => p("let s = 1 in forall s in 0..1: s = s"))).toMatch(/already bound/);
    expect(failure(() => p("forall i, i in 0..1: true"))).toMatch(/listed twice/);
  });

  test("a let value must be a number or an array", () => {
    expect(failure(() => p("let s = (1 = 1) in true"))).toMatch(/number or an array/);
  });
});

describe("parser — refusals carry a position", () => {
  test("syntax errors name line and column", () => {
    expect(failure(() => p("1 + (2"))).toMatch(/^line 1, column 7: expected `\)`/);
    expect(failure(() => p("x = 1 and\n  @"))).toMatch(
      /^line 2, column 3: unexpected character "@"/,
    );
    expect(failure(() => p("x = 1 y"))).toMatch(/unexpected `y` after the end/);
  });

  test("sorts are checked: a number is not a formula and vice versa", () => {
    expect(failure(() => p("1 + 2"))).toMatch(/expected a formula as a statement/);
    expect(failure(() => p("(1 = 1) + 2 = 3"))).toMatch(/expected a number expression/);
    expect(failure(() => p("x = 1 and 2"))).toMatch(/expected a formula/);
  });

  test("unbounded quantifiers are refused with a pointer to smt / lean4", () => {
    for (const s of [
      "forall x: x >= 0",
      "forall n in Nat: n >= 0",
      "exists x in ℕ: x = 0",
      "forall x in N: x = x",
    ]) {
      const msg = failure(() => p(s));
      expect(msg).toMatch(/smt or lean4/);
    }
  });

  test("caps: statement length, nesting depth, expanded size", () => {
    expect(failure(() => p(`x = ${"1 + ".repeat(6_000)}1`))).toMatch(/characters; the cap/);
    expect(failure(() => p(`${"(".repeat(300)}true${")".repeat(300)}`))).toMatch(/nests more than/);
    // Each let doubles the expansion: 2^20 nodes from a tiny text.
    const lets = Array.from({ length: 20 }, (_, i) => `a${i + 1} = a${i} + a${i}`).join(", ");
    expect(failure(() => p(`let a0 = 1, ${lets} in a20 = 0`))).toMatch(/expands to more than/);
    expect(BUILTIN_LIMITS.maxFormulaNodes).toBe(200_000);
  });

  test("a long chain of lets is refused at once, not after an exponential walk", () => {
    // Each `let` doubles the expansion. The parser used to walk every use's
    // value for its free variables before the size cap ran: 26 lets took 3 s,
    // and each more doubled it (adversarial review, W1-D).
    const lets = Array.from({ length: 40 }, (_, i) => `a${i + 1} = a${i} + a${i}`).join(", ");
    const started = performance.now();
    expect(failure(() => p(`let a0 = x, ${lets} in a40 = 0`))).toMatch(/expands to more than/);
    // Inside a quantifier domain, and with the capture check exercised.
    expect(
      failure(() => p(`let a0 = x, ${lets} in forall i in {a40}: forall y in {1}: a40 = i`)),
    ).toMatch(/expands to more than/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("parsing spends from the budget: a cancelled signal stops it", () => {
    const ac = new AbortController();
    ac.abort();
    const long = `x = ${Array.from({ length: 400 }, (_, i) => `term_number_${i}`).join(" + ")}`;
    expect(long.length).toBeGreaterThan(4_096);
    expect(failure(() => parseFormula(long, new Budget(5_000, ac.signal)))).toMatch(/cancelled/);
    expect(() => parseFormula(long)).not.toThrow();
  });

  test("a let value's variables are still checked against quantifiers that would capture them", () => {
    expect(failure(() => p("let a = x + 1, b = a * 2 in forall x in {1}: b = 4"))).toMatch(
      /`b` uses `x`, which a quantifier inside its scope rebinds/,
    );
    expect(p("let a = x + 1, b = a * 2 in forall y in {1}: b = 4")).toBeDefined();
  });

  test("a multi-name binder's domain may not mention its own names", () => {
    // `forall x, y in {x + 1}` nests as `forall x in {x + 1}: forall y in {x + 1}`,
    // where the inner x would be the outer binder and the outer x free.
    expect(failure(() => p("forall x, y in {x + 1}: y = x + 1"))).toMatch(
      /the domain mentions `x`, which this quantifier also binds; write the quantifiers separately/,
    );
    expect(failure(() => p("let d = [y] in exists x, y in {d[0]}: x = y"))).toMatch(
      /the domain mentions `y`/,
    );
    // One name: the domain is outside the binder, so `x` there is the free x.
    expect(freeVars(p("forall x in {x + 1}: x > 0"))).toEqual(new Set(["x"]));
    expect([...freeVars(p("forall x, y in {z}: x = y"))]).toEqual(["z"]);
  });
});

describe("printing round-trips", () => {
  const cases = [
    "forall i in 0..5: forall j in 0..5: i = j or [10, 11][0] <= [9, 10.5][1]",
    "exists x in {1, 2.5, -3}: x * x = 6.25",
    "not (a = 1 or b = 2) <-> not a = 1 and not b = 2",
    "(forall x in {1}: x = 1) and (exists y in {2}: y = 2)",
    "x - -3 = x + 3",
    "(-3)^2 = 9",
    "2^-1 = 0.5",
    "abs(x - y) <= max(x, y) - min(x, y)",
  ];
  for (const text of cases) {
    test(text, () => {
      const f = p(text);
      const printed = printFormula(f);
      expect(formulaEq(p(printed), f, budget())).toBe(true);
      expect(printFormula(p(printed))).toBe(printed);
    });
  }
});

describe("alpha-equality, free variables and substitution", () => {
  test("bound names do not matter; free names do", () => {
    expect(formulaEq(p("forall i in 0..2: i >= 0"), p("forall k in 0..2: k >= 0"), budget())).toBe(
      true,
    );
    expect(formulaEq(p("forall i in 0..2: i >= x"), p("forall i in 0..2: i >= y"), budget())).toBe(
      false,
    );
    expect(formulaEq(p("forall i in 0..2: i >= x"), p("forall x in 0..2: x >= x"), budget())).toBe(
      false,
    );
  });

  test("free variables exclude bound ones but include domains", () => {
    expect([...freeVars(p("forall i in 0..n: i <= m"))].sort()).toEqual(["m", "n"]);
  });

  test("substitution is capture-avoiding", () => {
    const f = p("forall i in 0..2: i < x");
    const out = subst(f, "x", { k: "var", name: "i" }, budget());
    // The bound i was renamed, so the substituted (free) i is not captured.
    expect(printFormula(out)).toBe("forall i_1 in 0..2: i_1 < i");
    expect(formulaEq(out, p("forall k in 0..2: k < i"), budget())).toBe(true);
  });

  test("substitution stops at a binder of the same name but reaches its domain", () => {
    const f = p("forall x in 0..x: x >= 0");
    expect(printFormula(subst(f, "x", parseValue("5"), budget()))).toBe("forall x in 0..5: x >= 0");
  });

  test("substituting a number into -x folds to a literal", () => {
    const f = subst(p("-x = 3"), "x", parseValue("-3"), budget());
    expect(formulaEq(f, p("3 = 3"), budget())).toBe(true);
  });

  test("parseValue accepts closed terms only", () => {
    // A value is kept as written (instantiate substitutes what the model wrote).
    expect(parseValue("1/3").k).toBe("div");
    expect(parseValue("-2.5")).toEqual({ k: "num", v: { n: -5n, d: 2n } });
    expect(failure(() => parseValue("x + 1"))).toMatch(/must be closed/);
    expect(failure(() => parseValue("1 = 1"))).toMatch(/unexpected `=` after the value/);
    expect(failure(() => parseValue("[1, 2]"))).toMatch(/array cannot be used/);
  });
});

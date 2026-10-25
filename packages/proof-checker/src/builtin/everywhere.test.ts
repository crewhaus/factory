import { describe, expect, test } from "bun:test";
import { Budget, CheckFailure } from "./budget";
import { type Everywhere, everywhere, neverTrue } from "./everywhere";
import { parseFormula } from "./syntax";

const facts = (src: string): Everywhere => everywhere(parseFormula(src), new Budget(10_000));
const refute = (src: string, budget = new Budget(10_000)) => neverTrue(parseFormula(src), budget);

const TRUE: Everywhere = {
  alwaysTrue: true,
  alwaysFalse: false,
  neverTrue: false,
  neverFalse: true,
};
const FALSE: Everywhere = {
  alwaysTrue: false,
  alwaysFalse: true,
  neverTrue: true,
  neverFalse: false,
};
const UNKNOWN: Everywhere = {
  alwaysTrue: false,
  alwaysFalse: false,
  neverTrue: false,
  neverFalse: false,
};

describe("everywhere — what holds at every value of the free variables", () => {
  test("closed formulas evaluate; one that fails to evaluate is unknown", () => {
    expect(facts("2 > 1")).toEqual(TRUE);
    expect(facts("forall i in 0..3: i < 3")).toEqual(FALSE);
    expect(facts("1 / 0 = 1")).toEqual(UNKNOWN);
  });

  test("a comparison is decided when its sides differ by a constant polynomial", () => {
    expect(facts("x + 1 > x")).toEqual(TRUE);
    expect(facts("y - y = 0")).toEqual(TRUE);
    expect(facts("y * 0 = 1")).toEqual(FALSE);
    expect(facts("(a + b)^2 = a^2 + 2*a*b + b^2 + 1")).toEqual(FALSE);
    // Not constant, or not a polynomial: unknown.
    expect(facts("x * x >= 0")).toEqual(UNKNOWN);
    expect(facts("1 / x = 1 / x")).toEqual(UNKNOWN);
    expect(facts("abs(x) >= 0")).toEqual(UNKNOWN);
    expect(facts("x + 1 / 0 = x")).toEqual(UNKNOWN);
  });

  test("`not` swaps the facts", () => {
    expect(facts("not y * 0 = 1")).toEqual(TRUE);
    expect(facts("not x + 1 > x")).toEqual(FALSE);
  });

  test("`and` stops at a false left side; a never-true side makes it never true", () => {
    expect(facts("y = y and 1 = 2")).toEqual(FALSE);
    expect(facts("1 = 2 and abs(y) >= 0")).toEqual(FALSE);
    // The left side may fail to evaluate where the right is never reached,
    // so `abs(y) >= 0 and 1 = 2` is never true but not "false without error".
    expect(facts("abs(y) >= 0 and 1 = 2")).toEqual({ ...UNKNOWN, neverTrue: true });
    expect(facts("y = y and x + 1 > x")).toEqual(TRUE);
    expect(facts("abs(y) >= 0 and y = y")).toEqual(UNKNOWN);
  });

  test("`or` stops at a true left side", () => {
    expect(facts("1 = 1 or abs(y) > 0")).toEqual(TRUE);
    expect(facts("y * 0 = 1 or y = y")).toEqual(TRUE);
    expect(facts("y * 0 = 1 or 2 < 1")).toEqual(FALSE);
    expect(facts("abs(y) >= 0 or 1 = 1")).toEqual({ ...UNKNOWN, neverFalse: true });
    expect(facts("abs(y) > 0 or 1 = 2")).toEqual(UNKNOWN);
  });

  test("`->` is true where its premise is false", () => {
    expect(facts("1 = 2 -> abs(y) > 0")).toEqual(TRUE);
    expect(facts("1 = 1 -> y * 0 = 1")).toEqual(FALSE);
    // Nothing here knows `abs(y) >= 0` holds, so this stays unknown: the
    // residual the README names.
    expect(facts("abs(y) >= 0 -> 1 = 2")).toEqual(UNKNOWN);
    expect(facts("abs(y) >= 0 -> y = y")).toEqual({ ...UNKNOWN, neverFalse: true });
  });

  test("`<->` evaluates both sides", () => {
    expect(facts("x = x <-> 1 = 2")).toEqual(FALSE);
    expect(facts("y * 0 = 1 <-> 1 = 2")).toEqual(TRUE);
    expect(facts("x = x <-> abs(y) > 0")).toEqual(UNKNOWN);
    expect(facts("abs(y) > 0 <-> 1 = 2 and abs(y) > 0")).toEqual(UNKNOWN);
  });

  test("a quantifier over a closed domain inherits its body's facts", () => {
    expect(facts("forall i in 0..3: y * 0 = i + 1")).toEqual(UNKNOWN);
    expect(facts("forall i in 0..3: y = y and 1 = 2")).toEqual(FALSE);
    expect(facts("exists i in {1, 2}: y + i = i + y")).toEqual(TRUE);
    // Empty: `forall` is true and `exists` false, whatever the body.
    expect(facts("forall i in 1..0: y * 0 = 1")).toEqual(TRUE);
    expect(facts("exists i in {}: y = y")).toEqual(FALSE);
    // A domain over a free variable is not read.
    expect(facts("forall i in 0..y: 1 = 2")).toEqual(UNKNOWN);
  });
});

describe("neverTrue — the refutation of an open formula", () => {
  test("names one assignment and why it fails there", () => {
    expect(refute("y = y and 1 = 2")).toEqual({ at: "y = 0", why: "1 = 2 is false" });
    expect(refute("x * 0 = y - y + 1")).toEqual({ at: "x = 0, y = 0", why: "0 = 1 is false" });
    // An evaluation error at that assignment is its reason.
    expect(refute("1 / y > 0 and 1 = 2")).toEqual({ at: "y = 0", why: "division by zero" });
  });

  test("closed, unknown and true formulas refute nothing", () => {
    expect(refute("1 = 2")).toBeUndefined();
    expect(refute("abs(y) >= 0 -> 1 = 2")).toBeUndefined();
    expect(refute("y = y")).toBeUndefined();
  });

  test("a spent budget is inconclusive; a cancelled one rejects", () => {
    expect(refute("y = y and 1 = 2", new Budget(-1))).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(() => refute("y = y and 1 / 0 = 1", new Budget(10_000, controller.signal))).toThrow(
      new CheckFailure("the check was cancelled"),
    );
  });
});

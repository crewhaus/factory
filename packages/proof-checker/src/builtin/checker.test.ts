import { describe, expect, spyOn, test } from "bun:test";
import { BUILTIN_LIMITS, Budget } from "./budget";
import {
  BUILTIN_CHECKER_ID,
  BUILTIN_LANGUAGE,
  BUILTIN_RULES,
  type BuiltinVerdict,
  checkCertificate,
} from "./checker";
import { createBuiltinChecker } from "./runner";

type StepIn = {
  id: string;
  stmt: string;
  by: string;
  from?: string[];
  with?: Record<string, unknown>;
};

const check = (statement: string, steps: StepIn[] | string): BuiltinVerdict =>
  checkCertificate({
    statement,
    proof: typeof steps === "string" ? steps : JSON.stringify(steps),
  });

function accepted(v: BuiltinVerdict): void {
  if (!v.ok) throw new Error(`expected ok, got: ${v.reason}`);
  expect(v.reason).toBeUndefined();
}

function rejected(v: BuiltinVerdict, reason: RegExp): void {
  expect(v.ok).toBe(false);
  expect(v.reason ?? "").toMatch(reason);
}

// design §0 scenario C: six meetings, start and end times.
const STARTS = "[9, 10.5, 12, 13.5, 15, 16.5]";
const ENDS_OK = "[10, 11.5, 13, 14.5, 16, 17.5]";
const ENDS_OVERLAP = "[10, 11.5, 13, 15.75, 16, 17.5]"; // meeting 3 runs into meeting 4
const noOverlap = (ends: string): string =>
  `let s = ${STARTS}, e = ${ends} in forall i in 0..5: forall j in 0..5: i = j or e[i] <= s[j] or e[j] <= s[i]`;

describe("acceptance — design §0 scenario C (no two of the six meetings overlap)", () => {
  test("a true claim is proven by eval over the finite set", () => {
    const v = check(noOverlap(ENDS_OK), "eval");
    accepted(v);
    expect(v.assumptions).toEqual([]);
    expect(v.axioms).toEqual([]);
    expect(v.output).toMatch(/s1 eval: true \(42 cases\)/);
  });

  test("a false claim yields a counterexample naming the pair", () => {
    const v = check(noOverlap(ENDS_OVERLAP), "eval");
    rejected(v, /the formula is false/);
    expect(v.counterexample).toBe(
      "i = 3, j = 4: 3 = 4 is false; 15.75 <= 15 is false; 16 <= 13.5 is false",
    );
  });

  test("the full certificate form is accepted too", () => {
    accepted(check(noOverlap(ENDS_OK), [{ id: "s1", stmt: noOverlap(ENDS_OK), by: "eval" }]));
    accepted(
      check(
        noOverlap(ENDS_OK),
        `{"steps": [{"id": "s1", "stmt": ${JSON.stringify(noOverlap(ENDS_OK))}, "by": "eval"}]}`,
      ),
    );
  });
});

describe("inconsistent hypotheses never prove a claim", () => {
  // The false scenario-C claim, "proved" from two contradictory hypotheses
  // about a variable it never mentions (adversarial review, W1-D).
  const falseClaim = noOverlap(ENDS_OVERLAP);

  test("a closed statement refuses open givens, so the false scenario C stays false", () => {
    const v = check(falseClaim, [
      { id: "h1", stmt: "k = 0", by: "given" },
      { id: "h2", stmt: "k = 1", by: "given" },
      { id: "z", stmt: "1 = 0", by: "subst", from: ["h2", "h1"] },
      { id: "n", stmt: "not 1 = 0", by: "eval" },
      { id: "done", stmt: falseClaim, by: "contra", from: ["z", "n"] },
    ]);
    rejected(
      v,
      /step h1 \(given\): the statement is closed, so a hypothesis about `k` cannot bear on it/,
    );
    // The retry nudge still names the overlapping pair.
    expect(v.counterexample).toBe(
      "i = 3, j = 4: 3 = 4 is false; 15.75 <= 15 is false; 16 <= 13.5 is false",
    );
  });

  test("the smaller shapes: subst between open givens, and subst into an open domain", () => {
    rejected(
      check("1 = 2", [
        { id: "a", stmt: "x = 1", by: "given" },
        { id: "b", stmt: "x = 2", by: "given" },
        { id: "c", stmt: "1 = 2", by: "subst", from: ["a", "b"] },
      ]),
      /step a \(given\): the statement is closed/,
    );
    rejected(
      check("1 = 2", [
        { id: "a", stmt: "y = 1", by: "given" },
        { id: "b", stmt: "forall x in {y}: x = 2", by: "given" },
        { id: "c", stmt: "forall x in {1}: x = 2", by: "subst", from: ["a", "b"] },
        { id: "d", stmt: "1 = 2", by: "instantiate", from: ["c"], with: { x: 1 } },
      ]),
      /step a \(given\): the statement is closed, so a hypothesis about `y`/,
    );
  });

  test("closed givens stay usable for a closed statement", () => {
    accepted(
      check("3 > 2", [
        { id: "g", stmt: "3 > 2 or 2 > 3", by: "given" },
        { id: "n", stmt: "not 2 > 3", by: "eval" },
        { id: "i1", stmt: "3 > 2 -> 3 > 2", by: "eval" },
        { id: "i2", stmt: "2 > 3 -> 3 > 2", by: "eval" },
        { id: "c", stmt: "3 > 2", by: "cases", from: ["g", "i1", "i2"] },
      ]),
    );
  });

  test("an open statement: a false closed step derived from the givens rejects the proof", () => {
    const v = check("r * 1 = 1", [
      { id: "h1", stmt: "k = 0", by: "given" },
      { id: "h2", stmt: "k * 2 = 1", by: "given" },
      { id: "z", stmt: "0 * 2 = 1", by: "subst", from: ["h1", "h2"] },
      { id: "id", stmt: "r * 0 = 0", by: "arith" },
      { id: "done", stmt: "r * 1 = 1", by: "subst", from: ["z", "id"] },
    ]);
    rejected(
      v,
      /step z \(subst\): the step is false \(0 = 1 is false\), so the hypotheses it follows from are inconsistent; anything follows from them/,
    );
    // The refutation is of an intermediate step, not of the claim.
    expect(v.counterexample).toBeUndefined();
  });

  // A decorative variable made a false closed claim "open", escaping the
  // closed-statement rule, and contradictory givens about another variable
  // then proved it (adversarial review, W1-D, round 3).
  test("a decorative variable does not make a false claim provable", () => {
    const v = check("y = y and 1 = 2", [
      { id: "h1", stmt: "k = 1", by: "given" },
      { id: "h2", stmt: "k = 2", by: "given" },
      { id: "r", stmt: "y = y", by: "arith" },
      { id: "a", stmt: "y = y and k = 2", by: "and_intro", from: ["r", "h2"] },
      { id: "done", stmt: "y = y and 1 = 2", by: "subst", from: ["h1", "a"] },
    ]);
    rejected(
      v,
      /^the statement is never true, whatever `y` is \(at y = 0: 1 = 2 is false\), so no consistent hypotheses prove it$/,
    );
    expect(v.counterexample).toBe("y = 0 (or any other value): 1 = 2 is false");
    expect(v.assumptions).toEqual([]);
    expect(v.output).toBe("statement: never true; no step read");

    // The false scenario C, dressed the same way: the counterexample still
    // names the overlapping pair.
    const dressed = `y = y and (${falseClaim})`;
    const c = check(dressed, [
      { id: "h1", stmt: "k = 0", by: "given" },
      { id: "h2", stmt: `k = 1 or (${falseClaim})`, by: "given" },
      { id: "r", stmt: "y = y", by: "arith" },
      { id: "s", stmt: `0 = 1 or (${falseClaim})`, by: "subst", from: ["h1", "h2"] },
      { id: "a", stmt: `y = y and (0 = 1 or (${falseClaim}))`, by: "and_intro", from: ["r", "s"] },
    ]);
    rejected(c, /^the statement is never true, whatever `y` is/);
    expect(c.counterexample).toBe(
      "y = 0 (or any other value): i = 3, j = 4: 3 = 4 is false; 15.75 <= 15 is false; 16 <= 13.5 is false",
    );

    // A first conjunct the test cannot decide does not hide a false second one.
    rejected(
      check("abs(y) >= 0 and 1 = 2", [
        { id: "p", stmt: "y > 0", by: "given" },
        { id: "i", stmt: "y > 0 -> (abs(y) >= 0 and 1 = 2)", by: "given" },
        { id: "done", stmt: "abs(y) >= 0 and 1 = 2", by: "mp", from: ["p", "i"] },
      ]),
      /^the statement is never true, whatever `y` is/,
    );
    // Cancelling identities count too: `y * 0 = 1` and `y - y > 0`.
    rejected(
      check("y * 0 = 1", "eval"),
      /never true, whatever `y` is \(at y = 0: 0 = 1 is false\)/,
    );
    rejected(check("y - y > 0 or 1 > 2", "eval"), /never true, whatever `y` is/);
  });

  test("two givens may not fix a variable to two values", () => {
    rejected(
      check("y = 7", [
        { id: "h1", stmt: "k = 1", by: "given" },
        { id: "h2", stmt: "2 = k", by: "given" },
      ]),
      /^step h2 \(given\): the hypotheses give `k` two values, 1 \(step h1\) and 2; contradictory hypotheses would prove anything$/,
    );
    // The same value twice, however written, is one value.
    accepted(
      check("k + 0 = 1", [
        { id: "h1", stmt: "k = 1", by: "given" },
        { id: "h2", stmt: "k = 2 / 2", by: "given" },
        { id: "a", stmt: "k + 0 = 1", by: "arith", from: ["h2"] },
      ]),
    );
  });

  test("an open hypothesis or step that is never true rejects the proof", () => {
    rejected(
      check("y = 7", [{ id: "h", stmt: "k * 0 = 1", by: "given" }]),
      /^step h \(given\): the hypothesis is never true, whatever `k` is \(at k = 0: 0 = 1 is false\); a false hypothesis would let anything follow$/,
    );
    rejected(
      check("x = 3", [
        { id: "g1", stmt: "x - x = z", by: "given" },
        { id: "g2", stmt: "z = 1", by: "given" },
        { id: "s", stmt: "x - x = 1", by: "subst", from: ["g2", "g1"] },
      ]),
      /^step s \(subst\): the step is never true, whatever `x` is \(at x = 0: 0 = 1 is false\), so the hypotheses it follows from are inconsistent/,
    );
  });

  test("every given and the statement are checked at the values the givens fix", () => {
    // A given that fails there shows the givens inconsistent.
    rejected(
      check("y = 7", [
        { id: "g1", stmt: "y = 1", by: "given" },
        { id: "g2", stmt: "y = 1 -> y = 7", by: "given" },
        { id: "done", stmt: "y = 7", by: "mp", from: ["g1", "g2"] },
      ]),
      /^given g2 cannot hold at y = 1, the value the givens fix \(at y = 1: 1 = 7 is false\), so the hypotheses are inconsistent/,
    );
    // A given left partly open is put to the never-true test there.
    rejected(
      check("y >= y", [
        { id: "g1", stmt: "k = 1", by: "given" },
        { id: "g2", stmt: "k = 1 -> (y = y and 1 = 2)", by: "given" },
        { id: "a", stmt: "y >= y", by: "arith" },
      ]),
      /^given g2 cannot hold at k = 1, the value the givens fix \(at k = 1, y = 0 \(or any other value of `y`\): 1 = 2 is false\)/,
    );
    // Used, the same given yields a step that is never true.
    rejected(
      check("y >= y", [
        { id: "g1", stmt: "k = 1", by: "given" },
        { id: "g2", stmt: "k = 1 -> (y = y and 1 = 2)", by: "given" },
        { id: "m", stmt: "y = y and 1 = 2", by: "mp", from: ["g1", "g2"] },
      ]),
      /^step m \(mp\): the step is never true, whatever `y` is/,
    );
    // The statement: false at the fixed values (z is left open in the givens
    // that make them inconsistent) …
    const atFixed = check("y = 7", [
      { id: "g1", stmt: "y = 1", by: "given" },
      { id: "g2", stmt: "z > 0", by: "given" },
      { id: "g3", stmt: "z > 0 -> y = 7", by: "given" },
      { id: "done", stmt: "y = 7", by: "mp", from: ["g2", "g3"] },
    ]);
    rejected(
      atFixed,
      /^the statement is false at y = 1, the value the givens fix \(1 = 7 is false\), so no consistent hypotheses prove it$/,
    );
    expect(atFixed.counterexample).toBe("y = 1: 1 = 7 is false");
    expect(atFixed.output).toMatch(/at the values the givens fix: rejected$/);
    // … or never true there, whatever its other variables are.
    const partly = check("k * y = y + 1", [
      { id: "g1", stmt: "k = 1", by: "given" },
      { id: "g2", stmt: "z > 0", by: "given" },
      { id: "g3", stmt: "z > 0 -> k * y = y + 1", by: "given" },
      { id: "done", stmt: "k * y = y + 1", by: "mp", from: ["g2", "g3"] },
    ]);
    rejected(
      partly,
      /^the statement is false at k = 1, the value the givens fix \(0 = 1 is false\)/,
    );
    expect(partly.counterexample).toBe("k = 1, y = 0 (or any other value of `y`): 0 = 1 is false");
    // A statement that cannot be evaluated at those values is not proven.
    rejected(
      check("1 / y > 0", [
        { id: "g1", stmt: "y = 0", by: "given" },
        { id: "g2", stmt: "z > 0", by: "given" },
        { id: "g3", stmt: "z > 0 -> 1 / y > 0", by: "given" },
        { id: "done", stmt: "1 / y > 0", by: "mp", from: ["g2", "g3"] },
      ]),
      /^the statement cannot be evaluated at y = 0, the values the givens fix: division by zero/,
    );
  });

  test("hypotheses about other quantities still prove an open statement", () => {
    const v = check("y = 7", [
      { id: "g1", stmt: "x = 3", by: "given" },
      { id: "g2", stmt: "x = 3 -> y = 2*x + 1", by: "given" },
      { id: "m", stmt: "y = 2*x + 1", by: "mp", from: ["g1", "g2"] },
      { id: "s", stmt: "y = 2*3 + 1", by: "subst", from: ["g1", "m"] },
      { id: "a", stmt: "2*3 + 1 = 7", by: "arith" },
      { id: "done", stmt: "y = 7", by: "subst", from: ["a", "s"] },
    ]);
    accepted(v);
    expect(v.assumptions).toEqual(["x = 3", "x = 3 -> y = 2 * x + 1"]);
  });

  // The residual, pinned so the README stays true: hypotheses whose
  // inconsistency nothing here can read off are trusted, and listed.
  test("tailored open givens are trusted and listed as assumptions", () => {
    const v = check("abs(y) >= 0 -> 1 = 2", [
      { id: "p", stmt: "y > 0", by: "given" },
      { id: "i", stmt: "y > 0 -> (abs(y) >= 0 -> 1 = 2)", by: "given" },
      { id: "done", stmt: "abs(y) >= 0 -> 1 = 2", by: "mp", from: ["p", "i"] },
    ]);
    accepted(v);
    expect(v.assumptions).toEqual(["y > 0", "y > 0 -> abs(y) >= 0 -> 1 = 2"]);
  });

  test("a false closed step that cannot be evaluated is a rejection too", () => {
    rejected(
      check("q = q", [
        { id: "h1", stmt: "k = 0", by: "given" },
        { id: "h2", stmt: "1 / k = 1 / k", by: "given" },
        { id: "z", stmt: "1 / 0 = 1 / 0", by: "subst", from: ["h1", "h2"] },
      ]),
      /step z \(subst\): this closed step cannot be evaluated: division by zero/,
    );
  });
});

describe("certificate format", () => {
  test("the proof must be JSON (or the word eval)", () => {
    rejected(check("1 = 1", "by eval"), /not valid JSON/);
    rejected(check("1 = 1", '{"stmt": "1 = 1"}'), /must be a JSON array of steps/);
    rejected(check("1 = 1", "[]"), /no steps/);
  });

  test("steps are validated strictly", () => {
    rejected(check("1 = 1", ["nope" as unknown as StepIn]), /step #1 is not a JSON object/);
    rejected(
      check("1 = 1", [{ id: "s1", stmt: "1 = 1", by: "eval", form: [] } as unknown as StepIn]),
      /unknown key `form`/,
    );
    rejected(check("1 = 1", [{ id: "has space", stmt: "1 = 1", by: "eval" }]), /needs an `id`/);
    rejected(check("1 = 1", [{ id: "s1", stmt: "", by: "eval" }]), /needs a `stmt`/);
    rejected(check("1 = 1", [{ id: "s1", stmt: "1 = 1" } as StepIn]), /needs `by`/);
    rejected(
      check("1 = 1", [{ id: "s1", stmt: "1 = 1", by: "eval", from: "s0" } as unknown as StepIn]),
      /`from` must be an array/,
    );
    rejected(
      check("1 = 1", [{ id: "s1", stmt: "1 = 1", by: "eval", with: [] } as unknown as StepIn]),
      /`with` must be a JSON object/,
    );
  });

  test("ids are unique and premises must be earlier steps", () => {
    rejected(
      check("1 = 1", [
        { id: "a", stmt: "1 = 1", by: "eval" },
        { id: "a", stmt: "1 = 1", by: "eval" },
      ]),
      /step a \(eval\): the id is used twice/,
    );
    rejected(
      check("1 = 1 and 1 = 1", [
        { id: "a", stmt: "1 = 1 and 1 = 1", by: "and_intro", from: ["b", "b"] },
        { id: "b", stmt: "1 = 1", by: "eval" },
      ]),
      /premise `b` is not an earlier step/,
    );
  });

  test("unknown rules list the known ones; induction points at lean4", () => {
    rejected(
      check("1 = 1", [{ id: "a", stmt: "1 = 1", by: "magic" }]),
      /unknown rule `magic` \(rules: given, eval/,
    );
    rejected(
      check("1 = 1", [{ id: "a", stmt: "1 = 1", by: "induction" }]),
      /no induction; prove it with the lean4/,
    );
  });

  test("a parse error in a step names the step and the position", () => {
    rejected(
      check("1 = 1", [{ id: "s1", stmt: "1 = (1", by: "eval" }]),
      /^step s1 \(eval\): stmt: line 1, column 7/,
    );
  });

  test("a parse error in the statement names the position", () => {
    rejected(check("1 = = 1", "eval"), /^statement: line 1, column 5/);
    rejected(check("", "eval"), /statement is empty/);
  });

  test("the last step must be the statement (compared as formulas, not strings)", () => {
    accepted(check("(1 + 1) = 2", [{ id: "s", stmt: "1+1=2", by: "eval" }]));
    rejected(
      check("2 = 2", [{ id: "s", stmt: "1 = 1", by: "eval" }]),
      /the last step proves `1 = 1`, which is not the statement `2 = 2`/,
    );
  });

  test("caps: `from` is at most maxSteps long", () => {
    const from = Array.from({ length: BUILTIN_LIMITS.maxSteps + 1 }, () => "a");
    rejected(
      check("1 = 1", [
        { id: "a", stmt: "1 = 1", by: "eval" },
        { id: "b", stmt: "1 = 1", by: "and_elim", from },
      ]),
      new RegExp(
        `\`from\` lists ${BUILTIN_LIMITS.maxSteps + 1} premises; the cap is ${BUILTIN_LIMITS.maxSteps}`,
      ),
    );
  });

  test("caps: step count and proof size", () => {
    const steps = Array.from({ length: BUILTIN_LIMITS.maxSteps + 1 }, (_, i) => ({
      id: `s${i}`,
      stmt: "1 = 1",
      by: "eval",
    }));
    rejected(check("1 = 1", steps), /2001 steps; the cap is 2000/);
    rejected(
      check("1 = 1", `[${" ".repeat(BUILTIN_LIMITS.maxProofChars)}]`),
      /characters; the cap/,
    );
  });
});

describe("rule: given", () => {
  test("open hypotheses become assumptions (normalized text, in order, deduped)", () => {
    const v = check("y = 2", [
      { id: "g1", stmt: "x  >  3", by: "given" },
      { id: "g2", stmt: "x > 3 -> y = 2", by: "given" },
      { id: "g3", stmt: "x>3", by: "given" },
      { id: "m", stmt: "y = 2", by: "mp", from: ["g1", "g2"] },
    ]);
    accepted(v);
    expect(v.assumptions).toEqual(["x > 3", "x > 3 -> y = 2"]);
  });

  test("a closed hypothesis that is false is rejected as inconsistent", () => {
    rejected(
      check("x = 1", [{ id: "g", stmt: "forall i in 0..3: i < 3", by: "given" }]),
      /the hypothesis is false \(i = 3: 3 < 3 is false\); a false hypothesis would let anything follow/,
    );
  });

  test("a closed hypothesis that cannot be evaluated is rejected", () => {
    rejected(
      check("x = 1", [{ id: "g", stmt: "1 / 0 = 1", by: "given" }]),
      /cannot be evaluated: division by zero/,
    );
  });

  test("a closed true hypothesis is accepted (and listed)", () => {
    const v = check("2 > 1", [
      { id: "g", stmt: "2 > 1 or 1 = 0", by: "given" },
      { id: "n", stmt: "not 1 = 0", by: "eval" },
      { id: "e", stmt: "2 > 1", by: "arith" },
    ]);
    accepted(v);
    expect(v.assumptions).toEqual(["2 > 1 or 1 = 0"]);
  });

  test("assuming the statement itself is refused", () => {
    rejected(
      check("x = 1", [{ id: "g", stmt: "x = 1", by: "given" }]),
      /cannot assume what it proves/,
    );
  });

  test("given takes no premises", () => {
    rejected(
      check("x = 1", [
        { id: "a", stmt: "1 = 1", by: "eval" },
        { id: "g", stmt: "x = 1", by: "given", from: ["a"] },
      ]),
      /takes no premises/,
    );
  });
});

describe("rule: eval", () => {
  test("needs a closed formula", () => {
    rejected(
      check("x = x", [{ id: "e", stmt: "x = x", by: "eval" }]),
      /eval needs a closed formula, but `x` has no value/,
    );
  });

  test("a false formula is rejected with its counterexample", () => {
    const v = check("forall x in {1, 2, 3}: x * x < 5", "eval");
    rejected(v, /the formula is false: x = 3: 9 < 5 is false/);
    expect(v.counterexample).toBe("x = 3: 9 < 5 is false");
  });

  test("an evaluation error is a rejection", () => {
    rejected(check("1 / 0 = 0", "eval"), /division by zero/);
  });

  test("takes no `with`", () => {
    rejected(
      check("1 = 1", [{ id: "e", stmt: "1 = 1", by: "eval", with: { x: 1 } }]),
      /takes no `with`/,
    );
  });
});

describe("rule: arith", () => {
  const one = (stmt: string, extra: Partial<StepIn> = {}): BuiltinVerdict =>
    check(stmt, [{ id: "a", stmt, by: "arith", ...extra }]);

  test("ground comparisons by exact arithmetic", () => {
    accepted(one("1284.50 = 1000 + 250 + 34.5"));
    accepted(one("1/3 < 0.34"));
    rejected(one("0.1 + 0.2 != 0.3"), /the comparison is false: 0.3 != 0.3 is false/);
    expect(one("2 > 3").counterexample).toBe("2 > 3 is false");
  });

  test("polynomial identities hold for every value", () => {
    accepted(one("(x + 1)^2 = x^2 + 2*x + 1"));
    accepted(one("(a - b) * (a + b) = a^2 - b^2"));
    accepted(one("x / 2 + x / 2 = x"));
    rejected(one("x * x = x"), /differ by -x \+ x\^2, which is not 0 for every value/);
  });

  test("inequalities over variables only when the sides differ by a constant", () => {
    accepted(one("x + 2 > x + 1"));
    accepted(one("2*y - 1 <= 2*y"));
    accepted(one("x + 1 != x"));
    // The rule's own refusal, on a step that is not the statement…
    rejected(
      check("x + 1 < x or x = x", [{ id: "a", stmt: "x + 1 < x", by: "arith" }]),
      /step a \(arith\): the sides differ by 1, so `<` does not hold/,
    );
    // …and as the statement, it is refuted before any step is read: it is
    // never true, whatever x is.
    const never = one("x + 1 < x");
    rejected(never, /^the statement is never true, whatever `x` is \(at x = 0: 1 < 0 is false\)/);
    expect(never.counterexample).toBe("x = 0 (or any other value): 1 < 0 is false");
    rejected(one("x^2 + 1 > 0"), /only when its sides differ by a constant/);
  });

  test("premises `x = <number>` give variables values", () => {
    const v = check("e_3 <= s_4", [
      { id: "g1", stmt: "e_3 = 14.5", by: "given" },
      { id: "g2", stmt: "15 = s_4", by: "given" },
      { id: "a", stmt: "e_3 <= s_4", by: "arith", from: ["g1", "g2"] },
    ]);
    accepted(v);
    expect(v.assumptions).toEqual(["e_3 = 14.5", "15 = s_4"]);
    rejected(
      check("e <= s", [
        { id: "g1", stmt: "e = 16", by: "given" },
        { id: "g2", stmt: "s = 15", by: "given" },
        { id: "a", stmt: "e <= s", by: "arith", from: ["g1", "g2"] },
      ]),
      /16 <= 15 is false/,
    );
  });

  test("premises must be equations with a closed side, and must agree", () => {
    rejected(
      check("x > 0", [
        { id: "g", stmt: "x > 3", by: "given" },
        { id: "a", stmt: "x > 0", by: "arith", from: ["g"] },
      ]),
      /premises must be equations `x = <number>`/,
    );
    // Two givens fixing x differently are refused as they arrive; premises
    // derived from one given meet the rule's own check.
    rejected(
      check("x = x", [
        { id: "g1", stmt: "x = 1", by: "given" },
        { id: "g2", stmt: "x = 2", by: "given" },
        { id: "a", stmt: "x = x", by: "arith", from: ["g1", "g2"] },
      ]),
      /step g2 \(given\): the hypotheses give `x` two values, 1 \(step g1\) and 2/,
    );
    rejected(
      check("x = x", [
        { id: "g", stmt: "x = 1 and x = 2", by: "given" },
        { id: "g1", stmt: "x = 1", by: "and_elim", from: ["g"] },
        { id: "g2", stmt: "x = 2", by: "and_elim", from: ["g"] },
        { id: "a", stmt: "x = x", by: "arith", from: ["g1", "g2"] },
      ]),
      /step a \(arith\): the premises give `x` two different values/,
    );
  });

  test("non-polynomial forms over variables are refused, closed ones evaluate", () => {
    rejected(one("1 / x = 1 / x + 0"), /division by an expression with a variable/);
    rejected(one("abs(x) = abs(x)"), /`abs` of an expression with a variable/);
    rejected(one("2^x = 2^x"), /variable exponent/);
    accepted(one("x + abs(-2) = x + 2"));
    accepted(one("x * min(4, 2) = 2 * x"));
  });

  test("only a single comparison", () => {
    rejected(one("1 = 1 and 2 = 2"), /arith proves one comparison/);
  });
});

describe("rule: subst", () => {
  test("replaces occurrences of one side by the other, in either direction", () => {
    const v = check("y + 1 > 5", [
      { id: "e", stmt: "x = y", by: "given" },
      { id: "p", stmt: "x + 1 > 5", by: "given" },
      { id: "s", stmt: "y + 1 > 5", by: "subst", from: ["e", "p"] },
    ]);
    accepted(v);
    accepted(
      check("x * x = 4", [
        { id: "e", stmt: "x = y", by: "given" },
        { id: "p", stmt: "y * x = 4", by: "given" },
        { id: "s", stmt: "x * x = 4", by: "subst", from: ["e", "p"] },
      ]),
    );
  });

  test("not every occurrence has to be replaced", () => {
    accepted(
      check("x + y = 2*x", [
        { id: "e", stmt: "x = y", by: "given" },
        { id: "p", stmt: "x + x = 2*x", by: "given" },
        { id: "s", stmt: "x + y = 2*x", by: "subst", from: ["e", "p"] },
      ]),
    );
  });

  test("a change that is not a replacement is rejected", () => {
    rejected(
      check("z + 1 > 5", [
        { id: "e", stmt: "x = y", by: "given" },
        { id: "p", stmt: "x + 1 > 5", by: "given" },
        { id: "s", stmt: "z + 1 > 5", by: "subst", from: ["e", "p"] },
      ]),
      /not the second premise with occurrences of `x` and `y` exchanged/,
    );
  });

  test("an occurrence captured by a binder is not the same term", () => {
    rejected(
      check("forall i in 0..2: y >= 0", [
        { id: "e", stmt: "i = y", by: "given" },
        { id: "p", stmt: "forall i in 0..2: i >= 0", by: "eval" },
        { id: "s", stmt: "forall i in 0..2: y >= 0", by: "subst", from: ["e", "p"] },
      ]),
      /exchanged/,
    );
  });

  test("the first premise must be an equation", () => {
    rejected(
      check("y > 0", [
        { id: "e", stmt: "x < y", by: "given" },
        { id: "p", stmt: "x > 0", by: "given" },
        { id: "s", stmt: "y > 0", by: "subst", from: ["e", "p"] },
      ]),
      /first premise of subst must be an equation/,
    );
  });
});

describe("rule: mp", () => {
  const base: StepIn[] = [
    { id: "p", stmt: "a = 1", by: "given" },
    { id: "i", stmt: "a = 1 -> b = 2", by: "given" },
  ];

  test("accepts φ, φ -> ψ in either order", () => {
    accepted(check("b = 2", [...base, { id: "m", stmt: "b = 2", by: "mp", from: ["p", "i"] }]));
    accepted(check("b = 2", [...base, { id: "m", stmt: "b = 2", by: "mp", from: ["i", "p"] }]));
  });

  test("accepts <-> in both directions", () => {
    accepted(
      check("a = 1", [
        { id: "q", stmt: "b = 2", by: "given" },
        { id: "i", stmt: "a = 1 <-> b = 2", by: "given" },
        { id: "m", stmt: "a = 1", by: "mp", from: ["q", "i"] },
      ]),
    );
  });

  test("rejects a conclusion that does not follow, and a missing antecedent", () => {
    rejected(
      check("c = 3", [...base, { id: "m", stmt: "c = 3", by: "mp", from: ["p", "i"] }]),
      /mp needs premises/,
    );
    rejected(
      check("b = 2", [
        { id: "p", stmt: "a = 2", by: "given" },
        { id: "i", stmt: "a = 1 -> b = 2", by: "given" },
        { id: "m", stmt: "b = 2", by: "mp", from: ["p", "i"] },
      ]),
      /mp needs premises/,
    );
    rejected(
      check("b = 2", [...base, { id: "m", stmt: "b = 2", by: "mp", from: ["p"] }]),
      /takes 2 premises/,
    );
  });
});

describe("and_elim: an empty `with` is the same as none", () => {
  test("with: {} is accepted like every other rule's", () => {
    accepted(
      check("1 = 1", [
        { id: "a", stmt: "1 = 1 and 2 = 2", by: "eval" },
        { id: "b", stmt: "1 = 1", by: "and_elim", from: ["a"], with: {} },
      ]),
    );
  });
});

describe("rules: and_intro, and_elim, or_intro", () => {
  const ab: StepIn[] = [
    { id: "a", stmt: "x = 1", by: "given" },
    { id: "b", stmt: "y = 2", by: "given" },
  ];

  test("and_intro in premise order", () => {
    accepted(
      check("x = 1 and y = 2", [
        ...ab,
        { id: "c", stmt: "x = 1 and y = 2", by: "and_intro", from: ["a", "b"] },
      ]),
    );
    rejected(
      check("y = 2 and x = 1", [
        ...ab,
        { id: "c", stmt: "y = 2 and x = 1", by: "and_intro", from: ["a", "b"] },
      ]),
      /in that order/,
    );
  });

  test("and_elim with and without a side", () => {
    const both: StepIn[] = [{ id: "c", stmt: "x = 1 and y = 2", by: "given" }];
    accepted(
      check("x = 1", [
        ...both,
        { id: "l", stmt: "x = 1", by: "and_elim", from: ["c"], with: { side: "left" } },
      ]),
    );
    accepted(check("y = 2", [...both, { id: "r", stmt: "y = 2", by: "and_elim", from: ["c"] }]));
    rejected(
      check("x = 1", [
        ...both,
        { id: "l", stmt: "x = 1", by: "and_elim", from: ["c"], with: { side: "right" } },
      ]),
      /not that side/,
    );
    rejected(
      check("x = 1", [
        ...both,
        { id: "l", stmt: "x = 1", by: "and_elim", from: ["c"], with: { side: "middle" } },
      ]),
      /takes `with: \{"side": "left"\}`/,
    );
    rejected(
      check("x = 1", [
        { id: "c", stmt: "x = 1 or y = 2", by: "given" },
        { id: "l", stmt: "x = 1", by: "and_elim", from: ["c"] },
      ]),
      /must be a conjunction/,
    );
  });

  test("or_intro with the premise on either side", () => {
    accepted(
      check("x = 1 or z = 9", [
        ...ab,
        { id: "o", stmt: "x = 1 or z = 9", by: "or_intro", from: ["a"] },
      ]),
    );
    accepted(
      check("z = 9 or x = 1", [
        ...ab,
        { id: "o", stmt: "z = 9 or x = 1", by: "or_intro", from: ["a"] },
      ]),
    );
    rejected(
      check("z = 9 or w = 1", [
        ...ab,
        { id: "o", stmt: "z = 9 or w = 1", by: "or_intro", from: ["a"] },
      ]),
      /premise as one side/,
    );
  });
});

describe("rule: cases", () => {
  test("over a disjunction, implications in either order", () => {
    const steps = (first: string, second: string): StepIn[] => [
      { id: "d", stmt: "x = 1 or x = 2", by: "given" },
      { id: "i1", stmt: `${first} -> y > 0`, by: "given" },
      { id: "i2", stmt: `${second} -> y > 0`, by: "given" },
      { id: "c", stmt: "y > 0", by: "cases", from: ["d", "i1", "i2"] },
    ];
    accepted(check("y > 0", steps("x = 1", "x = 2")));
    accepted(check("y > 0", steps("x = 2", "x = 1")));
    rejected(check("y > 0", steps("x = 1", "x = 3")), /cases takes either/);
  });

  test("over a finite domain: one premise per value concludes the forall", () => {
    const v = check("forall k in 1..3: k * a = a * k", [
      { id: "c1", stmt: "1 * a = a * 1", by: "arith" },
      { id: "c3", stmt: "3 * a = a * 3", by: "arith" },
      { id: "c2", stmt: "2 * a = a * 2", by: "arith" },
      { id: "all", stmt: "forall k in 1..3: k * a = a * k", by: "cases", from: ["c1", "c3", "c2"] },
    ]);
    accepted(v);
    expect(v.output).toMatch(/all cases: 3 cases/);
  });

  test("a missing case is named", () => {
    rejected(
      check("forall k in {1, 2.5}: k * a = a * k", [
        { id: "c1", stmt: "1 * a = a * 1", by: "arith" },
        { id: "all", stmt: "forall k in {1, 2.5}: k * a = a * k", by: "cases", from: ["c1"] },
      ]),
      /no premise is the case k = 2.5: `2.5 \* a = a \* 2.5`/,
    );
  });

  test("more premises than domain values are refused", () => {
    rejected(
      check("forall k in {}: k = k", [
        { id: "c", stmt: "1 = 1", by: "eval" },
        { id: "all", stmt: "forall k in {}: k = k", by: "cases", from: ["c", "c"] },
      ]),
      /cases over a domain takes one premise per value: the domain has 0, `from` lists 2/,
    );
  });

  test("a long `from` over a big premise stays inside the deadline (adversarial review, W1-D)", () => {
    // ~128k nodes once expanded; the old checker printed it once per premise,
    // outside the budget, and overran a 1 s deadline ninefold at 4 000 premises.
    const sum = (name: string): string => Array.from({ length: 40 }, () => name).join(" + ");
    const big = `let a = ${sum("x")}, b = ${sum("a")}, c = ${sum("b")} in c = -1`;
    const body = `let a = ${sum("x")}, b = ${sum("a")}, c = ${sum("b")} in c = i`;
    const steps = (n: number, statement: string): StepIn[] => [
      { id: "a", stmt: big, by: "given" },
      { id: "c", stmt: statement, by: "cases", from: Array.from({ length: n }, () => "a") },
    ];
    // The bound is on the overrun, the time a check runs past its deadline,
    // never on the budgeted time a loaded runner stretches up to it. Printing
    // every premise outside the budget overran by 3 to 4 s where this was
    // measured; a budgeted check stops within a few ms of its deadline. So
    // 400 ms fails the first by 5x on a machine twice as fast and holds on a
    // runner 20x slower, and the best of up to three runs rides out a stall.
    const OVERRUN_MS = 400;
    type Run = { verdict: BuiltinVerdict; overrunMs: number };
    const once = (statement: string, proof: string, timeoutMs: number): Run => {
      const started = performance.now();
      const verdict = checkCertificate({ statement, proof, timeoutMs });
      return { verdict, overrunMs: performance.now() - started - timeoutMs };
    };
    const leastOverrun = (
      statement: string,
      proof: string,
      timeoutMs: number,
      first: Run = once(statement, proof, timeoutMs),
    ): Run => {
      let best = first;
      for (let i = 1; i < 3 && best.overrunMs >= OVERRUN_MS; i++) {
        const next = once(statement, proof, timeoutMs);
        if (next.overrunMs < best.overrunMs) best = next;
      }
      return best;
    };
    // The original shape (a closed statement) now stops at the open given.
    const closed = leastOverrun(
      "forall i in {}: true",
      JSON.stringify(steps(2_000, "forall i in {}: true")),
      1_000,
    );
    expect(closed.overrunMs).toBeLessThan(OVERRUN_MS);
    expect(closed.verdict.reason).toMatch(/the statement is closed/);
    // An open statement with a domain as long as the premise list: every
    // comparison spends from the budget, so the check stops at its deadline.
    // The steps before `cases` take about 50 ms where this was measured; a
    // deadline that falls inside them never runs the rule under test, so a
    // slower machine doubles the deadline until the rejection names step c.
    const statement = `forall i in 0..1999: ${body}`;
    const proof = JSON.stringify(steps(2_000, statement));
    const inCases =
      /^step c \(cases\): (the check ran out of time|the check needs more than|no premise is the case)/;
    let timeoutMs = 100;
    let first = once(statement, proof, timeoutMs);
    while (!inCases.test(first.verdict.reason ?? "") && timeoutMs < 3_200) {
      timeoutMs *= 2;
      first = once(statement, proof, timeoutMs);
    }
    const open = leastOverrun(statement, proof, timeoutMs, first);
    expect(open.verdict.ok).toBe(false);
    expect(open.verdict.reason).toMatch(inCases);
    expect(open.overrunMs).toBeLessThan(OVERRUN_MS);
  }, 20_000);

  test("the domain must be closed", () => {
    rejected(
      check("forall k in 1..n: k = k", [
        { id: "c", stmt: "1 = 1", by: "eval" },
        { id: "all", stmt: "forall k in 1..n: k = k", by: "cases", from: ["c"] },
      ]),
      /domain mentions `n`/,
    );
  });
});

describe("rule: contra", () => {
  // Every step follows from the givens (there are no sub-proofs to discharge),
  // so φ and not φ prove the givens inconsistent: the proof is rejected, as the
  // smt checker rejects an unsatisfiable preamble.
  test("φ and not φ show the hypotheses inconsistent, which rejects the proof", () => {
    for (const from of [
      ["b", "a"],
      ["a", "b"],
    ]) {
      const v = check("z = 99", [
        { id: "a", stmt: "x > 1", by: "given" },
        { id: "b", stmt: "not x > 1", by: "given" },
        { id: "c", stmt: "z = 99", by: "contra", from },
      ]);
      rejected(
        v,
        /step c \(contra\): the premises are `x > 1` and its negation, so the hypotheses are inconsistent; anything follows from them/,
      );
      expect(v.counterexample).toBeUndefined();
    }
    rejected(
      check("z = 99", [
        { id: "a", stmt: "x > 1", by: "given" },
        { id: "b", stmt: "not x > 2", by: "given" },
        { id: "c", stmt: "z = 99", by: "contra", from: ["a", "b"] },
      ]),
      /a formula and its negation/,
    );
  });
});

describe("rules: instantiate and witness", () => {
  const all: StepIn = { id: "all", stmt: "forall x in {1, 2, 5}: x * c >= c", by: "given" };

  test("instantiate a forall with a value from its domain", () => {
    const v = check("5 * c >= c", [
      all,
      { id: "i", stmt: "5 * c >= c", by: "instantiate", from: ["all"], with: { x: 5 } },
    ]);
    accepted(v);
    expect(v.output).toMatch(/i instantiate: x = 5/);
    accepted(
      check("2 * c >= c", [
        all,
        { id: "i", stmt: "2 * c >= c", by: "instantiate", from: ["all"], with: { x: "2" } },
      ]),
    );
  });

  test("instantiate refuses a value outside the domain, a wrong key, a wrong result", () => {
    rejected(
      check("3 * c >= c", [
        all,
        { id: "i", stmt: "3 * c >= c", by: "instantiate", from: ["all"], with: { x: 3 } },
      ]),
      /3 is not in the domain/,
    );
    rejected(
      check("5 * c >= c", [
        all,
        { id: "i", stmt: "5 * c >= c", by: "instantiate", from: ["all"], with: { y: 5 } },
      ]),
      /exactly the quantified variable/,
    );
    rejected(
      check("5 * c >= c", [
        all,
        { id: "i", stmt: "5 * c >= c", by: "instantiate", from: ["all"], with: { x: "y" } },
      ]),
      /must be closed/,
    );
    rejected(
      check("5 * c > c", [
        all,
        { id: "i", stmt: "5 * c > c", by: "instantiate", from: ["all"], with: { x: 5 } },
      ]),
      /gives `5 \* c >= c`, not this step/,
    );
    rejected(
      check("1 = 1", [
        { id: "p", stmt: "exists x in {1}: x = 1", by: "eval" },
        { id: "i", stmt: "1 = 1", by: "instantiate", from: ["p"], with: { x: 1 } },
      ]),
      /must be a `forall`/,
    );
  });

  test("witness concludes an exists from one instance", () => {
    accepted(
      check("exists n in 0..10: n * n = q", [
        { id: "w", stmt: "7 * 7 = q", by: "given" },
        {
          id: "e",
          stmt: "exists n in 0..10: n * n = q",
          by: "witness",
          from: ["w"],
          with: { n: 7 },
        },
      ]),
    );
    rejected(
      check("exists n in 0..5: n * n = q", [
        { id: "w", stmt: "7 * 7 = q", by: "given" },
        {
          id: "e",
          stmt: "exists n in 0..5: n * n = q",
          by: "witness",
          from: ["w"],
          with: { n: 7 },
        },
      ]),
      /7 is not in the domain/,
    );
    rejected(
      check("exists n in 0..10: n * n = q", [
        { id: "w", stmt: "6 * 6 = q", by: "given" },
        {
          id: "e",
          stmt: "exists n in 0..10: n * n = q",
          by: "witness",
          from: ["w"],
          with: { n: 7 },
        },
      ]),
      /premise must be the body with n = 7/,
    );
    rejected(
      check("forall n in 0..1: n = n", [
        { id: "w", stmt: "0 = 0", by: "eval" },
        { id: "e", stmt: "forall n in 0..1: n = n", by: "witness", from: ["w"], with: { n: 0 } },
      ]),
      /witness proves an `exists`/,
    );
  });
});

describe("a multi-step derivation", () => {
  test("hypotheses, modus ponens, substitution and arithmetic together", () => {
    const v = check("y = 7", [
      { id: "g1", stmt: "x = 3", by: "given" },
      { id: "g2", stmt: "x = 3 -> y = 2*x + 1", by: "given" },
      { id: "m", stmt: "y = 2*x + 1", by: "mp", from: ["g1", "g2"] },
      { id: "s", stmt: "y = 2*3 + 1", by: "subst", from: ["g1", "m"] },
      { id: "a", stmt: "2*3 + 1 = 7", by: "arith" },
      { id: "done", stmt: "y = 7", by: "subst", from: ["a", "s"] },
    ]);
    accepted(v);
    expect(v.assumptions).toEqual(["x = 3", "x = 3 -> y = 2 * x + 1"]);
    expect(v.output.split("\n")).toEqual([
      "g1 given: assumed",
      "g2 given: assumed",
      "m mp: ok",
      "s subst: ok",
      "a arith: exact",
      "done subst: ok",
      "statement: proved from 2 assumptions",
    ]);
  });

  test("a forall hypothesis, instantiated and discharged", () => {
    accepted(
      check("l1 > 0", [
        { id: "pos", stmt: "forall k in {1, 2}: k = 1 -> l1 > 0", by: "given" },
        { id: "p1", stmt: "1 = 1 -> l1 > 0", by: "instantiate", from: ["pos"], with: { k: 1 } },
        { id: "t", stmt: "1 = 1", by: "eval" },
        { id: "l1pos", stmt: "l1 > 0", by: "mp", from: ["t", "p1"] },
      ]),
    );
  });
});

describe("rejection extras", () => {
  test("a closed false statement with a bogus proof still yields its counterexample", () => {
    const v = check("forall x in {1, 2, 3}: x < 3", [
      { id: "g", stmt: "1 = 1", by: "given" },
      { id: "z", stmt: "forall x in {1, 2, 3}: x < 3", by: "contra", from: ["g", "g"] },
    ]);
    rejected(v, /contra needs/);
    expect(v.counterexample).toBe("x = 3: 3 < 3 is false");
  });

  test("a false intermediate step's refutation is not the claim's counterexample", () => {
    const v = check("1 < 2", [
      { id: "s1", stmt: "forall i in 0..3: i < 2", by: "eval" },
      { id: "s2", stmt: "1 < 2", by: "eval" },
    ]);
    rejected(v, /step s1 \(eval\): the formula is false: i = 2: 2 < 2 is false/);
    expect(v.counterexample).toBeUndefined();
    expect(v.output).toMatch(/hint: the statement is closed and true by evaluation/);
  });

  test("a cancelled check does not go on to evaluate the statement", () => {
    const heavy = "forall i in 1..10000: forall j in 1..99: i * j > 0";
    const ac = new AbortController();
    ac.abort();
    // Counted, not timed: the work units every Budget spends, the rejection
    // path's own included. Evaluating `heavy` is about 6M of them; a budget
    // tied to the aborted signal sees it within one 4 096-unit clock stride.
    const tick = Budget.prototype.tick;
    let work = 0;
    Budget.prototype.tick = function (this: Budget, n = 1): void {
      work += n;
      tick.call(this, n);
    };
    let v: BuiltinVerdict;
    try {
      v = checkCertificate({
        statement: heavy,
        proof: JSON.stringify([{ id: "a", stmt: "1 = 1", by: "mp" }]),
        signal: ac.signal,
      });
    } finally {
      Budget.prototype.tick = tick;
    }
    expect(work).toBeLessThan(4_096);
    expect(v.reason).toMatch(/cancelled/);
    expect(v.counterexample).toBeUndefined();
    expect(v.output).not.toMatch(/hint/);
  });

  test("the deadline is capped at maxTimeoutMs whatever the caller asks", () => {
    // A check holds a core (or, with no worker, the caller's thread) for its
    // whole budget; formal.timeout_ms (30 s by default, sized for containers)
    // must not stretch it.
    const t0 = 1_000_000;
    let calls = 0;
    const clock = spyOn(Date, "now").mockImplementation(() =>
      calls++ === 0 ? t0 : t0 + BUILTIN_LIMITS.maxTimeoutMs + 1,
    );
    try {
      const v = checkCertificate({ statement: "1 = 1", proof: "eval", timeoutMs: 60_000 });
      expect(v.reason).toMatch(/ran out of time/);
    } finally {
      clock.mockRestore();
    }
  });

  test("a closed true statement with a bogus proof gets a hint to use eval", () => {
    const v = check("2 + 2 = 4", [{ id: "a", stmt: "2 + 2 = 4", by: "mp", from: [] }]);
    rejected(v, /takes 2 premises/);
    expect(v.counterexample).toBeUndefined();
    expect(v.output).toMatch(
      /hint: the statement is closed and true by evaluation; the proof `eval` proves it/,
    );
  });

  test("the timeout and the signal reject instead of hanging", () => {
    const heavy = "forall i in 1..10000: forall j in 1..99: i * j > 0";
    const slow = checkCertificate({ statement: heavy, proof: "eval", timeoutMs: 0 });
    expect(slow.ok).toBe(false);
    expect(slow.reason).toMatch(/ran out of time/);
    const ac = new AbortController();
    ac.abort();
    const cancelled = checkCertificate({ statement: heavy, proof: "eval", signal: ac.signal });
    expect(cancelled.reason).toMatch(/cancelled/);
  });

  test("a NaN budget does not disable the deadline (the default applies)", async () => {
    const r = await createBuiltinChecker({ timeoutMs: Number.NaN }).check({
      claim: "c",
      statement: "1 = 1",
      proof: "eval",
      timeoutMs: Number.NaN,
    });
    expect(r.ok).toBe(true);
  });

  test("assumption texts are clipped", () => {
    const big = `x = ${Array.from({ length: 700 }, (_, i) => `${i}`).join(" + ")}`;
    const v = check("y = 1", [
      { id: "g", stmt: big, by: "given" },
      { id: "h", stmt: "y = 1 - 0", by: "given" },
      { id: "a", stmt: "y = 1", by: "arith", from: [] },
    ]);
    expect(v.assumptions[0]?.length).toBeLessThanOrEqual(2_000);
  });

  test("garbage input never throws", () => {
    for (const [statement, proof] of [
      [undefined, "eval"],
      ["1 = 1", undefined],
      ["1 = 1", "null"],
      ["1 = 1", "[null]"],
      ["1 = 1", "[{}]"],
      ["\u0000", "eval"],
    ] as const) {
      const v = checkCertificate({
        statement: statement as unknown as string,
        proof: proof as unknown as string,
      });
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe("string");
    }
  });

  test("the output trace is clipped to a few KB", () => {
    const steps = Array.from({ length: 400 }, (_, i) => ({
      id: `step_number_${i}`,
      stmt: "1 = 1",
      by: "eval",
    }));
    const v = check("1 = 1", steps);
    accepted(v);
    expect(v.output.length).toBeLessThanOrEqual(4_100);
    expect(v.output).toMatch(/characters of trace omitted/);
  });
});

describe("createBuiltinChecker — the ProofChecker contract", () => {
  test("id, language, always available", async () => {
    const c = createBuiltinChecker();
    expect(c.id).toBe(BUILTIN_CHECKER_ID);
    expect(c.id).toBe("builtin");
    expect(await c.available()).toEqual({ ok: true });
    expect(c.language).toBe(BUILTIN_LANGUAGE);
  });

  test("the language paragraph names every rule and the escape hatch", () => {
    for (const rule of BUILTIN_RULES) expect(BUILTIN_LANGUAGE).toContain(rule);
    expect(BUILTIN_LANGUAGE).toMatch(/smt or lean4/);
    expect(BUILTIN_LANGUAGE).toMatch(/Example:/);
  });

  test("the example in the language paragraph is itself accepted", async () => {
    const m = /statement `([^`]+)` \(no two meetings overlap\), proof `eval`/.exec(
      BUILTIN_LANGUAGE,
    );
    expect(m).not.toBeNull();
    const result = await createBuiltinChecker().check({
      claim: "No two meetings overlap.",
      statement: (m as RegExpExecArray)[1] as string,
      proof: "eval",
    });
    expect(result.ok).toBe(true);
  });

  test("check() returns a full CheckResult with a duration", async () => {
    const r = await createBuiltinChecker({ timeoutMs: 5_000 }).check({
      claim: "three is odd",
      statement: "exists k in 0..3: 2*k + 1 = 3",
      proof: "eval",
    });
    expect(r).toMatchObject({ ok: true, checker: "builtin", assumptions: [], axioms: [] });
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

import { describe, expect, test } from "bun:test";
import { Z3_HEALTHCHECK_ARGV, Z3_IMAGE_REF } from "@crewhaus/sandbox-image-z3";
import {
  SMT_LANGUAGE,
  SMT_LIMITS,
  SMT_PREAMBLE_COMMANDS,
  SMT_RESERVED_NAMES,
  buildSmtScript,
  createSmtChecker,
  formatModel,
  parseSExprs,
  parseSmtOutput,
  printSExpr,
} from "./smt";
import { fakeSandbox } from "./test-helpers";

const PREAMBLE = "(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))";
const GOAL = "(<= (+ x y) 10)";

/** What real Z3 prints for each outcome (captured from z3 4.x with this script shape). */
const Z3 = {
  proved: 'sat\nunsat\n(error "line 11 column 10: model is not available")\n',
  counterexample:
    "sat\nsat\n(\n  (define-fun x () Int\n    4)\n  (define-fun y () Int\n    (- 6))\n)\n",
  inconsistent: 'unsat\nunsat\n(error "line 10 column 10: model is not available")\n',
  /** A goal with no free constants: Z3's model is empty. */
  emptyModel: "sat\nsat\n(\n)\n",
  preambleError:
    '(error "line 5 column 11: unknown constant z")\nsat\nsat\n(\n  (define-fun x () Int\n    0)\n)\n',
  goalError: 'sat\n(error "line 9 column 18: invalid assert command, term is not Boolean")\nsat\n',
  unknownFirst: "unknown\nunknown\n",
  unknownGoal: "sat\nunknown\n",
};

describe("S-expressions", () => {
  test("atoms keep their raw text; comments vanish; printing is single-spaced", () => {
    const [e] = parseSExprs('(assert (= s "a ""quoted"" (str)")) ; trailing\n');
    expect(printSExpr(e as never)).toBe('(assert (= s "a ""quoted"" (str)"))');
    expect(parseSExprs("(declare-const |odd name; (x)| Int)")[0]).toEqual([
      "declare-const",
      "|odd name; (x)|",
      "Int",
    ]);
    expect(parseSExprs("#b101 #xFF 1.5 :named")).toEqual(["#b101", "#xFF", "1.5", ":named"]);
  });

  test("unbalanced, unterminated and ambiguous input is refused", () => {
    expect(() => parseSExprs("(a (b)")).toThrow(/never closed/);
    expect(() => parseSExprs("a)")).toThrow(/unbalanced `\)`/);
    expect(() => parseSExprs('"abc')).toThrow(/unterminated string/);
    expect(() => parseSExprs("|abc")).toThrow(/unterminated quoted symbol/);
    // A backslash escape would end the string somewhere else for an older reader.
    expect(() => parseSExprs('(assert (= s "a\\" ) (exit) ("))')).toThrow(/backslash/);
    expect(() => parseSExprs("(a |b\\c|)")).toThrow(/backslash/);
    expect(() => parseSExprs("(a\u0007)")).toThrow(/control character/);
  });

  test("depth and size are capped", () => {
    expect(() =>
      parseSExprs(`${"(".repeat(SMT_LIMITS.maxDepth + 1)}${")".repeat(SMT_LIMITS.maxDepth + 1)}`),
    ).toThrow(/nesting deeper/);
    expect(() => parseSExprs("a ".repeat(SMT_LIMITS.maxNodes + 1))).toThrow(/too large/);
  });

  test("output mode tolerates backslashes", () => {
    expect(parseSExprs('(error "a \\"b\\"")', false)).toEqual([["error", '"a \\"b\\""']]);
  });
});

describe("buildSmtScript — the exact script shape", () => {
  test("header, the preamble re-printed, two checks, model, exit", () => {
    const { script, assumptions } = buildSmtScript(
      GOAL,
      "(declare-const x Int) ; a comment\n(declare-const y Int)\n(assert (<= x 4))\n(assert   (<= y 6))",
      7_000,
    );
    expect(script).toBe(
      [
        "(set-option :print-success false)",
        "(set-option :produce-models true)",
        "(set-option :timeout 7000)",
        "(declare-const x Int)",
        "(declare-const y Int)",
        "(assert (<= x 4))",
        "(assert (<= y 6))",
        "(check-sat)",
        "(assert (not (<= (+ x y) 10)))",
        "(check-sat)",
        "(get-model)",
        "(exit)",
        "",
      ].join("\n"),
    );
    expect(assumptions).toEqual(["(<= x 4)", "(<= y 6)"]);
  });

  test("every allowed command passes; set-logic only first", () => {
    const pre = [
      "(set-logic ALL)",
      "(declare-sort U 0)",
      "(define-sort Pair () (Array Int Int))",
      "(declare-datatypes ((Color 0)) (((red) (green))))",
      "(declare-datatype Dir ((up) (down)))",
      "(declare-fun f (Int) Int)",
      "(define-fun g ((a Int)) Int (+ a 1))",
      "(declare-const c Color)",
      "(assert (= (f 1) 2))",
    ].join("\n");
    // A definition fixes a value the goal may rest on, so it is listed too.
    expect(buildSmtScript("(= (g 1) 2)", pre, 1_000).assumptions).toEqual([
      "(define-fun g ((a Int)) Int (+ a 1))",
      "(= (f 1) 2)",
    ]);
    expect(SMT_PREAMBLE_COMMANDS).toContain("declare-datatypes");
    expect(() => buildSmtScript("true", "(declare-const x Int) (set-logic QF_LIA)", 1_000)).toThrow(
      /set-logic` must be the first/,
    );
  });

  test("every other command is refused with a reason", () => {
    for (const cmd of [
      "(check-sat)",
      "(check-sat-assuming (a))",
      "(exit)",
      "(push 1)",
      "(pop 1)",
      "(reset)",
      "(reset-assertions)",
      '(echo "hi")',
      '(set-option :regular-output-channel "/tmp/x")',
      "(set-info :status sat)",
      "(get-model)",
      "(get-value (x))",
      "(eval x)",
      "(simplify x)",
      '(include "other.smt2")',
    ]) {
      const head = cmd.slice(1).split(/[\s)]/)[0];
      expect(() => buildSmtScript("true", cmd, 1_000)).toThrow(
        new RegExp(`\`${head}\` is not allowed`),
      );
    }
  });

  test("the preamble may not declare `not`, which negates the goal", () => {
    for (const pre of [
      "(declare-const not Bool)",
      "(declare-fun |not| (Bool) Bool)",
      "(define-fun not ((b Bool)) Bool b)",
      "(declare-datatypes ((T 0)) (((not) (yes))))",
      "(declare-datatype T ((mk (not Bool))))",
    ]) {
      expect(() => buildSmtScript("true", pre, 1_000)).toThrow(/may not declare `not`/);
    }
    // Using `not` is fine; only declaring it is refused.
    expect(() =>
      buildSmtScript("(f true)", "(define-fun f ((b Bool)) Bool (not (not b)))", 1_000),
    ).not.toThrow();
  });

  // Z3 4.11 accepts a redefinition of its own built-ins; each of these made a
  // false goal "proven" with no assumptions (adversarial review, W1-D).
  test("no name may shadow an SMT-LIB/Z3 built-in", () => {
    for (const [goal, pre] of [
      ["(<= 11 10)", "(define-fun <= ((a Int) (b Int)) Bool true)"],
      ["(= 1 2)", "(define-fun = ((a Int) (b Int)) Bool true)"],
      ["(= (+ 2 2) 5)", "(define-fun + ((a Int) (b Int)) Int 5)"],
      ["false", "(define-fun false () Bool true)"],
      ["false", "(declare-const false Bool) (assert false)"],
      ["(> 1 2)", "(define-fun > ((a Int) (b Int)) Bool true)"],
      ["(=> true false)", "(define-fun => ((a Bool) (b Bool)) Bool true)"],
      ["(= (ite true 1 2) 0)", "(define-fun ite ((c Bool) (a Int) (b Int)) Int 0)"],
      ["true", "(declare-fun |<=| (Int Int) Bool)"],
      ["true", "(declare-const |false| Bool)"],
      ["true", "(declare-const true Bool)"],
      ["true", "(declare-fun distinct (Int Int) Bool)"],
      ["true", "(declare-fun div (Int Int) Int)"],
      ["true", "(declare-fun select (Int Int) Int)"],
      ["true", "(declare-fun bvadd (Int Int) Int)"],
      ["true", "(declare-fun bvnego (Int) Int)"],
      ["true", "(define-sort Int () Bool)"],
      ["true", "(declare-sort Real 0)"],
      ["true", "(declare-datatypes ((T 0)) (((true) (other))))"],
      ["true", "(declare-datatype T ((mk (ite Int))))"],
      ["true", "(declare-datatypes ((Bool 0)) (((a) (b))))"],
      ["true", "(declare-datatypes ((L 1)) ((par (Int) ((nil) (cons (hd Int) (tl (L Int)))))))"],
      ["true", "(define-fun f ((true Bool)) Bool true)"],
      ["true", "(define-sort S (Int) Int)"],
    ] as const) {
      expect(() => buildSmtScript(goal, pre, 1_000)).toThrow(
        /^proof: the preamble may not declare `[^`]+` \(.*\): it is an SMT-LIB\/Z3 built-in|^proof: `[^`]+` \(.*\) is not an accepted name/,
      );
    }
  });

  test("binders and :named labels in the terms are checked too", () => {
    for (const [goal, pre, where] of [
      ["(let ((false true)) false)", "", "statement"],
      ["(forall ((false Bool)) false)", "", "statement"],
      ["(exists ((ite Int)) true)", "", "statement"],
      ["((lambda ((not Bool)) not) true)", "", "statement"],
      ["(! (= 1 1) :named true)", "", "statement"],
      ["true", "(assert (let ((<= 1)) (= <= 1)))", "proof"],
      ["true", "(define-fun f () Bool (forall ((and Bool)) and))", "proof"],
      ["true", "(declare-const x Int) (assert (! (> x 0) :named or))", "proof"],
      [
        "true",
        "(declare-datatypes ((C 0)) (((red) (blue)))) (declare-const c C) (assert (match c ((false true) (blue true))))",
        "proof",
      ],
    ] as const) {
      expect(() => buildSmtScript(goal, pre, 1_000)).toThrow(new RegExp(`^${where}: `));
    }
  });

  test("names are plain identifiers, declared once", () => {
    for (const pre of [
      "(declare-const x-1 Int)",
      "(declare-const a.b Int)",
      "(declare-const |my var| Int)",
      "(declare-const x!0 Int)",
      "(declare-const _x Int)",
      "(declare-const 5x Int)",
    ]) {
      expect(() => buildSmtScript("true", pre, 1_000)).toThrow(/is not an accepted name/);
    }
    expect(() =>
      buildSmtScript("true", "(declare-const x Int) (declare-const |x| Real)", 1_000),
    ).toThrow(/`x` is declared twice/);
    expect(() =>
      buildSmtScript("true", "(declare-const h Int) (assert (! (> h 0) :named h))", 1_000),
    ).toThrow(/`h` is declared twice/);
    // A sort and a constant may share a name: separate namespaces.
    expect(() =>
      buildSmtScript("true", "(declare-sort T 0) (declare-const T T)", 1_000),
    ).not.toThrow();
    // Ordinary names, quoted or not, and built-ins merely USED, are fine.
    const ok = buildSmtScript(
      "(and (<= revenue_q3 10) (not false) (= (ite flag 1 2) 1))",
      "(declare-const revenue_q3 Int) (declare-const |flag| Bool) (assert flag) (assert (<= revenue_q3 4))",
      1_000,
    );
    expect(ok.assumptions).toEqual(["flag", "(<= revenue_q3 4)"]);
    expect(() =>
      buildSmtScript(
        "(forall ((n Int)) (let ((m (+ n 1))) (> m n)))",
        "(declare-datatypes ((L 1)) ((par (T) ((nil) (cons (hd T) (tl (L T)))))))",
        1_000,
      ),
    ).not.toThrow();
    expect(SMT_RESERVED_NAMES.has("ite")).toBe(true);
  });

  test("the legacy declare-datatypes form is refused with the 2.6 shape", () => {
    expect(() =>
      buildSmtScript("true", "(declare-datatypes () ((Color red green)))", 1_000),
    ).toThrow(/SMT-LIB 2.6 form/);
    expect(() =>
      buildSmtScript("true", "(declare-datatypes ((Color 0)) ((red green)))", 1_000),
    ).toThrow(/a constructor \(written `\(name selector…\)`/);
  });

  test("a define-fun is an assumption: it can fix the very value the goal states", () => {
    // Without this, `(define-fun revenue () Int 5)` proved `(= revenue 5)` with
    // assumptions: [] (adversarial review, W1-D).
    expect(
      buildSmtScript("(= revenue 5)", "(define-fun revenue () Int 5)", 1_000).assumptions,
    ).toEqual(["(define-fun revenue () Int 5)"]);
  });

  test("repeated asserts are one assumption; very long ones are clipped", () => {
    const long = `(assert (= x (+ ${"1 ".repeat(1_500)})))`;
    const { assumptions } = buildSmtScript(
      "true",
      `(declare-const x Int) (assert (> x 0)) (assert (> x 0)) ${long}`,
      1_000,
    );
    expect(assumptions[0]).toBe("(> x 0)");
    expect(assumptions).toHaveLength(2);
    expect((assumptions[1] as string).length).toBeLessThanOrEqual(2_000);
  });

  test("the preamble must be commands, the statement exactly one term", () => {
    expect(() => buildSmtScript("true", "x", 1_000)).toThrow(/must be a command/);
    expect(() => buildSmtScript("true", "()", 1_000)).toThrow(/must be a command/);
    expect(() => buildSmtScript("true", "((assert x))", 1_000)).toThrow(/must be a command/);
    expect(() => buildSmtScript("true", "(assert)", 1_000)).toThrow(/exactly one term/);
    expect(() => buildSmtScript("", "", 1_000)).toThrow(/exactly one SMT-LIB term, found none/);
    // A statement that tries to close the assert and run commands of its own:
    expect(() => buildSmtScript("true)) (check-sat) (assert (not true", "", 1_000)).toThrow(
      /unbalanced|exactly one/,
    );
    expect(() => buildSmtScript("true false", "", 1_000)).toThrow(/found 2/);
    expect(() => buildSmtScript("(= x", "", 1_000)).toThrow(/^statement: /);
    expect(() => buildSmtScript("true", "(assert", 1_000)).toThrow(/^proof: /);
  });

  test("sizes are capped", () => {
    expect(() => buildSmtScript("x".repeat(SMT_LIMITS.maxStatementChars + 1), "", 1_000)).toThrow(
      /statement is .* characters/,
    );
    expect(() =>
      buildSmtScript("true", " ".repeat(SMT_LIMITS.maxPreambleChars + 1), 1_000),
    ).toThrow(/preamble is .* characters/);
  });
});

describe("parseSmtOutput", () => {
  test("answers in order; the get-model error after unsat is dropped", () => {
    expect(parseSmtOutput(Z3.proved)).toEqual({ answers: ["sat", "unsat"], errors: [] });
  });

  test("a sat goal carries the model", () => {
    expect(parseSmtOutput(Z3.counterexample)).toEqual({
      answers: ["sat", "sat"],
      errors: [],
      model: "x = 4, y = -6",
    });
  });

  test("errors before the second answer are kept, in place", () => {
    expect(parseSmtOutput(Z3.preambleError).errors).toEqual([
      "line 5 column 11: unknown constant z",
    ]);
    expect(parseSmtOutput(Z3.goalError)).toMatchObject({
      answers: ["sat", "sat"],
      errors: ["line 9 column 18: invalid assert command, term is not Boolean"],
    });
  });

  test("formatModel renders functions, fractions and negatives", () => {
    expect(
      formatModel(
        "(\n (define-fun r () Real (/ 1 2))\n (define-fun f ((x!0 Int)) Int (ite (= x!0 1) 2 0))\n (define-fun n () Int (- 3))\n)",
      ),
    ).toBe("r = 1/2, f(x!0) = (ite (= x!0 1) 2 0), n = -3");
    // Older Z3 wraps the model in `(model …)`.
    expect(formatModel("(model (define-fun x () Int 1))")).toBe("x = 1");
    expect(formatModel("not an s-expression (")).toBe("not an s-expression (");
    // An empty model (a goal with no free constants) renders as nothing.
    expect(formatModel("(\n)")).toBe("");
    expect(parseSmtOutput(Z3.emptyModel)).toEqual({ answers: ["sat", "sat"], errors: [] });
  });
});

describe("createSmtChecker — with a scripted sandbox", () => {
  test("runs `z3 -in` on the curated image with the script on stdin, once", async () => {
    const sandbox = fakeSandbox([{ stdout: Z3.proved }]);
    const checker = createSmtChecker({ sandbox, timeoutMs: 9_000 });
    const r = await checker.check({
      claim: "x + y is at most 10",
      statement: GOAL,
      proof: PREAMBLE,
    });
    expect(r).toMatchObject({
      ok: true,
      checker: "smt",
      assumptions: ["(<= x 4)", "(<= y 6)"],
      axioms: [],
    });
    expect(r.reason).toBeUndefined();
    expect(sandbox.calls).toHaveLength(1);
    const call = sandbox.calls[0];
    expect(call?.image).toBe(Z3_IMAGE_REF);
    expect(call?.argv).toEqual(["z3", "-in"]);
    expect(call?.timeoutMs).toBe(9_000);
    expect(call?.stdin).toBe(buildSmtScript(GOAL, PREAMBLE, 3_000).script);
    expect(checker.image).toBe(Z3_IMAGE_REF);
  });

  test("sat on the negated goal: rejected with the model as counterexample", async () => {
    const r = await createSmtChecker({
      sandbox: fakeSandbox([{ stdout: Z3.counterexample }]),
    }).check({
      claim: "c",
      statement: GOAL,
      proof: PREAMBLE,
    });
    expect(r.ok).toBe(false);
    expect(r.counterexample).toBe("x = 4, y = -6");
    expect(r.reason).toMatch(/goal does not follow: z3 found a counterexample \(x = 4, y = -6\)/);
    expect(r.assumptions).toEqual(["(<= x 4)", "(<= y 6)"]);
  });

  test("inconsistent hypotheses are rejected even though the goal is unsat", async () => {
    const r = await createSmtChecker({ sandbox: fakeSandbox([{ stdout: Z3.inconsistent }]) }).check(
      {
        claim: "c",
        statement: "(> x 100)",
        proof: "(declare-const x Int) (assert (< x 0)) (assert (> x 5))",
      },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("the hypotheses are inconsistent; anything follows from them");
  });

  test("unknown on either check is a rejection, never a pass", async () => {
    const first = await createSmtChecker({
      sandbox: fakeSandbox([{ stdout: Z3.unknownFirst }]),
    }).check({
      claim: "c",
      statement: GOAL,
      proof: PREAMBLE,
    });
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/could not decide whether the hypotheses are consistent/);
    const goal = await createSmtChecker({
      sandbox: fakeSandbox([{ stdout: Z3.unknownGoal }]),
    }).check({
      claim: "c",
      statement: GOAL,
      proof: PREAMBLE,
    });
    expect(goal.ok).toBe(false);
    expect(goal.reason).toMatch(/could not decide the goal/);
  });

  test("a z3 error anywhere before the second answer rejects", async () => {
    for (const stdout of [Z3.preambleError, Z3.goalError]) {
      const r = await createSmtChecker({ sandbox: fakeSandbox([{ stdout }]) }).check({
        claim: "c",
        statement: GOAL,
        proof: PREAMBLE,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^z3 reported an error: line \d+ column \d+/);
    }
  });

  test("timeouts, crashes, sandbox errors and missing answers reject", async () => {
    const cases: Array<[Parameters<typeof fakeSandbox>[0], RegExp]> = [
      [[{ timedOut: true, exitCode: 137 }], /did not finish within 30000 ms/],
      [[{ exitCode: 137, stderr: "Killed" }], /gave no answer \(exit 137\): Killed/],
      [[{ stdout: "sat\n", exitCode: 0 }], /stopped before checking the goal/],
      [
        [{ throws: new Error("image not on the allowlist") }],
        /could not run z3: image not on the allowlist/,
      ],
    ];
    for (const [replies, reason] of cases) {
      const r = await createSmtChecker({ sandbox: fakeSandbox(replies) }).check({
        claim: "c",
        statement: GOAL,
        proof: PREAMBLE,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(reason);
    }
  });

  test("a refused preamble never reaches the sandbox", async () => {
    const sandbox = fakeSandbox([]);
    const r = await createSmtChecker({ sandbox }).check({
      claim: "c",
      statement: "true",
      proof: "(check-sat)",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/`check-sat` is not allowed/);
    const shadow = await createSmtChecker({ sandbox }).check({
      claim: "c",
      statement: "(<= 11 10)",
      proof: "(define-fun <= ((a Int) (b Int)) Bool true)",
    });
    expect(shadow.ok).toBe(false);
    expect(shadow.reason).toMatch(
      /may not declare `<=`|`<=` \(a definition\) is not an accepted name/,
    );
    expect(sandbox.calls).toHaveLength(0);
  });

  test("an empty model still gives a counterexample sentence, not `( )`", async () => {
    const r = await createSmtChecker({ sandbox: fakeSandbox([{ stdout: Z3.emptyModel }]) }).check({
      claim: "c",
      statement: "(forall ((x Int)) (> (* x x x) (- 0 1)))",
      proof: "",
    });
    expect(r.ok).toBe(false);
    expect(r.counterexample).toBe("z3 found the negated goal satisfiable but showed no values");
    expect(r.reason).toBe(
      "the goal does not follow: z3 found a counterexample (z3 found the negated goal satisfiable but showed no values)",
    );
  });

  test("the per-check timeout and the image override are honoured", async () => {
    const sandbox = fakeSandbox([{ stdout: Z3.proved }]);
    await createSmtChecker({
      sandbox,
      image: "registry.example/z3:pinned",
      timeoutMs: 30_000,
    }).check({
      claim: "c",
      statement: GOAL,
      proof: PREAMBLE,
      timeoutMs: 1_500,
    });
    expect(sandbox.calls[0]?.image).toBe("registry.example/z3:pinned");
    expect(sandbox.calls[0]?.timeoutMs).toBe(1_500);
    // Each solver call gets a third of the budget, at least a second.
    expect(sandbox.calls[0]?.stdin).toContain("(set-option :timeout 1000)");
  });

  test("a NaN or negative budget falls back to the default instead of disabling it", async () => {
    for (const bad of [Number.NaN, -1]) {
      const sandbox = fakeSandbox([{ stdout: Z3.proved }]);
      await createSmtChecker({ sandbox, timeoutMs: bad }).check({
        claim: "c",
        statement: GOAL,
        proof: PREAMBLE,
        timeoutMs: bad,
      });
      expect(sandbox.calls[0]?.timeoutMs).toBe(30_000);
      expect(sandbox.calls[0]?.stdin).toContain("(set-option :timeout 10000)");
    }
  });

  test("an aborted signal reports cancellation", async () => {
    const ac = new AbortController();
    ac.abort();
    const sandbox = fakeSandbox([{ exitCode: -1 }]);
    const r = await createSmtChecker({ sandbox }).check({
      claim: "c",
      statement: GOAL,
      proof: PREAMBLE,
      signal: ac.signal,
    });
    expect(sandbox.calls[0]?.signal).toBe(ac.signal);
    expect(r.reason).toBe("the check was cancelled");
  });

  test("output keeps stderr and is clipped", async () => {
    const r = await createSmtChecker({
      sandbox: fakeSandbox([
        { stdout: `${Z3.proved}${"x".repeat(10_000)}`, stderr: "warning: something" },
      ]),
    }).check({ claim: "c", statement: GOAL, proof: PREAMBLE });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThan(4_200);
    expect(r.output).toMatch(/characters omitted/);
    expect(r.output).toMatch(/\[stderr\]\nwarning: something/);
  });
});

describe("the noop backend and availability", () => {
  test("noop: unavailable and refused, unless trusted code opts in", async () => {
    const sandbox = fakeSandbox([{ stdout: Z3.proved }], "noop");
    const checker = createSmtChecker({ sandbox });
    const a = await checker.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/backend is noop \(no isolation\); set CREWHAUS_SANDBOX=docker/);
    const r = await checker.check({ claim: "c", statement: GOAL, proof: PREAMBLE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(a.reason);
    expect(sandbox.calls).toHaveLength(0);

    const trusted = fakeSandbox([{ exitCode: 0 }, { stdout: Z3.proved }], "noop");
    const allowed = createSmtChecker({ sandbox: trusted, allowNoop: true });
    expect((await allowed.available()).ok).toBe(true);
    expect((await allowed.check({ claim: "c", statement: GOAL, proof: PREAMBLE })).ok).toBe(true);
  });

  test("available() runs the image healthcheck once and remembers a pass", async () => {
    const sandbox = fakeSandbox([{ exitCode: 0, stdout: "Z3 version 4.13.0" }]);
    const checker = createSmtChecker({ sandbox, probeTimeoutMs: 5_000 });
    const [a, b] = await Promise.all([checker.available(), checker.available()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(await checker.available()).toEqual({ ok: true });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]).toMatchObject({
      image: Z3_IMAGE_REF,
      argv: [...Z3_HEALTHCHECK_ARGV],
      timeoutMs: 5_000,
    });
  });

  test("a failed probe says why, is remembered for a while, then retried", async () => {
    let now = 1_000;
    const sandbox = fakeSandbox([
      { exitCode: 125, stderr: "Unable to find image" },
      { exitCode: 0 },
    ]);
    const checker = createSmtChecker({ sandbox, now: () => now, probeRetryMs: 60_000 });
    const first = await checker.available();
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(
      /smt image .* is not ready: `z3 --version` exited 125: Unable to find image/,
    );
    now += 30_000;
    expect(await checker.available()).toEqual(first);
    expect(sandbox.calls).toHaveLength(1);
    now += 31_000;
    expect(await checker.available()).toEqual({ ok: true });
    expect(sandbox.calls).toHaveLength(2);
  });

  test("a probe that times out or throws is reported, not thrown", async () => {
    const slow = await createSmtChecker({
      sandbox: fakeSandbox([{ timedOut: true, exitCode: -1 }]),
    }).available();
    expect(slow.reason).toMatch(/timed out \(the image may still be pulling\)/);
    const broken = await createSmtChecker({
      sandbox: fakeSandbox([{ throws: new Error("docker: not found") }]),
    }).available();
    expect(broken.reason).toMatch(/could not be probed: docker: not found/);
  });
});

describe("the language paragraph", () => {
  test("states the input shape, the refused commands and an example", () => {
    expect(SMT_LANGUAGE).toMatch(/ONE SMT-LIB Boolean term/);
    expect(SMT_LANGUAGE).toMatch(/no check-sat, push\/pop, set-option, get-\* or exit/);
    expect(SMT_LANGUAGE).toMatch(/inconsistent hypotheses/);
    expect(SMT_LANGUAGE).toMatch(/not a built-in/);
    expect(SMT_LANGUAGE).toMatch(/Every assert and every define-fun is listed as an assumption/);
    expect(SMT_LANGUAGE).toMatch(/Example:/);
  });
});

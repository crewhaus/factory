/**
 * The smt adapter against a REAL Z3 on the host, through `@crewhaus/sandbox`'s
 * noop backend (which runs the argv directly — hence `allowNoop`, trusted test
 * code only). Gated: set `CREWHAUS_PROOF_CHECKER_HOST_Z3=1` with `z3` on PATH.
 * It pins the script shape and the output parser to what Z3 actually prints;
 * the container image is exercised by the live-docker test of the image
 * build, not here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createSandbox } from "@crewhaus/sandbox";
import { Z3_IMAGE_REF } from "@crewhaus/sandbox-image-z3";
import { createSmtChecker } from "./smt";

const HOST_Z3 = process.env["CREWHAUS_PROOF_CHECKER_HOST_Z3"] === "1";

describe.skipIf(!HOST_Z3)("smt checker against host z3", () => {
  const sandbox = createSandbox({ backend: "noop", allowedImages: [Z3_IMAGE_REF] });
  const checker = createSmtChecker({ sandbox, allowNoop: true, timeoutMs: 20_000 });
  const run = (statement: string, proof: string) => checker.check({ claim: "c", statement, proof });
  afterAll(async () => {
    await sandbox.close();
  });

  test("available() passes the healthcheck", async () => {
    expect(await checker.available()).toEqual({ ok: true });
  });

  test("proves a linear goal from its hypotheses", async () => {
    const r = await run(
      "(<= (+ x y) 10)",
      "(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))",
    );
    expect(r.ok).toBe(true);
    expect(r.assumptions).toEqual(["(<= x 4)", "(<= y 6)"]);
  });

  test("rejects a false goal with Z3's model", async () => {
    const r = await run(
      "(<= (+ x y) 9)",
      "(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))",
    );
    expect(r.ok).toBe(false);
    expect(r.counterexample).toMatch(/^x = -?\d+, y = -?\d+$/);
  });

  test("rejects inconsistent hypotheses", async () => {
    const r = await run("(> x 100)", "(declare-const x Int) (assert (< x 0)) (assert (> x 5))");
    expect(r.reason).toBe("the hypotheses are inconsistent; anything follows from them");
  });

  test("reports Z3's own errors", async () => {
    const r = await run("(> x 1)", "(declare-const x Int) (assert (< y 0))");
    expect(r.reason).toMatch(/^z3 reported an error: .*unknown constant y/);
    const typed = await run("x", "(declare-const x Int)");
    expect(typed.ok).toBe(false);
    expect(typed.reason).toMatch(/^z3 reported an error/);
  });

  // Real Z3 accepts each of these redefinitions and then "proves" the false
  // goal with no assumptions; the adapter refuses them before Z3 runs
  // (adversarial review, W1-D).
  test("a preamble that redefines a built-in is refused, so the false goal stays unproven", async () => {
    for (const [goal, pre] of [
      ["(<= 11 10)", "(define-fun <= ((a Int) (b Int)) Bool true)"],
      ["(= (+ 2 2) 5)", "(define-fun + ((a Int) (b Int)) Int 5)"],
      ["false", "(define-fun false () Bool true)"],
      ["false", "(declare-const false Bool) (assert false)"],
      ["(= 1 2)", "(define-fun = ((a Int) (b Int)) Bool true)"],
      ["(= (ite true 1 2) 0)", "(define-fun ite ((c Bool) (a Int) (b Int)) Int 0)"],
      ["(let ((false true)) false)", ""],
    ] as const) {
      const r = await run(goal, pre);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/may not declare|is not an accepted name/);
    }
  });

  test("a define-fun that fixes the goal's value is listed as an assumption", async () => {
    const r = await run("(= revenue 5)", "(define-fun revenue () Int 5)");
    expect(r.ok).toBe(true);
    expect(r.assumptions).toEqual(["(define-fun revenue () Int 5)"]);
  });

  test("a false goal with no free constants gets a sentence, not an empty model", async () => {
    const r = await run("(forall ((x Int)) (> (* x x x) (- 0 1)))", "");
    expect(r.ok).toBe(false);
    expect(r.counterexample).toBe("z3 found the negated goal satisfiable but showed no values");
  });

  test("non-linear real arithmetic, datatypes and quantifiers", async () => {
    expect((await run("(> (* x x) 0.0)", "(declare-const x Real) (assert (> x 0.5))")).ok).toBe(
      true,
    );
    expect(
      (
        await run(
          "(or (= c red) (= c green))",
          "(declare-datatypes ((Color 0)) (((red) (green)))) (declare-const c Color)",
        )
      ).ok,
    ).toBe(true);
    expect(
      (await run("(forall ((n Int)) (=> (> n 0) (>= (* 2 n) 2)))", "(set-logic ALL)")).ok,
    ).toBe(true);
  });
});

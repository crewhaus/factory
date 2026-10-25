/**
 * Polynomial normal form for `arith` over variables (design §6.4: "both sides
 * normalize to the same exact value").
 *
 * A comparison with free variables is accepted only when it holds for EVERY
 * value of them: `lhs - rhs` is expanded into a sum of monomials with exact
 * rational coefficients, and an equation must cancel to zero, a disequation
 * or inequality to a constant that satisfies it. `(x + 1)^2 = x^2 + 2*x + 1`
 * passes; `x * x = x` does not, though it holds at `x = 1`. Anything that is
 * not a polynomial in the variables (division by a variable, `abs`/`min`/
 * `max` or an index over one) is refused rather than guessed.
 */
import { BUILTIN_LIMITS, type Budget, CheckFailure } from "./budget";
import { evalClosed } from "./evaluate";
import {
  ONE,
  type Rat,
  ZERO,
  add,
  div,
  isInteger,
  mul,
  neg,
  pow,
  rat,
  ratToString,
} from "./rational";
import { type Term, freeVarsTerm } from "./syntax";

/** Monomial key (`x^2*y`, sorted by variable) → coefficient. "" is the constant. */
export type Poly = Map<string, Rat>;

type Mono = ReadonlyArray<readonly [string, number]>;

function keyOf(m: Mono): string {
  return m.map(([v, e]) => (e === 1 ? v : `${v}^${e}`)).join("*");
}

function monoOf(key: string): Mono {
  if (key === "") return [];
  return key.split("*").map((part) => {
    const caret = part.indexOf("^");
    return caret < 0
      ? ([part, 1] as const)
      : ([part.slice(0, caret), Number(part.slice(caret + 1))] as const);
  });
}

function mulMono(a: Mono, b: Mono): Mono {
  const exps = new Map<string, number>();
  for (const [v, e] of [...a, ...b]) exps.set(v, (exps.get(v) ?? 0) + e);
  for (const [v, e] of exps) {
    if (e > BUILTIN_LIMITS.maxSymbolicExponent) {
      throw new CheckFailure(
        `arith: \`${v}\` reaches degree ${e}; the cap is ${BUILTIN_LIMITS.maxSymbolicExponent}`,
      );
    }
  }
  return [...exps.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

function constant(c: Rat): Poly {
  const p: Poly = new Map();
  if (c.n !== 0n) p.set("", c);
  return p;
}

function addInto(p: Poly, key: string, c: Rat): void {
  const sum = add(p.get(key) ?? ZERO, c);
  if (sum.n === 0n) p.delete(key);
  else p.set(key, sum);
  if (p.size > BUILTIN_LIMITS.maxMonomials) {
    throw new CheckFailure(
      `arith: the expansion has more than ${BUILTIN_LIMITS.maxMonomials} terms`,
    );
  }
}

function plus(a: Poly, b: Poly, budget: Budget): Poly {
  const out: Poly = new Map(a);
  for (const [k, c] of b) {
    budget.tick();
    addInto(out, k, c);
  }
  return out;
}

function scale(a: Poly, c: Rat): Poly {
  const out: Poly = new Map();
  if (c.n === 0n) return out;
  for (const [k, v] of a) out.set(k, mul(v, c));
  return out;
}

function times(a: Poly, b: Poly, budget: Budget): Poly {
  const out: Poly = new Map();
  for (const [ka, ca] of a) {
    const ma = monoOf(ka);
    for (const [kb, cb] of b) {
      budget.tick();
      addInto(out, keyOf(mulMono(ma, monoOf(kb))), mul(ca, cb));
    }
  }
  return out;
}

/** The constant a polynomial is, or undefined when it has a variable. */
export function constantOf(p: Poly): Rat | undefined {
  if (p.size === 0) return ZERO;
  if (p.size === 1 && p.has("")) return p.get("");
  return undefined;
}

function nonPolynomial(what: string): never {
  throw new CheckFailure(
    `arith: ${what} is not a polynomial in the variables; give the variables values (premises \`x = …\`) or prove it with eval`,
  );
}

/** Expand a term into polynomial normal form. Closed subterms are evaluated exactly. */
export function toPoly(t: Term, budget: Budget): Poly {
  budget.tick();
  switch (t.k) {
    case "num":
      return constant(t.v);
    case "var": {
      const p: Poly = new Map();
      p.set(t.name, ONE);
      return p;
    }
    case "neg":
      return scale(toPoly(t.a, budget), rat(-1n));
    case "add":
      return plus(toPoly(t.a, budget), toPoly(t.b, budget), budget);
    case "sub":
      return plus(toPoly(t.a, budget), scale(toPoly(t.b, budget), rat(-1n)), budget);
    case "mul":
      return times(toPoly(t.a, budget), toPoly(t.b, budget), budget);
    case "div": {
      const divisor = constantOf(toPoly(t.b, budget));
      if (divisor === undefined) return nonPolynomial("division by an expression with a variable");
      return scale(toPoly(t.a, budget), div(ONE, divisor));
    }
    case "pow": {
      const e = constantOf(toPoly(t.b, budget));
      if (e === undefined) return nonPolynomial("a power with a variable exponent");
      const base = toPoly(t.a, budget);
      const c = constantOf(base);
      if (c !== undefined) return constant(pow(c, e));
      if (!isInteger(e) || e.n < 0n) {
        throw new CheckFailure("an exponent must be a non-negative integer");
      }
      if (e.n > BigInt(BUILTIN_LIMITS.maxSymbolicExponent)) {
        throw new CheckFailure(
          `arith: the exponent ${e.n} is above the symbolic cap of ${BUILTIN_LIMITS.maxSymbolicExponent}`,
        );
      }
      let out = constant(ONE);
      for (let i = 0n; i < e.n; i++) out = times(out, base, budget);
      return out;
    }
    case "abs":
    case "min":
    case "max":
    case "idx": {
      // Not polynomial operations: fine on closed arguments, which evaluate.
      if (freeVarsTerm(t).size === 0) return constant(evalClosed(t, budget));
      return nonPolynomial(
        t.k === "idx"
          ? "an index into an array with a variable"
          : `\`${t.k}\` of an expression with a variable`,
      );
    }
  }
}

/** `a - b` in normal form. */
export function difference(a: Term, b: Term, budget: Budget): Poly {
  return plus(toPoly(a, budget), scale(toPoly(b, budget), neg(ONE)), budget);
}

/** `2*x^2 - 3*y + 1` — for rejection messages. */
export function printPoly(p: Poly): string {
  if (p.size === 0) return "0";
  const keys = [...p.keys()].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : a < b ? -1 : a > b ? 1 : 0,
  );
  let out = "";
  for (const key of keys) {
    const c = p.get(key) as Rat;
    const negative = c.n < 0n;
    const mag = negative ? neg(c) : c;
    const coeff = ratToString(mag);
    const body = key === "" ? coeff : coeff === "1" ? key : `${coeff}*${key}`;
    if (out === "") out = negative ? `-${body}` : body;
    else out += negative ? ` - ${body}` : ` + ${body}`;
  }
  return out;
}

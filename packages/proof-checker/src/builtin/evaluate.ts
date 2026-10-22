/**
 * Exact evaluation of closed formulas, and the counterexample a false one
 * yields (design §0 scenario C: "a false claim yields a counterexample —
 * meetings 2 and 5 overlap — and that counterexample, not a rationale, is
 * the retry nudge").
 *
 * Semantics, stated so a model can rely on them:
 *   - every number is an exact rational; `/` by zero, an exponent that is not
 *     a non-negative integer, and an index that is not an in-range integer
 *     are ERRORS (the step is rejected), never values;
 *   - `and`, `or` and `->` evaluate left to right and stop as soon as the
 *     result is known, so `x = 0 or 1/x < 2` is safe at `x = 0`;
 *   - a quantifier enumerates its domain in order: `a..b` is every integer
 *     from `a` to `b` inclusive (empty when `b < a`), `{…}` is its listed
 *     values; each domain is capped, and so is the total enumeration.
 */
import { BUILTIN_LIMITS, type Budget, CheckFailure } from "./budget";
import {
  type Rat,
  absRat,
  add,
  cmp,
  div,
  isInteger,
  mul,
  neg,
  pow,
  rat,
  ratToString,
  sub,
} from "./rational";
import { type CmpOp, type Domain, type Formula, type Term, num, printTerm } from "./syntax";

/** Values of the variables in scope, innermost first. */
export type Env = { readonly name: string; readonly value: Rat; readonly next?: Env };

function lookup(env: Env | undefined, name: string): Rat | undefined {
  for (let e = env; e !== undefined; e = e.next) if (e.name === name) return e.value;
  return undefined;
}

export function extend(env: Env | undefined, name: string, value: Rat): Env {
  return env === undefined ? { name, value } : { name, value, next: env };
}

export function evalTerm(t: Term, env: Env | undefined, budget: Budget): Rat {
  budget.tick();
  switch (t.k) {
    case "num":
      return t.v;
    case "var": {
      const v = lookup(env, t.name);
      if (v === undefined) {
        throw new CheckFailure(
          `\`${t.name}\` has no value; evaluation needs a closed formula (define it with \`let\`, quantify it, or prove the step with given/arith instead)`,
        );
      }
      return v;
    }
    case "neg":
      return neg(evalTerm(t.a, env, budget));
    case "abs":
      return absRat(evalTerm(t.a, env, budget));
    case "min":
    case "max": {
      let best = evalTerm(t.args[0] as Term, env, budget);
      for (let i = 1; i < t.args.length; i++) {
        const v = evalTerm(t.args[i] as Term, env, budget);
        const c = cmp(v, best);
        if ((t.k === "min" && c < 0) || (t.k === "max" && c > 0)) best = v;
      }
      return best;
    }
    case "idx": {
      const i = evalTerm(t.i, env, budget);
      if (!isInteger(i) || i.n < 0n || i.n >= BigInt(t.items.length)) {
        throw new CheckFailure(
          `index ${ratToString(i)} is outside the array of ${t.items.length} element(s) (indexes start at 0)`,
        );
      }
      return evalTerm(t.items[Number(i.n)] as Term, env, budget);
    }
    case "add":
      return add(evalTerm(t.a, env, budget), evalTerm(t.b, env, budget));
    case "sub":
      return sub(evalTerm(t.a, env, budget), evalTerm(t.b, env, budget));
    case "mul":
      return mul(evalTerm(t.a, env, budget), evalTerm(t.b, env, budget));
    case "div":
      return div(evalTerm(t.a, env, budget), evalTerm(t.b, env, budget));
    case "pow":
      return pow(evalTerm(t.a, env, budget), evalTerm(t.b, env, budget));
  }
}

export function compare(op: CmpOp, a: Rat, b: Rat): boolean {
  const c = cmp(a, b);
  switch (op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
  }
}

/** A domain value: the term a rule substitutes, and its value. */
export type DomainValue = { readonly term: Term; readonly value: Rat };

/**
 * The values of a domain, in order. A set keeps its items as written (so
 * `instantiate` and `cases` substitute what the model wrote); a range yields
 * integer literals.
 */
export function domainValues(d: Domain, env: Env | undefined, budget: Budget): DomainValue[] {
  if (d.k === "set") {
    if (d.items.length > BUILTIN_LIMITS.maxDomainSize) {
      throw new CheckFailure(
        `a domain lists ${d.items.length} values; the cap is ${BUILTIN_LIMITS.maxDomainSize}`,
      );
    }
    return d.items.map((term) => ({ term, value: evalTerm(term, env, budget) }));
  }
  const lo = evalTerm(d.lo, env, budget);
  const hi = evalTerm(d.hi, env, budget);
  if (!isInteger(lo) || !isInteger(hi)) {
    throw new CheckFailure(
      `a range needs integer bounds, got ${ratToString(lo)}..${ratToString(hi)}`,
    );
  }
  if (hi.n < lo.n) return [];
  const size = hi.n - lo.n + 1n;
  if (size > BigInt(BUILTIN_LIMITS.maxDomainSize)) {
    throw new CheckFailure(
      `the range ${lo.n}..${hi.n} has ${size} values; the cap is ${BUILTIN_LIMITS.maxDomainSize} — narrow it, or use the smt checker`,
    );
  }
  const out: DomainValue[] = [];
  for (let k = lo.n; k <= hi.n; k++) {
    const value = rat(k);
    out.push({ term: num(value), value });
  }
  return out;
}

export function evalFormula(f: Formula, env: Env | undefined, budget: Budget): boolean {
  budget.tick();
  switch (f.k) {
    case "bool":
      return f.v;
    case "cmp":
      return compare(f.op, evalTerm(f.a, env, budget), evalTerm(f.b, env, budget));
    case "not":
      return !evalFormula(f.a, env, budget);
    case "and":
      return evalFormula(f.a, env, budget) && evalFormula(f.b, env, budget);
    case "or":
      return evalFormula(f.a, env, budget) || evalFormula(f.b, env, budget);
    case "imp":
      return !evalFormula(f.a, env, budget) || evalFormula(f.b, env, budget);
    case "iff":
      return evalFormula(f.a, env, budget) === evalFormula(f.b, env, budget);
    case "forall":
    case "exists": {
      const want = f.k === "exists";
      for (const { value } of domainValues(f.dom, env, budget)) {
        budget.enumerate();
        if (evalFormula(f.body, extend(env, f.v, value), budget) === want) return want;
      }
      return !want;
    }
  }
}

/**
 * Why a closed formula that evaluates false is false: the quantifier
 * assignment that refutes it (`i = 1, j = 4`) and the comparisons that fail
 * there, with their values (`11 <= 10.5 is false`). Call only on a formula
 * {@link evalFormula} has already evaluated false under `env`.
 */
export function explainFalse(f: Formula, env: Env | undefined, budget: Budget): string {
  const bindings: string[] = [];
  const detail = falsify(f, env, budget, bindings, true);
  const where = bindings.length > 0 ? bindings.join(", ") : "";
  if (where !== "" && detail !== "") return `${where}: ${detail}`;
  return where !== "" ? where : detail;
}

/**
 * Walk to the smallest false part. `want` is the truth value that failed to
 * hold (false ⇒ "this formula is false"). Records quantifier assignments into
 * `bindings` and returns a description of the failing comparisons.
 */
function falsify(
  f: Formula,
  env: Env | undefined,
  budget: Budget,
  bindings: string[],
  wantTrue: boolean,
): string {
  switch (f.k) {
    case "bool":
      return `the literal \`${f.v}\``;
    case "cmp": {
      const a = evalTerm(f.a, env, budget);
      const b = evalTerm(f.b, env, budget);
      return `${ratToString(a)} ${f.op} ${ratToString(b)} is ${wantTrue ? "false" : "true"}`;
    }
    case "not":
      return falsify(f.a, env, budget, bindings, !wantTrue);
    case "and":
      if (wantTrue) {
        // One conjunct is false: explain the first.
        return evalFormula(f.a, env, budget)
          ? falsify(f.b, env, budget, bindings, true)
          : falsify(f.a, env, budget, bindings, true);
      }
      return joinParts([
        falsify(f.a, env, budget, bindings, false),
        falsify(f.b, env, budget, bindings, false),
      ]);
    case "or":
      if (wantTrue) {
        // Every disjunct is false.
        return joinParts([
          falsify(f.a, env, budget, bindings, true),
          falsify(f.b, env, budget, bindings, true),
        ]);
      }
      return evalFormula(f.a, env, budget)
        ? falsify(f.a, env, budget, bindings, false)
        : falsify(f.b, env, budget, bindings, false);
    case "imp":
      if (wantTrue) {
        // The premise holds and the conclusion fails.
        return falsify(f.b, env, budget, bindings, true);
      }
      return evalFormula(f.a, env, budget)
        ? falsify(f.b, env, budget, bindings, false)
        : falsify(f.a, env, budget, bindings, true);
    case "iff": {
      const a = evalFormula(f.a, env, budget);
      const b = evalFormula(f.b, env, budget);
      return `the left side of \`<->\` is ${a} and the right side is ${b}`;
    }
    case "forall":
    case "exists": {
      // A false `forall` (or a true `exists` that should be false) has a
      // witness: the first domain value where the body takes the wrong value.
      if ((f.k === "forall" && wantTrue) || (f.k === "exists" && !wantTrue)) {
        const seek = !wantTrue;
        for (const { term, value } of domainValues(f.dom, env, budget)) {
          budget.enumerate();
          const inner = extend(env, f.v, value);
          if (evalFormula(f.body, inner, budget) === seek) {
            bindings.push(`${f.v} = ${printTerm(term)}`);
            return falsify(f.body, inner, budget, bindings, wantTrue);
          }
        }
        return "";
      }
      // A false `exists` (or a true `forall` that should be false) has no
      // single witness: say so.
      return f.k === "exists"
        ? `no ${f.v} in the domain satisfies the body`
        : `every ${f.v} in the domain satisfies the body`;
    }
  }
}

function joinParts(parts: string[]): string {
  return parts.filter((p) => p !== "").join("; ");
}

/** Evaluate a closed term with no variables in scope (instantiation values, arith). */
export function evalClosed(t: Term, budget: Budget): Rat {
  return evalTerm(t, undefined, budget);
}

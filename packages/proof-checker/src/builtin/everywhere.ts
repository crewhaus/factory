/**
 * What holds of a formula at EVERY value of its free variables — the test
 * that keeps a decorative variable from turning a false closed claim into an
 * "open" one (`y = y and 1 = 2`), which inconsistent hypotheses could then
 * "prove" (design §0 scenario C: a false claim is never proven).
 *
 * Read off the formula, never searched for: closed parts are evaluated, a
 * comparison whose sides differ by a constant polynomial is decided (the
 * `arith` identity test), a quantifier over a closed domain inherits from its
 * body, and the connectives combine their parts in the evaluator's
 * left-to-right, stop-early order. Sound and incomplete — `abs(y) >= 0 -> C`
 * is never true when C is false, but nothing here knows `abs(y) >= 0`.
 *
 * Four facts are tracked because an evaluation ERROR (division by zero, an
 * index out of range) is neither true nor false: `not` swaps "never true" and
 * "never false", and `and`'s short circuit needs "true, without error".
 */
import { type Budget, CheckFailure } from "./budget";
import { type Env, compare, domainValues, evalFormula, explainFalse, extend } from "./evaluate";
import { constantOf, difference } from "./poly";
import { ZERO } from "./rational";
import { type Formula, freeVars, freeVarsDomain, freeVarsTerm } from "./syntax";

export type Everywhere = {
  /** True at every value, without error. */
  readonly alwaysTrue: boolean;
  /** False at every value, without error. */
  readonly alwaysFalse: boolean;
  /** Never true: false or an evaluation error at every value. */
  readonly neverTrue: boolean;
  /** Never false: true or an evaluation error at every value. */
  readonly neverFalse: boolean;
};

const UNKNOWN: Everywhere = {
  alwaysTrue: false,
  alwaysFalse: false,
  neverTrue: false,
  neverFalse: false,
};

const constant = (v: boolean): Everywhere =>
  v
    ? { alwaysTrue: true, alwaysFalse: false, neverTrue: false, neverFalse: true }
    : { alwaysTrue: false, alwaysFalse: true, neverTrue: true, neverFalse: false };

/** A failed sub-evaluation (an error, or the probe's caps) is "unknown" — unless the caller has cancelled. */
function unknownUnlessCancelled(err: unknown, budget: Budget): Everywhere {
  if (!(err instanceof CheckFailure)) throw err;
  if (budget.cancelled) throw new CheckFailure("the check was cancelled");
  return UNKNOWN;
}

/**
 * Free variables per node, computed once: asking `freeVars` afresh at every
 * level of a deep formula would be quadratic, and that work never ticks the
 * budget's clock.
 */
type FreeMemo = WeakMap<Formula, ReadonlySet<string>>;

function freeOf(f: Formula, memo: FreeMemo): ReadonlySet<string> {
  const hit = memo.get(f);
  if (hit !== undefined) return hit;
  let out: ReadonlySet<string>;
  switch (f.k) {
    case "bool":
      out = new Set();
      break;
    case "cmp":
      out = freeVarsTerm(f.b, freeVarsTerm(f.a));
      break;
    case "not":
      out = freeOf(f.a, memo);
      break;
    case "forall":
    case "exists": {
      const set = freeVarsDomain(f.dom);
      for (const v of freeOf(f.body, memo)) if (v !== f.v) set.add(v);
      out = set;
      break;
    }
    default: {
      const set = new Set(freeOf(f.a, memo));
      for (const v of freeOf(f.b, memo)) set.add(v);
      out = set;
    }
  }
  memo.set(f, out);
  return out;
}

export function everywhere(f: Formula, budget: Budget): Everywhere {
  return walk(f, budget, new WeakMap());
}

function walk(f: Formula, budget: Budget, memo: FreeMemo): Everywhere {
  budget.tick();
  if (freeOf(f, memo).size === 0) {
    try {
      return constant(evalFormula(f, undefined, budget));
    } catch (err) {
      return unknownUnlessCancelled(err, budget);
    }
  }
  switch (f.k) {
    case "bool":
      return constant(f.v);
    case "cmp": {
      try {
        const c = constantOf(difference(f.a, f.b, budget));
        return c === undefined ? UNKNOWN : constant(compare(f.op, c, ZERO));
      } catch (err) {
        return unknownUnlessCancelled(err, budget);
      }
    }
    case "not": {
      const a = walk(f.a, budget, memo);
      return {
        alwaysTrue: a.alwaysFalse,
        alwaysFalse: a.alwaysTrue,
        neverTrue: a.neverFalse,
        neverFalse: a.neverTrue,
      };
    }
    case "and": {
      // B is evaluated only where A is true.
      const a = walk(f.a, budget, memo);
      const b = walk(f.b, budget, memo);
      return {
        alwaysTrue: a.alwaysTrue && b.alwaysTrue,
        alwaysFalse: a.alwaysFalse || (a.alwaysTrue && b.alwaysFalse),
        neverTrue: a.neverTrue || b.neverTrue,
        neverFalse: a.neverFalse && b.neverFalse,
      };
    }
    case "or": {
      // B is evaluated only where A is false.
      const a = walk(f.a, budget, memo);
      const b = walk(f.b, budget, memo);
      return {
        alwaysTrue: a.alwaysTrue || (a.alwaysFalse && b.alwaysTrue),
        alwaysFalse: a.alwaysFalse && b.alwaysFalse,
        neverTrue: a.neverTrue && b.neverTrue,
        neverFalse: a.neverFalse || b.neverFalse,
      };
    }
    case "imp": {
      // B is evaluated only where A is true.
      const a = walk(f.a, budget, memo);
      const b = walk(f.b, budget, memo);
      return {
        alwaysTrue: a.alwaysFalse || (a.alwaysTrue && b.alwaysTrue),
        alwaysFalse: a.alwaysTrue && b.alwaysFalse,
        neverTrue: a.neverFalse && b.neverTrue,
        neverFalse: a.neverTrue || b.neverFalse,
      };
    }
    case "iff": {
      // Both sides are evaluated.
      const a = walk(f.a, budget, memo);
      const b = walk(f.b, budget, memo);
      return {
        alwaysTrue: (a.alwaysTrue && b.alwaysTrue) || (a.alwaysFalse && b.alwaysFalse),
        alwaysFalse: (a.alwaysTrue && b.alwaysFalse) || (a.alwaysFalse && b.alwaysTrue),
        neverTrue:
          (a.alwaysTrue && b.neverTrue) ||
          (a.alwaysFalse && b.neverFalse) ||
          (a.neverTrue && b.alwaysTrue) ||
          (a.neverFalse && b.alwaysFalse),
        neverFalse:
          (a.alwaysTrue && b.neverFalse) ||
          (a.alwaysFalse && b.neverTrue) ||
          (a.neverFalse && b.alwaysTrue) ||
          (a.neverTrue && b.alwaysFalse),
      };
    }
    case "forall":
    case "exists": {
      // Over a closed, non-empty domain the body's facts — which already
      // hold for every value of the bound variable — carry over: the first
      // value decides `forall` when the body is never true, `exists` when it
      // is always true, and so on.
      if (freeVarsDomain(f.dom).size > 0) return UNKNOWN;
      let nonEmpty: boolean;
      try {
        nonEmpty = domainValues(f.dom, undefined, budget).length > 0;
      } catch (err) {
        return unknownUnlessCancelled(err, budget);
      }
      // Nothing to enumerate: `forall` is true and `exists` false, without error.
      if (!nonEmpty) return constant(f.k === "forall");
      return walk(f.body, budget, memo);
    }
  }
}

/** A refutation of an open formula: one assignment, and why it fails there. */
export type NeverTrue = {
  /** `x = 0, y = 0` — every free variable at 0; any other values would do. */
  readonly at: string;
  readonly why: string;
};

/**
 * When an OPEN formula is never true, whatever its free variables are, the
 * failure at one assignment (every variable 0); otherwise undefined. A probe:
 * it spends from a fork of `budget` (at most 2 s, its own work and
 * enumeration counts) so it never eats a proof's allowance, and one it cannot
 * finish is inconclusive. Cancellation still rejects.
 */
export function neverTrue(f: Formula, budget: Budget): NeverTrue | undefined {
  const free = [...freeVars(f)].sort();
  if (free.length === 0) return undefined;
  const probe = budget.fork(2_000);
  if (probe === undefined) return undefined;
  try {
    if (!everywhere(f, probe).neverTrue) return undefined;
    let env: Env | undefined;
    for (const v of free) env = extend(env, v, ZERO);
    const at = free.map((v) => `${v} = 0`).join(", ");
    try {
      // A never-true formula evaluates false (or fails) everywhere; a true
      // one here would be a bug in the analysis, and refutes nothing.
      if (evalFormula(f, env, probe)) return undefined;
    } catch (err) {
      if (!(err instanceof CheckFailure)) throw err;
      if (budget.cancelled) throw new CheckFailure("the check was cancelled");
      return { at, why: err.message };
    }
    return { at, why: explainFalse(f, env, probe) };
  } catch (err) {
    if (!(err instanceof CheckFailure)) throw err;
    if (budget.cancelled) throw new CheckFailure("the check was cancelled");
    return undefined;
  }
}

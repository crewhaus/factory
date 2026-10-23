/**
 * The `builtin` proof checker — a dependency-free certificate checker for
 * finite, arithmetic and propositional claims (design §6.4, §16: "the
 * builtin certificate checker makes `proven` reachable with no sandbox at
 * all").
 *
 * The model searches; this only checks. A certificate is a list of steps,
 * each a formula plus the rule that justifies it from earlier steps; the last
 * step must be the statement. Every rule is a few lines below, so the whole
 * trusted base reads in one sitting. Nothing is executed: the checker parses
 * text and evaluates exact arithmetic, and every loop spends from a bounded
 * {@link Budget}.
 */
import type { CheckResult } from "../types";
import { BUILTIN_LIMITS, Budget, CheckFailure } from "./budget";
import { compare, domainValues, evalClosed, evalFormula, explainFalse } from "./evaluate";
import { neverTrue } from "./everywhere";
import { constantOf, difference, printPoly } from "./poly";
import { type Rat, ZERO, eq as ratEq, ratToString } from "./rational";
import {
  type BoundEnv,
  type Domain,
  type Formula,
  type Term,
  bind,
  formulaEq,
  freeVars,
  freeVarsDomain,
  freeVarsTerm,
  num,
  parseFormula,
  parseValue,
  printFormula,
  printTerm,
  subst,
  substTerm,
  termEq,
} from "./syntax";

export const BUILTIN_CHECKER_ID = "builtin";

/** The rules a step may cite in `by`. */
export const BUILTIN_RULES = [
  "given",
  "eval",
  "arith",
  "subst",
  "mp",
  "and_intro",
  "and_elim",
  "or_intro",
  "cases",
  "contra",
  "instantiate",
  "witness",
] as const;
export type BuiltinRule = (typeof BUILTIN_RULES)[number];

/**
 * The statement language in one paragraph, written for the model — the
 * `ProofCheckers` tool shows it verbatim (design §7).
 */
export const BUILTIN_LANGUAGE = [
  "builtin: exact finite arithmetic and logic, no sandbox. `statement` is one formula.",
  "Numbers are exact rationals (integers and decimals like 10.5, never floats); terms use variables, + - * /, ^ (non-negative integer exponent), unary -, abs(x), min(a, b, …), max(a, b, …), and arrays defined with let and indexed from 0: `let s = [9, 10.5, 13] in … s[i] …`.",
  "Formulas: = != < <= > >= between terms; true, false, not, and, or, -> (right-associative), <-> (that order, tightest first); bounded quantifiers only: `forall x in {1, 2, 5}: φ`, `exists i in 0..5: φ` (inclusive integer range, at most 10000 values per domain); a quantifier or let body runs to the end.",
  "and/or/-> stop early, so `x = 0 or 1/x < 2` is safe; division by zero is an error.",
  '`proof` is a JSON array of steps `{"id": "s1", "stmt": "<formula>", "by": "<rule>", "from": ["<earlier ids>"], "with": {…}}` whose last stmt is the statement, or the single word `eval` for a closed statement that is true by evaluation.',
  'Rules: given (a hypothesis; listed as an assumption; when the statement is closed every given must be closed, a closed one must be true, and two givens may not give one variable two values), eval (a closed formula true by exact evaluation, quantifiers enumerated), arith (one comparison true by exact arithmetic, or for all values as a polynomial identity; premises `x = <number>` give variables values), subst (from a = b and φ: φ with occurrences of one side replaced by the other), mp (φ and φ -> ψ, or φ <-> ψ, give ψ), and_intro, and_elim (with {"side": "left"|"right"}), or_intro, cases (φ1 or φ2, φ1 -> ψ, φ2 -> ψ give ψ; or one premise per domain value gives forall x in D: φ), instantiate (forall x in D: φ with {"x": v}, v in D, gives φ with x = v), witness (φ with x = v and {"x": v}, v in D, gives exists x in D: φ).',
  "Every step follows from the givens, so a proof that reaches φ and not φ (contra), or a step that is never true whatever its variables are (a false closed step, `y * 0 = 1`), has shown its hypotheses inconsistent, and is rejected: inconsistent hypotheses prove anything. A statement that is never true (`y = y and 1 = 2`) is rejected outright, and every given and the statement are checked at the values givens `x = <number>` fix.",
  "No induction or unbounded quantifiers: use smt or lean4 for those.",
  "Example: statement `let s = [9, 10.5, 13], e = [10, 12, 14] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]` (no two meetings overlap), proof `eval`; if it were false the counterexample would name the pair, e.g. `i = 0, j = 1`.",
].join(" ");

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

type Step = {
  readonly id: string;
  readonly stmt: string;
  readonly by: string;
  readonly from: readonly string[];
  readonly with?: Readonly<Record<string, unknown>>;
};

type CheckedStep = Step & { readonly formula: Formula };

const STEP_KEYS = new Set(["id", "stmt", "by", "from", "with"]);
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The proof text → validated steps. `eval` alone is the one-step certificate. */
function readSteps(proof: string, statement: string): Step[] {
  if (proof.trim() === "eval") return [{ id: "s1", stmt: statement, by: "eval", from: [] }];
  if (proof.length > BUILTIN_LIMITS.maxProofChars) {
    throw new CheckFailure(
      `the proof is ${proof.length} characters; the cap is ${BUILTIN_LIMITS.maxProofChars}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(proof);
  } catch (err) {
    throw new CheckFailure(
      `the proof is not valid JSON (${err instanceof Error ? err.message : String(err)}); write a JSON array of steps, or the single word \`eval\``,
    );
  }
  const raw = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json["steps"])
      ? (json["steps"] as unknown[])
      : undefined;
  if (raw === undefined) {
    throw new CheckFailure('the proof must be a JSON array of steps (or `{"steps": [...]}`)');
  }
  if (raw.length === 0) throw new CheckFailure("the certificate has no steps");
  if (raw.length > BUILTIN_LIMITS.maxSteps) {
    throw new CheckFailure(
      `the certificate has ${raw.length} steps; the cap is ${BUILTIN_LIMITS.maxSteps}`,
    );
  }
  return raw.map((entry, index) => readStep(entry, index));
}

function readStep(entry: unknown, index: number): Step {
  const where = `step #${index + 1}`;
  if (!isRecord(entry)) throw new CheckFailure(`${where} is not a JSON object`);
  for (const key of Object.keys(entry)) {
    if (!STEP_KEYS.has(key)) {
      throw new CheckFailure(
        `${where} has an unknown key \`${key}\` (a step has id, stmt, by, from, with)`,
      );
    }
  }
  const { id, stmt, by } = entry;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new CheckFailure(`${where} needs an \`id\`: 1–64 letters, digits or _ . : -`);
  }
  if (typeof stmt !== "string" || stmt.trim() === "") {
    throw new CheckFailure(`step ${id} needs a \`stmt\` (a formula)`);
  }
  if (typeof by !== "string") throw new CheckFailure(`step ${id} needs \`by\` (a rule name)`);
  const from = entry["from"];
  if (from !== undefined && !(Array.isArray(from) && from.every((f) => typeof f === "string"))) {
    throw new CheckFailure(`step ${id}: \`from\` must be an array of step ids`);
  }
  // No rule needs more premises than there can be earlier steps; a longer list
  // only repeats ids, and every premise costs a comparison.
  if (from !== undefined && from.length > BUILTIN_LIMITS.maxSteps) {
    throw new CheckFailure(
      `step ${id}: \`from\` lists ${from.length} premises; the cap is ${BUILTIN_LIMITS.maxSteps}`,
    );
  }
  const withValue = entry["with"];
  if (withValue !== undefined && !isRecord(withValue)) {
    throw new CheckFailure(`step ${id}: \`with\` must be a JSON object`);
  }
  return {
    id,
    stmt,
    by,
    from: (from as string[] | undefined) ?? [],
    ...(withValue !== undefined ? { with: withValue } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Ctx = {
  readonly budget: Budget;
  readonly statement: Formula;
  /**
   * The statement's free variables. A given may mention no others: with none,
   * the statement's truth is a matter of evaluation.
   */
  readonly statementFree: ReadonlySet<string>;
  readonly known: ReadonlyMap<string, CheckedStep>;
  readonly assumptions: string[];
  /** Every `given` step so far, for the check under the values they fix. */
  readonly givens: CheckedStep[];
  /** Values the givens `x = <closed term>` give variables, with the step that gave each. */
  readonly values: Map<string, { readonly value: Rat; readonly id: string }>;
};

function premises(step: Step, ctx: Ctx, count: number | "any"): Formula[] {
  if (count !== "any" && step.from.length !== count) {
    throw new CheckFailure(
      count === 0
        ? "this rule takes no premises; leave `from` empty"
        : `this rule takes ${count} premise${count === 1 ? "" : "s"} in \`from\`, got ${step.from.length}`,
    );
  }
  return step.from.map((id) => {
    const found = ctx.known.get(id);
    if (found === undefined) {
      throw new CheckFailure(`premise \`${id}\` is not an earlier step`);
    }
    return found.formula;
  });
}

function noWith(step: Step): void {
  if (step.with !== undefined && Object.keys(step.with).length > 0) {
    throw new CheckFailure("this rule takes no `with`");
  }
}

function same(a: Formula, b: Formula, ctx: Ctx): boolean {
  return formulaEq(a, b, ctx.budget);
}

const show = (f: Formula): string => clip(printFormula(f), 300);

/** `with: {x: v}` → the closed term `v` (a JSON number or a formula-language string). */
function withValue(step: Step, variable: string): Term {
  const entries = Object.entries(step.with ?? {});
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry[0] !== variable) {
    throw new CheckFailure(
      `\`with\` must give exactly the quantified variable, like {"${variable}": 3}`,
    );
  }
  const raw = entry[1];
  if (typeof raw === "number" && Number.isFinite(raw)) return parseValue(String(raw));
  if (typeof raw === "string") return parseValue(raw);
  throw new CheckFailure(`the value of \`${variable}\` must be a number or a string like "10.5"`);
}

function closedDomainValues(dom: Domain, ctx: Ctx): ReturnType<typeof domainValues> {
  const free = freeVarsDomain(dom);
  if (free.size > 0) {
    throw new CheckFailure(
      `the domain mentions ${[...free].map((v) => `\`${v}\``).join(", ")}; it must be closed here`,
    );
  }
  return domainValues(dom, undefined, ctx.budget);
}

function inDomain(value: Term, dom: Domain, ctx: Ctx): void {
  const v = evalClosed(value, ctx.budget);
  if (!closedDomainValues(dom, ctx).some((d) => ratEq(d.value, v))) {
    throw new CheckFailure(`${printTerm(value)} is not in the domain`);
  }
}

function ruleGiven(step: CheckedStep, ctx: Ctx): string {
  premises(step, ctx, 0);
  noWith(step);
  if (same(step.formula, ctx.statement, ctx)) {
    throw new CheckFailure(
      "this assumes the statement itself; a proof cannot assume what it proves",
    );
  }
  const free = freeVars(step.formula);
  if (ctx.statementFree.size === 0 && free.size > 0) {
    // A closed statement is true or false outright. Hypotheses about other
    // quantities cannot bear on it — they can only contradict each other
    // (`k = 0`, `k = 1`), and contradictory hypotheses prove anything. With
    // every given closed, each is evaluated below, so a closed statement is
    // proven only when it is true (design §0 scenario C). An open statement
    // may lean on hypotheses about other quantities (`x = 3`,
    // `x = 3 -> y = 7` give `y = 7`); a decorative variable that only dresses
    // a false claim as open (`y = y and 1 = 2`) is caught by the never-true
    // test instead (checkCertificate, ./everywhere).
    throw new CheckFailure(
      `the statement is closed, so a hypothesis about ${[...free].map((v) => `\`${v}\``).join(", ")} cannot bear on it (and contradictory hypotheses would prove anything); give closed facts only, or prove the statement by eval`,
    );
  }
  if (free.size > 0) {
    // An open hypothesis that is false whatever its variables are
    // (`k * 0 = 1`, `k = k and 1 = 2`) is as false as a closed one.
    const refuted = neverTrue(step.formula, ctx.budget);
    if (refuted !== undefined) {
      throw new CheckFailure(
        `the hypothesis is never true, whatever ${namesOf(step.formula)} ${free.size === 1 ? "is" : "are"} (at ${refuted.at}: ${refuted.why}); a false hypothesis would let anything follow`,
      );
    }
  }
  if (free.size === 0) {
    // A closed hypothesis can be checked, and a false one would let anything follow.
    let holds: boolean;
    try {
      holds = evalFormula(step.formula, undefined, ctx.budget);
    } catch (err) {
      if (err instanceof CheckFailure) {
        throw new CheckFailure(`this closed hypothesis cannot be evaluated: ${err.message}`);
      }
      throw err;
    }
    if (!holds) {
      // The refutation goes in the reason, not `counterexample`: it refutes
      // the hypothesis, not the claim.
      const why = explainFalse(step.formula, undefined, ctx.budget);
      throw new CheckFailure(
        `the hypothesis is false (${why}); a false hypothesis would let anything follow`,
      );
    }
  }
  const assigned = assignmentOf(step.formula);
  if (assigned !== undefined) {
    // `x = <closed term>` fixes x. Two givens that fix it differently
    // contradict each other; at the end every given and the statement are
    // checked under the values the givens fix (see checkUnderGivenValues).
    let value: Rat;
    try {
      value = evalClosed(assigned.value, ctx.budget);
    } catch (err) {
      if (err instanceof CheckFailure) {
        throw new CheckFailure(`this hypothesis cannot be evaluated: ${err.message}`);
      }
      throw err;
    }
    const prior = ctx.values.get(assigned.name);
    if (prior !== undefined && !ratEq(prior.value, value)) {
      throw new CheckFailure(
        `the hypotheses give \`${assigned.name}\` two values, ${ratToString(prior.value)} (step ${prior.id}) and ${ratToString(value)}; contradictory hypotheses would prove anything`,
      );
    }
    if (prior === undefined) ctx.values.set(assigned.name, { value, id: step.id });
  }
  ctx.givens.push(step);
  const text = clip(printFormula(step.formula, 0, ctx.budget), ASSUMPTION_TEXT_CAP);
  if (!ctx.assumptions.includes(text)) ctx.assumptions.push(text);
  return "assumed";
}

function ruleEval(step: CheckedStep, ctx: Ctx): string {
  premises(step, ctx, 0);
  noWith(step);
  const free = freeVars(step.formula);
  if (free.size > 0) {
    throw new CheckFailure(
      `eval needs a closed formula, but ${[...free].map((v) => `\`${v}\``).join(", ")} ha${free.size === 1 ? "s" : "ve"} no value; define it with let, quantify it, or use given/arith`,
    );
  }
  const before = ctx.budget.enumerationCount;
  if (!evalFormula(step.formula, undefined, ctx.budget)) {
    const why = explainFalse(step.formula, undefined, ctx.budget);
    throw new CheckFailure(`the formula is false: ${why}`, why);
  }
  const cases = ctx.budget.enumerationCount - before;
  return cases > 0 ? `true (${cases} case${cases === 1 ? "" : "s"})` : "true";
}

function ruleArith(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const f = step.formula;
  if (f.k !== "cmp") {
    throw new CheckFailure("arith proves one comparison (`a = b`, `a <= b`, …)");
  }
  // Premises `x = <closed term>` give variables values.
  const values = new Map<string, Rat>();
  for (const p of premises(step, ctx, "any")) {
    let name: string | undefined;
    let valueTerm: Term | undefined;
    if (p.k === "cmp" && p.op === "=") {
      if (p.a.k === "var" && freeVarsTerm(p.b).size === 0) {
        name = p.a.name;
        valueTerm = p.b;
      } else if (p.b.k === "var" && freeVarsTerm(p.a).size === 0) {
        name = p.b.name;
        valueTerm = p.a;
      }
    }
    if (name === undefined || valueTerm === undefined) {
      throw new CheckFailure(
        `arith premises must be equations \`x = <number>\`; \`${show(p)}\` is not`,
      );
    }
    const v = evalClosed(valueTerm, ctx.budget);
    const prior = values.get(name);
    if (prior !== undefined && !ratEq(prior, v)) {
      throw new CheckFailure(`the premises give \`${name}\` two different values`);
    }
    values.set(name, v);
  }
  let a = f.a;
  let b = f.b;
  for (const [name, v] of values) {
    a = substTerm(a, name, num(v), ctx.budget);
    b = substTerm(b, name, num(v), ctx.budget);
  }
  if (freeVarsTerm(a).size === 0 && freeVarsTerm(b).size === 0) {
    const va = evalClosed(a, ctx.budget);
    const vb = evalClosed(b, ctx.budget);
    if (!compare(f.op, va, vb)) {
      const why = `${ratToString(va)} ${f.op} ${ratToString(vb)} is false`;
      throw new CheckFailure(`the comparison is false: ${why}`, why);
    }
    return "exact";
  }
  const d = difference(a, b, ctx.budget);
  const c = constantOf(d);
  if (f.op === "=") {
    if (d.size !== 0) {
      throw new CheckFailure(
        `the two sides differ by ${clip(printPoly(d), 200)}, which is not 0 for every value of the variables`,
      );
    }
    return "identity";
  }
  if (c === undefined) {
    throw new CheckFailure(
      `with variables, arith accepts an inequality only when its sides differ by a constant; here they differ by ${clip(printPoly(d), 200)}`,
    );
  }
  if (!compare(f.op, c, ZERO)) {
    throw new CheckFailure(`the sides differ by ${ratToString(c)}, so \`${f.op}\` does not hold`);
  }
  return "identity";
}

/**
 * `q` is `p` with some occurrences of `x` replaced by `y` or of `y` by `x`.
 * An occurrence under a binder that captures one of their variables is not
 * an occurrence of the same term, so it cannot be replaced.
 */
function leibnizTerm(
  p: Term,
  q: Term,
  x: Term,
  y: Term,
  ctx: Ctx,
  envP?: BoundEnv,
  envQ?: BoundEnv,
): boolean {
  const b = ctx.budget;
  b.tick();
  if (
    (termEq(p, x, b, envP) && termEq(q, y, b, envQ)) ||
    (termEq(p, y, b, envP) && termEq(q, x, b, envQ))
  ) {
    return true;
  }
  if (p.k !== q.k) return false;
  switch (p.k) {
    case "num":
    case "var":
      return termEq(p, q, b, envP, envQ);
    case "neg":
    case "abs":
      return leibnizTerm(p.a, (q as typeof p).a, x, y, ctx, envP, envQ);
    case "min":
    case "max": {
      const qq = q as typeof p;
      return (
        p.args.length === qq.args.length &&
        p.args.every((t, i) => leibnizTerm(t, qq.args[i] as Term, x, y, ctx, envP, envQ))
      );
    }
    case "idx": {
      const qq = q as typeof p;
      return (
        p.items.length === qq.items.length &&
        p.items.every((t, i) => leibnizTerm(t, qq.items[i] as Term, x, y, ctx, envP, envQ)) &&
        leibnizTerm(p.i, qq.i, x, y, ctx, envP, envQ)
      );
    }
    default: {
      const qq = q as typeof p;
      return (
        leibnizTerm(p.a, qq.a, x, y, ctx, envP, envQ) &&
        leibnizTerm(p.b, qq.b, x, y, ctx, envP, envQ)
      );
    }
  }
}

function leibnizDomain(
  p: Domain,
  q: Domain,
  x: Term,
  y: Term,
  ctx: Ctx,
  envP?: BoundEnv,
  envQ?: BoundEnv,
): boolean {
  if (p.k === "set" && q.k === "set") {
    return (
      p.items.length === q.items.length &&
      p.items.every((t, i) => leibnizTerm(t, q.items[i] as Term, x, y, ctx, envP, envQ))
    );
  }
  if (p.k === "range" && q.k === "range") {
    return (
      leibnizTerm(p.lo, q.lo, x, y, ctx, envP, envQ) &&
      leibnizTerm(p.hi, q.hi, x, y, ctx, envP, envQ)
    );
  }
  return false;
}

function leibniz(
  p: Formula,
  q: Formula,
  x: Term,
  y: Term,
  ctx: Ctx,
  envP?: BoundEnv,
  envQ?: BoundEnv,
): boolean {
  ctx.budget.tick();
  if (p.k !== q.k) return false;
  switch (p.k) {
    case "bool":
      return p.v === (q as typeof p).v;
    case "cmp": {
      const qq = q as typeof p;
      return (
        p.op === qq.op &&
        leibnizTerm(p.a, qq.a, x, y, ctx, envP, envQ) &&
        leibnizTerm(p.b, qq.b, x, y, ctx, envP, envQ)
      );
    }
    case "not":
      return leibniz(p.a, (q as typeof p).a, x, y, ctx, envP, envQ);
    case "forall":
    case "exists": {
      const qq = q as typeof p;
      return (
        leibnizDomain(p.dom, qq.dom, x, y, ctx, envP, envQ) &&
        leibniz(p.body, qq.body, x, y, ctx, bind(envP, p.v), bind(envQ, qq.v))
      );
    }
    default: {
      const qq = q as typeof p;
      return leibniz(p.a, qq.a, x, y, ctx, envP, envQ) && leibniz(p.b, qq.b, x, y, ctx, envP, envQ);
    }
  }
}

function ruleSubst(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const [eqn, source] = premises(step, ctx, 2) as [Formula, Formula];
  if (eqn.k !== "cmp" || eqn.op !== "=") {
    throw new CheckFailure("the first premise of subst must be an equation `a = b`");
  }
  if (!leibniz(source, step.formula, eqn.a, eqn.b, ctx)) {
    throw new CheckFailure(
      `this is not the second premise with occurrences of \`${clip(printTerm(eqn.a), 80)}\` and \`${clip(printTerm(eqn.b), 80)}\` exchanged`,
    );
  }
  return "ok";
}

function ruleMp(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const [p, q] = premises(step, ctx, 2) as [Formula, Formula];
  for (const [rule, fact] of [
    [q, p],
    [p, q],
  ] as const) {
    if (rule.k === "imp" && same(rule.a, fact, ctx) && same(rule.b, step.formula, ctx)) return "ok";
    if (
      rule.k === "iff" &&
      ((same(rule.a, fact, ctx) && same(rule.b, step.formula, ctx)) ||
        (same(rule.b, fact, ctx) && same(rule.a, step.formula, ctx)))
    ) {
      return "ok";
    }
  }
  throw new CheckFailure("mp needs premises φ and φ -> ψ (or φ <-> ψ), and ψ as the step");
}

function ruleAndIntro(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const [p, q] = premises(step, ctx, 2) as [Formula, Formula];
  const f = step.formula;
  if (f.k === "and" && same(f.a, p, ctx) && same(f.b, q, ctx)) return "ok";
  throw new CheckFailure("and_intro gives `<first premise> and <second premise>`, in that order");
}

function ruleAndElim(step: CheckedStep, ctx: Ctx): string {
  const [p] = premises(step, ctx, 1) as [Formula];
  const side = step.with?.["side"];
  // `with: {}` is the same as no `with`, as for every other rule.
  if (
    step.with !== undefined &&
    Object.keys(step.with).length > 0 &&
    (Object.keys(step.with).some((k) => k !== "side") || (side !== "left" && side !== "right"))
  ) {
    throw new CheckFailure('and_elim takes `with: {"side": "left"}` or `{"side": "right"}`');
  }
  if (p.k !== "and") throw new CheckFailure("the premise of and_elim must be a conjunction");
  if (side !== "right" && same(p.a, step.formula, ctx)) return "left";
  if (side !== "left" && same(p.b, step.formula, ctx)) return "right";
  throw new CheckFailure("the step is not that side of the premise's conjunction");
}

function ruleOrIntro(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const [p] = premises(step, ctx, 1) as [Formula];
  const f = step.formula;
  if (f.k === "or" && (same(f.a, p, ctx) || same(f.b, p, ctx))) return "ok";
  throw new CheckFailure("or_intro gives a disjunction with the premise as one side");
}

function ruleCases(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const ps = premises(step, ctx, "any");
  const f = step.formula;
  // Over a disjunction: φ1 or φ2, φ1 -> ψ, φ2 -> ψ ⊢ ψ.
  if (ps.length === 3) {
    const [d, i1, i2] = ps as [Formula, Formula, Formula];
    if (
      d.k === "or" &&
      i1.k === "imp" &&
      i2.k === "imp" &&
      same(i1.b, f, ctx) &&
      same(i2.b, f, ctx) &&
      ((same(i1.a, d.a, ctx) && same(i2.a, d.b, ctx)) ||
        (same(i1.a, d.b, ctx) && same(i2.a, d.a, ctx)))
    ) {
      return "by the disjunction";
    }
  }
  // Over a finite domain: one premise per value ⊢ forall x in D: φ.
  if (f.k === "forall") {
    const values = closedDomainValues(f.dom, ctx);
    if (ps.length > values.length) {
      throw new CheckFailure(
        `cases over a domain takes one premise per value: the domain has ${values.length}, \`from\` lists ${ps.length}`,
      );
    }
    values.forEach(({ term }, index) => {
      const instance = subst(f.body, f.v, term, ctx.budget);
      // Premises listed in domain order match at their own index; otherwise
      // search them all. Every comparison spends from the budget.
      const atIndex = ps[index];
      if (atIndex !== undefined && same(atIndex, instance, ctx)) return;
      if (!ps.some((p) => same(p, instance, ctx))) {
        throw new CheckFailure(
          `no premise is the case ${f.v} = ${printTerm(term)}: \`${show(instance)}\``,
        );
      }
    });
    return `${values.length} case${values.length === 1 ? "" : "s"}`;
  }
  throw new CheckFailure(
    "cases takes either [φ1 or φ2, φ1 -> ψ, φ2 -> ψ] for the step ψ, or one premise per domain value for a step `forall x in D: φ`",
  );
}

/**
 * `contra` (φ, not φ ⊢ anything) is recognised but never accepts. This
 * calculus has no hypothetical sub-proofs — every step follows from the
 * givens — so premises φ and `not φ` show the givens themselves are
 * inconsistent, and the proof is rejected the way the smt checker rejects an
 * unsatisfiable preamble: inconsistent hypotheses prove anything.
 */
function ruleContra(step: CheckedStep, ctx: Ctx): string {
  noWith(step);
  const [p, q] = premises(step, ctx, 2) as [Formula, Formula];
  const positive =
    q.k === "not" && same(q.a, p, ctx) ? p : p.k === "not" && same(p.a, q, ctx) ? q : undefined;
  if (positive !== undefined) {
    throw new CheckFailure(
      `the premises are \`${show(positive)}\` and its negation, so the hypotheses are inconsistent; anything follows from them`,
    );
  }
  throw new CheckFailure("contra needs a formula and its negation (`not …`) as premises");
}

/** Rules that already establish their step: a true closed one, an identity, or a checked given. */
const SELF_EVALUATING: ReadonlySet<string> = new Set(["given", "eval", "arith"]);

/** `x`, `` `x`, `y` `` — a formula's free variables, for messages. */
function namesOf(f: Formula): string {
  return [...freeVars(f)]
    .sort()
    .map((v) => `\`${v}\``)
    .join(", ");
}

/**
 * A derived step must be able to be true. Every step follows from the givens,
 * so a false closed step (`0 = 1` by `subst` from `k = 0` and `k = 1`), or an
 * open one that is never true whatever its variables are (`r * 0 = 1`), shows
 * the givens are inconsistent — the proof is rejected rather than allowed to
 * derive anything from it.
 */
function refuteFalseStep(step: CheckedStep, ctx: Ctx): void {
  if (SELF_EVALUATING.has(step.by)) return;
  if (freeVars(step.formula).size > 0) {
    const refuted = neverTrue(step.formula, ctx.budget);
    if (refuted !== undefined) {
      throw new CheckFailure(
        `the step is never true, whatever ${namesOf(step.formula)} ${freeVars(step.formula).size === 1 ? "is" : "are"} (at ${refuted.at}: ${refuted.why}), so the hypotheses it follows from are inconsistent; anything follows from them`,
      );
    }
    return;
  }
  let holds: boolean;
  try {
    holds = evalFormula(step.formula, undefined, ctx.budget);
  } catch (err) {
    if (err instanceof CheckFailure) {
      throw new CheckFailure(`this closed step cannot be evaluated: ${err.message}`);
    }
    throw err;
  }
  if (!holds) {
    const why = explainFalse(step.formula, undefined, ctx.budget);
    throw new CheckFailure(
      `the step is false (${why}), so the hypotheses it follows from are inconsistent; anything follows from them`,
      why,
    );
  }
}

/**
 * An open statement that is never true, whatever its variables are
 * (`y = y and 1 = 2`, `abs(y) >= 0 and 1 = 2`, `y * 0 = 1`), cannot follow
 * from consistent hypotheses: a decorative variable does not make a false
 * claim provable. It is refuted before any step is read, with its failure at
 * one assignment as the counterexample. (A closed statement needs no probe:
 * every route to it evaluates.)
 */
function refuteNeverTrueStatement(statement: Formula, budget: Budget): void {
  const refuted = neverTrue(statement, budget);
  if (refuted === undefined) return;
  const many = freeVars(statement).size > 1;
  throw new CheckFailure(
    `the statement is never true, whatever ${namesOf(statement)} ${many ? "are" : "is"} (at ${refuted.at}: ${refuted.why}), so no consistent hypotheses prove it`,
    `${refuted.at} (or any other value${many ? "s" : ""}): ${refuted.why}`,
  );
}

/** `x = <closed term>` (either way round): the variable and the term, or undefined. */
function assignmentOf(f: Formula): { name: string; value: Term } | undefined {
  if (f.k !== "cmp" || f.op !== "=") return undefined;
  if (f.a.k === "var" && freeVarsTerm(f.b).size === 0) return { name: f.a.name, value: f.b };
  if (f.b.k === "var" && freeVarsTerm(f.a).size === 0) return { name: f.b.name, value: f.a };
  return undefined;
}

/**
 * After the last step, every given and the statement are read at the values
 * the givens `x = <closed term>` fix. A formula all of whose variables are
 * fixed is evaluated there; one with some left open is put to the never-true
 * test. A given that fails shows the givens inconsistent (`y = 1` with
 * `y = 1 -> 1 = 2`, `k = 1` with `k = 1 -> (y = y and 1 = 2)`); a statement
 * that fails is refuted with that assignment as its counterexample — whatever
 * the steps derived, consistent hypotheses cannot prove it.
 *
 * What remains trusted: givens whose inconsistency nothing here can read off
 * (`y > 0` with `y > 0 -> (abs(y) >= 0 and 1 = 2)`). They are listed as
 * assumptions, which is where the design keeps them (§2, "assumptions are
 * first-class").
 */
function checkUnderGivenValues(ctx: Ctx): void {
  if (ctx.values.size === 0) return;
  /** `f` with the fixed values substituted, and `k = 1, …` naming them; undefined when none apply. */
  const atFixed = (f: Formula): { formula: Formula; where: string } | undefined => {
    const fixed = [...freeVars(f)].filter((v) => ctx.values.has(v)).sort();
    if (fixed.length === 0) return undefined;
    let formula = f;
    for (const v of fixed) {
      formula = subst(formula, v, num((ctx.values.get(v) as { value: Rat }).value), ctx.budget);
    }
    const where = fixed
      .map((v) => `${v} = ${ratToString((ctx.values.get(v) as { value: Rat }).value)}`)
      .join(", ");
    return { formula, where };
  };
  /** Why `f` fails at the fixed values (with any variables left open), or undefined. */
  const failureAt = (
    f: Formula,
    what: string,
    where: string,
  ): { why: string; at: string } | undefined => {
    if (freeVars(f).size > 0) {
      const refuted = neverTrue(f, ctx.budget);
      return refuted === undefined
        ? undefined
        : { why: refuted.why, at: `${where}, ${refuted.at} (or any other value of ${namesOf(f)})` };
    }
    let holds: boolean;
    try {
      holds = evalFormula(f, undefined, ctx.budget);
    } catch (err) {
      if (err instanceof CheckFailure) {
        throw new CheckFailure(
          `${what} cannot be evaluated at ${where}, the values the givens fix: ${err.message}`,
        );
      }
      throw err;
    }
    return holds ? undefined : { why: explainFalse(f, undefined, ctx.budget), at: where };
  };
  for (const given of ctx.givens) {
    const fixed = atFixed(given.formula);
    if (fixed === undefined) continue;
    const failure = failureAt(fixed.formula, `given ${given.id}`, fixed.where);
    if (failure !== undefined) {
      throw new CheckFailure(
        `given ${given.id} cannot hold at ${fixed.where}, the value${fixed.where.includes(",") ? "s" : ""} the givens fix (at ${failure.at}: ${failure.why}), so the hypotheses are inconsistent; anything follows from them`,
      );
    }
  }
  const fixed = atFixed(ctx.statement);
  if (fixed === undefined) return;
  const failure = failureAt(fixed.formula, "the statement", fixed.where);
  if (failure !== undefined) {
    throw new CheckFailure(
      `the statement is false at ${fixed.where}, the value${fixed.where.includes(",") ? "s" : ""} the givens fix (${failure.why}), so no consistent hypotheses prove it`,
      `${failure.at}: ${failure.why}`,
    );
  }
}

function ruleInstantiate(step: CheckedStep, ctx: Ctx): string {
  const [p] = premises(step, ctx, 1) as [Formula];
  if (p.k !== "forall") {
    throw new CheckFailure("the premise of instantiate must be a `forall`");
  }
  const value = withValue(step, p.v);
  inDomain(value, p.dom, ctx);
  const instance = subst(p.body, p.v, value, ctx.budget);
  if (!same(instance, step.formula, ctx)) {
    throw new CheckFailure(
      `instantiating ${p.v} = ${printTerm(value)} gives \`${show(instance)}\`, not this step`,
    );
  }
  return `${p.v} = ${printTerm(value)}`;
}

function ruleWitness(step: CheckedStep, ctx: Ctx): string {
  const [p] = premises(step, ctx, 1) as [Formula];
  const f = step.formula;
  if (f.k !== "exists") throw new CheckFailure("witness proves an `exists`");
  const value = withValue(step, f.v);
  inDomain(value, f.dom, ctx);
  const instance = subst(f.body, f.v, value, ctx.budget);
  if (!same(instance, p, ctx)) {
    throw new CheckFailure(
      `the premise must be the body with ${f.v} = ${printTerm(value)}: \`${show(instance)}\``,
    );
  }
  return `${f.v} = ${printTerm(value)}`;
}

const RULES: Readonly<Record<BuiltinRule, (step: CheckedStep, ctx: Ctx) => string>> = {
  given: ruleGiven,
  eval: ruleEval,
  arith: ruleArith,
  subst: ruleSubst,
  mp: ruleMp,
  and_intro: ruleAndIntro,
  and_elim: ruleAndElim,
  or_intro: ruleOrIntro,
  cases: ruleCases,
  contra: ruleContra,
  instantiate: ruleInstantiate,
  witness: ruleWitness,
};

function isRule(by: string): by is BuiltinRule {
  return Object.hasOwn(RULES, by);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type BuiltinVerdict = Omit<CheckResult, "checker" | "durationMs">;

const OUTPUT_CAP = 4_000;
/** Longest assumption text kept (assumptions render on every surface). */
const ASSUMPTION_TEXT_CAP = 2_000;

/** The first finite, non-negative budget; a NaN must not disable the deadline. */
export function usableMs(...candidates: ReadonlyArray<number | undefined>): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  }
  return BUILTIN_LIMITS.defaultTimeoutMs;
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

function clipOutput(lines: readonly string[]): string {
  const text = lines.join("\n");
  if (text.length <= OUTPUT_CAP) return text;
  const head = text.slice(0, OUTPUT_CAP - 600);
  const tail = text.slice(text.length - 500);
  return `${head}\n… ${text.length - head.length - tail.length} characters of trace omitted …\n${tail}`;
}

/**
 * Check a statement against a certificate. Pure and synchronous; never
 * throws — every refusal is `{ ok: false, reason }`. It holds the thread
 * that calls it for up to its whole budget, so `createBuiltinChecker`
 * (./runner) calls it on a worker thread, never on the harness's.
 */
export function checkCertificate(input: {
  readonly statement: string;
  readonly proof: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): BuiltinVerdict {
  const budget = new Budget(
    Math.min(usableMs(input.timeoutMs), BUILTIN_LIMITS.maxTimeoutMs),
    input.signal,
  );
  const trace: string[] = [];
  const assumptions: string[] = [];
  let statement: Formula | undefined;
  try {
    if (typeof input.statement !== "string" || input.statement.trim() === "") {
      throw new CheckFailure("the statement is empty");
    }
    if (typeof input.proof !== "string") throw new CheckFailure("the proof must be text");
    try {
      statement = parseFormula(input.statement, budget);
    } catch (err) {
      if (err instanceof CheckFailure) throw new CheckFailure(`statement: ${err.message}`);
      throw err;
    }
    try {
      refuteNeverTrueStatement(statement, budget);
    } catch (err) {
      if (err instanceof CheckFailure) trace.push("statement: never true; no step read");
      throw err;
    }
    const steps = readSteps(input.proof, input.statement);
    const known = new Map<string, CheckedStep>();
    const ctx: Ctx = {
      budget,
      statement,
      statementFree: freeVars(statement),
      known,
      assumptions,
      givens: [],
      values: new Map(),
    };
    let last: CheckedStep | undefined;
    for (const step of steps) {
      budget.checkClock();
      let formula: Formula | undefined;
      try {
        if (known.has(step.id)) throw new CheckFailure("the id is used twice");
        if (!isRule(step.by)) {
          throw new CheckFailure(
            /^induct/i.test(step.by)
              ? "the builtin checker has no induction; prove it with the lean4 checker (or smt for arithmetic)"
              : `unknown rule \`${step.by}\` (rules: ${BUILTIN_RULES.join(", ")})`,
          );
        }
        try {
          formula = parseFormula(step.stmt, budget);
        } catch (err) {
          if (err instanceof CheckFailure) throw new CheckFailure(`stmt: ${err.message}`);
          throw err;
        }
        const checked: CheckedStep = { ...step, formula };
        const note = RULES[step.by](checked, ctx);
        refuteFalseStep(checked, ctx);
        // The clock is checked after each rule as well as before it, so one
        // step's work is the most the deadline can be overrun by.
        budget.checkClock();
        trace.push(`${step.id} ${step.by}: ${note}`);
        known.set(step.id, checked);
        last = checked;
      } catch (err) {
        if (err instanceof CheckFailure) {
          trace.push(`${step.id} ${step.by}: rejected`);
          // A refutation is the claim's counterexample only when this step IS
          // the statement; a false intermediate step says nothing about the
          // claim (the statement's own evaluation below may).
          const isStatement =
            err.counterexample !== undefined &&
            formula !== undefined &&
            isSameFormula(formula, statement);
          throw new CheckFailure(
            `step ${step.id} (${step.by}): ${err.message}`,
            isStatement ? err.counterexample : undefined,
          );
        }
        throw err;
      }
    }
    if (last === undefined) throw new CheckFailure("the certificate has no steps");
    if (!formulaEq(last.formula, statement, budget)) {
      throw new CheckFailure(
        `the last step proves \`${show(last.formula)}\`, which is not the statement \`${show(statement)}\``,
      );
    }
    try {
      checkUnderGivenValues(ctx);
    } catch (err) {
      if (err instanceof CheckFailure) trace.push("at the values the givens fix: rejected");
      throw err;
    }
    trace.push(
      `statement: proved from ${assumptions.length} assumption${assumptions.length === 1 ? "" : "s"}`,
    );
    return { ok: true, assumptions, axioms: [], output: clipOutput(trace) };
  } catch (err) {
    if (!(err instanceof CheckFailure)) {
      // A bug in the checker is a rejection too — never a throw out of check().
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        assumptions,
        axioms: [],
        output: clipOutput(trace),
        reason: `internal checker error: ${clip(message, 300)}`,
      };
    }
    const reason = clip(err.message, 1_000);
    const verdict =
      err.counterexample === undefined ? evaluateStatement(statement, budget) : undefined;
    const counterexample =
      err.counterexample ?? (verdict?.holds === false ? verdict.why : undefined);
    const hint =
      verdict?.holds === true
        ? "hint: the statement is closed and true by evaluation; the proof `eval` proves it"
        : undefined;
    return {
      ok: false,
      assumptions,
      axioms: [],
      output: clipOutput(hint !== undefined ? [...trace, hint] : trace),
      reason,
      ...(counterexample !== undefined ? { counterexample: clip(counterexample, 1_000) } : {}),
    };
  }
}

/** Alpha-equality outside any rule's budget accounting (a fresh, small budget). */
function isSameFormula(a: Formula, b: Formula | undefined): boolean {
  if (b === undefined) return false;
  try {
    return formulaEq(a, b, new Budget(1_000));
  } catch {
    return false;
  }
}

/**
 * After a rejection, a closed statement that evaluates false gives the most
 * useful retry nudge there is: why the claim itself is wrong; one that
 * evaluates true gets a hint that `eval` proves it. One evaluation, bounded
 * by what is left of the deadline (at most 2 s), and none at all once the
 * caller has cancelled.
 */
function evaluateStatement(
  statement: Formula | undefined,
  budget: Budget,
): { holds: boolean; why?: string } | undefined {
  if (statement === undefined || budget.cancelled || freeVars(statement).size > 0) return undefined;
  const fresh = budget.fork(2_000);
  if (fresh === undefined) return undefined;
  try {
    if (evalFormula(statement, undefined, fresh)) return { holds: true };
    return { holds: false, why: explainFalse(statement, undefined, fresh) };
  } catch {
    return undefined;
  }
}

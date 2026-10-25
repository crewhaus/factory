/**
 * The builtin checker's statement language: lexer, AST, parser, printer and
 * the structural operations the proof rules need (free variables,
 * capture-avoiding substitution, alpha-equality). design §6.4.
 *
 * The language is deliberately small — the claims a harness makes are finite,
 * arithmetic or propositional, and the verifier has to be readable in one
 * sitting. Grammar (loosest binding first):
 *
 *   formula := binder | iff
 *   binder  := ("forall" | "exists") name {"," name} "in" domain ":" formula
 *            | "let" name "=" (term | array) {"," name "=" (term | array)} "in" formula
 *   iff     := imp ["<->" imp]                (does not chain)
 *   imp     := or ["->" imp]                  (right-associative)
 *   or      := and {"or" and}
 *   and     := not {"and" not}
 *   not     := "not" not | binder | cmp
 *   cmp     := sum [("=" | "!=" | "<" | "<=" | ">" | ">=") sum]   (does not chain)
 *   sum     := product {("+" | "-") product}
 *   product := unary {("*" | "/") unary}
 *   unary   := "-" unary | power
 *   power   := postfix ["^" unary]            (right-associative)
 *   postfix := primary {"[" sum "]"}          (indexes an array, 0-based)
 *   primary := number | name | "true" | "false" | "(" formula ")"
 *            | "abs" "(" sum ")" | ("min" | "max") "(" sum {"," sum} ")"
 *            | array
 *   array   := "[" [sum {"," sum}] "]"
 *   domain  := "{" [sum {"," sum}] "}" | sum ".." sum      (inclusive integer range)
 *
 * A binder's body extends as far right as possible. `let` is expanded at
 * parse time (each use is replaced by its value), so the AST every rule sees
 * has no `let` — two statements that differ only in how they name their data
 * compare equal. Common Unicode forms (≤ ≥ ≠ → ↔ ¬ ∧ ∨ ∀ ∃ ∈) are read as
 * their ASCII spelling.
 *
 * An expansion shares subtrees, so a chain of `let`s can describe a tree
 * exponentially larger than its text. Nothing here walks the expanded tree
 * before {@link measure} has bounded it: a `let`'s free variables are
 * collected once, while its value is parsed, and the parser and `measure`
 * spend from the caller's {@link Budget} (design §18, "checkers bounded by
 * timeout_ms").
 */
import { BUILTIN_LIMITS, type Budget, CheckFailure } from "./budget";
import { type Rat, parseDecimal, eq as ratEq, neg as ratNeg, ratToString } from "./rational";

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Term =
  | { readonly k: "num"; readonly v: Rat }
  | { readonly k: "var"; readonly name: string }
  | { readonly k: "neg"; readonly a: Term }
  | { readonly k: "add" | "sub" | "mul" | "div" | "pow"; readonly a: Term; readonly b: Term }
  | { readonly k: "abs"; readonly a: Term }
  | { readonly k: "min" | "max"; readonly args: readonly Term[] }
  | { readonly k: "idx"; readonly items: readonly Term[]; readonly i: Term };

export type CmpOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

export type Domain =
  | { readonly k: "set"; readonly items: readonly Term[] }
  | { readonly k: "range"; readonly lo: Term; readonly hi: Term };

export type Formula =
  | { readonly k: "bool"; readonly v: boolean }
  | { readonly k: "cmp"; readonly op: CmpOp; readonly a: Term; readonly b: Term }
  | { readonly k: "not"; readonly a: Formula }
  | { readonly k: "and" | "or" | "imp" | "iff"; readonly a: Formula; readonly b: Formula }
  | {
      readonly k: "forall" | "exists";
      readonly v: string;
      readonly dom: Domain;
      readonly body: Formula;
    };

/** `-<number>` is a number: `-3` and `-(3)` and a substituted `-x` with `x := 3` agree. */
export function mkNeg(a: Term): Term {
  return a.k === "num" ? { k: "num", v: ratNeg(a.v) } : { k: "neg", a };
}

export const num = (v: Rat): Term => ({ k: "num", v });

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Tok = {
  readonly kind: "num" | "id" | "sym" | "eof";
  readonly text: string;
  readonly pos: number;
};

const KEYWORDS = new Set([
  "true",
  "false",
  "not",
  "and",
  "or",
  "forall",
  "exists",
  "in",
  "let",
  "abs",
  "min",
  "max",
]);

/** Multi-character symbols, longest first, with their canonical spelling. */
const SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["<->", "<->"],
  ["<=>", "<->"],
  ["->", "->"],
  ["<=", "<="],
  [">=", ">="],
  ["!=", "!="],
  ["==", "="],
  ["&&", "and"],
  ["||", "or"],
  ["..", ".."],
  ["=", "="],
  ["<", "<"],
  [">", ">"],
  ["+", "+"],
  ["-", "-"],
  ["*", "*"],
  ["/", "/"],
  ["^", "^"],
  ["(", "("],
  [")", ")"],
  ["[", "["],
  ["]", "]"],
  ["{", "{"],
  ["}", "}"],
  [",", ","],
  [":", ":"],
  ["!", "not"],
];

const UNICODE: Readonly<Record<string, string>> = {
  "≠": "!=",
  "≤": "<=",
  "≥": ">=",
  "→": "->",
  "⇒": "->",
  "↔": "<->",
  "⇔": "<->",
  "¬": "not",
  "∧": "and",
  "∨": "or",
  "∀": "forall",
  "∃": "exists",
  "∈": "in",
  "×": "*",
  "·": "*",
  "÷": "/",
  "−": "-",
};

/** Number sets a model reaches for when it means an unbounded quantifier. */
const NUMBER_SETS = new Set(["ℕ", "ℤ", "ℚ", "ℝ"]);

/** 1-based line and column of an offset, for parse errors. */
export function lineCol(src: string, pos: number): string {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return `line ${line}, column ${col}`;
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src.charAt(j) >= "0" && src.charAt(j) <= "9") j += 1;
      // A decimal point needs a digit after it, so `0..5` is a range.
      if (src.charAt(j) === "." && src.charAt(j + 1) >= "0" && src.charAt(j + 1) <= "9") {
        j += 1;
        while (j < src.length && src.charAt(j) >= "0" && src.charAt(j) <= "9") j += 1;
      }
      out.push({ kind: "num", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src.charAt(j))) j += 1;
      const word = src.slice(i, j);
      out.push({ kind: KEYWORDS.has(word) ? "sym" : "id", text: word, pos: i });
      i = j;
      continue;
    }
    const uni = UNICODE[c];
    if (uni !== undefined) {
      out.push({ kind: "sym", text: uni, pos: i });
      i += 1;
      continue;
    }
    if (NUMBER_SETS.has(c)) {
      out.push({ kind: "id", text: c, pos: i });
      i += 1;
      continue;
    }
    let matched = false;
    for (const [spelling, canonical] of SYMBOLS) {
      if (src.startsWith(spelling, i)) {
        out.push({ kind: "sym", text: canonical, pos: i });
        i += spelling.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new CheckFailure(`${lineCol(src, i)}: unexpected character ${JSON.stringify(c)}`);
    }
  }
  out.push({ kind: "eof", text: "", pos: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** What a parse level returns before sorts are settled. */
type Parsed =
  | { readonly s: "term"; readonly t: Term; readonly pos: number }
  | { readonly s: "formula"; readonly f: Formula; readonly pos: number }
  | { readonly s: "array"; readonly items: readonly Term[]; readonly pos: number };

type Scope =
  | { readonly kind: "bound"; readonly name: string }
  | {
      readonly kind: "let";
      readonly name: string;
      readonly value: Parsed;
      /** The value's free variables, collected while it was parsed. */
      readonly free: ReadonlySet<string>;
    };

/** Collects the free variables of a `let` value while it is parsed. */
type FreeCollector = { readonly vars: Set<string>; readonly merged: Set<Scope> };

const CMP_OPS = new Set(["=", "!=", "<", "<=", ">", ">="]);

const UNBOUNDED =
  "the builtin checker only has bounded quantifiers over an explicit finite domain (`forall x in {1, 2, 5}: …` or `forall i in 0..9: …`); for unbounded quantifiers or induction use the smt or lean4 checker";

class Parser {
  private i = 0;
  private depth = 0;
  private readonly scopes: Scope[] = [];
  private readonly collectors: FreeCollector[] = [];
  private readonly toks: Tok[];

  constructor(
    private readonly src: string,
    private readonly budget?: Budget,
  ) {
    budget?.tick(src.length);
    this.toks = lex(src);
  }

  parseStatement(): Formula {
    const p = this.parseFormula();
    const t = this.peek();
    if (t.kind !== "eof") this.fail(t, `unexpected ${describe(t)} after the end of the formula`);
    return this.asFormula(p, "a statement");
  }

  parseClosedTerm(): Term {
    const p = this.parseSum();
    const t = this.peek();
    if (t.kind !== "eof") this.fail(t, `unexpected ${describe(t)} after the value`);
    return this.asTerm(p, "a value");
  }

  // -- helpers --------------------------------------------------------------

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)] as Tok;
  }

  private next(): Tok {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i += 1;
    this.budget?.tick();
    return t;
  }

  private isSym(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "sym" && t.text === text;
  }

  private expect(text: string, what?: string): Tok {
    const t = this.peek();
    if (t.kind === "sym" && t.text === text) return this.next();
    return this.fail(
      t,
      `expected \`${text}\`${what !== undefined ? ` ${what}` : ""}, found ${describe(t)}`,
    );
  }

  private fail(t: { pos: number }, message: string): never {
    throw new CheckFailure(`${lineCol(this.src, t.pos)}: ${message}`);
  }

  private enter(t: Tok): void {
    this.depth += 1;
    if (this.depth > BUILTIN_LIMITS.maxParseDepth) {
      this.fail(t, `the formula nests more than ${BUILTIN_LIMITS.maxParseDepth} levels deep`);
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private asTerm(p: Parsed, role: string): Term {
    if (p.s === "term") return p.t;
    if (p.s === "array") {
      return this.fail(p, `an array cannot be used as ${role}; index it, like \`s[0]\``);
    }
    return this.fail(p, `expected a number expression as ${role}, found a formula`);
  }

  private asFormula(p: Parsed, role: string): Formula {
    if (p.s === "formula") return p.f;
    if (p.s === "array") return this.fail(p, `expected a formula as ${role}, found an array`);
    return this.fail(
      p,
      `expected a formula as ${role}, found a number expression (compare it: \`… = …\`, \`… < …\`)`,
    );
  }

  private formula(f: Formula, pos: number): Parsed {
    return { s: "formula", f, pos };
  }

  private term(t: Term, pos: number): Parsed {
    return { s: "term", t, pos };
  }

  // -- formula levels -------------------------------------------------------

  private parseFormula(): Parsed {
    return this.parseIff();
  }

  private parseIff(): Parsed {
    const left = this.parseImp();
    if (!this.isSym("<->")) return left;
    const op = this.next();
    const right = this.parseImp();
    if (this.isSym("<->")) {
      this.fail(this.peek(), "`<->` does not chain; add parentheses");
    }
    return this.formula(
      {
        k: "iff",
        a: this.asFormula(left, "the left side of `<->`"),
        b: this.asFormula(right, "the right side of `<->`"),
      },
      op.pos,
    );
  }

  private parseImp(): Parsed {
    const left = this.parseOr();
    if (!this.isSym("->")) return left;
    const op = this.next();
    this.enter(op);
    const right = this.parseImp();
    this.leave();
    return this.formula(
      {
        k: "imp",
        a: this.asFormula(left, "the left side of `->`"),
        b: this.asFormula(right, "the right side of `->`"),
      },
      op.pos,
    );
  }

  private parseOr(): Parsed {
    let left = this.parseAnd();
    while (this.isSym("or")) {
      const op = this.next();
      const right = this.parseAnd();
      left = this.formula(
        {
          k: "or",
          a: this.asFormula(left, "the left side of `or`"),
          b: this.asFormula(right, "the right side of `or`"),
        },
        op.pos,
      );
    }
    return left;
  }

  private parseAnd(): Parsed {
    let left = this.parseNot();
    while (this.isSym("and")) {
      const op = this.next();
      const right = this.parseNot();
      left = this.formula(
        {
          k: "and",
          a: this.asFormula(left, "the left side of `and`"),
          b: this.asFormula(right, "the right side of `and`"),
        },
        op.pos,
      );
    }
    return left;
  }

  private parseNot(): Parsed {
    const t = this.peek();
    if (t.kind === "sym" && t.text === "not") {
      this.next();
      this.enter(t);
      const inner = this.parseNot();
      this.leave();
      return this.formula({ k: "not", a: this.asFormula(inner, "the operand of `not`") }, t.pos);
    }
    if (t.kind === "sym" && (t.text === "forall" || t.text === "exists")) {
      return this.parseQuantifier();
    }
    if (t.kind === "sym" && t.text === "let") return this.parseLet();
    return this.parseCmp();
  }

  private parseQuantifier(): Parsed {
    const q = this.next();
    this.enter(q);
    const kind = q.text as "forall" | "exists";
    const names: Tok[] = [this.parseBinderName()];
    while (this.isSym(",")) {
      this.next();
      const name = this.parseBinderName();
      if (names.some((n) => n.text === name.text)) {
        this.fail(name, `\`${name.text}\` is listed twice`);
      }
      names.push(name);
    }
    if (this.isSym(":")) this.fail(this.peek(), UNBOUNDED);
    this.expect("in", "after the quantified variable");
    const domStart = this.peek();
    // Collect D's variables while parsing it (D may hold a `let` expansion,
    // which must not be walked before it is measured).
    const collector: FreeCollector = { vars: new Set(), merged: new Set() };
    this.collectors.push(collector);
    const dom = this.parseDomain();
    this.collectors.pop();
    if (names.length > 1) {
      // `forall x, y in D: φ` nests as `forall x in D: forall y in D: φ`, so
      // an `x` in D would mean the outer x in the inner copy and a free x in
      // the outer one.
      const clash = names.find((n) => collector.vars.has(n.text));
      if (clash !== undefined) {
        this.fail(
          domStart,
          `the domain mentions \`${clash.text}\`, which this quantifier also binds; write the quantifiers separately`,
        );
      }
    }
    this.expect(":", "after the domain");
    for (const n of names) this.scopes.push({ kind: "bound", name: n.text });
    const body = this.parseFormula();
    this.scopes.length -= names.length;
    this.leave();
    let f = this.asFormula(body, `the body of \`${kind}\``);
    for (let j = names.length - 1; j >= 0; j--) {
      f = { k: kind, v: (names[j] as Tok).text, dom, body: f };
    }
    return this.formula(f, q.pos);
  }

  private parseBinderName(): Tok {
    const t = this.peek();
    if (t.kind !== "id") this.fail(t, `expected a variable name, found ${describe(t)}`);
    if (NUMBER_SETS.has(t.text)) this.fail(t, UNBOUNDED);
    if (this.scopes.some((s) => s.name === t.text)) {
      this.fail(t, `\`${t.text}\` is already bound here; use a different name`);
    }
    return this.next();
  }

  private parseDomain(): Domain {
    const t = this.peek();
    if (t.kind === "sym" && t.text === "{") {
      this.next();
      const items: Term[] = [];
      if (!this.isSym("}")) {
        items.push(this.asTerm(this.parseSum(), "a domain value"));
        while (this.isSym(",")) {
          this.next();
          items.push(this.asTerm(this.parseSum(), "a domain value"));
        }
      }
      this.expect("}", "to close the domain");
      return { k: "set", items };
    }
    // `forall n in Nat: …` / `in ℕ:` — a named, unbounded set.
    if (t.kind === "id" && this.isSym(":", 1)) this.fail(t, UNBOUNDED);
    const lo = this.asTerm(this.parseSum(), "a range bound");
    if (!this.isSym("..")) {
      this.fail(
        this.peek(),
        `expected \`..\` (an integer range like \`0..9\`) or \`{…}\` (a finite set) as the domain; ${UNBOUNDED}`,
      );
    }
    this.next();
    const hi = this.asTerm(this.parseSum(), "a range bound");
    return { k: "range", lo, hi };
  }

  private parseLet(): Parsed {
    const l = this.next();
    this.enter(l);
    let pushed = 0;
    do {
      if (pushed > 0) this.next(); // the ","
      const name = this.parseBinderName();
      this.expect("=", `after \`let ${name.text}\``);
      const collector: FreeCollector = { vars: new Set(), merged: new Set() };
      this.collectors.push(collector);
      const value = this.parseSum();
      this.collectors.pop();
      if (value.s === "formula") this.fail(value, "a `let` value must be a number or an array");
      this.scopes.push({ kind: "let", name: name.text, value, free: collector.vars });
      pushed += 1;
    } while (this.isSym(","));
    this.expect("in", "after the `let` definitions");
    const body = this.parseFormula();
    this.scopes.length -= pushed;
    this.leave();
    return this.formula(this.asFormula(body, "the body of `let`"), l.pos);
  }

  private parseCmp(): Parsed {
    const left = this.parseSum();
    const t = this.peek();
    if (!(t.kind === "sym" && CMP_OPS.has(t.text))) return left;
    this.next();
    const right = this.parseSum();
    const after = this.peek();
    if (after.kind === "sym" && CMP_OPS.has(after.text)) {
      this.fail(after, "comparisons do not chain; write `a < b and b < c`");
    }
    return this.formula(
      {
        k: "cmp",
        op: t.text as CmpOp,
        a: this.asTerm(left, `the left side of \`${t.text}\``),
        b: this.asTerm(right, `the right side of \`${t.text}\``),
      },
      t.pos,
    );
  }

  // -- term levels ----------------------------------------------------------

  private parseSum(): Parsed {
    let left = this.parseProduct();
    while (this.isSym("+") || this.isSym("-")) {
      const op = this.next();
      const right = this.parseProduct();
      left = this.term(
        {
          k: op.text === "+" ? "add" : "sub",
          a: this.asTerm(left, `the left side of \`${op.text}\``),
          b: this.asTerm(right, `the right side of \`${op.text}\``),
        },
        op.pos,
      );
    }
    return left;
  }

  private parseProduct(): Parsed {
    let left = this.parseUnary();
    while (this.isSym("*") || this.isSym("/")) {
      const op = this.next();
      const right = this.parseUnary();
      left = this.term(
        {
          k: op.text === "*" ? "mul" : "div",
          a: this.asTerm(left, `the left side of \`${op.text}\``),
          b: this.asTerm(right, `the right side of \`${op.text}\``),
        },
        op.pos,
      );
    }
    return left;
  }

  private parseUnary(): Parsed {
    const t = this.peek();
    if (t.kind === "sym" && t.text === "-") {
      this.next();
      this.enter(t);
      const inner = this.parseUnary();
      this.leave();
      return this.term(mkNeg(this.asTerm(inner, "the operand of `-`")), t.pos);
    }
    return this.parsePower();
  }

  private parsePower(): Parsed {
    const base = this.parsePostfix();
    if (!this.isSym("^")) return base;
    const op = this.next();
    this.enter(op);
    const exp = this.parseUnary();
    this.leave();
    return this.term(
      {
        k: "pow",
        a: this.asTerm(base, "the base of `^`"),
        b: this.asTerm(exp, "the exponent of `^`"),
      },
      op.pos,
    );
  }

  private parsePostfix(): Parsed {
    let p = this.parsePrimary();
    while (this.isSym("[")) {
      const open = this.next();
      if (p.s !== "array") {
        this.fail(open, "only an array can be indexed (define one with `let s = [1, 2, 3] in …`)");
      }
      const index = this.asTerm(this.parseSum(), "an index");
      this.expect("]", "to close the index");
      p = this.term({ k: "idx", items: p.items, i: index }, open.pos);
    }
    return p;
  }

  private parsePrimary(): Parsed {
    const t = this.peek();
    this.enter(t);
    try {
      if (t.kind === "num") {
        this.next();
        return this.term({ k: "num", v: parseDecimal(t.text) }, t.pos);
      }
      if (t.kind === "id") {
        this.next();
        return this.resolveName(t);
      }
      if (t.kind === "sym") {
        switch (t.text) {
          case "true":
          case "false":
            this.next();
            return this.formula({ k: "bool", v: t.text === "true" }, t.pos);
          case "(": {
            this.next();
            const inner = this.parseFormula();
            this.expect(")", "to close the parenthesis");
            return inner;
          }
          case "abs": {
            this.next();
            this.expect("(", "after `abs`");
            const a = this.asTerm(this.parseSum(), "the argument of `abs`");
            this.expect(")", "to close `abs(…)`");
            return this.term({ k: "abs", a }, t.pos);
          }
          case "min":
          case "max": {
            this.next();
            this.expect("(", `after \`${t.text}\``);
            const args: Term[] = [this.asTerm(this.parseSum(), `an argument of \`${t.text}\``)];
            while (this.isSym(",")) {
              this.next();
              args.push(this.asTerm(this.parseSum(), `an argument of \`${t.text}\``));
            }
            this.expect(")", `to close \`${t.text}(…)\``);
            return this.term({ k: t.text, args }, t.pos);
          }
          case "[": {
            this.next();
            const items: Term[] = [];
            if (!this.isSym("]")) {
              items.push(this.asTerm(this.parseSum(), "an array element"));
              while (this.isSym(",")) {
                this.next();
                items.push(this.asTerm(this.parseSum(), "an array element"));
              }
            }
            this.expect("]", "to close the array");
            return { s: "array", items, pos: t.pos };
          }
          default:
            break;
        }
      }
      return this.fail(
        t,
        `expected a number, a variable, \`(\`, \`true\`, \`false\` or a function, found ${describe(t)}`,
      );
    } finally {
      this.leave();
    }
  }

  /**
   * A name is a quantified variable, a `let` definition (replaced by its value
   * here) or a free variable. A `let` value is refused where a quantifier
   * between the definition and the use rebinds one of its free variables —
   * the substitution would capture it. The value's free variables were
   * collected when it was parsed: walking the value here would walk its
   * expansion, which a chain of `let`s makes exponential in the text.
   */
  private resolveName(t: Tok): Parsed {
    for (let j = this.scopes.length - 1; j >= 0; j--) {
      const s = this.scopes[j] as Scope;
      if (s.name !== t.text) continue;
      if (s.kind === "bound") {
        this.noteFree(t.text);
        return this.term({ k: "var", name: t.text }, t.pos);
      }
      for (let m = j + 1; m < this.scopes.length; m++) {
        const inner = this.scopes[m] as Scope;
        if (inner.kind === "bound" && s.free.has(inner.name)) {
          this.fail(
            t,
            `\`${t.text}\` uses \`${inner.name}\`, which a quantifier inside its scope rebinds; rename that quantifier's variable`,
          );
        }
      }
      for (const c of this.collectors) {
        // Each definition's set is merged once per collector, so a value that
        // uses one name many times costs one merge.
        if (c.merged.has(s)) continue;
        c.merged.add(s);
        for (const v of s.free) c.vars.add(v);
      }
      return { ...s.value, pos: t.pos } as Parsed;
    }
    this.noteFree(t.text);
    return this.term({ k: "var", name: t.text }, t.pos);
  }

  /** A variable occurrence: free in every `let` value being parsed. */
  private noteFree(name: string): void {
    for (const c of this.collectors) c.vars.add(name);
  }
}

function describe(t: Tok): string {
  if (t.kind === "eof") return "the end of the text";
  return `\`${t.text}\``;
}

/**
 * Parse one formula. Throws {@link CheckFailure} with `line L, column C` on a
 * syntax error and when the `let`-expanded formula exceeds the size caps.
 * With a `budget`, parsing and measuring spend from it, so the deadline and
 * the abort signal reach the parse too.
 */
export function parseFormula(src: string, budget?: Budget): Formula {
  if (src.length > BUILTIN_LIMITS.maxStatementChars) {
    throw new CheckFailure(
      `the formula is ${src.length} characters; the cap is ${BUILTIN_LIMITS.maxStatementChars}`,
    );
  }
  const f = new Parser(src, budget).parseStatement();
  measure(f, budget);
  return f;
}

/** Parse a closed value (an instantiation or witness), e.g. `3`, `10.5`, `1/3`. */
export function parseValue(src: string): Term {
  if (src.length > BUILTIN_LIMITS.maxStatementChars) {
    throw new CheckFailure("the value is too long");
  }
  const t = new Parser(src).parseClosedTerm();
  const free = freeVarsTerm(t);
  if (free.size > 0) {
    throw new CheckFailure(
      `the value \`${src}\` mentions ${[...free].join(", ")}; it must be closed`,
    );
  }
  return t;
}

// ---------------------------------------------------------------------------
// Size (a `let` expansion shares subtrees, so count with memoisation)
// ---------------------------------------------------------------------------

type Node = Term | Formula | Domain;

function children(n: Node): Node[] {
  switch (n.k) {
    case "num":
    case "var":
    case "bool":
      return [];
    case "neg":
    case "abs":
    case "not":
      return [n.a];
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "pow":
    case "and":
    case "or":
    case "imp":
    case "iff":
    case "cmp":
      return [n.a, n.b];
    case "min":
    case "max":
      return [...n.args];
    case "idx":
      return [...n.items, n.i];
    case "set":
      return [...n.items];
    case "range":
      return [n.lo, n.hi];
    case "forall":
    case "exists":
      return [n.dom, n.body];
  }
}

function measure(f: Formula, budget?: Budget): void {
  const size = new Map<Node, number>();
  const depth = new Map<Node, number>();
  // Iterative post-order: an expanded formula may be deeper than the stack likes.
  const stack: Array<{ n: Node; done: boolean }> = [{ n: f, done: false }];
  while (stack.length > 0) {
    budget?.tick();
    const top = stack.pop() as { n: Node; done: boolean };
    if (size.has(top.n)) continue;
    const kids = children(top.n);
    if (!top.done) {
      stack.push({ n: top.n, done: true });
      for (const k of kids) if (!size.has(k)) stack.push({ n: k, done: false });
      continue;
    }
    let s = 1;
    let d = 0;
    for (const k of kids) {
      s += size.get(k) ?? 0;
      d = Math.max(d, depth.get(k) ?? 0);
    }
    if (s > BUILTIN_LIMITS.maxFormulaNodes) {
      throw new CheckFailure(
        `the formula expands to more than ${BUILTIN_LIMITS.maxFormulaNodes} nodes; use fewer \`let\` uses or a smaller statement`,
      );
    }
    if (d + 1 > BUILTIN_LIMITS.maxFormulaDepth) {
      throw new CheckFailure(
        `the formula nests more than ${BUILTIN_LIMITS.maxFormulaDepth} levels deep`,
      );
    }
    size.set(top.n, s);
    depth.set(top.n, d + 1);
  }
}

// ---------------------------------------------------------------------------
// Free variables
// ---------------------------------------------------------------------------

export function freeVarsTerm(t: Term, out: Set<string> = new Set()): Set<string> {
  switch (t.k) {
    case "num":
      return out;
    case "var":
      out.add(t.name);
      return out;
    case "neg":
    case "abs":
      return freeVarsTerm(t.a, out);
    case "min":
    case "max":
      for (const a of t.args) freeVarsTerm(a, out);
      return out;
    case "idx":
      for (const a of t.items) freeVarsTerm(a, out);
      return freeVarsTerm(t.i, out);
    default:
      freeVarsTerm(t.a, out);
      return freeVarsTerm(t.b, out);
  }
}

export function freeVarsDomain(d: Domain, out: Set<string> = new Set()): Set<string> {
  if (d.k === "set") {
    for (const t of d.items) freeVarsTerm(t, out);
    return out;
  }
  freeVarsTerm(d.lo, out);
  return freeVarsTerm(d.hi, out);
}

export function freeVars(f: Formula, out: Set<string> = new Set()): Set<string> {
  switch (f.k) {
    case "bool":
      return out;
    case "cmp":
      freeVarsTerm(f.a, out);
      return freeVarsTerm(f.b, out);
    case "not":
      return freeVars(f.a, out);
    case "forall":
    case "exists": {
      freeVarsDomain(f.dom, out);
      const inner = freeVars(f.body);
      inner.delete(f.v);
      for (const v of inner) out.add(v);
      return out;
    }
    default:
      freeVars(f.a, out);
      return freeVars(f.b, out);
  }
}

// ---------------------------------------------------------------------------
// Substitution (capture-avoiding)
// ---------------------------------------------------------------------------

/** Replace every free `x` in a term by `value`. Terms have no binders. */
export function substTerm(t: Term, x: string, value: Term, budget: Budget): Term {
  budget.tick();
  switch (t.k) {
    case "num":
      return t;
    case "var":
      return t.name === x ? value : t;
    case "neg":
      return mkNeg(substTerm(t.a, x, value, budget));
    case "abs":
      return { k: "abs", a: substTerm(t.a, x, value, budget) };
    case "min":
    case "max":
      return { k: t.k, args: t.args.map((a) => substTerm(a, x, value, budget)) };
    case "idx":
      return {
        k: "idx",
        items: t.items.map((a) => substTerm(a, x, value, budget)),
        i: substTerm(t.i, x, value, budget),
      };
    default:
      return {
        k: t.k,
        a: substTerm(t.a, x, value, budget),
        b: substTerm(t.b, x, value, budget),
      };
  }
}

function substDomain(d: Domain, x: string, value: Term, budget: Budget): Domain {
  if (d.k === "set") return { k: "set", items: d.items.map((t) => substTerm(t, x, value, budget)) };
  return {
    k: "range",
    lo: substTerm(d.lo, x, value, budget),
    hi: substTerm(d.hi, x, value, budget),
  };
}

function freshName(base: string, avoid: Set<string>): string {
  for (let n = 1; ; n++) {
    const candidate = `${base}_${n}`;
    if (!avoid.has(candidate)) return candidate;
  }
}

/** `f[x := value]`, renaming a binder that would capture a free variable of `value`. */
export function subst(f: Formula, x: string, value: Term, budget: Budget): Formula {
  budget.tick();
  switch (f.k) {
    case "bool":
      return f;
    case "cmp":
      return {
        k: "cmp",
        op: f.op,
        a: substTerm(f.a, x, value, budget),
        b: substTerm(f.b, x, value, budget),
      };
    case "not":
      return { k: "not", a: subst(f.a, x, value, budget) };
    case "forall":
    case "exists": {
      const dom = substDomain(f.dom, x, value, budget);
      if (f.v === x) return { k: f.k, v: f.v, dom, body: f.body };
      const valueFree = freeVarsTerm(value);
      if (!valueFree.has(f.v)) {
        return { k: f.k, v: f.v, dom, body: subst(f.body, x, value, budget) };
      }
      const avoid = new Set([...valueFree, ...freeVars(f.body), x]);
      const renamed = freshName(f.v, avoid);
      const body = subst(f.body, f.v, { k: "var", name: renamed }, budget);
      return { k: f.k, v: renamed, dom, body: subst(body, x, value, budget) };
    }
    default:
      return {
        k: f.k,
        a: subst(f.a, x, value, budget),
        b: subst(f.b, x, value, budget),
      };
  }
}

// ---------------------------------------------------------------------------
// Alpha-equality
// ---------------------------------------------------------------------------

/** Bound-variable environment: name → binder depth, innermost first. */
export type BoundEnv = { readonly name: string; readonly level: number; readonly next?: BoundEnv };

export function lookupBound(env: BoundEnv | undefined, name: string): number | undefined {
  for (let e = env; e !== undefined; e = e.next) if (e.name === name) return e.level;
  return undefined;
}

function depthOf(env: BoundEnv | undefined): number {
  return env === undefined ? 0 : env.level + 1;
}

export function bind(env: BoundEnv | undefined, name: string): BoundEnv {
  return env === undefined ? { name, level: 0 } : { name, level: depthOf(env), next: env };
}

/** Term equality up to the names of bound variables (numbers compare by value). */
export function termEq(
  a: Term,
  b: Term,
  budget: Budget,
  envA?: BoundEnv,
  envB?: BoundEnv,
): boolean {
  budget.tick();
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "num":
      return ratEq(a.v, (b as typeof a).v);
    case "var": {
      const bb = b as typeof a;
      const la = lookupBound(envA, a.name);
      const lb = lookupBound(envB, bb.name);
      if (la === undefined && lb === undefined) return a.name === bb.name;
      return la === lb;
    }
    case "neg":
    case "abs":
      return termEq(a.a, (b as typeof a).a, budget, envA, envB);
    case "min":
    case "max": {
      const bb = b as typeof a;
      return (
        a.args.length === bb.args.length &&
        a.args.every((x, i) => termEq(x, bb.args[i] as Term, budget, envA, envB))
      );
    }
    case "idx": {
      const bb = b as typeof a;
      return (
        a.items.length === bb.items.length &&
        a.items.every((x, i) => termEq(x, bb.items[i] as Term, budget, envA, envB)) &&
        termEq(a.i, bb.i, budget, envA, envB)
      );
    }
    default: {
      const bb = b as typeof a;
      return termEq(a.a, bb.a, budget, envA, envB) && termEq(a.b, bb.b, budget, envA, envB);
    }
  }
}

function domainEq(a: Domain, b: Domain, budget: Budget, envA?: BoundEnv, envB?: BoundEnv): boolean {
  if (a.k === "set" && b.k === "set") {
    return (
      a.items.length === b.items.length &&
      a.items.every((x, i) => termEq(x, b.items[i] as Term, budget, envA, envB))
    );
  }
  if (a.k === "range" && b.k === "range") {
    return termEq(a.lo, b.lo, budget, envA, envB) && termEq(a.hi, b.hi, budget, envA, envB);
  }
  return false;
}

/** Formula equality up to the names of bound variables. */
export function formulaEq(
  a: Formula,
  b: Formula,
  budget: Budget,
  envA?: BoundEnv,
  envB?: BoundEnv,
): boolean {
  budget.tick();
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "bool":
      return a.v === (b as typeof a).v;
    case "cmp": {
      const bb = b as typeof a;
      return (
        a.op === bb.op &&
        termEq(a.a, bb.a, budget, envA, envB) &&
        termEq(a.b, bb.b, budget, envA, envB)
      );
    }
    case "not":
      return formulaEq(a.a, (b as typeof a).a, budget, envA, envB);
    case "forall":
    case "exists": {
      const bb = b as typeof a;
      return (
        domainEq(a.dom, bb.dom, budget, envA, envB) &&
        formulaEq(a.body, bb.body, budget, bind(envA, a.v), bind(envB, bb.v))
      );
    }
    default: {
      const bb = b as typeof a;
      return formulaEq(a.a, bb.a, budget, envA, envB) && formulaEq(a.b, bb.b, budget, envA, envB);
    }
  }
}

// ---------------------------------------------------------------------------
// Printer — the normalized text of a formula (assumptions, traces)
// ---------------------------------------------------------------------------

const TERM_PREC: Readonly<Record<string, number>> = {
  add: 1,
  sub: 1,
  mul: 2,
  div: 2,
  neg: 3,
  pow: 4,
};

function printNum(v: Rat, minPrec: number): string {
  const text = ratToString(v);
  // A negative literal binds like unary minus; a fraction like division.
  const prec = text.startsWith("-") ? 3 : text.includes("/") ? 2 : 5;
  return prec < minPrec ? `(${text})` : text;
}

/**
 * The canonical text of a term. Printing walks the `let`-expanded tree, so a
 * caller that prints once per step passes its `budget`.
 */
export function printTerm(t: Term, minPrec = 0, budget?: Budget): string {
  budget?.tick();
  let text: string;
  let prec: number;
  switch (t.k) {
    case "num":
      return printNum(t.v, minPrec);
    case "var":
      return t.name;
    case "neg":
      text = `-${printTerm(t.a, 3, budget)}`;
      prec = 3;
      break;
    case "abs":
      return `abs(${printTerm(t.a, 0, budget)})`;
    case "min":
    case "max":
      return `${t.k}(${t.args.map((a) => printTerm(a, 0, budget)).join(", ")})`;
    case "idx":
      return `[${t.items.map((a) => printTerm(a, 0, budget)).join(", ")}][${printTerm(t.i, 0, budget)}]`;
    case "pow":
      text = `${printTerm(t.a, 5, budget)}^${printTerm(t.b, 3, budget)}`;
      prec = 4;
      break;
    default: {
      prec = TERM_PREC[t.k] as number;
      const op = t.k === "add" ? "+" : t.k === "sub" ? "-" : t.k === "mul" ? "*" : "/";
      text = `${printTerm(t.a, prec, budget)} ${op} ${printTerm(t.b, prec + 1, budget)}`;
      break;
    }
  }
  return prec < minPrec ? `(${text})` : text;
}

function printDomain(d: Domain, budget?: Budget): string {
  if (d.k === "set") return `{${d.items.map((t) => printTerm(t, 0, budget)).join(", ")}}`;
  return `${printTerm(d.lo, 1, budget)}..${printTerm(d.hi, 1, budget)}`;
}

const FORMULA_PREC: Readonly<Record<string, number>> = {
  iff: 1,
  imp: 2,
  or: 3,
  and: 4,
  not: 5,
  cmp: 6,
  bool: 7,
};

/**
 * The canonical ASCII text of a formula; it parses back to an equal formula.
 * Walks the expanded tree — pass the `budget` when printing once per step.
 */
export function printFormula(f: Formula, minPrec = 0, budget?: Budget): string {
  budget?.tick();
  let text: string;
  let prec: number;
  switch (f.k) {
    case "bool":
      return f.v ? "true" : "false";
    case "cmp":
      text = `${printTerm(f.a, 0, budget)} ${f.op} ${printTerm(f.b, 0, budget)}`;
      prec = 6;
      break;
    case "not":
      text = `not ${printFormula(f.a, 5, budget)}`;
      prec = 5;
      break;
    case "forall":
    case "exists":
      text = `${f.k} ${f.v} in ${printDomain(f.dom, budget)}: ${printFormula(f.body, 0, budget)}`;
      prec = 0;
      break;
    case "iff":
      text = `${printFormula(f.a, 2, budget)} <-> ${printFormula(f.b, 2, budget)}`;
      prec = 1;
      break;
    case "imp":
      text = `${printFormula(f.a, 3, budget)} -> ${printFormula(f.b, 2, budget)}`;
      prec = 2;
      break;
    default: {
      prec = FORMULA_PREC[f.k] as number;
      text = `${printFormula(f.a, prec, budget)} ${f.k} ${printFormula(f.b, prec + 1, budget)}`;
      break;
    }
  }
  // A binder (prec 0) runs to the end of the text, so any context above the top
  // needs parentheses around it.
  return prec < minPrec ? `(${text})` : text;
}

/**
 * The `smt` proof checker — SMT-LIB 2 to Z3 in a sandbox (design §6.4).
 *
 * Input: `statement` is the goal as ONE SMT-LIB term; `proof` is the problem
 * preamble — declarations, definitions and `assert`ed hypotheses. The adapter
 * parses both into S-expressions, refuses every command that is not a pure
 * declaration or assertion, and writes the script Z3 runs itself, re-printed
 * from the parse so the text Z3 reads has exactly the structure that was
 * checked:
 *
 *     (set-option :print-success false)
 *     (set-option :produce-models true)
 *     (set-option :timeout <ms>)
 *     <preamble>
 *     (check-sat)                    ; 1: the hypotheses must be satisfiable
 *     (assert (not <statement>))
 *     (check-sat)                    ; 2: unsat ⇒ the hypotheses entail the goal
 *     (get-model)                    ;    sat ⇒ this model is the counterexample
 *     (exit)
 *
 * Check 1 exists because an inconsistent set of hypotheses entails anything:
 * `unsat` there rejects the proof ("hypotheses are inconsistent; anything
 * follows from them"). `unknown` or a timeout on either check is a rejection,
 * never a pass. Every `assert` and every `define-fun` in the preamble is
 * reported as an assumption: a definition fixes a value just as an assertion
 * does (`(define-fun revenue () Int 5)` proves `(= revenue 5)`), and the
 * bundle lists everything a proof depends on (design §6.4).
 *
 * Z3 lets a preamble redefine its own built-ins — `(define-fun <= ((a Int)
 * (b Int)) Bool true)` makes `(<= 11 10)` "proven" with no assumptions — so
 * every name the preamble or the statement introduces (declared, defined,
 * bound, `:named`, a datatype's sorts, constructors and selectors) must be a
 * plain identifier that is not a built-in: {@link SMT_RESERVED_NAMES}.
 * One container run, argv `["z3", "-in"]`, the script on stdin, network none
 * (the sandbox default).
 */
import { Z3_HEALTHCHECK_ARGV, Z3_IMAGE_REF } from "@crewhaus/sandbox-image-z3";
import {
  ASSUMPTION_CAP,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  type SandboxCheckerOptions,
  type SandboxProofChecker,
  budgetMs,
  clipLine,
  clipOutput,
  createAvailabilityProbe,
  errorMessage,
  noopRefusal,
} from "./sandbox-common";
import type { CheckInput, CheckResult } from "./types";

export const SMT_CHECKER_ID = "smt";

/** The commands a preamble may use: declarations, definitions, assertions. */
export const SMT_PREAMBLE_COMMANDS: ReadonlyArray<string> = [
  "set-logic",
  "declare-const",
  "declare-fun",
  "define-fun",
  "declare-sort",
  "define-sort",
  "declare-datatype",
  "declare-datatypes",
  "assert",
];

export const SMT_LANGUAGE = [
  "smt: SMT-LIB 2 checked by the Z3 solver in a sandbox; linear and non-linear integer/real arithmetic, bit-vectors, arrays, datatypes (finite domains), quantifiers (Z3 may answer unknown on them).",
  "`statement` is the goal as ONE SMT-LIB Boolean term, e.g. `(<= (+ x y) 10)`.",
  "`proof` is the problem preamble, using only set-logic, declare-const, declare-fun, define-fun, declare-sort, define-sort, declare-datatype(s) (SMT-LIB 2.6 form) and assert; no check-sat, push/pop, set-option, get-* or exit (the checker adds its own).",
  "Every name you declare, define or bind is letters, digits and _ starting with a letter, declared once, and not a built-in (true, false, not, and, or, ite, distinct, div, mod, abs, select, store, bv…, Int, Bool, …).",
  "The checker first requires the asserts to be satisfiable (inconsistent hypotheses prove anything, so they are rejected), then asserts the negated goal: unsat proves it; sat rejects it with Z3's model as the counterexample; unknown or a timeout rejects it.",
  "Every assert and every define-fun is listed as an assumption of the proof.",
  "Example: statement `(<= (+ x y) 10)`, proof `(declare-const x Int) (declare-const y Int) (assert (<= x 4)) (assert (<= y 6))`.",
].join(" ");

/** Characters in the preamble / the statement. */
export const SMT_LIMITS = {
  maxPreambleChars: 200_000,
  maxStatementChars: 20_000,
  maxDepth: 500,
  maxNodes: 200_000,
} as const;

/**
 * The names a preamble or statement may introduce: letters, digits and `_`,
 * starting with a letter (optionally `|quoted|`, which SMT-LIB 2.6 makes the
 * same symbol). Operator spellings (`<=`, `+`, `=>`), dotted theory names
 * (`str.len`, `fp.abs`, `re.*`) and hyphenated ones (`is-red`, `root-obj`)
 * are therefore never declarable; a hyphen would also read as subtraction.
 */
export const SMT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Alphanumeric symbols a declaration may not take: the SMT-LIB 2.6 reserved
 * words and theory symbols, plus every such symbol Z3 4.11.2 resolves without
 * a declaration (found by probing each identifier string in the z3 binary
 * with `(simplify <name>)`). Z3 accepts a redefinition of any of them, and a
 * redefined `<=`, `=`, `ite` or `false` turns a false goal into a "proof".
 * Names starting with `bv` are refused as a family ({@link isReservedSmtName}):
 * Z3 keeps adding bit-vector operators.
 */
export const SMT_RESERVED_NAMES: ReadonlySet<string> = new Set([
  // SMT-LIB 2.6 reserved words (the hyphenated commands cannot match the name pattern)
  "BINARY",
  "DECIMAL",
  "HEXADECIMAL",
  "NUMERAL",
  "STRING",
  "as",
  "assert",
  "echo",
  "exists",
  "exit",
  "forall",
  "lambda",
  "let",
  "match",
  "par",
  "pop",
  "push",
  "reset",
  // Core
  "true",
  "false",
  "not",
  "and",
  "or",
  "xor",
  "implies",
  "iff",
  "if",
  "ite",
  "distinct",
  // Arithmetic (Ints, Reals, Z3's transcendentals)
  "abs",
  "div",
  "mod",
  "rem",
  "div0",
  "mod0",
  "rem0",
  "to_real",
  "to_int",
  "is_int",
  "divisible",
  "pi",
  "euler",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  // Arrays and sets
  "select",
  "store",
  "const",
  "map",
  "default",
  "union",
  "intersection",
  "setminus",
  "subset",
  "complement",
  // Bit-vectors beyond the bv* family
  "bit0",
  "bit1",
  "bit2bool",
  "mkbv",
  "concat",
  "extract",
  "repeat",
  "zero_extend",
  "sign_extend",
  "rotate_left",
  "rotate_right",
  "ext_rotate_left",
  "ext_rotate_right",
  "int2bv",
  "nat2bv",
  "ubv_to_str",
  "sbv_to_str",
  // Floating point
  "fp",
  "NaN",
  "RNA",
  "RNE",
  "RTN",
  "RTP",
  "RTZ",
  "roundNearestTiesToAway",
  "roundNearestTiesToEven",
  "roundTowardNegative",
  "roundTowardPositive",
  "roundTowardZero",
  "to_fp",
  "to_fp_unsigned",
  "to_ieee_bv",
  // Characters, datatypes, pseudo-Booleans, difference logic
  "Char",
  "char",
  "is",
  "pbeq",
  "pbge",
  "pble",
  "maxdiff",
  "mindiff",
]);

/** Sort names a declaration may not take (Z3 refuses most itself; this does not rely on it). */
export const SMT_RESERVED_SORTS: ReadonlySet<string> = new Set([
  "Bool",
  "Int",
  "Real",
  "Array",
  "BitVec",
  "String",
  "RegLan",
  "RegEx",
  "Seq",
  "Set",
  "FloatingPoint",
  "Float16",
  "Float32",
  "Float64",
  "Float128",
  "RoundingMode",
  "Char",
  "Unicode",
]);

/** Whether a (bar-stripped) function or constant name is a built-in. */
export function isReservedSmtName(name: string): boolean {
  return SMT_RESERVED_NAMES.has(name) || /^bv/.test(name);
}

// ---------------------------------------------------------------------------
// S-expressions
// ---------------------------------------------------------------------------

/** An atom keeps its raw text: `x`, `42`, `#b101`, `"a string"`, `|quoted|`, `:named`. */
export type SExpr = string | readonly SExpr[];

class SmtSyntaxError extends Error {
  override readonly name = "SmtSyntaxError";
}

function isDelimiter(c: string): boolean {
  return c === "(" || c === ")" || c === '"' || c === ";" || c === "|" || /\s/.test(c);
}

/**
 * Parse SMT-LIB text into top-level S-expressions. Comments are dropped.
 * `strict` (input) refuses a backslash inside a string or quoted symbol and
 * any control character: SMT-LIB 2.6 has no backslash escapes, but older
 * readers did, and a reader that ends a string somewhere else than this
 * parser does would see different commands than the ones validated here.
 */
export function parseSExprs(text: string, strict = true): SExpr[] {
  const top: SExpr[] = [];
  const stack: SExpr[][] = [];
  let nodes = 0;
  let i = 0;
  const push = (e: SExpr): void => {
    nodes += 1;
    if (nodes > SMT_LIMITS.maxNodes) throw new SmtSyntaxError("the problem is too large");
    (stack.length > 0 ? (stack[stack.length - 1] as SExpr[]) : top).push(e);
  };
  if (strict) {
    for (let k = 0; k < text.length; k++) {
      const code = text.charCodeAt(k);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
        throw new SmtSyntaxError(`control character at offset ${k}`);
      }
    }
  }
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === ";") {
      while (i < text.length && text.charAt(i) !== "\n") i += 1;
      continue;
    }
    if (c === "(") {
      const list: SExpr[] = [];
      push(list);
      stack.push(list);
      if (stack.length > SMT_LIMITS.maxDepth) {
        throw new SmtSyntaxError(`nesting deeper than ${SMT_LIMITS.maxDepth}`);
      }
      i += 1;
      continue;
    }
    if (c === ")") {
      if (stack.length === 0) throw new SmtSyntaxError(`unbalanced \`)\` at offset ${i}`);
      stack.pop();
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new SmtSyntaxError(`unterminated string at offset ${i}`);
        const d = text.charAt(j);
        if (strict && d === "\\") {
          throw new SmtSyntaxError(`a backslash inside a string at offset ${j} is not accepted`);
        }
        if (!strict && d === "\\" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (d === '"') {
          if (text.charAt(j + 1) === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "|") {
      const end = text.indexOf("|", i + 1);
      if (end < 0) throw new SmtSyntaxError(`unterminated quoted symbol at offset ${i}`);
      const body = text.slice(i + 1, end);
      if (strict && body.includes("\\")) {
        throw new SmtSyntaxError(
          `a backslash inside a quoted symbol at offset ${i} is not accepted`,
        );
      }
      push(text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !isDelimiter(text.charAt(j))) j += 1;
    push(text.slice(i, j));
    i = j;
  }
  if (stack.length > 0) throw new SmtSyntaxError("unbalanced `(`: a list is never closed");
  return top;
}

/** Print an S-expression back to SMT-LIB text (single-spaced, comments gone). */
export function printSExpr(e: SExpr): string {
  return typeof e === "string" ? e : `(${e.map(printSExpr).join(" ")})`;
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

export type SmtProblem = {
  /** The script Z3 reads on stdin. */
  readonly script: string;
  /** The asserted hypotheses, printed. */
  readonly assumptions: readonly string[];
};

/** Validate the statement and the preamble and write the script; throws a reason. */
export function buildSmtScript(
  statement: string,
  preamble: string,
  solverTimeoutMs: number,
): SmtProblem {
  if (statement.length > SMT_LIMITS.maxStatementChars) {
    throw new SmtSyntaxError(
      `the statement is ${statement.length} characters; the cap is ${SMT_LIMITS.maxStatementChars}`,
    );
  }
  if (preamble.length > SMT_LIMITS.maxPreambleChars) {
    throw new SmtSyntaxError(
      `the preamble is ${preamble.length} characters; the cap is ${SMT_LIMITS.maxPreambleChars}`,
    );
  }
  let goal: SExpr[];
  try {
    goal = parseSExprs(statement);
  } catch (err) {
    throw new SmtSyntaxError(`statement: ${errorMessage(err)}`);
  }
  if (goal.length !== 1) {
    throw new SmtSyntaxError(
      `the statement must be exactly one SMT-LIB term, found ${goal.length === 0 ? "none" : goal.length}`,
    );
  }
  let commands: SExpr[];
  try {
    commands = parseSExprs(preamble);
  } catch (err) {
    throw new SmtSyntaxError(`proof: ${errorMessage(err)}`);
  }
  const assumptions: string[] = [];
  const listed = new Set<string>();
  const names = new NameTable();
  commands.forEach((cmd, index) => {
    if (typeof cmd === "string" || cmd.length === 0 || typeof cmd[0] !== "string") {
      throw new SmtSyntaxError(
        `proof: every top-level item must be a command like \`(declare-const x Int)\`, found \`${clipLine(printSExpr(cmd), 60)}\``,
      );
    }
    const name = cmd[0];
    if (!SMT_PREAMBLE_COMMANDS.includes(name)) {
      throw new SmtSyntaxError(
        `proof: \`${name}\` is not allowed in the preamble (only ${SMT_PREAMBLE_COMMANDS.join(", ")}); the checker issues check-sat and get-model itself`,
      );
    }
    if (name === "set-logic" && index !== 0) {
      throw new SmtSyntaxError("proof: `set-logic` must be the first command");
    }
    try {
      checkCommandNames(cmd, names);
    } catch (err) {
      throw new SmtSyntaxError(`proof: ${errorMessage(err)}`);
    }
    if (name === "assert" || name === "define-fun") {
      // An assertion is listed as its term; a definition whole, since it fixes
      // a value (or a function) the goal may rest on.
      const text = clipLine(
        printSExpr(name === "assert" ? (cmd[1] as SExpr) : cmd),
        ASSUMPTION_CAP,
      );
      if (!listed.has(text)) {
        listed.add(text);
        assumptions.push(text);
      }
    }
  });
  try {
    walkTerm(goal[0] as SExpr, names);
  } catch (err) {
    throw new SmtSyntaxError(`statement: ${errorMessage(err)}`);
  }
  const ms = Math.max(1, Math.floor(solverTimeoutMs));
  const lines = [
    "(set-option :print-success false)",
    "(set-option :produce-models true)",
    `(set-option :timeout ${ms})`,
    ...commands.map(printSExpr),
    "(check-sat)",
    `(assert (not ${printSExpr(goal[0] as SExpr)}))`,
    "(check-sat)",
    "(get-model)",
    "(exit)",
  ];
  return { script: `${lines.join("\n")}\n`, assumptions };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Global names introduced so far: functions/constants and sorts are separate namespaces. */
class NameTable {
  readonly funs = new Set<string>();
  readonly sorts = new Set<string>();
}

type NameKind = "function" | "sort" | "variable";

/**
 * Validate one introduced name and return it bar-stripped. Throws a reason.
 * `|x|` and `x` are one symbol (SMT-LIB 2.6), so the check is on the inside.
 */
function checkName(e: SExpr | undefined, kind: NameKind, what: string): string {
  if (typeof e !== "string") {
    throw new SmtSyntaxError(
      `${what} must be a name, found \`${e === undefined ? "nothing" : clipLine(printSExpr(e), 60)}\``,
    );
  }
  const bare = e.length >= 2 && e.startsWith("|") && e.endsWith("|") ? e.slice(1, -1) : e;
  if (!SMT_NAME_PATTERN.test(bare)) {
    throw new SmtSyntaxError(
      `\`${clipLine(e, 60)}\` (${what}) is not an accepted name: use letters, digits and _, starting with a letter`,
    );
  }
  const reserved = kind === "sort" ? SMT_RESERVED_SORTS.has(bare) : isReservedSmtName(bare);
  if (reserved) {
    throw new SmtSyntaxError(
      `the preamble may not declare \`${bare}\` (${what}): it is an SMT-LIB/Z3 built-in${bare === "not" ? ", and the checker negates the goal with `not`" : ""}, and redefining a built-in can make a false goal look proven; choose another name`,
    );
  }
  return bare;
}

/**
 * A global name: valid, and not introduced before in its namespace. Not named
 * `declare`: Bun 1.3 drops a statement that starts `declare(` as a TypeScript
 * ambient declaration, so every such call would silently vanish.
 */
function introduceName(
  e: SExpr | undefined,
  kind: "function" | "sort",
  what: string,
  t: NameTable,
): void {
  const bare = checkName(e, kind, what);
  const table = kind === "sort" ? t.sorts : t.funs;
  if (table.has(bare)) {
    throw new SmtSyntaxError(`\`${bare}\` is declared twice; give each ${kind} one declaration`);
  }
  table.add(bare);
}

function list(e: SExpr | undefined, what: string): readonly SExpr[] {
  if (e === undefined || typeof e === "string") {
    throw new SmtSyntaxError(`${what} must be a parenthesised list`);
  }
  return e;
}

/** `((x Int) (y Real))` — binder names checked, sorts left alone. */
function checkSortedVars(e: SExpr | undefined, what: string): void {
  for (const v of list(e, what)) {
    const pair = list(v, `each of ${what}`);
    checkName(pair[0], "variable", what);
  }
}

/** The names a command introduces, and the binders in the terms it holds. */
function checkCommandNames(cmd: readonly SExpr[], t: NameTable): void {
  const head = cmd[0];
  switch (head) {
    case "set-logic":
      if (cmd.length !== 2 || typeof cmd[1] !== "string") {
        throw new SmtSyntaxError("`set-logic` takes one logic name");
      }
      return;
    case "assert":
      if (cmd.length !== 2) throw new SmtSyntaxError("`assert` takes exactly one term");
      walkTerm(cmd[1] as SExpr, t);
      return;
    case "declare-const":
      if (cmd.length !== 3) throw new SmtSyntaxError("`declare-const` takes a name and a sort");
      introduceName(cmd[1], "function", "a constant", t);
      return;
    case "declare-fun":
      if (cmd.length !== 4) {
        throw new SmtSyntaxError("`declare-fun` takes a name, argument sorts and a sort");
      }
      introduceName(cmd[1], "function", "a function", t);
      return;
    case "define-fun":
      if (cmd.length !== 5) {
        throw new SmtSyntaxError("`define-fun` takes a name, parameters, a sort and a body");
      }
      introduceName(cmd[1], "function", "a definition", t);
      checkSortedVars(cmd[2], "the parameters");
      walkTerm(cmd[4] as SExpr, t);
      return;
    case "declare-sort":
      if (cmd.length !== 3) throw new SmtSyntaxError("`declare-sort` takes a name and an arity");
      introduceName(cmd[1], "sort", "a sort", t);
      return;
    case "define-sort":
      if (cmd.length !== 4) {
        throw new SmtSyntaxError("`define-sort` takes a name, parameters and a sort");
      }
      introduceName(cmd[1], "sort", "a sort", t);
      for (const p of list(cmd[2], "the sort parameters")) checkName(p, "sort", "a sort parameter");
      return;
    case "declare-datatype":
      if (cmd.length !== 3) {
        throw new SmtSyntaxError("`declare-datatype` takes a name and its constructors");
      }
      introduceName(cmd[1], "sort", "a datatype", t);
      checkDatatype(cmd[2], t);
      return;
    case "declare-datatypes": {
      const shape =
        "`declare-datatypes` takes the SMT-LIB 2.6 form `(declare-datatypes ((T 0)) (((c1) (c2 (field Int)))))`";
      if (cmd.length !== 3) throw new SmtSyntaxError(shape);
      const sorts = list(cmd[1], shape);
      const decls = list(cmd[2], shape);
      if (sorts.length === 0 || sorts.length !== decls.length) throw new SmtSyntaxError(shape);
      for (const s of sorts) {
        const dec = list(s, shape);
        if (dec.length !== 2) throw new SmtSyntaxError(shape);
        introduceName(dec[0], "sort", "a datatype", t);
      }
      for (const d of decls) checkDatatype(d, t);
      return;
    }
    default:
      // Unreachable: the command allowlist is checked first.
      throw new SmtSyntaxError(`\`${String(head)}\` is not allowed in the preamble`);
  }
}

/** `((c1) (c2 (sel Int)))` or `(par (T) ((c1) …))`. */
function checkDatatype(e: SExpr | undefined, t: NameTable): void {
  let ctors = list(e, "a datatype's constructors");
  if (ctors[0] === "par") {
    if (ctors.length !== 3) {
      throw new SmtSyntaxError("a parametric datatype is `(par (T …) (constructors…))`");
    }
    for (const p of list(ctors[1], "the datatype's sort parameters")) {
      checkName(p, "sort", "a sort parameter");
    }
    ctors = list(ctors[2], "a datatype's constructors");
  }
  if (ctors.length === 0) throw new SmtSyntaxError("a datatype needs at least one constructor");
  for (const c of ctors) {
    const ctor = list(c, "a constructor (written `(name selector…)`, e.g. `(red)`)");
    introduceName(ctor[0], "function", "a constructor", t);
    for (const sel of ctor.slice(1)) {
      const pair = list(sel, "a selector (written `(name Sort)`)");
      if (pair.length !== 2) throw new SmtSyntaxError("a selector is written `(name Sort)`");
      introduceName(pair[0], "function", "a selector", t);
    }
  }
}

/**
 * Every name a term binds — `let`, `forall`, `exists`, `lambda`, `match`
 * patterns — and every `:named` label, which Z3 makes a global constant.
 */
function walkTerm(e: SExpr, t: NameTable): void {
  if (typeof e === "string") return;
  const head = e[0];
  switch (head) {
    case "let": {
      for (const b of list(e[1], "`let` bindings")) {
        const pair = list(b, "a `let` binding");
        checkName(pair[0], "variable", "a `let` variable");
        if (pair[1] !== undefined) walkTerm(pair[1], t);
      }
      for (const rest of e.slice(2)) walkTerm(rest, t);
      return;
    }
    case "forall":
    case "exists":
    case "lambda":
      checkSortedVars(e[1], `the \`${head}\` variables`);
      for (const rest of e.slice(2)) walkTerm(rest, t);
      return;
    case "match": {
      if (e[1] !== undefined) walkTerm(e[1], t);
      for (const c of list(e[2], "`match` cases")) {
        const kase = list(c, "a `match` case");
        const pattern = kase[0];
        const symbols = typeof pattern === "string" ? [pattern] : (pattern ?? []);
        for (const s of symbols) checkName(s, "variable", "a `match` pattern");
        for (const rest of kase.slice(1)) walkTerm(rest, t);
      }
      return;
    }
    case "!": {
      if (e[1] !== undefined) walkTerm(e[1], t);
      for (let i = 2; i < e.length; i++) {
        const attr = e[i];
        if (attr === ":named") {
          introduceName(e[i + 1], "function", "a `:named` label", t);
          i += 1;
        } else if (attr !== undefined && typeof attr !== "string") {
          walkTerm(attr, t);
        }
      }
      return;
    }
    default:
      for (const child of e) walkTerm(child, t);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type SmtAnswer = "sat" | "unsat" | "unknown";

export type SmtOutcome = {
  /** Answers to the two `check-sat`s, in order (fewer when Z3 stopped early). */
  readonly answers: readonly SmtAnswer[];
  /** `(error "…")` lines that came before the second answer (the get-model error after `unsat` is expected and dropped). */
  readonly errors: readonly string[];
  /** Z3's model after a `sat` second answer, as `name = value` pairs. */
  readonly model?: string;
};

const ANSWERS = new Set(["sat", "unsat", "unknown"]);

/**
 * Read Z3's stdout. Line-based: Z3 prints each `check-sat` answer and each
 * `(error "…")` on its own line, in script order, so which command an error
 * belongs to follows from where it falls between the answers.
 */
export function parseSmtOutput(stdout: string): SmtOutcome {
  const answers: SmtAnswer[] = [];
  const errors: string[] = [];
  const after: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (answers.length < 2 && ANSWERS.has(line)) {
      answers.push(line as SmtAnswer);
      continue;
    }
    if (line.startsWith("(error")) {
      if (answers.length < 2) errors.push(readError(line));
      continue;
    }
    if (answers.length >= 2) after.push(raw);
  }
  const model = answers[1] === "sat" ? formatModel(after.join("\n")) : undefined;
  return { answers, errors, ...(model !== undefined && model !== "" ? { model } : {}) };
}

function readError(line: string): string {
  const m = /^\(error\s+"([\s\S]*)"\s*\)$/.exec(line);
  return clipLine(m?.[1] ?? line, 300);
}

/**
 * `((define-fun x () Int 4) …)` → `x = 4, y = -1`; the raw text when it does
 * not parse; empty when it parses but defines nothing (a goal with no free
 * constants has an empty model).
 */
export function formatModel(text: string): string {
  let parsed: SExpr[];
  try {
    parsed = parseSExprs(text, false);
  } catch {
    return clipLine(text, 1_000);
  }
  const defs: string[] = [];
  const visit = (e: SExpr): void => {
    if (typeof e === "string") return;
    if (e[0] === "define-fun" && e.length === 5 && typeof e[1] === "string") {
      const args = e[2] as SExpr;
      const params =
        typeof args !== "string" && args.length > 0
          ? `(${args.map((a) => (typeof a === "string" ? a : String(a[0]))).join(", ")})`
          : "";
      defs.push(`${e[1]}${params} = ${renderValue(e[4] as SExpr)}`);
      return;
    }
    for (const child of e) visit(child);
  };
  for (const e of parsed) visit(e);
  return clipLine(defs.join(", "), 1_000);
}

function renderValue(e: SExpr): string {
  if (typeof e === "string") return e;
  // Z3 prints negative numbers as `(- 3)` and fractions as `(/ 1 2)`.
  if (e.length === 2 && e[0] === "-" && typeof e[1] === "string") return `-${e[1]}`;
  if (e.length === 3 && e[0] === "/" && typeof e[1] === "string" && typeof e[2] === "string") {
    return `${e[1]}/${e[2]}`;
  }
  return printSExpr(e);
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

export type SmtCheckerOptions = SandboxCheckerOptions;

/** The `smt` checker: Z3 in the given sandbox. */
export function createSmtChecker(opts: SmtCheckerOptions): SandboxProofChecker {
  const image = opts.image ?? Z3_IMAGE_REF;
  const available = createAvailabilityProbe({
    id: SMT_CHECKER_ID,
    image,
    healthcheck: Z3_HEALTHCHECK_ARGV,
    opts,
  });
  return {
    id: SMT_CHECKER_ID,
    language: SMT_LANGUAGE,
    image,
    available,
    async check(input: CheckInput): Promise<CheckResult> {
      const started = performance.now();
      const done = (r: Omit<CheckResult, "checker" | "durationMs">): CheckResult => ({
        ...r,
        checker: SMT_CHECKER_ID,
        durationMs: Math.round(performance.now() - started),
      });
      const refusal = noopRefusal(SMT_CHECKER_ID, opts.sandbox, opts.allowNoop === true);
      if (refusal !== undefined) {
        return done({ ok: false, assumptions: [], axioms: [], output: "", reason: refusal });
      }
      if (typeof input.statement !== "string" || typeof input.proof !== "string") {
        return done({
          ok: false,
          assumptions: [],
          axioms: [],
          output: "",
          reason: "the statement and the proof must be text",
        });
      }
      const timeoutMs = budgetMs(input.timeoutMs, opts.timeoutMs, DEFAULT_SANDBOX_TIMEOUT_MS);
      // Two solver calls share the budget, and the container start needs some of it.
      const solverMs = Math.max(1_000, Math.floor(timeoutMs / 3));
      let problem: SmtProblem;
      try {
        problem = buildSmtScript(input.statement, input.proof, solverMs);
      } catch (err) {
        return done({
          ok: false,
          assumptions: [],
          axioms: [],
          output: "",
          reason: errorMessage(err),
        });
      }
      const { assumptions } = problem;
      let result: Awaited<ReturnType<SandboxCheckerOptions["sandbox"]["exec"]>>;
      try {
        result = await opts.sandbox.exec({
          image,
          argv: ["z3", "-in"],
          stdin: problem.script,
          timeoutMs,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (err) {
        return done({
          ok: false,
          assumptions,
          axioms: [],
          output: "",
          reason: `the sandbox could not run z3: ${clipLine(errorMessage(err), 300)}`,
        });
      }
      const output = clipOutput(
        result.stderr.trim() !== ""
          ? `${result.stdout}\n[stderr]\n${result.stderr}`
          : result.stdout,
      );
      const reject = (reason: string, counterexample?: string): CheckResult =>
        done({
          ok: false,
          assumptions,
          axioms: [],
          output,
          reason,
          ...(counterexample !== undefined ? { counterexample } : {}),
        });
      if (input.signal?.aborted === true) return reject("the check was cancelled");
      if (result.timedOut === true) {
        return reject(`z3 did not finish within ${timeoutMs} ms`);
      }
      const outcome = parseSmtOutput(result.stdout);
      const [first, second] = outcome.answers;
      if (first === undefined) {
        const why = outcome.errors[0] ?? clipLine(result.stderr || result.stdout, 300);
        return reject(`z3 gave no answer (exit ${result.exitCode})${why !== "" ? `: ${why}` : ""}`);
      }
      if (outcome.errors.length > 0) {
        return reject(`z3 reported an error: ${outcome.errors[0]}`);
      }
      if (first === "unsat") {
        return reject("the hypotheses are inconsistent; anything follows from them");
      }
      if (first === "unknown") {
        return reject(
          "z3 could not decide whether the hypotheses are consistent (unknown — a timeout or an undecidable fragment)",
        );
      }
      if (second === undefined) {
        return reject(`z3 stopped before checking the goal (exit ${result.exitCode})`);
      }
      if (second === "unsat") {
        return done({ ok: true, assumptions, axioms: [], output });
      }
      if (second === "sat") {
        const model = outcome.model ?? "z3 found the negated goal satisfiable but showed no values";
        return reject(`the goal does not follow: z3 found a counterexample (${model})`, model);
      }
      return reject(
        "z3 could not decide the goal (unknown — a timeout or an undecidable fragment); simplify the problem or split it",
      );
    },
  };
}

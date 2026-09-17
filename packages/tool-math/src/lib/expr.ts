/**
 * A safe arithmetic expression evaluator: a hand-written tokenizer and a
 * precedence-climbing parser that evaluates as it parses.
 *
 * NEVER `eval()` and NEVER `new Function()`. Both would hand a caller-supplied
 * string the full power of the host runtime, which is exactly the thing a
 * "calculator" tool must not do. Everything below is a literal grammar, and
 * anything outside that grammar is refused with the offending position.
 *
 * The supported grammar, in full — there is nothing else:
 *
 *   expr    := term (("+" | "-") term)*
 *   term    := power (("*" | "/" | "%") power)*
 *   power   := unary ("^" power)?            // right-associative
 *   unary   := ("+" | "-")* primary'         // binds looser than "^"
 *   primary := number | name | name "(" args ")" | "(" expr ")"
 *   number  := digits ["." digits] [("e"|"E") ["+"|"-"] digits]
 *   name    := [A-Za-z_][A-Za-z0-9_]*
 *
 * Precedence, loosest first: `+ -` < `* / %` < unary `-` < `^`. So `-2^2`
 * is `-(2^2)` = -4, matching mathematical notation (and Python), NOT
 * spreadsheet notation, where Excel gives 4. That divergence is documented on
 * the tool because a caller checking against a spreadsheet will hit it.
 *
 * Other deliberate decisions:
 *   - `%` is the REMAINDER, with the sign of the dividend (`-7 % 3` = -1),
 *     which is JavaScript's and C's rule, not Python's modulo.
 *   - `log` is base 10 and `ln` is natural. Ambiguity here is a classic
 *     silent-wrongness bug, so both names exist and neither is a synonym.
 *   - Trigonometric functions take RADIANS.
 *   - Any step that produces NaN or Infinity is refused, so a caller never
 *     receives a confidently wrong finite-looking answer. Division by zero,
 *     `sqrt(-1)` and overflow all stop the evaluation.
 *   - Numeric literals are decimal only. `0x10`, `1_000` and `1,000` are
 *     refused rather than silently reinterpreted.
 */

/** A refusal with the character offset that caused it. */
export class ExprError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "ExprError";
    this.position = position;
  }
}

/** Caps. They bound the work and the recursion, not just the output. */
export const EXPR_MAX_LENGTH = 4_000;
export const EXPR_MAX_TOKENS = 2_000;
export const EXPR_MAX_DEPTH = 64;

/** Constants available unless the caller shadows the name with a variable. */
export const EXPR_CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  pi: Math.PI,
  e: Math.E,
});

type FnSpec = { minArgs: number; maxArgs: number; apply: (args: number[]) => number };

/** The entire function set. A name not in this table is refused. */
const FUNCTIONS: Readonly<Record<string, FnSpec>> = Object.freeze({
  abs: { minArgs: 1, maxArgs: 1, apply: (a) => Math.abs(num(a, 0)) },
  min: { minArgs: 1, maxArgs: 64, apply: (a) => Math.min(...a) },
  max: { minArgs: 1, maxArgs: 64, apply: (a) => Math.max(...a) },
  // Half-away-from-zero, so round(-0.5) is -1 and not JavaScript's -0.
  round: { minArgs: 1, maxArgs: 1, apply: (a) => halfAwayFromZero(num(a, 0)) },
  floor: { minArgs: 1, maxArgs: 1, apply: (a) => Math.floor(num(a, 0)) },
  ceil: { minArgs: 1, maxArgs: 1, apply: (a) => Math.ceil(num(a, 0)) },
  sqrt: { minArgs: 1, maxArgs: 1, apply: (a) => Math.sqrt(num(a, 0)) },
  pow: { minArgs: 2, maxArgs: 2, apply: (a) => num(a, 0) ** num(a, 1) },
  log: { minArgs: 1, maxArgs: 1, apply: (a) => Math.log10(num(a, 0)) },
  ln: { minArgs: 1, maxArgs: 1, apply: (a) => Math.log(num(a, 0)) },
  exp: { minArgs: 1, maxArgs: 1, apply: (a) => Math.exp(num(a, 0)) },
  sin: { minArgs: 1, maxArgs: 1, apply: (a) => Math.sin(num(a, 0)) },
  cos: { minArgs: 1, maxArgs: 1, apply: (a) => Math.cos(num(a, 0)) },
  tan: { minArgs: 1, maxArgs: 1, apply: (a) => Math.tan(num(a, 0)) },
});

/** The function names, sorted, for error messages and documentation. */
export const EXPR_FUNCTIONS: ReadonlyArray<string> = Object.freeze(Object.keys(FUNCTIONS).sort());

function num(args: number[], i: number): number {
  return args[i] as number;
}

function halfAwayFromZero(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

// --- tokenizer -------------------------------------------------------------

type Token =
  | { kind: "num"; pos: number; value: number }
  | { kind: "name"; pos: number; text: string }
  | { kind: "op"; pos: number; text: string }
  | { kind: "("; pos: number }
  | { kind: ")"; pos: number }
  | { kind: ","; pos: number }
  | { kind: "end"; pos: number };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isNameStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isNamePart(c: string): boolean {
  return isNameStart(c) || isDigit(c);
}

export function tokenizeExpression(src: string): Token[] {
  if (src.length > EXPR_MAX_LENGTH) {
    throw new ExprError(
      `expression is ${src.length} characters, over the ${EXPR_MAX_LENGTH} limit`,
      0,
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (tokens.length >= EXPR_MAX_TOKENS) {
      throw new ExprError(`expression has more than ${EXPR_MAX_TOKENS} tokens`, i);
    }
    if (isDigit(c) || (c === "." && isDigit(src.charAt(i + 1)))) {
      const start = i;
      if (c === "0" && /[xXoObB]/.test(src.charAt(i + 1))) {
        throw new ExprError(
          `only decimal numbers are supported, found "${src.slice(i, i + 2)}"`,
          i,
        );
      }
      while (isDigit(src.charAt(i))) i++;
      if (src.charAt(i) === ".") {
        i++;
        while (isDigit(src.charAt(i))) i++;
      }
      if (src.charAt(i) === "e" || src.charAt(i) === "E") {
        const mark = i;
        i++;
        if (src.charAt(i) === "+" || src.charAt(i) === "-") i++;
        if (!isDigit(src.charAt(i))) {
          // "2e" is not a number and "e" is a constant: back out of the exponent.
          i = mark;
        } else {
          while (isDigit(src.charAt(i))) i++;
        }
      }
      if (src.charAt(i) === "_") {
        throw new ExprError("digit separators (_) are not supported in numbers", i);
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExprError(`"${text}" is not a finite number`, start);
      }
      tokens.push({ kind: "num", pos: start, value });
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      while (isNamePart(src.charAt(i))) i++;
      tokens.push({ kind: "name", pos: start, text: src.slice(start, i) });
      continue;
    }
    if (OPERATORS.has(c)) {
      if (c === "*" && src.charAt(i + 1) === "*") {
        throw new ExprError('"**" is not an operator here; use "^" for exponentiation', i);
      }
      tokens.push({ kind: "op", pos: i, text: c });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "(", pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: ")", pos: i });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ kind: ",", pos: i });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character "${c}"`, i);
  }
  tokens.push({ kind: "end", pos: src.length });
  return tokens;
}

// --- parser / evaluator ----------------------------------------------------

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  "+": 10,
  "-": 10,
  "*": 20,
  "/": 20,
  "%": 20,
  "^": 30,
});
const UNARY_PRECEDENCE = 25;

export type EvaluateOptions = {
  /** Named values the expression may reference. Shadow `pi`/`e` deliberately. */
  variables: Readonly<Record<string, number>>;
};

export type EvaluateResult = {
  value: number;
  /** Variable and constant names the expression actually read, sorted. */
  usedNames: string[];
  /** Function names the expression actually called, sorted. */
  usedFunctions: string[];
};

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private depth = 0;
  private readonly variables: Readonly<Record<string, number>>;
  readonly names = new Set<string>();
  readonly functions = new Set<string>();

  constructor(tokens: Token[], variables: Readonly<Record<string, number>>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const t = this.peek();
    this.index++;
    return t;
  }

  private enter(pos: number): void {
    this.depth++;
    if (this.depth > EXPR_MAX_DEPTH) {
      throw new ExprError(`expression nests deeper than ${EXPR_MAX_DEPTH} levels`, pos);
    }
  }

  private leave(): void {
    this.depth--;
  }

  parse(): number {
    const value = this.parseExpression(0);
    const tail = this.peek();
    if (tail.kind !== "end") {
      throw new ExprError(`unexpected ${describe(tail)} after a complete expression`, tail.pos);
    }
    return value;
  }

  parseExpression(minPrecedence: number): number {
    const start = this.peek();
    this.enter(start.pos);
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== "op") break;
      const precedence = BINARY_PRECEDENCE[tok.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      // "^" is right-associative, so its right operand may re-enter at the
      // same precedence; everything else steps up to stay left-associative.
      const nextMin = tok.text === "^" ? precedence : precedence + 1;
      const right = this.parseExpression(nextMin);
      left = this.applyBinary(tok.text, left, right, tok.pos);
    }
    this.leave();
    return left;
  }

  private parseUnary(): number {
    const tok = this.peek();
    if (tok.kind === "op" && (tok.text === "-" || tok.text === "+")) {
      this.next();
      this.enter(tok.pos);
      const operand = this.parseExpression(UNARY_PRECEDENCE);
      this.leave();
      return tok.text === "-" ? -operand : operand;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.next();
    if (tok.kind === "num") return tok.value;
    if (tok.kind === "(") {
      this.enter(tok.pos);
      const value = this.parseExpression(0);
      this.leave();
      const close = this.next();
      if (close.kind !== ")") {
        throw new ExprError(`expected ")" but found ${describe(close)}`, close.pos);
      }
      return value;
    }
    if (tok.kind === "name") {
      if (this.peek().kind === "(") return this.parseCall(tok.text, tok.pos);
      return this.lookup(tok.text, tok.pos);
    }
    throw new ExprError(`expected a number, name or "(" but found ${describe(tok)}`, tok.pos);
  }

  private parseCall(name: string, pos: number): number {
    const spec = FUNCTIONS[name];
    if (spec === undefined) {
      throw new ExprError(
        `unknown function "${name}"; supported: ${EXPR_FUNCTIONS.join(", ")}`,
        pos,
      );
    }
    this.next(); // "("
    this.enter(pos);
    const args: number[] = [];
    if (this.peek().kind === ")") {
      this.next();
    } else {
      for (;;) {
        args.push(this.parseExpression(0));
        const sep = this.next();
        if (sep.kind === ")") break;
        if (sep.kind !== ",") {
          throw new ExprError(`expected "," or ")" but found ${describe(sep)}`, sep.pos);
        }
        if (args.length > spec.maxArgs) {
          throw new ExprError(`${name}() takes at most ${spec.maxArgs} arguments`, sep.pos);
        }
      }
    }
    this.leave();
    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      const want =
        spec.minArgs === spec.maxArgs ? `${spec.minArgs}` : `${spec.minArgs} to ${spec.maxArgs}`;
      throw new ExprError(`${name}() takes ${want} argument(s) but got ${args.length}`, pos);
    }
    this.functions.add(name);
    const value = spec.apply(args);
    if (!Number.isFinite(value)) {
      throw new ExprError(
        `${name}(${args.join(", ")}) is not a finite number — refusing rather than returning ${value}`,
        pos,
      );
    }
    return value;
  }

  private lookup(name: string, pos: number): number {
    const provided = Object.hasOwn(this.variables, name) ? this.variables[name] : undefined;
    const value = provided ?? EXPR_CONSTANTS[name];
    if (value === undefined) {
      const known = [...Object.keys(this.variables), ...Object.keys(EXPR_CONSTANTS)].sort();
      const suffix = known.length > 0 ? `; known names: ${known.join(", ")}` : "";
      if (FUNCTIONS[name] !== undefined) {
        throw new ExprError(`"${name}" is a function — call it as ${name}(...)`, pos);
      }
      throw new ExprError(`unknown name "${name}"${suffix}`, pos);
    }
    if (!Number.isFinite(value)) {
      throw new ExprError(`variable "${name}" is not a finite number`, pos);
    }
    this.names.add(name);
    return value;
  }

  private applyBinary(op: string, left: number, right: number, pos: number): number {
    let value: number;
    switch (op) {
      case "+":
        value = left + right;
        break;
      case "-":
        value = left - right;
        break;
      case "*":
        value = left * right;
        break;
      case "/":
        if (right === 0) throw new ExprError("division by zero", pos);
        value = left / right;
        break;
      case "%":
        if (right === 0) throw new ExprError("remainder by zero", pos);
        value = left % right;
        break;
      case "^":
        value = left ** right;
        break;
      default:
        throw new ExprError(`unknown operator "${op}"`, pos);
    }
    if (!Number.isFinite(value)) {
      throw new ExprError(
        `${left} ${op} ${right} is not a finite number — refusing rather than returning ${value}`,
        pos,
      );
    }
    return value;
  }
}

function describe(tok: Token): string {
  switch (tok.kind) {
    case "num":
      return `number ${tok.value}`;
    case "name":
      return `name "${tok.text}"`;
    case "op":
      return `operator "${tok.text}"`;
    case "end":
      return "the end of the expression";
    default:
      return `"${tok.kind}"`;
  }
}

/** Parse and evaluate `source`. Throws `ExprError` for anything off-grammar. */
export function evaluateExpression(source: string, options: EvaluateOptions): EvaluateResult {
  const trimmed = source.trim();
  if (trimmed.length === 0) throw new ExprError("the expression is empty", 0);
  for (const [name, value] of Object.entries(options.variables)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ExprError(`variable "${name}" must be a finite number`, 0);
    }
  }
  const parser = new Parser(tokenizeExpression(source), options.variables);
  const value = parser.parse();
  return {
    value,
    usedNames: [...parser.names].sort(),
    usedFunctions: [...parser.functions].sort(),
  };
}

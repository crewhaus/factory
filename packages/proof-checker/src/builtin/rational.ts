/**
 * Exact rationals over bigint — the builtin checker's only number type
 * (design §6.4: "exact bigint rationals"). A float would make `0.1 + 0.2 = 0.3`
 * false and a certificate's verdict depend on rounding; here every value is a
 * reduced fraction `n/d` with `d > 0`, so equality is structural and every
 * comparison is exact.
 *
 * Sizes are capped ({@link RAT_MAX_BITS}): a statement like `10^10^10` is
 * refused with a reason instead of exhausting memory.
 */
import { CheckFailure } from "./budget";

export type Rat = { readonly n: bigint; readonly d: bigint };

/** Largest numerator or denominator, in bits. */
export const RAT_MAX_BITS = 8192;
const LIMIT = 1n << BigInt(RAT_MAX_BITS);
/** Exponents larger than this are refused before any multiplication. */
const MAX_EXPONENT = 1_000_000n;

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = absBig(a);
  let y = absBig(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** The reduced fraction `n/d`. Division by zero is an error, never a value. */
export function rat(n: bigint, d = 1n): Rat {
  if (d === 0n) throw new CheckFailure("division by zero");
  let num = n;
  let den = d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  if (g > 1n) {
    num /= g;
    den /= g;
  }
  if (absBig(num) >= LIMIT || den >= LIMIT) {
    throw new CheckFailure(`a number grows past ${RAT_MAX_BITS} bits`);
  }
  return { n: num, d: den };
}

export const ZERO: Rat = { n: 0n, d: 1n };
export const ONE: Rat = { n: 1n, d: 1n };

/** `123` or `10.50` → an exact rational. The lexer only passes digit strings. */
export function parseDecimal(text: string): Rat {
  const dot = text.indexOf(".");
  if (dot < 0) return rat(BigInt(text));
  const whole = text.slice(0, dot);
  const frac = text.slice(dot + 1);
  return rat(BigInt(whole + frac), 10n ** BigInt(frac.length));
}

export const add = (a: Rat, b: Rat): Rat => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rat, b: Rat): Rat => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d);
export const neg = (a: Rat): Rat => ({ n: -a.n, d: a.d });
export const absRat = (a: Rat): Rat => (a.n < 0n ? neg(a) : a);

export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new CheckFailure("division by zero");
  return rat(a.n * b.d, a.d * b.n);
}

/** -1, 0 or 1. */
export function cmp(a: Rat, b: Rat): number {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
}

export const eq = (a: Rat, b: Rat): boolean => a.n === b.n && a.d === b.d;
export const isInteger = (a: Rat): boolean => a.d === 1n;

function bitLength(x: bigint): number {
  return x === 0n ? 0 : absBig(x).toString(2).length;
}

/** `a^k` for a non-negative integer `k`; the size is checked before computing. */
export function pow(a: Rat, k: Rat): Rat {
  if (!isInteger(k) || k.n < 0n) {
    throw new CheckFailure("an exponent must be a non-negative integer");
  }
  const e = k.n;
  if (e === 0n) return ONE;
  // 0, 1 and -1 never grow, whatever the exponent.
  if (a.d === 1n && absBig(a.n) <= 1n) {
    return a.n === -1n && e % 2n === 0n ? ONE : a;
  }
  if (e > MAX_EXPONENT) throw new CheckFailure(`the exponent ${e} is too large`);
  // x^e has at least (bits(x) - 1)·e + 1 bits, so a lower bound past the cap
  // is refused before multiplying; one under it costs at most twice the cap
  // (bits(x)·e), and rat() checks the real size afterwards.
  const atLeast = (Math.max(bitLength(a.n), bitLength(a.d)) - 1) * Number(e) + 1;
  if (atLeast > RAT_MAX_BITS) {
    throw new CheckFailure(`a power grows past ${RAT_MAX_BITS} bits`);
  }
  return rat(a.n ** e, a.d ** e);
}

/**
 * Display form: an integer, an exact decimal when the denominator has only
 * the factors 2 and 5 (`21/2` → `10.5`), otherwise `n/d`.
 */
export function ratToString(a: Rat): string {
  if (a.d === 1n) return a.n.toString();
  let d = a.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos += 1;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives += 1;
  }
  if (d !== 1n) return `${a.n}/${a.d}`;
  const scale = Math.max(twos, fives);
  const scaled = absBig(a.n) * (10n ** BigInt(scale) / a.d);
  const digits = scaled.toString().padStart(scale + 1, "0");
  const text = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return a.n < 0n ? `-${text}` : text;
}

/** True when {@link ratToString} prints a literal the lexer reads back unchanged. */
export function isDecimal(a: Rat): boolean {
  return !ratToString(a).includes("/");
}

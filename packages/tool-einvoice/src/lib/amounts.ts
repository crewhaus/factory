/**
 * Money arithmetic for the fixed-format files in this package.
 *
 * Every amount that crosses this package's boundary is an integer number of
 * minor units, which is the convention `@crewhaus/tool-money` established and
 * the reason its README says what it says: floating point produces totals
 * that do not add up, and "off by a cent" on a payment file is not a rounding
 * detail, it is a file the bank rejects or a remittance that never reconciles.
 *
 * Internally the sums are `bigint`. A NACHA file control record carries a
 * 12-digit cent total, which is 10^12 — inside `Number.MAX_SAFE_INTEGER`, but
 * only just, and the entry hash is a running sum with no such bound. Doing it
 * in `bigint` means the arithmetic is exact at every size rather than exact
 * until someone builds a big enough file.
 *
 * Nothing here reads a clock, a network or a file. It is arithmetic.
 */

/** Raised for a caller mistake in an amount or a decimal string. */
export class AmountError extends Error {
  override readonly name = "AmountError";
}

/**
 * ISO 4217 minor-unit exponents that are NOT 2.
 *
 * `@crewhaus/tool-math` owns the full currency table and exports it, but it is
 * not a declared dependency of this package and the maintainer's standing rule
 * is that a tool package does not grow new dependency edges to get at a
 * constant. The exceptions are a closed list — everything absent here is 2 —
 * so carrying them costs less than the edge would.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
});

/** How many minor units make a major one, for `code`. Unknown codes get 2. */
export function minorUnitExponent(code: string): number {
  return MINOR_UNIT_EXPONENTS[code.toUpperCase()] ?? 2;
}

/**
 * Render minor units as the decimal string a document carries.
 *
 * `1234` with exponent 2 is `"12.34"`; with exponent 0 it is `"1234"`. The
 * sign goes in front of the whole thing, not in front of the integer part,
 * because `-0.05` formatted from the parts alone comes out as `-0.05` only if
 * you remember that `-5 / 100` truncates to `0`.
 */
export function formatMinor(minor: bigint, exponent: number): string {
  if (exponent === 0) return minor.toString();
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** A decimal string as an exact rational: `unscaled / 10^scale`. */
export type Decimal = { readonly unscaled: bigint; readonly scale: number };

const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Parse a decimal STRING. A `number` is deliberately not accepted: `0.1` and
 * `1e21` both reach this function having already lost the property that makes
 * the answer checkable, and there is no way to tell from inside which one is
 * which.
 */
export function parseDecimal(text: string, label: string): Decimal {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new AmountError(
      `${label} ("${text}") is not a plain decimal — write it as digits with at most one point, e.g. "2.5"; exponent notation is refused because it is where precision goes missing`,
    );
  }
  if (trimmed.length > 40) {
    throw new AmountError(`${label} ("${text}") has more digits than any quantity needs`);
  }
  const dot = trimmed.indexOf(".");
  if (dot < 0) return { unscaled: BigInt(trimmed), scale: 0 };
  const scale = trimmed.length - dot - 1;
  return { unscaled: BigInt(trimmed.slice(0, dot) + trimmed.slice(dot + 1)), scale };
}

/** 10^n as a bigint. */
export function pow10(n: number): bigint {
  if (n < 0) throw new AmountError(`negative exponent ${n}`);
  return 10n ** BigInt(n);
}

/**
 * `numerator / denominator`, rounded half-up AWAY FROM ZERO.
 *
 * Half-up is what EN 16931's BR-CO-17 means by "rounded" and what every ACH
 * and SEPA total in this package uses, so it is the only mode here: offering a
 * choice would let two callers produce two different files from one invoice,
 * and the whole point of these formats is that the bytes are determined.
 *
 * Away from zero rather than towards positive infinity, so a credit note's
 * -0.005 rounds to -0.01 and its mirror invoice's +0.005 rounds to +0.01 —
 * a credit note that does not exactly reverse its invoice is a reconciliation
 * break that surfaces a year later.
 */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new AmountError("division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Exact sum. Named so the call site reads as the thing being proved. */
export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/**
 * `minor` scaled by the rational `factor`, rounded half-up.
 *
 * Used for quantity x unit price and for taxable amount x VAT rate. The
 * multiply happens before the divide, so `3 x (1/3)` is 1 rather than 0.
 */
export function multiplyByDecimal(minor: bigint, factor: Decimal): bigint {
  return divideHalfUp(minor * factor.unscaled, pow10(factor.scale));
}

/**
 * `minor * numerator / denominator`, rounded half-up, with both operands
 * decimal strings. This is the line-amount rule: quantity divided by base
 * quantity, times the net price.
 */
export function scaleByRatio(minor: bigint, numerator: Decimal, denominator: Decimal): bigint {
  const n = numerator.unscaled * pow10(denominator.scale);
  const d = denominator.unscaled * pow10(numerator.scale);
  if (d === 0n) throw new AmountError("base quantity is zero");
  return divideHalfUp(minor * n, d);
}

/**
 * A non-negative integer as a zero-padded fixed-width digit string, or an
 * error.
 *
 * This refuses rather than truncating, and that asymmetry is the whole point
 * of the function. A truncated NAME on a payment file is a cosmetic defect;
 * a truncated AMOUNT is a different payment, and the bank has no way to know
 * it was not the one you meant. Every numeric field in this package goes
 * through here.
 */
export function digits(value: bigint, width: number, field: string): string {
  if (value < 0n) {
    throw new AmountError(`${field} is negative (${value}); this field has no sign column`);
  }
  const text = value.toString();
  if (text.length > width) {
    throw new AmountError(
      `${field} needs ${text.length} digits (${text}) but the field is ${width} wide — refusing rather than truncating, because a truncated amount is a different payment the bank cannot tell from the one you meant`,
    );
  }
  return text.padStart(width, "0");
}

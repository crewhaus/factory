/**
 * Exact integer money in a language whose numbers are doubles.
 *
 * A double holds every integer up to 2^53 − 1 (9,007,199,254,740,991) and
 * then starts skipping them. An amount past that arrives already rounded, and
 * a sum or a product that crosses it rounds without saying so: [2^53 − 1, 2]
 * totalled 9,007,199,254,740,992, and a tax of 19.99% on 1,595,908,809,793,069
 * came out a unit high because the product `amount × bps` was past the line
 * even though the amount and the answer were not.
 *
 * So the arithmetic is done in `bigint`, where it is exact, and a figure goes
 * back into a JSON number only when it fits. One that does not is refused,
 * by name — a tool whose whole job is the exact figure does not hand back an
 * approximate one.
 */

/** Why a figure was refused rather than reported. */
export class InexactAmountError extends Error {
  override readonly name = "InexactAmountError";
}

const LIMIT_TEXT = "2^53 − 1 (9007199254740991)";

/** An input amount, as a bigint. It must be a safe integer: past that it arrived rounded. */
export function big(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new InexactAmountError(
      `${what} (${value}) is not an integer within ±${LIMIT_TEXT}, the largest amount this computes exactly — express it in a larger unit`,
    );
  }
  return BigInt(value);
}

/** A result, back as a JSON number — or a refusal when it does not fit exactly. */
export function toNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new InexactAmountError(
      `${what} comes to ${value}, past ±${LIMIT_TEXT}, so it cannot be reported exactly as a number — express the amounts in a larger unit`,
    );
  }
  return Number(value);
}

/** The exact sum of integer amounts. */
export function sumExact(values: Iterable<number>, what: string): number {
  let total = 0n;
  for (const value of values) total += big(value, what);
  return toNumber(total, what);
}

/** `a` combined with `b` exactly, for a sum or difference of two amounts. */
export function addExact(a: number, b: number, what: string): number {
  return toNumber(big(a, what) + big(b, what), what);
}

/** Floor division (bigint division truncates toward zero; this rounds toward −∞). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/**
 * `num / den` rounded the way `Math.round` rounds — to the nearest integer,
 * a half toward +∞ — but exactly, however large the operands.
 */
export function mathRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("denominator must not be zero");
  const [n, d] = den < 0n ? [-num, -den] : [num, den];
  return floorDiv(2n * n + d, 2n * d);
}

/**
 * A quantity as the decimal it is written as: `units / 10^scale`, exactly.
 *
 * Quantities (kilograms, hours, 0.37 of a coin) are decimals, and a double
 * cannot hold most of them: 2.3 × 1001 is 2302.2999999999997 in binary. So a
 * quantity is read as the SHORTEST text that reads back as the same double —
 * which is the decimal the caller wrote (0.1, 1e-7, 10000000000) — and
 * counted as a bigint on a decimal scale, where sums, differences and
 * products with an integer price are exact however many digits they carry.
 */
export type Decimal = { readonly units: bigint; readonly scale: number };

export function decimalOf(value: number, what: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (match === null) throw new InexactAmountError(`${what} (${value}) is not a finite decimal`);
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`;
  let scale = fraction.length - Number(match[4] ?? 0);
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  const units = BigInt(digits);
  return { units: match[1] === "-" ? -units : units, scale };
}

/** `d`'s units on a finer (or equal) `scale`. */
export function atScale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

/** The exact sum (or, with `sign` −1, difference) of two decimals. */
export function addDecimal(a: Decimal, b: Decimal, sign: 1n | -1n = 1n): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: atScale(a, scale) + sign * atScale(b, scale), scale };
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = atScale(a, scale);
  const right = atScale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A decimal back as a JSON number — or a refusal when no double is exactly
 * it. A quantity is reported as a number, and one that would come back as a
 * different decimal (1234567890123457 − 0.1) is refused by name rather than
 * reported off by what the double could not hold.
 */
export function decimalNumber(d: Decimal, what: string): number {
  const negative = d.units < 0n;
  const magnitude = (negative ? -d.units : d.units).toString();
  const text =
    d.scale === 0
      ? magnitude
      : `${magnitude.padStart(d.scale + 1, "0").slice(0, -d.scale)}.${magnitude
          .padStart(d.scale + 1, "0")
          .slice(-d.scale)}`;
  const value = Number(`${negative ? "-" : ""}${text}`);
  if (!Number.isFinite(value) || compareDecimal(decimalOf(value, what), d) !== 0) {
    throw new InexactAmountError(
      `${what} comes to ${negative ? "-" : ""}${text}, which a JSON number cannot hold exactly — express the quantities in a coarser unit`,
    );
  }
  return value === 0 ? 0 : value;
}

/**
 * `num / den` rounded to whole minor units: to the nearest, a half away from
 * zero, exactly. A fractional quantity times an integer price is a fraction
 * of a minor unit; this is how it becomes a whole one.
 */
export function roundHalfAwayFromZero(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("denominator must not be zero");
  const [n, d] = den < 0n ? [-num, -den] : [num, den];
  const magnitude = (2n * (n < 0n ? -n : n) + d) / (2n * d);
  return n < 0n ? -magnitude : magnitude;
}

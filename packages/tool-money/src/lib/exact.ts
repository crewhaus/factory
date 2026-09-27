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
 * A fractional money figure — a fractional quantity times an integer price —
 * rounded to whole minor units: to the nearest, a half away from zero. The
 * binary floating-point noise below fifteen significant digits is discarded
 * first, so 2.3 × 1001 is 2302.3 (and rounds to 2302) rather than
 * 2302.2999999999997, and a true half is not read as just under one.
 */
export function roundFractionalMinor(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new InexactAmountError(`${what} is not a finite amount`);
  const clean = Number(value.toPrecision(15));
  const rounded = Math.sign(clean) * Math.round(Math.abs(clean));
  if (!Number.isSafeInteger(rounded)) {
    throw new InexactAmountError(
      `${what} comes to about ${clean}, past ±${LIMIT_TEXT}, so it cannot be reported exactly as a number`,
    );
  }
  return rounded === 0 ? 0 : rounded;
}

/** A difference of two decimal quantities without the binary noise (0.3 − 0.1 is 0.2). */
export function quantityDifference(a: number, b: number): number {
  const diff = Number((a - b).toPrecision(15));
  return diff === 0 ? 0 : diff;
}

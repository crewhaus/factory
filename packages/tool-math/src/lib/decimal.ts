/**
 * Exact decimal arithmetic on bigints, and every rounding mode the money and
 * rounding tools need.
 *
 * A decimal here is an unscaled signed integer plus a scale: 12.34 is
 * `{ unscaled: 1234n, scale: 2 }`. No binary floating point is involved once
 * a value is parsed, so 0.1 + 0.2 is exactly 0.3 and a cent is never lost to
 * representation error.
 *
 * Parsing a JavaScript `number` goes through its shortest round-trip decimal
 * form — the digits `String(value)` prints, which is the unique shortest
 * decimal that maps back to that double. This is deliberate and is stated on
 * the tools: rounding 1.005 to two places with halfUp gives 1.01, because
 * "1.005" is what the caller wrote and what the runtime prints, even though
 * the stored double is a hair below. Callers who need the double's exact
 * binary value should pass a decimal STRING instead, which is never
 * reinterpreted.
 */

export const ROUNDING_MODES = [
  "halfUp",
  "halfEven",
  "halfDown",
  "ceiling",
  "floor",
  "up",
  "down",
] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

/** What each mode does, echoed in results so the convention is never implicit. */
export const ROUNDING_MODE_NOTES: Readonly<Record<RoundingMode, string>> = Object.freeze({
  halfUp: "ties away from zero (2.5 -> 3, -2.5 -> -3); the schoolbook rule",
  halfEven:
    "ties to the even neighbour (2.5 -> 2, 3.5 -> 4); banker's rounding, IEEE 754 default, what accounting standards expect",
  halfDown: "ties toward zero (2.5 -> 2, -2.5 -> -2)",
  ceiling: "toward +infinity (2.1 -> 3, -2.9 -> -2)",
  floor: "toward -infinity (2.9 -> 2, -2.1 -> -3)",
  up: "away from zero (2.1 -> 3, -2.1 -> -3)",
  down: "toward zero, i.e. truncation (2.9 -> 2, -2.9 -> -2)",
});

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalError";
  }
}

export type Decimal = { unscaled: bigint; scale: number };

/** Guard rails: a decimal with a million digits is a denial of service, not a price. */
export const MAX_DECIMAL_DIGITS = 1_000;
export const MAX_DECIMAL_SCALE = 100;

const TEN = 10n;

export function pow10(n: number): bigint {
  if (n < 0) throw new DecimalError(`pow10 needs a non-negative exponent, got ${n}`);
  return TEN ** BigInt(n);
}

/**
 * Integer division with an explicit rounding mode. `denominator` must be
 * positive; the sign lives in the numerator. This one function is the entire
 * rounding behaviour of the package — money, nearest-multiple and decimal
 * places all route through it, so there is one place to be right.
 */
export function divideRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new DecimalError("denominator must be positive");
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const q = absNumerator / denominator;
  const r = absNumerator - q * denominator;
  if (r === 0n) return negative ? -q : q;
  const twice = r * 2n;
  let bump: boolean;
  switch (mode) {
    case "down":
      bump = false;
      break;
    case "up":
      bump = true;
      break;
    case "ceiling":
      bump = !negative;
      break;
    case "floor":
      bump = negative;
      break;
    case "halfUp":
      bump = twice >= denominator;
      break;
    case "halfDown":
      bump = twice > denominator;
      break;
    case "halfEven":
      bump = twice > denominator || (twice === denominator && q % 2n !== 0n);
      break;
    default:
      throw new DecimalError(`unknown rounding mode "${mode as string}"`);
  }
  const magnitude = bump ? q + 1n : q;
  return negative ? -magnitude : magnitude;
}

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse a decimal string or a JavaScript number exactly. Refuses grouping
 * separators, currency symbols and anything else that is not plain decimal —
 * use `NumberParse` for a locale-formatted string first.
 */
export function parseDecimal(input: string | number): Decimal {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new DecimalError(`${input} is not a finite number`);
    text = String(input);
  } else {
    text = input.trim();
  }
  if (text.length === 0) throw new DecimalError("the value is empty");
  if (text.length > MAX_DECIMAL_DIGITS + 32) {
    throw new DecimalError(`the value has ${text.length} characters, over the supported length`);
  }
  if (!DECIMAL_PATTERN.test(text)) {
    throw new DecimalError(
      `"${text}" is not a plain decimal number (digits, an optional sign, an optional "." and an optional exponent)`,
    );
  }
  const negative = text.startsWith("-");
  let body = text.replace(/^[+-]/, "");
  let exponent = 0;
  const eIndex = body.search(/[eE]/);
  if (eIndex >= 0) {
    exponent = Number(body.slice(eIndex + 1));
    body = body.slice(0, eIndex);
    if (!Number.isFinite(exponent) || Math.abs(exponent) > 6_000) {
      throw new DecimalError(`exponent ${exponent} is out of the supported range`);
    }
  }
  const dot = body.indexOf(".");
  let digits: string;
  let scale: number;
  if (dot >= 0) {
    digits = body.slice(0, dot) + body.slice(dot + 1);
    scale = body.length - dot - 1;
  } else {
    digits = body;
    scale = 0;
  }
  scale -= exponent;
  if (digits.length > MAX_DECIMAL_DIGITS) {
    throw new DecimalError(
      `the value has ${digits.length} significant digits, over the ${MAX_DECIMAL_DIGITS} limit`,
    );
  }
  let unscaled = BigInt(digits === "" ? "0" : digits);
  if (scale < 0) {
    unscaled *= pow10(-scale);
    scale = 0;
  }
  if (scale > MAX_DECIMAL_SCALE + MAX_DECIMAL_DIGITS) {
    throw new DecimalError(`the value needs a scale of ${scale}, over the supported range`);
  }
  return { unscaled: negative ? -unscaled : unscaled, scale };
}

/** Render a decimal in plain notation — never exponent notation, never a float. */
export function decimalToString(value: Decimal): string {
  const negative = value.unscaled < 0n;
  let digits = (negative ? -value.unscaled : value.unscaled).toString();
  if (value.scale === 0) return (negative ? "-" : "") + digits;
  if (digits.length <= value.scale) digits = digits.padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  const out = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return (negative ? "-" : "") + out;
}

/** The nearest double to an exact decimal. Lossy by nature — the string is authoritative. */
export function decimalToNumber(value: Decimal): number {
  return Number(decimalToString(value));
}

/** Re-scale, rounding when digits have to be dropped. */
export function rescale(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  if (scale < 0 || scale > MAX_DECIMAL_SCALE) {
    throw new DecimalError(`scale must be between 0 and ${MAX_DECIMAL_SCALE}, got ${scale}`);
  }
  if (scale === value.scale) return value;
  if (scale > value.scale) {
    return { unscaled: value.unscaled * pow10(scale - value.scale), scale };
  }
  return { unscaled: divideRound(value.unscaled, pow10(value.scale - scale), mode), scale };
}

/** Align two decimals on their larger scale, exactly. */
export function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.unscaled * pow10(scale - a.scale),
    b: b.unscaled * pow10(scale - b.scale),
    scale,
  };
}

export function decimalAdd(a: Decimal, b: Decimal): Decimal {
  const aligned = align(a, b);
  return { unscaled: aligned.a + aligned.b, scale: aligned.scale };
}

export function decimalMultiply(a: Decimal, b: Decimal): Decimal {
  return { unscaled: a.unscaled * b.unscaled, scale: a.scale + b.scale };
}

export function decimalIsZero(value: Decimal): boolean {
  return value.unscaled === 0n;
}

/** Drop trailing zeros without changing the value: 1.500 -> 1.5, 100 stays 100. */
export function trimTrailingZeros(value: Decimal): Decimal {
  let { unscaled, scale } = value;
  while (scale > 0 && unscaled % TEN === 0n) {
    unscaled /= TEN;
    scale--;
  }
  return { unscaled, scale };
}

/** Round to a fixed number of decimal places. Negative places are refused. */
export function roundToPlaces(value: Decimal, places: number, mode: RoundingMode): Decimal {
  if (!Number.isInteger(places) || places < 0 || places > MAX_DECIMAL_SCALE) {
    throw new DecimalError(`places must be an integer between 0 and ${MAX_DECIMAL_SCALE}`);
  }
  return rescale(value, places, mode);
}

/**
 * Round to `digits` significant figures. Zero has no significant figures to
 * speak of and is returned unchanged.
 */
export function roundToSignificant(value: Decimal, digits: number, mode: RoundingMode): Decimal {
  if (!Number.isInteger(digits) || digits < 1 || digits > MAX_DECIMAL_DIGITS) {
    throw new DecimalError(
      `significant digits must be an integer between 1 and ${MAX_DECIMAL_DIGITS}`,
    );
  }
  if (value.unscaled === 0n) return value;
  const magnitude = (value.unscaled < 0n ? -value.unscaled : value.unscaled).toString().length;
  const drop = magnitude - digits;
  if (drop <= 0) return value;
  const targetScale = value.scale - drop;
  if (targetScale >= 0) return rescale(value, targetScale, mode);
  // Rounding above the decimal point: round at scale 0 then scale back up.
  const rounded = divideRound(value.unscaled, pow10(drop), mode);
  return { unscaled: rounded * pow10(-targetScale), scale: 0 };
}

/** Round to the nearest multiple of `step` (which must be positive). */
export function roundToMultiple(value: Decimal, step: Decimal, mode: RoundingMode): Decimal {
  if (step.unscaled <= 0n) throw new DecimalError("the multiple must be greater than zero");
  const aligned = align(value, step);
  const quotient = divideRound(aligned.a, aligned.b, mode);
  return trimTrailingZeros(decimalMultiply({ unscaled: quotient, scale: 0 }, step));
}

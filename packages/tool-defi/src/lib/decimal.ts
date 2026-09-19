/**
 * Exact decimal arithmetic on `{ unscaled, scale }` pairs.
 *
 * Everything this package values is ALREADY a scaled integer: a token balance
 * is a uint256 with the token's decimals, a Chainlink answer is an int256 with
 * the feed's `decimals()`, a Pyth price is an int64 with its own exponent. So
 * `{ unscaled: balance, scale: 18 }` IS the balance, exactly, and no parsing
 * step is needed to get there. `Number(balance)` would keep fifteen of its
 * digits and quietly drop the rest, which for 18 decimals is the difference
 * between a wei and a thousand of them.
 *
 * WHY THIS IS NOT IMPORTED FROM `@crewhaus/tool-math`: that package owns this
 * monorepo's decimal kernel and this file mirrors it, but its entrypoint
 * exports only its tools, `statsKernel` and the currency table — the kernel
 * itself is module-private. Reaching past another package's entrypoint is the
 * thing `@crewhaus/tool-table` names as the wrong move, and widening
 * tool-math's surface mid-wave, while sibling packages are being written into
 * the same checkout, is how one agent's edit lands on top of another's. So the
 * arithmetic lives here and `lib.test.ts` pins every rounding case in it
 * against tool-math's `Round` tool, through that public surface, on the ties
 * and modes where two implementations diverge if they ever will.
 */

/** A rounding mode, named at every call site that can lose a digit. */
export type RoundingMode = "halfEven" | "halfUp" | "down";

/**
 * An exact decimal: `unscaled / 10^scale`. `scale` is non-negative — a value
 * that would need a negative scale is normalised by multiplying the integer
 * instead, so there is one representation of "this many, at this precision".
 */
export type Fixed = {
  readonly unscaled: bigint;
  readonly scale: number;
};

export class DecimalError extends Error {
  override readonly name = "DecimalError";
}

/** Scales past this are a bug, not a price. 18 decimals plus a cross is ~40. */
export const MAX_SCALE = 80;

const TEN = 10n;
const powCache = new Map<number, bigint>();

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SCALE * 4) {
    throw new DecimalError(`10^${n} is outside the supported range`);
  }
  const cached = powCache.get(n);
  if (cached !== undefined) return cached;
  const value = TEN ** BigInt(n);
  powCache.set(n, value);
  return value;
}

/** Build a Fixed, normalising a negative scale into the integer part. */
export function fixed(unscaled: bigint, scale: number): Fixed {
  if (!Number.isInteger(scale)) throw new DecimalError(`scale ${scale} is not an integer`);
  if (scale < 0) {
    // A Pyth feed with a positive exponent lands here: price 5, expo 2 is 500,
    // not "5 at scale -2". One representation means one comparison rule.
    return { unscaled: unscaled * pow10(-scale), scale: 0 };
  }
  if (scale > MAX_SCALE) {
    throw new DecimalError(`scale ${scale} is past the ${MAX_SCALE} limit for this package`);
  }
  return { unscaled, scale };
}

export const ZERO: Fixed = { unscaled: 0n, scale: 0 };

/** An integer as a Fixed. */
export function fromInteger(value: bigint): Fixed {
  return { unscaled: value, scale: 0 };
}

const PLAIN_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a plain decimal string exactly.
 *
 * Exponent notation is refused rather than accepted: every literal this
 * package reads comes from a price provider or a caller writing an amount, and
 * `1e-7` in either place is far more likely to be a float that has already
 * been through a double than a deliberate exponent.
 */
export function parseFixed(text: string, what: string): Fixed {
  const trimmed = text.trim();
  if (trimmed === "" || !PLAIN_DECIMAL.test(trimmed)) {
    throw new DecimalError(
      `${what}: "${text}" is not a plain decimal number (digits, an optional sign and at most one ".")`,
    );
  }
  const negative = trimmed.startsWith("-");
  const body = trimmed.replace(/^[+-]/, "");
  const dot = body.indexOf(".");
  const digits = dot < 0 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot < 0 ? 0 : body.length - dot - 1;
  if (scale > MAX_SCALE) {
    throw new DecimalError(
      `${what}: "${text}" has ${scale} decimal places, past the ${MAX_SCALE} this package carries`,
    );
  }
  const unscaled = BigInt(digits === "" ? "0" : digits);
  return { unscaled: negative ? -unscaled : unscaled, scale };
}

/**
 * Read a number that arrived inside a JSON document.
 *
 * `JSON.parse` turns a bare numeric literal into a double before anything here
 * sees it, so a provider that publishes its rate as `0.85431` hands us the
 * nearest double to that, not the digits. `String(value)` gives the shortest
 * decimal that round-trips to the same double, which is exact for anything up
 * to seventeen significant digits — an ECB reference rate has five. A provider
 * that published a twenty-digit price as a bare number would lose the tail, so
 * the caller is told which kind of literal a price came from rather than left
 * to assume; see `PriceLiteralKind` below and the `literal` field on a quote.
 */
export function fixedFromJson(
  value: unknown,
  what: string,
): { value: Fixed; kind: PriceLiteralKind } {
  if (typeof value === "string") return { value: parseFixed(value, what), kind: "string" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DecimalError(`${what}: ${value} is not a finite number`);
    const text = String(value);
    if (!PLAIN_DECIMAL.test(text)) {
      // A double large or small enough to stringify as "1e+21" or "5e-7".
      throw new DecimalError(
        `${what}: the provider's JSON number ${text} is outside the range this reads without exponent notation`,
      );
    }
    return { value: parseFixed(text, what), kind: "number" };
  }
  throw new DecimalError(`${what}: expected a number or a decimal string, got ${typeof value}`);
}

/** Whether a price arrived as a JSON string (exact) or a JSON number (through a double). */
export type PriceLiteralKind = "string" | "number";

export function isZero(value: Fixed): boolean {
  return value.unscaled === 0n;
}

export function isPositive(value: Fixed): boolean {
  return value.unscaled > 0n;
}

export function negate(value: Fixed): Fixed {
  return { unscaled: -value.unscaled, scale: value.scale };
}

export function absolute(value: Fixed): Fixed {
  return value.unscaled < 0n ? negate(value) : value;
}

/** Align two values on the larger scale, exactly. */
function align(a: Fixed, b: Fixed): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.unscaled * pow10(scale - a.scale),
    b: b.unscaled * pow10(scale - b.scale),
    scale,
  };
}

export function add(a: Fixed, b: Fixed): Fixed {
  const aligned = align(a, b);
  return { unscaled: aligned.a + aligned.b, scale: aligned.scale };
}

export function subtract(a: Fixed, b: Fixed): Fixed {
  return add(a, negate(b));
}

/** -1, 0 or 1. */
export function compare(a: Fixed, b: Fixed): number {
  const aligned = align(a, b);
  return aligned.a < aligned.b ? -1 : aligned.a > aligned.b ? 1 : 0;
}

/**
 * The exact product. Scales add, so nothing is rounded here — a balance at 18
 * decimals times a price at 8 is a value at 26, and the rounding happens once,
 * at the end, where a mode can be named for it.
 */
export function multiply(a: Fixed, b: Fixed): Fixed {
  const scale = a.scale + b.scale;
  if (scale > MAX_SCALE) {
    // Rather than round silently mid-chain, drop the product's tail once and
    // say so is tempting; refusing is better, because a caller that reached
    // scale 80 has multiplied something it did not mean to.
    throw new DecimalError(
      `the product needs scale ${scale}, past the ${MAX_SCALE} limit — round an intermediate deliberately`,
    );
  }
  return { unscaled: a.unscaled * b.unscaled, scale };
}

/** Integer division with the named mode. Shared by `divide` and `roundToPlaces`. */
export function divideRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new DecimalError("division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let bump = false;
  if (mode === "down") {
    bump = false;
  } else {
    const twice = remainder * 2n;
    if (twice > d) bump = true;
    else if (twice < d) bump = false;
    // The tie. halfUp always goes away from zero; halfEven goes to the even
    // quotient, which is the only mode whose errors cancel over many rows —
    // and a portfolio total is many rows.
    else bump = mode === "halfUp" ? true : quotient % 2n !== 0n;
  }
  const magnitude = bump ? quotient + 1n : quotient;
  return negative ? -magnitude : magnitude;
}

/** `a / b`, carried to `scale` decimal places with the named mode. */
export function divide(a: Fixed, b: Fixed, scale: number, mode: RoundingMode): Fixed {
  if (b.unscaled === 0n) throw new DecimalError("division by zero");
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new DecimalError(`scale must be an integer from 0 to ${MAX_SCALE}, got ${scale}`);
  }
  // a/b = (a.unscaled * 10^(scale + b.scale)) / (b.unscaled * 10^a.scale)
  const numerator = a.unscaled * pow10(scale + b.scale);
  const denominator = b.unscaled * pow10(a.scale);
  return { unscaled: divideRound(numerator, denominator, mode), scale };
}

/** Round to a fixed number of decimal places. */
export function roundToPlaces(value: Fixed, places: number, mode: RoundingMode): Fixed {
  if (!Number.isInteger(places) || places < 0 || places > MAX_SCALE) {
    throw new DecimalError(`places must be an integer from 0 to ${MAX_SCALE}, got ${places}`);
  }
  if (places >= value.scale) {
    return { unscaled: value.unscaled * pow10(places - value.scale), scale: places };
  }
  return {
    unscaled: divideRound(value.unscaled, pow10(value.scale - places), mode),
    scale: places,
  };
}

/** Drop trailing zeros without changing the value: 1.500 -> 1.5, 100 stays 100. */
export function trim(value: Fixed): Fixed {
  let { unscaled, scale } = value;
  while (scale > 0 && unscaled % TEN === 0n) {
    unscaled /= TEN;
    scale--;
  }
  return { unscaled, scale };
}

/** Plain decimal notation, always. Never `1e-7`, never a float. */
export function toDecimalString(value: Fixed): string {
  const negative = value.unscaled < 0n;
  let digits = (negative ? -value.unscaled : value.unscaled).toString();
  if (value.scale === 0) return (negative ? "-" : "") + digits;
  if (digits.length <= value.scale) digits = digits.padStart(value.scale + 1, "0");
  const cut = digits.length - value.scale;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * A ratio in basis points, rounded down.
 *
 * Down, deliberately: every caller of this is reporting a share or a spread,
 * and a share rounded up can make a set of weights sum past 10000, which reads
 * as an arithmetic bug in the output rather than as the rounding it is.
 */
export function ratioBps(part: Fixed, whole: Fixed): number {
  if (isZero(whole)) throw new DecimalError("the whole is zero, so there is no ratio");
  return Number(toDecimalString(divide(multiply(part, fromInteger(10_000n)), whole, 0, "down")));
}

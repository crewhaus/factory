/**
 * Money arithmetic on MINOR UNITS — integer cents, pence, yen — carried in
 * bigints. No float ever touches an amount.
 *
 * Every amount crossing this boundary is an integer count of minor units, and
 * every currency carries its own minor-unit exponent: USD and EUR have 2
 * (100 cents), JPY and KRW have 0 (a yen is not divisible), and the Gulf
 * dinars have 3 (1000 fils). Passing 1050 as USD means $10.50; passing 1050
 * as JPY means ¥1050. Getting that exponent wrong is a 100x error, so an
 * unknown currency code is refused rather than assumed to have 2.
 *
 * The table below is the common set, from ISO 4217. It is deliberately not
 * exhaustive: a code that is not listed can still be used by supplying
 * `exponent` explicitly, which is honest about where the number came from.
 */

import {
  type Decimal,
  DecimalError,
  MAX_DECIMAL_DIGITS,
  type RoundingMode,
  decimalToString,
  divideRound,
  parseDecimal,
  pow10,
} from "./decimal";

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** ISO 4217 minor-unit exponents for the currencies a harness actually sees. */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal currencies: the major unit is the smallest unit.
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
  // Three-decimal currencies: 1000 minor units to the major unit.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Two-decimal currencies.
  AED: 2,
  ARS: 2,
  AUD: 2,
  BGN: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  COP: 2,
  CZK: 2,
  DKK: 2,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  KES: 2,
  MAD: 2,
  MXN: 2,
  MYR: 2,
  NGN: 2,
  NOK: 2,
  NZD: 2,
  PEN: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TRY: 2,
  TWD: 2,
  UAH: 2,
  USD: 2,
  UYU: 2,
  VES: 2,
  ZAR: 2,
});

/** The currency codes this package knows, sorted. */
export const KNOWN_CURRENCIES: ReadonlyArray<string> = Object.freeze(
  Object.keys(CURRENCY_MINOR_UNITS).sort(),
);

/**
 * The minor-unit exponent for `code`, or the caller's explicit override.
 * Refuses an unknown code: guessing 2 is how a JPY invoice becomes 100x wrong.
 */
export function minorUnitExponent(code: string, override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 0 || override > 6) {
      throw new MoneyError(`exponent must be an integer between 0 and 6, got ${override}`);
    }
    return override;
  }
  if (!/^[A-Za-z]{3}$/.test(code)) {
    throw new MoneyError(`"${code}" is not a three-letter currency code`);
  }
  const exponent = CURRENCY_MINOR_UNITS[code.toUpperCase()];
  if (exponent === undefined) {
    throw new MoneyError(
      `currency "${code.toUpperCase()}" is not in this package's ISO 4217 table, so its minor-unit exponent is unknown — pass exponent explicitly (0 for yen-like, 2 for cent-like, 3 for fils-like). Known codes: ${KNOWN_CURRENCIES.join(", ")}`,
    );
  }
  return exponent;
}

/** A count of minor units, validated as a safe integer and carried as a bigint. */
export function toMinor(amount: number | string, label = "amount"): bigint {
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) {
      throw new MoneyError(
        `${label} must be a whole number of minor units (cents), got ${amount} — $10.50 is 1050, not 10.5`,
      );
    }
    if (!Number.isSafeInteger(amount)) {
      throw new MoneyError(`${label} ${amount} is beyond the exactly representable integer range`);
    }
    return BigInt(amount);
  }
  const text = amount.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new MoneyError(`${label} must be a whole number of minor units, got "${amount}"`);
  }
  // The same digit cap `parseDecimal` applies. Without it a single request could
  // carry a 200 000-digit "amount", and the bigint multiplications in
  // `moneyAllocate` then took tens of seconds and built an 80 MB result — an
  // unbounded amount of work from a small-looking input.
  const digits = text.replace(/^[+-]/, "").length;
  if (digits > MAX_DECIMAL_DIGITS) {
    throw new MoneyError(
      `${label} has ${digits} digits, over the ${MAX_DECIMAL_DIGITS} limit — no currency amount is that large`,
    );
  }
  return BigInt(text);
}

/** Minor units rendered as a major-unit decimal string: 1050 with exponent 2 -> "10.50". */
export function formatMinor(minor: bigint, exponent: number): string {
  return decimalToString({ unscaled: minor, scale: exponent });
}

export type MoneyAmount = {
  currency: string;
  minorUnits: string;
  exponent: number;
  amount: string;
};

export function describeMoney(minor: bigint, currency: string, exponent: number): MoneyAmount {
  return {
    currency: currency.toUpperCase(),
    minorUnits: minor.toString(),
    exponent,
    amount: formatMinor(minor, exponent),
  };
}

/** Exact sum of minor-unit amounts. No rounding happens, because none is needed. */
export function moneySum(amounts: ReadonlyArray<bigint>): bigint {
  let total = 0n;
  for (const a of amounts) total += a;
  return total;
}

/**
 * Multiply a minor-unit amount by an exact decimal factor and round the
 * result back to whole minor units with the named mode. The factor is parsed
 * as a decimal (never as a float), so 19.99 * 0.07 is computed on 1999 * 7
 * and then rounded once — not accumulated through binary floating point.
 */
export function moneyMultiply(
  minor: bigint,
  factor: Decimal,
  mode: RoundingMode,
): { rounded: bigint; exact: Decimal } {
  const exact: Decimal = { unscaled: minor * factor.unscaled, scale: factor.scale };
  const rounded = divideRound(exact.unscaled, pow10(exact.scale), mode);
  return { rounded, exact };
}

export const REMAINDER_POLICIES = ["largest", "first", "last"] as const;
export type RemainderPolicy = (typeof REMAINDER_POLICIES)[number];

export type Allocation = {
  index: number;
  ratio: string;
  minorUnits: string;
  amount: string;
  /** True when this part received one extra minor unit from the remainder. */
  remainderUnit: boolean;
};

export type AllocateResult = {
  parts: Allocation[];
  total: string;
  remainderUnits: number;
  policy: RemainderPolicy;
  method: string;
};

/**
 * Split `total` minor units across `ratios` so the parts sum EXACTLY back to
 * the total — the invoice-rounding bug, closed.
 *
 * The method is largest-remainder (Hamilton's method): each part takes the
 * floor of its exact share, and the leftover minor units — always fewer than
 * the number of parts — are handed out one each. `policy` decides who gets
 * them:
 *
 *   - "largest" (default): to the parts with the largest fractional remainder,
 *     ties broken by lowest index so the result is deterministic.
 *   - "first" / "last": strictly in index order from either end, which is what
 *     some billing systems specify for auditability.
 *
 * A negative total is allocated on its magnitude and signed back, so
 * allocating -1000 mirrors allocating 1000.
 */
export function moneyAllocate(
  total: bigint,
  ratios: ReadonlyArray<Decimal>,
  policy: RemainderPolicy,
  exponent: number,
): AllocateResult {
  if (ratios.length === 0) throw new MoneyError("at least one ratio is required");
  if (ratios.length > 10_000) throw new MoneyError("at most 10000 ratios are supported");
  const scale = ratios.reduce((max, r) => Math.max(max, r.scale), 0);
  const weights = ratios.map((r) => {
    if (r.unscaled < 0n) throw new MoneyError("ratios must not be negative");
    return r.unscaled * pow10(scale - r.scale);
  });
  const weightTotal = weights.reduce((sum, w) => sum + w, 0n);
  if (weightTotal === 0n)
    throw new MoneyError("the ratios sum to zero, so there is nothing to split by");

  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const bases: bigint[] = [];
  const remainders: bigint[] = [];
  let distributed = 0n;
  for (const weight of weights) {
    const numerator = magnitude * weight;
    const base = numerator / weightTotal;
    bases.push(base);
    remainders.push(numerator - base * weightTotal);
    distributed += base;
  }
  let leftover = magnitude - distributed;
  const order = weights.map((_, index) => index);
  if (policy === "largest") {
    order.sort((a, b) => {
      const ra = remainders[a] as bigint;
      const rb = remainders[b] as bigint;
      if (ra === rb) return a - b;
      return rb > ra ? 1 : -1;
    });
  } else if (policy === "last") {
    order.reverse();
  }
  const gotExtra = new Set<number>();
  for (const index of order) {
    if (leftover <= 0n) break;
    // A part with zero weight never receives a remainder unit: a 0% share
    // must stay at zero.
    if ((weights[index] as bigint) === 0n) continue;
    gotExtra.add(index);
    bases[index] = (bases[index] as bigint) + 1n;
    leftover -= 1n;
  }
  if (leftover !== 0n) {
    throw new MoneyError("the remainder could not be distributed; every ratio was zero");
  }
  const parts = bases.map((base, index) => {
    const signed = negative ? -base : base;
    return {
      index,
      ratio: decimalToString(ratios[index] as Decimal),
      minorUnits: signed.toString(),
      amount: formatMinor(signed, exponent),
      remainderUnit: gotExtra.has(index),
    };
  });
  return {
    parts,
    total: total.toString(),
    remainderUnits: Number(magnitude - distributed),
    policy,
    method:
      "largest remainder (Hamilton): floor of each exact share, leftover minor units handed out one each; the parts always sum to the total",
  };
}

/**
 * Convert between currencies using a rate table the CALLER supplies. There is
 * no network here and no built-in rates: a tool that fetched a rate would
 * make the answer depend on the time of day, and a stale hard-coded table
 * would be worse. A rate keyed "USD/EUR" means "1 USD buys this many EUR".
 */
export function lookupRate(
  rates: Readonly<Record<string, string | number>>,
  from: string,
  to: string,
  allowInverse: boolean,
): { rate: Decimal; source: "direct" | "inverse" | "identity"; key: string } {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { rate: parseDecimal("1"), source: "identity", key: `${f}/${t}` };
  const normalized = new Map<string, string | number>();
  for (const [key, value] of Object.entries(rates)) {
    const upper = key.toUpperCase();
    const separated = /^[A-Z]{6}$/.test(upper)
      ? `${upper.slice(0, 3)}/${upper.slice(3)}`
      : upper.replace(/[^A-Z]/g, "/").replace(/\/+/g, "/");
    normalized.set(separated, value);
  }
  const directKey = `${f}/${t}`;
  const direct = normalized.get(directKey);
  if (direct !== undefined) {
    const rate = parseRate(direct, directKey);
    return { rate, source: "direct", key: directKey };
  }
  const inverseKey = `${t}/${f}`;
  const inverse = normalized.get(inverseKey);
  if (inverse !== undefined && allowInverse) {
    const parsed = parseRate(inverse, inverseKey);
    if (parsed.unscaled === 0n)
      throw new MoneyError(`rate "${inverseKey}" is zero and cannot be inverted`);
    // 1/x to 18 decimal places, rounded half-even. Inverting a quote is not
    // what a dealer would give you (there is a spread), which is why it is opt-in.
    const inverted = divideRound(pow10(18 + parsed.scale), parsed.unscaled, "halfEven");
    return { rate: { unscaled: inverted, scale: 18 }, source: "inverse", key: inverseKey };
  }
  const available = [...normalized.keys()].sort().join(", ");
  throw new MoneyError(
    `no rate for ${directKey} in the supplied table${allowInverse ? "" : " (inverse lookup is off)"}; available: ${available || "none"}`,
  );
}

function parseRate(value: string | number, key: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = parseDecimal(value);
  } catch (err) {
    const message = err instanceof DecimalError ? err.message : String(err);
    throw new MoneyError(`rate "${key}" is not a decimal number: ${message}`);
  }
  if (parsed.unscaled <= 0n) throw new MoneyError(`rate "${key}" must be greater than zero`);
  return parsed;
}

/**
 * Apply a rate to a minor-unit amount, honouring both currencies' exponents.
 * Exact until the single final rounding into the target currency's minor unit.
 */
export function convertMinor(
  minor: bigint,
  rate: Decimal,
  fromExponent: number,
  toExponent: number,
  mode: RoundingMode,
): bigint {
  const shift = toExponent - fromExponent;
  const numerator = minor * rate.unscaled * (shift > 0 ? pow10(shift) : 1n);
  const denominator = pow10(rate.scale) * (shift < 0 ? pow10(-shift) : 1n);
  return divideRound(numerator, denominator, mode);
}

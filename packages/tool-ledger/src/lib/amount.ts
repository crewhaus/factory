/**
 * Amounts, dates and the canonical bytes everything else is hashed over.
 *
 * Three rules hold everywhere below this line, and each of them is a bug that
 * has shipped in somebody's books:
 *
 * 1. **No float ever touches an amount.** Every amount is a bigint count of
 *    minor units. The arithmetic and the ISO 4217 exponent table come from
 *    `@crewhaus/tool-math`'s money kernel rather than from a second copy here
 *    — a JPY exponent guessed at 2 is a 100x error, and there is exactly one
 *    table in this repo that knows it is 0.
 * 2. **A scale the currency cannot hold is refused, not rounded.** "1.005" as
 *    USD is not $1.01; it is a caller who has not decided. A ledger that
 *    rounds an input silently is a ledger whose total disagrees with the
 *    document it was posted from.
 * 3. **Totals accumulate in bigint, not in a JS number.** A single amount fits
 *    a safe integer — that is why `@crewhaus/tool-money` types one as
 *    `number` and this package matches it at the tool boundary — but a year of
 *    them summed does not, and SQLite's own `SUM()` silently promotes a
 *    64-bit overflow to a float. So amounts are STORED as text and summed
 *    here.
 */
import { createHash } from "node:crypto";
import { CrewhausError } from "@crewhaus/errors";
import { decimalKernel, moneyKernel } from "@crewhaus/tool-math";

/** Every refusal this package makes, so a caller can tell one from a crash. */
export class LedgerError extends CrewhausError {
  override readonly name = "LedgerError";
  constructor(message: string) {
    super("tool", message);
  }
}

export const ROUNDING_MODES = decimalKernel.ROUNDING_MODES;
export type RoundingMode = decimalKernel.RoundingMode;

/**
 * Half-even everywhere rounding is unavoidable. It is the mode that does not
 * drift upward over a long series of conversions, which is the whole of what a
 * ledger is.
 */
export const LEDGER_ROUNDING: RoundingMode = "halfEven";

/** The minor-unit exponent for a currency, refusing a code nobody knows. */
export function exponentFor(currency: string, override?: number): number {
  try {
    return moneyKernel.minorUnitExponent(currency, override);
  } catch (err) {
    throw new LedgerError(err instanceof Error ? err.message : String(err));
  }
}

/** Minor units rendered as a major-unit decimal string: 1050 @2 -> "10.50". */
export function formatMajor(minor: bigint, exponent: number): string {
  return moneyKernel.formatMinor(minor, exponent);
}

/**
 * A major-unit decimal string ("100.00", "-3.5") as minor units.
 *
 * A fraction longer than the currency's exponent is REFUSED. Rounding it here
 * would mean the entry posts an amount the source document does not contain,
 * and the difference is invisible until a reconciliation a year later.
 */
export function parseMajor(text: string, exponent: number, label: string): bigint {
  let parsed: decimalKernel.Decimal;
  try {
    parsed = decimalKernel.parseDecimal(text);
  } catch (err) {
    throw new LedgerError(
      `${label} ("${text}") is not a decimal number: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.scale > exponent) {
    throw new LedgerError(
      `${label} ("${text}") has ${parsed.scale} decimal places but this currency has ${exponent} — refusing to round an amount that was written down, decide the rounding before posting it`,
    );
  }
  return parsed.unscaled * decimalKernel.pow10(exponent - parsed.scale);
}

/** An integer count of minor units, from a string or a safe integer. */
export function parseMinorUnits(value: string | number, label: string): bigint {
  try {
    return moneyKernel.toMinor(value, label);
  } catch (err) {
    throw new LedgerError(err instanceof Error ? err.message : String(err));
  }
}

/** A decimal factor — an fx rate, a quantity — parsed exactly. */
export function parseFactor(text: string, label: string): decimalKernel.Decimal {
  try {
    return decimalKernel.parseDecimal(text);
  } catch (err) {
    throw new LedgerError(
      `${label} ("${text}") is not a decimal number: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Multiply minor units by an exact decimal and round once, at the end. */
export function multiplyMinor(
  minor: bigint,
  factor: decimalKernel.Decimal,
  mode: RoundingMode = LEDGER_ROUNDING,
): bigint {
  return moneyKernel.moneyMultiply(minor, factor, mode).rounded;
}

/** Apply an fx rate, honouring both currencies' exponents, rounding once. */
export function convertMinor(
  minor: bigint,
  rate: decimalKernel.Decimal,
  fromExponent: number,
  toExponent: number,
  mode: RoundingMode = LEDGER_ROUNDING,
): bigint {
  return moneyKernel.convertMinor(minor, rate, fromExponent, toExponent, mode);
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date, validated against the calendar.
 *
 * `Date.parse` accepts "2026-02-30" and rolls it to 2 March, which puts an
 * entry in the wrong month without anybody typing a wrong month. The round
 * trip through the constructed date is what catches it.
 */
export function assertIsoDate(text: string, label: string): string {
  const m = ISO_DATE.exec(text);
  if (!m) {
    throw new LedgerError(`${label} ("${text}") must be an ISO calendar date, YYYY-MM-DD`);
  }
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    at.getUTCFullYear() !== Number(y) ||
    at.getUTCMonth() + 1 !== Number(mo) ||
    at.getUTCDate() !== Number(d)
  ) {
    throw new LedgerError(`${label} ("${text}") is not a date that exists`);
  }
  return text;
}

/** Whole days since the epoch, in UTC. Dates are compared and differenced here. */
export function epochDay(isoDate: string): number {
  const m = ISO_DATE.exec(isoDate);
  if (!m) throw new LedgerError(`"${isoDate}" is not an ISO calendar date`);
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 86_400_000);
}

/** Signed day difference, `a - b`. */
export function dayDiff(a: string, b: string): number {
  return epochDay(a) - epochDay(b);
}

/** The year an invoice sequence resets on comes from the DOCUMENT, not the clock. */
export function yearOf(isoDate: string): string {
  return isoDate.slice(0, 4);
}

/**
 * An ISO-8601 instant that carries a UTC offset.
 *
 * Matches `@crewhaus/tool-money`'s rule: an offset-less string means local
 * time per ECMAScript, so the same posting would carry a different instant on
 * two machines — and the instant is inside the hash chain.
 */
export function assertInstant(text: string, label: string): string {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text.trim())) {
    throw new LedgerError(
      `${label} ("${text}") has no UTC offset — write it as e.g. 2026-01-01T00:00:00Z, because an offset-less string means local time and would hash differently on two machines`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new LedgerError(`${label} ("${text}") is not a valid instant`);
  return new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// canonical bytes
// ---------------------------------------------------------------------------

/**
 * JSON with every object key in codepoint order and no incidental whitespace.
 *
 * This is what the hash chain and every idempotency fingerprint are taken
 * over, so it has to be stable against the one thing JSON is not stable
 * against: insertion order. A bigint serializes as its decimal string, and a
 * non-integer number is refused outright — a float in the bytes that identify
 * a payment is the defect this whole package exists to avoid.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new LedgerError("a non-finite number cannot be canonicalized");
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Codepoint order, never `localeCompare` — a locale-aware sort is not the
  // same order on two machines, and the hash would move with it.
  for (const key of Object.keys(source).sort(byString)) {
    const entry = source[key];
    if (entry === undefined) continue;
    out[key] = canonicalize(entry);
  }
  return out;
}

/** Locale-independent string order. */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 hex of a string. The chain link and every fingerprint use this. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);

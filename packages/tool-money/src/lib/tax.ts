/**
 * Per-line tax from an operator's own rate tables.
 *
 * Money is integer minor units throughout — cents, pence, satoshi-free. A
 * tax engine that computes in floating point produces totals that do not add
 * up, and "off by a cent" in an invoice is not a rounding detail, it is a
 * document that fails an audit.
 *
 * Two choices are the caller's and neither has a safe default, so both are
 * explicit: whether listed prices already include tax, and whether rounding
 * happens per line or once per invoice. Jurisdictions differ, the totals
 * differ, and a tool that picked one silently would be wrong half the time.
 */

import { big, mathRound, toNumber } from "./exact";

export const ROUNDING_MODES = ["half-up", "half-even", "down", "up"] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const ROUNDING_SCOPES = ["line", "invoice"] as const;
export type RoundingScope = (typeof ROUNDING_SCOPES)[number];

export type TaxRate = {
  readonly code: string;
  /** Basis points: 2000 is 20%. Integer, so the rate itself never rounds. */
  readonly bps: number;
  readonly name?: string;
  /**
   * Charged on the running total including earlier taxes, rather than on the
   * net amount. Quebec's QST historically worked this way, and getting it
   * wrong changes the total rather than a rounding digit.
   */
  readonly compound?: boolean;
};

export type TaxLine = {
  readonly id: string;
  /** Minor units. Net of tax unless `pricesIncludeTax` is set. */
  readonly amountMinor: number;
  /** Rate codes applied to this line, in order. */
  readonly taxCodes: ReadonlyArray<string>;
  /** Exempt from tax entirely, which is not the same as a zero rate. */
  readonly exempt?: boolean;
};

export type TaxOptions = {
  readonly pricesIncludeTax?: boolean;
  readonly rounding?: RoundingMode;
  readonly scope?: RoundingScope;
  /**
   * B2B cross-border: the customer accounts for the tax, so the invoice
   * carries none. It is reported rather than silently zero, because an
   * invoice that shows no tax for the wrong reason is a compliance problem.
   */
  readonly reverseCharge?: boolean;
};

export type TaxLineResult = {
  readonly id: string;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  readonly breakdown: ReadonlyArray<{
    readonly code: string;
    readonly bps: number;
    readonly taxMinor: number;
  }>;
  readonly note: string;
};

export type TaxResult = {
  readonly lines: ReadonlyArray<TaxLineResult>;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  readonly byCode: ReadonlyArray<{
    readonly code: string;
    readonly bps: number;
    readonly taxMinor: number;
    readonly netMinor: number;
  }>;
  readonly reverseCharge: boolean;
  readonly rounding: RoundingMode;
  readonly scope: RoundingScope;
};

/**
 * Round a rational to an integer, by the caller's rule, exactly: the
 * numerator is an amount times a rate in basis points, which passes 2^53 long
 * before the amount or the answer does.
 */
export function roundMinorExact(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator === 0n) throw new Error("denominator must not be zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const whole = n / d;
  const remainder = n - whole * d;
  let result: bigint;
  switch (mode) {
    case "down":
      result = whole;
      break;
    case "up":
      result = remainder > 0n ? whole + 1n : whole;
      break;
    case "half-even": {
      const twice = remainder * 2n;
      if (twice > d) result = whole + 1n;
      else if (twice < d) result = whole;
      // Exactly half: go to the even neighbour. Over many lines this is what
      // keeps a total from drifting upward the way half-up does.
      else result = whole % 2n === 0n ? whole : whole + 1n;
      break;
    }
    default:
      result = remainder * 2n >= d ? whole + 1n : whole;
  }
  return negative ? -result : result;
}

/** {@link roundMinorExact} over integer numbers, for callers holding numbers. */
export function roundMinor(numerator: number, denominator: number, mode: RoundingMode): number {
  return toNumber(
    roundMinorExact(big(numerator, "numerator"), big(denominator, "denominator"), mode),
    "the rounded amount",
  );
}

const BPS_DENOMINATOR = 10_000n;

export function calculateTax(
  lines: ReadonlyArray<TaxLine>,
  rates: ReadonlyArray<TaxRate>,
  options: TaxOptions = {},
): TaxResult {
  const mode = options.rounding ?? "half-up";
  const scope = options.scope ?? "line";
  const byCodeIndex = new Map(rates.map((r) => [r.code, r]));

  for (const line of lines) {
    for (const code of line.taxCodes) {
      if (!byCodeIndex.has(code)) {
        throw new Error(
          `line "${line.id}" uses tax code "${code}", which is not in the rate table — add it rather than letting the line go untaxed`,
        );
      }
    }
  }
  // Exact throughout: every amount and rate as a bigint, and a figure goes
  // back to a number only when it fits. See ./exact.
  const tally = new Map<string, { bps: number; taxMinor: bigint; netMinor: bigint }>();
  const results: TaxLineResult[] = [];
  // Exact totals kept as numerator over BPS_DENOMINATOR, so invoice-scope
  // rounding rounds the true sum rather than a sum of rounded pieces.
  let exactTaxNumerator = 0n;
  let netTotal = 0n;
  let summedTax = 0n;

  for (const line of lines) {
    const amount = big(line.amountMinor, `line "${line.id}" amountMinor`);
    const applied = line.exempt || options.reverseCharge ? [] : line.taxCodes;
    const rateList = applied.map((code) => byCodeIndex.get(code) as TaxRate);

    // Net is the base everything is charged on. When listed prices already
    // include tax it has to be recovered first: gross / (1 + total rate).
    let net: bigint;
    if (options.pricesIncludeTax && rateList.length > 0) {
      let multiplier = BPS_DENOMINATOR;
      for (const rate of rateList) {
        const bps = big(rate.bps, `rate "${rate.code}" bps`);
        multiplier = rate.compound
          ? mathRound(multiplier * (BPS_DENOMINATOR + bps), BPS_DENOMINATOR)
          : multiplier + bps;
      }
      net = roundMinorExact(amount * BPS_DENOMINATOR, multiplier, mode);
    } else {
      net = amount;
    }

    const breakdown: Array<{ code: string; bps: number; taxMinor: number }> = [];
    let lineTax = 0n;
    for (const rate of rateList) {
      // `compound` describes the base THIS rate is charged on — net plus the
      // taxes already applied — not an effect on the rates after it. Adding
      // to the base afterwards instead left the compound rate itself charged
      // on the bare net, which is the whole thing the flag exists to change.
      const base = rate.compound ? net + lineTax : net;
      const numerator = base * big(rate.bps, `rate "${rate.code}" bps`);
      const taxMinor = roundMinorExact(numerator, BPS_DENOMINATOR, mode);
      exactTaxNumerator += numerator;
      breakdown.push({
        code: rate.code,
        bps: rate.bps,
        taxMinor: toNumber(taxMinor, `line "${line.id}" ${rate.code} tax`),
      });
      lineTax += taxMinor;
      const seen = tally.get(rate.code) ?? { bps: rate.bps, taxMinor: 0n, netMinor: 0n };
      tally.set(rate.code, {
        bps: rate.bps,
        taxMinor: seen.taxMinor + taxMinor,
        netMinor: seen.netMinor + net,
      });
    }

    netTotal += net;
    summedTax += lineTax;
    results.push({
      id: line.id,
      netMinor: toNumber(net, `line "${line.id}" net`),
      taxMinor: toNumber(lineTax, `line "${line.id}" tax`),
      grossMinor: toNumber(net + lineTax, `line "${line.id}" gross`),
      breakdown,
      note: options.reverseCharge
        ? "reverse charge: the customer accounts for the tax"
        : line.exempt
          ? "exempt: outside the scope of tax, which is not a zero rate"
          : "",
    });
  }

  const taxTotal =
    scope === "invoice" ? roundMinorExact(exactTaxNumerator, BPS_DENOMINATOR, mode) : summedTax;

  return {
    lines: results,
    netMinor: toNumber(netTotal, "the invoice's net"),
    taxMinor: toNumber(taxTotal, "the invoice's tax"),
    grossMinor: toNumber(netTotal + taxTotal, "the invoice's gross"),
    byCode: [...tally.entries()]
      .map(([code, v]) => ({
        code,
        bps: v.bps,
        taxMinor: toNumber(v.taxMinor, `the ${code} tax`),
        netMinor: toNumber(v.netMinor, `the net taxed at ${code}`),
      }))
      .sort((a, b) => (a.code < b.code ? -1 : 1)),
    reverseCharge: options.reverseCharge === true,
    rounding: mode,
    scope,
  };
}

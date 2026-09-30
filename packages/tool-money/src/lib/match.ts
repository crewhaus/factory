/**
 * Three-way match: invoice against purchase order against goods receipt.
 *
 * This is the standard accounts-payable control, and it is entirely
 * mechanical — pair the lines, compare price and quantity, and report what
 * falls outside tolerance. A model reading two documents to decide whether
 * 4,800 matches 4,750 is being paid to do subtraction, and it will sometimes
 * get it wrong on an invoice nobody re-reads.
 */

import {
  type Decimal,
  addDecimal,
  addExact,
  atScale,
  big,
  compareDecimal,
  decimalNumber,
  decimalOf,
  roundHalfAwayFromZero,
  sumExact,
  toNumber,
} from "./exact";

export type MatchLine = {
  readonly id: string;
  /** Explicit link to a PO line, when the document carries one. */
  readonly poLineId?: string;
  readonly sku?: string;
  readonly description?: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
};

export type Tolerance = {
  /** Allowed unit-price variance, in basis points. 100 is 1%. */
  readonly pricePercentBps?: number;
  /** Allowed variance in absolute minor units, whichever is larger. */
  readonly priceAbsoluteMinor?: number;
  readonly quantityPercentBps?: number;
  readonly quantityAbsolute?: number;
};

export const MATCH_STATUSES = [
  "matched",
  "price-variance",
  "quantity-variance",
  "both-variance",
  "over-receipt",
  "not-received",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export type MatchPair = {
  readonly invoiceLineId: string;
  readonly poLineId: string;
  readonly matchedBy: "reference" | "sku" | "description";
  readonly status: MatchStatus;
  readonly invoiceUnitPriceMinor: number;
  readonly poUnitPriceMinor: number;
  readonly priceDeltaMinor: number;
  readonly invoiceQuantity: number;
  readonly poQuantity: number;
  readonly receivedQuantity: number | null;
  readonly quantityDelta: number;
  /**
   * What the variance costs, positive when the invoice asks for more. With a
   * fractional quantity (kilograms, hours) the figure is rounded to whole
   * minor units, half away from zero.
   */
  readonly exposureMinor: number;
  readonly reasons: ReadonlyArray<string>;
};

export type MatchReport = {
  readonly pairs: ReadonlyArray<MatchPair>;
  readonly unmatchedInvoiceLines: ReadonlyArray<string>;
  readonly unmatchedPoLines: ReadonlyArray<string>;
  readonly ok: boolean;
  readonly exceptions: number;
  /** Net amount the invoice claims above the order, across every exception. */
  readonly totalExposureMinor: number;
  readonly threeWay: boolean;
};

/** Lowercased, punctuation folded, runs of space collapsed. */
function normalizeDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Whether `actual` is within tolerance of `expected`, decided exactly.
 *
 * Prices are integers whose products with a rate pass 2^53 on ordinary
 * amounts, and quantities are decimals a double cannot hold (0.33 against
 * 0.3 at 10% is exactly on the bound, and 0.7.0's float arithmetic put it
 * just outside). So every figure — the two values, the rate and the absolute
 * bound — is compared as the exact decimal it was written as.
 */
function withinTolerance(
  actual: Decimal,
  expected: Decimal,
  percentBps: number | undefined,
  absolute: number | undefined,
  what: string,
): boolean {
  if (compareDecimal(actual, expected) === 0) return true;
  // Either bound may pass. A percentage alone is useless on a cheap line and
  // an absolute alone is useless on an expensive one.
  const scale = Math.max(actual.scale, expected.scale);
  const delta = abs(atScale(actual, scale) - atScale(expected, scale));
  const base = abs(atScale(expected, scale));
  let byPercent = false;
  if (percentBps !== undefined && !Number.isNaN(percentBps)) {
    if (percentBps === Number.POSITIVE_INFINITY) byPercent = true;
    else {
      // |expected| × bps / 10 000 >= delta, on one scale: bps is b / 10^s.
      const bps = decimalOf(percentBps, `${what} percentage tolerance`);
      byPercent = base * bps.units >= delta * 10_000n * 10n ** BigInt(bps.scale);
    }
  }
  let byAbsolute = false;
  if (absolute !== undefined && !Number.isNaN(absolute)) {
    if (absolute === Number.POSITIVE_INFINITY) byAbsolute = true;
    else {
      // delta / 10^scale <= a / 10^s.
      const bound = decimalOf(absolute, `${what} absolute tolerance`);
      byAbsolute = delta * 10n ** BigInt(bound.scale) <= bound.units * 10n ** BigInt(scale);
    }
  }
  return byPercent || byAbsolute;
}

export function matchInvoiceToPurchaseOrder(
  invoiceLines: ReadonlyArray<MatchLine>,
  poLines: ReadonlyArray<MatchLine>,
  receiptLines: ReadonlyArray<{ readonly poLineId: string; readonly quantity: number }> = [],
  tolerance: Tolerance = {},
): MatchReport {
  for (const [label, list] of [
    ["invoice", invoiceLines],
    ["purchase order", poLines],
  ] as const) {
    const seen = new Set<string>();
    for (const line of list) {
      if (seen.has(line.id)) throw new Error(`two ${label} lines share the id "${line.id}"`);
      seen.add(line.id);
    }
  }

  // Receipts against one line are summed exactly: 0.1 + 0.2 received is 0.3,
  // not a float a hair over it that an invoice for 0.3 is then "within".
  const received = new Map<string, Decimal>();
  for (const entry of receiptLines) {
    const quantity = decimalOf(entry.quantity, `receipt for "${entry.poLineId}" quantity`);
    const before = received.get(entry.poLineId);
    received.set(entry.poLineId, before === undefined ? quantity : addDecimal(before, quantity));
  }

  const remainingPo = new Map(poLines.map((l) => [l.id, l]));
  const pairs: MatchPair[] = [];
  const unmatchedInvoiceLines: string[] = [];

  for (const invoice of invoiceLines) {
    // Reference first, then SKU, then description. Each is weaker than the
    // one before, and the pair records which was used so a reviewer can see
    // that a match rested on fuzzy text rather than on an identifier.
    let po = invoice.poLineId === undefined ? undefined : remainingPo.get(invoice.poLineId);
    let matchedBy: MatchPair["matchedBy"] = "reference";
    if (!po && invoice.sku !== undefined) {
      po = [...remainingPo.values()].find((l) => l.sku !== undefined && l.sku === invoice.sku);
      if (po) matchedBy = "sku";
    }
    if (!po && invoice.description !== undefined) {
      const wanted = normalizeDescription(invoice.description);
      po = [...remainingPo.values()].find(
        (l) => l.description !== undefined && normalizeDescription(l.description) === wanted,
      );
      if (po) matchedBy = "description";
    }
    if (!po) {
      unmatchedInvoiceLines.push(invoice.id);
      continue;
    }
    remainingPo.delete(po.id);

    const reasons: string[] = [];
    const line = `invoice line "${invoice.id}"`;
    const invoicePrice = big(invoice.unitPriceMinor, `${line} unitPriceMinor`);
    const poPrice = big(po.unitPriceMinor, `order line "${po.id}" unitPriceMinor`);
    const invoiceQuantity = decimalOf(invoice.quantity, `${line} quantity`);
    const poQuantity = decimalOf(po.quantity, `order line "${po.id}" quantity`);
    const priceOk = withinTolerance(
      { units: invoicePrice, scale: 0 },
      { units: poPrice, scale: 0 },
      tolerance.pricePercentBps,
      tolerance.priceAbsoluteMinor,
      `${line} price`,
    );
    const quantityOk = withinTolerance(
      invoiceQuantity,
      poQuantity,
      tolerance.quantityPercentBps,
      tolerance.quantityAbsolute,
      `${line} quantity`,
    );
    if (!priceOk) {
      reasons.push(
        `unit price ${invoice.unitPriceMinor} against ${po.unitPriceMinor} on the order`,
      );
    }
    if (!quantityOk) {
      reasons.push(`quantity ${invoice.quantity} against ${po.quantity} on the order`);
    }

    const receivedExact = received.get(po.id);
    const receivedQuantity =
      receivedExact === undefined
        ? null
        : decimalNumber(receivedExact, `the quantity received against order line "${po.id}"`);
    let status: MatchStatus =
      !priceOk && !quantityOk
        ? "both-variance"
        : !priceOk
          ? "price-variance"
          : !quantityOk
            ? "quantity-variance"
            : "matched";

    // The receipt is the third leg: billing for more than arrived is the
    // failure this control exists to catch, and it is invisible in a two-way
    // match however well price and quantity agree with the order.
    if (receiptLines.length > 0) {
      if (receivedExact === undefined || receivedExact.units === 0n) {
        status = "not-received";
        reasons.push("nothing has been received against this order line");
      } else if (compareDecimal(invoiceQuantity, receivedExact) > 0) {
        status = "over-receipt";
        reasons.push(`invoiced ${invoice.quantity} but only ${receivedQuantity} received`);
      }
    }

    // What the variance costs: the invoice's quantity at its price, less what
    // was billable (no more than arrived) at the lower of the two prices.
    // Counted exactly — decimal quantities times integer prices, as bigints
    // on one decimal scale — then rounded to whole minor units, a half away
    // from zero, and refused past 2^53 rather than reported units off.
    const billable =
      receivedExact !== undefined && compareDecimal(receivedExact, invoiceQuantity) < 0
        ? receivedExact
        : invoiceQuantity;
    const scale = Math.max(invoiceQuantity.scale, billable.scale);
    const lowerPrice = invoicePrice < poPrice ? invoicePrice : poPrice;
    const exposureMinor =
      status === "matched"
        ? 0
        : toNumber(
            roundHalfAwayFromZero(
              atScale(invoiceQuantity, scale) * invoicePrice -
                atScale(billable, scale) * lowerPrice,
              10n ** BigInt(scale),
            ),
            `${line} exposure`,
          );

    pairs.push({
      invoiceLineId: invoice.id,
      poLineId: po.id,
      matchedBy,
      status,
      invoiceUnitPriceMinor: invoice.unitPriceMinor,
      poUnitPriceMinor: po.unitPriceMinor,
      priceDeltaMinor: addExact(invoice.unitPriceMinor, -po.unitPriceMinor, `${line} price delta`),
      invoiceQuantity: invoice.quantity,
      poQuantity: po.quantity,
      receivedQuantity,
      quantityDelta: decimalNumber(
        addDecimal(invoiceQuantity, poQuantity, -1n),
        `${line} quantity delta`,
      ),
      exposureMinor,
      reasons,
    });
  }

  const exceptions = pairs.filter((p) => p.status !== "matched").length;
  return {
    pairs,
    unmatchedInvoiceLines,
    unmatchedPoLines: [...remainingPo.keys()],
    ok: exceptions === 0 && unmatchedInvoiceLines.length === 0,
    exceptions,
    totalExposureMinor: sumExact(
      pairs.map((p) => p.exposureMinor),
      "the total exposure",
    ),
    threeWay: receiptLines.length > 0,
  };
}

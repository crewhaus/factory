/**
 * Three-way match: invoice against purchase order against goods receipt.
 *
 * This is the standard accounts-payable control, and it is entirely
 * mechanical — pair the lines, compare price and quantity, and report what
 * falls outside tolerance. A model reading two documents to decide whether
 * 4,800 matches 4,750 is being paid to do subtraction, and it will sometimes
 * get it wrong on an invoice nobody re-reads.
 */

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
  /** What the variance costs, positive when the invoice asks for more. */
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

function withinTolerance(
  actual: number,
  expected: number,
  percentBps: number | undefined,
  absolute: number | undefined,
): boolean {
  const delta = Math.abs(actual - expected);
  if (delta === 0) return true;
  // Either bound may pass. A percentage alone is useless on a cheap line and
  // an absolute alone is useless on an expensive one.
  const byPercent = percentBps !== undefined && Math.abs(expected) * percentBps >= delta * 10_000;
  const byAbsolute = absolute !== undefined && delta <= absolute;
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

  const received = new Map<string, number>();
  for (const entry of receiptLines) {
    received.set(entry.poLineId, (received.get(entry.poLineId) ?? 0) + entry.quantity);
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
    const priceOk = withinTolerance(
      invoice.unitPriceMinor,
      po.unitPriceMinor,
      tolerance.pricePercentBps,
      tolerance.priceAbsoluteMinor,
    );
    const quantityOk = withinTolerance(
      invoice.quantity,
      po.quantity,
      tolerance.quantityPercentBps,
      tolerance.quantityAbsolute,
    );
    if (!priceOk) {
      reasons.push(
        `unit price ${invoice.unitPriceMinor} against ${po.unitPriceMinor} on the order`,
      );
    }
    if (!quantityOk) {
      reasons.push(`quantity ${invoice.quantity} against ${po.quantity} on the order`);
    }

    const receivedQuantity = received.has(po.id) ? (received.get(po.id) as number) : null;
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
      if (receivedQuantity === null || receivedQuantity === 0) {
        status = "not-received";
        reasons.push("nothing has been received against this order line");
      } else if (invoice.quantity > receivedQuantity) {
        status = "over-receipt";
        reasons.push(`invoiced ${invoice.quantity} but only ${receivedQuantity} received`);
      }
    }

    const billable = Math.min(invoice.quantity, receivedQuantity ?? invoice.quantity);
    const exposureMinor =
      invoice.quantity * invoice.unitPriceMinor -
      billable * Math.min(invoice.unitPriceMinor, po.unitPriceMinor);

    pairs.push({
      invoiceLineId: invoice.id,
      poLineId: po.id,
      matchedBy,
      status,
      invoiceUnitPriceMinor: invoice.unitPriceMinor,
      poUnitPriceMinor: po.unitPriceMinor,
      priceDeltaMinor: invoice.unitPriceMinor - po.unitPriceMinor,
      invoiceQuantity: invoice.quantity,
      poQuantity: po.quantity,
      receivedQuantity,
      quantityDelta: invoice.quantity - po.quantity,
      exposureMinor: status === "matched" ? 0 : exposureMinor,
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
    totalExposureMinor: pairs.reduce((s, p) => s + p.exposureMinor, 0),
    threeWay: receiptLines.length > 0,
  };
}

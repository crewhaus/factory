/**
 * Splitting money without losing or inventing any.
 *
 * Allocating an order-level discount across lines, or tax across returned
 * items, is the place cents go missing: divide, round each share, and the
 * shares no longer sum to what you started with. The refund is then a cent
 * short, or a cent over, and the ledger does not balance.
 *
 * Largest-remainder allocation fixes that by construction: the shares always
 * sum to the total, exactly, whatever the weights.
 */

/**
 * Split `totalMinor` across `weights` so the parts sum to it exactly.
 *
 * Each part is the floor of its exact share; the leftover units go to the
 * largest remainders, ties broken by position so the answer is stable. With
 * all-zero weights the total is spread evenly from the front rather than
 * dropped, since dropping it would silently lose the money.
 */
export function allocateProportional(totalMinor: number, weights: ReadonlyArray<number>): number[] {
  if (!Number.isInteger(totalMinor)) throw new Error("totalMinor must be an integer");
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) throw new Error("weights must not be negative");

  const sum = weights.reduce((a, b) => a + b, 0);
  const negative = totalMinor < 0;
  const magnitude = Math.abs(totalMinor);

  if (sum === 0) {
    // Nothing to weigh by. Spread evenly rather than returning zeros, which
    // would drop the amount entirely.
    const base = Math.floor(magnitude / weights.length);
    const parts = weights.map(() => base);
    let leftover = magnitude - base * weights.length;
    for (let i = 0; leftover > 0; i = (i + 1) % weights.length, leftover--) {
      parts[i] = (parts[i] as number) + 1;
    }
    return negative ? parts.map((p) => -p) : parts;
  }

  const exact = weights.map((w) => (magnitude * w) / sum);
  const parts = exact.map((value) => Math.floor(value));
  let leftover = magnitude - parts.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; leftover > 0; i++, leftover--) {
    const target = order[i % order.length]?.index as number;
    parts[target] = (parts[target] as number) + 1;
  }
  return negative ? parts.map((p) => -p) : parts;
}

export type OrderLine = {
  readonly id: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  /** Tax charged on this line as invoiced. */
  readonly taxMinor?: number;
  /** A discount already applied to this line, as invoiced. */
  readonly discountMinor?: number;
};

export type ReturnedLine = { readonly lineId: string; readonly quantity: number };

export const SHIPPING_POLICIES = ["none", "proportional", "full"] as const;
export type ShippingPolicy = (typeof SHIPPING_POLICIES)[number];

export type RefundOptions = {
  /** A discount applied to the order as a whole, to be spread over lines. */
  readonly orderDiscountMinor?: number;
  readonly shippingMinor?: number;
  readonly shippingPolicy?: ShippingPolicy;
  /** Kept by the merchant, subtracted from the refund. */
  readonly restockingFeeMinor?: number;
};

export type RefundLineResult = {
  readonly lineId: string;
  readonly quantity: number;
  readonly grossMinor: number;
  readonly lineDiscountMinor: number;
  readonly orderDiscountMinor: number;
  readonly taxMinor: number;
  readonly refundMinor: number;
};

export type RefundResult = {
  readonly lines: ReadonlyArray<RefundLineResult>;
  readonly shippingMinor: number;
  readonly restockingFeeMinor: number;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly fullReturn: boolean;
};

/**
 * What to refund for a partial return.
 *
 * Both allocations are proportional to what the customer actually paid for
 * the returned units: an order-level discount applies to them in the same
 * proportion it applied to the order, and tax follows the discounted amount.
 * Refunding the list price of a discounted item refunds more than was taken.
 */
export function computeRefund(
  lines: ReadonlyArray<OrderLine>,
  returned: ReadonlyArray<ReturnedLine>,
  options: RefundOptions = {},
): RefundResult {
  const index = new Map(lines.map((l) => [l.id, l]));
  for (const item of returned) {
    const line = index.get(item.lineId);
    if (!line) throw new Error(`returned line "${item.lineId}" is not in the order`);
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(
        `returned line "${item.lineId}" has quantity ${item.quantity}; it must be a positive integer`,
      );
    }
    if (item.quantity > line.quantity) {
      throw new Error(
        `returned line "${item.lineId}" returns ${item.quantity} of ${line.quantity} ordered`,
      );
    }
  }

  // The order discount is spread over ALL lines by their net value, then the
  // returned fraction of each line's share comes back. Spreading it over the
  // returned lines only would refund the whole discount on a partial return.
  const lineNet = lines.map((l) => l.quantity * l.unitPriceMinor - (l.discountMinor ?? 0));
  const orderDiscountShares = allocateProportional(options.orderDiscountMinor ?? 0, lineNet);
  const shareByLine = new Map(lines.map((l, i) => [l.id, orderDiscountShares[i] as number]));

  const results: RefundLineResult[] = [];
  for (const item of returned) {
    const line = index.get(item.lineId) as OrderLine;
    const fraction = [item.quantity, line.quantity] as const;
    const gross = line.unitPriceMinor * item.quantity;

    const lineDiscount = splitByQuantity(line.discountMinor ?? 0, fraction);
    const orderDiscount = splitByQuantity(shareByLine.get(line.id) ?? 0, fraction);
    const tax = splitByQuantity(line.taxMinor ?? 0, fraction);

    results.push({
      lineId: line.id,
      quantity: item.quantity,
      grossMinor: gross,
      lineDiscountMinor: lineDiscount,
      orderDiscountMinor: orderDiscount,
      taxMinor: tax,
      refundMinor: gross - lineDiscount - orderDiscount + tax,
    });
  }

  const fullReturn = lines.every(
    (l) => (returned.find((r) => r.lineId === l.id)?.quantity ?? 0) === l.quantity,
  );
  const policy = options.shippingPolicy ?? "none";
  const shippingTotal = options.shippingMinor ?? 0;
  let shippingMinor = 0;
  if (policy === "full" || (policy === "proportional" && fullReturn)) {
    shippingMinor = shippingTotal;
  } else if (policy === "proportional") {
    // Spread the shipping over EVERY line by its value, then take only the
    // returned fraction of each share. Allocating across the returned lines
    // and summing the parts gives back the whole amount every time — an
    // allocation's parts always sum to what was allocated — so a one-item
    // return refunded the entire shipping charge.
    const shares = allocateProportional(
      shippingTotal,
      lines.map((l) => l.quantity * l.unitPriceMinor),
    );
    shippingMinor = lines.reduce((total, line, i) => {
      const returnedQuantity = returned.find((r) => r.lineId === line.id)?.quantity ?? 0;
      if (returnedQuantity === 0) return total;
      return total + splitByQuantity(shares[i] as number, [returnedQuantity, line.quantity]);
    }, 0);
  }

  const subtotalMinor = results.reduce(
    (s, r) => s + r.grossMinor - r.lineDiscountMinor - r.orderDiscountMinor,
    0,
  );
  const taxMinor = results.reduce((s, r) => s + r.taxMinor, 0);
  const restockingFeeMinor = options.restockingFeeMinor ?? 0;

  return {
    lines: results,
    shippingMinor,
    restockingFeeMinor,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor + shippingMinor - restockingFeeMinor,
    fullReturn,
  };
}

/**
 * The returned fraction of a line-level amount.
 *
 * Allocating across the line's units and summing the returned ones — rather
 * than multiplying by a fraction and rounding — is what makes the parts of a
 * fully returned line add back up to the whole.
 */
function splitByQuantity(
  amountMinor: number,
  [returned, total]: readonly [number, number],
): number {
  if (total <= 0 || amountMinor === 0) return 0;
  const perUnit = allocateProportional(amountMinor, new Array(total).fill(1));
  return perUnit.slice(0, returned).reduce((a, b) => a + b, 0);
}

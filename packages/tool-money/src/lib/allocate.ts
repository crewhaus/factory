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

import { big, toNumber } from "./exact";

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
  if (weights.some((w) => w < 0)) throw new Error("weights must not be negative");
  return allocateExact(
    big(totalMinor, "totalMinor"),
    weights.map((w, i) => big(w, `weight ${i}`)),
  ).map((part, i) => toNumber(part, `share ${i}`));
}

/**
 * {@link allocateProportional} in exact integers. Each share's exact value is
 * a quotient and a remainder over the weights' sum, so the largest remainders
 * are compared exactly: a double's `magnitude × weight` passes 2^53 on an
 * ordinary invoice's cents times its lines' values.
 */
export function allocateExact(total: bigint, weights: ReadonlyArray<bigint>): bigint[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0n)) throw new Error("weights must not be negative");

  const sum = weights.reduce((a, b) => a + b, 0n);
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const count = BigInt(weights.length);

  if (sum === 0n) {
    // Nothing to weigh by. Spread evenly rather than returning zeros, which
    // would drop the amount entirely.
    const base = magnitude / count;
    const leftover = magnitude - base * count;
    const parts = weights.map((_, i) => (BigInt(i) < leftover ? base + 1n : base));
    return negative ? parts.map((p) => -p) : parts;
  }

  const parts = weights.map((w) => (magnitude * w) / sum);
  const leftover = magnitude - parts.reduce((a, b) => a + b, 0n);

  // The leftover is smaller than the number of shares, so it goes one unit
  // each to the largest remainders, ties broken by position.
  const order = weights
    .map((w, index) => ({ index, remainder: (magnitude * w) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (let i = 0n; i < leftover; i++) {
    const target = order[Number(i) % order.length]?.index as number;
    parts[target] = (parts[target] as bigint) + 1n;
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

  // Exact throughout (see ./exact): a line's value is quantity × price, and
  // the allocations multiply amounts by values again.
  const unitPrice = (l: OrderLine): bigint =>
    big(l.unitPriceMinor, `line "${l.id}" unitPriceMinor`);
  const lineGross = (l: OrderLine): bigint =>
    big(l.quantity, `line "${l.id}" quantity`) * unitPrice(l);

  // The order discount is spread over ALL lines by their net value, then the
  // returned fraction of each line's share comes back. Spreading it over the
  // returned lines only would refund the whole discount on a partial return.
  const lineNet = lines.map(
    (l) => lineGross(l) - big(l.discountMinor ?? 0, `line "${l.id}" discountMinor`),
  );
  if (lineNet.some((net) => net < 0n)) throw new Error("weights must not be negative");
  const orderDiscountShares = allocateExact(
    big(options.orderDiscountMinor ?? 0, "orderDiscountMinor"),
    lineNet,
  );
  const shareByLine = new Map(lines.map((l, i) => [l.id, orderDiscountShares[i] as bigint]));

  const results: RefundLineResult[] = [];
  let subtotal = 0n;
  let taxTotal = 0n;
  for (const item of returned) {
    const line = index.get(item.lineId) as OrderLine;
    const fraction = [BigInt(item.quantity), BigInt(line.quantity)] as const;
    const gross = unitPrice(line) * BigInt(item.quantity);

    const lineDiscount = splitByQuantity(big(line.discountMinor ?? 0, "discountMinor"), fraction);
    const orderDiscount = splitByQuantity(shareByLine.get(line.id) ?? 0n, fraction);
    const tax = splitByQuantity(big(line.taxMinor ?? 0, "taxMinor"), fraction);
    subtotal += gross - lineDiscount - orderDiscount;
    taxTotal += tax;

    const what = `returned line "${line.id}"`;
    results.push({
      lineId: line.id,
      quantity: item.quantity,
      grossMinor: toNumber(gross, `${what} gross`),
      lineDiscountMinor: toNumber(lineDiscount, `${what} line discount`),
      orderDiscountMinor: toNumber(orderDiscount, `${what} order discount`),
      taxMinor: toNumber(tax, `${what} tax`),
      refundMinor: toNumber(gross - lineDiscount - orderDiscount + tax, `${what} refund`),
    });
  }

  const fullReturn = lines.every(
    (l) => (returned.find((r) => r.lineId === l.id)?.quantity ?? 0) === l.quantity,
  );
  const policy = options.shippingPolicy ?? "none";
  const shippingTotal = big(options.shippingMinor ?? 0, "shippingMinor");
  let shipping = 0n;
  if (policy === "full" || (policy === "proportional" && fullReturn)) {
    shipping = shippingTotal;
  } else if (policy === "proportional") {
    // Spread the shipping over EVERY line by its value, then take only the
    // returned fraction of each share. Allocating across the returned lines
    // and summing the parts gives back the whole amount every time — an
    // allocation's parts always sum to what was allocated — so a one-item
    // return refunded the entire shipping charge.
    const shares = allocateExact(shippingTotal, lines.map(lineGross));
    lines.forEach((line, i) => {
      const returnedQuantity = returned.find((r) => r.lineId === line.id)?.quantity ?? 0;
      if (returnedQuantity === 0) return;
      shipping += splitByQuantity(shares[i] as bigint, [
        BigInt(returnedQuantity),
        BigInt(line.quantity),
      ]);
    });
  }

  const restocking = big(options.restockingFeeMinor ?? 0, "restockingFeeMinor");

  return {
    lines: results,
    shippingMinor: toNumber(shipping, "the refunded shipping"),
    restockingFeeMinor: toNumber(restocking, "the restocking fee"),
    subtotalMinor: toNumber(subtotal, "the refund subtotal"),
    taxMinor: toNumber(taxTotal, "the refunded tax"),
    totalMinor: toNumber(subtotal + taxTotal + shipping - restocking, "the refund total"),
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
function splitByQuantity(amount: bigint, [returned, total]: readonly [bigint, bigint]): bigint {
  if (total <= 0n || amount === 0n) return 0n;
  // The per-unit allocation of `amount` over `total` equal units, summed over
  // the first `returned` of them — in closed form. Every unit gets the same
  // floor share and the leftover goes one unit each to the first ones (equal
  // remainders break ties by position). 0.7.0 built that array of `total`
  // units, so a line with a quantity in the millions allocated millions.
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const base = magnitude / total;
  const leftover = magnitude - base * total;
  const part = returned * base + (returned < leftover ? returned : leftover);
  return negative ? -part : part;
}

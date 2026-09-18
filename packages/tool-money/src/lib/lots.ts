/**
 * Lot consumption and realized gain.
 *
 * Which lots a disposal consumes is a policy choice with a tax consequence,
 * and once the policy is chosen the arithmetic is fixed. A model asked to do
 * this will produce a plausible number that cannot be reproduced next
 * quarter, which is the one property a cost-basis figure must have.
 *
 * Cost is integer minor units. Quantity is a decimal, because a lot can be
 * 0.37 of a share or of a coin — but the cost attached to a lot is tracked
 * as an integer remainder and the final consumption takes whatever is left,
 * so a fully consumed lot always accounts for exactly its cost with no
 * rounding drift.
 */

export const LOT_METHODS = ["fifo", "lifo", "hifo", "specific"] as const;
export type LotMethod = (typeof LOT_METHODS)[number];

export type Lot = {
  readonly id: string;
  /** ISO-8601 with an offset. Acquisition time. */
  readonly acquiredAt: string;
  readonly quantity: number;
  /** What the whole lot cost, in minor units. */
  readonly costMinor: number;
};

export type Disposal = {
  readonly id: string;
  readonly disposedAt: string;
  readonly quantity: number;
  /** What the whole disposal realized, in minor units. */
  readonly proceedsMinor: number;
  /** `specific` only: which lots to consume, in order. */
  readonly lotIds?: ReadonlyArray<string>;
};

export type Consumption = {
  readonly lotId: string;
  readonly quantity: number;
  readonly costMinor: number;
  readonly acquiredAt: string;
  /** True when held over a year, which most jurisdictions treat differently. */
  readonly longTerm: boolean;
};

export type DisposalResult = {
  readonly id: string;
  readonly quantity: number;
  readonly proceedsMinor: number;
  readonly costMinor: number;
  readonly gainMinor: number;
  readonly shortTermGainMinor: number;
  readonly longTermGainMinor: number;
  readonly consumed: ReadonlyArray<Consumption>;
};

export type CostBasisResult = {
  readonly method: LotMethod;
  readonly disposals: ReadonlyArray<DisposalResult>;
  readonly realizedGainMinor: number;
  readonly remainingLots: ReadonlyArray<Lot>;
  readonly remainingQuantity: number;
  readonly remainingCostMinor: number;
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function instant(value: string, what: string): number {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    throw new Error(
      `${what} ("${value}") has no UTC offset — an offset-less timestamp means local time and would put a holding period on the wrong side of a year boundary depending on the machine`,
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${what} ("${value}") is not a valid ISO-8601 instant`);
  return parsed;
}

export function computeCostBasis(
  lots: ReadonlyArray<Lot>,
  disposals: ReadonlyArray<Disposal>,
  method: LotMethod,
): CostBasisResult {
  const seen = new Set<string>();
  for (const lot of lots) {
    if (seen.has(lot.id)) throw new Error(`two lots share the id "${lot.id}"`);
    seen.add(lot.id);
    if (lot.quantity <= 0) throw new Error(`lot "${lot.id}" has quantity ${lot.quantity}`);
    if (!Number.isInteger(lot.costMinor))
      throw new Error(`lot "${lot.id}" cost must be minor units`);
    instant(lot.acquiredAt, `lot "${lot.id}" acquiredAt`);
  }

  // Working copies: remaining cost is an integer so a lot cannot drift.
  const open = lots.map((lot) => ({
    ...lot,
    remainingQuantity: lot.quantity,
    remainingCostMinor: lot.costMinor,
    acquiredMs: instant(lot.acquiredAt, "acquiredAt"),
  }));

  const results: DisposalResult[] = [];

  for (const disposal of disposals) {
    const disposedMs = instant(disposal.disposedAt, `disposal "${disposal.id}" disposedAt`);
    if (disposal.quantity <= 0) {
      throw new Error(`disposal "${disposal.id}" has quantity ${disposal.quantity}`);
    }

    let order = open.filter((l) => l.remainingQuantity > 0);
    if (method === "specific") {
      const wanted = disposal.lotIds;
      if (!wanted || wanted.length === 0) {
        throw new Error(
          `disposal "${disposal.id}" uses the specific-identification method but names no lots`,
        );
      }
      const index = new Map(order.map((l) => [l.id, l]));
      order = wanted.map((id) => {
        const lot = index.get(id);
        if (!lot) {
          throw new Error(`disposal "${disposal.id}" names lot "${id}", which is not open`);
        }
        return lot;
      });
    } else if (method === "fifo") {
      order = [...order].sort((a, b) => a.acquiredMs - b.acquiredMs || (a.id < b.id ? -1 : 1));
    } else if (method === "lifo") {
      order = [...order].sort((a, b) => b.acquiredMs - a.acquiredMs || (a.id < b.id ? -1 : 1));
    } else {
      // Highest cost per unit first, which realizes the smallest gain.
      order = [...order].sort(
        (a, b) =>
          b.remainingCostMinor / b.remainingQuantity - a.remainingCostMinor / a.remainingQuantity ||
          (a.id < b.id ? -1 : 1),
      );
    }

    let toConsume = disposal.quantity;
    const consumed: Consumption[] = [];
    let costMinor = 0;

    for (const lot of order) {
      if (toConsume <= 0) break;
      const take = Math.min(toConsume, lot.remainingQuantity);
      // Taking the whole remainder consumes the whole remaining cost. That
      // is what keeps a lot's costs summing to exactly what it cost, however
      // many partial disposals came before.
      const takeCost =
        take === lot.remainingQuantity
          ? lot.remainingCostMinor
          : Math.round((lot.remainingCostMinor * take) / lot.remainingQuantity);
      lot.remainingQuantity -= take;
      lot.remainingCostMinor -= takeCost;
      toConsume -= take;
      costMinor += takeCost;
      consumed.push({
        lotId: lot.id,
        quantity: take,
        costMinor: takeCost,
        acquiredAt: lot.acquiredAt,
        longTerm: disposedMs - lot.acquiredMs > YEAR_MS,
      });
    }

    if (toConsume > 1e-9) {
      throw new Error(
        `disposal "${disposal.id}" needs ${disposal.quantity} but only ${disposal.quantity - toConsume} was open — a disposal cannot exceed the lots held`,
      );
    }

    // Proceeds follow the units, so the split between short and long term is
    // allocated by quantity rather than by cost.
    const gainMinor = disposal.proceedsMinor - costMinor;
    let longTermProceeds = 0;
    let longTermCost = 0;
    for (const entry of consumed) {
      if (!entry.longTerm) continue;
      longTermProceeds += Math.round((disposal.proceedsMinor * entry.quantity) / disposal.quantity);
      longTermCost += entry.costMinor;
    }
    const longTermGainMinor = longTermProceeds - longTermCost;

    results.push({
      id: disposal.id,
      quantity: disposal.quantity,
      proceedsMinor: disposal.proceedsMinor,
      costMinor,
      gainMinor,
      longTermGainMinor,
      shortTermGainMinor: gainMinor - longTermGainMinor,
      consumed,
    });
  }

  const remaining = open.filter((l) => l.remainingQuantity > 0);
  return {
    method,
    disposals: results,
    realizedGainMinor: results.reduce((s, r) => s + r.gainMinor, 0),
    remainingLots: remaining.map((l) => ({
      id: l.id,
      acquiredAt: l.acquiredAt,
      quantity: l.remainingQuantity,
      costMinor: l.remainingCostMinor,
    })),
    remainingQuantity: remaining.reduce((s, l) => s + l.remainingQuantity, 0),
    remainingCostMinor: remaining.reduce((s, l) => s + l.remainingCostMinor, 0),
  };
}

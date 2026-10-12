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
 *
 * Quantities are counted as exact decimals, not as doubles. Each is read as
 * the decimal it is written as (0.1 is one tenth, not the binary fraction
 * nearest it), and every lot and disposal is scaled to the same number of
 * decimal places as a bigint. So ten disposals of 0.1 leave nothing of a lot
 * of 1, and five units left of a lot of ten billion stay five units — where a
 * tolerance for binary noise would have to guess which remainders are real.
 */

import { addExact, big, decimalOf, mathRound, sumExact, toNumber } from "./exact";

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

/*
 * A disposal may come up short of the lots by up to 1e-9 units and still be
 * read as consuming them: a caller's own float sum (0.1 + 0.2 is
 * 0.30000000000000004) is not a claim to hold more than was bought.
 */

/** `units / 10^scale` back as a number: the double nearest the exact decimal. */
function quantityNumber(units: bigint, scale: number): number {
  if (scale === 0) return Number(units);
  const negative = units < 0n;
  const text = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const value = Number(`${text.slice(0, -scale)}.${text.slice(-scale)}`);
  return negative ? -value : value;
}

/**
 * Move `heap[at]` down past every child taken before it. `before(a, b)` is
 * negative when `a` is taken first; no two lots tie.
 */
function siftDown<T>(heap: T[], at: number, before: (a: T, b: T) => number): void {
  const item = heap[at] as T;
  let i = at;
  for (;;) {
    const left = 2 * i + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const first =
      right < heap.length && before(heap[right] as T, heap[left] as T) < 0 ? right : left;
    if (before(heap[first] as T, item) >= 0) break;
    heap[i] = heap[first] as T;
    i = first;
  }
  heap[i] = item;
}

/** Drop the top of the heap. */
function popTop<T>(heap: T[], before: (a: T, b: T) => number): void {
  const last = heap.pop() as T;
  if (heap.length === 0) return;
  heap[0] = last;
  siftDown(heap, 0, before);
}

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
    big(lot.costMinor, `lot "${lot.id}" costMinor`);
    instant(lot.acquiredAt, `lot "${lot.id}" acquiredAt`);
  }

  for (const disposal of disposals) {
    if (disposal.quantity <= 0) {
      throw new Error(`disposal "${disposal.id}" has quantity ${disposal.quantity}`);
    }
  }
  // Every quantity on one decimal scale, so each subtraction is exact.
  const quantities = [
    ...lots.map((l) => decimalOf(l.quantity, `lot "${l.id}" quantity`)),
    ...disposals.map((d) => decimalOf(d.quantity, `disposal "${d.id}" quantity`)),
  ];
  const scale = quantities.reduce((most, q) => Math.max(most, q.scale), 0);
  const scaled = (value: number, what: string): bigint => {
    const q = decimalOf(value, what);
    return q.units * 10n ** BigInt(scale - q.scale);
  };
  // SHORTFALL_TOLERANCE on this scale; nothing when the scale is coarser.
  const shortfallAllowed = scale >= 9 ? 10n ** BigInt(scale - 9) : 0n;

  // Working copies: remaining cost is an integer so a lot cannot drift.
  const open = lots.map((lot) => ({
    ...lot,
    remainingUnits: scaled(lot.quantity, `lot "${lot.id}" quantity`),
    remainingCostMinor: lot.costMinor,
    acquiredMs: instant(lot.acquiredAt, "acquiredAt"),
  }));

  const results: DisposalResult[] = [];

  // Which open lot a disposal takes first, for the ordered methods. A
  // negative answer means `a` goes before `b`; ids are unique, so no two lots
  // tie.
  type OpenLot = (typeof open)[number];
  const byId = (a: OpenLot, b: OpenLot): number => (a.id < b.id ? -1 : 1);
  const takenBefore: ((a: OpenLot, b: OpenLot) => number) | undefined =
    method === "fifo"
      ? (a, b) => a.acquiredMs - b.acquiredMs || byId(a, b)
      : method === "lifo"
        ? (a, b) => b.acquiredMs - a.acquiredMs || byId(a, b)
        : method === "hifo"
          ? (a, b) => {
              // Highest cost per unit first, which realizes the smallest
              // gain — compared by cross-multiplying, so two lots a float
              // would call equal are still told apart.
              const left = BigInt(b.remainingCostMinor) * a.remainingUnits;
              const right = BigInt(a.remainingCostMinor) * b.remainingUnits;
              return left > right ? 1 : left < right ? -1 : byId(a, b);
            }
          : undefined;
  // The open lots as a binary heap in that order, the next lot to take at
  // the top. A disposal takes lots off the top; the only lot whose place can
  // change is the one it took part of (its cost per unit moves by the
  // rounding of that part), and that one is sifted to where it now belongs.
  // Re-sorting every open lot for every disposal made HIFO quadratic in the
  // lots at the schema's limit, and so did moving the part-taken lot within
  // a sorted list: rounding can send it from the front to the back. A list
  // sorted once is already a heap.
  const heap = takenBefore === undefined ? [] : [...open].sort(takenBefore);
  // Every lot by its id, built once, for the specific method. A lot is open
  // while it has units left; that is read at lookup, where an index of the
  // open lots rebuilt for every disposal cost the lots times the disposals.
  const lotById = new Map(method === "specific" ? open.map((lot) => [lot.id, lot]) : []);

  for (const disposal of disposals) {
    const disposedMs = instant(disposal.disposedAt, `disposal "${disposal.id}" disposedAt`);

    let named: ReadonlyArray<OpenLot> = [];
    if (method === "specific") {
      const wanted = disposal.lotIds;
      if (!wanted || wanted.length === 0) {
        throw new Error(
          `disposal "${disposal.id}" uses the specific-identification method but names no lots`,
        );
      }
      named = wanted.map((id) => {
        const lot = lotById.get(id);
        if (lot === undefined || lot.remainingUnits <= 0n) {
          throw new Error(`disposal "${disposal.id}" names lot "${id}", which is not open`);
        }
        return lot;
      });
    }

    const disposalUnits = scaled(disposal.quantity, `disposal "${disposal.id}" quantity`);
    let toConsume = disposalUnits;
    const consumed: Array<Consumption & { readonly units: bigint }> = [];
    let costMinor = 0;

    // The named lots in turn, or the top of the heap until the disposal is
    // met: a lot taken whole leaves the heap, and the one taken in part is
    // sifted down from the top to its new place.
    for (let at = 0; toConsume > 0n; at++) {
      const lot = takenBefore === undefined ? named[at] : heap[0];
      if (lot === undefined) break;
      // Taking the whole remainder consumes the whole remaining cost. That
      // is what keeps a lot's costs summing to exactly what it cost, however
      // many partial disposals came before.
      const whole = toConsume >= lot.remainingUnits;
      const take = whole ? lot.remainingUnits : toConsume;
      const takeCost = whole
        ? lot.remainingCostMinor
        : toNumber(
            mathRound(BigInt(lot.remainingCostMinor) * take, lot.remainingUnits),
            `disposal "${disposal.id}" cost`,
          );
      lot.remainingUnits -= take;
      lot.remainingCostMinor = addExact(
        lot.remainingCostMinor,
        -takeCost,
        `lot "${lot.id}" remaining cost`,
      );
      toConsume -= take;
      costMinor = addExact(costMinor, takeCost, `disposal "${disposal.id}" cost`);
      consumed.push({
        lotId: lot.id,
        quantity: quantityNumber(take, scale),
        units: take,
        costMinor: takeCost,
        acquiredAt: lot.acquiredAt,
        longTerm: disposedMs - lot.acquiredMs > YEAR_MS,
      });
      if (takenBefore !== undefined) {
        if (lot.remainingUnits === 0n) popTop(heap, takenBefore);
        else siftDown(heap, 0, takenBefore);
      }
    }

    if (toConsume > shortfallAllowed) {
      throw new Error(
        `disposal "${disposal.id}" needs ${disposal.quantity} but only ${quantityNumber(disposalUnits - toConsume, scale)} was open — a disposal cannot exceed the lots held`,
      );
    }

    // Proceeds follow the units, so the split between short and long term is
    // allocated by quantity rather than by cost.
    const what = `disposal "${disposal.id}"`;
    const proceeds = big(disposal.proceedsMinor, `${what} proceedsMinor`);
    const gainMinor = toNumber(proceeds - big(costMinor, what), `${what} gain`);
    let longTermProceeds = 0n;
    let longTermCost = 0n;
    for (const entry of consumed) {
      if (!entry.longTerm) continue;
      longTermProceeds += mathRound(proceeds * entry.units, disposalUnits);
      longTermCost += big(entry.costMinor, what);
    }
    const longTermGainMinor = toNumber(longTermProceeds - longTermCost, `${what} long-term gain`);

    results.push({
      id: disposal.id,
      quantity: disposal.quantity,
      proceedsMinor: disposal.proceedsMinor,
      costMinor,
      gainMinor,
      longTermGainMinor,
      shortTermGainMinor: addExact(gainMinor, -longTermGainMinor, `${what} short-term gain`),
      consumed: consumed.map(({ units: _units, ...entry }) => entry),
    });
  }

  const remaining = open.filter((l) => l.remainingUnits > 0n);
  return {
    method,
    disposals: results,
    realizedGainMinor: sumExact(
      results.map((r) => r.gainMinor),
      "the realized gain",
    ),
    remainingLots: remaining.map((l) => ({
      id: l.id,
      acquiredAt: l.acquiredAt,
      quantity: quantityNumber(l.remainingUnits, scale),
      costMinor: l.remainingCostMinor,
    })),
    remainingQuantity: quantityNumber(
      remaining.reduce((sum, l) => sum + l.remainingUnits, 0n),
      scale,
    ),
    remainingCostMinor: sumExact(
      remaining.map((l) => l.remainingCostMinor),
      "the remaining cost",
    ),
  };
}

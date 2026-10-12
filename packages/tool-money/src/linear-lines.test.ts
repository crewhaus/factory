/**
 * Matching, refunds and HIFO each read a line a bounded number of times.
 *
 * Three loops searched one whole list once per entry of another, each over
 * model JSON the schema allows thousands of lines of:
 *
 *   - PurchaseOrderMatch searched every remaining order line, twice, for
 *     each invoice line with no reference, and normalized every order line's
 *     description again each time;
 *   - RefundAmountCompute searched the returned lines once per order line;
 *   - CostBasisCompute put the lot a HIFO disposal took part of back into a
 *     sorted list with a splice, and rounding can send that lot from the
 *     front of the list to the back every time.
 *
 * Now the order lines are grouped by SKU and by description once, the
 * returned quantities are a map, and the open lots are a binary heap. The
 * answers are unchanged: each test of the work has one beside it comparing
 * against the search it replaced.
 *
 * The work is counted by `listWork` below, never timed.
 */
import { describe, expect, test } from "bun:test";
import { computeRefund } from "./lib/allocate";
import { mathRound } from "./lib/exact";
import { type LotMethod, computeCostBasis } from "./lib/lots";
import { type MatchLine, matchInvoiceToPurchaseOrder } from "./lib/match";

/**
 * The list work `body` did: every element an array's or a Map's iterator
 * handed out (a `for…of`, a spread, `new Map(array)`), every callback of
 * `find`, `findIndex`, `some`, `every`, `filter` and `forEach`, every
 * element a `splice` or `copyWithin` moved, and every `toLowerCase` (the
 * first step of normalizing a description). Past `limit` the next one throws
 * instead of running, and the work reads as Infinity. Every original is put
 * back before this returns. A loop that reads `lines[i]` by hand, or a Map
 * lookup, is not seen.
 */
function listWork<T>(limit: number, body: () => T): { value: T | undefined; work: number } {
  const OVER = Symbol("over the limit");
  const counter = { work: 0 };
  const charge = (n: number): void => {
    counter.work += n;
    if (counter.work > limit) throw OVER;
  };
  type Fn = (this: unknown, ...args: unknown[]) => unknown;
  const arrays = Array.prototype as unknown as Record<string, Fn>;
  const strings = String.prototype as unknown as Record<string, Fn>;
  const iterators = [
    Object.getPrototypeOf([][Symbol.iterator]()),
    Object.getPrototypeOf(new Map().values()),
  ] as Array<Record<string, Fn>>;
  const saved: Array<{ target: Record<string, Fn>; name: string; real: Fn }> = [];
  const wrap = (target: Record<string, Fn>, name: string, make: (real: Fn) => Fn): void => {
    const real = target[name] as Fn;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
  for (const name of ["find", "findIndex", "some", "every", "filter", "forEach"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, fn: unknown, thisArg?: unknown) {
          const visit = fn as Fn;
          return real.call(this, (...args: unknown[]) => {
            charge(1);
            return visit.apply(thisArg, args);
          });
        },
    );
  }
  for (const name of ["splice", "copyWithin"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const length = (this as unknown[]).length;
          const start = Number(args[0] ?? 0);
          charge(Math.max(0, length - (start < 0 ? Math.max(0, length + start) : start)));
          return real.apply(this, args);
        },
    );
  }
  wrap(
    strings,
    "toLowerCase",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        charge(1);
        return real.apply(this, args);
      },
  );
  // The iterators last, and by index: a `for…of` here would be counted.
  for (let i = 0; i < iterators.length; i++) {
    wrap(
      iterators[i] as Record<string, Fn>,
      "next",
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const out = real.apply(this, args) as IteratorResult<unknown>;
          if (out.done !== true) charge(1);
          return out;
        },
    );
  }
  try {
    return { value: body(), work: counter.work };
  } catch (err) {
    if (err !== OVER) throw err;
    return { value: undefined, work: Number.POSITIVE_INFINITY };
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { target, name, real } = saved[i] as (typeof saved)[number];
      target[name] = real;
    }
  }
}

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** List work per line of input; between 4 and 9 here. */
const WORK_PER_LINE = 24;

describe("PurchaseOrderMatch reads each order line a bounded number of times", () => {
  test("invoice lines that no order line matches by SKU or description, at n and 2n", () => {
    const measured = [2_000, 4_000].map((n) => {
      const po = Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        sku: `S${i}`,
        description: `Widget model ${i}`,
        quantity: 1,
        unitPriceMinor: 100,
      }));
      const invoice = Array.from({ length: n }, (_, i) => ({
        id: `i${i}`,
        sku: `X${i}`,
        description: `Gadget kind ${i}`,
        quantity: 1,
        unitPriceMinor: 100,
      }));
      const lines = 2 * n;
      const run = listWork(WORK_PER_LINE * lines, () => matchInvoiceToPurchaseOrder(invoice, po));
      return { n, lines, run };
    });
    for (const { n, lines, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_LINE * lines);
      expect(run.value?.unmatchedInvoiceLines).toHaveLength(n);
      expect(run.value?.unmatchedPoLines).toHaveLength(n);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("many invoice lines sharing an SKU and a description take the order's lines in turn", () => {
    const n = 3_000;
    const po = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      ...(i % 2 === 0 ? { sku: "WID" } : { description: "Widget, blue" }),
      quantity: 1,
      unitPriceMinor: 100,
    }));
    const invoice = Array.from({ length: n + 10 }, (_, i) => ({
      id: `i${i}`,
      ...(i % 2 === 0 ? { sku: "WID" } : { description: "widget  BLUE" }),
      quantity: 1,
      unitPriceMinor: 100,
    }));
    const run = listWork(WORK_PER_LINE * (2 * n + 10), () =>
      matchInvoiceToPurchaseOrder(invoice, po),
    );
    expect(run.work).toBeLessThanOrEqual(WORK_PER_LINE * (2 * n + 10));
    expect(
      run.value?.pairs.slice(0, 2).map((p) => [p.invoiceLineId, p.poLineId, p.matchedBy]),
    ).toEqual([
      ["i0", "p0", "sku"],
      ["i1", "p1", "description"],
    ]);
    expect(run.value?.unmatchedInvoiceLines).toHaveLength(10);
  }, 20_000);

  test("the same pairs as searching the remaining order lines, on generated lines", () => {
    // The search it replaced, as it was: reference, then the first remaining
    // order line with the SKU, then the first with the description.
    const normalize = (text: string): string =>
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const searched = (invoice: ReadonlyArray<MatchLine>, po: ReadonlyArray<MatchLine>) => {
      const remaining = new Map(po.map((l) => [l.id, l]));
      const pairs: string[][] = [];
      const unmatched: string[] = [];
      for (const line of invoice) {
        let found = line.poLineId === undefined ? undefined : remaining.get(line.poLineId);
        let by = "reference";
        if (!found && line.sku !== undefined) {
          found = [...remaining.values()].find((l) => l.sku !== undefined && l.sku === line.sku);
          if (found) by = "sku";
        }
        if (!found && line.description !== undefined) {
          const wanted = normalize(line.description);
          found = [...remaining.values()].find(
            (l) => l.description !== undefined && normalize(l.description) === wanted,
          );
          if (found) by = "description";
        }
        if (!found) {
          unmatched.push(line.id);
          continue;
        }
        remaining.delete(found.id);
        pairs.push([line.id, found.id, by]);
      }
      return { pairs, unmatched, left: [...remaining.keys()] };
    };
    const next = rng(0x3a7c0001);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const skus = ["S1", "S2", "S3", "", "__proto__"];
    const descriptions = ["Widget, blue", "widget blue", "WIDGET  BLUE!", "Gadget", " ", "Ünï ß"];
    const differ: string[] = [];
    const by = { sku: 0, description: 0 };
    for (let round = 0; round < 5_000; round++) {
      const po = Array.from({ length: Math.floor(next() * 9) }, (_, i) => ({
        id: `p${i}`,
        ...(next() < 0.7 ? { sku: pick(skus) } : {}),
        ...(next() < 0.7 ? { description: pick(descriptions) } : {}),
        quantity: 1,
        unitPriceMinor: 100,
      }));
      const invoice = Array.from({ length: Math.floor(next() * 10) }, (_, i) => ({
        id: `i${i}`,
        ...(next() < 0.3 && po.length > 0 ? { poLineId: pick(po).id } : {}),
        ...(next() < 0.6 ? { sku: pick(skus) } : {}),
        ...(next() < 0.7 ? { description: pick(descriptions) } : {}),
        quantity: 1,
        unitPriceMinor: 100,
      }));
      const expected = searched(invoice, po);
      const report = matchInvoiceToPurchaseOrder(invoice, po);
      const got = {
        pairs: report.pairs.map((p) => [p.invoiceLineId, p.poLineId, p.matchedBy]),
        unmatched: report.unmatchedInvoiceLines,
        left: report.unmatchedPoLines,
      };
      for (const pair of expected.pairs) {
        if (pair[2] === "sku") by.sku++;
        if (pair[2] === "description") by.description++;
      }
      if (JSON.stringify(got) !== JSON.stringify(expected)) differ.push(JSON.stringify(invoice));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(by.sku).toBeGreaterThan(2_000);
    expect(by.description).toBeGreaterThan(2_000);
  }, 20_000);
});

describe("RefundAmountCompute looks each returned line up once", () => {
  test("a partial and a full return with proportional shipping, at n and 2n", () => {
    for (const quantity of [1, 2]) {
      const measured = [3_000, 6_000].map((n) => {
        const lines = Array.from({ length: n }, (_, i) => ({
          id: `l${i}`,
          quantity: 2,
          unitPriceMinor: 1_000 + i,
        }));
        const returned = lines.map((l) => ({ lineId: l.id, quantity }));
        const run = listWork(WORK_PER_LINE * 2 * n, () =>
          computeRefund(lines, returned, { shippingMinor: 1_001, shippingPolicy: "proportional" }),
        );
        return { n, run };
      });
      for (const { n, run } of measured) {
        expect(run.work).toBeLessThanOrEqual(WORK_PER_LINE * 2 * n);
        expect(run.value?.fullReturn).toBe(quantity === 2);
        expect(run.value?.lines).toHaveLength(n);
      }
      const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
      expect(large.run.work / small.run.work).toBeLessThan(2.4);
    }
  }, 20_000);

  test("the first entry naming a line decides, as the search did", () => {
    const lines = [
      { id: "a", quantity: 3, unitPriceMinor: 1_000 },
      { id: "b", quantity: 1, unitPriceMinor: 3_000 },
    ];
    const options = { shippingMinor: 600, shippingPolicy: "proportional" as const };
    // `a` named twice: the first entry (one unit) is what the search found,
    // for whether the return is full and for the shipping share.
    const twice = computeRefund(
      lines,
      [
        { lineId: "a", quantity: 1 },
        { lineId: "b", quantity: 1 },
        { lineId: "a", quantity: 3 },
      ],
      options,
    );
    expect(twice.fullReturn).toBe(false);
    expect(twice.shippingMinor).toBe(400);
    const firstWhole = computeRefund(
      lines,
      [
        { lineId: "a", quantity: 3 },
        { lineId: "b", quantity: 1 },
        { lineId: "a", quantity: 1 },
      ],
      options,
    );
    expect(firstWhole.fullReturn).toBe(true);
    expect(firstWhole.shippingMinor).toBe(600);
  });
});

/** The lots each disposal takes when the open lots are sorted afresh before every one. */
function resortedBeforeEachDisposal(
  lots: ReadonlyArray<{ id: string; acquiredAt: string; quantity: number; costMinor: number }>,
  disposals: ReadonlyArray<{ quantity: number }>,
  method: Exclude<LotMethod, "specific">,
): Array<Array<[string, number, number]>> {
  const open = lots.map((l) => ({
    id: l.id,
    at: Date.parse(l.acquiredAt),
    units: BigInt(l.quantity),
    cost: l.costMinor,
  }));
  type Open = (typeof open)[number];
  const byId = (a: Open, b: Open): number => (a.id < b.id ? -1 : 1);
  const before = (a: Open, b: Open): number => {
    if (method === "fifo") return a.at - b.at || byId(a, b);
    if (method === "lifo") return b.at - a.at || byId(a, b);
    const left = BigInt(b.cost) * a.units;
    const right = BigInt(a.cost) * b.units;
    return left > right ? 1 : left < right ? -1 : byId(a, b);
  };
  return disposals.map((disposal) => {
    let wanted = BigInt(disposal.quantity);
    const taken: Array<[string, number, number]> = [];
    for (const lot of open.filter((l) => l.units > 0n).sort(before)) {
      if (wanted <= 0n) break;
      const whole = wanted >= lot.units;
      const take = whole ? lot.units : wanted;
      const cost = whole ? lot.cost : Number(mathRound(BigInt(lot.cost) * take, lot.units));
      lot.units -= take;
      lot.cost -= cost;
      wanted -= take;
      taken.push([lot.id, Number(take), cost]);
    }
    return taken;
  });
}

describe("HIFO puts a lot taken in part back in log time", () => {
  test("equal lots, each disposal taking one unit of one, at n and 2n", () => {
    // Every lot costs 101 for 3 units. Taking one unit costs 34, which
    // leaves that lot the cheapest per unit, so it goes from the front of
    // the order to the back on every disposal: a splice moved every open lot.
    const measured = [2_000, 4_000].map((n) => {
      const lots = Array.from({ length: n }, (_, i) => ({
        id: `L${String(i).padStart(6, "0")}`,
        acquiredAt: "2020-01-01T00:00:00Z",
        quantity: 3,
        costMinor: 101,
      }));
      const disposals = Array.from({ length: n }, (_, i) => ({
        id: `D${i}`,
        disposedAt: "2022-01-01T00:00:00Z",
        quantity: 1,
        proceedsMinor: 50,
      }));
      const run = listWork(WORK_PER_LINE * 2 * n, () => computeCostBasis(lots, disposals, "hifo"));
      return { n, run };
    });
    for (const { n, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_LINE * 2 * n);
      // Each disposal took one unit of a different lot, in id order.
      expect(run.value?.disposals.map((d) => d.consumed[0]?.lotId)).toEqual(
        Array.from({ length: n }, (_, i) => `L${String(i).padStart(6, "0")}`),
      );
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("the lots and costs a re-sort before every disposal gives, on generated lots", () => {
    const next = rng(0x3a7c0002);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const differ: string[] = [];
    let partial = 0;
    for (let round = 0; round < 3_000; round++) {
      const lots = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, i) => ({
        id: `${pick(["a", "b", "c"])}${i}`,
        acquiredAt: new Date(
          Date.UTC(2020, 0, 1) + Math.floor(next() * 4) * 86_400_000,
        ).toISOString(),
        quantity: 1 + Math.floor(next() * 7),
        costMinor: pick([101, 100, 333, 667, 1_000, 7]),
      }));
      const held = lots.reduce((sum, l) => sum + l.quantity, 0);
      const disposals: Array<{
        id: string;
        disposedAt: string;
        quantity: number;
        proceedsMinor: number;
      }> = [];
      let left = held;
      while (left > 0 && disposals.length < 12 && next() < 0.9) {
        const quantity = 1 + Math.floor(next() * Math.min(left, 4));
        left -= quantity;
        disposals.push({
          id: `d${disposals.length}`,
          disposedAt: "2025-01-01T00:00:00Z",
          quantity,
          proceedsMinor: 1_000,
        });
      }
      for (const method of ["fifo", "lifo", "hifo"] as const) {
        const expected = resortedBeforeEachDisposal(lots, disposals, method);
        const got = computeCostBasis(lots, disposals, method).disposals.map((d) =>
          d.consumed.map((c) => [c.lotId, c.quantity, c.costMinor]),
        );
        partial += expected
          .flat()
          .filter(([id], i, all) => all.findIndex(([o]) => o === id) !== i).length;
        if (JSON.stringify(got) !== JSON.stringify(expected)) {
          differ.push(`${method} ${JSON.stringify({ lots, disposals })}`);
        }
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    // Lots taken from more than once, so the re-ranking was exercised.
    expect(partial).toBeGreaterThan(3_000);
  }, 20_000);
});

import { describe, expect, test } from "bun:test";
/**
 * The pure core, tested directly and against published vectors.
 *
 * A wrong mod-97 or a lost cent reads better as a failing unit than as a
 * refund that is a penny short, and the allocation invariants — the parts
 * always sum to the whole — are properties this is the right level to pin.
 */
import { createHmac } from "node:crypto";
import { allocateProportional, computeRefund } from "./lib/allocate";
import { codeLines } from "./lib/coding";
import { checkSpendLimit, refundAbuseSignals } from "./lib/controls";
import {
  detectKind,
  luhnOk,
  validateAba,
  validateBic,
  validateCard,
  validateIban,
  validateSortCode,
} from "./lib/identifiers";
import { computeCostBasis } from "./lib/lots";
import { matchInvoiceToPurchaseOrder } from "./lib/match";
import {
  datesAreUnambiguous,
  parseCsvRows,
  parseDate,
  parseMoneyMinor,
  parseStatement,
} from "./lib/statement";
import { calculateTax, roundMinor } from "./lib/tax";
import { verifyWebhookSignature } from "./lib/webhook";

describe("payment identifiers, against published specimens", () => {
  test("registry specimen IBANs validate", () => {
    for (const iban of [
      "GB82 WEST 1234 5698 7654 32",
      "DE89 3704 0044 0532 0130 00",
      "FR14 2004 1010 0505 0001 3M02 606",
      "NL91 ABNA 0417 1643 00",
      "CH93 0076 2011 6238 5295 7",
    ]) {
      expect({ iban, valid: validateIban(iban).valid }).toEqual({ iban, valid: true });
    }
  });

  test("a single transposed digit fails the check", () => {
    const result = validateIban("GB82 WEST 1234 5698 7654 33");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("check digits");
  });

  test("length is part of the standard, not only the checksum", () => {
    // mod-97 alone accepts plenty of wrong-length strings.
    expect(validateIban("GB82 WEST 1234 5698 7654 3").reason).toContain("22 characters");
  });

  test("a country that issues no IBAN is named as such", () => {
    expect(validateIban("ZZ82WEST12345698765432").reason).toContain("not a country");
  });

  test("the mod-97 fold handles the longest IBANs, which exceed exact float range", () => {
    // Malta is 31 characters; as one integer that is past 2^53.
    expect(validateIban("MT84 MALT 0110 0001 2345 MTLC AST0 01S").valid).toBe(true);
  });

  test("Federal Reserve routing numbers validate, and a changed digit does not", () => {
    for (const aba of ["021000021", "011401533", "121000248"]) {
      expect({ aba, valid: validateAba(aba).valid }).toEqual({ aba, valid: true });
    }
    expect(validateAba("021000022").valid).toBe(false);
  });

  test("network test card numbers validate and are identified", () => {
    for (const [number, brand] of [
      ["4242424242424242", "visa"],
      ["5555555555554444", "mastercard"],
      ["378282246310005", "amex"],
      ["6011111111111117", "discover"],
    ] as Array<[string, string]>) {
      const result = validateCard(number);
      expect({ number, valid: result.valid, brand: result.parts.brand }).toEqual({
        number,
        valid: true,
        brand,
      });
    }
    expect(validateCard("4242424242424241").valid).toBe(false);
  });

  test("a card number is never echoed, only its last four", () => {
    // A validator that returned what it was given would copy a value the
    // caller has to protect into a log, a transcript and a model's context.
    const result = validateCard("4242 4242 4242 4242");
    expect(result.normalized).toBe("************4242");
    expect(JSON.stringify(result)).not.toContain("4242424242424242");
  });

  test("BIC accepts the 8 and 11 character forms and rejects 7", () => {
    expect(validateBic("DEUTDEFF").valid).toBe(true);
    expect(validateBic("DEUTDEFF500").valid).toBe(true);
    expect(validateBic("DEUTDEF").valid).toBe(false);
  });

  test("a sort code says plainly that only its shape was checked", () => {
    const result = validateSortCode("12-34-56");
    expect(result.valid).toBe(true);
    expect(result.formatted).toBe("12-34-56");
    expect(JSON.stringify(result.parts)).toContain("no checksum");
  });

  test("luhn agrees with itself on a known pair", () => {
    expect(luhnOk("79927398713")).toBe(true);
    expect(luhnOk("79927398710")).toBe(false);
  });

  test("detection picks the kind from the shape, or admits it cannot", () => {
    expect(detectKind("GB82WEST12345698765432")).toBe("iban");
    expect(detectKind("DEUTDEFF")).toBe("bic");
    expect(detectKind("021000021")).toBe("aba");
    expect(detectKind("4242424242424242")).toBe("card");
    expect(detectKind("hello")).toBeNull();
  });
});

describe("tax", () => {
  const vat = [{ code: "VAT20", bps: 2000 }];

  test("exclusive and inclusive pricing reach the same invoice", () => {
    const exclusive = calculateTax([{ id: "a", amountMinor: 10000, taxCodes: ["VAT20"] }], vat);
    expect(exclusive).toMatchObject({ netMinor: 10000, taxMinor: 2000, grossMinor: 12000 });
    const inclusive = calculateTax([{ id: "a", amountMinor: 12000, taxCodes: ["VAT20"] }], vat, {
      pricesIncludeTax: true,
    });
    expect(inclusive).toMatchObject({ netMinor: 10000, taxMinor: 2000, grossMinor: 12000 });
  });

  test("a compound rate is charged on the net PLUS the taxes before it", () => {
    // Quebec: 5% GST on 100.00, then QST on 105.00. Charging the compound
    // rate on the bare net is the bug the flag exists to prevent, and it
    // changes the total rather than a rounding digit.
    const result = calculateTax(
      [{ id: "a", amountMinor: 10000, taxCodes: ["GST", "QST"] }],
      [
        { code: "GST", bps: 500 },
        { code: "QST", bps: 998, compound: true },
      ],
    );
    expect(result.lines[0]?.breakdown).toEqual([
      { code: "GST", bps: 500, taxMinor: 500 },
      { code: "QST", bps: 998, taxMinor: 1048 },
    ]);
    expect(result.grossMinor).toBe(11548);
  });

  test("rounding per line and per invoice differ, and both are reported", () => {
    const lines = Array.from({ length: 3 }, (_, i) => ({
      id: `l${i}`,
      amountMinor: 1002,
      taxCodes: ["VAT20"],
    }));
    const perLine = calculateTax(lines, vat, { scope: "line" });
    const perInvoice = calculateTax(lines, vat, { scope: "invoice" });
    expect(perLine.taxMinor).toBe(600);
    expect(perInvoice.taxMinor).toBe(601);
    expect(perLine.scope).toBe("line");
    expect(perInvoice.scope).toBe("invoice");
  });

  test("reverse charge and exemption are stated, not silently zero", () => {
    const reverse = calculateTax([{ id: "a", amountMinor: 10000, taxCodes: ["VAT20"] }], vat, {
      reverseCharge: true,
    });
    expect(reverse.taxMinor).toBe(0);
    expect(reverse.reverseCharge).toBe(true);
    expect(reverse.lines[0]?.note).toContain("customer accounts for the tax");

    const exempt = calculateTax(
      [{ id: "a", amountMinor: 10000, taxCodes: ["VAT20"], exempt: true }],
      vat,
    );
    expect(exempt.lines[0]?.note).toContain("not a zero rate");
  });

  test("a tax code missing from the table is an error, not an untaxed line", () => {
    expect(() => calculateTax([{ id: "a", amountMinor: 1, taxCodes: ["NOPE"] }], vat)).toThrow(
      /not in the rate table/,
    );
  });

  test("rounding modes behave at exactly half", () => {
    expect(roundMinor(5, 2, "half-up")).toBe(3);
    expect(roundMinor(5, 2, "half-even")).toBe(2);
    expect(roundMinor(7, 2, "half-even")).toBe(4);
    expect(roundMinor(5, 2, "down")).toBe(2);
    expect(roundMinor(5, 2, "up")).toBe(3);
    expect(roundMinor(-5, 2, "half-up")).toBe(-3);
  });
});

describe("allocation never loses or invents money", () => {
  test("100 cents three ways is 34, 33, 33", () => {
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  test("the parts always sum to the total, for any weights", () => {
    const cases: Array<[number, number[]]> = [
      [1, [1, 1, 1]],
      [100, [1, 1, 1]],
      [-100, [1, 1, 1]],
      [10, [0, 0, 0]],
      [1000, [1, 0, 999]],
      [7, [5, 3, 1, 1]],
      [0, [1, 2, 3]],
    ];
    for (const [total, weights] of cases) {
      const parts = allocateProportional(total, weights);
      expect({ total, sum: parts.reduce((a, b) => a + b, 0) }).toEqual({ total, sum: total });
    }
  });

  test("all-zero weights spread the money rather than dropping it", () => {
    expect(allocateProportional(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  test("a negative weight is refused", () => {
    expect(() => allocateProportional(10, [1, -1])).toThrow(/negative/);
  });
});

describe("refunds", () => {
  const lines = [
    { id: "a", quantity: 3, unitPriceMinor: 999, taxMinor: 599, discountMinor: 100 },
    { id: "b", quantity: 1, unitPriceMinor: 2500, taxMinor: 500 },
  ];

  test("a full return refunds exactly what was charged", () => {
    const charged =
      lines.reduce(
        (s, l) => s + l.quantity * l.unitPriceMinor - (l.discountMinor ?? 0) + (l.taxMinor ?? 0),
        0,
      ) - 250;
    const refund = computeRefund(
      lines,
      [
        { lineId: "a", quantity: 3 },
        { lineId: "b", quantity: 1 },
      ],
      { orderDiscountMinor: 250 },
    );
    expect(refund.totalMinor).toBe(charged);
    expect(refund.fullReturn).toBe(true);
  });

  test("a partial return refunds the discounted price, not the list price", () => {
    const refund = computeRefund(lines, [{ lineId: "a", quantity: 1 }], {
      orderDiscountMinor: 250,
    });
    const line = refund.lines[0];
    expect(line?.grossMinor).toBe(999);
    expect(line?.lineDiscountMinor).toBeGreaterThan(0);
    expect(line?.orderDiscountMinor).toBeGreaterThan(0);
    expect(line?.refundMinor).toBeLessThan(999 + 599);
  });

  test("the order discount is spread over the whole order, not the returned part", () => {
    // Otherwise a one-item return refunds the entire order-level discount.
    const refund = computeRefund(lines, [{ lineId: "a", quantity: 1 }], {
      orderDiscountMinor: 250,
    });
    expect(refund.lines[0]?.orderDiscountMinor).toBeLessThan(250);
  });

  test("proportional shipping refunds a share, not the whole charge", () => {
    // An allocation's parts always sum to what was allocated, so allocating
    // shipping across the returned lines and summing the parts gave back the
    // entire shipping charge for a one-item return.
    const refund = computeRefund(lines, [{ lineId: "b", quantity: 1 }], {
      shippingMinor: 500,
      shippingPolicy: "proportional",
    });
    expect(refund.shippingMinor).toBeGreaterThan(0);
    expect(refund.shippingMinor).toBeLessThan(500);
  });

  test("shipping follows the policy", () => {
    const all = [
      { lineId: "a", quantity: 3 },
      { lineId: "b", quantity: 1 },
    ];
    expect(computeRefund(lines, all, { shippingMinor: 500 }).shippingMinor).toBe(0);
    expect(
      computeRefund(lines, all, { shippingMinor: 500, shippingPolicy: "full" }).shippingMinor,
    ).toBe(500);
    expect(
      computeRefund(lines, all, { shippingMinor: 500, shippingPolicy: "proportional" })
        .shippingMinor,
    ).toBe(500);
    expect(
      computeRefund(lines, [{ lineId: "b", quantity: 1 }], {
        shippingMinor: 500,
        shippingPolicy: "proportional",
      }).shippingMinor,
    ).toBeLessThan(500);
  });

  test("returning more than was ordered is refused", () => {
    expect(() => computeRefund(lines, [{ lineId: "a", quantity: 4 }])).toThrow(/of 3 ordered/);
    expect(() => computeRefund(lines, [{ lineId: "zz", quantity: 1 }])).toThrow(/not in the order/);
  });
});

describe("three-way match", () => {
  const po = [
    { id: "po1", sku: "WID-1", description: "Widget, blue", quantity: 100, unitPriceMinor: 4750 },
    { id: "po2", sku: "GAD-2", description: "Gadget", quantity: 10, unitPriceMinor: 12000 },
  ];

  test("an exact invoice matches with no exposure", () => {
    const report = matchInvoiceToPurchaseOrder(
      [{ id: "i1", poLineId: "po1", quantity: 100, unitPriceMinor: 4750 }],
      po,
    );
    expect(report).toMatchObject({ ok: true, exceptions: 0, totalExposureMinor: 0 });
    expect(report.pairs[0]?.status).toBe("matched");
  });

  test("tolerance decides whether a price creep is an exception", () => {
    const invoice = [{ id: "i1", poLineId: "po1", quantity: 100, unitPriceMinor: 4798 }];
    expect(
      matchInvoiceToPurchaseOrder(invoice, po, [], { pricePercentBps: 150 }).pairs[0]?.status,
    ).toBe("matched");
    expect(
      matchInvoiceToPurchaseOrder(invoice, po, [], { pricePercentBps: 50 }).pairs[0]?.status,
    ).toBe("price-variance");
  });

  test("an absolute tolerance rescues a cheap line a percentage would fail", () => {
    const cheapPo = [{ id: "p", sku: "S", quantity: 1, unitPriceMinor: 100 }];
    const invoice = [{ id: "i", poLineId: "p", quantity: 1, unitPriceMinor: 102 }];
    expect(
      matchInvoiceToPurchaseOrder(invoice, cheapPo, [], { pricePercentBps: 100 }).pairs[0]?.status,
    ).toBe("price-variance");
    expect(
      matchInvoiceToPurchaseOrder(invoice, cheapPo, [], {
        pricePercentBps: 100,
        priceAbsoluteMinor: 5,
      }).pairs[0]?.status,
    ).toBe("matched");
  });

  test("billing for more than arrived is caught only by the third leg", () => {
    const invoice = [{ id: "i1", poLineId: "po1", quantity: 100, unitPriceMinor: 4750 }];
    expect(matchInvoiceToPurchaseOrder(invoice, po).pairs[0]?.status).toBe("matched");
    const threeWay = matchInvoiceToPurchaseOrder(invoice, po, [{ poLineId: "po1", quantity: 60 }]);
    expect(threeWay.pairs[0]?.status).toBe("over-receipt");
    expect(threeWay.totalExposureMinor).toBe(190_000);
    expect(threeWay.threeWay).toBe(true);
  });

  test("nothing received at all is its own status", () => {
    const report = matchInvoiceToPurchaseOrder(
      [{ id: "i1", poLineId: "po1", quantity: 100, unitPriceMinor: 4750 }],
      po,
      [{ poLineId: "po2", quantity: 10 }],
    );
    expect(report.pairs[0]?.status).toBe("not-received");
  });

  test("how a pair was matched is recorded, because the ways are not equal", () => {
    expect(
      matchInvoiceToPurchaseOrder(
        [{ id: "i", sku: "GAD-2", quantity: 10, unitPriceMinor: 12000 }],
        po,
      ).pairs[0]?.matchedBy,
    ).toBe("sku");
    expect(
      matchInvoiceToPurchaseOrder(
        [{ id: "i", description: "widget,  BLUE!", quantity: 100, unitPriceMinor: 4750 }],
        po,
      ).pairs[0]?.matchedBy,
    ).toBe("description");
  });

  test("lines with no counterpart are listed on both sides", () => {
    const report = matchInvoiceToPurchaseOrder(
      [{ id: "i9", sku: "NOPE", quantity: 1, unitPriceMinor: 100 }],
      po,
    );
    expect(report.unmatchedInvoiceLines).toEqual(["i9"]);
    expect(report.unmatchedPoLines).toEqual(["po1", "po2"]);
    expect(report.ok).toBe(false);
  });

  test("a PO line is consumed once, so two invoice lines cannot both claim it", () => {
    const report = matchInvoiceToPurchaseOrder(
      [
        { id: "i1", sku: "WID-1", quantity: 100, unitPriceMinor: 4750 },
        { id: "i2", sku: "WID-1", quantity: 100, unitPriceMinor: 4750 },
      ],
      po,
    );
    expect(report.unmatchedInvoiceLines).toEqual(["i2"]);
  });
});

describe("cost basis", () => {
  const lots = [
    { id: "L1", acquiredAt: "2024-01-10T00:00:00Z", quantity: 10, costMinor: 10_000 },
    { id: "L2", acquiredAt: "2025-06-01T00:00:00Z", quantity: 10, costMinor: 30_000 },
  ];
  const sell = [
    { id: "D1", disposedAt: "2026-02-01T00:00:00Z", quantity: 15, proceedsMinor: 45_000 },
  ];

  test("the method chooses which lots are consumed", () => {
    expect(computeCostBasis(lots, sell, "fifo").disposals[0]?.costMinor).toBe(25_000);
    expect(computeCostBasis(lots, sell, "lifo").disposals[0]?.costMinor).toBe(35_000);
    expect(computeCostBasis(lots, sell, "hifo").disposals[0]?.costMinor).toBe(35_000);
  });

  test("specific identification consumes exactly the named lots", () => {
    const result = computeCostBasis(
      lots,
      [
        {
          id: "D",
          disposedAt: "2026-02-01T00:00:00Z",
          quantity: 5,
          proceedsMinor: 15_000,
          lotIds: ["L2"],
        },
      ],
      "specific",
    );
    expect(result.disposals[0]?.consumed.map((c) => c.lotId)).toEqual(["L2"]);
    expect(result.disposals[0]?.costMinor).toBe(15_000);
  });

  test("holding period is split short and long term", () => {
    const result = computeCostBasis(lots, sell, "fifo");
    const consumed = result.disposals[0]?.consumed ?? [];
    expect(consumed[0]).toMatchObject({ lotId: "L1", longTerm: true });
    expect(consumed[1]).toMatchObject({ lotId: "L2", longTerm: false });
  });

  test("partial consumption never drifts: the parts sum to the lot's cost", () => {
    const one = [{ id: "X", acquiredAt: "2024-01-01T00:00:00Z", quantity: 3, costMinor: 10_000 }];
    const bites = computeCostBasis(
      one,
      [1, 2, 3].map((n) => ({
        id: `d${n}`,
        disposedAt: `2024-06-0${n}T00:00:00Z`,
        quantity: 1,
        proceedsMinor: 0,
      })),
      "fifo",
    );
    expect(bites.disposals.reduce((s, d) => s + d.costMinor, 0)).toBe(10_000);
    expect(bites.remainingQuantity).toBe(0);
    expect(bites.remainingCostMinor).toBe(0);
  });

  test("disposing more than is held is refused", () => {
    expect(() =>
      computeCostBasis(
        lots,
        [{ id: "z", disposedAt: "2026-01-01T00:00:00Z", quantity: 99, proceedsMinor: 1 }],
        "fifo",
      ),
    ).toThrow(/cannot exceed the lots held/);
  });

  test("an offset-less timestamp is refused rather than read as local time", () => {
    expect(() =>
      computeCostBasis(
        [{ ...(lots[0] as (typeof lots)[number]), acquiredAt: "2024-01-10T00:00:00" }],
        [],
        "fifo",
      ),
    ).toThrow(/no UTC offset/);
  });

  test("specific identification with no lots named is a caller mistake", () => {
    expect(() =>
      computeCostBasis(
        lots,
        [{ id: "d", disposedAt: "2026-01-01T00:00:00Z", quantity: 1, proceedsMinor: 1 }],
        "specific",
      ),
    ).toThrow(/names no lots/);
  });
});

describe("spend limits", () => {
  const now = Date.parse("2026-01-01T11:00:00Z");
  const history = [
    { id: "s1", at: "2026-01-01T10:00:00Z", amountMinor: 80_000, counterparty: "acme" },
  ];

  test("a payment inside every limit is allowed, with the headroom stated", () => {
    const decision = checkSpendLimit(
      { amountMinor: 1_000 },
      history,
      { perDayMinor: 100_000 },
      now,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.headroomMinor).toBe(20_000);
  });

  test("every limit the payment breaks is reported, not just the first", () => {
    const decision = checkSpendLimit(
      { amountMinor: 500_000, counterparty: "new-co" },
      history,
      {
        perTransactionMinor: 100_000,
        perDayMinor: 100_000,
        knownCounterpartiesOnly: true,
        quietHoursUtc: [11],
      },
      now,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((v) => v.limit).sort()).toEqual([
      "knownCounterpartiesOnly",
      "perDay",
      "perTransaction",
      "quietHours",
    ]);
  });

  test("a declared allow-list is the allow-list; one payment cannot extend it", () => {
    // The hole this closes: a payment that got through by any means used to
    // add its counterparty to the allow-list permanently, so the control
    // stopped exactly one payment and approved every one after it.
    const breached = [
      { id: "s1", at: "2026-01-01T10:00:00Z", amountMinor: 1, counterparty: "attacker" },
    ];
    const decision = checkSpendLimit(
      { amountMinor: 100, counterparty: "attacker" },
      breached,
      { knownCounterpartiesOnly: true, knownCounterparties: ["approved-vendor"] },
      now,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violations[0]?.detail).toContain("allow-list");
  });

  test("with no allow-list declared, history is the basis, and the result says so", () => {
    const decision = checkSpendLimit(
      { amountMinor: 1, counterparty: "nobody" },
      history,
      { knownCounterpartiesOnly: true },
      now,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violations[0]?.detail).toContain("no allow-list was declared");
  });

  test("a counterparty paid before counts as known", () => {
    const decision = checkSpendLimit(
      { amountMinor: 1, counterparty: "acme" },
      history,
      { knownCounterpartiesOnly: true },
      now,
    );
    expect(decision.allowed).toBe(true);
  });

  test("windows are relative to the supplied clock, not the real one", () => {
    const later = Date.parse("2026-01-03T11:00:00Z");
    expect(
      checkSpendLimit({ amountMinor: 1 }, history, { perDayMinor: 100_000 }, later).windows
        .dayMinor,
    ).toBe(0);
    expect(
      checkSpendLimit({ amountMinor: 1 }, history, { perDayMinor: 100_000 }, later).windows
        .weekMinor,
    ).toBe(80_000);
  });

  test("a per-counterparty cap is separate from the overall one", () => {
    const decision = checkSpendLimit(
      { amountMinor: 30_000, counterparty: "acme" },
      history,
      { perDayMinor: 1_000_000, perCounterpartyPerDayMinor: 100_000 },
      now,
    );
    expect(decision.violations.map((v) => v.limit)).toEqual(["perCounterpartyPerDay:acme"]);
  });
});

describe("refund-abuse signals", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");

  test("ratios are reported per window", () => {
    const signals = refundAbuseSignals(
      [{ id: "r1", at: "2026-05-20T00:00:00Z", amountMinor: 5_000 }],
      [{ id: "o1", at: "2026-05-15T00:00:00Z", amountMinor: 10_000 }],
      now,
    );
    expect(signals.windows[0]).toMatchObject({ days: 30, refunds: 1, ratioBps: 5_000 });
  });

  test("a ratio against no spend is absent, not infinite", () => {
    // Reporting a huge number there would read as the strongest possible
    // signal when it is in fact no information at all.
    const signals = refundAbuseSignals(
      [{ id: "r", at: "2026-05-20T00:00:00Z", amountMinor: 1 }],
      [],
      now,
    );
    expect(signals.windows[0]?.ratioBps).toBeNull();
  });

  test("thresholds produce flags, and without them there are none", () => {
    const refunds = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      at: "2026-05-20T00:00:00Z",
      amountMinor: 1_000,
    }));
    expect(refundAbuseSignals(refunds, [], now).flags).toEqual([]);
    expect(refundAbuseSignals(refunds, [], now, { refundCount: 3 }).flags.length).toBeGreaterThan(
      0,
    );
  });

  test("non-delivery claims are counted from the reason text", () => {
    const signals = refundAbuseSignals(
      [
        { id: "a", at: "2026-05-20T00:00:00Z", amountMinor: 1, reason: "Package never arrived" },
        { id: "b", at: "2026-05-20T00:00:00Z", amountMinor: 1, reason: "changed my mind" },
      ],
      [],
      now,
    );
    expect(signals.nonDeliveryClaims).toBe(1);
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const t = 1_700_000_000;
  const sign = (payload: string, ts = t, key = secret): string =>
    createHmac("sha256", key).update(`${ts}.${payload}`).digest("hex");
  const nowMs = t * 1000;

  test("a correctly signed body verifies", () => {
    expect(verifyWebhookSignature(body, `t=${t},v1=${sign(body)}`, secret, { nowMs }).valid).toBe(
      true,
    );
  });

  test("a single changed byte fails", () => {
    expect(
      verifyWebhookSignature(`${body} `, `t=${t},v1=${sign(body)}`, secret, { nowMs }).valid,
    ).toBe(false);
  });

  test("the wrong secret fails", () => {
    expect(
      verifyWebhookSignature(body, `t=${t},v1=${sign(body)}`, "whsec_other", { nowMs }).valid,
    ).toBe(false);
  });

  test("an old signature is refused as a possible replay", () => {
    const result = verifyWebhookSignature(body, `t=${t},v1=${sign(body)}`, secret, {
      nowMs: nowMs + 3_600_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("replay");
  });

  test("a signature from the future is refused too", () => {
    const result = verifyWebhookSignature(body, `t=${t},v1=${sign(body)}`, secret, {
      nowMs: nowMs - 3_600_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("future");
  });

  test("several signatures are tried, which is how a secret is rotated", () => {
    const header = `t=${t},v1=deadbeef,v1=${sign(body)}`;
    const result = verifyWebhookSignature(body, header, secret, { nowMs });
    expect(result.valid).toBe(true);
    expect(result.signaturesTried).toBe(2);
  });

  test("a malformed header is refused with the specific reason", () => {
    expect(verifyWebhookSignature(body, `v1=${sign(body)}`, secret, { nowMs }).reason).toContain(
      "no timestamp",
    );
    expect(verifyWebhookSignature(body, `t=${t},v0=x`, secret, { nowMs }).reason).toContain(
      'no "v1" signature',
    );
  });

  test("a signature of the wrong length cannot pass the comparison", () => {
    expect(verifyWebhookSignature(body, `t=${t},v1=abc`, secret, { nowMs }).valid).toBe(false);
  });
});

describe("statement parsing", () => {
  test("money is parsed exactly, in every convention", () => {
    expect(parseMoneyMinor("1,234.56", 2, false)).toBe(123_456);
    expect(parseMoneyMinor("1.234,56", 2, true)).toBe(123_456);
    expect(parseMoneyMinor("(45.00)", 2, false)).toBe(-4_500);
    expect(parseMoneyMinor("45.00-", 2, false)).toBe(-4_500);
    expect(parseMoneyMinor("-1.5", 2, false)).toBe(-150);
    expect(parseMoneyMinor("1234", 0, false)).toBe(1_234);
    expect(parseMoneyMinor("", 2, false)).toBeNull();
    expect(parseMoneyMinor("abc", 2, false)).toBeNull();
  });

  test("a file whose dates could be read either way is REFUSED", () => {
    // A wrong guess moves transactions between months, and a reconciliation
    // then balances to exactly twice the error.
    const csv = "Date,Description,Amount\n03/04/2026,Coffee,-4.50\n05/06/2026,Book,-12.00\n";
    expect(() => parseStatement(csv)).toThrow(/day-first or month-first/);
    expect(parseStatement(csv, { dateOrder: "dmy" }).transactions[0]?.date).toBe("2026-04-03");
    expect(parseStatement(csv, { dateOrder: "mdy" }).transactions[0]?.date).toBe("2026-03-04");
  });

  test("an unambiguous file needs no hint", () => {
    const result = parseStatement("Date,Description,Amount\n25/12/2026,Gift,-20.00\n");
    expect(result.dateOrder).toBe("dmy");
    expect(result.transactions[0]?.date).toBe("2026-12-25");
  });

  test("a debit column's sign is applied, not read", () => {
    const result = parseStatement(
      "Posted Date,Narrative,Money Out,Money In,Balance\n2026-01-05,Rent,1200.00,,3800.00\n2026-01-06,Salary,,2500.00,6300.00\n",
    );
    expect(result.transactions[0]).toMatchObject({ amountMinor: -120_000, direction: "debit" });
    expect(result.transactions[1]).toMatchObject({ amountMinor: 250_000, direction: "credit" });
    expect(result.transactions[1]?.balanceMinor).toBe(630_000);
  });

  test("quoted fields carry commas and newlines", () => {
    const result = parseStatement(
      'Date,Description,Amount\n2026-02-01,"Shop, Ltd\nsecond line",-9.99\n',
    );
    expect(result.transactions[0]?.description).toBe("Shop, Ltd\nsecond line");
    expect(result.transactions[0]?.amountMinor).toBe(-999);
  });

  test("OFX is detected and read", () => {
    const ofx =
      "<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260210120000<TRNAMT>-42.10<FITID>abc123<NAME>Grocer</STMTTRN></OFX>";
    const result = parseStatement(ofx);
    expect(result.format).toBe("ofx");
    expect(result.transactions[0]).toMatchObject({
      id: "abc123",
      date: "2026-02-10",
      amountMinor: -4_210,
      direction: "debit",
    });
  });

  test("an unreadable row is reported with its reason, and the rest still parse", () => {
    const result = parseStatement(
      "Date,Description,Amount\n2026-01-01,ok,1.00\nnotadate,bad,2.00\n",
    );
    expect(result.count).toBe(1);
    expect(result.rejected[0]).toMatchObject({ row: 3 });
  });

  test("a header with no date or amount column is an error naming what it saw", () => {
    expect(() => parseStatement("Foo,Bar\n1,2\n")).toThrow(/no date column/);
    expect(() => parseStatement("Date,Bar\n2026-01-01,2\n")).toThrow(/no amount, debit or credit/);
  });

  test("ambiguity detection only fires on genuinely ambiguous dates", () => {
    expect(datesAreUnambiguous(["25/12/2026", "01/01/2026"])).toBe(true);
    expect(datesAreUnambiguous(["03/04/2026"])).toBe(false);
    expect(parseDate("2026-03-04", "iso")).toBe("2026-03-04");
    expect(parseDate("notadate", "dmy")).toBeNull();
  });

  test("the CSV reader handles a trailing newline and blank lines", () => {
    expect(parseCsvRows("a,b\n1,2\n\n").length).toBe(2);
  });
});

describe("GL coding", () => {
  const rules = [
    {
      id: "cloud",
      when: [{ path: "vendor", op: "equals" as const, expected: "AWS" }],
      account: "6500",
      costCenter: "ENG",
    },
    {
      id: "travel",
      when: [{ path: "category", op: "equals" as const, expected: "travel" }],
      account: "7200",
    },
  ];

  test("a matching line is coded and does not need review", () => {
    const result = codeLines([{ id: "l1", vendor: "AWS" }], rules);
    expect(result.lines[0]).toMatchObject({
      account: "6500",
      costCenter: "ENG",
      needsReview: false,
    });
    expect(result.coded).toBe(1);
  });

  test("a line no rule matched always goes to review, default account or not", () => {
    // A default account is somewhere to put it, not a coding decision.
    const result = codeLines([{ id: "l1", vendor: "Mystery" }], rules, { defaultAccount: "9999" });
    expect(result.lines[0]).toMatchObject({
      account: "9999",
      needsReview: true,
      reason: "no rule matched",
    });
  });

  test("two rules that disagree at the same priority are ambiguous, not resolved", () => {
    const conflicting = [
      { id: "a", when: [{ path: "vendor", op: "exists" as const }], account: "1000" },
      { id: "b", when: [{ path: "vendor", op: "exists" as const }], account: "2000" },
    ];
    const result = codeLines([{ id: "l1", vendor: "X" }], conflicting);
    expect(result.lines[0]).toMatchObject({ account: null, ambiguous: true, needsReview: true });
    expect(result.lines[0]?.reason).toContain("same priority");
  });

  test("priority settles a disagreement that was meant to be settled", () => {
    const ordered = [
      { id: "general", when: [{ path: "vendor", op: "exists" as const }], account: "1000" },
      {
        id: "specific",
        when: [{ path: "vendor", op: "equals" as const, expected: "AWS" }],
        account: "6500",
        priority: 10,
      },
    ];
    expect(codeLines([{ id: "l1", vendor: "AWS" }], ordered).lines[0]).toMatchObject({
      account: "6500",
      ambiguous: false,
    });
  });

  test("a rule with no conditions would code everything, so it is refused", () => {
    expect(() => codeLines([{ id: "l" }], [{ id: "all", when: [], account: "1" }])).toThrow(
      /every line/,
    );
  });

  test("the version is echoed so a coding is attributable", () => {
    expect(codeLines([{ id: "l1", vendor: "AWS" }], rules, { version: "2026-Q3" }).version).toBe(
      "2026-Q3",
    );
  });
});

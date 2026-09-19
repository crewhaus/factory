/**
 * The libraries, directly.
 *
 * These are the tests that pin arithmetic: a 94-character record, an entry
 * hash, a half-up rounding at exactly half, a block count that pads to ten, an
 * Easter that moves. Each one has a right answer that can be worked by hand,
 * and each is written so that a failure says which one moved.
 */
import { describe, expect, test } from "bun:test";
import {
  EXPECTED,
  INVOICE,
  NACHA_OPTIONS,
  NACHA_PAYMENTS,
  SEPA_OPTIONS,
  SEPA_PAYMENTS,
  routingWithCheckDigit,
} from "./fixtures";
import {
  AmountError,
  digits,
  divideHalfUp,
  formatMinor,
  minorUnitExponent,
  parseDecimal,
  scaleByRatio,
} from "./lib/amounts";
import {
  easterSunday,
  formatIsoDate,
  nextOpenDay,
  parseIsoDate,
  target2Closure,
  usFedClosure,
} from "./lib/calendar";
import { buildCii } from "./lib/cii";
import { CHECK_IDS, NAMED_RULES, checkRules } from "./lib/en16931";
import { type Invoice, canonicalRate, computeTotals } from "./lib/invoice";
import { abaCheckDigit, buildNacha } from "./lib/nacha";
import { PaymentFileError, validateRows } from "./lib/payments";
import { buildSepa, normalizeIban, resolveSettlementDate, toSepaCharset } from "./lib/sepa";
import { escapeText, localName, serialize } from "./lib/xml";

const day = (iso: string): number => parseIsoDate(iso, "date");

describe("amounts", () => {
  test("minor units render at the currency's own scale", () => {
    expect(formatMinor(1234n, 2)).toBe("12.34");
    expect(formatMinor(1234n, 0)).toBe("1234");
    expect(formatMinor(1234n, 3)).toBe("1.234");
    expect(formatMinor(5n, 2)).toBe("0.05");
  });

  test("a negative amount keeps its sign in front of the whole number", () => {
    // -5 minor units is -0.05, not -0.5 and not 0.-05. Formatting the integer
    // part separately is how that goes wrong.
    expect(formatMinor(-5n, 2)).toBe("-0.05");
    expect(formatMinor(-1234n, 2)).toBe("-12.34");
  });

  test("half rounds away from zero, in both directions", () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideHalfUp(4n, 2n)).toBe(2n);
    expect(divideHalfUp(1n, 3n)).toBe(0n);
  });

  test("exponent notation is refused rather than parsed", () => {
    // "1e3" parses as 1000 in JavaScript and as nothing at all in a document.
    // Accepting it here would put a quantity in a file that no recipient reads
    // the same way.
    expect(() => parseDecimal("1e3", "quantity")).toThrow(/plain decimal/);
    expect(() => parseDecimal("1.2.3", "quantity")).toThrow(AmountError);
    expect(parseDecimal("2.50", "q")).toEqual({ unscaled: 250n, scale: 2 });
  });

  test("quantity times price multiplies before it divides", () => {
    // 3 x (1/3) is 1, not 0. Dividing first loses the whole amount.
    const oneThird = parseDecimal("1", "n");
    const three = parseDecimal("3", "d");
    expect(scaleByRatio(300n, oneThird, three)).toBe(100n);
    expect(scaleByRatio(9000n, parseDecimal("2.5", "q"), parseDecimal("1", "b"))).toBe(22_500n);
  });

  test("a number too wide for its field is refused, never truncated", () => {
    expect(digits(125_000n, 10, "amount")).toBe("0000125000");
    expect(() => digits(12_345_678_901n, 10, "amount")).toThrow(/refusing rather than truncating/);
    expect(() => digits(-1n, 10, "amount")).toThrow(/no sign column/);
  });

  test("the minor-unit table knows the currencies that are not two", () => {
    expect(minorUnitExponent("EUR")).toBe(2);
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("KWD")).toBe(3);
    expect(minorUnitExponent("zzz")).toBe(2);
  });
});

describe("invoice totals", () => {
  test("every total comes off the rows and matches the hand-worked figures", () => {
    const totals = computeTotals(INVOICE);
    expect(formatMinor(totals.lineExtensionMinor, 2)).toBe(EXPECTED.lineExtension);
    expect(formatMinor(totals.allowanceTotalMinor, 2)).toBe(EXPECTED.allowanceTotal);
    expect(formatMinor(totals.taxExclusiveMinor, 2)).toBe(EXPECTED.taxExclusive);
    expect(formatMinor(totals.taxTotalMinor, 2)).toBe(EXPECTED.taxTotal);
    expect(formatMinor(totals.taxInclusiveMinor, 2)).toBe(EXPECTED.taxInclusive);
    expect(formatMinor(totals.payableMinor, 2)).toBe(EXPECTED.payable);
  });

  test("a document allowance reduces the base of ITS OWN rate, not every rate", () => {
    const totals = computeTotals(INVOICE);
    const at19 = totals.vatBreakdown.find((v) => v.ratePercent === "19");
    const at7 = totals.vatBreakdown.find((v) => v.ratePercent === "7");
    // 350.00 of lines at 19% less the 5.00 allowance; the 7% line is untouched.
    expect(formatMinor(at19?.taxableAmountMinor ?? 0n, 2)).toBe("345.00");
    expect(formatMinor(at7?.taxableAmountMinor ?? 0n, 2)).toBe("40.00");
  });

  test("tax at exactly half a cent rounds up", () => {
    // 100.10 at 19% is 19.019, which rounds to 19.02. A floor would take 4 of
    // these to move a cent off an invoice total.
    const invoice: Invoice = {
      ...INVOICE,
      allowances: undefined,
      lines: [
        {
          id: "1",
          name: "Thing",
          quantity: "1",
          unitCode: "C62",
          unitPriceMinor: 10_010,
          vat: { categoryCode: "S", ratePercent: "19" },
        },
      ],
    };
    const totals = computeTotals(invoice);
    expect(formatMinor(totals.taxTotalMinor, 2)).toBe("19.02");
  });

  test("19.00 and 19 are one rate, not two breakdown groups", () => {
    expect(canonicalRate("19.00", "rate")).toBe("19");
    expect(canonicalRate("7.500", "rate")).toBe("7.5");
    expect(canonicalRate("0.0", "rate")).toBe("0");
    const invoice: Invoice = {
      ...INVOICE,
      allowances: undefined,
      lines: [
        { ...(INVOICE.lines[0] as Invoice["lines"][number]) },
        {
          ...(INVOICE.lines[1] as Invoice["lines"][number]),
          vat: { categoryCode: "S", ratePercent: "19.00" },
        },
      ],
    };
    expect(computeTotals(invoice).vatBreakdown.length).toBe(1);
  });

  test("the breakdown is ordered by rate as a NUMBER, so 7 comes before 19", () => {
    const rates = computeTotals(INVOICE).vatBreakdown.map((v) => v.ratePercent);
    expect(rates).toEqual(["7", "19"]);
  });

  test("a document allowance with no VAT category is refused, naming the rule", () => {
    const invoice: Invoice = {
      ...INVOICE,
      allowances: [{ amountMinor: 500, reason: "Discount" }],
    };
    expect(() => computeTotals(invoice)).toThrow(/BR-32/);
  });

  test("two rows giving different exemption reasons for one group are reported, not merged", () => {
    const invoice: Invoice = {
      ...INVOICE,
      allowances: undefined,
      lines: [
        {
          id: "1",
          name: "A",
          quantity: "1",
          unitCode: "C62",
          unitPriceMinor: 1000,
          vat: { categoryCode: "AE", ratePercent: "0", exemptionReason: "Reverse charge" },
        },
        {
          id: "2",
          name: "B",
          quantity: "1",
          unitCode: "C62",
          unitPriceMinor: 1000,
          vat: { categoryCode: "AE", ratePercent: "0", exemptionReason: "Article 196" },
        },
      ],
    };
    const totals = computeTotals(invoice);
    expect(totals.vatBreakdown.length).toBe(1);
    expect(totals.exemptionReasonConflicts.length).toBe(1);
    expect(totals.exemptionReasonConflicts[0]).toContain("Article 196");
  });
});

describe("the rule table says what it covers", () => {
  const subject = () => {
    const totals = computeTotals(INVOICE);
    return checkRules({
      invoice: INVOICE,
      totals,
      stated: {
        lineExtensionMinor: totals.lineExtensionMinor,
        allowanceTotalMinor: totals.allowanceTotalMinor,
        chargeTotalMinor: totals.chargeTotalMinor,
        taxExclusiveMinor: totals.taxExclusiveMinor,
        taxTotalMinor: totals.taxTotalMinor,
        taxInclusiveMinor: totals.taxInclusiveMinor,
        paidMinor: totals.paidMinor,
        roundingMinor: totals.roundingMinor,
        payableMinor: totals.payableMinor,
        vatBreakdown: totals.vatBreakdown,
      },
      customizationId: "urn:cen.eu:en16931:2017",
      currencyExponent: 2,
    });
  };

  test("the verdict states a count and refuses to claim the whole set", () => {
    const report = subject();
    expect(report.verdict).toContain(`checked ${report.checksRun} rules`);
    expect(report.verdict).toContain("not the whole of it");
    expect(report.verdict).toContain("not a Schematron run");
  });

  test("it never reports the document as valid", () => {
    const report = subject();
    const text = JSON.stringify(report);
    // The word appears only inside the sentence that denies it, so the two
    // spellings a reader would take as a verdict must be absent.
    expect(/"?is valid"?/.test(text)).toBe(false);
    expect(/"valid":\s*true/.test(text)).toBe(false);
  });

  test("every identifier is unique and every named rule is one it runs", () => {
    expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length);
    expect(NAMED_RULES.every((rule) => CHECK_IDS.includes(rule))).toBe(true);
    expect(NAMED_RULES.length).toBeGreaterThan(40);
  });

  test("the not-checked list names the families that are genuinely absent", () => {
    const notChecked = subject().notChecked.join(" ");
    expect(notChecked).toContain("BR-CL-*");
    expect(notChecked).toContain("BR-UBL-*");
    expect(notChecked).toContain("XSD");
    expect(notChecked).toContain("Peppol");
  });

  test("a rule with nothing to check reports notApplicable rather than passing", () => {
    // BR-17 is about a payee; this invoice has none. Counting that as a pass
    // is how a coverage number stops meaning anything.
    const report = subject();
    expect(report.notApplicable).toBeGreaterThan(0);
    // All FOUR buckets, or a check that raised could vanish from the arithmetic.
    expect(
      report.passed + report.failed.length + report.notApplicable + report.notEvaluated.length,
    ).toBe(report.checksRun);
  });

  test("a check that raises is its own outcome, counted apart from both", () => {
    // BR-CO-17 has to canonicalise the stated rate, and "nineteen" is not a
    // decimal. Reporting that as a FAILURE of BR-CO-17 tells the caller the
    // document violates a published rule; nothing here established that, and
    // a reader acts on the identifier.
    const totals = computeTotals(INVOICE);
    const report = checkRules({
      invoice: INVOICE,
      totals,
      stated: {
        vatBreakdown: [
          {
            categoryCode: "S",
            ratePercent: "nineteen",
            taxableAmountMinor: 100n,
            taxAmountMinor: 19n,
          },
        ],
      },
      customizationId: "urn:cen.eu:en16931:2017",
      currencyExponent: 2,
    });
    expect(report.failed.map((f) => f.id)).not.toContain("BR-CO-17");
    const stuck = report.notEvaluated.find((o) => o.id === "BR-CO-17");
    expect(stuck?.status).toBe("notEvaluated");
    expect(stuck?.detail).toContain("nothing is known either way");
    expect(report.verdict).toContain("could not be evaluated at all");
    expect(
      report.passed + report.failed.length + report.notApplicable + report.notEvaluated.length,
    ).toBe(report.checksRun);
  });

  test("a stated total that disagrees with the rows fails the calculation rule", () => {
    const totals = computeTotals(INVOICE);
    const report = checkRules({
      invoice: INVOICE,
      totals,
      stated: {
        lineExtensionMinor: 40_000n, // the rows come to 390.00
        taxExclusiveMinor: totals.taxExclusiveMinor,
        taxTotalMinor: totals.taxTotalMinor,
        taxInclusiveMinor: totals.taxInclusiveMinor,
        payableMinor: totals.payableMinor,
        vatBreakdown: totals.vatBreakdown,
      },
      customizationId: "urn:cen.eu:en16931:2017",
      currencyExponent: 2,
    });
    const failure = report.failed.find((f) => f.id === "BR-CO-10");
    expect(failure?.detail).toContain("400.00");
    expect(failure?.detail).toContain("390.00");
  });

  test("an unknown VAT category code is caught by the one code list that is checked", () => {
    const invoice: Invoice = {
      ...INVOICE,
      allowances: undefined,
      lines: [
        {
          ...(INVOICE.lines[0] as Invoice["lines"][number]),
          vat: { categoryCode: "XX", ratePercent: "19" },
        },
      ],
    };
    const totals = computeTotals(invoice);
    const report = checkRules({
      invoice,
      totals,
      stated: { vatBreakdown: totals.vatBreakdown },
      customizationId: "x",
      currencyExponent: 2,
    });
    expect(report.failed.map((f) => f.id)).toContain("CH-VAT-CATEGORY-CODE");
  });
});

describe("xml writing", () => {
  test("output is byte-identical across runs", () => {
    const totals = computeTotals(INVOICE);
    const once = serialize(buildCii(INVOICE, totals, { customizationId: "x", exponent: 2 }));
    const twice = serialize(buildCii(INVOICE, totals, { customizationId: "x", exponent: 2 }));
    expect(once).toBe(twice);
  });

  test("markup in a name is escaped rather than emitted", () => {
    expect(escapeText("Smith & Sons <Ltd>")).toBe("Smith &amp; Sons &lt;Ltd&gt;");
  });

  test("a control character no XML parser accepts is refused", () => {
    const evil = `Acme${String.fromCharCode(7)}Ltd`;
    expect(() => serialize({ name: "a", text: evil })).toThrow(/control character/);
  });

  test("a prefix is not part of the name a mapping matches on", () => {
    expect(localName("cac:InvoiceLine")).toBe("InvoiceLine");
    expect(localName("InvoiceLine")).toBe("InvoiceLine");
  });
});

describe("CII mapping", () => {
  test("the header summation carries the computed totals under CII's own names", () => {
    // The round trip through the real reader is in index.test.ts, which drives
    // the parser `@crewhaus/tool-data` owns. What is under test here is the
    // mapping: CII spells every one of these differently from UBL, and a
    // mis-spelled element is a total the recipient never finds.
    const totals = computeTotals(INVOICE);
    const xml = serialize(
      buildCii(INVOICE, totals, { customizationId: "urn:cen.eu:en16931:2017", exponent: 2 }),
    );
    expect(xml).toContain("<ram:LineTotalAmount>390.00</ram:LineTotalAmount>");
    expect(xml).toContain("<ram:AllowanceTotalAmount>5.00</ram:AllowanceTotalAmount>");
    expect(xml).toContain("<ram:TaxBasisTotalAmount>385.00</ram:TaxBasisTotalAmount>");
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">68.35</ram:TaxTotalAmount>');
    expect(xml).toContain("<ram:GrandTotalAmount>453.35</ram:GrandTotalAmount>");
    expect(xml).toContain("<ram:DuePayableAmount>453.35</ram:DuePayableAmount>");
  });

  test("a date is CII's format-102 basic date, not the element's own text", () => {
    const xml = serialize(
      buildCii(INVOICE, computeTotals(INVOICE), { customizationId: "x", exponent: 2 }),
    );
    expect(xml).toContain('<udt:DateTimeString format="102">20260302</udt:DateTimeString>');
  });

  test("a VAT identifier is written under the VA scheme, which is what distinguishes it", () => {
    // A CII tax registration keyed "FC" is a local tax number, not BT-31.
    const xml = serialize(
      buildCii(INVOICE, computeTotals(INVOICE), { customizationId: "x", exponent: 2 }),
    );
    expect(xml).toContain('<ram:ID schemeID="VA">DE123456789</ram:ID>');
  });
});

describe("calendars", () => {
  test("Easter moves, and the computus follows it", () => {
    expect(easterSunday(2024)).toEqual({ month: 3, day: 31 });
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
  });

  test("TARGET2 closes on the days it closes on", () => {
    expect(target2Closure(day("2026-04-03"))).toBe("Good Friday");
    expect(target2Closure(day("2026-04-06"))).toBe("Easter Monday");
    expect(target2Closure(day("2026-05-01"))).toContain("1 May");
    expect(target2Closure(day("2026-12-25"))).toBe("Christmas Day");
    expect(target2Closure(day("2026-03-04"))).toBe(null);
  });

  test("the Fed keeps a Sunday holiday on the Monday and does NOT take the Friday", () => {
    // 4 July 2026 is a Saturday. The Fed is open on Friday the 3rd — the
    // federal-EMPLOYEE rule closes it, and using that rule here would hold a
    // file on a day the ACH network is running.
    expect(usFedClosure(day("2026-07-03"))).toBe(null);
    expect(usFedClosure(day("2026-07-04"))).toBe("a Saturday");
    // 4 July 2027 is a Sunday, so the 5th is observed.
    expect(usFedClosure(day("2027-07-05"))).toContain("Independence Day (observed)");
  });

  test("Juneteenth is a settlement holiday only from the year it became one", () => {
    expect(usFedClosure(day("2020-06-19"))).toBe(null);
    expect(usFedClosure(day("2026-06-19"))).toContain("Juneteenth");
  });

  test("the floating holidays land where the calendar says", () => {
    expect(usFedClosure(day("2026-01-19"))).toContain("Martin Luther King");
    expect(usFedClosure(day("2026-11-26"))).toBe("Thanksgiving Day");
    expect(usFedClosure(day("2026-05-25"))).toBe("Memorial Day");
  });

  test("the next open day walks past a whole closed weekend plus a holiday", () => {
    // Good Friday 3 April 2026, then the weekend, then Easter Monday: the
    // first settlement day is Tuesday the 7th.
    expect(formatIsoDate(nextOpenDay("target2", day("2026-04-03")))).toBe("2026-04-07");
  });
});

describe("settlement dates", () => {
  test("a closed day is refused by default, with the reason and the next open day", () => {
    expect(() =>
      resolveSettlementDate("target2", "2026-04-03", "requestedExecutionDate", false),
    ).toThrow(/Good Friday.*2026-04-07/s);
  });

  test("moving it is opt-in, and both dates come back", () => {
    const moved = resolveSettlementDate("target2", "2026-04-03", "d", true);
    expect(moved).toEqual({ date: "2026-04-07", movedFrom: "2026-04-03", reason: "Good Friday" });
  });

  test("an open day passes through untouched", () => {
    expect(resolveSettlementDate("usfed", "2026-03-04", "d", false)).toEqual({
      date: "2026-03-04",
    });
  });
});

describe("NACHA", () => {
  test("every record is exactly 94 characters", () => {
    const result = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS);
    const records = result.text.split("\n").filter((line) => line !== "");
    expect(records.length).toBe(result.blockCount * 10);
    for (const [index, line] of records.entries()) {
      expect({ index, length: line.length }).toEqual({ index, length: 94 });
    }
  });

  test("the file is padded with 9-filled records to a multiple of ten", () => {
    const result = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS);
    // 1 header + 1 batch header + 2 entries + 1 addenda + 1 batch control +
    // 1 file control = 7 records, so 3 filler records and one block.
    expect(result.recordCount).toBe(7);
    expect(result.paddingRecords).toBe(3);
    expect(result.blockCount).toBe(1);
    const records = result.text.split("\n").filter((line) => line !== "");
    expect(records.slice(-3).every((line) => line === "9".repeat(94))).toBe(true);
  });

  test("the entry hash is the sum of the first eight digits, truncated to ten", () => {
    // 02100002 + 01140153 = 3240155, right-padded into a ten-digit field.
    const result = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS);
    expect(result.entryHash).toBe("0003240155");
    const batchControl = result.text.split("\n")[5] as string;
    const fileControl = result.text.split("\n")[6] as string;
    expect(batchControl.slice(10, 20)).toBe("0003240155");
    expect(fileControl.slice(21, 31)).toBe("0003240155");
  });

  test("the hash keeps the RIGHTMOST ten digits when the sum overflows them", () => {
    // The sum has to ACTUALLY pass 10^10 or this test proves nothing: two
    // thousand entries at prefix 02100002 come to 4,200,004,000, which is
    // under it, so the previous version of this test stayed green with the
    // truncation removed entirely. A prefix of 99999998 gives
    // 2,000 x 99,999,998 = 199,999,996,000 — twenty times the field — and the
    // expectation below is the low ten digits worked out by hand rather than
    // by re-running the implementation's own `%`.
    const routing = routingWithCheckDigit("99999998");
    const payments = Array.from({ length: 2_000 }, (_, i) => ({
      id: `P${i}`,
      amountMinor: 100,
      name: "Payee",
      routingNumber: routing,
      accountNumber: "1",
    }));
    const sum = 2_000 * 99_999_998; // 199,999,996,000
    expect(sum).toBeGreaterThan(10 ** 10);
    const result = buildNacha(payments, NACHA_OPTIONS);
    // 199,999,996,000 -> the rightmost ten digits are 9999996000.
    expect(result.entryHash).toBe("9999996000");
  });

  test("a file-level identifier too long for its column is refused, not cut", () => {
    // A name is shortened and reported; an identifier is not either. A
    // company identifier cut to ten characters is a different originator.
    expect(() =>
      buildNacha(NACHA_PAYMENTS, { ...NACHA_OPTIONS, companyId: "11234567890123" }),
    ).toThrow(/companyId is 14 characters/);
  });

  test("a file-level name is shortened to its column AND reported", () => {
    const result = buildNacha(NACHA_PAYMENTS, {
      ...NACHA_OPTIONS,
      destinationName: "JPMORGAN CHASE BANK NATIONAL ASSOCIATION",
    });
    const cut = result.truncations.find((t) => t.field === "destinationName");
    expect(cut?.to).toBe("JPMORGAN CHASE BANK NAT");
    expect(cut?.paymentId).toBe("(file)");
  });

  test("the totals and the counts are the entries', not an argument's", () => {
    const result = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS);
    expect(result.totalCreditMinor).toBe("175000");
    expect(result.totalDebitMinor).toBe("0");
    expect(result.entryAddendaCount).toBe(3); // two entries plus one addenda
    const fileControl = result.text.split("\n")[6] as string;
    expect(fileControl.slice(13, 21)).toBe("00000003");
    expect(fileControl.slice(43, 55)).toBe("000000175000");
  });

  test("the service class is derived from the entries", () => {
    expect(buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS).serviceClassCode).toBe("220");
    const debits = NACHA_PAYMENTS.map((p) => ({ ...p, direction: "debit" as const }));
    expect(buildNacha(debits, NACHA_OPTIONS).serviceClassCode).toBe("225");
    const mixed = [NACHA_PAYMENTS[0] as never, { ...NACHA_PAYMENTS[1], direction: "debit" }];
    expect(buildNacha(mixed as never, NACHA_OPTIONS).serviceClassCode).toBe("200");
  });

  test("trace numbers are the ODFI prefix plus an ascending sequence", () => {
    const result = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS);
    expect(result.traceNumbers).toEqual(["011401530000001", "011401530000002"]);
    const addenda = result.text.split("\n")[4] as string;
    // The addenda points back at its entry by the last seven digits of the trace.
    expect(addenda.slice(87, 94)).toBe("0000002");
  });

  test("the trace sequence can be started elsewhere and stays contiguous", () => {
    const result = buildNacha(NACHA_PAYMENTS, { ...NACHA_OPTIONS, traceStart: 4_500 });
    expect(result.traceNumbers).toEqual(["011401530004500", "011401530004501"]);
  });

  test("transaction codes follow the account type and direction", () => {
    const result = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS);
    const lines = result.text.split("\n");
    expect((lines[2] as string).slice(0, 3)).toBe("622"); // checking credit
    expect((lines[3] as string).slice(0, 3)).toBe("632"); // savings credit
  });

  test("a routing number that fails its check digit is refused, naming the digit", () => {
    const bad = [{ ...(NACHA_PAYMENTS[0] as never), routingNumber: "021000022" }];
    expect(() => buildNacha(bad as never, NACHA_OPTIONS)).toThrow(/check digit.*should be 1/s);
  });

  test("the check digit is the published weighting", () => {
    expect(abaCheckDigit("02100002")).toBe(1);
    expect(abaCheckDigit("01140153")).toBe(3);
    expect(routingWithCheckDigit("12345678")).toBe("123456780");
  });

  test("an amount too wide for the field is refused rather than truncated", () => {
    const huge = [{ ...(NACHA_PAYMENTS[0] as never), amountMinor: 99_999_999_999 }];
    expect(() => buildNacha(huge as never, NACHA_OPTIONS)).toThrow(
      /refusing rather than truncating/,
    );
  });

  test("a long name is truncated to the field and the truncation is reported", () => {
    const long = [{ ...(NACHA_PAYMENTS[0] as never), name: "Bartholomew Featherstonehaugh III" }];
    const result = buildNacha(long as never, NACHA_OPTIONS);
    expect(result.truncations.length).toBe(1);
    expect(result.truncations[0]).toMatchObject({
      field: "counterparty name",
      to: "Bartholomew Feathersto", // the field holds 22
    });
  });

  test("a long identifier is refused, because a reference is matched by machine", () => {
    const long = [{ ...(NACHA_PAYMENTS[0] as never), id: "INVOICE-2026-000000001" }];
    expect(() => buildNacha(long as never, NACHA_OPTIONS)).toThrow(
      /Refusing rather than truncating/,
    );
  });

  test("a name outside printable ASCII is refused, naming the character", () => {
    const accented = [{ ...(NACHA_PAYMENTS[0] as never), name: "Jürgen Müller" }];
    expect(() => buildNacha(accented as never, NACHA_OPTIONS)).toThrow(/U\+00FC/);
  });

  test("an addenda over eighty characters is refused", () => {
    const long = [{ ...(NACHA_PAYMENTS[0] as never), addenda: "X".repeat(81) }];
    expect(() => buildNacha(long as never, NACHA_OPTIONS)).toThrow(/holds 80/);
  });

  test("line endings are the caller's, and a blocked file has none", () => {
    const crlf = buildNacha(NACHA_PAYMENTS, { ...NACHA_OPTIONS, lineEnding: "crlf" });
    expect(crlf.text.split("\r\n").filter((l) => l !== "").length).toBe(10);
    const blocked = buildNacha(NACHA_PAYMENTS, { ...NACHA_OPTIONS, lineEnding: "none" });
    expect(blocked.text.length).toBe(940);
    expect(blocked.text.includes("\n")).toBe(false);
  });

  test("a creation time that is not a time of day is refused", () => {
    expect(() => buildNacha(NACHA_PAYMENTS, { ...NACHA_OPTIONS, creationTime: "25:00" })).toThrow(
      /not a real time of day/,
    );
  });

  test("building twice produces identical bytes", () => {
    const a = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS).text;
    const b = buildNacha(NACHA_PAYMENTS, NACHA_OPTIONS).text;
    expect(a).toBe(b);
  });
});

describe("row validation", () => {
  test("a duplicated identifier is refused before anything is written", () => {
    const rows = [
      { id: "SAME", amountMinor: 1, name: "A" },
      { id: "SAME", amountMinor: 2, name: "B" },
    ];
    expect(() => validateRows(rows)).toThrow(/duplicate found after the file has gone/);
  });

  test("a zero or negative amount is refused, and direction is a field not a sign", () => {
    expect(() => validateRows([{ id: "A", amountMinor: 0, name: "A" }])).toThrow(
      /direction is set per row/,
    );
    expect(() => validateRows([{ id: "A", amountMinor: -1, name: "A" }])).toThrow(PaymentFileError);
  });

  test("a fractional amount is refused, with the minor-unit convention spelled out", () => {
    expect(() => validateRows([{ id: "A", amountMinor: 12.34, name: "A" }])).toThrow(
      /12\.34 euros is 1234/,
    );
  });

  test("an empty file is refused", () => {
    expect(() => validateRows([])).toThrow(/no payments/);
  });
});

describe("SEPA", () => {
  test("the control sum and the count are the rows', at both levels", () => {
    const result = buildSepa(SEPA_PAYMENTS, SEPA_OPTIONS);
    expect(result.controlSum).toBe("1259.99");
    expect(result.transactionCount).toBe(2);
    const occurrences = result.text.split("<CtrlSum>1259.99</CtrlSum>").length - 1;
    expect(occurrences).toBe(2);
  });

  test("the two schema versions differ where they actually differ", () => {
    const old = buildSepa(SEPA_PAYMENTS, SEPA_OPTIONS);
    const current = buildSepa(SEPA_PAYMENTS, { ...SEPA_OPTIONS, version: "pain.001.001.09" });
    expect(old.text).toContain("<ReqdExctnDt>2026-03-04</ReqdExctnDt>");
    expect(old.text).toContain("<BIC>ABNANL2A</BIC>");
    expect(current.text).toContain("<ReqdExctnDt>\n        <Dt>2026-03-04</Dt>");
    expect(current.text).toContain("<BICFI>ABNANL2A</BICFI>");
    expect(current.text).toContain("pain.001.001.09");
  });

  test("an accented name is transliterated and every substitution is reported", () => {
    const rows = [{ ...(SEPA_PAYMENTS[0] as never), name: "Jürgen Müller & Söhne" }];
    const result = buildSepa(rows as never, SEPA_OPTIONS);
    expect(result.text).toContain("<Nm>Jurgen Muller + Sohne</Nm>");
    expect(result.transliterations[0]).toMatchObject({
      from: "Jürgen Müller & Söhne",
      to: "Jurgen Muller + Sohne",
    });
  });

  test("the hand-mapped letters that NFD cannot decompose", () => {
    expect(toSepaCharset("Straße", "f")).toBe("Strasse");
    expect(toSepaCharset("Ærø", "f")).toBe("AEro");
    expect(toSepaCharset("Łódź", "f")).toBe("Lodz");
    expect(toSepaCharset("O’Brien", "f")).toBe("O'Brien");
  });

  test("a name this package cannot romanize is refused, not mangled", () => {
    expect(() => toSepaCharset("Ελληνικά ΑΕ", "creditor name")).toThrow(/U\+0395/);
    expect(() => toSepaCharset("株式会社", "creditor name")).toThrow(
      /will not guess a romanization/,
    );
  });

  test("a remittance over 140 characters is refused, because it is what reconciles", () => {
    const rows = [{ ...(SEPA_PAYMENTS[0] as never), remittance: "R".repeat(141) }];
    expect(() => buildSepa(rows as never, SEPA_OPTIONS)).toThrow(/Refusing rather than truncating/);
  });

  test("an end-to-end identifier over 35 characters is refused", () => {
    const rows = [{ ...(SEPA_PAYMENTS[0] as never), id: "E".repeat(36) }];
    expect(() => buildSepa(rows as never, SEPA_OPTIONS)).toThrow(/endToEndId/);
  });

  test("a row with no IBAN is refused, naming the row", () => {
    const rows = [{ id: "X", amountMinor: 100, name: "A" }];
    expect(() => buildSepa(rows as never, SEPA_OPTIONS)).toThrow(
      /names the creditor account by IBAN/,
    );
  });

  test("a creation timestamp with no offset is refused", () => {
    expect(() =>
      buildSepa(SEPA_PAYMENTS, { ...SEPA_OPTIONS, creationDateTime: "2026-03-02T09:30:00" }),
    ).toThrow(/no UTC offset/);
  });

  test("a non-euro SEPA credit transfer is refused rather than mislabelled", () => {
    expect(() => buildSepa(SEPA_PAYMENTS, { ...SEPA_OPTIONS, currency: "GBP" })).toThrow(
      /different scheme/,
    );
  });

  test("an IBAN of the wrong shape is refused before the checksum is even reached", () => {
    expect(() => normalizeIban("DE89 3704", "debtorIban")).toThrow(/shape of an IBAN/);
    expect(normalizeIban("de89 3704 0044 0532 0130 00", "x")).toBe("DE89370400440532013000");
  });

  test("a debtor with no BIC gets the IBAN-only form rather than an empty element", () => {
    const result = buildSepa(SEPA_PAYMENTS, { ...SEPA_OPTIONS, debtorBic: undefined });
    expect(result.text).toContain("<Id>NOTPROVIDED</Id>");
  });

  test("building twice produces identical bytes", () => {
    expect(buildSepa(SEPA_PAYMENTS, SEPA_OPTIONS).text).toBe(
      buildSepa(SEPA_PAYMENTS, SEPA_OPTIONS).text,
    );
  });
});

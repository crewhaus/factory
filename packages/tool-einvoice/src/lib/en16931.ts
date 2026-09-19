/**
 * A NARROW, NAMED subset of the EN 16931 business rules.
 *
 * ## Read this before believing a result from here
 *
 * EN 16931 publishes its business rules as Schematron generated from the
 * semantic model, and the distribution is large: the BR-*, BR-CO-*, BR-CL-*,
 * BR-DEC-*, the per-VAT-category families (BR-S, BR-Z, BR-E, BR-AE, BR-G,
 * BR-O, BR-IC), and on top of those the syntax-binding BR-UBL-* and
 * BR-CII-* sets, plus whatever Peppol BIS 3 or XRechnung add on their own
 * account. There is no XSLT engine in this repository and no Schematron
 * processor, so this file is not a Schematron run and does not become one by
 * being thorough.
 *
 * What it is: a hand-written table of checks, each of which is implemented
 * COMPLETELY or not at all. Every check reports its own identifier, and a
 * check that corresponds to a published rule carries that rule's identifier
 * too. Checks that correspond to a rule FAMILY whose individual identifiers
 * are not transcribed here are prefixed `CH-` and say which family they cover
 * the effect of — because citing `BR-S-08` for something that is nearly
 * BR-S-08 is how a reader ends up trusting a coverage claim that is not true.
 *
 * The report never says "valid". It says how many checks ran and that the
 * rule set is larger, because a partially transcribed rule set that reports
 * "valid" is worse than no validation at all: somebody relies on it.
 *
 * ## Deliberately NOT covered
 *
 * - XSD schema validation. Structure, cardinality and datatypes as the UBL or
 *   CII schema defines them are not checked here at all.
 * - BR-CL-* — the code-list rules. ISO 4217 currencies, ISO 3166-1 countries,
 *   UN/ECE Recommendation 20 unit codes and UNCL codes each need their list
 *   vendored, and a code-list check against a list this package guessed at is
 *   worse than none. Only two small closed lists are checked, under `CH-`
 *   identifiers that say so.
 * - BR-UBL-* and BR-CII-* — the syntax-binding rules.
 * - Peppol BIS Billing 3.0 and XRechnung national rules. Selecting one of
 *   those presets in `EInvoiceBuild` sets identifiers; it does not check their
 *   rules, and the build result says so.
 */
import { formatMinor } from "./amounts";
import type { Invoice, InvoiceTotals, VatBreakdownEntry } from "./invoice";
import { canonicalRate, taxOf } from "./invoice";

/**
 * Four outcomes, not three.
 *
 * `notEvaluated` is the one that keeps the other three honest: a check that
 * THREW did not find the document wanting, it found this table wanting, and
 * folding it into `failed` reports a violation of a published rule against a
 * document that may satisfy it. Folding it into `passed` would be worse. It
 * is its own status, it is counted separately, and the verdict says so.
 */
export type RuleStatus = "passed" | "failed" | "notApplicable" | "notEvaluated";

export type RuleOutcome = {
  readonly id: string;
  /** The published rule this check IS, when it is one. Absent for `CH-` checks. */
  readonly en16931Rule?: string;
  readonly text: string;
  readonly status: RuleStatus;
  readonly detail?: string;
};

/** The totals a DOCUMENT declares, as opposed to the ones its rows come to. */
export type StatedTotals = {
  readonly lineExtensionMinor?: bigint;
  readonly allowanceTotalMinor?: bigint;
  readonly chargeTotalMinor?: bigint;
  readonly taxExclusiveMinor?: bigint;
  readonly taxTotalMinor?: bigint;
  readonly taxInclusiveMinor?: bigint;
  readonly paidMinor?: bigint;
  readonly roundingMinor?: bigint;
  readonly payableMinor?: bigint;
  readonly vatBreakdown?: ReadonlyArray<VatBreakdownEntry>;
  /** Monetary elements carrying more decimals than the currency has minor units. */
  readonly overPreciseAmounts?: ReadonlyArray<string>;
  /**
   * Monetary elements that were PRESENT and could not be read as a decimal.
   *
   * Absence and unreadability are different findings and the second is the
   * dangerous one, so they do not share a representation: an amount that
   * arrives here has been dropped from the stated totals above, and anything
   * comparing those totals to the rows would otherwise be comparing against
   * a figure the document does state.
   */
  readonly unreadableAmounts?: ReadonlyArray<string>;
};

export type RuleSubject = {
  readonly invoice: Invoice;
  readonly totals: InvoiceTotals;
  readonly stated: StatedTotals;
  /** BT-24. */
  readonly customizationId?: string;
  readonly currencyExponent: number;
};

export type RuleReport = {
  readonly standard: string;
  readonly checksRun: number;
  readonly passed: number;
  readonly failed: ReadonlyArray<RuleOutcome>;
  readonly notApplicable: number;
  /** Checks that raised. A defect in this table, reported as such, never as a failure. */
  readonly notEvaluated: ReadonlyArray<RuleOutcome>;
  /** Every identifier this table can report, so coverage is auditable. */
  readonly checkedIds: ReadonlyArray<string>;
  /** The published rule identifiers among them. */
  readonly namedEn16931Rules: ReadonlyArray<string>;
  readonly notChecked: ReadonlyArray<string>;
  readonly verdict: string;
};

/**
 * The VAT category codes EN 16931 admits (UNCL5305 as the standard restricts
 * it). A closed list of eight, which is why it is checked here when the rest
 * of the code lists are not.
 */
export const VAT_CATEGORY_CODES: ReadonlyArray<string> = Object.freeze([
  "AE", // reverse charge
  "E", // exempt from tax
  "G", // free export item, tax not charged
  "K", // VAT exempt for intra-community supply of goods
  "L", // Canary Islands general indirect tax
  "M", // tax for production, services and import in Ceuta and Melilla
  "O", // services outside scope of tax
  "S", // standard rate
  "Z", // zero rated goods
]);

/** Categories that carry no tax: the rate and the tax amount are both zero. */
const ZERO_TAX_CATEGORIES: ReadonlySet<string> = new Set(["AE", "E", "G", "K", "O", "Z"]);

/** Categories whose breakdown must explain itself. */
const REASON_REQUIRED_CATEGORIES: ReadonlySet<string> = new Set(["AE", "E", "G", "K", "O"]);

/**
 * The invoice type codes EN 16931 admits (UNCL1001 as the standard restricts
 * it). Also a closed list, also checked for that reason.
 */
export const INVOICE_TYPE_CODES: ReadonlyArray<string> = Object.freeze([
  "326", // partial invoice
  "380", // commercial invoice
  "381", // credit note
  "384", // corrected invoice
  "389", // self-billed invoice
  "875", // partial construction invoice
  "876", // partial final construction invoice
  "877", // final construction invoice
]);

/** Payment means that are a credit transfer, for BR-61. */
const CREDIT_TRANSFER_MEANS: ReadonlySet<string> = new Set(["30", "58", "31"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function isRealDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

type Check = {
  id: string;
  en16931Rule?: string;
  text: string;
  /** `null` means the rule does not apply to this document. */
  run: (s: RuleSubject) => string | null | undefined;
};

/**
 * Why `what` is not there, in the document's own terms.
 *
 * An element that is absent and one that is present but unreadable are
 * different findings, and calling the second "absent" is how a ten-fold
 * difference between a stated total and its rows gets filed as a missing
 * field. `unreadableAmounts` carries entries spelled `BT-115="1.100,00"`, so
 * the label is the key.
 */
function absence(s: RuleSubject, what: string): string {
  const entry = (s.stated.unreadableAmounts ?? []).find((e) => e.startsWith(`${what}=`));
  return entry === undefined
    ? `${what} is absent`
    : `${what} is present and could not be read as a decimal (${entry.slice(what.length + 1)}), so what the document states there is unknown — not absent and not zero`;
}

/** `undefined` from a check means it passed; a string is the failure detail. */
function eq(
  s: RuleSubject,
  actual: bigint | undefined,
  expected: bigint,
  exponent: number,
  what: string,
) {
  if (actual === undefined) return absence(s, what);
  if (actual === expected) return undefined;
  return `${what} is ${formatMinor(actual, exponent)} but the rows come to ${formatMinor(expected, exponent)} (a difference of ${formatMinor(actual - expected, exponent)})`;
}

const CHECKS: ReadonlyArray<Check> = [
  // --- presence and cardinality ------------------------------------------
  {
    id: "BR-01",
    en16931Rule: "BR-01",
    text: "An Invoice shall have a Specification identifier (BT-24).",
    run: (s) => (present(s.customizationId) ? undefined : "no specification identifier"),
  },
  {
    id: "BR-02",
    en16931Rule: "BR-02",
    text: "An Invoice shall have an Invoice number (BT-1).",
    run: (s) => (present(s.invoice.invoiceNumber) ? undefined : "no invoice number"),
  },
  {
    id: "BR-03",
    en16931Rule: "BR-03",
    text: "An Invoice shall have an Invoice issue date (BT-2).",
    run: (s) => (present(s.invoice.issueDate) ? undefined : "no issue date"),
  },
  {
    id: "BR-04",
    en16931Rule: "BR-04",
    text: "An Invoice shall have an Invoice type code (BT-3).",
    run: (s) => (present(s.invoice.typeCode) ? undefined : "no invoice type code"),
  },
  {
    id: "BR-05",
    en16931Rule: "BR-05",
    text: "An Invoice shall have an Invoice currency code (BT-5).",
    run: (s) => (present(s.invoice.currency) ? undefined : "no currency code"),
  },
  {
    id: "BR-06",
    en16931Rule: "BR-06",
    text: "An Invoice shall contain the Seller name (BT-27).",
    run: (s) => (present(s.invoice.seller.name) ? undefined : "no seller name"),
  },
  {
    id: "BR-07",
    en16931Rule: "BR-07",
    text: "An Invoice shall contain the Buyer name (BT-44).",
    run: (s) => (present(s.invoice.buyer.name) ? undefined : "no buyer name"),
  },
  {
    id: "BR-08",
    en16931Rule: "BR-08",
    text: "An Invoice shall contain the Seller postal address (BG-5).",
    run: (s) => (s.invoice.seller.address === undefined ? "no seller postal address" : undefined),
  },
  {
    id: "BR-09",
    en16931Rule: "BR-09",
    text: "The Seller postal address (BG-5) shall contain a Seller country code (BT-40).",
    run: (s) => (present(s.invoice.seller.address?.country) ? undefined : "no seller country code"),
  },
  {
    id: "BR-10",
    en16931Rule: "BR-10",
    text: "An Invoice shall contain the Buyer postal address (BG-8).",
    run: (s) => (s.invoice.buyer.address === undefined ? "no buyer postal address" : undefined),
  },
  {
    id: "BR-11",
    en16931Rule: "BR-11",
    text: "The Buyer postal address (BG-8) shall contain a Buyer country code (BT-55).",
    run: (s) => (present(s.invoice.buyer.address?.country) ? undefined : "no buyer country code"),
  },
  {
    id: "BR-12",
    en16931Rule: "BR-12",
    text: "An Invoice shall have the Sum of Invoice line net amount (BT-106).",
    run: (s) => (s.stated.lineExtensionMinor === undefined ? absence(s, "BT-106") : undefined),
  },
  {
    id: "BR-13",
    en16931Rule: "BR-13",
    text: "An Invoice shall have the Invoice total amount without VAT (BT-109).",
    run: (s) => (s.stated.taxExclusiveMinor === undefined ? absence(s, "BT-109") : undefined),
  },
  {
    id: "BR-14",
    en16931Rule: "BR-14",
    text: "An Invoice shall have the Invoice total amount with VAT (BT-112).",
    run: (s) => (s.stated.taxInclusiveMinor === undefined ? absence(s, "BT-112") : undefined),
  },
  {
    id: "BR-15",
    en16931Rule: "BR-15",
    text: "An Invoice shall have the Amount due for payment (BT-115).",
    run: (s) => (s.stated.payableMinor === undefined ? absence(s, "BT-115") : undefined),
  },
  {
    id: "BR-16",
    en16931Rule: "BR-16",
    text: "An Invoice shall have at least one Invoice line (BG-25).",
    run: (s) => (s.invoice.lines.length > 0 ? undefined : "the invoice has no lines"),
  },
  {
    id: "BR-17",
    en16931Rule: "BR-17",
    text: "The Payee name (BT-59) shall be provided when the Payee is different from the Seller.",
    run: (s) => {
      if (s.invoice.payee === undefined) return null;
      if (!present(s.invoice.payee.name)) return "a payee is present with no name";
      return s.invoice.payee.name === s.invoice.seller.name
        ? "the payee is named identically to the seller, so BG-10 should be omitted"
        : undefined;
    },
  },

  // --- lines --------------------------------------------------------------
  {
    id: "BR-21",
    en16931Rule: "BR-21",
    text: "Each Invoice line shall have an Invoice line identifier (BT-126).",
    run: (s) => failingLines(s, (l) => !present(l.id), "no line identifier"),
  },
  {
    id: "BR-22",
    en16931Rule: "BR-22",
    text: "Each Invoice line shall have an Invoiced quantity (BT-129).",
    run: (s) => failingLines(s, (l) => !present(l.quantity), "no invoiced quantity"),
  },
  {
    id: "BR-23",
    en16931Rule: "BR-23",
    text: "Each Invoice line shall have an Invoiced quantity unit of measure code (BT-130).",
    run: (s) => failingLines(s, (l) => !present(l.unitCode), "no unit of measure code"),
  },
  {
    id: "BR-24",
    en16931Rule: "BR-24",
    text: "Each Invoice line shall have an Invoice line net amount (BT-131).",
    // Computed here from quantity and price, so it can only be absent if the
    // line carried neither; the check still runs so the set is the same in
    // both directions.
    run: (s) =>
      s.totals.lines.length === s.invoice.lines.length
        ? undefined
        : "a line produced no net amount",
  },
  {
    id: "BR-25",
    en16931Rule: "BR-25",
    text: "Each Invoice line shall have an Item name (BT-153).",
    run: (s) => failingLines(s, (l) => !present(l.name), "no item name"),
  },
  {
    id: "BR-26",
    en16931Rule: "BR-26",
    text: "Each Invoice line shall have an Item net price (BT-146).",
    run: (s) => failingLines(s, (l) => !Number.isFinite(l.unitPriceMinor), "no item net price"),
  },
  {
    id: "BR-27",
    en16931Rule: "BR-27",
    text: "The Item net price (BT-146) shall NOT be negative.",
    run: (s) => failingLines(s, (l) => l.unitPriceMinor < 0, "a negative item net price"),
  },
  {
    id: "BR-CO-04",
    en16931Rule: "BR-CO-04",
    text: "Each Invoice line shall be categorized with an Invoiced item VAT category code (BT-151).",
    run: (s) => failingLines(s, (l) => !present(l.vat?.categoryCode), "no VAT category code"),
  },

  // --- document-level allowances and charges -------------------------------
  {
    id: "BR-31",
    en16931Rule: "BR-31",
    text: "Each document level allowance shall have a Document level allowance amount (BT-92).",
    run: (s) =>
      failingAdjustments(
        s.invoice.allowances,
        (a) => !Number.isFinite(a.amountMinor),
        "allowance",
        "no amount",
      ),
  },
  {
    id: "BR-32",
    en16931Rule: "BR-32",
    text: "Each document level allowance shall have a Document level allowance VAT category code (BT-95).",
    run: (s) =>
      failingAdjustments(
        s.invoice.allowances,
        (a) => !present(a.vat?.categoryCode),
        "allowance",
        "no VAT category code",
      ),
  },
  {
    id: "BR-33",
    en16931Rule: "BR-33",
    text: "Each document level allowance shall have a reason (BT-97) or a reason code (BT-98).",
    run: (s) =>
      failingAdjustments(
        s.invoice.allowances,
        (a) => !present(a.reason) && !present(a.reasonCode),
        "allowance",
        "neither a reason nor a reason code",
      ),
  },
  {
    id: "BR-36",
    en16931Rule: "BR-36",
    text: "Each document level charge shall have a Document level charge amount (BT-99).",
    run: (s) =>
      failingAdjustments(
        s.invoice.charges,
        (a) => !Number.isFinite(a.amountMinor),
        "charge",
        "no amount",
      ),
  },
  {
    id: "BR-37",
    en16931Rule: "BR-37",
    text: "Each document level charge shall have a Document level charge VAT category code (BT-102).",
    run: (s) =>
      failingAdjustments(
        s.invoice.charges,
        (a) => !present(a.vat?.categoryCode),
        "charge",
        "no VAT category code",
      ),
  },
  {
    id: "BR-38",
    en16931Rule: "BR-38",
    text: "Each document level charge shall have a reason (BT-104) or a reason code (BT-105).",
    run: (s) =>
      failingAdjustments(
        s.invoice.charges,
        (a) => !present(a.reason) && !present(a.reasonCode),
        "charge",
        "neither a reason nor a reason code",
      ),
  },
  {
    id: "BR-41",
    en16931Rule: "BR-41",
    text: "Each Invoice line allowance shall have an Invoice line allowance amount (BT-136).",
    run: (s) =>
      lineAdjustments(s, "allowances", (a) => !Number.isFinite(a.amountMinor), "no amount"),
  },
  {
    id: "BR-42",
    en16931Rule: "BR-42",
    text: "Each Invoice line allowance shall have a reason (BT-139) or a reason code (BT-140).",
    run: (s) =>
      lineAdjustments(
        s,
        "allowances",
        (a) => !present(a.reason) && !present(a.reasonCode),
        "neither a reason nor a reason code",
      ),
  },
  {
    id: "BR-43",
    en16931Rule: "BR-43",
    text: "Each Invoice line charge shall have an Invoice line charge amount (BT-141).",
    run: (s) => lineAdjustments(s, "charges", (a) => !Number.isFinite(a.amountMinor), "no amount"),
  },
  {
    id: "BR-44",
    en16931Rule: "BR-44",
    text: "Each Invoice line charge shall have a reason (BT-144) or a reason code (BT-145).",
    run: (s) =>
      lineAdjustments(
        s,
        "charges",
        (a) => !present(a.reason) && !present(a.reasonCode),
        "neither a reason nor a reason code",
      ),
  },

  // --- VAT breakdown -------------------------------------------------------
  {
    id: "BR-CO-18",
    en16931Rule: "BR-CO-18",
    text: "An Invoice shall at least have one VAT breakdown group (BG-23).",
    run: (s) => (breakdown(s).length > 0 ? undefined : "no VAT breakdown"),
  },
  {
    id: "BR-45",
    en16931Rule: "BR-45",
    text: "Each VAT breakdown shall have a VAT category taxable amount (BT-116).",
    run: (s) =>
      breakdown(s).some((v) => v.taxableAmountMinor === undefined)
        ? "a VAT breakdown has no taxable amount"
        : undefined,
  },
  {
    id: "BR-46",
    en16931Rule: "BR-46",
    text: "Each VAT breakdown shall have a VAT category tax amount (BT-117).",
    run: (s) =>
      breakdown(s).some((v) => v.taxAmountMinor === undefined)
        ? "a VAT breakdown has no tax amount"
        : undefined,
  },
  {
    id: "BR-47",
    en16931Rule: "BR-47",
    text: "Each VAT breakdown shall be defined through a VAT category code (BT-118).",
    run: (s) =>
      breakdown(s).some((v) => !present(v.categoryCode))
        ? "a VAT breakdown has no category code"
        : undefined,
  },
  {
    id: "BR-48",
    en16931Rule: "BR-48",
    text: "Each VAT breakdown shall have a VAT category rate (BT-119), except where the Invoice is not subject to VAT.",
    run: (s) => {
      const offenders = breakdown(s).filter(
        (v) => v.categoryCode !== "O" && !present(v.ratePercent),
      );
      return offenders.length === 0
        ? undefined
        : `${offenders.length} VAT breakdown group(s) carry no rate`;
    },
  },

  // --- calculation ---------------------------------------------------------
  {
    id: "BR-CO-03",
    en16931Rule: "BR-CO-03",
    text: "Value added tax point date (BT-7) and Value added tax point date code (BT-8) are mutually exclusive.",
    run: (s) =>
      present(s.invoice.taxPointDate) && present(s.invoice.taxPointDateCode)
        ? "both a tax point date and a tax point date code are present"
        : undefined,
  },
  {
    id: "BR-CO-09",
    en16931Rule: "BR-CO-09",
    text: "Seller and Buyer VAT identifiers shall have an ISO 3166-1 alpha-2 country prefix.",
    run: (s) => {
      const bad: string[] = [];
      for (const [who, party] of [
        ["seller", s.invoice.seller],
        ["buyer", s.invoice.buyer],
      ] as const) {
        const id = party.vatId;
        if (id !== undefined && id !== "" && !/^[A-Z]{2}/.test(id.trim())) {
          bad.push(`${who} VAT identifier "${id}"`);
        }
      }
      if (s.invoice.seller.vatId === undefined && s.invoice.buyer.vatId === undefined) return null;
      return bad.length === 0 ? undefined : `${bad.join(" and ")} lack a two-letter prefix`;
    },
  },
  {
    id: "BR-CO-10",
    en16931Rule: "BR-CO-10",
    text: "Sum of Invoice line net amount (BT-106) = sum of Invoice line net amounts (BT-131).",
    run: (s) =>
      eq(s, s.stated.lineExtensionMinor, s.totals.lineExtensionMinor, s.currencyExponent, "BT-106"),
  },
  {
    id: "BR-CO-11",
    en16931Rule: "BR-CO-11",
    text: "Sum of allowances on document level (BT-107) = sum of Document level allowance amounts (BT-92).",
    run: (s) =>
      s.stated.allowanceTotalMinor === undefined && s.totals.allowanceTotalMinor === 0n
        ? null
        : eq(
            s,
            s.stated.allowanceTotalMinor ?? 0n,
            s.totals.allowanceTotalMinor,
            s.currencyExponent,
            "BT-107",
          ),
  },
  {
    id: "BR-CO-12",
    en16931Rule: "BR-CO-12",
    text: "Sum of charges on document level (BT-108) = sum of Document level charge amounts (BT-99).",
    run: (s) =>
      s.stated.chargeTotalMinor === undefined && s.totals.chargeTotalMinor === 0n
        ? null
        : eq(
            s,
            s.stated.chargeTotalMinor ?? 0n,
            s.totals.chargeTotalMinor,
            s.currencyExponent,
            "BT-108",
          ),
  },
  {
    id: "BR-CO-13",
    en16931Rule: "BR-CO-13",
    text: "Invoice total amount without VAT (BT-109) = BT-106 - BT-107 + BT-108.",
    run: (s) =>
      eq(s, s.stated.taxExclusiveMinor, s.totals.taxExclusiveMinor, s.currencyExponent, "BT-109"),
  },
  {
    id: "BR-CO-14",
    en16931Rule: "BR-CO-14",
    text: "Invoice total VAT amount (BT-110) = sum of VAT category tax amounts (BT-117).",
    run: (s) => {
      const statedBreakdown = s.stated.vatBreakdown;
      // Measured against the breakdown the DOCUMENT carries, not the one
      // recomputed from the lines: BR-CO-14 is about the document agreeing
      // with itself, and folding in the recomputation would report one defect
      // twice and hide which of the two it is.
      const expected =
        statedBreakdown === undefined
          ? s.totals.taxTotalMinor
          : statedBreakdown.reduce((sum, v) => sum + v.taxAmountMinor, 0n);
      return eq(s, s.stated.taxTotalMinor ?? 0n, expected, s.currencyExponent, "BT-110");
    },
  },
  {
    id: "BR-CO-15",
    en16931Rule: "BR-CO-15",
    text: "Invoice total amount with VAT (BT-112) = BT-109 + BT-110.",
    run: (s) => {
      if (s.stated.taxExclusiveMinor === undefined) return absence(s, "BT-109");
      if (s.stated.taxInclusiveMinor === undefined) return absence(s, "BT-112");
      const expected = s.stated.taxExclusiveMinor + (s.stated.taxTotalMinor ?? 0n);
      return eq(s, s.stated.taxInclusiveMinor, expected, s.currencyExponent, "BT-112");
    },
  },
  {
    id: "BR-CO-16",
    en16931Rule: "BR-CO-16",
    text: "Amount due for payment (BT-115) = BT-112 - BT-113 + BT-114.",
    run: (s) => {
      if (s.stated.taxInclusiveMinor === undefined) return absence(s, "BT-112");
      const expected =
        s.stated.taxInclusiveMinor - (s.stated.paidMinor ?? 0n) + (s.stated.roundingMinor ?? 0n);
      return eq(s, s.stated.payableMinor, expected, s.currencyExponent, "BT-115");
    },
  },
  {
    id: "BR-CO-17",
    en16931Rule: "BR-CO-17",
    text: "VAT category tax amount (BT-117) = BT-116 x (BT-119 / 100), rounded to two decimals.",
    run: (s) => {
      const failures: string[] = [];
      for (const group of breakdown(s)) {
        if (!present(group.ratePercent)) continue;
        const expected = taxOf(group.taxableAmountMinor, group.ratePercent);
        if (expected !== group.taxAmountMinor) {
          failures.push(
            `${group.categoryCode} at ${group.ratePercent}%: stated ${formatMinor(group.taxAmountMinor, s.currencyExponent)}, computed ${formatMinor(expected, s.currencyExponent)}`,
          );
        }
      }
      return failures.length === 0 ? undefined : failures.join("; ");
    },
  },
  {
    id: "BR-CO-25",
    en16931Rule: "BR-CO-25",
    text: "When the Amount due for payment (BT-115) is positive, a Payment due date (BT-9) or Payment terms (BT-20) shall be present.",
    run: (s) => {
      const due = s.stated.payableMinor ?? s.totals.payableMinor;
      if (due <= 0n) return null;
      return present(s.invoice.dueDate) || present(s.invoice.paymentTerms)
        ? undefined
        : "an amount is due with neither a due date nor payment terms";
    },
  },
  {
    id: "BR-61",
    en16931Rule: "BR-61",
    text: "When the Payment means type code (BT-81) is a credit transfer, a Payment account identifier (BT-84) shall be present.",
    run: (s) => {
      const code = s.invoice.paymentMeansCode;
      if (code === undefined || !CREDIT_TRANSFER_MEANS.has(code)) return null;
      return present(s.invoice.payeeIban)
        ? undefined
        : `payment means ${code} is a credit transfer but no account identifier is given`;
    },
  },
  {
    id: "BR-62",
    en16931Rule: "BR-62",
    text: "The Seller electronic address (BT-34) shall have a Scheme identifier.",
    run: (s) => {
      if (!present(s.invoice.seller.electronicAddress)) return null;
      return present(s.invoice.seller.electronicAddressScheme)
        ? undefined
        : "the seller electronic address has no scheme identifier";
    },
  },
  {
    id: "BR-63",
    en16931Rule: "BR-63",
    text: "The Buyer electronic address (BT-49) shall have a Scheme identifier.",
    run: (s) => {
      if (!present(s.invoice.buyer.electronicAddress)) return null;
      return present(s.invoice.buyer.electronicAddressScheme)
        ? undefined
        : "the buyer electronic address has no scheme identifier";
    },
  },

  // --- local checks: named CH-* because they are not transcriptions ---------
  {
    id: "CH-DEC-2",
    text: "Every monetary amount is written with no more decimal places than its currency has minor units (the effect of the BR-DEC-* family, whose per-field identifiers are not transcribed here).",
    run: (s) => {
      // Against the CURRENCY's exponent, not against two. A KWD amount of
      // "100.000" is exact and a JPY amount of "100.50" is not a currency
      // amount at all; a fixed two called the first a defect and let the
      // second through to be rounded on the quiet.
      const over = s.stated.overPreciseAmounts ?? [];
      const places = s.currencyExponent === 1 ? "one decimal" : `${s.currencyExponent} decimals`;
      return over.length === 0
        ? undefined
        : `${s.invoice.currency} has ${places}, but ${over.length} amount(s) carry more and were rounded half-up to read them: ${over.slice(0, 5).join(", ")}`;
    },
  },
  {
    id: "CH-AMOUNT-UNREADABLE",
    text: "Every monetary element the document carries could be read as a decimal. Not a BR rule and not something an XSD failure would tell you in these words: an element present but unreadable is dropped from the stated totals, so without this check a comparison against the rows would silently be a comparison against nothing.",
    run: (s) => {
      const bad = s.stated.unreadableAmounts ?? [];
      return bad.length === 0
        ? undefined
        : `${bad.length} monetary element(s) are present and not a decimal, so what the document states there is unknown — it is NOT zero and NOT absent: ${bad.slice(0, 5).join(", ")}`;
    },
  },
  {
    id: "CH-VAT-CATEGORY-CODE",
    text: `The VAT category code of every line, adjustment and breakdown is one of the EN 16931 subset of UNCL5305 (${VAT_CATEGORY_CODES.join(", ")}). This is the effect of a BR-CL-* rule; no other code list is checked.`,
    run: (s) => {
      const bad = new Set<string>();
      for (const line of s.invoice.lines) {
        const code = line.vat?.categoryCode;
        if (code !== undefined && !VAT_CATEGORY_CODES.includes(code)) bad.add(code);
      }
      for (const adj of [...(s.invoice.allowances ?? []), ...(s.invoice.charges ?? [])]) {
        const code = adj.vat?.categoryCode;
        if (code !== undefined && !VAT_CATEGORY_CODES.includes(code)) bad.add(code);
      }
      for (const group of breakdown(s)) {
        if (!VAT_CATEGORY_CODES.includes(group.categoryCode)) bad.add(group.categoryCode);
      }
      return bad.size === 0
        ? undefined
        : `unknown VAT category code(s): ${[...bad].sort().join(", ")}`;
    },
  },
  {
    id: "CH-INVOICE-TYPE-CODE",
    text: `The invoice type code is one of the EN 16931 subset of UNCL1001 (${INVOICE_TYPE_CODES.join(", ")}). Also the effect of a BR-CL-* rule.`,
    run: (s) => {
      const code = s.invoice.typeCode;
      if (code === undefined) return null;
      return INVOICE_TYPE_CODES.includes(code) ? undefined : `unknown invoice type code "${code}"`;
    },
  },
  {
    id: "CH-ZERO-RATE-CATEGORY",
    text: "A VAT breakdown whose category carries no tax (AE, E, G, K, O, Z) has a zero rate and a zero tax amount. This is the shared effect of the BR-AE-*, BR-E-*, BR-G-*, BR-IC-*, BR-O-* and BR-Z-* families; their individual identifiers are not transcribed here.",
    run: (s) => {
      const failures: string[] = [];
      for (const group of breakdown(s)) {
        if (!ZERO_TAX_CATEGORIES.has(group.categoryCode)) continue;
        if (present(group.ratePercent) && canonicalRate(group.ratePercent, "rate") !== "0") {
          failures.push(`${group.categoryCode} carries a rate of ${group.ratePercent}%`);
        }
        if (group.taxAmountMinor !== 0n) {
          failures.push(
            `${group.categoryCode} carries tax of ${formatMinor(group.taxAmountMinor, s.currencyExponent)}`,
          );
        }
      }
      return failures.length === 0 ? undefined : failures.join("; ");
    },
  },
  {
    id: "CH-EXEMPTION-REASON",
    text: "A VAT breakdown for reverse charge, exempt, free export, intra-community supply or out-of-scope carries an exemption reason or reason code; a standard-rated one carries neither. The effect of the BR-*-10 rules in those families.",
    run: (s) => {
      const failures: string[] = [];
      for (const group of breakdown(s)) {
        const hasReason = present(group.exemptionReason) || present(group.exemptionReasonCode);
        if (REASON_REQUIRED_CATEGORIES.has(group.categoryCode) && !hasReason) {
          failures.push(`${group.categoryCode} has no exemption reason`);
        }
        if (group.categoryCode === "S" && hasReason) {
          failures.push("a standard-rated breakdown carries an exemption reason");
        }
      }
      return failures.length === 0 ? undefined : failures.join("; ");
    },
  },
  {
    id: "CH-OUT-OF-SCOPE-EXCLUSIVE",
    text: "An invoice with an out-of-scope (O) VAT category carries no other category. The effect of the BR-O-11 through BR-O-14 rules.",
    run: (s) => {
      const codes = new Set(breakdown(s).map((v) => v.categoryCode));
      if (!codes.has("O")) return null;
      return codes.size === 1
        ? undefined
        : `category O appears alongside ${[...codes]
            .filter((c) => c !== "O")
            .sort()
            .join(", ")}`;
    },
  },
  {
    id: "CH-CATEGORY-TAXABLE-BASE",
    text: "Each VAT breakdown's taxable amount equals the line net amounts in its category and rate, less document allowances and plus document charges in the same one. The effect of the BR-*-08 rules.",
    run: (s) => {
      const stated = s.stated.vatBreakdown;
      if (stated === undefined) return null;
      const computed = new Map(
        s.totals.vatBreakdown.map((v) => [`${v.categoryCode}|${v.ratePercent}`, v]),
      );
      const failures: string[] = [];
      for (const group of stated) {
        const key = `${group.categoryCode}|${canonicalRate(group.ratePercent || "0", "rate")}`;
        const match = computed.get(key);
        if (match === undefined) {
          failures.push(`no rows fall in ${group.categoryCode} at ${group.ratePercent}%`);
          continue;
        }
        if (match.taxableAmountMinor !== group.taxableAmountMinor) {
          failures.push(
            `${group.categoryCode} at ${group.ratePercent}%: stated base ${formatMinor(group.taxableAmountMinor, s.currencyExponent)}, rows come to ${formatMinor(match.taxableAmountMinor, s.currencyExponent)}`,
          );
        }
      }
      for (const [key, group] of computed) {
        if (
          !stated.some(
            (v) => `${v.categoryCode}|${canonicalRate(v.ratePercent || "0", "rate")}` === key,
          )
        ) {
          failures.push(
            `rows fall in ${group.categoryCode} at ${group.ratePercent}% but the document has no such breakdown`,
          );
        }
      }
      return failures.length === 0 ? undefined : failures.join("; ");
    },
  },
  {
    id: "CH-EXEMPTION-REASON-CONFLICT",
    text: "Two rows in one VAT breakdown group do not give different exemption reasons. BG-23 has room for one, so a conflict silently attributes one row's explanation to another's tax.",
    run: (s) =>
      s.totals.exemptionReasonConflicts.length === 0
        ? undefined
        : s.totals.exemptionReasonConflicts.join("; "),
  },
  {
    id: "CH-DATE-FORMAT",
    text: "Every date is a real calendar date written as YYYY-MM-DD. Not a BR rule — a datatype the XSD would catch, which is not run here.",
    run: (s) => {
      const bad: string[] = [];
      for (const [label, value] of [
        ["issue date", s.invoice.issueDate],
        ["due date", s.invoice.dueDate],
        ["tax point date", s.invoice.taxPointDate],
      ] as const) {
        if (value !== undefined && value !== "" && !isRealDate(value))
          bad.push(`${label} "${value}"`);
      }
      return bad.length === 0 ? undefined : `${bad.join(", ")} is not a real YYYY-MM-DD date`;
    },
  },
  {
    id: "CH-CURRENCY-SHAPE",
    text: "The invoice currency is three upper-case letters. A SHAPE check, not a code-list check: the ISO 4217 list is not vendored here.",
    run: (s) =>
      /^[A-Z]{3}$/.test(s.invoice.currency)
        ? undefined
        : `"${s.invoice.currency}" is not a three-letter currency code`,
  },
  {
    id: "CH-LINE-ID-UNIQUE",
    text: "Invoice line identifiers are unique. Not a BR rule; duplicated identifiers make a credit note or a dispute unable to name one line.",
    run: (s) => {
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const line of s.invoice.lines) {
        if (seen.has(line.id)) dupes.add(line.id);
        seen.add(line.id);
      }
      return dupes.size === 0
        ? undefined
        : `duplicated line identifier(s): ${[...dupes].sort().join(", ")}`;
    },
  },
];

function breakdown(s: RuleSubject): ReadonlyArray<VatBreakdownEntry> {
  return s.stated.vatBreakdown ?? s.totals.vatBreakdown;
}

function failingLines(
  s: RuleSubject,
  predicate: (line: Invoice["lines"][number]) => boolean,
  what: string,
): string | undefined {
  const bad = s.invoice.lines.filter(predicate).map((l) => l.id || "(unidentified)");
  return bad.length === 0
    ? undefined
    : `${bad.length} line(s) have ${what}: ${bad.slice(0, 5).join(", ")}`;
}

function failingAdjustments(
  items: Invoice["allowances"],
  predicate: (a: NonNullable<Invoice["allowances"]>[number]) => boolean,
  kind: string,
  what: string,
): string | null | undefined {
  if (items === undefined || items.length === 0) return null;
  const bad = items.map((a, i) => ({ a, i })).filter(({ a }) => predicate(a));
  return bad.length === 0
    ? undefined
    : `document level ${kind}(s) at index ${bad.map((b) => b.i).join(", ")} have ${what}`;
}

function lineAdjustments(
  s: RuleSubject,
  key: "allowances" | "charges",
  predicate: (a: NonNullable<Invoice["allowances"]>[number]) => boolean,
  what: string,
): string | null | undefined {
  const offenders: string[] = [];
  let any = false;
  for (const line of s.invoice.lines) {
    for (const adj of line[key] ?? []) {
      any = true;
      if (predicate(adj)) offenders.push(line.id);
    }
  }
  if (!any) return null;
  return offenders.length === 0
    ? undefined
    : `line(s) ${[...new Set(offenders)].join(", ")} have a ${key.slice(0, -1)} with ${what}`;
}

/** Everything this table can report, in the order it reports it. */
export const CHECK_IDS: ReadonlyArray<string> = Object.freeze(CHECKS.map((c) => c.id));

/** The published rule identifiers among them. */
export const NAMED_RULES: ReadonlyArray<string> = Object.freeze(
  CHECKS.map((c) => c.en16931Rule).filter((r): r is string => r !== undefined),
);

const NOT_CHECKED: ReadonlyArray<string> = Object.freeze([
  "XSD schema validation (structure, cardinality and datatypes as UBL 2.1 or CII D16B define them)",
  "BR-CL-* — the code-list rules; ISO 4217, ISO 3166-1 and UN/ECE Recommendation 20 are not vendored here. Two closed lists are checked, under CH- identifiers.",
  "BR-UBL-* and BR-CII-* — the syntax-binding rules",
  "Peppol BIS Billing 3.0 and XRechnung national rules; selecting one as a preset sets identifiers only",
  "the individual identifiers of the BR-DEC-* and per-category BR-S/Z/E/AE/G/O/IC-* families; their effect is covered by the CH- checks above",
]);

/**
 * Run the table. Nothing here throws on a rule failure: a document that fails
 * a rule is still a document, and the caller wants the findings AND the
 * content. A rule whose subject is absent reports `notApplicable` rather than
 * passing, because a rule that passes for want of anything to check is how a
 * coverage number stops meaning anything.
 */
export function checkRules(subject: RuleSubject): RuleReport {
  const outcomes: RuleOutcome[] = [];
  for (const check of CHECKS) {
    let detail: string | null | undefined;
    let threw: string | undefined;
    try {
      detail = check.run(subject);
    } catch (err) {
      // A check that throws is a defect in THIS TABLE, not in the invoice.
      // It gets its own status: writing it into `failed` would tell the
      // caller that the document violates BR-CO-17 when all that happened is
      // that the check could not run, and somebody acts on that sentence.
      threw = `this check could not be evaluated, so nothing is known either way about this rule: ${(err as Error).message}`;
    }
    const status: RuleStatus =
      threw !== undefined
        ? "notEvaluated"
        : detail === null
          ? "notApplicable"
          : detail === undefined
            ? "passed"
            : "failed";
    const reported = threw ?? detail;
    outcomes.push({
      id: check.id,
      ...(check.en16931Rule === undefined ? {} : { en16931Rule: check.en16931Rule }),
      text: check.text,
      status,
      ...(typeof reported === "string" ? { detail: reported } : {}),
    });
  }
  const failed = outcomes.filter((o) => o.status === "failed");
  const notEvaluated = outcomes.filter((o) => o.status === "notEvaluated");
  const passed = outcomes.filter((o) => o.status === "passed").length;
  const notApplicable = outcomes.filter((o) => o.status === "notApplicable").length;
  const couldNotRun =
    notEvaluated.length === 0
      ? ""
      : ` ${notEvaluated.length} could not be evaluated at all (${notEvaluated.map((o) => o.id).join(", ")}) — that is a defect here, not a finding about the document, and those rules are neither passed nor failed.`;
  return {
    standard: "EN 16931-1 business rules, partially covered",
    checksRun: outcomes.length,
    passed,
    failed,
    notApplicable,
    notEvaluated,
    checkedIds: CHECK_IDS,
    namedEn16931Rules: NAMED_RULES,
    notChecked: NOT_CHECKED,
    verdict: `checked ${outcomes.length} rules of the EN 16931 rule set, not the whole of it — ${NAMED_RULES.length} of them are named published rules and the rest are marked CH- because they cover the effect of a family rather than transcribe it; ${failed.length} failed, ${notApplicable} did not apply.${couldNotRun} This is not a Schematron run and "no failures" is not "valid".`,
  };
}

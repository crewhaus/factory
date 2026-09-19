/**
 * The normalized invoice record, and the totals derived from it.
 *
 * One record shape serves both directions: `EInvoiceBuild` maps it out to UBL
 * or CII, and `EInvoiceParse` maps UBL or CII into it. That is what makes the
 * two tools comparable — a document parsed and rebuilt lands in the same
 * place, and a difference is a mapping bug rather than a matter of opinion.
 *
 * NO TOTAL IS AN INPUT. Every one of BT-106 through BT-115 and the whole VAT
 * breakdown is computed here from the lines and the document-level
 * allowances and charges. A caller-supplied total that disagrees with the rows
 * is the defect these formats exist to make impossible: the recipient's system
 * reads the total, the auditor reads the lines, and neither notices for a
 * year. On the way IN, a document's stated totals are kept separately and
 * reported as a comparison, never adopted.
 */
import { type Decimal, divideHalfUp, parseDecimal, scaleByRatio, sumMinor } from "./amounts";

/**
 * A record this package cannot compute totals from — as opposed to one whose
 * totals come out wrong, which is a rule finding rather than an error.
 *
 * Typed, so the tool layer can tell a caller's mistake from a defect here:
 * an untyped `Error` gets rethrown and reaches the caller as a stack trace
 * where an answer belongs.
 */
export class InvoiceRecordError extends Error {
  override readonly name = "InvoiceRecordError";
}

/** BG-23's category, as EN 16931 binds UNCL5305. */
export type VatCategory = {
  readonly categoryCode: string;
  readonly ratePercent: string;
  readonly exemptionReason?: string;
  readonly exemptionReasonCode?: string;
};

/** A document-level or line-level allowance (BG-20 / BG-27) or charge (BG-21 / BG-28). */
export type Adjustment = {
  readonly amountMinor: number;
  readonly reason?: string;
  readonly reasonCode?: string;
  readonly baseAmountMinor?: number;
  readonly percentage?: string;
  /** Document level only; a line-level adjustment takes the line's category. */
  readonly vat?: VatCategory;
};

export type PostalAddress = {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly postalCode?: string;
  readonly countrySubdivision?: string;
  /** BT-40 / BT-55, ISO 3166-1 alpha-2. */
  readonly country?: string;
};

export type Party = {
  readonly name: string;
  readonly tradingName?: string;
  readonly vatId?: string;
  readonly legalId?: string;
  readonly legalIdScheme?: string;
  readonly address?: PostalAddress;
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly contactEmail?: string;
  /** BT-34 / BT-49 — the routing address, with its scheme (e.g. "0088" for GLN). */
  readonly electronicAddress?: string;
  readonly electronicAddressScheme?: string;
};

export type InvoiceLine = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** BT-129. A decimal string, because 2.5 hours is a quantity. */
  readonly quantity: string;
  /** BT-130, UN/ECE Recommendation 20 (C62 = one, HUR = hour, KGM = kilogram). */
  readonly unitCode: string;
  /** BT-146, per `baseQuantity` units, in minor units of the invoice currency. */
  readonly unitPriceMinor: number;
  /** BT-149. A price of 0.0125 is 125 minor units per a base quantity of 100. */
  readonly baseQuantity?: string;
  readonly vat: VatCategory;
  readonly allowances?: ReadonlyArray<Adjustment>;
  readonly charges?: ReadonlyArray<Adjustment>;
  readonly note?: string;
  readonly sellerItemId?: string;
  readonly buyerAccountingReference?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
};

export type Invoice = {
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly typeCode?: string;
  readonly currency: string;
  readonly dueDate?: string;
  readonly paymentTerms?: string;
  readonly buyerReference?: string;
  readonly orderReference?: string;
  readonly note?: string;
  readonly taxPointDate?: string;
  readonly taxPointDateCode?: string;
  readonly seller: Party;
  readonly buyer: Party;
  readonly payee?: Party;
  readonly paymentMeansCode?: string;
  readonly payeeIban?: string;
  readonly payeeBic?: string;
  readonly paymentReference?: string;
  readonly lines: ReadonlyArray<InvoiceLine>;
  readonly allowances?: ReadonlyArray<Adjustment>;
  readonly charges?: ReadonlyArray<Adjustment>;
  /** BT-113 — already paid. Not derivable, so it is an input. */
  readonly paidAmountMinor?: number;
  /** BT-114 — the rounding line some jurisdictions require. Also an input. */
  readonly roundingAmountMinor?: number;
};

export type ComputedLine = {
  readonly id: string;
  /** quantity / baseQuantity x unitPrice, before line allowances and charges. */
  readonly grossAmountMinor: bigint;
  readonly allowanceTotalMinor: bigint;
  readonly chargeTotalMinor: bigint;
  /** BT-131. */
  readonly netAmountMinor: bigint;
  readonly vat: VatCategory;
};

export type VatBreakdownEntry = {
  readonly categoryCode: string;
  readonly ratePercent: string;
  /** BT-116. */
  readonly taxableAmountMinor: bigint;
  /** BT-117. */
  readonly taxAmountMinor: bigint;
  readonly exemptionReason?: string;
  readonly exemptionReasonCode?: string;
};

export type InvoiceTotals = {
  readonly lines: ReadonlyArray<ComputedLine>;
  readonly vatBreakdown: ReadonlyArray<VatBreakdownEntry>;
  /** BT-106. */
  readonly lineExtensionMinor: bigint;
  /** BT-107. */
  readonly allowanceTotalMinor: bigint;
  /** BT-108. */
  readonly chargeTotalMinor: bigint;
  /** BT-109. */
  readonly taxExclusiveMinor: bigint;
  /** BT-110. */
  readonly taxTotalMinor: bigint;
  /** BT-112. */
  readonly taxInclusiveMinor: bigint;
  /** BT-113. */
  readonly paidMinor: bigint;
  /** BT-114. */
  readonly roundingMinor: bigint;
  /** BT-115. */
  readonly payableMinor: bigint;
  /**
   * Category groups whose lines disagreed about the exemption reason. Kept
   * rather than resolved: BG-23 has room for exactly one reason per group, so
   * silently taking the first would put one line's explanation on another
   * line's tax, and the wrong exemption reason is found in an audit.
   */
  readonly exemptionReasonConflicts: ReadonlyArray<string>;
};

const ONE = "1";
const HUNDRED: Decimal = { unscaled: 100n, scale: 0 };

/**
 * The canonical spelling of a rate, for grouping.
 *
 * "19", "19.0" and "19.00" are one rate, and a breakdown that splits them into
 * three groups produces three BG-23s the recipient's validator rejects. Zeros
 * are trimmed off the fraction and a bare integer keeps no point.
 */
export function canonicalRate(text: string, label: string): string {
  const value = parseDecimal(text, label);
  if (value.scale === 0) return value.unscaled.toString();
  let unscaled = value.unscaled;
  let scale = value.scale;
  while (scale > 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale -= 1;
  }
  if (scale === 0) return unscaled.toString();
  const negative = unscaled < 0n;
  const abs = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, "0");
  const whole = abs.slice(0, abs.length - scale);
  const fraction = abs.slice(abs.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function adjustmentTotal(items: ReadonlyArray<Adjustment> | undefined): bigint {
  return sumMinor((items ?? []).map((a) => BigInt(a.amountMinor)));
}

/** BT-131 for one line: quantity x price, then its own allowances and charges. */
export function computeLine(line: InvoiceLine): ComputedLine {
  const quantity = parseDecimal(line.quantity, `line ${line.id} quantity`);
  const base = parseDecimal(line.baseQuantity ?? ONE, `line ${line.id} baseQuantity`);
  const gross = scaleByRatio(BigInt(line.unitPriceMinor), quantity, base);
  const allowanceTotalMinor = adjustmentTotal(line.allowances);
  const chargeTotalMinor = adjustmentTotal(line.charges);
  return {
    id: line.id,
    grossAmountMinor: gross,
    allowanceTotalMinor,
    chargeTotalMinor,
    netAmountMinor: gross - allowanceTotalMinor + chargeTotalMinor,
    vat: { ...line.vat, ratePercent: canonicalRate(line.vat.ratePercent, `line ${line.id} rate`) },
  };
}

/**
 * Everything BR-CO-10 through BR-CO-17 says a total is, computed rather than
 * accepted.
 *
 * The VAT breakdown groups by (category code, rate) — the pair BG-23 keys on.
 * Document-level allowances subtract from, and charges add to, the taxable
 * amount of the group their OWN category names, which is why each of them
 * carries a category of its own: a discount at 19% does not reduce the 7%
 * base, and getting that wrong moves tax between rates while leaving the
 * invoice total looking right.
 */
export function computeTotals(invoice: Invoice): InvoiceTotals {
  const lines = invoice.lines.map(computeLine);
  const lineExtensionMinor = sumMinor(lines.map((l) => l.netAmountMinor));
  const allowanceTotalMinor = adjustmentTotal(invoice.allowances);
  const chargeTotalMinor = adjustmentTotal(invoice.charges);
  const taxExclusiveMinor = lineExtensionMinor - allowanceTotalMinor + chargeTotalMinor;

  type Group = {
    categoryCode: string;
    ratePercent: string;
    taxable: bigint;
    reasons: Set<string>;
    reasonCode?: string;
    exemptionReason?: string;
  };
  const groups = new Map<string, Group>();
  const keyOf = (vat: VatCategory, label: string): string => {
    const rate = canonicalRate(vat.ratePercent, label);
    return `${vat.categoryCode}|${rate}`;
  };
  const groupFor = (vat: VatCategory, label: string): Group => {
    const key = keyOf(vat, label);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        categoryCode: vat.categoryCode,
        ratePercent: canonicalRate(vat.ratePercent, label),
        taxable: 0n,
        reasons: new Set(),
      };
      groups.set(key, group);
    }
    if (vat.exemptionReason !== undefined && vat.exemptionReason !== "") {
      group.reasons.add(vat.exemptionReason);
      group.exemptionReason ??= vat.exemptionReason;
    }
    if (vat.exemptionReasonCode !== undefined && vat.exemptionReasonCode !== "") {
      group.reasonCode ??= vat.exemptionReasonCode;
    }
    return group;
  };

  for (const line of lines) {
    groupFor(line.vat, `line ${line.id} rate`).taxable += line.netAmountMinor;
  }
  for (const [index, allowance] of (invoice.allowances ?? []).entries()) {
    if (allowance.vat === undefined) {
      throw new InvoiceRecordError(
        `document-level allowance ${index} has no VAT category; EN 16931 BR-32 requires one, and without it the amount cannot be subtracted from any taxable base`,
      );
    }
    groupFor(allowance.vat, `allowance ${index} rate`).taxable -= BigInt(allowance.amountMinor);
  }
  for (const [index, charge] of (invoice.charges ?? []).entries()) {
    if (charge.vat === undefined) {
      throw new InvoiceRecordError(
        `document-level charge ${index} has no VAT category; EN 16931 BR-37 requires one, and without it the amount cannot be added to any taxable base`,
      );
    }
    groupFor(charge.vat, `charge ${index} rate`).taxable += BigInt(charge.amountMinor);
  }

  // Deterministic order: category code, then rate as a NUMBER. Sorting the
  // rate as text puts "7" after "19", and a breakdown whose order depends on
  // string collation is not a file you can diff against the one you sent.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.categoryCode !== b.categoryCode) return a.categoryCode < b.categoryCode ? -1 : 1;
    const ra = parseDecimal(a.ratePercent, "rate");
    const rb = parseDecimal(b.ratePercent, "rate");
    const diff = ra.unscaled * 10n ** BigInt(rb.scale) - rb.unscaled * 10n ** BigInt(ra.scale);
    return diff === 0n ? 0 : diff < 0n ? -1 : 1;
  });

  const vatBreakdown: VatBreakdownEntry[] = ordered.map((group) => ({
    categoryCode: group.categoryCode,
    ratePercent: group.ratePercent,
    taxableAmountMinor: group.taxable,
    taxAmountMinor: scaleByRatio(group.taxable, parseDecimal(group.ratePercent, "rate"), HUNDRED),
    ...(group.exemptionReason === undefined ? {} : { exemptionReason: group.exemptionReason }),
    ...(group.reasonCode === undefined ? {} : { exemptionReasonCode: group.reasonCode }),
  }));

  const taxTotalMinor = sumMinor(vatBreakdown.map((v) => v.taxAmountMinor));
  const taxInclusiveMinor = taxExclusiveMinor + taxTotalMinor;
  const paidMinor = BigInt(invoice.paidAmountMinor ?? 0);
  const roundingMinor = BigInt(invoice.roundingAmountMinor ?? 0);

  return {
    lines,
    vatBreakdown,
    lineExtensionMinor,
    allowanceTotalMinor,
    chargeTotalMinor,
    taxExclusiveMinor,
    taxTotalMinor,
    taxInclusiveMinor,
    paidMinor,
    roundingMinor,
    payableMinor: taxInclusiveMinor - paidMinor + roundingMinor,
    exemptionReasonConflicts: ordered
      .filter((g) => g.reasons.size > 1)
      .map((g) => `${g.categoryCode} at ${g.ratePercent}%: ${[...g.reasons].sort().join(" / ")}`),
  };
}

/** Half-up percentage, exposed so the rule checker computes tax the same way. */
export function taxOf(taxableMinor: bigint, ratePercent: string): bigint {
  return scaleByRatio(taxableMinor, parseDecimal(ratePercent, "rate"), HUNDRED);
}

/** Exposed for the same reason: one rounding rule, used everywhere. */
export { divideHalfUp };

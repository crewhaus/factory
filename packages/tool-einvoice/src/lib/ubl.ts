/**
 * UBL 2.1 Invoice — the syntax Peppol BIS Billing 3.0 and XRechnung's UBL
 * flavour use.
 *
 * Element ORDER here is the UBL schema's sequence, which is not a stylistic
 * choice: UBL's content models are sequences, so an element in the wrong place
 * is a document the recipient's XSD rejects. This package does not run an XSD
 * (see `en16931.ts` for what is and is not checked), so the order below is the
 * only thing standing between the record and a rejected file. Do not sort it.
 *
 * No total is written from an argument. Everything under `LegalMonetaryTotal`
 * and every `TaxSubtotal` comes from `computeTotals`, off the rows.
 */
import { formatMinor } from "./amounts";
import type { StatedTotals } from "./en16931";
import type { Adjustment, Invoice, InvoiceTotals, Party, VatBreakdownEntry } from "./invoice";
import {
  type MoneyReader,
  type ParsedDocument,
  compact,
  moneyReader,
  orUndefined,
  readMoney,
} from "./syntax";
import {
  path,
  type El,
  type ParsedElement,
  attr,
  child,
  childrenNamed,
  textAt,
  textOf,
} from "./xml";

export const UBL_INVOICE_NAMESPACE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";

type BuildOptions = {
  readonly customizationId: string;
  readonly profileId?: string;
  readonly exponent: number;
};

/** `<cbc:Name>text</cbc:Name>`, or nothing when there is no text. */
function cbc(
  name: string,
  text: string | undefined,
  attrs?: Record<string, string>,
): El | undefined {
  if (text === undefined || text === "") return undefined;
  return { name: `cbc:${name}`, text, ...(attrs === undefined ? {} : { attrs }) };
}

function group(name: string, children: ReadonlyArray<El | undefined>): El | undefined {
  const kept = children.filter((c): c is El => c !== undefined);
  return kept.length === 0 ? undefined : { name: `cac:${name}`, children: kept };
}

function amount(name: string, minor: bigint, currency: string, exponent: number): El {
  return {
    name: `cbc:${name}`,
    attrs: { currencyID: currency },
    text: formatMinor(minor, exponent),
  };
}

function taxCategory(vat: VatBreakdownEntry | Adjustment["vat"], withReason: boolean): El {
  const category = vat as VatBreakdownEntry;
  return {
    name: "cac:TaxCategory",
    children: [
      cbc("ID", category.categoryCode),
      cbc("Percent", category.ratePercent),
      withReason ? cbc("TaxExemptionReasonCode", category.exemptionReasonCode) : undefined,
      withReason ? cbc("TaxExemptionReason", category.exemptionReason) : undefined,
      { name: "cac:TaxScheme", children: [{ name: "cbc:ID", text: "VAT" }] },
    ].filter((c): c is El => c !== undefined),
  };
}

function partyElement(tag: string, party: Party): El {
  return {
    name: `cac:${tag}`,
    children: [
      {
        name: "cac:Party",
        children: [
          cbc(
            "EndpointID",
            party.electronicAddress,
            party.electronicAddressScheme === undefined
              ? undefined
              : { schemeID: party.electronicAddressScheme },
          ),
          group("PartyName", [cbc("Name", party.tradingName)]),
          group("PostalAddress", [
            cbc("StreetName", party.address?.line1),
            cbc("AdditionalStreetName", party.address?.line2),
            cbc("CityName", party.address?.city),
            cbc("PostalZone", party.address?.postalCode),
            cbc("CountrySubentity", party.address?.countrySubdivision),
            group("Country", [cbc("IdentificationCode", party.address?.country)]),
          ]),
          party.vatId === undefined
            ? undefined
            : {
                name: "cac:PartyTaxScheme",
                children: [
                  { name: "cbc:CompanyID", text: party.vatId },
                  { name: "cac:TaxScheme", children: [{ name: "cbc:ID", text: "VAT" }] },
                ],
              },
          group("PartyLegalEntity", [
            cbc("RegistrationName", party.name),
            cbc(
              "CompanyID",
              party.legalId,
              party.legalIdScheme === undefined ? undefined : { schemeID: party.legalIdScheme },
            ),
          ]),
          group("Contact", [
            cbc("Name", party.contactName),
            cbc("Telephone", party.contactPhone),
            cbc("ElectronicMail", party.contactEmail),
          ]),
        ],
      },
    ],
  };
}

function allowanceCharge(
  adjustment: Adjustment,
  isCharge: boolean,
  currency: string,
  exponent: number,
  documentLevel: boolean,
): El {
  return {
    name: "cac:AllowanceCharge",
    children: [
      { name: "cbc:ChargeIndicator", text: isCharge ? "true" : "false" },
      cbc("AllowanceChargeReasonCode", adjustment.reasonCode),
      cbc("AllowanceChargeReason", adjustment.reason),
      cbc("MultiplierFactorNumeric", adjustment.percentage),
      amount("Amount", BigInt(adjustment.amountMinor), currency, exponent),
      adjustment.baseAmountMinor === undefined
        ? undefined
        : amount("BaseAmount", BigInt(adjustment.baseAmountMinor), currency, exponent),
      documentLevel && adjustment.vat !== undefined
        ? taxCategory(adjustment.vat, false)
        : undefined,
    ].filter((c): c is El => c !== undefined),
  };
}

/** Build the document. Totals come from `totals`; none of them is an argument. */
export function buildUbl(invoice: Invoice, totals: InvoiceTotals, options: BuildOptions): El {
  const currency = invoice.currency;
  const exp = options.exponent;
  const money = (name: string, minor: bigint): El => amount(name, minor, currency, exp);

  const lines: El[] = invoice.lines.map((line, index) => {
    const computed = totals.lines[index];
    if (computed === undefined) throw new Error(`no computed total for line "${line.id}"`);
    return {
      name: "cac:InvoiceLine",
      children: [
        { name: "cbc:ID", text: line.id },
        cbc("Note", line.note),
        {
          name: "cbc:InvoicedQuantity",
          attrs: { unitCode: line.unitCode },
          text: line.quantity,
        },
        money("LineExtensionAmount", computed.netAmountMinor),
        cbc("AccountingCost", line.buyerAccountingReference),
        group("InvoicePeriod", [
          cbc("StartDate", line.periodStart),
          cbc("EndDate", line.periodEnd),
        ]),
        ...(line.allowances ?? []).map((a) => allowanceCharge(a, false, currency, exp, false)),
        ...(line.charges ?? []).map((a) => allowanceCharge(a, true, currency, exp, false)),
        {
          name: "cac:Item",
          children: [
            cbc("Description", line.description),
            { name: "cbc:Name", text: line.name },
            group("SellersItemIdentification", [cbc("ID", line.sellerItemId)]),
            {
              name: "cac:ClassifiedTaxCategory",
              children: [
                { name: "cbc:ID", text: line.vat.categoryCode },
                ...(computed.vat.ratePercent === ""
                  ? []
                  : [{ name: "cbc:Percent", text: computed.vat.ratePercent }]),
                { name: "cac:TaxScheme", children: [{ name: "cbc:ID", text: "VAT" }] },
              ],
            },
          ].filter((c): c is El => c !== undefined),
        },
        {
          name: "cac:Price",
          children: [
            amount("PriceAmount", BigInt(line.unitPriceMinor), currency, exp),
            line.baseQuantity === undefined
              ? undefined
              : {
                  name: "cbc:BaseQuantity",
                  attrs: { unitCode: line.unitCode },
                  text: line.baseQuantity,
                },
          ].filter((c): c is El => c !== undefined),
        },
      ].filter((c): c is El => c !== undefined),
    };
  });

  return {
    name: "Invoice",
    attrs: { xmlns: UBL_INVOICE_NAMESPACE, "xmlns:cac": CAC, "xmlns:cbc": CBC },
    children: [
      { name: "cbc:CustomizationID", text: options.customizationId },
      cbc("ProfileID", options.profileId),
      { name: "cbc:ID", text: invoice.invoiceNumber },
      { name: "cbc:IssueDate", text: invoice.issueDate },
      cbc("DueDate", invoice.dueDate),
      { name: "cbc:InvoiceTypeCode", text: invoice.typeCode ?? "380" },
      cbc("Note", invoice.note),
      cbc("TaxPointDate", invoice.taxPointDate),
      { name: "cbc:DocumentCurrencyCode", text: currency },
      cbc("BuyerReference", invoice.buyerReference),
      group("OrderReference", [cbc("ID", invoice.orderReference)]),
      partyElement("AccountingSupplierParty", invoice.seller),
      partyElement("AccountingCustomerParty", invoice.buyer),
      invoice.payee === undefined
        ? undefined
        : {
            name: "cac:PayeeParty",
            children: [
              { name: "cac:PartyName", children: [{ name: "cbc:Name", text: invoice.payee.name }] },
            ],
          },
      invoice.paymentMeansCode === undefined
        ? undefined
        : {
            name: "cac:PaymentMeans",
            children: [
              { name: "cbc:PaymentMeansCode", text: invoice.paymentMeansCode },
              cbc("PaymentID", invoice.paymentReference),
              group("PayeeFinancialAccount", [
                cbc("ID", invoice.payeeIban),
                group("FinancialInstitutionBranch", [cbc("ID", invoice.payeeBic)]),
              ]),
            ].filter((c): c is El => c !== undefined),
          },
      group("PaymentTerms", [cbc("Note", invoice.paymentTerms)]),
      ...(invoice.allowances ?? []).map((a) => allowanceCharge(a, false, currency, exp, true)),
      ...(invoice.charges ?? []).map((a) => allowanceCharge(a, true, currency, exp, true)),
      {
        name: "cac:TaxTotal",
        children: [
          money("TaxAmount", totals.taxTotalMinor),
          ...totals.vatBreakdown.map(
            (entry): El => ({
              name: "cac:TaxSubtotal",
              children: [
                money("TaxableAmount", entry.taxableAmountMinor),
                money("TaxAmount", entry.taxAmountMinor),
                taxCategory(entry, true),
              ],
            }),
          ),
        ],
      },
      {
        name: "cac:LegalMonetaryTotal",
        children: [
          money("LineExtensionAmount", totals.lineExtensionMinor),
          money("TaxExclusiveAmount", totals.taxExclusiveMinor),
          money("TaxInclusiveAmount", totals.taxInclusiveMinor),
          totals.allowanceTotalMinor === 0n
            ? undefined
            : money("AllowanceTotalAmount", totals.allowanceTotalMinor),
          totals.chargeTotalMinor === 0n
            ? undefined
            : money("ChargeTotalAmount", totals.chargeTotalMinor),
          totals.paidMinor === 0n ? undefined : money("PrepaidAmount", totals.paidMinor),
          totals.roundingMinor === 0n
            ? undefined
            : money("PayableRoundingAmount", totals.roundingMinor),
          money("PayableAmount", totals.payableMinor),
        ].filter((c): c is El => c !== undefined),
      },
      ...lines,
    ].filter((c): c is El => c !== undefined),
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * The `cac:PartyTaxScheme` that carries BT-31, which is the one whose
 * `cac:TaxScheme/cbc:ID` is VAT.
 *
 * A party routinely declares more than one: XRechnung puts the German
 * Steuernummer under scheme `FC` alongside the VAT identifier under `VAT`,
 * and the order is the sender's choice. Taking the first one puts a tax
 * number in BT-31 whenever FC happens to come first — which then fails
 * BR-CO-09 for want of a country prefix, reporting a violation of a published
 * rule against a document that satisfies it.
 *
 * A party that declares exactly one scheme and does not name it is read as
 * the VAT one, because that is what a document with nothing to disambiguate
 * means.
 */
function vatCompanyId(party: ParsedElement | undefined): ParsedElement | undefined {
  if (party === undefined) return undefined;
  const schemes = childrenNamed(party, "PartyTaxScheme");
  const named = schemes.find((scheme) => textAt(scheme, "TaxScheme", "ID").toUpperCase() === "VAT");
  if (named !== undefined) return child(named, "CompanyID");
  const unnamed = schemes.filter((scheme) => textAt(scheme, "TaxScheme", "ID") === "");
  return unnamed.length === 1 ? child(unnamed[0] as ParsedElement, "CompanyID") : undefined;
}

/**
 * A stated amount as the record's `number`, or `undefined`.
 *
 * NOT `?? 0`: an element that is present and unreadable is not a zero. A
 * prepaid amount that read as zero put the whole invoice back on the payable
 * line and left the document looking internally consistent about it.
 */
function amountOrUndefined(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function readParty(el: ParsedElement | undefined): Party {
  const party = child(el ?? ({ name: "", attributes: {}, children: [] } as ParsedElement), "Party");
  const address = path(party, "PostalAddress");
  const endpoint = party === undefined ? undefined : child(party, "EndpointID");
  const legal = path(party, "PartyLegalEntity");
  const companyId = legal === undefined ? undefined : child(legal, "CompanyID");
  return compact({
    // BT-27 is the registration name; the PartyName is the trading name
    // (BT-28) and is NOT a fallback for it. Substituting one for the other
    // would make BR-06 pass on a document that does not carry a seller name.
    name: textAt(party, "PartyLegalEntity", "RegistrationName"),
    tradingName: orUndefined(textAt(party, "PartyName", "Name")),
    vatId: orUndefined(textOf(vatCompanyId(party))),
    legalId: orUndefined(textOf(companyId)),
    legalIdScheme: attr(companyId, "schemeID"),
    address:
      address === undefined
        ? undefined
        : compact({
            line1: orUndefined(textAt(address, "StreetName")),
            line2: orUndefined(textAt(address, "AdditionalStreetName")),
            city: orUndefined(textAt(address, "CityName")),
            postalCode: orUndefined(textAt(address, "PostalZone")),
            countrySubdivision: orUndefined(textAt(address, "CountrySubentity")),
            country: orUndefined(textAt(address, "Country", "IdentificationCode")),
          }),
    contactName: orUndefined(textAt(party, "Contact", "Name")),
    contactPhone: orUndefined(textAt(party, "Contact", "Telephone")),
    contactEmail: orUndefined(textAt(party, "Contact", "ElectronicMail")),
    electronicAddress: orUndefined(textOf(endpoint)),
    electronicAddressScheme: attr(endpoint, "schemeID"),
  }) as Party;
}

function readAdjustment(el: ParsedElement, reader: MoneyReader, label: string): Adjustment {
  const category = child(el, "TaxCategory");
  return compact({
    amountMinor: Number(readMoney(reader, textAt(el, "Amount"), `${label} amount`) ?? 0n),
    reason: orUndefined(textAt(el, "AllowanceChargeReason")),
    reasonCode: orUndefined(textAt(el, "AllowanceChargeReasonCode")),
    baseAmountMinor:
      child(el, "BaseAmount") === undefined
        ? undefined
        : Number(readMoney(reader, textAt(el, "BaseAmount"), `${label} base`) ?? 0n),
    percentage: orUndefined(textAt(el, "MultiplierFactorNumeric")),
    vat:
      category === undefined
        ? undefined
        : {
            categoryCode: textAt(category, "ID"),
            ratePercent: textAt(category, "Percent") || "0",
          },
  }) as Adjustment;
}

/** Map a UBL `Invoice` element into the record and the totals it CLAIMS. */
export function parseUbl(root: ParsedElement): ParsedDocument {
  const currency = textAt(root, "DocumentCurrencyCode");
  const reader = moneyReader(currency);
  const totalsEl = child(root, "LegalMonetaryTotal");
  const taxTotal = child(root, "TaxTotal");

  const adjustments = childrenNamed(root, "AllowanceCharge");
  const allowances: Adjustment[] = [];
  const charges: Adjustment[] = [];
  for (const [i, el] of adjustments.entries()) {
    const isCharge = textAt(el, "ChargeIndicator").toLowerCase() === "true";
    (isCharge ? charges : allowances).push(
      readAdjustment(el, reader, `document ${isCharge ? "charge" : "allowance"} ${i}`),
    );
  }

  const lines = childrenNamed(root, "InvoiceLine").map((el) => {
    const item = child(el, "Item");
    const price = child(el, "Price");
    const category = item === undefined ? undefined : child(item, "ClassifiedTaxCategory");
    const quantityEl = child(el, "InvoicedQuantity");
    const lineId = textAt(el, "ID");
    const lineAllowances: Adjustment[] = [];
    const lineCharges: Adjustment[] = [];
    for (const [i, adjustment] of childrenNamed(el, "AllowanceCharge").entries()) {
      const isCharge = textAt(adjustment, "ChargeIndicator").toLowerCase() === "true";
      (isCharge ? lineCharges : lineAllowances).push(
        readAdjustment(adjustment, reader, `line ${lineId} adjustment ${i}`),
      );
    }
    const baseQuantity = price === undefined ? undefined : child(price, "BaseQuantity");
    return compact({
      id: lineId,
      name: textAt(item, "Name"),
      description: orUndefined(textAt(item, "Description")),
      quantity: textOf(quantityEl) || "0",
      unitCode: attr(quantityEl, "unitCode") ?? "",
      unitPriceMinor: Number(
        readMoney(reader, textAt(price, "PriceAmount"), `line ${lineId} price`) ?? 0n,
      ),
      baseQuantity: orUndefined(textOf(baseQuantity)),
      vat: {
        categoryCode: textAt(category, "ID"),
        ratePercent: textAt(category, "Percent") || "0",
      },
      allowances: lineAllowances.length === 0 ? undefined : lineAllowances,
      charges: lineCharges.length === 0 ? undefined : lineCharges,
      note: orUndefined(textAt(el, "Note")),
      sellerItemId: orUndefined(textAt(item, "SellersItemIdentification", "ID")),
      buyerAccountingReference: orUndefined(textAt(el, "AccountingCost")),
      periodStart: orUndefined(textAt(el, "InvoicePeriod", "StartDate")),
      periodEnd: orUndefined(textAt(el, "InvoicePeriod", "EndDate")),
    }) as Invoice["lines"][number];
  });

  const paymentMeans = child(root, "PaymentMeans");
  const invoice = compact({
    invoiceNumber: textAt(root, "ID"),
    issueDate: textAt(root, "IssueDate"),
    typeCode: orUndefined(textAt(root, "InvoiceTypeCode")),
    currency,
    dueDate: orUndefined(textAt(root, "DueDate")),
    paymentTerms: orUndefined(textAt(root, "PaymentTerms", "Note")),
    buyerReference: orUndefined(textAt(root, "BuyerReference")),
    orderReference: orUndefined(textAt(root, "OrderReference", "ID")),
    note: orUndefined(textAt(root, "Note")),
    taxPointDate: orUndefined(textAt(root, "TaxPointDate")),
    seller: readParty(child(root, "AccountingSupplierParty")),
    buyer: readParty(child(root, "AccountingCustomerParty")),
    payee:
      child(root, "PayeeParty") === undefined
        ? undefined
        : { name: textAt(root, "PayeeParty", "PartyName", "Name") },
    paymentMeansCode: orUndefined(textAt(paymentMeans, "PaymentMeansCode")),
    payeeIban: orUndefined(textAt(paymentMeans, "PayeeFinancialAccount", "ID")),
    payeeBic: orUndefined(
      textAt(paymentMeans, "PayeeFinancialAccount", "FinancialInstitutionBranch", "ID"),
    ),
    paymentReference: orUndefined(textAt(paymentMeans, "PaymentID")),
    lines,
    allowances: allowances.length === 0 ? undefined : allowances,
    charges: charges.length === 0 ? undefined : charges,
    paidAmountMinor: amountOrUndefined(
      readMoney(reader, textAt(totalsEl, "PrepaidAmount"), "BT-113"),
    ),
    roundingAmountMinor: amountOrUndefined(
      readMoney(reader, textAt(totalsEl, "PayableRoundingAmount"), "BT-114"),
    ),
  }) as Invoice;

  const vatBreakdown: VatBreakdownEntry[] =
    taxTotal === undefined
      ? []
      : childrenNamed(taxTotal, "TaxSubtotal").map((sub) => {
          const category = child(sub, "TaxCategory");
          return compact({
            categoryCode: textAt(category, "ID"),
            ratePercent: textAt(category, "Percent") || "0",
            taxableAmountMinor: readMoney(reader, textAt(sub, "TaxableAmount"), "BT-116") ?? 0n,
            taxAmountMinor: readMoney(reader, textAt(sub, "TaxAmount"), "BT-117") ?? 0n,
            exemptionReason: orUndefined(textAt(category, "TaxExemptionReason")),
            exemptionReasonCode: orUndefined(textAt(category, "TaxExemptionReasonCode")),
          }) as VatBreakdownEntry;
        });

  const stated: StatedTotals = compact({
    lineExtensionMinor: readMoney(reader, textAt(totalsEl, "LineExtensionAmount"), "BT-106"),
    allowanceTotalMinor: readMoney(reader, textAt(totalsEl, "AllowanceTotalAmount"), "BT-107"),
    chargeTotalMinor: readMoney(reader, textAt(totalsEl, "ChargeTotalAmount"), "BT-108"),
    taxExclusiveMinor: readMoney(reader, textAt(totalsEl, "TaxExclusiveAmount"), "BT-109"),
    taxTotalMinor:
      taxTotal === undefined
        ? undefined
        : readMoney(reader, textAt(taxTotal, "TaxAmount"), "BT-110"),
    taxInclusiveMinor: readMoney(reader, textAt(totalsEl, "TaxInclusiveAmount"), "BT-112"),
    paidMinor: readMoney(reader, textAt(totalsEl, "PrepaidAmount"), "BT-113"),
    roundingMinor: readMoney(reader, textAt(totalsEl, "PayableRoundingAmount"), "BT-114"),
    payableMinor: readMoney(reader, textAt(totalsEl, "PayableAmount"), "BT-115"),
    vatBreakdown: vatBreakdown.length === 0 ? undefined : vatBreakdown,
  }) as StatedTotals;

  return compact({
    syntax: "ubl",
    invoice,
    stated: {
      ...stated,
      overPreciseAmounts: reader.overPrecise,
      unreadableAmounts: reader.unreadable,
    },
    customizationId: orUndefined(textAt(root, "CustomizationID")),
    profileId: orUndefined(textAt(root, "ProfileID")),
    currencyExponent: reader.exponent,
  }) as ParsedDocument;
}

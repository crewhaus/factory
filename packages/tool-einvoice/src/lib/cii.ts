/**
 * UN/CEFACT Cross Industry Invoice (D16B) — the syntax Factur-X, ZUGFeRD and
 * XRechnung's CII flavour use.
 *
 * Same semantic model as UBL, different shape: the tax breakdown is
 * `ram:ApplicableTradeTax` rather than `cac:TaxSubtotal`, dates are a
 * `format="102"` basic date inside a wrapper rather than the element's own
 * text, and an allowance's charge indicator is an element with an element
 * inside it. Element order is again the schema's sequence and again
 * load-bearing — see the note at the top of `ubl.ts`.
 *
 * One asymmetry worth naming: CII has no single "document level allowance"
 * container. The header allowances and charges are one repeated element
 * distinguished by `ChargeIndicator`, exactly as at line level, so the parse
 * has to split them and the build has to interleave them in the right order.
 */
import { formatMinor } from "./amounts";
import type { StatedTotals } from "./en16931";
import type { Adjustment, Invoice, InvoiceTotals, Party, VatBreakdownEntry } from "./invoice";
import {
  type MoneyReader,
  type ParsedDocument,
  compact,
  fromBasicDate,
  moneyReader,
  orUndefined,
  readMoney,
  toBasicDate,
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

export const CII_NAMESPACE = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";
const RAM = "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100";
const UDT = "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100";

type BuildOptions = {
  readonly customizationId: string;
  readonly exponent: number;
};

function ram(
  name: string,
  text: string | undefined,
  attrs?: Record<string, string>,
): El | undefined {
  if (text === undefined || text === "") return undefined;
  return { name: `ram:${name}`, text, ...(attrs === undefined ? {} : { attrs }) };
}

function ramGroup(name: string, children: ReadonlyArray<El | undefined>): El | undefined {
  const kept = children.filter((c): c is El => c !== undefined);
  return kept.length === 0 ? undefined : { name: `ram:${name}`, children: kept };
}

function dateElement(tag: string, isoDate: string | undefined): El | undefined {
  if (isoDate === undefined || isoDate === "") return undefined;
  return {
    name: `ram:${tag}`,
    children: [
      { name: "udt:DateTimeString", attrs: { format: "102" }, text: toBasicDate(isoDate) },
    ],
  };
}

function tradeParty(tag: string, party: Party): El {
  return {
    name: `ram:${tag}`,
    children: [
      ram("ID", party.legalId),
      { name: "ram:Name", text: party.name },
      ramGroup("SpecifiedLegalOrganization", [
        ram(
          "ID",
          party.legalId,
          party.legalIdScheme === undefined ? undefined : { schemeID: party.legalIdScheme },
        ),
        ram("TradingBusinessName", party.tradingName),
      ]),
      ramGroup("DefinedTradeContact", [
        ram("PersonName", party.contactName),
        party.contactPhone === undefined
          ? undefined
          : {
              name: "ram:TelephoneUniversalCommunication",
              children: [{ name: "ram:CompleteNumber", text: party.contactPhone }],
            },
        party.contactEmail === undefined
          ? undefined
          : {
              name: "ram:EmailURIUniversalCommunication",
              children: [{ name: "ram:URIID", text: party.contactEmail }],
            },
      ]),
      ramGroup("PostalTradeAddress", [
        ram("PostcodeCode", party.address?.postalCode),
        ram("LineOne", party.address?.line1),
        ram("LineTwo", party.address?.line2),
        ram("CityName", party.address?.city),
        ram("CountryID", party.address?.country),
        ram("CountrySubDivisionName", party.address?.countrySubdivision),
      ]),
      party.electronicAddress === undefined
        ? undefined
        : {
            name: "ram:URIUniversalCommunication",
            children: [
              {
                name: "ram:URIID",
                attrs:
                  party.electronicAddressScheme === undefined
                    ? {}
                    : { schemeID: party.electronicAddressScheme },
                text: party.electronicAddress,
              },
            ],
          },
      party.vatId === undefined
        ? undefined
        : {
            name: "ram:SpecifiedTaxRegistration",
            children: [{ name: "ram:ID", attrs: { schemeID: "VA" }, text: party.vatId }],
          },
    ].filter((c): c is El => c !== undefined),
  };
}

function tradeAdjustment(
  adjustment: Adjustment,
  isCharge: boolean,
  exponent: number,
  documentLevel: boolean,
): El {
  return {
    name: "ram:SpecifiedTradeAllowanceCharge",
    children: [
      {
        name: "ram:ChargeIndicator",
        children: [{ name: "udt:Indicator", text: isCharge ? "true" : "false" }],
      },
      ram("CalculationPercent", adjustment.percentage),
      adjustment.baseAmountMinor === undefined
        ? undefined
        : ram("BasisAmount", formatMinor(BigInt(adjustment.baseAmountMinor), exponent)),
      { name: "ram:ActualAmount", text: formatMinor(BigInt(adjustment.amountMinor), exponent) },
      ram("ReasonCode", adjustment.reasonCode),
      ram("Reason", adjustment.reason),
      documentLevel && adjustment.vat !== undefined
        ? {
            name: "ram:CategoryTradeTax",
            children: [
              { name: "ram:TypeCode", text: "VAT" },
              { name: "ram:CategoryCode", text: adjustment.vat.categoryCode },
              { name: "ram:RateApplicablePercent", text: adjustment.vat.ratePercent },
            ],
          }
        : undefined,
    ].filter((c): c is El => c !== undefined),
  };
}

export function buildCii(invoice: Invoice, totals: InvoiceTotals, options: BuildOptions): El {
  const exp = options.exponent;
  const currency = invoice.currency;
  const money = (name: string, minor: bigint): El => ({
    name: `ram:${name}`,
    text: formatMinor(minor, exp),
  });

  const lineItems: El[] = invoice.lines.map((line, index) => {
    const computed = totals.lines[index];
    if (computed === undefined) throw new Error(`no computed total for line "${line.id}"`);
    return {
      name: "ram:IncludedSupplyChainTradeLineItem",
      children: [
        {
          name: "ram:AssociatedDocumentLineDocument",
          children: [
            { name: "ram:LineID", text: line.id },
            ...(line.note === undefined
              ? []
              : [
                  {
                    name: "ram:IncludedNote",
                    children: [{ name: "ram:Content", text: line.note }],
                  },
                ]),
          ],
        },
        {
          name: "ram:SpecifiedTradeProduct",
          children: [
            ram("SellerAssignedID", line.sellerItemId),
            { name: "ram:Name", text: line.name },
            ram("Description", line.description),
          ].filter((c): c is El => c !== undefined),
        },
        {
          name: "ram:SpecifiedLineTradeAgreement",
          children: [
            {
              name: "ram:NetPriceProductTradePrice",
              children: [
                { name: "ram:ChargeAmount", text: formatMinor(BigInt(line.unitPriceMinor), exp) },
                ...(line.baseQuantity === undefined
                  ? []
                  : [
                      {
                        name: "ram:BasisQuantity",
                        attrs: { unitCode: line.unitCode },
                        text: line.baseQuantity,
                      },
                    ]),
              ],
            },
          ],
        },
        {
          name: "ram:SpecifiedLineTradeDelivery",
          children: [
            { name: "ram:BilledQuantity", attrs: { unitCode: line.unitCode }, text: line.quantity },
          ],
        },
        {
          name: "ram:SpecifiedLineTradeSettlement",
          children: [
            {
              name: "ram:ApplicableTradeTax",
              children: [
                { name: "ram:TypeCode", text: "VAT" },
                { name: "ram:CategoryCode", text: line.vat.categoryCode },
                ...(computed.vat.ratePercent === ""
                  ? []
                  : [{ name: "ram:RateApplicablePercent", text: computed.vat.ratePercent }]),
              ],
            },
            ramGroup("BillingSpecifiedPeriod", [
              dateElement("StartDateTime", line.periodStart),
              dateElement("EndDateTime", line.periodEnd),
            ]),
            ...(line.allowances ?? []).map((a) => tradeAdjustment(a, false, exp, false)),
            ...(line.charges ?? []).map((a) => tradeAdjustment(a, true, exp, false)),
            {
              name: "ram:SpecifiedTradeSettlementLineMonetarySummation",
              children: [money("LineTotalAmount", computed.netAmountMinor)],
            },
            ramGroup("ReceivableSpecifiedTradeAccountingAccount", [
              ram("ID", line.buyerAccountingReference),
            ]),
          ].filter((c): c is El => c !== undefined),
        },
      ],
    };
  });

  return {
    name: "rsm:CrossIndustryInvoice",
    attrs: { "xmlns:rsm": CII_NAMESPACE, "xmlns:ram": RAM, "xmlns:udt": UDT },
    children: [
      {
        name: "rsm:ExchangedDocumentContext",
        children: [
          {
            name: "ram:GuidelineSpecifiedDocumentContextParameter",
            children: [{ name: "ram:ID", text: options.customizationId }],
          },
        ],
      },
      {
        name: "rsm:ExchangedDocument",
        children: [
          { name: "ram:ID", text: invoice.invoiceNumber },
          { name: "ram:TypeCode", text: invoice.typeCode ?? "380" },
          dateElement("IssueDateTime", invoice.issueDate) as El,
          ...(invoice.note === undefined
            ? []
            : [
                {
                  name: "ram:IncludedNote",
                  children: [{ name: "ram:Content", text: invoice.note }],
                },
              ]),
        ],
      },
      {
        name: "rsm:SupplyChainTradeTransaction",
        children: [
          ...lineItems,
          {
            name: "ram:ApplicableHeaderTradeAgreement",
            children: [
              ram("BuyerReference", invoice.buyerReference),
              tradeParty("SellerTradeParty", invoice.seller),
              tradeParty("BuyerTradeParty", invoice.buyer),
              ramGroup("BuyerOrderReferencedDocument", [
                ram("IssuerAssignedID", invoice.orderReference),
              ]),
            ].filter((c): c is El => c !== undefined),
          },
          { name: "ram:ApplicableHeaderTradeDelivery" },
          {
            name: "ram:ApplicableHeaderTradeSettlement",
            children: [
              ram("PaymentReference", invoice.paymentReference),
              { name: "ram:InvoiceCurrencyCode", text: currency },
              invoice.payee === undefined
                ? undefined
                : {
                    name: "ram:PayeeTradeParty",
                    children: [{ name: "ram:Name", text: invoice.payee.name }],
                  },
              invoice.paymentMeansCode === undefined
                ? undefined
                : {
                    name: "ram:SpecifiedTradeSettlementPaymentMeans",
                    children: [
                      { name: "ram:TypeCode", text: invoice.paymentMeansCode },
                      ramGroup("PayeePartyCreditorFinancialAccount", [
                        ram("IBANID", invoice.payeeIban),
                      ]),
                      ramGroup("PayeeSpecifiedCreditorFinancialInstitution", [
                        ram("BICID", invoice.payeeBic),
                      ]),
                    ].filter((c): c is El => c !== undefined),
                  },
              ...totals.vatBreakdown.map(
                (entry): El => ({
                  name: "ram:ApplicableTradeTax",
                  children: [
                    { name: "ram:CalculatedAmount", text: formatMinor(entry.taxAmountMinor, exp) },
                    { name: "ram:TypeCode", text: "VAT" },
                    ...(entry.exemptionReason === undefined
                      ? []
                      : [{ name: "ram:ExemptionReason", text: entry.exemptionReason }]),
                    { name: "ram:BasisAmount", text: formatMinor(entry.taxableAmountMinor, exp) },
                    { name: "ram:CategoryCode", text: entry.categoryCode },
                    ...(entry.exemptionReasonCode === undefined
                      ? []
                      : [{ name: "ram:ExemptionReasonCode", text: entry.exemptionReasonCode }]),
                    ...(entry.ratePercent === ""
                      ? []
                      : [{ name: "ram:RateApplicablePercent", text: entry.ratePercent }]),
                  ],
                }),
              ),
              ...(invoice.allowances ?? []).map((a) => tradeAdjustment(a, false, exp, true)),
              ...(invoice.charges ?? []).map((a) => tradeAdjustment(a, true, exp, true)),
              ramGroup("SpecifiedTradePaymentTerms", [
                ram("Description", invoice.paymentTerms),
                dateElement("DueDateDateTime", invoice.dueDate),
              ]),
              {
                name: "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
                children: [
                  money("LineTotalAmount", totals.lineExtensionMinor),
                  totals.chargeTotalMinor === 0n
                    ? undefined
                    : money("ChargeTotalAmount", totals.chargeTotalMinor),
                  totals.allowanceTotalMinor === 0n
                    ? undefined
                    : money("AllowanceTotalAmount", totals.allowanceTotalMinor),
                  money("TaxBasisTotalAmount", totals.taxExclusiveMinor),
                  {
                    name: "ram:TaxTotalAmount",
                    attrs: { currencyID: currency },
                    text: formatMinor(totals.taxTotalMinor, exp),
                  },
                  totals.roundingMinor === 0n
                    ? undefined
                    : money("RoundingAmount", totals.roundingMinor),
                  money("GrandTotalAmount", totals.taxInclusiveMinor),
                  totals.paidMinor === 0n
                    ? undefined
                    : money("TotalPrepaidAmount", totals.paidMinor),
                  money("DuePayableAmount", totals.payableMinor),
                ].filter((c): c is El => c !== undefined),
              },
            ].filter((c): c is El => c !== undefined),
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

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

/**
 * The `ram:SpecifiedTaxRegistration` that carries BT-31, which is the one
 * whose `ram:ID` has `schemeID="VA"`.
 *
 * A ZUGFeRD or Factur-X seller commonly declares two — the local tax number
 * under `FC` and the VAT identifier under `VA` — in whichever order the
 * sender chose, and the FC one first is the layout in the published samples.
 * Reading only the first registration therefore drops BT-31 from a perfectly
 * correct document (or, if the schemeID check were dropped, files the tax
 * number as the VAT identifier). Both registrations are searched.
 *
 * A single registration with no schemeID is read as the VAT one: that is what
 * a document with nothing to disambiguate means.
 */
function vatRegistrationId(el: ParsedElement | undefined): ParsedElement | undefined {
  if (el === undefined) return undefined;
  const ids = childrenNamed(el, "SpecifiedTaxRegistration")
    .map((registration) => child(registration, "ID"))
    .filter((id): id is ParsedElement => id !== undefined);
  const named = ids.find((id) => attr(id, "schemeID")?.toUpperCase() === "VA");
  if (named !== undefined) return named;
  const unnamed = ids.filter((id) => attr(id, "schemeID") === undefined);
  return unnamed.length === 1 ? unnamed[0] : undefined;
}

function readTradeParty(el: ParsedElement | undefined): Party {
  const address = path(el, "PostalTradeAddress");
  const uri = path(el, "URIUniversalCommunication", "URIID");
  const taxId = vatRegistrationId(el);
  const legalId = path(el, "SpecifiedLegalOrganization", "ID");
  return compact({
    name: textAt(el, "Name"),
    tradingName: orUndefined(textAt(el, "SpecifiedLegalOrganization", "TradingBusinessName")),
    // Already narrowed to the VA registration by `vatRegistrationId`.
    vatId: orUndefined(textOf(taxId)),
    legalId: orUndefined(textOf(legalId)),
    legalIdScheme: attr(legalId, "schemeID"),
    address:
      address === undefined
        ? undefined
        : compact({
            line1: orUndefined(textAt(address, "LineOne")),
            line2: orUndefined(textAt(address, "LineTwo")),
            city: orUndefined(textAt(address, "CityName")),
            postalCode: orUndefined(textAt(address, "PostcodeCode")),
            countrySubdivision: orUndefined(textAt(address, "CountrySubDivisionName")),
            country: orUndefined(textAt(address, "CountryID")),
          }),
    contactName: orUndefined(textAt(el, "DefinedTradeContact", "PersonName")),
    contactPhone: orUndefined(
      textAt(el, "DefinedTradeContact", "TelephoneUniversalCommunication", "CompleteNumber"),
    ),
    contactEmail: orUndefined(
      textAt(el, "DefinedTradeContact", "EmailURIUniversalCommunication", "URIID"),
    ),
    electronicAddress: orUndefined(textOf(uri)),
    electronicAddressScheme: attr(uri, "schemeID"),
  }) as Party;
}

function readTradeAdjustment(el: ParsedElement, reader: MoneyReader, label: string): Adjustment {
  const category = child(el, "CategoryTradeTax");
  return compact({
    amountMinor: Number(readMoney(reader, textAt(el, "ActualAmount"), `${label} amount`) ?? 0n),
    reason: orUndefined(textAt(el, "Reason")),
    reasonCode: orUndefined(textAt(el, "ReasonCode")),
    baseAmountMinor:
      child(el, "BasisAmount") === undefined
        ? undefined
        : Number(readMoney(reader, textAt(el, "BasisAmount"), `${label} base`) ?? 0n),
    percentage: orUndefined(textAt(el, "CalculationPercent")),
    vat:
      category === undefined
        ? undefined
        : {
            categoryCode: textAt(category, "CategoryCode"),
            ratePercent: textAt(category, "RateApplicablePercent") || "0",
          },
  }) as Adjustment;
}

export function parseCii(root: ParsedElement): ParsedDocument {
  const doc = child(root, "ExchangedDocument");
  const transaction = child(root, "SupplyChainTradeTransaction");
  const settlement = path(transaction, "ApplicableHeaderTradeSettlement");
  const agreement = path(transaction, "ApplicableHeaderTradeAgreement");
  const summation =
    settlement === undefined
      ? undefined
      : child(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const currency = textAt(settlement, "InvoiceCurrencyCode");
  const reader = moneyReader(currency);

  const allowances: Adjustment[] = [];
  const charges: Adjustment[] = [];
  if (settlement !== undefined) {
    for (const [i, el] of childrenNamed(settlement, "SpecifiedTradeAllowanceCharge").entries()) {
      const isCharge = textAt(el, "ChargeIndicator", "Indicator").toLowerCase() === "true";
      (isCharge ? charges : allowances).push(
        readTradeAdjustment(el, reader, `document ${isCharge ? "charge" : "allowance"} ${i}`),
      );
    }
  }

  const lines = (
    transaction === undefined ? [] : childrenNamed(transaction, "IncludedSupplyChainTradeLineItem")
  ).map((el) => {
    const lineSettlement = child(el, "SpecifiedLineTradeSettlement");
    const tax =
      lineSettlement === undefined ? undefined : child(lineSettlement, "ApplicableTradeTax");
    const quantity = path(el, "SpecifiedLineTradeDelivery", "BilledQuantity");
    const price = path(el, "SpecifiedLineTradeAgreement", "NetPriceProductTradePrice");
    const basis = price === undefined ? undefined : child(price, "BasisQuantity");
    const lineId = textAt(el, "AssociatedDocumentLineDocument", "LineID");
    const lineAllowances: Adjustment[] = [];
    const lineCharges: Adjustment[] = [];
    if (lineSettlement !== undefined) {
      for (const [i, adjustment] of childrenNamed(
        lineSettlement,
        "SpecifiedTradeAllowanceCharge",
      ).entries()) {
        const isCharge =
          textAt(adjustment, "ChargeIndicator", "Indicator").toLowerCase() === "true";
        (isCharge ? lineCharges : lineAllowances).push(
          readTradeAdjustment(adjustment, reader, `line ${lineId} adjustment ${i}`),
        );
      }
    }
    return compact({
      id: lineId,
      name: textAt(el, "SpecifiedTradeProduct", "Name"),
      description: orUndefined(textAt(el, "SpecifiedTradeProduct", "Description")),
      quantity: textOf(quantity) || "0",
      unitCode: attr(quantity, "unitCode") ?? "",
      unitPriceMinor: Number(
        readMoney(reader, textAt(price, "ChargeAmount"), `line ${lineId} price`) ?? 0n,
      ),
      baseQuantity: orUndefined(textOf(basis)),
      vat: {
        categoryCode: textAt(tax, "CategoryCode"),
        ratePercent: textAt(tax, "RateApplicablePercent") || "0",
      },
      allowances: lineAllowances.length === 0 ? undefined : lineAllowances,
      charges: lineCharges.length === 0 ? undefined : lineCharges,
      note: orUndefined(textAt(el, "AssociatedDocumentLineDocument", "IncludedNote", "Content")),
      sellerItemId: orUndefined(textAt(el, "SpecifiedTradeProduct", "SellerAssignedID")),
      buyerAccountingReference: orUndefined(
        textAt(lineSettlement, "ReceivableSpecifiedTradeAccountingAccount", "ID"),
      ),
      periodStart: orUndefined(
        fromBasicDate(textAt(lineSettlement, "BillingSpecifiedPeriod", "StartDateTime")),
      ),
      periodEnd: orUndefined(
        fromBasicDate(textAt(lineSettlement, "BillingSpecifiedPeriod", "EndDateTime")),
      ),
    }) as Invoice["lines"][number];
  });

  const means =
    settlement === undefined
      ? undefined
      : child(settlement, "SpecifiedTradeSettlementPaymentMeans");

  const invoice = compact({
    invoiceNumber: textAt(doc, "ID"),
    issueDate: fromBasicDate(textAt(doc, "IssueDateTime", "DateTimeString")),
    typeCode: orUndefined(textAt(doc, "TypeCode")),
    currency,
    dueDate: orUndefined(
      fromBasicDate(
        textAt(settlement, "SpecifiedTradePaymentTerms", "DueDateDateTime", "DateTimeString"),
      ),
    ),
    paymentTerms: orUndefined(textAt(settlement, "SpecifiedTradePaymentTerms", "Description")),
    buyerReference: orUndefined(textAt(agreement, "BuyerReference")),
    orderReference: orUndefined(
      textAt(agreement, "BuyerOrderReferencedDocument", "IssuerAssignedID"),
    ),
    note: orUndefined(textAt(doc, "IncludedNote", "Content")),
    seller: readTradeParty(path(agreement, "SellerTradeParty")),
    buyer: readTradeParty(path(agreement, "BuyerTradeParty")),
    payee:
      settlement === undefined || child(settlement, "PayeeTradeParty") === undefined
        ? undefined
        : { name: textAt(settlement, "PayeeTradeParty", "Name") },
    paymentMeansCode: orUndefined(textAt(means, "TypeCode")),
    payeeIban: orUndefined(textAt(means, "PayeePartyCreditorFinancialAccount", "IBANID")),
    payeeBic: orUndefined(textAt(means, "PayeeSpecifiedCreditorFinancialInstitution", "BICID")),
    paymentReference: orUndefined(textAt(settlement, "PaymentReference")),
    lines,
    allowances: allowances.length === 0 ? undefined : allowances,
    charges: charges.length === 0 ? undefined : charges,
    paidAmountMinor: amountOrUndefined(
      readMoney(reader, textAt(summation, "TotalPrepaidAmount"), "BT-113"),
    ),
    roundingAmountMinor: amountOrUndefined(
      readMoney(reader, textAt(summation, "RoundingAmount"), "BT-114"),
    ),
  }) as Invoice;

  const vatBreakdown: VatBreakdownEntry[] =
    settlement === undefined
      ? []
      : childrenNamed(settlement, "ApplicableTradeTax").map(
          (tax) =>
            compact({
              categoryCode: textAt(tax, "CategoryCode"),
              ratePercent: textAt(tax, "RateApplicablePercent") || "0",
              taxableAmountMinor: readMoney(reader, textAt(tax, "BasisAmount"), "BT-116") ?? 0n,
              taxAmountMinor: readMoney(reader, textAt(tax, "CalculatedAmount"), "BT-117") ?? 0n,
              exemptionReason: orUndefined(textAt(tax, "ExemptionReason")),
              exemptionReasonCode: orUndefined(textAt(tax, "ExemptionReasonCode")),
            }) as VatBreakdownEntry,
        );

  const stated: StatedTotals = compact({
    lineExtensionMinor: readMoney(reader, textAt(summation, "LineTotalAmount"), "BT-106"),
    allowanceTotalMinor: readMoney(reader, textAt(summation, "AllowanceTotalAmount"), "BT-107"),
    chargeTotalMinor: readMoney(reader, textAt(summation, "ChargeTotalAmount"), "BT-108"),
    taxExclusiveMinor: readMoney(reader, textAt(summation, "TaxBasisTotalAmount"), "BT-109"),
    taxTotalMinor: readMoney(reader, textAt(summation, "TaxTotalAmount"), "BT-110"),
    taxInclusiveMinor: readMoney(reader, textAt(summation, "GrandTotalAmount"), "BT-112"),
    paidMinor: readMoney(reader, textAt(summation, "TotalPrepaidAmount"), "BT-113"),
    roundingMinor: readMoney(reader, textAt(summation, "RoundingAmount"), "BT-114"),
    payableMinor: readMoney(reader, textAt(summation, "DuePayableAmount"), "BT-115"),
    vatBreakdown: vatBreakdown.length === 0 ? undefined : vatBreakdown,
  }) as StatedTotals;

  return compact({
    syntax: "cii",
    invoice,
    stated: {
      ...stated,
      overPreciseAmounts: reader.overPrecise,
      unreadableAmounts: reader.unreadable,
    },
    customizationId: orUndefined(
      textAt(root, "ExchangedDocumentContext", "GuidelineSpecifiedDocumentContextParameter", "ID"),
    ),
    currencyExponent: reader.exponent,
  }) as ParsedDocument;
}

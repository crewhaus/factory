/**
 * The records the tests drive, in one place so a change to the shape shows up
 * once rather than in forty literals.
 *
 * Every routing number here carries a REAL ABA check digit, because the
 * builder recomputes it and would refuse a made-up one. `routingWithCheckDigit`
 * is how the bulk test manufactures thousands more.
 */
import type { Invoice } from "./lib/invoice";
import { abaCheckDigit } from "./lib/nacha";
import type { Payment } from "./lib/payments";

export const SELLER = {
  name: "Nordwind Handel GmbH",
  vatId: "DE123456789",
  address: {
    line1: "Hafenstrasse 1",
    city: "Hamburg",
    postalCode: "20095",
    country: "DE",
  },
  electronicAddress: "4030000000001",
  electronicAddressScheme: "0088",
} as const;

export const BUYER = {
  name: "Compagnie du Sud SARL",
  vatId: "FR12345678901",
  address: {
    line1: "12 rue Bleue",
    city: "Lyon",
    postalCode: "69001",
    country: "FR",
  },
  electronicAddress: "FR99887766",
  electronicAddressScheme: "0009",
} as const;

/**
 * Two rates, a fractional quantity and a document-level allowance — the shape
 * where every calculation rule has something to bite on.
 *
 * Its arithmetic, worked by hand: 10 x 12.50 = 125.00, 2.5 x 90.00 = 225.00 at
 * 19%, 1 x 40.00 = 40.00 at 7%. Lines 390.00, allowance 5.00 against the 19%
 * base, so 385.00 without VAT. 19% of 345.00 is 65.55 and 7% of 40.00 is 2.80,
 * so 68.35 of VAT and 453.35 with it.
 */
export const INVOICE: Invoice = {
  invoiceNumber: "INV-2026-0001",
  issueDate: "2026-03-02",
  typeCode: "380",
  currency: "EUR",
  dueDate: "2026-04-01",
  buyerReference: "PO-99",
  seller: SELLER,
  buyer: BUYER,
  paymentMeansCode: "58",
  payeeIban: "DE89370400440532013000",
  lines: [
    {
      id: "1",
      name: "Widget",
      quantity: "10",
      unitCode: "C62",
      unitPriceMinor: 1250,
      vat: { categoryCode: "S", ratePercent: "19" },
    },
    {
      id: "2",
      name: "Support hours",
      quantity: "2.5",
      unitCode: "HUR",
      unitPriceMinor: 9000,
      vat: { categoryCode: "S", ratePercent: "19" },
    },
    {
      id: "3",
      name: "Printed manual",
      quantity: "1",
      unitCode: "C62",
      unitPriceMinor: 4000,
      vat: { categoryCode: "S", ratePercent: "7" },
    },
  ],
  allowances: [
    {
      amountMinor: 500,
      reason: "Early settlement",
      vat: { categoryCode: "S", ratePercent: "19" },
    },
  ],
};

export const EXPECTED = {
  lineExtension: "390.00",
  allowanceTotal: "5.00",
  taxExclusive: "385.00",
  taxTotal: "68.35",
  taxInclusive: "453.35",
  payable: "453.35",
} as const;

/** A nine-digit routing number whose ninth digit is the real check digit. */
export function routingWithCheckDigit(first8: string): string {
  return `${first8}${abaCheckDigit(first8)}`;
}

export const CHASE = "021000021";
export const WELLS = "011401533";

export const NACHA_OPTIONS = {
  immediateDestination: CHASE,
  immediateOrigin: WELLS,
  destinationName: "CHASE",
  originName: "ACME PAYROLL",
  companyName: "ACME INC",
  companyId: "1123456789",
  companyEntryDescription: "PAYROLL",
  standardEntryClass: "PPD" as const,
  odfiRouting: WELLS,
  creationDate: "2026-03-02",
  creationTime: "09:30",
  effectiveEntryDate: "2026-03-04",
};

export const NACHA_PAYMENTS: ReadonlyArray<Payment> = [
  {
    id: "PAY-1",
    amountMinor: 125_000,
    name: "Jane Doe",
    routingNumber: CHASE,
    accountNumber: "12345678",
    accountType: "checking",
  },
  {
    id: "PAY-2",
    amountMinor: 50_000,
    name: "John Smith",
    routingNumber: WELLS,
    accountNumber: "9988776655",
    accountType: "savings",
    addenda: "INV 2026-0001",
  },
];

export const SEPA_OPTIONS = {
  messageId: "MSG-2026-03-02-1",
  creationDateTime: "2026-03-02T09:30:00Z",
  paymentInformationId: "PMT-1",
  requestedExecutionDate: "2026-03-04",
  debtorName: "Acme Europe BV",
  debtorIban: "NL91ABNA0417164300",
  debtorBic: "ABNANL2A",
};

export const SEPA_PAYMENTS: ReadonlyArray<Payment> = [
  {
    id: "E2E-1",
    amountMinor: 125_000,
    name: "Jurgen Muller",
    iban: "DE89370400440532013000",
    remittance: "RF18 5390 0754 7034",
  },
  {
    id: "E2E-2",
    amountMinor: 999,
    name: "Alesund Fisk AS",
    iban: "NL91ABNA0417164300",
    bic: "ABNANL2A",
  },
];

/**
 * Every key any object in a zod schema declares, collected by walking the
 * schema tree.
 *
 * The obvious version — stringifying `schema.shape` — sees only the top level,
 * so a credential nested inside `payments[].` or inside an optional block
 * would pass a test that claims no schema anywhere accepts one. This walks
 * arrays, optionals, unions, records and effects, which is what makes the
 * claim mean what it says.
 */
export function collectSchemaKeys(schema: unknown, depth = 0): Set<string> {
  const found = new Set<string>();
  if (depth > 20 || schema === null || typeof schema !== "object") return found;
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (def === undefined) return found;
  const merge = (child: unknown): void => {
    for (const key of collectSchemaKeys(child, depth + 1)) found.add(key);
  };
  const shape = (schema as { shape?: unknown }).shape;
  if (shape !== undefined) {
    const entries = typeof shape === "function" ? (shape as () => object)() : shape;
    for (const [key, value] of Object.entries(entries as object)) {
      found.add(key);
      merge(value);
    }
  }
  for (const key of ["type", "innerType", "schema", "valueType", "keyType", "element"]) {
    if (def[key] !== undefined) merge(def[key]);
  }
  const options = def["options"];
  if (Array.isArray(options)) for (const option of options) merge(option);
  if (options instanceof Map) for (const option of options.values()) merge(option);
  return found;
}

/**
 * @crewhaus/tool-einvoice — the fixed-format files banks and tax authorities
 * parse byte-exactly.
 *
 * Three tools. Two of them read and write EN 16931 e-invoices in UBL or CII;
 * the third assembles a NACHA or SEPA pain.001 payment batch. What they have
 * in common is that the output is checked by a machine that will not tell you
 * what was wrong with it: an ODFI rejects a 94-byte record whose columns are
 * off with no line number, and a tax authority rejects an invoice whose totals
 * disagree with its rows without saying which total.
 *
 * Three rules hold across the package.
 *
 * NO TOTAL IS AN ARGUMENT. Every sum, count, hash and control figure is
 * computed from the rows. A caller-supplied total that disagrees with the rows
 * is the defect all of this exists to prevent, so there is nowhere to supply
 * one.
 *
 * NOTHING IS TRANSMITTED. These tools hand back bytes. There is no SFTP, no
 * bank API, no submission endpoint, and no schema in this package accepts a
 * credential, a key or a token — a test asserts that over the schemas
 * themselves, the way `tool-onchain` asserts that nothing there accepts a
 * private key. What happens to the file is the operator's decision.
 *
 * NO CLOCK IS READ. Creation timestamps are required inputs. A payment file
 * whose bytes depend on when it was built cannot be diffed against the one you
 * sent, and the sha256 in the result would mean nothing.
 *
 * The rule checking is deliberately narrow and says so in its own result: see
 * the header of `lib/en16931.ts` for exactly which rules are covered and which
 * families are not.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { xmlParse } from "@crewhaus/tool-data";
import { paymentIdentifierValidate } from "@crewhaus/tool-money";
import { z } from "zod";
import { AmountError, formatMinor, minorUnitExponent } from "./lib/amounts";
import { CalendarError } from "./lib/calendar";
import { buildCii, parseCii } from "./lib/cii";
import { type RuleReport, type StatedTotals, checkRules } from "./lib/en16931";
import { type Invoice, InvoiceRecordError, type InvoiceTotals, computeTotals } from "./lib/invoice";
import { LINE_ENDINGS, NACHA_CALENDAR, SEC_CODES, buildNacha } from "./lib/nacha";
import { type Payment, PaymentFileError, validateRows } from "./lib/payments";
import { PAIN_VERSIONS, SEPA_CALENDAR, buildSepa, resolveSettlementDate } from "./lib/sepa";
import { PRESETS, PRESET_IDENTIFIERS, SYNTAXES, type Syntax } from "./lib/syntax";
import { buildUbl, parseUbl } from "./lib/ubl";
import {
  type ParsedElement,
  XmlReadError,
  declaredNamespaces,
  localName,
  serialize,
} from "./lib/xml";
import { ToolPermissionError, resolveSafe } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  lines: 2_000,
  adjustments: 200,
  payments: 25_000,
  documentBytes: 32 * 1024 * 1024,
  /** Beyond this the content is not returned inline; pass `outFile` instead. */
  inlineBytes: 256 * 1024,
} as const;

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * A caller mistake this package states in its own words: the wrong argument
 * combination, a document in a vocabulary this package does not map, a file it
 * will not read.
 *
 * Every refusal in this package THROWS, which is what makes it arrive at the
 * runtime as `isError: true` carrying the reason. Returning the sentence as an
 * ordinary result would tell a harness that branches on that flag that a
 * payment file had been built when none had — and the sentence explaining why
 * not would be sitting where the bytes belong. `tool-containers` takes the
 * same posture for the same reason.
 */
class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/**
 * The refusals this package raises deliberately. Listed so a reader can see
 * that every one of them is a message written FOR the caller; anything else
 * reaching the runtime is a defect here, and its message was written for
 * nobody.
 */
export const REFUSAL_TYPES = [
  AmountError,
  CalendarError,
  InvoiceRecordError,
  PaymentFileError,
  ToolInputError,
  ToolPermissionError,
  XmlReadError,
] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * An integer number of minor units, as a JSON number.
 *
 * `.safe()` and not just `.int()`, because this is the one place in the
 * package where money is a JS number and it is a boundary rather than an
 * arithmetic: everything past here is `bigint`. `Number.isInteger` is true of
 * 2^53 and of 1e300, so without the bound a literal that already lost digits
 * on its way through `JSON.parse` would be accepted, converted to a bigint
 * exactly, and written into a document as the wrong amount with nothing
 * anywhere to notice. Above 2^53-1 minor units there is no way to tell what
 * the caller meant, so it is refused at the edge.
 */
const minorUnits = z.number().int().safe();
const decimalString = z
  .string()
  .regex(/^[+-]?\d+(?:\.\d+)?$/, 'a plain decimal, e.g. "2.5" — exponent notation loses precision');

const vatCategorySchema = z.object({
  categoryCode: z
    .string()
    .min(1)
    .describe("UNCL5305 as EN 16931 restricts it: S, Z, E, AE, K, G, O, L, M"),
  ratePercent: decimalString.describe('the rate as a percentage, so 19% is "19"'),
  exemptionReason: z.string().max(1_000).optional(),
  exemptionReasonCode: z.string().max(64).optional(),
});

const adjustmentSchema = z.object({
  amountMinor: minorUnits.describe(
    "positive; whether it is subtracted or added is the list it is in",
  ),
  reason: z.string().max(1_000).optional(),
  reasonCode: z.string().max(64).optional(),
  baseAmountMinor: minorUnits.optional(),
  percentage: decimalString.optional(),
  vat: vatCategorySchema.optional().describe("required at document level (BR-32 / BR-37)"),
});

const addressSchema = z.object({
  line1: z.string().max(500).optional(),
  line2: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  postalCode: z.string().max(50).optional(),
  countrySubdivision: z.string().max(200).optional(),
  country: z.string().max(10).optional().describe("ISO 3166-1 alpha-2"),
});

const partySchema = z.object({
  name: z.string().min(1).max(500),
  tradingName: z.string().max(500).optional(),
  vatId: z.string().max(64).optional(),
  legalId: z.string().max(64).optional(),
  legalIdScheme: z.string().max(32).optional(),
  address: addressSchema.optional(),
  contactName: z.string().max(200).optional(),
  contactPhone: z.string().max(100).optional(),
  contactEmail: z.string().max(200).optional(),
  electronicAddress: z.string().max(500).optional(),
  electronicAddressScheme: z.string().max(32).optional(),
});

const lineSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  description: z.string().max(4_000).optional(),
  quantity: decimalString,
  unitCode: z.string().min(1).max(10).describe('UN/ECE Recommendation 20; C62 is "one"'),
  unitPriceMinor: minorUnits.describe(
    "per baseQuantity units; a price of 0.0125 is 125 per a base of 100",
  ),
  baseQuantity: decimalString.optional(),
  vat: vatCategorySchema,
  allowances: z.array(adjustmentSchema).max(LIMITS.adjustments).optional(),
  charges: z.array(adjustmentSchema).max(LIMITS.adjustments).optional(),
  note: z.string().max(4_000).optional(),
  sellerItemId: z.string().max(64).optional(),
  buyerAccountingReference: z.string().max(64).optional(),
  periodStart: z.string().max(10).optional(),
  periodEnd: z.string().max(10).optional(),
});

const invoiceSchema = z.object({
  invoiceNumber: z.string().min(1).max(64),
  issueDate: z.string().min(1).max(10).describe("YYYY-MM-DD"),
  typeCode: z
    .string()
    .max(10)
    .optional()
    .describe("UNCL1001; 380 commercial invoice, 381 credit note"),
  currency: z.string().min(3).max(3),
  dueDate: z.string().max(10).optional(),
  paymentTerms: z.string().max(1_000).optional(),
  buyerReference: z.string().max(200).optional(),
  orderReference: z.string().max(200).optional(),
  note: z.string().max(4_000).optional(),
  taxPointDate: z.string().max(10).optional(),
  taxPointDateCode: z.string().max(10).optional(),
  seller: partySchema,
  buyer: partySchema,
  payee: partySchema.optional(),
  paymentMeansCode: z
    .string()
    .max(10)
    .optional()
    .describe("UNCL4461; 30 and 58 are credit transfers"),
  payeeIban: z
    .string()
    .max(64)
    .optional()
    .describe("the account to be paid — an identifier, not a credential"),
  payeeBic: z.string().max(11).optional(),
  paymentReference: z.string().max(200).optional(),
  lines: z.array(lineSchema).min(1).max(LIMITS.lines),
  allowances: z.array(adjustmentSchema).max(LIMITS.adjustments).optional(),
  charges: z.array(adjustmentSchema).max(LIMITS.adjustments).optional(),
  paidAmountMinor: minorUnits
    .optional()
    .describe("BT-113; not derivable from the rows, so it is an input"),
  roundingAmountMinor: minorUnits.optional().describe("BT-114; also an input"),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Totals as strings, so a JSON consumer never sees a float where money was. */
function describeTotals(totals: InvoiceTotals, currency: string): Record<string, unknown> {
  const exp = minorUnitExponent(currency);
  const show = (value: bigint) => formatMinor(value, exp);
  return {
    currency,
    sumOfLineNetAmounts_BT106: show(totals.lineExtensionMinor),
    documentAllowanceTotal_BT107: show(totals.allowanceTotalMinor),
    documentChargeTotal_BT108: show(totals.chargeTotalMinor),
    totalWithoutVat_BT109: show(totals.taxExclusiveMinor),
    totalVat_BT110: show(totals.taxTotalMinor),
    totalWithVat_BT112: show(totals.taxInclusiveMinor),
    paid_BT113: show(totals.paidMinor),
    rounding_BT114: show(totals.roundingMinor),
    dueForPayment_BT115: show(totals.payableMinor),
    vatBreakdown_BG23: totals.vatBreakdown.map((entry) => ({
      categoryCode: entry.categoryCode,
      ratePercent: entry.ratePercent,
      taxableAmount_BT116: show(entry.taxableAmountMinor),
      taxAmount_BT117: show(entry.taxAmountMinor),
      ...(entry.exemptionReason === undefined ? {} : { exemptionReason: entry.exemptionReason }),
    })),
    lines: totals.lines.map((line) => ({
      id: line.id,
      netAmount_BT131: show(line.netAmountMinor),
    })),
  };
}

/** The rule report, with the coverage statement kept next to the findings. */
function describeRules(report: RuleReport): Record<string, unknown> {
  const outcome = (o: RuleReport["failed"][number]) => ({
    id: o.id,
    ...(o.en16931Rule === undefined ? {} : { en16931Rule: o.en16931Rule }),
    rule: o.text,
    detail: o.detail,
  });
  return {
    standard: report.standard,
    verdict: report.verdict,
    checksRun: report.checksRun,
    passed: report.passed,
    notApplicable: report.notApplicable,
    failures: report.failed.map(outcome),
    // Separate from `failures`, and present even when empty, so a consumer
    // cannot read "no failures" as "every rule was evaluated". A check that
    // raised says nothing about the document either way.
    notEvaluated: report.notEvaluated.map(outcome),
    checkedIds: report.checkedIds,
    notChecked: report.notChecked,
  };
}

/** Write to a contained path, refusing to clobber unless told to. */
function writeContained(toolName: string, rel: string, text: string, overwrite: boolean): string {
  const at = resolveSafe(toolName, rel);
  if (!overwrite) {
    try {
      statSync(at.real);
      throw new PaymentFileError(`"${rel}" already exists; pass overwrite to replace it`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  // The parent is created because the destination was already proved to be
  // inside the workspace — `resolveSafe` allows a missing leaf precisely so a
  // tool can validate a destination before making it.
  mkdirSync(dirname(at.real), { recursive: true });
  writeFileSync(at.real, text, "utf8");
  return at.rel;
}

/**
 * The payload a builder returns: the bytes, or where they were put.
 *
 * Over `inlineBytes` the content is NOT returned and the caller is told to
 * pass `outFile`. Quietly truncating a payment file into a result would put a
 * partial file where a complete one belongs, and a partial NACHA file is a
 * valid-looking prefix.
 */
function deliver(
  toolName: string,
  text: string,
  outFile: string | undefined,
  overwrite: boolean,
): Record<string, unknown> {
  const bytes = Buffer.byteLength(text, "utf8");
  const digest = sha256(text);
  if (outFile !== undefined) {
    return { file: writeContained(toolName, outFile, text, overwrite), bytes, sha256: digest };
  }
  if (bytes > LIMITS.inlineBytes) {
    throw new PaymentFileError(
      `the file is ${bytes} bytes, over the ${LIMITS.inlineBytes}-byte inline limit — pass outFile to write it. It is not truncated into the result: a partial fixed-width file is a valid-looking prefix.`,
    );
  }
  return { content: text, bytes, sha256: digest };
}

/**
 * Check an identifier through `@crewhaus/tool-money`, which owns this
 * arithmetic.
 *
 * Reaching it through its registered tool rather than importing the function
 * is not elegance — `tool-money` exports its tools and not its library, and a
 * second IBAN implementation in this repository would disagree with the first
 * about some country's length. Disagreeing about that is worse than the call.
 */
async function identifierProblem(
  value: string,
  kind: "iban" | "bic" | "aba",
  label: string,
): Promise<string | null> {
  const raw = await paymentIdentifierValidate.execute({ value, kind }, undefined);
  let parsed: { valid?: boolean; reason?: string };
  try {
    parsed = JSON.parse(String(raw)) as { valid?: boolean; reason?: string };
  } catch {
    return `${label}: ${String(raw)}`;
  }
  if (parsed.valid === true) return null;
  return `${label} ("${value}") failed its ${kind.toUpperCase()} checksum: ${parsed.reason ?? "no reason given"}`;
}

// ---------------------------------------------------------------------------
// EInvoiceBuild
// ---------------------------------------------------------------------------

export const eInvoiceBuild: RegisteredTool = buildTool({
  name: "EInvoiceBuild",
  description:
    'Write an EN 16931 e-invoice as UBL or CII (the syntaxes Peppol BIS 3, XRechnung, Factur-X and ZUGFeRD use) from an invoice record, and report which of the standard\'s rules were checked. Use it instead of a model composing the XML: every total, the VAT breakdown and every line net amount are computed from the rows, so there is no way to state a total that disagrees with them. The rule check is NARROW and names the rule identifiers it covers and the families it does not — it is not a Schematron run, and it never reports "valid". The bytes come back or go to a path you name; nothing is submitted anywhere.',
  inputSchema: z.object({
    syntax: z.enum(SYNTAXES).describe("ubl (Peppol, XRechnung UBL) or cii (Factur-X, ZUGFeRD)"),
    invoice: invoiceSchema,
    preset: z
      .enum(PRESETS)
      .optional()
      .describe(
        "which specification identifier to declare; en16931 by default. Sets identifiers only — the preset's own rules are NOT checked.",
      ),
    customizationId: z.string().max(500).optional().describe("overrides the preset's BT-24"),
    profileId: z.string().max(500).optional().describe("overrides the preset's BT-23"),
    outFile: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe("workspace-relative path to write to"),
    overwrite: z.boolean().optional(),
  }),
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    // The type code is defaulted HERE rather than inside the two mappings,
    // so the rules are checked against exactly the document that gets
    // written. Defaulting it further down made BR-04 fail on an invoice
    // whose emitted XML carried a perfectly good 380.
    const raw = input.invoice as unknown as Invoice;
    const invoice: Invoice = { ...raw, typeCode: raw.typeCode ?? "380" };
    const totals = computeTotals(invoice);
    const preset = PRESET_IDENTIFIERS[input.preset ?? "en16931"];
    const customizationId = input.customizationId ?? preset.customizationId;
    const profileId = input.profileId ?? preset.profileId;
    const exponent = minorUnitExponent(invoice.currency);
    const syntax = input.syntax as Syntax;
    const tree =
      syntax === "ubl"
        ? buildUbl(invoice, totals, { customizationId, profileId, exponent })
        : buildCii(invoice, totals, { customizationId, exponent });
    const text = serialize(tree);

    // The totals in the document ARE the computed ones, so the calculation
    // rules hold by construction. They are still run: the same table runs on
    // the way in, and a coverage claim that changed direction would not be
    // one.
    const stated: StatedTotals = {
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
      // Both empty by construction on the way out: these totals were computed
      // from the rows rather than read off a document, so there is nothing to
      // have been over-precise or unreadable. Stated explicitly so the same
      // rule table runs against the same shape in both directions.
      overPreciseAmounts: [],
      unreadableAmounts: [],
    };
    const report = checkRules({
      invoice,
      totals,
      stated,
      customizationId,
      currencyExponent: exponent,
    });

    return json({
      syntax,
      customizationId,
      ...(profileId === undefined ? {} : { profileId }),
      ...deliver("EInvoiceBuild", text, input.outFile, input.overwrite === true),
      totals: describeTotals(totals, invoice.currency),
      ruleCheck: describeRules(report),
      notes: [
        "every total and the whole VAT breakdown were computed from the lines; none of them is an input, so the calculation rules hold by construction",
        "no XSD was run: element order follows the published schema sequence as implemented here, and a schema validator at the recipient is still the authority",
        input.preset !== undefined && input.preset !== "en16931"
          ? `the ${input.preset} preset set the specification identifiers; its own rule set was NOT checked`
          : undefined,
        "nothing was submitted, filed or transmitted — this returned bytes",
      ].filter((note): note is string => note !== undefined),
    });
  },
});

// ---------------------------------------------------------------------------
// EInvoiceParse
// ---------------------------------------------------------------------------

const PDF_MAGIC = "%PDF-";

export const eInvoiceParse: RegisteredTool = buildTool({
  name: "EInvoiceParse",
  description:
    'Read a UBL or CII e-invoice — Peppol BIS 3, XRechnung, Factur-X or ZUGFeRD XML — into one normalized record, and say where the document\'s own totals disagree with its rows. Use it to check an incoming invoice before it reaches a ledger: the stated total is what a system pays and the lines are what an auditor reads, and this is where a difference between them shows up. A document that fails a rule still comes back parsed, with findings; only markup that cannot be read at all is an error. The rule check is the same narrow, named set the build side runs and it never reports "valid".',
  inputSchema: z.object({
    file: z.string().min(1).max(4_096).optional().describe("workspace-relative path to the XML"),
    xml: z.string().max(LIMITS.documentBytes).optional().describe("the document itself"),
    includeDocument: z.boolean().optional().describe("include the parsed record; true by default"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if ((input.file === undefined) === (input.xml === undefined)) {
      throw new ToolInputError(
        "pass exactly one of file or xml — with both, there would be no way to tell which one the result describes",
      );
    }
    let text: string;
    let source: string;
    if (input.file !== undefined) {
      const at = resolveSafe("EInvoiceParse", input.file);
      const size = statSync(at.real).size;
      if (size > LIMITS.documentBytes) {
        throw new ToolInputError(
          `${at.rel} is ${size} bytes, over the ${LIMITS.documentBytes}-byte limit for this tool`,
        );
      }
      text = readFileSync(at.real, "utf8");
      source = at.rel;
    } else {
      text = input.xml as string;
      source = "(inline)";
    }

    if (text.startsWith(PDF_MAGIC)) {
      throw new ToolInputError(
        `${source} is a PDF. A Factur-X or ZUGFeRD PDF carries the invoice XML as an embedded file, and pulling it out means walking the /Names /EmbeddedFiles tree — including its /Kids and object streams — which this package does not do. Extract the attachment and pass the XML.`,
      );
    }

    const parsedRaw = await xmlParse.execute(
      { text, mode: "xml", shape: "tree", trimWhitespace: true, maxDepth: 64 },
      undefined,
    );
    let nodes: unknown;
    try {
      nodes = JSON.parse(String(parsedRaw));
    } catch {
      // XmlParse hands back a sentence rather than JSON when the markup is
      // not well formed. That sentence carries the line number, so it is
      // the answer, not something to wrap.
      throw new ToolInputError(`${source} could not be read: ${String(parsedRaw)}`);
    }
    const root = (nodes as ParsedElement[]).find(
      (node) => typeof node === "object" && node !== null && "name" in node,
    );
    if (root === undefined) {
      throw new ToolInputError(`${source} contains no XML element`);
    }

    const rootName = localName(root.name);
    const namespaces = declaredNamespaces(root).join(" ");
    let document: ReturnType<typeof parseUbl>;
    if (rootName === "Invoice" && namespaces.includes("ubl:schema:xsd:Invoice")) {
      document = parseUbl(root);
    } else if (rootName === "CrossIndustryInvoice") {
      document = parseCii(root);
    } else if (rootName === "FatturaElettronica") {
      throw new ToolInputError(
        `${source} is an Italian FatturaPA document. It is a different semantic model from EN 16931, not a syntax of it, and this package does not map it — mapping it badly would produce a record whose totals look right and whose tax does not.`,
      );
    } else if (rootName === "CreditNote") {
      throw new ToolInputError(
        `${source} is a UBL CreditNote. Only the UBL Invoice and the CII CrossIndustryInvoice are mapped here; a credit note is expressed as an Invoice with type code 381 in the documents this package builds.`,
      );
    } else {
      throw new ToolInputError(
        `${source} has a root element <${root.name}> this package does not recognize as a UBL Invoice or a CII CrossIndustryInvoice`,
      );
    }

    const totals = computeTotals(document.invoice);
    const report = checkRules({
      invoice: document.invoice,
      totals,
      stated: document.stated,
      customizationId: document.customizationId,
      currencyExponent: document.currencyExponent,
    });

    const exp = document.currencyExponent;
    const differences: Array<Record<string, string>> = [];
    /**
     * Totals the document states that could not be read, so they were never
     * compared with anything.
     *
     * This is the third outcome and it has to reach the caller, because
     * `agrees` is the field a harness branches on: an exporter that writes
     * "1.100,00" where 110.00 is due produces a document whose stated total
     * is ten times its rows, and reporting that as agreement — on the
     * grounds that the unreadable figure was dropped earlier and there was
     * therefore nothing to disagree with — is the worst answer available.
     */
    const couldNotCompare: Array<Record<string, string>> = [];
    const unreadable = document.stated.unreadableAmounts ?? [];
    const compare = (label: string, statedValue: bigint | undefined, computed: bigint): void => {
      if (statedValue === undefined) {
        const term = label.split(" ")[0] as string;
        const entry = unreadable.find((e) => e.startsWith(`${term}=`));
        if (entry !== undefined) {
          couldNotCompare.push({
            field: label,
            statedInDocument: entry.slice(term.length + 1),
            computedFromRows: formatMinor(computed, exp),
            why: "present in the document and not a decimal, so it was not compared — this is not agreement",
          });
        }
        return;
      }
      if (statedValue === computed) return;
      differences.push({
        field: label,
        statedInDocument: formatMinor(statedValue, exp),
        computedFromRows: formatMinor(computed, exp),
        difference: formatMinor(statedValue - computed, exp),
      });
    };
    compare(
      "BT-106 sum of line net amounts",
      document.stated.lineExtensionMinor,
      totals.lineExtensionMinor,
    );
    compare(
      "BT-107 document allowance total",
      document.stated.allowanceTotalMinor,
      totals.allowanceTotalMinor,
    );
    compare(
      "BT-108 document charge total",
      document.stated.chargeTotalMinor,
      totals.chargeTotalMinor,
    );
    compare(
      "BT-109 total without VAT",
      document.stated.taxExclusiveMinor,
      totals.taxExclusiveMinor,
    );
    compare("BT-110 total VAT", document.stated.taxTotalMinor, totals.taxTotalMinor);
    compare("BT-112 total with VAT", document.stated.taxInclusiveMinor, totals.taxInclusiveMinor);
    compare("BT-115 due for payment", document.stated.payableMinor, totals.payableMinor);

    return json({
      source,
      syntax: document.syntax,
      ...(document.customizationId === undefined
        ? {}
        : { customizationId: document.customizationId }),
      ...(document.profileId === undefined ? {} : { profileId: document.profileId }),
      lineCount: document.invoice.lines.length,
      reconciliation: {
        // A total that could not be read is not a total that agreed. `agrees`
        // is false whenever anything went uncompared, and `couldNotCompare`
        // says which.
        agrees: differences.length === 0 && couldNotCompare.length === 0,
        differences,
        couldNotCompare,
        note: "the document's own totals against the totals its rows come to; the stated one is what a system pays and the rows are what an auditor reads. agrees is true only when every stated total was READ and matched — see couldNotCompare for any that could not be read at all",
      },
      computedTotals: describeTotals(totals, document.invoice.currency),
      ruleCheck: describeRules(report),
      ...(input.includeDocument === false ? {} : { invoice: document.invoice }),
      notes: [
        "a document that fails a rule is still returned, parsed, with findings — only unreadable markup is an error",
        "no XSD was run and no Schematron was run; see ruleCheck.notChecked",
      ],
    });
  },
});

// ---------------------------------------------------------------------------
// PaymentFileBuild
// ---------------------------------------------------------------------------

export const PAYMENT_FORMATS = ["nacha", "sepa-pain001"] as const;

const paymentSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(140)
    .describe("the end-to-end reference; unique across the file, and a duplicate is refused"),
  amountMinor: minorUnits.describe(
    "positive minor units — cents; direction is a field, not a sign",
  ),
  name: z.string().min(1).max(500).describe("the counterparty's name"),
  iban: z
    .string()
    .max(64)
    .optional()
    .describe("SEPA: the creditor account. An identifier, not a credential."),
  bic: z.string().max(11).optional(),
  routingNumber: z
    .string()
    .max(20)
    .optional()
    .describe("NACHA: the receiving DFI's 9-digit ABA number"),
  accountNumber: z.string().max(40).optional().describe("NACHA: the receiving account number"),
  accountType: z.enum(["checking", "savings"]).optional(),
  direction: z.enum(["credit", "debit"]).optional().describe("credit by default"),
  remittance: z
    .string()
    .max(4_000)
    .optional()
    .describe("SEPA: unstructured remittance, 140 characters"),
  addenda: z.string().max(4_000).optional().describe("NACHA: an 05 addenda record, 80 characters"),
});

export const paymentFileBuild: RegisteredTool = buildTool({
  name: "PaymentFileBuild",
  description:
    "Assemble a bank-ready NACHA ACH batch or a SEPA pain.001 credit transfer from approved payment rows, with every control figure computed from the rows. Use it because this is arithmetic a model cannot be allowed to approximate: NACHA is 94-byte fixed-width records whose entry hash, debit and credit totals, entry count and block padding must agree exactly or the ODFI rejects the whole file with no line number, and pain.001's NbOfTxs and CtrlSum are no more forgiving. Duplicate references are refused before anything is written, names are truncated to the field and reported while references and amounts are refused rather than shortened, and a settlement date the calendar does not settle on is refused unless you ask for it to be moved. IT BUILDS THE FILE AND DOES NOT SEND IT: there is no transport here and no schema accepts a credential.",
  inputSchema: z.object({
    format: z.enum(PAYMENT_FORMATS),
    payments: z.array(paymentSchema).min(1).max(LIMITS.payments),
    adjustSettlementDate: z
      .boolean()
      .optional()
      .describe(
        "move a closed-day settlement date to the next open one and report both; refuses by default",
      ),
    outFile: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe("workspace-relative path to write to"),
    overwrite: z.boolean().optional(),
    nacha: z
      .object({
        immediateDestination: z.string().min(1).max(10),
        immediateOrigin: z.string().min(1).max(10),
        destinationName: z.string().min(1).max(100),
        originName: z.string().min(1).max(100),
        companyName: z.string().min(1).max(100),
        companyId: z.string().min(1).max(10).describe("usually 1 followed by a nine-digit EIN"),
        companyEntryDescription: z
          .string()
          .min(1)
          .max(10)
          .describe("what the receiver sees, e.g. PAYROLL"),
        companyDescriptiveDate: z.string().max(6).optional(),
        standardEntryClass: z.enum(SEC_CODES),
        odfiRouting: z.string().min(9).max(9),
        creationDate: z
          .string()
          .min(10)
          .max(10)
          .describe("YYYY-MM-DD; required, because nothing here reads a clock"),
        creationTime: z.string().min(4).max(5).describe("HH:MM, 24-hour; also required"),
        effectiveEntryDate: z.string().min(10).max(10),
        fileIdModifier: z.string().min(1).max(1).optional(),
        batchNumber: z.number().int().positive().max(9_999_999).optional(),
        traceStart: z.number().int().positive().max(9_999_999).optional(),
        lineEnding: z
          .enum(LINE_ENDINGS)
          .optional()
          .describe("lf by default; none writes a pure 94-byte blocked file"),
        discretionaryData: z.string().max(20).optional(),
      })
      .optional(),
    sepa: z
      .object({
        messageId: z.string().min(1).max(140),
        creationDateTime: z
          .string()
          .min(1)
          .max(64)
          .describe("ISO-8601 WITH an offset; required, because nothing here reads a clock"),
        paymentInformationId: z.string().min(1).max(140),
        requestedExecutionDate: z.string().min(10).max(10).describe("YYYY-MM-DD"),
        debtorName: z.string().min(1).max(500),
        debtorIban: z
          .string()
          .min(1)
          .max(64)
          .describe("the account to be debited. An identifier, not a credential."),
        debtorBic: z.string().max(11).optional(),
        initiatingPartyName: z.string().max(500).optional(),
        batchBooking: z.boolean().optional(),
        version: z.enum(PAIN_VERSIONS).optional().describe("pain.001.001.03 by default"),
      })
      .optional(),
  }),
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    const payments = input.payments as unknown as ReadonlyArray<Payment>;
    validateRows(payments);

    if (input.format === "nacha") {
      const options = input.nacha;
      if (options === undefined) {
        throw new ToolInputError(
          "format is nacha but no nacha block was given; the file header, the batch header and the trace numbers all need values only you have",
        );
      }
      if (input.sepa !== undefined) {
        throw new ToolInputError(
          "both a nacha and a sepa block were given; pass the one that matches the format so there is no question which settings the file was built from",
        );
      }
      const problems: string[] = [];
      const odfi = await identifierProblem(options.odfiRouting, "aba", "odfiRouting");
      if (odfi !== null) problems.push(odfi);
      // One check per DISTINCT routing number: a payroll file repeats a
      // handful of banks across thousands of rows.
      const seen = new Map<string, number[]>();
      for (const [index, payment] of payments.entries()) {
        if (payment.routingNumber === undefined) continue;
        const rows = seen.get(payment.routingNumber) ?? [];
        rows.push(index);
        seen.set(payment.routingNumber, rows);
      }
      for (const [routing, rows] of seen) {
        const problem = await identifierProblem(
          routing,
          "aba",
          `routingNumber on row(s) ${rows.join(", ")}`,
        );
        if (problem !== null) problems.push(problem);
      }
      if (problems.length > 0) {
        throw new ToolInputError(`refusing to build the file:\n- ${problems.join("\n- ")}`);
      }
      const settlement = resolveSettlementDate(
        NACHA_CALENDAR,
        options.effectiveEntryDate,
        "effectiveEntryDate",
        input.adjustSettlementDate === true,
      );
      const result = buildNacha(payments, {
        ...options,
        effectiveEntryDate: settlement.date,
      });
      return json({
        format: "nacha",
        standardEntryClass: options.standardEntryClass,
        serviceClassCode: result.serviceClassCode,
        serviceClassNote:
          "derived from the entries: 220 all credits, 225 all debits, 200 mixed — not taken as an argument",
        ...deliver("PaymentFileBuild", result.text, input.outFile, input.overwrite === true),
        recordCount: result.recordCount,
        paddingRecords: result.paddingRecords,
        blockCount: result.blockCount,
        entryAddendaCount: result.entryAddendaCount,
        entryHash: result.entryHash,
        totalCreditCents: result.totalCreditMinor,
        totalDebitCents: result.totalDebitMinor,
        firstTraceNumber: result.traceNumbers[0],
        lastTraceNumber: result.traceNumbers[result.traceNumbers.length - 1],
        effectiveEntryDate: settlement.date,
        ...(settlement.movedFrom === undefined
          ? {}
          : {
              settlementDateMoved: {
                from: settlement.movedFrom,
                to: settlement.date,
                because: settlement.reason,
              },
            }),
        truncations: result.truncations,
        notes: [
          "every record measured 94 characters before it was kept; the hash, the counts and the totals were computed from the entries",
          "the US Federal Reserve calendar was used for the settlement-day check; it does not know about your ODFI's own cut-off times",
          "THE FILE WAS BUILT, NOT SENT. There is no transport in this package.",
        ],
      });
    }

    const options = input.sepa;
    if (options === undefined) {
      throw new ToolInputError(
        "format is sepa-pain001 but no sepa block was given; the message identifier, the debtor and the execution date all need values only you have",
      );
    }
    if (input.nacha !== undefined) {
      throw new ToolInputError(
        "both a nacha and a sepa block were given; pass the one that matches the format so there is no question which settings the file was built from",
      );
    }
    const problems: string[] = [];
    const debtor = await identifierProblem(options.debtorIban, "iban", "debtorIban");
    if (debtor !== null) problems.push(debtor);
    if (options.debtorBic !== undefined) {
      const bic = await identifierProblem(options.debtorBic, "bic", "debtorBic");
      if (bic !== null) problems.push(bic);
    }
    for (const [index, payment] of payments.entries()) {
      if (payment.iban !== undefined) {
        const problem = await identifierProblem(
          payment.iban,
          "iban",
          `iban on payment ${index} ("${payment.id}")`,
        );
        if (problem !== null) problems.push(problem);
      }
      if (payment.bic !== undefined) {
        const problem = await identifierProblem(
          payment.bic,
          "bic",
          `bic on payment ${index} ("${payment.id}")`,
        );
        if (problem !== null) problems.push(problem);
      }
    }
    if (problems.length > 0) {
      throw new ToolInputError(`refusing to build the file:\n- ${problems.join("\n- ")}`);
    }
    const settlement = resolveSettlementDate(
      SEPA_CALENDAR,
      options.requestedExecutionDate,
      "requestedExecutionDate",
      input.adjustSettlementDate === true,
    );
    const result = buildSepa(payments, {
      ...options,
      requestedExecutionDate: settlement.date,
    });
    return json({
      format: "sepa-pain001",
      version: result.version,
      ...deliver("PaymentFileBuild", result.text, input.outFile, input.overwrite === true),
      transactionCount: result.transactionCount,
      controlSum: result.controlSum,
      currency: "EUR",
      requestedExecutionDate: result.requestedExecutionDate,
      ...(settlement.movedFrom === undefined
        ? {}
        : {
            settlementDateMoved: {
              from: settlement.movedFrom,
              to: settlement.date,
              because: settlement.reason,
            },
          }),
      truncations: result.truncations,
      transliterations: result.transliterations,
      notes: [
        "NbOfTxs and CtrlSum were computed from the rows, at both the group and the payment-information level",
        "names outside the SEPA character set were transliterated and every substitution is listed above; a character with no defined transliteration is a refusal, not a guess",
        "the TARGET2 calendar was used for the settlement-day check; it does not include national bank holidays",
        "no XSD was run against the message",
        "THE FILE WAS BUILT, NOT SENT. There is no transport in this package.",
      ],
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const EINVOICE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  eInvoiceBuild,
  eInvoiceParse,
  paymentFileBuild,
]);

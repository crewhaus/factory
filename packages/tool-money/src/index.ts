/**
 * @crewhaus/tool-money — money arithmetic and the controls around it.
 *
 * Everything here has a right answer that a model can get wrong in a way
 * nobody notices: a cent lost allocating a discount, a tax charged on the
 * wrong base, a date read month-first, a refund that returns list price for
 * a discounted item. These are the calculations that end up in documents
 * somebody audits.
 *
 * Money is integer minor units throughout — cents, pence — because floating
 * point produces totals that do not add up. Timestamps must carry a UTC
 * offset; an offset-less one is refused rather than read as local time.
 *
 * Nothing here moves money, reaches a payment provider, or decides that
 * somebody is committing fraud. It computes, checks and reports.
 */
import { readFileSync, statSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { ASSERT_OPS } from "@crewhaus/tool-schema";
import { z } from "zod";
import {
  type OrderLine,
  type ReturnedLine,
  SHIPPING_POLICIES,
  computeRefund,
} from "./lib/allocate";
import { type CodingRule, codeLines } from "./lib/coding";
import { type Spend, checkSpendLimit, refundAbuseSignals } from "./lib/controls";
import {
  IDENTIFIER_KINDS,
  type IdentifierKind,
  detectKind,
  validateIdentifier,
} from "./lib/identifiers";
import { LOT_METHODS, computeCostBasis } from "./lib/lots";
import { type MatchLine, matchInvoiceToPurchaseOrder } from "./lib/match";
import { DATE_ORDERS, STATEMENT_FORMATS, parseStatement } from "./lib/statement";
import { ROUNDING_MODES, ROUNDING_SCOPES, calculateTax } from "./lib/tax";
import { verifyWebhookSignature } from "./lib/webhook";
import { resolveSafe } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  lines: 5_000,
  rules: 1_000,
  lots: 10_000,
  history: 20_000,
  statementBytes: 64 * 1024 * 1024,
  checks: 64,
} as const;

const checkSchema = z.object({
  path: z.string().optional().describe("dotted path into the line, e.g. 'vendor.name'"),
  op: z.enum(ASSERT_OPS),
  expected: z.unknown().describe("the operand; its meaning depends on the op"),
  flags: z.string().optional(),
  message: z.string().optional(),
});

const minorUnits = z.number().int();

/**
 * An instant, as epoch milliseconds or ISO-8601 WITH an offset.
 *
 * Offset-less strings are rejected: per ECMAScript they mean local time, so
 * the same statement would land in different months on two machines.
 */
function parseInstant(value: string | number, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${field} is not a finite epoch-millisecond value`);
    return value;
  }
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new Error(
      `${field} ("${text}") has no UTC offset — write it as e.g. 2026-01-01T00:00:00Z, because an offset-less string means local time and would differ between machines`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`${field} ("${text}") is not a valid ISO-8601 instant`);
  return parsed;
}

const instantField = z.union([z.string(), z.number()]);

// ---------------------------------------------------------------------------

export const paymentIdentifierValidate: RegisteredTool = buildTool({
  name: "PaymentIdentifierValidate",
  description:
    "Check an IBAN, BIC, ABA routing number, card number or UK sort code against its published checksum, and return the canonical form. Use it before composing a payout or an invoice: these identifiers carry check digits precisely so a transposed pair of digits is caught before money moves, and the arithmetic has one right answer. A card number is echoed only as its last four. A valid checksum means well-formed, not that the account exists — nothing here reaches a network, and the result says so.",
  inputSchema: z.object({
    value: z.string().min(1).describe("the identifier, spacing and case as written"),
    kind: z
      .enum(IDENTIFIER_KINDS)
      .optional()
      .describe("iban | bic | aba | card | sortcode; detected from the shape when omitted"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const kind = (input.kind ?? detectKind(input.value)) as IdentifierKind | null;
    if (kind === null) {
      return `"${input.value.slice(0, 12)}…" does not have the shape of an IBAN, BIC, routing number, card number or sort code — pass kind explicitly if you know what it should be`;
    }
    return json({
      ...validateIdentifier(input.value, kind),
      checkedAgainst: "checksum only; no account was looked up",
    });
  },
});

export const taxCalculate: RegisteredTool = buildTool({
  name: "TaxCalculate",
  description:
    "Compute VAT, GST or sales tax per line and per invoice from the operator's own rate tables, in integer minor units. Use it instead of a model multiplying percentages: it handles tax-inclusive pricing, compound rates, exemptions and reverse charge, and it makes the two choices that have no safe default explicit — whether listed prices already include tax, and whether rounding happens per line or once per invoice. A tax code missing from the rate table is an error rather than an untaxed line.",
  inputSchema: z.object({
    lines: z
      .array(
        z.object({
          id: z.string().min(1),
          amountMinor: minorUnits.describe("net of tax unless pricesIncludeTax is set"),
          taxCodes: z.array(z.string()).max(8),
          exempt: z
            .boolean()
            .optional()
            .describe("outside the scope of tax, which is not a zero rate"),
        }),
      )
      .min(1)
      .max(LIMITS.lines),
    rates: z
      .array(
        z.object({
          code: z.string().min(1),
          bps: z.number().int().describe("basis points: 2000 is 20%"),
          name: z.string().optional(),
          compound: z
            .boolean()
            .optional()
            .describe("charged on the net plus taxes already applied"),
        }),
      )
      .min(1)
      .max(200),
    pricesIncludeTax: z.boolean().optional(),
    rounding: z.enum(ROUNDING_MODES).optional().describe("default half-up"),
    scope: z
      .enum(ROUNDING_SCOPES)
      .optional()
      .describe("round per line (default) or once per invoice"),
    reverseCharge: z.boolean().optional().describe("the customer accounts for the tax"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => json(calculateTax(input.lines, input.rates, input)),
});

export const refundAmountCompute: RegisteredTool = buildTool({
  name: "RefundAmountCompute",
  description:
    "Work out what to refund for a partial return: the returned units at what was actually paid for them, with the order-level discount and the tax allocated proportionally, plus whatever the shipping policy says. Use it because refunding list price for a discounted item refunds more than was taken, and because splitting an amount by rounding each share loses cents. Allocation is largest-remainder, so a full return refunds exactly what was charged.",
  inputSchema: z.object({
    lines: z
      .array(
        z.object({
          id: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPriceMinor: minorUnits,
          taxMinor: minorUnits.optional(),
          discountMinor: minorUnits.optional(),
        }),
      )
      .min(1)
      .max(LIMITS.lines),
    returned: z
      .array(z.object({ lineId: z.string().min(1), quantity: z.number().int().positive() }))
      .min(1)
      .max(LIMITS.lines),
    orderDiscountMinor: minorUnits.optional(),
    shippingMinor: minorUnits.optional(),
    shippingPolicy: z
      .enum(SHIPPING_POLICIES)
      .optional()
      .describe("none (default), proportional, or full"),
    restockingFeeMinor: minorUnits.optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json(
      computeRefund(
        input.lines as ReadonlyArray<OrderLine>,
        input.returned as ReadonlyArray<ReturnedLine>,
        input,
      ),
    ),
});

export const purchaseOrderMatch: RegisteredTool = buildTool({
  name: "PurchaseOrderMatch",
  description:
    "Run the accounts-payable three-way match: invoice lines against purchase-order lines against goods received, with price and quantity tolerances, reporting every exception and what it would cost to pay it. Use it before approving a bill. Lines pair by explicit reference, then SKU, then normalized description, and each pair records which was used so a reviewer can see when a match rested on fuzzy text. Billing for more than arrived is invisible in a two-way match however well the invoice agrees with the order.",
  inputSchema: z.object({
    invoiceLines: z
      .array(
        z.object({
          id: z.string().min(1),
          poLineId: z.string().optional(),
          sku: z.string().optional(),
          description: z.string().optional(),
          quantity: z.number(),
          unitPriceMinor: minorUnits,
        }),
      )
      .min(1)
      .max(LIMITS.lines),
    poLines: z
      .array(
        z.object({
          id: z.string().min(1),
          sku: z.string().optional(),
          description: z.string().optional(),
          quantity: z.number(),
          unitPriceMinor: minorUnits,
        }),
      )
      .min(1)
      .max(LIMITS.lines),
    receiptLines: z
      .array(z.object({ poLineId: z.string().min(1), quantity: z.number() }))
      .max(LIMITS.lines)
      .optional()
      .describe("omit for a two-way match"),
    tolerance: z
      .object({
        pricePercentBps: z.number().int().nonnegative().optional(),
        priceAbsoluteMinor: minorUnits.nonnegative().optional(),
        quantityPercentBps: z.number().int().nonnegative().optional(),
        quantityAbsolute: z.number().nonnegative().optional(),
      })
      .optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json(
      matchInvoiceToPurchaseOrder(
        input.invoiceLines as ReadonlyArray<MatchLine>,
        input.poLines as ReadonlyArray<MatchLine>,
        input.receiptLines ?? [],
        input.tolerance ?? {},
      ),
    ),
});

export const costBasisCompute: RegisteredTool = buildTool({
  name: "CostBasisCompute",
  description:
    "Consume lots against disposals by FIFO, LIFO, HIFO or specific identification, and report realized gain split into short and long term with the lots each disposal consumed. Use it for crypto or securities bookkeeping: once the method is chosen the arithmetic is fixed, and a figure a model produced cannot be reproduced next quarter, which is the one property a cost-basis number must have. A lot's costs always sum to exactly what it cost, however many partial disposals came before.",
  inputSchema: z.object({
    lots: z
      .array(
        z.object({
          id: z.string().min(1),
          acquiredAt: z.string().describe("ISO-8601 with a UTC offset"),
          quantity: z.number().positive(),
          costMinor: minorUnits,
        }),
      )
      .min(1)
      .max(LIMITS.lots),
    disposals: z
      .array(
        z.object({
          id: z.string().min(1),
          disposedAt: z.string(),
          quantity: z.number().positive(),
          proceedsMinor: minorUnits,
          lotIds: z.array(z.string()).max(LIMITS.lots).optional().describe("specific method only"),
        }),
      )
      .max(LIMITS.lots),
    method: z.enum(LOT_METHODS),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => json(computeCostBasis(input.lots, input.disposals, input.method)),
});

export const spendLimitCheck: RegisteredTool = buildTool({
  name: "SpendLimitCheck",
  description:
    "Decide whether a proposed payment fits inside the operator's velocity, counterparty and quiet-hours limits, given what has already been spent. Use it as the gate an unattended harness actually consults before moving money: a limit a model is asked to respect is a suggestion, while one computed from the record of prior spend is a limit. It reports every limit the payment breaks rather than the first, and the headroom that would pass.",
  inputSchema: z.object({
    proposed: z.object({ amountMinor: minorUnits, counterparty: z.string().optional() }),
    history: z
      .array(
        z.object({
          id: z.string().min(1),
          at: z.string().describe("ISO-8601 with a UTC offset"),
          amountMinor: minorUnits,
          counterparty: z.string().optional(),
        }),
      )
      .max(LIMITS.history),
    limits: z.object({
      perTransactionMinor: minorUnits.optional(),
      perHourMinor: minorUnits.optional(),
      perDayMinor: minorUnits.optional(),
      perWeekMinor: minorUnits.optional(),
      perCounterpartyPerDayMinor: minorUnits.optional(),
      maxTransactionsPerHour: z.number().int().positive().optional(),
      quietHoursUtc: z.array(z.number().int().min(0).max(23)).max(24).optional(),
      knownCounterpartiesOnly: z.boolean().optional(),
      knownCounterparties: z.array(z.string()).max(10_000).optional(),
    }),
    now: instantField.optional().describe("overrides the real clock, for tests and replays"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const nowMs = input.now === undefined ? Date.now() : parseInstant(input.now, "now");
    return json(
      checkSpendLimit(input.proposed, input.history as ReadonlyArray<Spend>, input.limits, nowMs),
    );
  },
});

export const refundAbuseCheck: RegisteredTool = buildTool({
  name: "RefundAbuseCheck",
  description:
    "Report refund counts, refunded-to-spent ratios over 30, 90 and 365 days, replacement counts and non-delivery claims for one customer. Use it to decide which refund requests a person should look at. It reports signals and never a verdict: a high ratio is also what a customer with one genuinely broken delivery looks like, and a ratio against zero spend is reported as absent rather than as a large number.",
  inputSchema: z.object({
    refunds: z
      .array(
        z.object({
          id: z.string().min(1),
          at: z.string(),
          amountMinor: minorUnits,
          reason: z.string().optional(),
          replacement: z.boolean().optional(),
        }),
      )
      .max(LIMITS.history),
    orders: z
      .array(z.object({ id: z.string().min(1), at: z.string(), amountMinor: minorUnits }))
      .max(LIMITS.history),
    thresholds: z
      .object({
        ratioBps: z.number().int().nonnegative().optional(),
        refundCount: z.number().int().nonnegative().optional(),
      })
      .optional(),
    now: instantField.optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const nowMs = input.now === undefined ? Date.now() : parseInstant(input.now, "now");
    return json({
      ...refundAbuseSignals(input.refunds, input.orders, nowMs, input.thresholds ?? {}),
      note: "these are signals, not a finding; a person decides",
    });
  },
});

export const webhookSignatureVerify: RegisteredTool = buildTool({
  name: "WebhookSignatureVerify",
  description:
    "Verify a payment webhook's HMAC-SHA256 signature over its raw body, in the scheme Stripe uses and several providers copy, and check the timestamp against a replay tolerance. Use it before acting on any event that claims money moved: anyone who can reach the endpoint can post that claim, and a harness that believes an unverified 'payment succeeded' ships goods for free. The comparison is constant-time, and the body must be the raw bytes as received — re-serializing parsed JSON changes the bytes the signature covers.",
  inputSchema: z.object({
    body: z.string().describe("the raw request body, exactly as received"),
    signatureHeader: z.string().min(1).describe("e.g. t=1614556800,v1=abc…"),
    secretEnvVar: z
      .string()
      .min(1)
      .describe("NAME of the environment variable holding the signing secret, never the secret"),
    toleranceSeconds: z.number().int().positive().max(86_400).optional().describe("default 300"),
    scheme: z.string().optional().describe("default v1"),
    now: instantField.optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    // The secret arrives as the NAME of an environment variable. Taking it
    // inline would put a signing key into a spec, a transcript and a model's
    // context, which is the posture tool-fetch established for credentials.
    const secret = process.env[input.secretEnvVar];
    if (secret === undefined || secret === "") {
      return `the environment variable "${input.secretEnvVar}" is not set, so the signature cannot be checked — refusing rather than reporting the event as unverified`;
    }
    const nowMs = input.now === undefined ? Date.now() : parseInstant(input.now, "now");
    return json(
      verifyWebhookSignature(input.body, input.signatureHeader, secret, {
        nowMs,
        toleranceSeconds: input.toleranceSeconds,
        scheme: input.scheme,
      }),
    );
  },
});

export const statementParse: RegisteredTool = buildTool({
  name: "StatementParse",
  description:
    "Turn a bank, card or exchange export into one normalized transaction list with ISO dates and signed minor-unit amounts. Use it to reconcile without putting the statement through a context window. It reads CSV and OFX, applies the sign a debit or credit column implies rather than reading it, and REFUSES a file whose dates could be day-first or month-first unless the order is stated — a wrong guess moves transactions between months, which reconciles to exactly twice the error. Rows it cannot read are listed with reasons rather than dropped.",
  inputSchema: z.object({
    file: z.string().min(1).describe("workspace-relative path to the export"),
    format: z
      .enum(STATEMENT_FORMATS)
      .optional()
      .describe("detected from the contents when omitted"),
    dateOrder: z
      .enum(DATE_ORDERS)
      .optional()
      .describe("iso, dmy or mdy; required when the file is ambiguous"),
    decimalComma: z.boolean().optional().describe("1.234,56 rather than 1,234.56"),
    decimals: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe("minor-unit exponent; 2 by default, 0 for JPY"),
    columns: z
      .object({
        date: z.string().optional(),
        description: z.string().optional(),
        amount: z.string().optional(),
        debit: z.string().optional(),
        credit: z.string().optional(),
        balance: z.string().optional(),
        reference: z.string().optional(),
      })
      .optional()
      .describe("column names, when the header does not use recognizable ones"),
    limit: z
      .number()
      .int()
      .positive()
      .max(20_000)
      .optional()
      .describe("cap the returned list; default 500"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const at = resolveSafe("StatementParse", input.file);
    const size = statSync(at.real).size;
    if (size > LIMITS.statementBytes) {
      throw new Error(`${at.rel} is ${size} bytes, over the ${LIMITS.statementBytes}-byte limit`);
    }
    const result = parseStatement(readFileSync(at.real, "utf-8"), input);
    const limit = input.limit ?? 500;
    return json({
      file: at.rel,
      format: result.format,
      dateOrder: result.dateOrder,
      count: result.count,
      totalMinor: result.totalMinor,
      debitMinor: result.debitMinor,
      creditMinor: result.creditMinor,
      rejected: result.rejected,
      transactions: result.transactions.slice(0, limit),
      truncated: result.count > limit,
    });
  },
});

export const glCodeSuggest: RegisteredTool = buildTool({
  name: "GlCodeSuggest",
  description:
    "Code invoice lines to a GL account and cost centre from versioned operator rules, and put only the genuinely unclear ones in a review queue. Use it because most lines on most invoices code the same way every month, and a coding a model produced cannot be reproduced at year end. Two rules that match at the same priority and disagree are reported as ambiguous rather than resolved — the wrong account is found in an audit, not in a test — and a line no rule matched always goes to review.",
  inputSchema: z.object({
    lines: z
      .array(z.object({ id: z.string().min(1) }).passthrough())
      .min(1)
      .max(LIMITS.lines)
      .describe("invoice lines; any fields, referenced by the rules' paths"),
    rules: z
      .array(
        z.object({
          id: z.string().min(1),
          when: z.array(checkSchema).min(1).max(LIMITS.checks),
          account: z.string().min(1),
          costCenter: z.string().optional(),
          taxCode: z.string().optional(),
          priority: z.number().optional(),
        }),
      )
      .min(1)
      .max(LIMITS.rules),
    version: z.string().optional().describe("echoed into the result, so a coding is attributable"),
    defaultAccount: z
      .string()
      .optional()
      .describe("where unmatched lines go; they still need review"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json(
      codeLines(input.lines, input.rules as ReadonlyArray<CodingRule>, {
        version: input.version,
        defaultAccount: input.defaultAccount,
      }),
    ),
});

/** Every tool this package registers, in the order a catalog should list them. */
export const MONEY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  costBasisCompute,
  glCodeSuggest,
  paymentIdentifierValidate,
  purchaseOrderMatch,
  refundAbuseCheck,
  refundAmountCompute,
  spendLimitCheck,
  statementParse,
  taxCalculate,
  webhookSignatureVerify,
]);

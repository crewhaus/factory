/**
 * Invoices: the totals, the logic-less template, and the number.
 *
 * THE NUMBER IS THE HARD PART. A legally required document sequence has to be
 * gap-free and monotonic, and the two obvious orderings both break it:
 * allocate the number and then write the file, and a crash in between burns a
 * number forever; write the file and then allocate, and two concurrent calls
 * write two documents with the same number. What works is neither: allocate
 * the number AND record the document — its idempotency key, and the hash of
 * everything that determines its bytes — in one `BEGIN IMMEDIATE`
 * transaction, then render. If the render dies, the same call repeated with
 * the same key gets the SAME number back and re-renders the SAME bytes,
 * because the rendering is a pure function of the recorded payload. Nothing is
 * burnt and nothing is duplicated. `resetYearly` takes its year from
 * `issueDate`, never from the clock, or an invoice back-dated across New Year
 * lands in the wrong sequence.
 *
 * THE SECOND HARD PART IS BYTES. `Intl.NumberFormat` output moves with the
 * ICU version the runtime was built against, so an invoice rendered on a
 * developer's Mac and on a CI container can differ in the separator between
 * thousands — on a document somebody files. This package therefore has no
 * locale formatter at all: amounts are rendered from exact decimal strings
 * with separators the caller names, and dates are ISO. Nothing here can move
 * with an ICU upgrade because nothing here asks ICU anything.
 */
import type { Database } from "bun:sqlite";
import {
  LedgerError,
  assertIsoDate,
  byString,
  exponentFor,
  formatMajor,
  multiplyMinor,
  parseFactor,
  parseMajor,
  parseMinorUnits,
  yearOf,
} from "./amount";
import { type DocumentRow, inImmediateTransaction } from "./db";

export const DOCUMENT_KINDS = ["invoice", "receipt", "credit_note", "quote"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const OUTPUT_FORMATS = ["html", "markdown", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const INVOICE_LIMITS = {
  lines: 1_000,
  templateBytes: 256 * 1024,
} as const;

export type PartyInput = {
  readonly name: string;
  readonly address?: ReadonlyArray<string>;
  readonly taxId?: string;
  readonly email?: string;
  readonly phone?: string;
};

export type InvoiceLineInput = {
  readonly description: string;
  readonly quantity?: string;
  readonly unitAmount?: string;
  readonly unitAmountMinor?: string | number;
  readonly discount?: string;
  readonly discountMinor?: string | number;
  readonly taxRateBps?: number;
  readonly taxMinor?: string | number;
};

export type NumberFormatOptions = {
  readonly decimalSeparator?: string;
  readonly groupSeparator?: string;
};

/**
 * Minor units as the document shows them. No `Intl`, on purpose (see above):
 * the digits come from exact bigint arithmetic and the separators come from
 * the caller, so the same input renders the same bytes on every machine.
 */
export function formatAmount(
  minor: bigint,
  exponent: number,
  options: NumberFormatOptions = {},
): string {
  const plain = formatMajor(minor, exponent);
  const negative = plain.startsWith("-");
  const body = negative ? plain.slice(1) : plain;
  const dot = body.indexOf(".");
  let whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? "" : body.slice(dot + 1);
  const group = options.groupSeparator ?? "";
  if (group !== "") whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const decimal = options.decimalSeparator ?? ".";
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : decimal + fraction}`;
}

export type ComputedLine = {
  readonly index: number;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmountMinor: string;
  readonly netMinor: string;
  readonly discountMinor: string;
  readonly taxMinor: string;
  readonly taxRateBps: number | null;
  readonly totalMinor: string;
};

/**
 * The four figures a document shows, in the order it shows them and with the
 * arithmetic a reader will do on them:
 *
 *     subtotal − discount + tax = total
 *
 * `subtotalMinor` is therefore the sum of the lines BEFORE discount. Making it
 * the net instead — the sum after discount — leaves every individual figure
 * defensible and the document as a whole wrong: 90.00 subtotal, 10.00
 * discount, 18.00 tax and a 108.00 total is a page whose own sum is 98.00, and
 * the first person to check the arithmetic is the customer being asked to pay
 * it. `netMinor` is carried alongside for anybody who wants the after-discount
 * figure without subtracting.
 */
export type ComputedTotals = {
  readonly subtotalMinor: string;
  readonly discountMinor: string;
  readonly netMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
};

/**
 * Totals are computed, never accepted.
 *
 * A total supplied alongside the lines is a second source of truth, and the
 * one that gets believed is the one a model wrote. Quantities are exact
 * decimals so "1.5 hours" is not a float, and each line rounds once.
 *
 * Tax here is a flat per-line rate, which covers the ordinary case. For
 * compound rates, exemptions, reverse charge or per-invoice rounding scope,
 * run `@crewhaus/tool-money`'s `TaxCalculate` and pass the answer in as
 * `taxMinor` — this refuses both at once rather than guessing which wins.
 */
export function computeInvoice(
  lines: ReadonlyArray<InvoiceLineInput>,
  exponent: number,
): { lines: ComputedLine[]; totals: ComputedTotals } {
  if (lines.length === 0) throw new LedgerError("an invoice with no lines is not a document");
  if (lines.length > INVOICE_LIMITS.lines) {
    throw new LedgerError(`${lines.length} lines is over the ${INVOICE_LIMITS.lines} limit`);
  }
  const computed: ComputedLine[] = [];
  let grossTotal = 0n;
  let discountTotal = 0n;
  let taxTotal = 0n;
  for (const [index, line] of lines.entries()) {
    const at = `line ${index}`;
    // A description is one table cell. A line break inside it splits the row
    // and shifts every column after it, so the Total column ends up showing
    // the Tax — a wrong number on a document somebody pays from, arrived at
    // without a single wrong figure being computed.
    if (/[\r\n]/.test(line.description)) {
      throw new LedgerError(
        `${at} has a line break inside its description — a description is one cell of one row, and a break would push the amounts into the wrong columns; put the detail in "notes"`,
      );
    }
    if (line.unitAmount !== undefined && line.unitAmountMinor !== undefined) {
      throw new LedgerError(`${at} gives both unitAmount and unitAmountMinor — pick one spelling`);
    }
    const unit =
      line.unitAmount !== undefined
        ? parseMajor(line.unitAmount, exponent, `${at} unitAmount`)
        : line.unitAmountMinor !== undefined
          ? parseMinorUnits(line.unitAmountMinor, `${at} unitAmountMinor`)
          : null;
    if (unit === null) throw new LedgerError(`${at} has no unit amount`);
    const quantity = parseFactor(line.quantity ?? "1", `${at} quantity`);
    if (quantity.unscaled < 0n) {
      throw new LedgerError(
        `${at} has a negative quantity — a return is a credit note, which is a different document kind`,
      );
    }
    const gross = multiplyMinor(unit, quantity);
    if (line.discount !== undefined && line.discountMinor !== undefined) {
      throw new LedgerError(`${at} gives both discount and discountMinor — pick one spelling`);
    }
    const discount =
      line.discount !== undefined
        ? parseMajor(line.discount, exponent, `${at} discount`)
        : line.discountMinor !== undefined
          ? parseMinorUnits(line.discountMinor, `${at} discountMinor`)
          : 0n;
    if (discount < 0n) throw new LedgerError(`${at} has a negative discount, which is a surcharge`);
    if (discount > gross) {
      throw new LedgerError(
        `${at} discounts ${formatMajor(discount, exponent)} off a line worth ${formatMajor(gross, exponent)} — a line cannot be worth less than nothing`,
      );
    }
    const net = gross - discount;
    if (line.taxRateBps !== undefined && line.taxMinor !== undefined) {
      throw new LedgerError(
        `${at} gives both taxRateBps and taxMinor — two sources of truth for the same number, and this will not choose between them`,
      );
    }
    const tax =
      line.taxMinor !== undefined
        ? parseMinorUnits(line.taxMinor, `${at} taxMinor`)
        : line.taxRateBps !== undefined
          ? multiplyMinor(net, { unscaled: BigInt(line.taxRateBps), scale: 4 })
          : 0n;
    if (tax < 0n) throw new LedgerError(`${at} has negative tax`);
    grossTotal += gross;
    discountTotal += discount;
    taxTotal += tax;
    computed.push({
      index,
      description: line.description,
      quantity: line.quantity ?? "1",
      unitAmountMinor: unit.toString(),
      netMinor: net.toString(),
      discountMinor: discount.toString(),
      taxMinor: tax.toString(),
      taxRateBps: line.taxRateBps ?? null,
      totalMinor: (net + tax).toString(),
    });
  }
  // subtotal − discount + tax = total, which is the sum the document invites
  // a reader to check. `net` is the same as the sum of the lines' netMinor,
  // and `total` is the same as the sum of their totalMinor, so the line column
  // and the totals block agree as well.
  const net = grossTotal - discountTotal;
  return {
    lines: computed,
    totals: {
      subtotalMinor: grossTotal.toString(),
      discountMinor: discountTotal.toString(),
      netMinor: net.toString(),
      taxMinor: taxTotal.toString(),
      totalMinor: (net + taxTotal).toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// numbering

export type NumberingConfig = {
  readonly prefix: string;
  readonly pad: number;
  readonly resetYearly: boolean;
  readonly start: number;
};

export type Allocation = {
  readonly number: string;
  readonly ordinal: number;
  readonly sequenceName: string;
  readonly replayed: boolean;
  /**
   * Whether the sequence has issued every number between its start and its
   * next — or `null` when there is no sequence to check, which is the case for
   * a number the caller assigned. `null` is not `false` and it is emphatically
   * not `true`: "I could not check this" has to survive to the caller, because
   * a gap in a document sequence is a finding in most jurisdictions and a
   * confident `true` from a check that never ran is how it gets missed.
   */
  readonly gapFree: boolean | null;
  readonly files: ReadonlyArray<string>;
};

/** `INV-` + the issue date's year when the sequence resets yearly. */
export function sequenceNameFor(
  kind: DocumentKind,
  config: NumberingConfig,
  issueDate: string,
): string {
  return config.resetYearly ? `${kind}:${yearOf(issueDate)}` : kind;
}

export function numberFor(config: NumberingConfig, issueDate: string, ordinal: number): string {
  const year = config.resetYearly ? `${yearOf(issueDate)}-` : "";
  return `${config.prefix}${year}${String(ordinal).padStart(config.pad, "0")}`;
}

/** Characters a document number may hold, because it also names a file. */
const FILENAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A document number is also a FILE NAME, so it is contained like one.
 *
 * `outDir` goes through `resolveSafe`, but the leaf does not — the file is
 * `${number}.${format}` under that directory — and the number is
 * caller-supplied twice over: directly as `number`, and indirectly through
 * `numbering.prefix`. Without this check `number: "../../escaped"` writes
 * outside the workspace root, and because the write finishes with a rename it
 * silently REPLACES whatever was already there. Containing the directory and
 * not the leaf contains nothing.
 *
 * Called before the sequence is touched, for the reason the rest of this file
 * is shaped the way it is: a refusal must not cost a number.
 */
export function assertNumberIsAFileName(number: string, where: string): string {
  if (!FILENAME_SAFE.test(number) || number.includes("..")) {
    throw new LedgerError(
      `${where} ("${number}") cannot be used as a document number: it becomes the name of a file under outDir, so it may hold only letters, digits, ".", "-" and "_", must start with a letter or a digit, and may not contain ".." — a number that walks out of the directory would overwrite a file nobody asked it to touch`,
    );
  }
  return number;
}

/**
 * Take the next number and record the document, in one transaction.
 *
 * The idempotency key is what makes a retry safe. A second call with the same
 * key and the same payload gets the same number back and posts nothing; a
 * second call with the same key and a DIFFERENT payload is refused, because
 * that is somebody re-using a key for a new document and the alternative is
 * two different invoices claiming one number.
 */
export function allocateDocument(
  db: Database,
  args: {
    readonly kind: DocumentKind;
    readonly config: NumberingConfig;
    readonly issueDate: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly files: ReadonlyArray<string>;
    readonly createdAt: string;
  },
): Allocation {
  const sequenceName = sequenceNameFor(args.kind, args.config, args.issueDate);
  return inImmediateTransaction(db, (): Allocation => {
    const existing = db
      .query("SELECT * FROM documents WHERE idempotency_key = ?")
      .get(args.idempotencyKey) as DocumentRow | null;
    if (existing !== null) {
      if (existing.payload_hash !== args.payloadHash) {
        throw new LedgerError(
          `idempotency key "${args.idempotencyKey}" already issued ${existing.number} for different content — a document number identifies one document, so this will not re-use the key; issue a credit note and a new document instead`,
        );
      }
      return {
        number: existing.number,
        ordinal: existing.ordinal,
        sequenceName: existing.sequence_name,
        replayed: true,
        gapFree: checkGapFree(db, existing.sequence_name),
        files: JSON.parse(existing.files) as string[],
      };
    }
    const row = db.query("SELECT next, start FROM sequences WHERE name = ?").get(sequenceName) as {
      next: number;
      start: number;
    } | null;
    const start = row?.start ?? args.config.start;
    const ordinal = row?.next ?? args.config.start;
    const number = numberFor(args.config, args.issueDate, ordinal);
    db.run(
      "INSERT INTO documents (number, kind, sequence_name, ordinal, issue_date, idempotency_key, payload_hash, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        number,
        args.kind,
        sequenceName,
        ordinal,
        args.issueDate,
        args.idempotencyKey,
        args.payloadHash,
        JSON.stringify(args.files),
        args.createdAt,
      ],
    );
    db.run(
      "INSERT INTO sequences (name, next, start) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET next = ?",
      [sequenceName, ordinal + 1, start, ordinal + 1],
    );
    return {
      number,
      ordinal,
      sequenceName,
      replayed: false,
      gapFree: checkGapFree(db, sequenceName),
      files: args.files,
    };
  });
}

/**
 * Whether the sequence has issued every number between its start and its next.
 *
 * This is a check, not an assumption: the transaction above makes a gap
 * impossible through this tool, and this is what notices if one appears
 * anyway — a row deleted by hand, a restored backup.
 */
function checkGapFree(db: Database, sequenceName: string): boolean {
  const seq = db.query("SELECT next, start FROM sequences WHERE name = ?").get(sequenceName) as {
    next: number;
    start: number;
  } | null;
  if (seq === null) return true;
  const count = db
    .query("SELECT COUNT(*) AS n FROM documents WHERE sequence_name = ?")
    .get(sequenceName) as { n: number };
  return count.n === seq.next - seq.start;
}

// ---------------------------------------------------------------------------
// the template

/**
 * Markdown output escapes a pipe, because a pipe ENDS A TABLE CELL.
 *
 * A description of "Widget | Deluxe" renders six cells into a five-column
 * table: the reader sees "Deluxe" as the quantity, the unit amount as the tax,
 * and — because the last cell is dropped — a Total of 0.00 on a line worth a
 * hundred. Nothing computes a wrong number; the document simply shows the
 * wrong one. `renderRows` in ./query escapes the same character for the same
 * reason, and this is the invoice's copy of that rule.
 */
export function escapeMarkdown(text: string): string {
  return text.split("|").join("\\|");
}

export function escapeHtml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; path: string; raw: boolean }
  | { kind: "section"; path: string; inverted: boolean; children: Node[] };

const TAG = /\{\{(\{)?([#^/]?)\s*([A-Za-z0-9_.]+)\s*(\})?\}\}/g;

function parseTemplate(template: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ path: string; children: Node[] }> = [];
  const push = (node: Node): void => {
    const top = stack[stack.length - 1];
    (top === undefined ? root : top.children).push(node);
  };
  let cursor = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(template); m !== null; m = TAG.exec(template)) {
    if (m.index > cursor) push({ kind: "text", text: template.slice(cursor, m.index) });
    cursor = m.index + m[0].length;
    const sigil = m[2] ?? "";
    const path = m[3] as string;
    if (sigil === "#" || sigil === "^") {
      const node: Node = { kind: "section", path, inverted: sigil === "^", children: [] };
      push(node);
      stack.push({ path, children: node.children });
    } else if (sigil === "/") {
      const top = stack.pop();
      if (top === undefined || top.path !== path) {
        throw new LedgerError(
          `the template closes {{/${path}}} where ${top === undefined ? "nothing" : `{{#${top.path}}}`} is open — a mismatched section renders silently wrong, so it is refused`,
        );
      }
    } else {
      push({ kind: "var", path, raw: m[1] === "{" });
    }
  }
  if (cursor < template.length) push({ kind: "text", text: template.slice(cursor) });
  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) {
    throw new LedgerError(`the template leaves {{#${unclosed.path}}} unclosed`);
  }
  return root;
}

function lookup(context: ReadonlyArray<unknown>, path: string): unknown {
  for (let i = context.length - 1; i >= 0; i--) {
    let value = context[i];
    if (path === ".") return value;
    let found = true;
    for (const segment of path.split(".")) {
      if (value === null || typeof value !== "object" || !(segment in (value as object))) {
        found = false;
        break;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (found) return value;
  }
  return undefined;
}

/**
 * A logic-less template: variables, array sections, inverted sections. No
 * partials, no lambdas, no expressions — a template that can compute is a
 * template that can compute a total, and totals come from `computeInvoice`.
 *
 * `strict` (on by default) refuses an unknown path instead of rendering the
 * empty string. Mustache's silence is the right default for a web page and
 * the wrong one for an invoice: a mistyped `{{seller.taxId}}` would drop the
 * VAT number off the document and nothing would say so.
 *
 * Only ARRAYS iterate. A plain object never does, because the order it would
 * iterate in is insertion order, and that is not a property of the document.
 */
export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  options: { readonly escape: (text: string) => string; readonly strict: boolean },
): string {
  if (template.length > INVOICE_LIMITS.templateBytes) {
    throw new LedgerError(
      `the template is ${template.length} bytes, over the ${INVOICE_LIMITS.templateBytes} limit`,
    );
  }
  const nodes = parseTemplate(template);
  const out: string[] = [];
  const walk = (list: ReadonlyArray<Node>, context: unknown[]): void => {
    for (const node of list) {
      if (node.kind === "text") {
        out.push(node.text);
        continue;
      }
      const value = lookup(context, node.path);
      if (node.kind === "var") {
        if (value === undefined || value === null) {
          if (options.strict) {
            throw new LedgerError(
              `the template refers to "${node.path}", which this document has no value for — refusing rather than rendering a blank where a tax number or a total should be`,
            );
          }
          continue;
        }
        const text = String(value);
        out.push(node.raw ? text : options.escape(text));
        continue;
      }
      const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
      if (node.inverted) {
        if (!truthy) walk(node.children, context);
        continue;
      }
      if (!truthy) continue;
      if (Array.isArray(value)) {
        for (const item of value) walk(node.children, [...context, item]);
      } else if (typeof value === "object") {
        walk(node.children, [...context, value]);
      } else {
        walk(node.children, context);
      }
    }
  };
  walk(nodes, [data]);
  return out.join("");
}

/** Column order in the built-in templates, written out rather than iterated. */
export const LINE_COLUMNS = ["description", "quantity", "unitAmount", "tax", "total"] as const;

export const BUILTIN_TEMPLATES: Readonly<Record<"html" | "markdown", string>> = Object.freeze({
  markdown: `# {{kindLabel}} {{number}}

**{{seller.name}}**{{#seller.taxId}} · {{seller.taxId}}{{/seller.taxId}}
{{#seller.address}}{{.}}
{{/seller.address}}

**Billed to:** {{buyer.name}}{{#buyer.taxId}} · {{buyer.taxId}}{{/buyer.taxId}}
{{#buyer.address}}{{.}}
{{/buyer.address}}

Issued: {{issueDate}}{{#dueDate}} · Due: {{dueDate}}{{/dueDate}}{{#reference}} · Ref: {{reference}}{{/reference}}

| Description | Qty | Unit | Tax | Total |
| --- | ---: | ---: | ---: | ---: |
{{#lines}}| {{description}} | {{quantity}} | {{unitAmount}} | {{tax}} | {{total}} |
{{/lines}}

| | |
| --- | ---: |
| Subtotal | {{totals.subtotal}} {{currency}} |
| Discount | {{totals.discount}} {{currency}} |
| Tax | {{totals.tax}} {{currency}} |
| **Total** | **{{totals.total}} {{currency}}** |
{{#notes}}

{{notes}}
{{/notes}}{{#paymentInstructions}}

{{paymentInstructions}}
{{/paymentInstructions}}
`,
  html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{kindLabel}} {{number}}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.4rem .6rem;text-align:left}td.n,th.n{text-align:right}.tot td{border:0}</style>
</head><body>
<h1>{{kindLabel}} {{number}}</h1>
<p><strong>{{seller.name}}</strong>{{#seller.taxId}} &middot; {{seller.taxId}}{{/seller.taxId}}<br>
{{#seller.address}}{{.}}<br>{{/seller.address}}</p>
<p><strong>Billed to:</strong> {{buyer.name}}{{#buyer.taxId}} &middot; {{buyer.taxId}}{{/buyer.taxId}}<br>
{{#buyer.address}}{{.}}<br>{{/buyer.address}}</p>
<p>Issued: {{issueDate}}{{#dueDate}} &middot; Due: {{dueDate}}{{/dueDate}}{{#reference}} &middot; Ref: {{reference}}{{/reference}}</p>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Tax</th><th class="n">Total</th></tr></thead><tbody>
{{#lines}}<tr><td>{{description}}</td><td class="n">{{quantity}}</td><td class="n">{{unitAmount}}</td><td class="n">{{tax}}</td><td class="n">{{total}}</td></tr>
{{/lines}}</tbody><tfoot>
<tr class="tot"><td colspan="4" class="n">Subtotal</td><td class="n">{{totals.subtotal}} {{currency}}</td></tr>
<tr class="tot"><td colspan="4" class="n">Discount</td><td class="n">{{totals.discount}} {{currency}}</td></tr>
<tr class="tot"><td colspan="4" class="n">Tax</td><td class="n">{{totals.tax}} {{currency}}</td></tr>
<tr class="tot"><td colspan="4" class="n"><strong>Total</strong></td><td class="n"><strong>{{totals.total}} {{currency}}</strong></td></tr>
</tfoot></table>
{{#notes}}<p>{{notes}}</p>{{/notes}}
{{#paymentInstructions}}<p>{{paymentInstructions}}</p>{{/paymentInstructions}}
</body></html>
`,
});

const KIND_LABELS: Readonly<Record<DocumentKind, string>> = Object.freeze({
  invoice: "Invoice",
  receipt: "Receipt",
  credit_note: "Credit note",
  quote: "Quote",
});

/** The object a template sees, and the `json` output verbatim. */
export function documentModel(args: {
  readonly kind: DocumentKind;
  readonly number: string;
  readonly currency: string;
  readonly exponent: number;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly reference?: string;
  readonly notes?: string;
  readonly paymentInstructions?: string;
  readonly seller: PartyInput;
  readonly buyer: PartyInput;
  readonly computed: { lines: ComputedLine[]; totals: ComputedTotals };
  readonly numberFormat: NumberFormatOptions;
}): Record<string, unknown> {
  const money = (minor: string): string =>
    formatAmount(BigInt(minor), args.exponent, args.numberFormat);
  return {
    kind: args.kind,
    kindLabel: KIND_LABELS[args.kind],
    number: args.number,
    currency: args.currency,
    issueDate: args.issueDate,
    dueDate: args.dueDate ?? "",
    reference: args.reference ?? "",
    notes: args.notes ?? "",
    paymentInstructions: args.paymentInstructions ?? "",
    seller: party(args.seller),
    buyer: party(args.buyer),
    lines: args.computed.lines.map((line) => ({
      index: line.index,
      description: line.description,
      quantity: line.quantity,
      unitAmount: money(line.unitAmountMinor),
      unitAmountMinor: line.unitAmountMinor,
      discount: money(line.discountMinor),
      discountMinor: line.discountMinor,
      taxRateBps: line.taxRateBps ?? "",
      tax: money(line.taxMinor),
      taxMinor: line.taxMinor,
      net: money(line.netMinor),
      netMinor: line.netMinor,
      total: money(line.totalMinor),
      totalMinor: line.totalMinor,
    })),
    totals: {
      subtotal: money(args.computed.totals.subtotalMinor),
      subtotalMinor: args.computed.totals.subtotalMinor,
      discount: money(args.computed.totals.discountMinor),
      discountMinor: args.computed.totals.discountMinor,
      net: money(args.computed.totals.netMinor),
      netMinor: args.computed.totals.netMinor,
      tax: money(args.computed.totals.taxMinor),
      taxMinor: args.computed.totals.taxMinor,
      total: money(args.computed.totals.totalMinor),
      totalMinor: args.computed.totals.totalMinor,
    },
  };
}

function party(input: PartyInput): Record<string, unknown> {
  return {
    name: input.name,
    address: [...(input.address ?? [])],
    taxId: input.taxId ?? "",
    email: input.email ?? "",
    phone: input.phone ?? "",
  };
}

/** Validate the dates an invoice carries, in one place. */
export function validateInvoiceDates(issueDate: string, dueDate?: string): void {
  assertIsoDate(issueDate, "issueDate");
  if (dueDate === undefined) return;
  assertIsoDate(dueDate, "dueDate");
  if (dueDate < issueDate) {
    throw new LedgerError(
      `dueDate ${dueDate} is before issueDate ${issueDate} — a document that is overdue the moment it is issued is a transposed pair of dates`,
    );
  }
}

export { byString, exponentFor };

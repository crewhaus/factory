/**
 * `@crewhaus/tool-ledger` — a local double-entry ledger, and the reports that
 * make one usable.
 *
 * Four tools: post balanced entries to a hash-chained `bun:sqlite` journal,
 * read the standard views out of it, match it against a statement, and render
 * a sequentially numbered invoice.
 *
 * THREE PROPERTIES HOLD ACROSS ALL OF THEM.
 *
 * 1. **Nothing moves money.** Nothing here opens a socket. No schema in this
 *    package accepts an account number, a card, an API key or any other
 *    credential, and `index.test.ts` asserts that over every schema rather
 *    than trusting this paragraph. An invoice is rendered to a file; a
 *    reconciliation returns entries a person could post. Sending a payment
 *    instruction is a different job in a different package with different
 *    gates.
 * 2. **Money is never a JS float.** Amounts arrive as decimal strings or as
 *    integer minor units and are carried as bigints; the arithmetic and the
 *    ISO 4217 exponent table come from `@crewhaus/tool-math`'s money kernel,
 *    and the reconciler's row shape is `@crewhaus/tool-money`'s `Transaction`,
 *    imported rather than re-declared.
 * 3. **Every write is one `BEGIN IMMEDIATE` transaction.** The rows, the hash
 *    chain's head and the idempotency claim commit together or not at all —
 *    see `./lib/db` for why anything less leaves a ledger that verifies and
 *    still posts the same payment twice.
 *
 * There is no network seam here because there is no network. The one seam is
 * `_setClock`, so a test can fix `postedAt` — which is inside the hash chain,
 * so a wall-clock read would make the same posting hash differently twice.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type Transaction, parseStatement } from "@crewhaus/tool-money";
import { z } from "zod";
import {
  LedgerError,
  assertInstant,
  assertIsoDate,
  canonicalJson,
  exponentFor,
  json,
  parseMinorUnits,
  sha256Hex,
} from "./lib/amount";
import {
  ACCOUNT_TYPES,
  DEFAULT_BUSY_TIMEOUT_MS,
  inImmediateTransaction,
  openDb,
  readMeta,
  writeMeta,
} from "./lib/db";
import {
  BUILTIN_TEMPLATES,
  DOCUMENT_KINDS,
  type DocumentKind,
  OUTPUT_FORMATS,
  allocateDocument,
  assertNumberIsAFileName,
  computeInvoice,
  documentModel,
  escapeHtml,
  escapeMarkdown,
  numberFor,
  renderTemplate,
  validateInvoiceDates,
} from "./lib/invoice";
import { POST_LIMITS, ensureAccounts, postBatch } from "./lib/post";
import { FORMATS, VIEWS, renderRows, runQuery } from "./lib/query";
import { RECONCILE_LIMITS, reconcile } from "./lib/reconcile";
import { resolveSafe } from "./paths";

// ---------------------------------------------------------------------------
// the one seam
// ---------------------------------------------------------------------------

let clock: () => number = Date.now;

/**
 * Replace the clock. Tests drive this so that `postedAt` — which is inside the
 * hashed payload — is fixed, and so no assertion in this package depends on
 * wall-clock time.
 */
export function _setClock(fn: () => number): void {
  clock = fn;
}

const nowIso = (): string => new Date(clock()).toISOString();

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = ".crewhaus/ledger.sqlite";

const dbPathField = z
  .string()
  .min(1)
  .max(1_024)
  .optional()
  .describe(`workspace-relative path to the ledger file; default ${DEFAULT_DB_PATH}`);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "an ISO calendar date, YYYY-MM-DD")
  .describe("ISO calendar date, YYYY-MM-DD");

const currencyField = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "a three-letter ISO 4217 code")
  .describe("ISO 4217 code; sets the minor-unit exponent");

const exponentField = z
  .number()
  .int()
  .min(0)
  .max(6)
  .optional()
  .describe("minor-unit exponent for a code the ISO 4217 table does not carry");

/** Decimal string in major units, or a whole number of minor units. */
const amountField = z
  .union([z.string().min(1).max(64), z.number().int()])
  .describe("a whole number of minor units; never a float");

const busyTimeoutField = z
  .number()
  .int()
  .positive()
  .max(120_000)
  .optional()
  .describe(`ms to wait for another writer's lock; default ${DEFAULT_BUSY_TIMEOUT_MS}`);

type Opened = {
  db: import("bun:sqlite").Database;
  rel: string;
  baseCurrency: string;
  exponent: number;
};

/**
 * Open the ledger and settle the base currency.
 *
 * The base currency is fixed by the FIRST posting and stored in the file. A
 * later call that names a different one is refused rather than converted: a
 * ledger whose base currency changed halfway is a set of totals that cannot be
 * added together, and nothing in the rows records which half is which.
 */
function open(
  toolName: string,
  input: { dbPath?: string; baseCurrency?: string; baseExponent?: number; busyTimeoutMs?: number },
  mode: "read" | "write",
  needBaseCurrency = true,
): Opened {
  const at = resolveSafe(toolName, input.dbPath ?? DEFAULT_DB_PATH);
  const db = openDb(at.real, mode, input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, at.rel);
  const stored = readMeta(db, "baseCurrency");
  const storedExponent = readMeta(db, "baseExponent");
  if (stored === null) {
    // `InvoiceRender` only ever touches the numbering tables, so it does not
    // need the book's reporting currency and must not be the call that fixes
    // it — an invoice in EUR should not decide that the ledger reports in EUR.
    if (!needBaseCurrency) return { db, rel: at.rel, baseCurrency: "", exponent: 0 };
    if (mode === "read") {
      throw new LedgerError(
        `the ledger at ${at.rel} has no entries yet, so it has no base currency — post to it before reading it`,
      );
    }
    if (input.baseCurrency === undefined) {
      throw new LedgerError(
        "this ledger is new and has no base currency — state baseCurrency on the first post; defaulting it would fix the reporting currency of somebody's books by accident",
      );
    }
    const currency = input.baseCurrency.toUpperCase();
    const exponent = exponentFor(currency, input.baseExponent);
    writeMeta(db, "baseCurrency", currency);
    writeMeta(db, "baseExponent", String(exponent));
    return { db, rel: at.rel, baseCurrency: currency, exponent };
  }
  if (
    needBaseCurrency &&
    input.baseCurrency !== undefined &&
    input.baseCurrency.toUpperCase() !== stored
  ) {
    db.close();
    throw new LedgerError(
      `this ledger's base currency is ${stored} and the call says ${input.baseCurrency.toUpperCase()} — refusing, because re-basing a book of record is not something a tool call should do silently`,
    );
  }
  return {
    db,
    rel: at.rel,
    baseCurrency: stored,
    exponent: Number(storedExponent ?? String(exponentFor(stored))),
  };
}

// ---------------------------------------------------------------------------
// LedgerPost
// ---------------------------------------------------------------------------

const lineSchema = z
  .object({
    account: z.string().min(1).max(128).describe("account code from the chart of accounts"),
    debit: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("major units as a decimal string, e.g. '1250.00'"),
    credit: z.string().min(1).max(64).optional(),
    debitMinor: amountField.optional(),
    creditMinor: amountField.optional(),
    currency: currencyField.optional().describe("defaults to the ledger's base currency"),
    exponent: exponentField,
    fxRate: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("required on a line not in the base currency; units of base per unit of this line"),
    counterparty: z.string().max(256).optional().describe("required by the aging view"),
    dueDate: isoDate.optional().describe("required by the aging view"),
    memo: z.string().max(2_000).optional(),
  })
  .strict();

const entrySchema = z
  .object({
    date: isoDate,
    memo: z.string().min(1).max(2_000),
    reference: z.string().max(256).optional(),
    // min(1), not min(2): "at least two lines" is the double-entry rule, and
    // it belongs with the balance check, where it produces a rejection
    // carrying this entry's index. Enforced by the schema it would instead
    // fail the whole call, so one malformed entry would stop the 499 good
    // ones — which is the behaviour the rejected list exists to avoid.
    lines: z.array(lineSchema).min(1).max(POST_LIMITS.linesPerEntry),
    tags: z.array(z.string().max(64)).max(POST_LIMITS.tagsPerEntry).optional(),
    source: z
      .object({ system: z.string().min(1).max(64), id: z.string().min(1).max(256) })
      .strict()
      .optional()
      .describe("where this came from; the pair is unique, so the same payment cannot post twice"),
  })
  .strict();

export const ledgerPost: RegisteredTool = buildTool({
  name: "LedgerPost",
  operativeArgs: [{ field: "dbPath", kind: "path", default: DEFAULT_DB_PATH }],
  description:
    "Append balanced double-entry journal entries to a local, hash-chained SQLite ledger, refusing anything that would corrupt it. Use it instead of having a model track what has been booked: debits must equal credits or the entry is rejected with the difference named, a (source system, id) pair can only post once, a closed period stays closed, and the rows, the chain's new head and the idempotency claim all commit in ONE transaction — so a crash mid-batch leaves the book exactly as it was rather than a ledger that verifies while its duplicate suppression has forgotten the entry. Amounts are decimal strings or integer minor units, never floats. Nothing is transmitted anywhere; this writes a file.",
  inputSchema: z
    .object({
      dbPath: dbPathField,
      idempotencyKey: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "replaying it returns the first result; re-using it for different content is refused",
        ),
      entries: z.array(entrySchema).min(1).max(POST_LIMITS.entriesPerCall),
      baseCurrency: currencyField
        .optional()
        .describe("required on the first post; fixed thereafter"),
      baseExponent: exponentField,
      accounts: z
        .array(
          z
            .object({
              code: z.string().min(1).max(128),
              name: z.string().max(256).optional(),
              type: z.enum(ACCOUNT_TYPES),
            })
            .strict(),
        )
        .max(10_000)
        .optional()
        .describe("chart of accounts to declare or update before posting"),
      autoCreateAccounts: z
        .boolean()
        .optional()
        .describe(
          "off by default; an account created from a typo is a balance that reconciles to nothing",
        ),
      lockedBefore: isoDate.optional().describe("entries dated before this are refused"),
      fxAccount: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe("absorbs conversion rounding; required when an entry mixes currencies"),
      maxFxResidueMinor: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional()
        .describe("largest residue treated as rounding; default one minor unit per converted line"),
      postedAt: z
        .string()
        .max(64)
        .optional()
        .describe("ISO-8601 with a UTC offset; it is inside the hash"),
      dryRun: z.boolean().optional().describe("runs the real transaction and rolls it back"),
      busyTimeoutMs: busyTimeoutField,
    })
    .strict(),
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    const opened = open("LedgerPost", input, "write");
    try {
      if (input.accounts !== undefined) ensureAccounts(opened.db, input.accounts);
      const result = postBatch(opened.db, input.entries, {
        baseCurrency: opened.baseCurrency,
        baseExponent: opened.exponent,
        autoCreateAccounts: input.autoCreateAccounts === true,
        lockedBefore: input.lockedBefore,
        fxAccount: input.fxAccount,
        maxFxResidueMinor: input.maxFxResidueMinor,
        postedAt:
          input.postedAt === undefined ? nowIso() : assertInstant(input.postedAt, "postedAt"),
        idempotencyKey: input.idempotencyKey,
        dryRun: input.dryRun === true,
      });
      return json({ ledger: opened.rel, ...result });
    } finally {
      opened.db.close();
    }
  },
});

// ---------------------------------------------------------------------------
// LedgerQuery
// ---------------------------------------------------------------------------

/** The tighter of two upper date bounds, either of which may be absent. */
function earlier(a?: string, b?: string): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

/** An amount filter as minor units, refused by name rather than by SyntaxError. */
function minorFilter(value: string | number | undefined, label: string): string | undefined {
  return value === undefined ? undefined : parseMinorUnits(value, label).toString();
}

export const ledgerQuery: RegisteredTool = buildTool({
  name: "LedgerQuery",
  description:
    "Answer trial-balance, balance, P&L, balance-sheet, account-ledger, aging, journal, search and chain-verification questions directly from the local ledger, pre-aggregated. Use it instead of dumping the journal into a context window. Signs come from the chart of accounts, so a contra account reports correctly; totals are summed as exact integers rather than by SQL's SUM, which turns a 64-bit overflow into a float. The aging view REFUSES when the lines it would age carry no counterparty or no due date, naming the missing field, rather than returning a table in which everything is conveniently current. Read-only: it opens the file read-only and will not create one.",
  inputSchema: z
    .object({
      dbPath: dbPathField,
      view: z.enum(VIEWS),
      accounts: z.array(z.string().min(1).max(128)).max(5_000).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      asOf: isoDate.optional().describe("required by aging; never read from the clock"),
      tag: z.string().max(64).optional(),
      reference: z.string().max(256).optional(),
      sourceSystem: z.string().max(64).optional(),
      counterparty: z.string().max(256).optional(),
      text: z
        .string()
        .max(256)
        .optional()
        .describe("case-insensitive substring over memo, reference and account"),
      amountMinMinor: amountField.optional().describe("on the absolute base-currency amount"),
      amountMaxMinor: amountField.optional(),
      format: z.enum(FORMATS).optional().describe("json (default), csv or markdown"),
      limit: z
        .number()
        .int()
        .positive()
        .max(20_000)
        .optional()
        .describe("rows returned; default 200"),
      busyTimeoutMs: busyTimeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const opened = open("LedgerQuery", input, "read");
    try {
      if (input.from !== undefined) assertIsoDate(input.from, "from");
      if (input.to !== undefined) assertIsoDate(input.to, "to");
      const result = runQuery(opened.db, {
        view: input.view,
        baseCurrency: opened.baseCurrency,
        baseExponent: opened.exponent,
        limit: input.limit ?? 200,
        asOf: input.asOf,
        filter: {
          accounts: input.accounts,
          from: input.from,
          // A balance sheet and an aging are both "as of" a date, so asOf
          // narrows the selection as well as labelling it — otherwise the
          // report carries one date and is computed over every entry ever
          // posted, and an aging as of June quietly includes an August
          // invoice as "current". The EARLIER of to/asOf wins, because both
          // are upper bounds and honouring only one of them is how a report
          // ends up labelled with a date it does not cover.
          to: earlier(
            input.to,
            input.view === "balance_sheet" || input.view === "aging" ? input.asOf : undefined,
          ),
          tag: input.tag,
          reference: input.reference,
          sourceSystem: input.sourceSystem,
          counterparty: input.counterparty,
          text: input.text,
          // Parsed, not stringified. `String(input.amountMinMinor)` handed
          // "50.00" or 1e21 straight to `BigInt()`, which throws a bare
          // SyntaxError naming neither the field nor the rule — and "50.00"
          // for a fifty-dollar floor is the obvious thing to type.
          amountMinMinor: minorFilter(input.amountMinMinor, "amountMinMinor"),
          amountMaxMinor: minorFilter(input.amountMaxMinor, "amountMaxMinor"),
        },
      });
      const format = input.format ?? "json";
      if (format === "json") return json({ ledger: opened.rel, ...result });
      return json({
        ledger: opened.rel,
        view: result.view,
        totals: result.totals,
        rowCount: result.rowCount,
        truncated: result.truncated,
        notes: result.notes,
        [format]: renderRows(result.rows, format),
      });
    } finally {
      opened.db.close();
    }
  },
});

// ---------------------------------------------------------------------------
// LedgerReconcile
// ---------------------------------------------------------------------------

const MAX_STATEMENT_BYTES = 64 * 1024 * 1024;

/** The row shape is `@crewhaus/tool-money`'s, so the schema mirrors it exactly. */
const transactionSchema = z
  .object({
    id: z.string().min(1).max(256),
    date: isoDate,
    description: z.string().max(2_000),
    amountMinor: z.number().int().describe("negative for money leaving the account"),
    direction: z.enum(["debit", "credit"]),
    reference: z.string().max(256),
    balanceMinor: z.number().int().nullable(),
  })
  .strict();

const sideSchema = z
  .object({
    kind: z.enum(["lines", "statement", "ledger"]),
    lines: z
      .array(transactionSchema)
      .max(RECONCILE_LIMITS.rowsPerSide)
      .optional()
      .describe("kind 'lines': rows in StatementParse's shape"),
    file: z
      .string()
      .min(1)
      .max(1_024)
      .optional()
      .describe("kind 'statement': workspace-relative CSV or OFX"),
    dateOrder: z.enum(["iso", "dmy", "mdy"]).optional(),
    decimalComma: z.boolean().optional(),
    decimals: z.number().int().min(0).max(8).optional(),
    account: z.string().min(1).max(128).optional().describe("kind 'ledger': the account to read"),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict();

type Side = z.infer<typeof sideSchema>;

function loadSide(
  side: Side,
  label: string,
  input: { dbPath?: string; busyTimeoutMs?: number },
): Transaction[] {
  if (side.kind === "lines") {
    if (side.lines === undefined)
      throw new LedgerError(`${label}.kind is "lines" but no lines were given`);
    return side.lines;
  }
  if (side.kind === "statement") {
    if (side.file === undefined)
      throw new LedgerError(`${label}.kind is "statement" but no file was given`);
    const at = resolveSafe("LedgerReconcile", side.file);
    const size = statSync(at.real).size;
    if (size > MAX_STATEMENT_BYTES) {
      throw new LedgerError(
        `${at.rel} is ${size} bytes, over the ${MAX_STATEMENT_BYTES}-byte limit`,
      );
    }
    // tool-money's parser, not a second one: it is the thing that refuses a
    // file whose dates could be day-first or month-first, and a reconciliation
    // run on months guessed the wrong way balances to twice the error.
    return [
      ...parseStatement(readTextFile(at.real), {
        dateOrder: side.dateOrder,
        decimalComma: side.decimalComma,
        decimals: side.decimals,
      }).transactions,
    ];
  }
  if (side.account === undefined) {
    throw new LedgerError(`${label}.kind is "ledger" but no account was given`);
  }
  const opened = open("LedgerReconcile", input, "read");
  try {
    return ledgerAsTransactions(opened.db, side.account, side.from, side.to);
  } finally {
    opened.db.close();
  }
}

/** One place that reads a file, so one place decides how much of it is held. */
function readTextFile(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * One account's posted lines as statement rows.
 *
 * The id is `<entryId>:<idx>` because a line, not an entry, is what a
 * statement row corresponds to; the amount is the signed base-currency
 * movement, which is what the other side of a reconciliation carries.
 */
function ledgerAsTransactions(
  db: import("bun:sqlite").Database,
  account: string,
  from?: string,
  to?: string,
): Transaction[] {
  const where = ["l.account = ?"];
  const params: string[] = [account];
  if (from !== undefined) {
    where.push("e.date >= ?");
    params.push(assertIsoDate(from, "from"));
  }
  if (to !== undefined) {
    where.push("e.date <= ?");
    params.push(assertIsoDate(to, "to"));
  }
  const rows = db
    .query(
      `SELECT e.entry_id, e.date, e.memo, e.reference, l.idx, l.base_debit_minor, l.base_credit_minor, l.line_memo
       FROM lines l JOIN entries e ON e.seq = l.entry_seq
       WHERE ${where.join(" AND ")} ORDER BY e.seq ASC, l.idx ASC LIMIT ${RECONCILE_LIMITS.rowsPerSide + 1}`,
    )
    .all(...params) as Array<{
    entry_id: string;
    date: string;
    memo: string;
    reference: string;
    idx: number;
    base_debit_minor: string;
    base_credit_minor: string;
    line_memo: string | null;
  }>;
  if (rows.length > RECONCILE_LIMITS.rowsPerSide) {
    throw new LedgerError(
      `account ${account} has more than ${RECONCILE_LIMITS.rowsPerSide} lines in this range — narrow it with from/to`,
    );
  }
  return rows.map((row) => {
    const amount = BigInt(row.base_debit_minor) - BigInt(row.base_credit_minor);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LedgerError(
        `entry ${row.entry_id} line ${row.idx} is larger than a safe integer, so it cannot be expressed in the statement row shape`,
      );
    }
    return {
      id: `${row.entry_id}:${row.idx}`,
      date: row.date,
      description: row.line_memo ?? row.memo,
      amountMinor: Number(amount),
      direction: amount < 0n ? ("debit" as const) : ("credit" as const),
      reference: row.reference,
      balanceMinor: null,
    };
  });
}

export const ledgerReconcile: RegisteredTool = buildTool({
  name: "LedgerReconcile",
  description:
    "Match two sets of transactions — a parsed statement, a ledger account, or rows handed in — and report matched, unmatched on each side, and near misses SEPARATELY. Use it instead of an in-context comparison that stops being possible past a few dozen rows. A tolerance here does NOT widen matching: a 100.00 and a 100.01 are reported as a near miss for a person to look at, never silently paired, because pairing them destroys the only evidence that something is wrong. Bundled payouts are found by a bounded subset-sum with a canonical choice, so reruns return the same grouping. Rows use StatementParse's shape. It opens no socket and posts nothing — proposed entries come back for the caller to pass to LedgerPost.",
  inputSchema: z
    .object({
      left: sideSchema,
      right: sideSchema,
      dbPath: dbPathField,
      currency: currencyField.optional().describe("for rendering amounts; default USD"),
      exponent: exponentField,
      toleranceMinor: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000_000)
        .optional()
        .describe("near-miss radius in minor units; it does NOT widen matching. Default 0 (off)"),
      windowDays: z
        .number()
        .int()
        .nonnegative()
        .max(365)
        .optional()
        .describe("date window; default 3"),
      allowManyToOne: z
        .boolean()
        .optional()
        .describe("look for bundles that sum to one row; default true"),
      maxSubsetSize: z
        .number()
        .int()
        .min(2)
        .max(RECONCILE_LIMITS.maxSubsetSize)
        .optional()
        .describe("largest bundle considered; default 6"),
      feeToleranceMinor: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional()
        .describe("largest residue a bundle may carry as a withheld fee; default 0 (off)"),
      requireReferenceMatch: z
        .boolean()
        .optional()
        .describe("stop after the reference pass; everything else is reported unmatched"),
      propose: z
        .object({
          bankAccount: z.string().min(1).max(128),
          feeAccount: z.string().min(1).max(128),
          suspenseAccount: z.string().min(1).max(128),
        })
        .strict()
        .optional()
        .describe("account codes for draft entries; they are returned, never posted"),
      busyTimeoutMs: busyTimeoutField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const currency = (input.currency ?? "USD").toUpperCase();
    const result = reconcile(
      loadSide(input.left, "left", input),
      loadSide(input.right, "right", input),
      {
        toleranceMinor: BigInt(input.toleranceMinor ?? 0),
        windowDays: input.windowDays ?? 3,
        allowManyToOne: input.allowManyToOne !== false,
        maxSubsetSize: input.maxSubsetSize ?? 6,
        maxCombinations: RECONCILE_LIMITS.maxCombinations,
        feeToleranceMinor: BigInt(input.feeToleranceMinor ?? 0),
        requireReferenceMatch: input.requireReferenceMatch === true,
        exponent: exponentFor(currency, input.exponent),
        currency,
        propose: input.propose,
      },
    );
    return json(result);
  },
});

// ---------------------------------------------------------------------------
// InvoiceRender
// ---------------------------------------------------------------------------

const partySchema = z
  .object({
    name: z.string().min(1).max(256),
    address: z.array(z.string().max(256)).max(12).optional(),
    taxId: z.string().max(64).optional().describe("VAT/GST registration, not a credential"),
    email: z.string().max(256).optional(),
    phone: z.string().max(64).optional(),
  })
  .strict();

export const invoiceRender: RegisteredTool = buildTool({
  name: "InvoiceRender",
  operativeArgs: [
    { field: "dbPath", kind: "path", default: DEFAULT_DB_PATH },
    { field: "outDir", kind: "path" },
  ],
  description:
    "Render an invoice, receipt, credit note or quote to HTML, Markdown and JSON with a gap-free document number and totals computed rather than supplied. Use it instead of a model emitting invoice HTML: the number and the document record are allocated in ONE transaction, so a crash cannot burn a number out of a legally required sequence, and repeating the call with the same idempotency key returns the same number and the same bytes. Nothing is formatted through Intl, so the output does not move with an ICU upgrade; the yearly reset takes its year from the issue date, not the clock. Files are written under the workspace. It submits nothing and asks for no payment credentials.",
  inputSchema: z
    .object({
      dbPath: dbPathField,
      kind: z.enum(DOCUMENT_KINDS),
      idempotencyKey: z
        .string()
        .min(1)
        .max(200)
        .describe("repeating it returns the same number and re-renders the same bytes"),
      seller: partySchema,
      buyer: partySchema,
      lines: z
        .array(
          z
            .object({
              description: z.string().min(1).max(2_000),
              quantity: z.string().max(32).optional().describe("exact decimal string; default '1'"),
              unitAmount: z
                .string()
                .min(1)
                .max(64)
                .optional()
                .describe("major units, e.g. '125.00'"),
              unitAmountMinor: amountField.optional(),
              discount: z.string().min(1).max(64).optional(),
              discountMinor: amountField.optional(),
              taxRateBps: z
                .number()
                .int()
                .nonnegative()
                .max(100_000)
                .optional()
                .describe("2000 is 20%"),
              taxMinor: amountField
                .optional()
                .describe("from TaxCalculate, for anything beyond a flat rate"),
            })
            .strict(),
        )
        .min(1)
        .max(1_000),
      currency: currencyField,
      exponent: exponentField,
      issueDate: isoDate,
      dueDate: isoDate.optional(),
      reference: z.string().max(256).optional(),
      notes: z.string().max(8_000).optional(),
      paymentInstructions: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "free text the operator wrote; this tool never asks for account details of its own",
        ),
      number: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("an externally assigned number; omit to take the next one from the sequence"),
      numbering: z
        .object({
          prefix: z.string().max(32).optional().describe("default 'INV-'"),
          pad: z.number().int().min(1).max(12).optional().describe("default 5"),
          resetYearly: z.boolean().optional().describe("the year comes from issueDate"),
          start: z.number().int().nonnegative().max(1_000_000_000).optional().describe("default 1"),
        })
        .strict()
        .optional(),
      template: z
        .string()
        .max(256 * 1024)
        .optional()
        .describe("inline logic-less template"),
      templateFile: z
        .string()
        .min(1)
        .max(1_024)
        .optional()
        .describe("workspace-relative template file"),
      strictTemplate: z
        .boolean()
        .optional()
        .describe("refuse an unknown placeholder instead of rendering a blank; default true"),
      numberFormat: z
        .object({
          decimalSeparator: z.string().max(4).optional(),
          groupSeparator: z.string().max(4).optional(),
        })
        .strict()
        .optional(),
      outputs: z.array(z.enum(OUTPUT_FORMATS)).min(1).max(3),
      outDir: z
        .string()
        .min(1)
        .max(1_024)
        .optional()
        .describe("workspace-relative directory for the files; omit to return the text only"),
      createdAt: z.string().max(64).optional().describe("ISO-8601 with a UTC offset"),
      busyTimeoutMs: busyTimeoutField,
    })
    .strict(),
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    validateInvoiceDates(input.issueDate, input.dueDate);
    const currency = input.currency.toUpperCase();
    const exponent = exponentFor(currency, input.exponent);
    if (input.template !== undefined && input.templateFile !== undefined) {
      throw new LedgerError("give template or templateFile, not both");
    }
    const computed = computeInvoice(input.lines, exponent);
    const numbering = {
      prefix: input.numbering?.prefix ?? "INV-",
      pad: input.numbering?.pad ?? 5,
      resetYearly: input.numbering?.resetYearly === true,
      start: input.numbering?.start ?? 1,
    };
    // The number names a FILE. `outDir` is resolved through the workspace
    // resolver below, but the leaf under it is `${number}.${format}`, and the
    // number is the caller's — directly as `number`, or through
    // `numbering.prefix`. Both are checked HERE, before the sequence is
    // touched, so a number that would walk out of the directory is a refusal
    // rather than a burnt number and an overwritten file somewhere else.
    if (input.number !== undefined) {
      assertNumberIsAFileName(input.number, "number");
    } else {
      // The ordinal contributes only digits, so checking the number this
      // sequence would issue next checks the prefix and the year with it.
      assertNumberIsAFileName(
        numberFor(numbering, input.issueDate, numbering.start),
        "the number numbering.prefix would produce",
      );
    }
    const custom =
      input.templateFile === undefined
        ? input.template
        : readTextFile(resolveSafe("InvoiceRender", input.templateFile).real);

    // The hash covers everything that determines the rendered bytes, so a
    // replay under the same key can be checked for being the same document —
    // and a re-render after a crash produces byte-identical files.
    const payloadHash = sha256Hex(
      canonicalJson({
        kind: input.kind,
        seller: input.seller,
        buyer: input.buyer,
        lines: input.lines,
        currency,
        exponent,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? null,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        paymentInstructions: input.paymentInstructions ?? null,
        numbering,
        template: custom ?? null,
        numberFormat: input.numberFormat ?? null,
        outputs: [...input.outputs].sort(),
        explicitNumber: input.number ?? null,
      }),
    );

    const createdAt =
      input.createdAt === undefined ? nowIso() : assertInstant(input.createdAt, "createdAt");

    // Render ONCE against a provisional number, before the sequence is
    // touched. Rendering is where a bad template or a missing field is found,
    // and a number allocated and then thrown away is a gap in a sequence that
    // is legally required not to have one. Rendering is a pure function of the
    // payload, so proving it first and doing it again costs only time.
    const render = (
      number: string,
    ): { outputs: Record<string, string>; totals: Record<string, string> } => {
      const model = documentModel({
        kind: input.kind as DocumentKind,
        number,
        currency,
        exponent,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        reference: input.reference,
        notes: input.notes,
        paymentInstructions: input.paymentInstructions,
        seller: input.seller,
        buyer: input.buyer,
        computed,
        numberFormat: input.numberFormat ?? {},
      });
      const out: Record<string, string> = {};
      for (const format of [...input.outputs].sort()) {
        if (format === "json") {
          out["json"] = JSON.stringify(model, null, 2);
          continue;
        }
        const template = custom ?? BUILTIN_TEMPLATES[format];
        out[format] = renderTemplate(template, model, {
          // Markdown escapes a pipe for the same reason HTML escapes a "<":
          // an unescaped one ends the table cell early and every amount after
          // it lands under the wrong heading. See ./lib/invoice.
          escape: format === "html" ? escapeHtml : escapeMarkdown,
          strict: input.strictTemplate !== false,
        });
      }
      return { outputs: out, totals: model["totals"] as Record<string, string> };
    };
    render("PENDING");

    // The destination is checked before the sequence is touched too, for the
    // same reason: a path that escapes the workspace must not cost a number.
    const outDir = input.outDir === undefined ? null : resolveSafe("InvoiceRender", input.outDir);

    const opened = open(
      "InvoiceRender",
      { dbPath: input.dbPath, busyTimeoutMs: input.busyTimeoutMs },
      "write",
      false,
    );
    let allocation: {
      number: string;
      ordinal: number;
      sequenceName: string;
      replayed: boolean;
      /** `null` when there is no sequence to check — see ./lib/invoice. */
      gapFree: boolean | null;
    };
    try {
      const plannedFiles =
        outDir === null ? [] : input.outputs.map((f) => `${outDir.rel}/${placeholderName(f)}`);
      allocation =
        input.number === undefined
          ? allocateDocument(opened.db, {
              kind: input.kind,
              config: numbering,
              issueDate: input.issueDate,
              idempotencyKey: input.idempotencyKey,
              payloadHash,
              files: plannedFiles,
              createdAt,
            })
          : recordExternalNumber(
              opened.db,
              input.number,
              input.kind,
              input.issueDate,
              input.idempotencyKey,
              payloadHash,
              createdAt,
            );
    } finally {
      opened.db.close();
    }

    const { outputs: rendered, totals } = render(allocation.number);

    const files: string[] = [];
    if (outDir !== null) {
      const dir = outDir;
      mkdirSync(dir.real, { recursive: true });
      for (const [format, text] of Object.entries(rendered).sort()) {
        const name = `${allocation.number}.${format === "markdown" ? "md" : format}`;
        // Belt and braces over the check above: the composed path goes back
        // through the workspace resolver, so containment is enforced by the
        // resolver every other path in this package uses and not only by the
        // character rule that produced this name.
        const target = resolveSafe("InvoiceRender", `${dir.rel}/${name}`).abs;
        // Written to a temporary name and renamed: a rename within one
        // directory is atomic, so a reader never sees half an invoice, and a
        // crash mid-write leaves the previous file rather than a truncated one.
        const temp = `${target}.${payloadHash.slice(0, 8)}.tmp`;
        mkdirSync(dirname(temp), { recursive: true });
        writeFileSync(temp, text, "utf-8");
        renameSync(temp, target);
        files.push(`${dir.rel}/${name}`);
      }
    }

    return json({
      ledger: opened.rel,
      number: allocation.number,
      ordinal: allocation.ordinal,
      sequence: allocation.sequenceName,
      replayed: allocation.replayed,
      // `null`, never `true`, when the number did not come from a sequence
      // this tool keeps: a gap is a finding, and a check that could not run
      // must not report as one that passed.
      gapFree: allocation.gapFree,
      ...(allocation.gapFree === null
        ? {
            gapFreeNote:
              "this number was assigned by the caller, so there is no sequence here to check for gaps — gap-freeness is the caller's to keep and this tool has NOT verified it",
          }
        : {}),
      currency,
      totals,
      files,
      ...(outDir === null ? rendered : {}),
      note: "rendered and numbered locally; nothing was sent and no payment was requested",
    });
  },
});

/** The name a file will get, before the number is known. Only its shape matters. */
function placeholderName(format: string): string {
  return `<number>.${format === "markdown" ? "md" : format}`;
}

/**
 * Record a number the caller assigned.
 *
 * Supported because some operators' numbers come from elsewhere, but recorded
 * all the same: the `documents` table's primary key is the number, so issuing
 * the same one twice is refused here rather than discovered by a tax
 * inspector. Gap-freeness is the caller's to keep in this mode, so `gapFree`
 * comes back `null` and the result says in words that nothing was checked —
 * `true` from a check that never ran is the answer that gets believed.
 */
function recordExternalNumber(
  db: import("bun:sqlite").Database,
  number: string,
  kind: string,
  issueDate: string,
  idempotencyKey: string,
  payloadHash: string,
  createdAt: string,
): {
  number: string;
  ordinal: number;
  sequenceName: string;
  replayed: boolean;
  gapFree: null;
} {
  return inImmediateTransaction(db, () => {
    const existing = db
      .query("SELECT number, payload_hash FROM documents WHERE idempotency_key = ?")
      .get(idempotencyKey) as { number: string; payload_hash: string } | null;
    if (existing !== null) {
      if (existing.payload_hash !== payloadHash) {
        throw new LedgerError(
          `idempotency key "${idempotencyKey}" already issued ${existing.number} for different content`,
        );
      }
      return {
        number: existing.number,
        ordinal: 0,
        sequenceName: "external",
        replayed: true,
        gapFree: null,
      };
    }
    const clash = db
      .query("SELECT idempotency_key FROM documents WHERE number = ?")
      .get(number) as {
      idempotency_key: string;
    } | null;
    if (clash !== null) {
      throw new LedgerError(
        `document number "${number}" has already been issued (under key "${clash.idempotency_key}") — one number, one document`,
      );
    }
    db.run(
      "INSERT INTO documents (number, kind, sequence_name, ordinal, issue_date, idempotency_key, payload_hash, files, created_at) VALUES (?, ?, 'external', 0, ?, ?, ?, '[]', ?)",
      [number, kind, issueDate, idempotencyKey, payloadHash, createdAt],
    );
    return { number, ordinal: 0, sequenceName: "external", replayed: false, gapFree: null };
  });
}

export { LedgerError };

/** Every tool this package registers, in the order a catalog should list them. */
export const LEDGER_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  invoiceRender,
  ledgerPost,
  ledgerQuery,
  ledgerReconcile,
]);

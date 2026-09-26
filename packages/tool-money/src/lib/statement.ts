/**
 * Normalize a bank, card or exchange export into one transaction list.
 *
 * Two things in this job corrupt ledgers quietly, and both are guessed at by
 * every convenient importer:
 *
 * - **Date order.** `03/04/2026` is 3 April in most of the world and 4 March
 *   in the United States. Nothing in the file says which, and a wrong guess
 *   moves transactions between months — so a file whose dates are ambiguous
 *   is REFUSED unless the caller states the order, rather than parsed into
 *   something that looks fine.
 * - **Sign.** Some exports use a signed amount, some a debit column and a
 *   credit column, and some a positive amount with a separate direction. Get
 *   it backwards and a reconciliation balances to exactly twice the error.
 *
 * Only what the file says is reported. No categorization, no counterparty
 * enrichment, no guessing at what a memo line means.
 */

import { InexactAmountError } from "./exact";

export const DATE_ORDERS = ["iso", "dmy", "mdy"] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

export const STATEMENT_FORMATS = ["csv", "ofx"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

export type Transaction = {
  /** The file's own id where it has one, otherwise a stable positional id. */
  readonly id: string;
  /** ISO-8601 date, always. */
  readonly date: string;
  readonly description: string;
  /** Minor units, negative for money leaving the account. */
  readonly amountMinor: number;
  readonly direction: "debit" | "credit";
  readonly reference: string;
  readonly balanceMinor: number | null;
};

export type ParseOptions = {
  readonly format?: StatementFormat;
  readonly dateOrder?: DateOrder;
  /** Decimal comma and dot-as-thousands, as much of Europe writes it. */
  readonly decimalComma?: boolean;
  /** Column names, when the header does not use recognizable ones. */
  readonly columns?: {
    readonly date?: string;
    readonly description?: string;
    readonly amount?: string;
    readonly debit?: string;
    readonly credit?: string;
    readonly balance?: string;
    readonly reference?: string;
  };
  /** Currency's minor-unit exponent. 2 for most, 0 for JPY. */
  readonly decimals?: number;
  /**
   * How many transactions and how many rejected rows to hold. The file is
   * read to the end either way — `count`, `rejectedCount` and the totals
   * cover every row — but the lists stop growing, so a caller that shows the
   * first few hundred rows does not hold a million in memory first. Default:
   * all of them.
   */
  readonly keep?: { readonly transactions?: number; readonly rejected?: number };
};

export type ParseResult = {
  readonly format: StatementFormat;
  /** The transactions read, in file order — the first `keep.transactions` of them. */
  readonly transactions: ReadonlyArray<Transaction>;
  /** Every transaction read, held or not. */
  readonly count: number;
  /**
   * The sums of every transaction read, exact, or null when one comes to more
   * than a JSON number holds exactly — `totalsUnavailable` then says which.
   */
  readonly totalMinor: number | null;
  readonly debitMinor: number | null;
  readonly creditMinor: number | null;
  readonly totalsUnavailable: string | null;
  readonly dateOrder: DateOrder;
  /** Rows the file contained that could not be read, with the reason — the first `keep.rejected`. */
  readonly rejected: ReadonlyArray<{ readonly row: number; readonly reason: string }>;
  /** Every row that could not be read, held or not. */
  readonly rejectedCount: number;
};

/** RFC 4180 fields: quotes, doubled quotes inside them, embedded newlines. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** The most digits a safe integer has: 2^53 − 1 is 9,007,199,254,740,991. */
const SAFE_DIGITS = 16;

/**
 * Parse a money string to minor units, exactly, without floating point.
 *
 * Returns null for text that is not an amount. An amount past 2^53 − 1 minor
 * units is refused with an {@link InexactAmountError}: a JSON number past
 * that has already been rounded, and 90,071,992,547,409.93 read as
 * 9007199254740992 cents is a figure one cent out that nothing flags.
 */
export function parseMoneyMinor(
  raw: string,
  decimals: number,
  decimalComma: boolean,
): number | null {
  let text = raw.trim();
  if (text === "") return null;
  let negative = false;
  // Accounting negatives are parenthesised, and a trailing sign is common.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1);
  }
  text = text.replace(/[^\d.,+-]/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) text = text.slice(1);

  const groupSeparator = decimalComma ? "." : ",";
  const decimalSeparator = decimalComma ? "," : ".";
  text = text.split(groupSeparator).join("");
  const parts = text.split(decimalSeparator);
  if (parts.length > 2) return null;
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (whole === "" && fraction === "") return null;
  // Pad or truncate to the currency's exponent rather than rounding a float.
  const scaled = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`;
  const digits = scaled.replace(/^0+/, "");
  // Counted before it is converted: past sixteen digits it cannot fit, and a
  // megabyte of digits is not worth a bigint to find that out.
  if (
    digits.length > SAFE_DIGITS ||
    (digits.length === SAFE_DIGITS && BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    const shown = raw.trim().length > 40 ? `${raw.trim().slice(0, 40)}…` : raw.trim();
    throw new InexactAmountError(
      `"${shown}" is more than 2^53 − 1 (9007199254740991) minor units, the largest amount this reads exactly, so it is left out rather than rounded`,
    );
  }
  const value = digits === "" ? 0 : Number(digits);
  return negative ? -value : value;
}

/**
 * Parse a date, refusing what cannot be read unambiguously.
 *
 * Returns null rather than a guess. The caller turns that into a rejected
 * row with a reason, which is recoverable; a silently wrong month is not.
 */
export function parseDate(raw: string, order: DateOrder): string | null {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // OFX and several exports use YYYYMMDD, optionally with a time after it.
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (slashed) {
    if (order === "iso") return null;
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    let year = Number(slashed[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    const day = order === "dmy" ? first : second;
    const month = order === "dmy" ? second : first;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

/** True when every slashed date in the file reads the same either way. */
export function datesAreUnambiguous(values: ReadonlyArray<string>): boolean {
  for (const value of values) {
    const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(value.trim());
    if (!slashed) continue;
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    // Both readable as a month means the file cannot settle the question.
    if (first <= 12 && second <= 12 && first !== second) return false;
  }
  return true;
}

const COLUMN_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  date: ["date", "transaction date", "posted date", "posting date", "value date", "booking date"],
  description: ["description", "details", "narrative", "memo", "payee", "name", "reference text"],
  amount: ["amount", "value", "transaction amount"],
  debit: ["debit", "withdrawal", "withdrawals", "money out", "paid out", "charge"],
  credit: ["credit", "deposit", "deposits", "money in", "paid in"],
  balance: ["balance", "running balance", "closing balance"],
  reference: ["reference", "ref", "transaction id", "id", "cheque number"],
};

function findColumn(headers: string[], role: string, override?: string): number {
  if (override !== undefined) {
    const at = headers.findIndex((h) => h.toLowerCase() === override.toLowerCase());
    if (at === -1) throw new Error(`the file has no column named "${override}"`);
    return at;
  }
  const aliases = COLUMN_ALIASES[role] ?? [];
  return headers.findIndex((h) => aliases.includes(h.trim().toLowerCase()));
}

/**
 * The `<STMTTRN>` blocks of an OFX file, in one forward pass over its tags.
 *
 * OFX 1.x is SGML, where an end tag may be left out, so a block that is
 * never closed ends where the next one starts, at the transaction list's
 * own tags, or at the end of the file — and is read like any other rather
 * than dropped. (A lazy `<STMTTRN>…</STMTTRN>` match instead rescanned to
 * the end of the file from every unclosed tag, which was quadratic, and
 * swallowed the next transaction into an unclosed one.) A stray end tag is
 * ignored.
 */
export function* ofxTransactionBlocks(text: string): Generator<string> {
  const tag = /<(\/?)(STMTTRN|BANKTRANLIST)>/gi;
  let open = -1;
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const closing = m[1] === "/";
    const isTransaction = (m[2] as string).toUpperCase() === "STMTTRN";
    // Its own end tag closes a block; any other boundary ends it unclosed.
    if (open !== -1) yield text.slice(open, m.index);
    open = -1;
    if (!closing && isTransaction) open = m.index;
  }
  if (open !== -1) yield text.slice(open);
}

/** One OFX element's value, e.g. `<TRNAMT>-12.50`. Built once per tag, not once per block. */
const OFX_FIELDS: Readonly<Record<string, RegExp>> = Object.fromEntries(
  ["DTPOSTED", "TRNAMT", "NAME", "MEMO", "FITID", "CHECKNUM", "REFNUM"].map((tag) => [
    tag,
    new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"),
  ]),
);

/**
 * Where a parse keeps what it has read: the lists up to what the caller will
 * show, the counts and the exact totals for every row.
 */
class StatementTally {
  readonly transactions: Transaction[] = [];
  readonly rejected: Array<{ row: number; reason: string }> = [];
  count = 0;
  rejectedCount = 0;
  private total = 0n;
  private debit = 0n;
  private credit = 0n;

  constructor(
    private readonly keepTransactions: number,
    private readonly keepRejected: number,
  ) {}

  add(transaction: Transaction): void {
    this.count++;
    const amount = BigInt(transaction.amountMinor);
    this.total += amount;
    if (transaction.direction === "debit") this.debit += amount;
    else this.credit += amount;
    if (this.transactions.length < this.keepTransactions) this.transactions.push(transaction);
  }

  reject(row: number, reason: string): void {
    this.rejectedCount++;
    if (this.rejected.length < this.keepRejected) this.rejected.push({ row, reason });
  }

  result(format: StatementFormat, dateOrder: DateOrder): ParseResult {
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    const sums = [
      ["total", this.total],
      ["debit total", this.debit],
      ["credit total", this.credit],
    ] as const;
    // Each total is reported when it fits, and left out, by name, when not.
    const over = sums.filter(([, v]) => v > limit || v < -limit);
    const fit = (v: bigint): number | null => (v > limit || v < -limit ? null : Number(v));
    return {
      format,
      transactions: this.transactions,
      count: this.count,
      totalMinor: fit(this.total),
      debitMinor: fit(this.debit),
      creditMinor: fit(this.credit),
      totalsUnavailable:
        over.length === 0
          ? null
          : `the statement's ${over.map(([name, v]) => `${name} comes to ${v}`).join(" and its ")} minor units, past ±2^53 − 1 (9007199254740991), so ${over.length === 1 ? "it is" : "they are"} left out rather than rounded; every transaction's own amount is exact`,
      dateOrder,
      rejected: this.rejected,
      rejectedCount: this.rejectedCount,
    };
  }
}

/** A money column read for one row: the amount, or why the row is refused. */
function readMoney(
  raw: string,
  column: string,
  decimals: number,
  decimalComma: boolean,
): { readonly value: number | null } | { readonly refused: string } {
  try {
    return { value: parseMoneyMinor(raw, decimals, decimalComma) };
  } catch (err) {
    if (err instanceof InexactAmountError) return { refused: `the ${column} ${err.message}` };
    throw err;
  }
}

export function parseStatement(text: string, options: ParseOptions = {}): ParseResult {
  const format: StatementFormat = options.format ?? (/<OFX>|<STMTTRN>/i.test(text) ? "ofx" : "csv");
  const decimals = options.decimals ?? 2;
  const decimalComma = options.decimalComma === true;
  const tally = new StatementTally(
    options.keep?.transactions ?? Number.POSITIVE_INFINITY,
    options.keep?.rejected ?? Number.POSITIVE_INFINITY,
  );

  if (format === "ofx") {
    // OFX is SGML with optional closing tags; the transaction blocks are all
    // that matters here and they are regular enough to read directly.
    const field = (block: string, tag: string): string =>
      ((OFX_FIELDS[tag] as RegExp).exec(block)?.[1] ?? "").trim();
    let i = -1;
    for (const block of ofxTransactionBlocks(text)) {
      i++;
      const date = parseDate(field(block, "DTPOSTED"), "iso");
      const amount = readMoney(field(block, "TRNAMT"), "amount", decimals, false);
      if ("refused" in amount) {
        tally.reject(i + 1, amount.refused);
        continue;
      }
      if (date === null || amount.value === null) {
        tally.reject(i + 1, "the transaction has no readable date or amount");
        continue;
      }
      const amountMinor = amount.value;
      const name = field(block, "NAME") || field(block, "MEMO");
      tally.add({
        id: field(block, "FITID") || `ofx-${i + 1}`,
        date,
        description: name,
        amountMinor,
        direction: amountMinor < 0 ? "debit" : "credit",
        reference: field(block, "CHECKNUM") || field(block, "REFNUM"),
        balanceMinor: null,
      });
    }
    return tally.result(format, "iso");
  }

  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new Error("the CSV has no data rows under its header");
  }
  const headers = (rows[0] as string[]).map((h) => h.trim());
  const at = {
    date: findColumn(headers, "date", options.columns?.date),
    description: findColumn(headers, "description", options.columns?.description),
    amount: findColumn(headers, "amount", options.columns?.amount),
    debit: findColumn(headers, "debit", options.columns?.debit),
    credit: findColumn(headers, "credit", options.columns?.credit),
    balance: findColumn(headers, "balance", options.columns?.balance),
    reference: findColumn(headers, "reference", options.columns?.reference),
  };
  if (at.date === -1) {
    throw new Error(`no date column found; the header is: ${headers.join(", ")}`);
  }
  if (at.amount === -1 && at.debit === -1 && at.credit === -1) {
    throw new Error(
      `no amount, debit or credit column found; the header is: ${headers.join(", ")}`,
    );
  }

  const body = rows.slice(1);
  const rawDates = body.map((r) => r[at.date] ?? "");
  let order = options.dateOrder;
  if (order === undefined) {
    if (!datesAreUnambiguous(rawDates)) {
      throw new Error(
        "the dates in this file could be day-first or month-first and the file does not say which; pass dateOrder explicitly rather than have the months guessed at",
      );
    }
    order = rawDates.some((d) => /^\d{1,2}[/.-]/.test(d.trim())) ? "dmy" : "iso";
  }

  const money = (row: string[], column: number, name: string) =>
    column === -1 ? { value: null } : readMoney(row[column] ?? "", name, decimals, decimalComma);

  for (const [i, row] of body.entries()) {
    const date = parseDate(row[at.date] ?? "", order);
    if (date === null) {
      tally.reject(i + 2, `"${row[at.date] ?? ""}" is not a date this can read`);
      continue;
    }
    const amount = money(row, at.amount, "amount");
    const debit = money(row, at.debit, "debit");
    const credit = money(row, at.credit, "credit");
    const balance = money(row, at.balance, "balance");
    const refusal = [amount, debit, credit, balance].find((m) => "refused" in m);
    if (refusal !== undefined && "refused" in refusal) {
      tally.reject(i + 2, refusal.refused);
      continue;
    }
    let amountMinor = "value" in amount ? amount.value : null;
    if (amountMinor === null) {
      const out = "value" in debit ? debit.value : null;
      const into = "value" in credit ? credit.value : null;
      // A debit column holds a positive number meaning money out, so the
      // sign has to be applied rather than read.
      if (out !== null && out !== 0) amountMinor = -Math.abs(out);
      else if (into !== null && into !== 0) amountMinor = Math.abs(into);
    }
    if (amountMinor === null) {
      tally.reject(i + 2, "no readable amount in this row");
      continue;
    }
    tally.add({
      id: (at.reference !== -1 ? row[at.reference] : "") || `row-${i + 2}`,
      date,
      description: (at.description === -1 ? "" : (row[at.description] ?? "")).trim(),
      amountMinor,
      direction: amountMinor < 0 ? "debit" : "credit",
      reference: at.reference === -1 ? "" : (row[at.reference] ?? "").trim(),
      balanceMinor: "value" in balance ? balance.value : null,
    });
  }
  return tally.result(format, order);
}

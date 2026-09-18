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
};

export type ParseResult = {
  readonly format: StatementFormat;
  readonly transactions: ReadonlyArray<Transaction>;
  readonly count: number;
  readonly totalMinor: number;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly dateOrder: DateOrder;
  /** Rows the file contained that could not be read, with the reason. */
  readonly rejected: ReadonlyArray<{ readonly row: number; readonly reason: string }>;
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

/** Parse a money string to minor units, exactly, without floating point. */
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
  const value = Number.parseInt(scaled === "" ? "0" : scaled, 10);
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

export function parseStatement(text: string, options: ParseOptions = {}): ParseResult {
  const format: StatementFormat = options.format ?? (/<OFX>|<STMTTRN>/i.test(text) ? "ofx" : "csv");
  const decimals = options.decimals ?? 2;
  const decimalComma = options.decimalComma === true;
  const rejected: Array<{ row: number; reason: string }> = [];
  const transactions: Transaction[] = [];

  if (format === "ofx") {
    // OFX is SGML with optional closing tags; the transaction blocks are all
    // that matters here and they are regular enough to read directly.
    const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
    const field = (block: string, tag: string): string => {
      const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
      return (m?.[1] ?? "").trim();
    };
    for (const [i, block] of blocks.entries()) {
      const date = parseDate(field(block, "DTPOSTED"), "iso");
      const amount = parseMoneyMinor(field(block, "TRNAMT"), decimals, false);
      if (date === null || amount === null) {
        rejected.push({ row: i + 1, reason: "the transaction has no readable date or amount" });
        continue;
      }
      const name = field(block, "NAME") || field(block, "MEMO");
      transactions.push({
        id: field(block, "FITID") || `ofx-${i + 1}`,
        date,
        description: name,
        amountMinor: amount,
        direction: amount < 0 ? "debit" : "credit",
        reference: field(block, "CHECKNUM") || field(block, "REFNUM"),
        balanceMinor: null,
      });
    }
  } else {
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

    for (const [i, row] of body.entries()) {
      const date = parseDate(row[at.date] ?? "", order);
      if (date === null) {
        rejected.push({
          row: i + 2,
          reason: `"${row[at.date] ?? ""}" is not a date this can read`,
        });
        continue;
      }
      let amountMinor: number | null = null;
      if (at.amount !== -1) {
        amountMinor = parseMoneyMinor(row[at.amount] ?? "", decimals, decimalComma);
      }
      if (amountMinor === null && (at.debit !== -1 || at.credit !== -1)) {
        const debit =
          at.debit === -1 ? null : parseMoneyMinor(row[at.debit] ?? "", decimals, decimalComma);
        const credit =
          at.credit === -1 ? null : parseMoneyMinor(row[at.credit] ?? "", decimals, decimalComma);
        // A debit column holds a positive number meaning money out, so the
        // sign has to be applied rather than read.
        if (debit !== null && debit !== 0) amountMinor = -Math.abs(debit);
        else if (credit !== null && credit !== 0) amountMinor = Math.abs(credit);
      }
      if (amountMinor === null) {
        rejected.push({ row: i + 2, reason: "no readable amount in this row" });
        continue;
      }
      transactions.push({
        id: (at.reference !== -1 ? row[at.reference] : "") || `row-${i + 2}`,
        date,
        description: (at.description === -1 ? "" : (row[at.description] ?? "")).trim(),
        amountMinor,
        direction: amountMinor < 0 ? "debit" : "credit",
        reference: at.reference === -1 ? "" : (row[at.reference] ?? "").trim(),
        balanceMinor:
          at.balance === -1 ? null : parseMoneyMinor(row[at.balance] ?? "", decimals, decimalComma),
      });
    }
    return {
      format,
      transactions,
      count: transactions.length,
      totalMinor: transactions.reduce((s, t) => s + t.amountMinor, 0),
      debitMinor: transactions
        .filter((t) => t.direction === "debit")
        .reduce((s, t) => s + t.amountMinor, 0),
      creditMinor: transactions
        .filter((t) => t.direction === "credit")
        .reduce((s, t) => s + t.amountMinor, 0),
      dateOrder: order,
      rejected,
    };
  }

  return {
    format,
    transactions,
    count: transactions.length,
    totalMinor: transactions.reduce((s, t) => s + t.amountMinor, 0),
    debitMinor: transactions
      .filter((t) => t.direction === "debit")
      .reduce((s, t) => s + t.amountMinor, 0),
    creditMinor: transactions
      .filter((t) => t.direction === "credit")
      .reduce((s, t) => s + t.amountMinor, 0),
    dateOrder: "iso",
    rejected,
  };
}

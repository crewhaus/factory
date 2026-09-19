/**
 * The reports. One selection, then aggregation in JavaScript.
 *
 * Two decisions here differ from the obvious one, and both are about SQLite
 * rather than about accounting:
 *
 * - **Totals are summed in bigint, not in `SUM()`.** Amounts are stored as
 *   TEXT (see `./db`), so `SUM()` would coerce them through a float, and even
 *   over INTEGER columns SQLite promotes a 64-bit overflow to a float without
 *   saying so. A trial balance that is off by a fraction of a cent is a
 *   trial balance nobody can sign.
 * - **Signs come from the chart of accounts, never from the query.** Whether a
 *   balance is "positive" depends on the account's normal side, which is a
 *   property of the account. A report that decides it from the account's name,
 *   or from the sign of the number it just computed, is wrong the first time
 *   somebody books a contra account.
 *
 * Every view that can return an unbounded number of rows takes a limit and
 * says `truncated` when it hit it, and the scan itself is capped: a question
 * that would pull the whole ledger into memory is refused with the range to
 * narrow, not answered slowly.
 */
import type { Database } from "bun:sqlite";
import { LedgerError, byString, dayDiff, epochDay, formatMajor } from "./amount";
import {
  type AccountType,
  type ChainVerification,
  type EntryRow,
  type LineRow,
  NORMAL_BALANCE,
  verifyChain,
} from "./db";
import { entryPayload } from "./post";

export const VIEWS = [
  "trial_balance",
  "balance",
  "account_ledger",
  "journal",
  "pnl",
  "balance_sheet",
  "aging",
  "search",
  "chain",
] as const;
export type View = (typeof VIEWS)[number];

export const FORMATS = ["json", "csv", "markdown"] as const;
export type Format = (typeof FORMATS)[number];

/** Lines one call will pull out of SQLite before it refuses to continue. */
export const MAX_SCAN_ROWS = 200_000;

export type QueryFilter = {
  readonly accounts?: ReadonlyArray<string>;
  readonly from?: string;
  readonly to?: string;
  readonly tag?: string;
  readonly reference?: string;
  readonly sourceSystem?: string;
  readonly counterparty?: string;
  readonly text?: string;
  readonly amountMinMinor?: string;
  readonly amountMaxMinor?: string;
};

type JoinedRow = LineRow & {
  readonly seq: number;
  readonly entry_id: string;
  readonly date: string;
  readonly memo: string;
  readonly reference: string;
  readonly tags: string;
  readonly source_system: string | null;
  readonly source_id: string | null;
};

function selectLines(db: Database, filter: QueryFilter): JoinedRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.from !== undefined) {
    where.push("e.date >= ?");
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("e.date <= ?");
    params.push(filter.to);
  }
  if (filter.accounts !== undefined && filter.accounts.length > 0) {
    where.push(`l.account IN (${filter.accounts.map(() => "?").join(", ")})`);
    params.push(...filter.accounts);
  }
  if (filter.reference !== undefined) {
    where.push("e.reference = ?");
    params.push(filter.reference);
  }
  if (filter.sourceSystem !== undefined) {
    where.push("e.source_system = ?");
    params.push(filter.sourceSystem);
  }
  if (filter.counterparty !== undefined) {
    where.push("l.counterparty = ?");
    params.push(filter.counterparty);
  }
  const sql = `SELECT l.*, e.seq, e.entry_id, e.date, e.memo, e.reference, e.tags, e.source_system, e.source_id
    FROM lines l JOIN entries e ON e.seq = l.entry_seq
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY e.seq ASC, l.idx ASC
    LIMIT ${MAX_SCAN_ROWS + 1}`;
  const rows = db.query(sql).all(...params) as JoinedRow[];
  if (rows.length > MAX_SCAN_ROWS) {
    throw new LedgerError(
      `this question selects more than ${MAX_SCAN_ROWS} lines — narrow it with from/to or accounts; answering it would mean holding the whole ledger in memory and returning a number nobody can check`,
    );
  }
  // The remaining predicates are applied here rather than in SQL: `tag` lives
  // inside a JSON array, `text` is a case-insensitive scan, and the amount
  // bounds compare bigints that SQLite would compare as text ("9" > "10").
  return rows.filter((row) => {
    if (filter.tag !== undefined) {
      const tags = JSON.parse(row.tags) as string[];
      if (!tags.includes(filter.tag)) return false;
    }
    if (filter.text !== undefined) {
      const needle = filter.text.toLowerCase();
      const hay =
        `${row.memo} ${row.reference} ${row.line_memo ?? ""} ${row.account}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (filter.amountMinMinor !== undefined || filter.amountMaxMinor !== undefined) {
      const magnitude = absolute(BigInt(row.base_debit_minor) - BigInt(row.base_credit_minor));
      if (filter.amountMinMinor !== undefined && magnitude < BigInt(filter.amountMinMinor)) {
        return false;
      }
      if (filter.amountMaxMinor !== undefined && magnitude > BigInt(filter.amountMaxMinor)) {
        return false;
      }
    }
    return true;
  });
}

const absolute = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Whether the selection can have split an entry across the filter boundary.
 *
 * `balanced` is only a statement about the books when the rows selected are
 * WHOLE entries. Filtering by date, tag, reference or source keeps or drops an
 * entry entirely, so the debits and credits still pair up; filtering by
 * account, counterparty, text or amount keeps one leg and drops the other, and
 * a trial balance over half an entry is unbalanced by construction. Reporting
 * `false` there says "somebody edited the file" about a caller who typed a
 * filter, which is worse than saying nothing.
 */
function selectionSplitsEntries(filter: QueryFilter): boolean {
  return (
    (filter.accounts !== undefined && filter.accounts.length > 0) ||
    filter.counterparty !== undefined ||
    filter.text !== undefined ||
    filter.amountMinMinor !== undefined ||
    filter.amountMaxMinor !== undefined
  );
}

function accountTypes(db: Database): Map<string, AccountType> {
  const rows = db.query("SELECT code, type FROM accounts").all() as Array<{
    code: string;
    type: AccountType;
  }>;
  return new Map(rows.map((r) => [r.code, r.type]));
}

type Totals = { debit: bigint; credit: bigint };

function totalsByAccount(rows: ReadonlyArray<JoinedRow>): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const row of rows) {
    const bucket = out.get(row.account) ?? { debit: 0n, credit: 0n };
    bucket.debit += BigInt(row.base_debit_minor);
    bucket.credit += BigInt(row.base_credit_minor);
    out.set(row.account, bucket);
  }
  return out;
}

/** The balance on the account's own normal side, which is the one a reader expects. */
function signedBalance(type: AccountType | undefined, totals: Totals): bigint {
  const normal = type === undefined ? "debit" : NORMAL_BALANCE[type];
  return normal === "debit" ? totals.debit - totals.credit : totals.credit - totals.debit;
}

export type QueryResult = {
  readonly view: View;
  readonly rows: ReadonlyArray<Record<string, string | number | null>>;
  readonly totals: Record<string, string | number | boolean | null>;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly notes?: ReadonlyArray<string>;
  readonly chain?: ChainVerification;
};

export type QueryOptions = {
  readonly view: View;
  readonly filter: QueryFilter;
  readonly baseCurrency: string;
  readonly baseExponent: number;
  readonly limit: number;
  /** Required by `aging` and `balance_sheet`; never taken from the clock. */
  readonly asOf?: string;
};

export function runQuery(db: Database, options: QueryOptions): QueryResult {
  const { view, baseExponent: exp } = options;
  if (view === "chain") {
    const chain = verifyChain(db, (entry: EntryRow, lines: ReadonlyArray<LineRow>) =>
      entryPayload(entry, lines),
    );
    return {
      view,
      rows: chain.problems.map((p) => ({ seq: p.seq, reason: p.reason })),
      totals: { ok: chain.ok, entries: chain.entries, head: chain.head },
      rowCount: chain.problems.length,
      truncated: false,
      // `ok` is a statement about the ENTRIES and their lines, which is what
      // the chain covers. It is not a statement about the chart of accounts:
      // an account's type is outside the hash, and flipping one from income to
      // expense turns a P&L over without breaking a single link. Saying so
      // here is the difference between "verified" and "verified what".
      notes: [
        'this checks the entries and their lines. The chart of accounts is NOT inside the chain, so re-typing an account changes every report that signs by type and still verifies "ok" — compare the account types against your own record separately.',
      ],
      chain,
    };
  }

  const rows = selectLines(db, options.filter);
  const types = accountTypes(db);
  const money = (v: bigint): string => formatMajor(v, exp);

  switch (view) {
    case "trial_balance":
    case "balance": {
      const totals = totalsByAccount(rows);
      const out = [...totals.entries()]
        .sort((a, b) => byString(a[0], b[0]))
        .map(([account, t]) => ({
          account,
          type: types.get(account) ?? null,
          debitMinor: t.debit.toString(),
          creditMinor: t.credit.toString(),
          debit: money(t.debit),
          credit: money(t.credit),
          balanceMinor: signedBalance(types.get(account), t).toString(),
          balance: money(signedBalance(types.get(account), t)),
        }));
      const debit = [...totals.values()].reduce((s, t) => s + t.debit, 0n);
      const credit = [...totals.values()].reduce((s, t) => s + t.credit, 0n);
      // Every posting was balance-checked, so over WHOLE entries this can only
      // be false if the file was edited outside the tool — which is why it is
      // reported rather than assumed. Over a selection that cuts entries in
      // half it says nothing at all, so it says `null` and the note explains
      // why; `false` there would read as tampering to whoever is looking.
      const split = selectionSplitsEntries(options.filter);
      return {
        view,
        rows: out.slice(0, options.limit),
        totals: {
          debitMinor: debit.toString(),
          creditMinor: credit.toString(),
          debit: money(debit),
          credit: money(credit),
          differenceMinor: (debit - credit).toString(),
          balanced: split ? null : debit === credit,
          currency: options.baseCurrency,
        },
        rowCount: out.length,
        truncated: out.length > options.limit,
        notes: split
          ? [
              'this selection filters on individual lines, so it holds one leg of an entry and not the other; "balanced" is null because it cannot be judged here — run the same view with no account, counterparty, text or amount filter to check the books',
            ]
          : undefined,
      };
    }

    case "account_ledger": {
      const accounts = options.filter.accounts ?? [];
      if (accounts.length !== 1) {
        throw new LedgerError(
          "account_ledger reports ONE account's running balance; pass exactly one account (a running balance across several accounts is a number with no meaning)",
        );
      }
      let running = 0n;
      const account = accounts[0] as string;
      const type = types.get(account);
      const out = rows.map((row) => {
        const delta =
          (type === undefined ? "debit" : NORMAL_BALANCE[type]) === "debit"
            ? BigInt(row.base_debit_minor) - BigInt(row.base_credit_minor)
            : BigInt(row.base_credit_minor) - BigInt(row.base_debit_minor);
        running += delta;
        return {
          seq: row.seq,
          entryId: row.entry_id,
          date: row.date,
          memo: row.line_memo ?? row.memo,
          reference: row.reference,
          counterparty: row.counterparty,
          debit: money(BigInt(row.base_debit_minor)),
          credit: money(BigInt(row.base_credit_minor)),
          balanceMinor: running.toString(),
          balance: money(running),
        };
      });
      return {
        view,
        rows: out.slice(0, options.limit),
        totals: {
          account,
          closingBalanceMinor: running.toString(),
          closingBalance: money(running),
          currency: options.baseCurrency,
        },
        rowCount: out.length,
        truncated: out.length > options.limit,
      };
    }

    case "journal":
    case "search": {
      const out = rows.map((row) => ({
        seq: row.seq,
        entryId: row.entry_id,
        date: row.date,
        account: row.account,
        memo: row.line_memo ?? row.memo,
        reference: row.reference,
        counterparty: row.counterparty,
        currency: row.currency,
        debit: money(BigInt(row.base_debit_minor)),
        credit: money(BigInt(row.base_credit_minor)),
        debitMinor: row.base_debit_minor,
        creditMinor: row.base_credit_minor,
        source: row.source_system === null ? null : `${row.source_system}/${row.source_id}`,
        tags: (JSON.parse(row.tags) as string[]).join(" "),
      }));
      const debit = rows.reduce((s, r) => s + BigInt(r.base_debit_minor), 0n);
      const credit = rows.reduce((s, r) => s + BigInt(r.base_credit_minor), 0n);
      return {
        view,
        rows: out.slice(0, options.limit),
        totals: {
          debit: money(debit),
          credit: money(credit),
          debitMinor: debit.toString(),
          creditMinor: credit.toString(),
          currency: options.baseCurrency,
        },
        rowCount: out.length,
        truncated: out.length > options.limit,
      };
    }

    case "pnl": {
      const totals = totalsByAccount(rows);
      const out: Array<Record<string, string | number | null>> = [];
      let income = 0n;
      let expense = 0n;
      for (const [account, t] of [...totals.entries()].sort((a, b) => byString(a[0], b[0]))) {
        const type = types.get(account);
        if (type !== "income" && type !== "expense") continue;
        const amount = signedBalance(type, t);
        if (type === "income") income += amount;
        else expense += amount;
        out.push({
          account,
          type,
          amountMinor: amount.toString(),
          amount: money(amount),
        });
      }
      const net = income - expense;
      return {
        view,
        rows: out.slice(0, options.limit),
        totals: {
          incomeMinor: income.toString(),
          income: money(income),
          expenseMinor: expense.toString(),
          expense: money(expense),
          netIncomeMinor: net.toString(),
          netIncome: money(net),
          currency: options.baseCurrency,
        },
        rowCount: out.length,
        truncated: out.length > options.limit,
      };
    }

    case "balance_sheet": {
      const totals = totalsByAccount(rows);
      const out: Array<Record<string, string | number | null>> = [];
      const sums: Record<AccountType, bigint> = {
        asset: 0n,
        liability: 0n,
        equity: 0n,
        income: 0n,
        expense: 0n,
      };
      for (const [account, t] of [...totals.entries()].sort((a, b) => byString(a[0], b[0]))) {
        const type = types.get(account);
        if (type === undefined) continue;
        const amount = signedBalance(type, t);
        sums[type] += amount;
        if (type === "income" || type === "expense") continue;
        out.push({ account, type, amountMinor: amount.toString(), amount: money(amount) });
      }
      // Retained earnings for the period are not an account anybody posted to;
      // they are income less expense, and the sheet does not balance without
      // them. Reporting the difference rather than asserting it lets a caller
      // see a book that has been edited.
      const retained = sums.income - sums.expense;
      const difference = sums.asset - (sums.liability + sums.equity + retained);
      return {
        view,
        rows: out.slice(0, options.limit),
        totals: {
          asOf: options.asOf ?? options.filter.to ?? "all posted entries",
          assetsMinor: sums.asset.toString(),
          assets: money(sums.asset),
          liabilitiesMinor: sums.liability.toString(),
          liabilities: money(sums.liability),
          equityMinor: sums.equity.toString(),
          equity: money(sums.equity),
          retainedEarningsMinor: retained.toString(),
          retainedEarnings: money(retained),
          differenceMinor: difference.toString(),
          balanced: difference === 0n,
          currency: options.baseCurrency,
        },
        rowCount: out.length,
        truncated: out.length > options.limit,
      };
    }

    case "aging":
      return agingView(rows, options, money);

    default: {
      const exhaustive: never = view;
      throw new LedgerError(`unknown view ${String(exhaustive)}`);
    }
  }
}

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
type Bucket = (typeof BUCKETS)[number];

function bucketFor(dueDate: string, asOf: string): Bucket {
  const overdue = dayDiff(asOf, dueDate);
  if (overdue <= 0) return "current";
  if (overdue <= 30) return "1-30";
  if (overdue <= 60) return "31-60";
  if (overdue <= 90) return "61-90";
  return "90+";
}

/**
 * Receivables/payables aging, or a refusal naming what is missing.
 *
 * The failure this guards against is the one that looks like an answer: with
 * no `dueDate` on any line, every amount falls in "current" and the report
 * says nothing is overdue. So a selection where nothing carries a due date is
 * refused outright, and a line with no `counterparty` is refused too — aging
 * is per counterparty by definition. Lines that DO have a counterparty but no
 * due date are payments and credits; they are reported as unapplied against
 * that counterparty rather than folded into "current", where they would
 * quietly cancel an overdue invoice.
 */
function agingView(
  rows: ReadonlyArray<JoinedRow>,
  options: QueryOptions,
  money: (v: bigint) => string,
): QueryResult {
  const asOf = options.asOf;
  if (asOf === undefined) {
    throw new LedgerError(
      "aging needs an explicit asOf date — reading it from the clock would make the same ledger produce a different report tomorrow, and an aging report is a document somebody files",
    );
  }
  epochDay(asOf);
  const accounts = options.filter.accounts ?? [];
  if (accounts.length === 0) {
    throw new LedgerError(
      "aging needs the accounts to age (receivables, payables) — ageing every account in the ledger produces a table with no meaning",
    );
  }
  if (rows.length === 0) {
    throw new LedgerError(
      `no posted lines match accounts ${accounts.join(", ")} in the requested range, so there is nothing to age`,
    );
  }
  const withoutCounterparty = rows.filter((r) => r.counterparty === null || r.counterparty === "");
  if (withoutCounterparty.length > 0) {
    const example = withoutCounterparty[0] as JoinedRow;
    throw new LedgerError(
      `aging needs "counterparty" on every line and ${withoutCounterparty.length} of ${rows.length} selected lines do not have it (for example entry ${example.entry_id}, account ${example.account}) — post those lines again with counterparty set; a table that omits them is not an aging of this account`,
    );
  }
  const withDueDate = rows.filter((r) => r.due_date !== null && r.due_date !== "");
  if (withDueDate.length === 0) {
    throw new LedgerError(
      `aging needs "dueDate" on the lines being aged and not one of the ${rows.length} selected lines has it — every amount would land in "current" and the report would say nothing is overdue, which is the partial answer this refuses to give`,
    );
  }

  type Row = { buckets: Record<Bucket, bigint>; unapplied: bigint };
  const byCounterparty = new Map<string, Row>();
  for (const row of rows) {
    const key = row.counterparty as string;
    const entry =
      byCounterparty.get(key) ??
      ({
        buckets: { current: 0n, "1-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n },
        unapplied: 0n,
      } as Row);
    const amount = BigInt(row.base_debit_minor) - BigInt(row.base_credit_minor);
    if (row.due_date === null || row.due_date === "") entry.unapplied += amount;
    else entry.buckets[bucketFor(row.due_date, asOf)] += amount;
    byCounterparty.set(key, entry);
  }

  const out = [...byCounterparty.entries()]
    .sort((a, b) => byString(a[0], b[0]))
    .map(([counterparty, row]) => {
      const total = BUCKETS.reduce((s, b) => s + row.buckets[b], 0n) + row.unapplied;
      return {
        counterparty,
        current: money(row.buckets.current),
        "1-30": money(row.buckets["1-30"]),
        "31-60": money(row.buckets["31-60"]),
        "61-90": money(row.buckets["61-90"]),
        "90+": money(row.buckets["90+"]),
        unapplied: money(row.unapplied),
        totalMinor: total.toString(),
        total: money(total),
      };
    });

  const grand = BUCKETS.map(
    (b) => [b, [...byCounterparty.values()].reduce((s, r) => s + r.buckets[b], 0n)] as const,
  );
  const unapplied = [...byCounterparty.values()].reduce((s, r) => s + r.unapplied, 0n);
  return {
    view: "aging",
    rows: out.slice(0, options.limit),
    totals: {
      asOf,
      ...Object.fromEntries(grand.map(([b, v]) => [b, money(v)])),
      unapplied: money(unapplied),
      currency: options.baseCurrency,
    },
    rowCount: out.length,
    truncated: out.length > options.limit,
    notes:
      rows.length === withDueDate.length
        ? undefined
        : [
            `${rows.length - withDueDate.length} of ${rows.length} lines carry no dueDate and are reported as "unapplied" rather than aged; they are not counted as current`,
          ],
  };
}

// ---------------------------------------------------------------------------
// rendering

/** RFC 4180: quote when the field contains a comma, a quote or a newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

export function renderRows(
  rows: ReadonlyArray<Record<string, string | number | null>>,
  format: Format,
): string {
  if (rows.length === 0) return "";
  // Column order comes from the first row's insertion order, which is written
  // out literally above — never from a set union over every row, which would
  // move the columns when a later row happens to carry an extra key.
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const cell = (row: Record<string, string | number | null>, key: string): string => {
    const value = row[key];
    return value === null || value === undefined ? "" : String(value);
  };
  if (format === "csv") {
    return [
      headers.map(csvField).join(","),
      ...rows.map((row) => headers.map((h) => csvField(cell(row, h))).join(",")),
    ].join("\n");
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) => `| ${headers.map((h) => cell(row, h).split("|").join("\\|")).join(" | ")} |`,
    ),
  ].join("\n");
}

/**
 * Posting: what a balanced entry is, and the one transaction that writes it.
 *
 * DOUBLE ENTRY IS THE WHOLE POINT. Debits equal credits, per entry, checked
 * here and refused here. A ledger that accepts an unbalanced entry is not a
 * ledger with a small error in it; it is a pile of rows, and every report over
 * it is unfalsifiable. So an unbalanced entry never reaches the database.
 *
 * MULTI-CURRENCY is where that rule gets interesting, and where the sketch
 * this was built from is too generous. An entry with a foreign line balances
 * in the BASE currency after conversion, and the conversions round — so a
 * residue of a minor unit or two is arithmetic, and it goes to the configured
 * fx account. A residue of nine hundred is not rounding; it is a rate entered
 * as 1.09 instead of 0.91, and booking it to "FX rounding" hides a real loss
 * in the one account nobody reads. So the residue is BOUNDED: at most one
 * minor unit per converted line, which is the most that rounding can produce,
 * and anything larger is refused with both numbers in the message.
 */
import type { Database } from "bun:sqlite";
import {
  LedgerError,
  assertIsoDate,
  byString,
  canonicalJson,
  convertMinor,
  exponentFor,
  formatMajor,
  parseFactor,
  parseMajor,
  parseMinorUnits,
  sha256Hex,
} from "./amount";
import {
  type AccountType,
  DryRunRollback,
  type EntryRow,
  GENESIS_HASH,
  type LineRow,
  entryHash,
  inImmediateTransaction,
  readHead,
  writeMeta,
} from "./db";

/** Ceilings that keep one call's work bounded. */
export const POST_LIMITS = {
  entriesPerCall: 500,
  linesPerEntry: 200,
  tagsPerEntry: 32,
} as const;

export type LineInput = {
  readonly account: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly debitMinor?: string | number;
  readonly creditMinor?: string | number;
  readonly currency?: string;
  readonly exponent?: number;
  readonly fxRate?: string;
  readonly counterparty?: string;
  readonly dueDate?: string;
  readonly memo?: string;
};

export type EntryInput = {
  readonly date: string;
  readonly memo: string;
  readonly reference?: string;
  readonly lines: ReadonlyArray<LineInput>;
  readonly tags?: ReadonlyArray<string>;
  readonly source?: { readonly system: string; readonly id: string };
};

export type PostConfig = {
  readonly baseCurrency: string;
  readonly baseExponent: number;
  readonly autoCreateAccounts: boolean;
  readonly lockedBefore?: string;
  readonly fxAccount?: string;
  readonly maxFxResidueMinor?: number;
  readonly postedAt: string;
  readonly idempotencyKey: string;
  readonly dryRun: boolean;
};

type NormalizedLine = {
  account: string;
  debitMinor: bigint;
  creditMinor: bigint;
  currency: string;
  exponent: number;
  fxRate: string | null;
  baseDebitMinor: bigint;
  baseCreditMinor: bigint;
  counterparty: string | null;
  dueDate: string | null;
  lineMemo: string | null;
  /** True for the line this package added to absorb conversion rounding. */
  fxResidue: boolean;
};

type NormalizedEntry = {
  index: number;
  entryId: string;
  date: string;
  memo: string;
  reference: string;
  tags: string[];
  sourceSystem: string | null;
  sourceId: string | null;
  lines: NormalizedLine[];
  totalDebitMinor: bigint;
  fxResidueMinor: bigint;
  perCurrency: Array<{ currency: string; debitMinor: string; creditMinor: string }>;
};

export type Rejection = { readonly index: number; readonly reason: string };

/** One amount on one side, from whichever of the four spellings the caller used. */
function readSide(
  line: LineInput,
  side: "debit" | "credit",
  exponent: number,
  where: string,
): bigint | null {
  const major = side === "debit" ? line.debit : line.credit;
  const minor = side === "debit" ? line.debitMinor : line.creditMinor;
  if (major !== undefined && minor !== undefined) {
    throw new LedgerError(
      `${where} gives both ${side} and ${side}Minor — one amount, one spelling, because two that disagree would be resolved by whichever this code read first`,
    );
  }
  if (major !== undefined) return parseMajor(major, exponent, `${where} ${side}`);
  if (minor !== undefined) return parseMinorUnits(minor, `${where} ${side}Minor`);
  return null;
}

/**
 * Validate and normalize one entry. Throws `LedgerError` with the reason; the
 * caller turns that into a rejection rather than failing the whole batch,
 * because "entry 7 is unbalanced" should not stop entries 1 through 6.
 */
function normalizeEntry(entry: EntryInput, index: number, config: PostConfig): NormalizedEntry {
  const where = `entry ${index}`;
  const date = assertIsoDate(entry.date, `${where} date`);
  if (config.lockedBefore !== undefined && date < config.lockedBefore) {
    throw new LedgerError(
      `${where} is dated ${date}, before the locked period boundary ${config.lockedBefore} — a closed period is closed; post the correction into an open one`,
    );
  }
  if (entry.memo.trim() === "") {
    throw new LedgerError(
      `${where} has an empty memo — an entry nobody can read is an entry nobody can audit`,
    );
  }
  if (entry.lines.length < 2) {
    throw new LedgerError(
      `${where} has ${entry.lines.length} line(s); double entry needs at least two, one on each side`,
    );
  }
  if (entry.lines.length > POST_LIMITS.linesPerEntry) {
    throw new LedgerError(
      `${where} has ${entry.lines.length} lines, over the ${POST_LIMITS.linesPerEntry} limit`,
    );
  }

  const lines: NormalizedLine[] = [];
  let convertedLines = 0;
  for (const [i, line] of entry.lines.entries()) {
    const at = `${where} line ${i}`;
    if (line.account.trim() === "") throw new LedgerError(`${at} has no account`);
    const currency = (line.currency ?? config.baseCurrency).toUpperCase();
    const exponent = exponentFor(currency, line.exponent);
    const debit = readSide(line, "debit", exponent, at);
    const credit = readSide(line, "credit", exponent, at);
    if (debit !== null && credit !== null) {
      throw new LedgerError(
        `${at} carries both a debit and a credit — split it into two lines so the entry says which side each amount is on`,
      );
    }
    if (debit === null && credit === null) {
      throw new LedgerError(`${at} has no amount on either side`);
    }
    const amount = (debit ?? credit) as bigint;
    if (amount < 0n) {
      throw new LedgerError(
        `${at} has a negative ${debit === null ? "credit" : "debit"} (${formatMajor(amount, exponent)}) — a negative debit is a credit, so write it as one; letting both spellings in is how a sign error survives a review`,
      );
    }
    if (amount === 0n) {
      throw new LedgerError(`${at} has a zero amount, which records nothing`);
    }

    let fxRate: string | null = null;
    let baseDebit = debit ?? 0n;
    let baseCredit = credit ?? 0n;
    if (currency !== config.baseCurrency) {
      if (line.fxRate === undefined) {
        throw new LedgerError(
          `${at} is in ${currency} but the ledger's base currency is ${config.baseCurrency} and the line carries no fxRate — this package will not invent a rate, and a rate a model recalled is not a rate`,
        );
      }
      const rate = parseFactor(line.fxRate, `${at} fxRate`);
      if (rate.unscaled <= 0n) throw new LedgerError(`${at} fxRate must be greater than zero`);
      fxRate = line.fxRate;
      baseDebit = debit === null ? 0n : convertMinor(debit, rate, exponent, config.baseExponent);
      baseCredit = credit === null ? 0n : convertMinor(credit, rate, exponent, config.baseExponent);
      convertedLines += 1;
    } else if (line.fxRate !== undefined) {
      throw new LedgerError(
        `${at} is already in the base currency ${config.baseCurrency} and also carries an fxRate — one of the two is a mistake and this code cannot tell which`,
      );
    }

    if (line.dueDate !== undefined) assertIsoDate(line.dueDate, `${at} dueDate`);
    lines.push({
      account: line.account,
      debitMinor: debit ?? 0n,
      creditMinor: credit ?? 0n,
      currency,
      exponent,
      fxRate,
      baseDebitMinor: baseDebit,
      baseCreditMinor: baseCredit,
      counterparty: line.counterparty ?? null,
      dueDate: line.dueDate ?? null,
      lineMemo: line.memo ?? null,
      fxResidue: false,
    });
  }

  // Per-currency totals are reported whether or not they are the test, because
  // "the entry balances in EUR but not in GBP" is the sentence a bookkeeper
  // needs and "unbalanced by 3" is not.
  const perCurrency = summarizePerCurrency(lines);

  if (convertedLines === 0) {
    const debits = lines.reduce((s, l) => s + l.debitMinor, 0n);
    const credits = lines.reduce((s, l) => s + l.creditMinor, 0n);
    if (debits !== credits) {
      throw new LedgerError(
        `${where} does not balance: debits ${formatMajor(debits, config.baseExponent)} ${config.baseCurrency} against credits ${formatMajor(credits, config.baseExponent)} ${config.baseCurrency}, a difference of ${formatMajor(debits - credits, config.baseExponent)}`,
      );
    }
    return {
      index,
      entryId: "",
      date,
      memo: entry.memo,
      reference: entry.reference ?? "",
      tags: canonicalTags(entry.tags ?? [], where),
      sourceSystem: entry.source?.system ?? null,
      sourceId: entry.source?.id ?? null,
      lines,
      totalDebitMinor: debits,
      fxResidueMinor: 0n,
      perCurrency,
    };
  }

  const baseDebits = lines.reduce((s, l) => s + l.baseDebitMinor, 0n);
  const baseCredits = lines.reduce((s, l) => s + l.baseCreditMinor, 0n);
  const residue = baseDebits - baseCredits;
  if (residue !== 0n) {
    // One minor unit per conversion is the most that rounding can produce.
    // Anything past it is a wrong rate wearing rounding's coat.
    const bound = BigInt(config.maxFxResidueMinor ?? convertedLines);
    const magnitude = residue < 0n ? -residue : residue;
    if (magnitude > bound) {
      throw new LedgerError(
        `${where} is out by ${formatMajor(residue, config.baseExponent)} ${config.baseCurrency} after converting ${convertedLines} foreign line(s), which is more than the ${bound} minor unit(s) that rounding can account for — this is a wrong fx rate, not a rounding residue, and booking it to the fx account would hide a real difference`,
      );
    }
    if (config.fxAccount === undefined) {
      throw new LedgerError(
        `${where} rounds to a residue of ${formatMajor(residue, config.baseExponent)} ${config.baseCurrency} and no fxAccount is configured — set ledger.fxAccount to the account that absorbs conversion rounding, because the alternative is silently adding it to whichever line came last`,
      );
    }
    lines.push({
      account: config.fxAccount,
      debitMinor: residue < 0n ? -residue : 0n,
      creditMinor: residue > 0n ? residue : 0n,
      currency: config.baseCurrency,
      exponent: config.baseExponent,
      fxRate: null,
      baseDebitMinor: residue < 0n ? -residue : 0n,
      baseCreditMinor: residue > 0n ? residue : 0n,
      counterparty: null,
      dueDate: null,
      lineMemo: "fx conversion rounding",
      fxResidue: true,
    });
  }

  return {
    index,
    entryId: "",
    date,
    memo: entry.memo,
    reference: entry.reference ?? "",
    tags: canonicalTags(entry.tags ?? [], where),
    sourceSystem: entry.source?.system ?? null,
    sourceId: entry.source?.id ?? null,
    lines,
    totalDebitMinor: lines.reduce((s, l) => s + l.baseDebitMinor, 0n),
    fxResidueMinor: residue,
    perCurrency,
  };
}

function summarizePerCurrency(
  lines: ReadonlyArray<NormalizedLine>,
): Array<{ currency: string; debitMinor: string; creditMinor: string }> {
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of lines) {
    const bucket = totals.get(line.currency) ?? { debit: 0n, credit: 0n };
    bucket.debit += line.debitMinor;
    bucket.credit += line.creditMinor;
    totals.set(line.currency, bucket);
  }
  return [...totals.entries()]
    .sort((a, b) => byString(a[0], b[0]))
    .map(([currency, t]) => ({
      currency,
      debitMinor: t.debit.toString(),
      creditMinor: t.credit.toString(),
    }));
}

function canonicalTags(tags: ReadonlyArray<string>, where: string): string[] {
  if (tags.length > POST_LIMITS.tagsPerEntry) {
    throw new LedgerError(
      `${where} has ${tags.length} tags, over the ${POST_LIMITS.tagsPerEntry} limit`,
    );
  }
  // Sorted and deduplicated so the same entry written twice hashes the same.
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ""))].sort(byString);
}

/** The bytes an entry's chain link is taken over. */
export function entryPayload(entry: EntryRow, lines: ReadonlyArray<LineRow>): unknown {
  return {
    seq: entry.seq,
    entryId: entry.entry_id,
    date: entry.date,
    memo: entry.memo,
    reference: entry.reference,
    tags: JSON.parse(entry.tags) as string[],
    source:
      entry.source_system === null ? null : { system: entry.source_system, id: entry.source_id },
    baseCurrency: entry.base_currency,
    postedAt: entry.posted_at,
    lines: lines.map((l) => ({
      idx: l.idx,
      account: l.account,
      debitMinor: l.debit_minor,
      creditMinor: l.credit_minor,
      currency: l.currency,
      exponent: l.exponent,
      fxRate: l.fx_rate,
      baseDebitMinor: l.base_debit_minor,
      baseCreditMinor: l.base_credit_minor,
      counterparty: l.counterparty,
      dueDate: l.due_date,
      memo: l.line_memo,
    })),
  };
}

export type PostedEntry = {
  readonly entryId: string;
  readonly seq: number;
  readonly hash: string;
  readonly date: string;
  readonly totalMinor: string;
  readonly total: string;
  readonly lines: number;
  readonly fxResidueMinor: string;
  readonly perCurrency: ReadonlyArray<{
    readonly currency: string;
    readonly debitMinor: string;
    readonly creditMinor: string;
  }>;
};

export type PostResult = {
  readonly posted: ReadonlyArray<PostedEntry>;
  readonly rejected: ReadonlyArray<Rejection>;
  readonly head: { readonly hash: string; readonly length: number };
  readonly idempotencyKey: string;
  readonly replayed: boolean;
  readonly dryRun: boolean;
  readonly baseCurrency: string;
};

/**
 * Post a batch.
 *
 * Pure validation runs first, outside the lock, because it needs nothing from
 * the database and holding a write lock while parsing five hundred entries
 * would block every other writer for no reason. Everything that depends on the
 * ledger's state — does this account exist, has this source already posted, is
 * this key claimed, what is the chain head — runs INSIDE the one immediate
 * transaction, together with the writes, because each of those is a
 * check-then-act whose two halves must not be separable by a crash or by
 * another process.
 */
export function postBatch(
  db: Database,
  entries: ReadonlyArray<EntryInput>,
  config: PostConfig,
): PostResult {
  const normalized: NormalizedEntry[] = [];
  const rejected: Rejection[] = [];
  for (const [index, entry] of entries.entries()) {
    try {
      normalized.push(normalizeEntry(entry, index, config));
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      rejected.push({ index, reason: err.message });
    }
  }

  // The fingerprint an idempotent replay is checked against covers everything
  // that could change what gets written — including the configuration, because
  // the same entries posted against a different base currency are different
  // entries.
  const payloadHash = sha256Hex(
    canonicalJson({
      entries,
      baseCurrency: config.baseCurrency,
      baseExponent: config.baseExponent,
      fxAccount: config.fxAccount ?? null,
      lockedBefore: config.lockedBefore ?? null,
      postedAt: config.postedAt,
    }),
  );

  const run = (): PostResult => {
    const claimed = db
      .query("SELECT payload_hash, result FROM idempotency WHERE key = ?")
      .get(config.idempotencyKey) as { payload_hash: string; result: string } | null;
    if (claimed !== null) {
      if (claimed.payload_hash !== payloadHash) {
        throw new LedgerError(
          `idempotency key "${config.idempotencyKey}" was already used for a DIFFERENT batch — reusing a key for new content is the failure an idempotency key exists to catch, so nothing was posted; use a new key`,
        );
      }
      const previous = JSON.parse(claimed.result) as PostResult;
      return { ...previous, replayed: true };
    }

    const head = readHead(db);
    const maxSeqRow = db.query("SELECT COALESCE(MAX(seq), 0) AS n FROM entries").get() as {
      n: number;
    };
    if (maxSeqRow.n !== head.length) {
      throw new LedgerError(
        `the ledger records ${head.length} entries but the highest sequence number is ${maxSeqRow.n} — the file has been modified outside this tool and appending to it would extend a broken chain`,
      );
    }

    const insertEntry = db.prepare(
      "INSERT INTO entries (seq, entry_id, date, memo, reference, tags, source_system, source_id, base_currency, posted_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertLine = db.prepare(
      "INSERT INTO lines (entry_seq, idx, account, debit_minor, credit_minor, currency, exponent, fx_rate, base_debit_minor, base_credit_minor, counterparty, due_date, line_memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const findAccount = db.query("SELECT code, name, type FROM accounts WHERE code = ?");
    const findSource = db.query(
      "SELECT entry_id FROM entries WHERE source_system = ? AND source_id = ?",
    );

    const posted: PostedEntry[] = [];
    const lateRejections: Rejection[] = [];
    let prevHash = head.hash;
    let seq = head.length;

    for (const entry of normalized) {
      const duplicate =
        entry.sourceSystem === null || entry.sourceId === null
          ? null
          : (findSource.get(entry.sourceSystem, entry.sourceId) as { entry_id: string } | null);
      if (duplicate !== null) {
        lateRejections.push({
          index: entry.index,
          reason: `${entry.sourceSystem}/${entry.sourceId} was already posted as entry ${duplicate.entry_id} — the same payment does not get two entries`,
        });
        continue;
      }
      let missing: string | null = null;
      for (const line of entry.lines) {
        if ((findAccount.get(line.account) as { code: string } | null) !== null) continue;
        if (!config.autoCreateAccounts) {
          missing = line.account;
          break;
        }
        db.run("INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)", [
          line.account,
          line.account,
          inferAccountType(line.account),
        ]);
      }
      if (missing !== null) {
        lateRejections.push({
          index: entry.index,
          reason: `account "${missing}" is not in the chart of accounts — add it, or set autoCreateAccounts, because a typo that creates an account silently is a balance that reconciles to nothing`,
        });
        continue;
      }

      seq += 1;
      const entryId = `e_${sha256Hex(canonicalJson({ key: config.idempotencyKey, index: entry.index, seq })).slice(0, 24)}`;
      const entryRow: EntryRow = {
        seq,
        entry_id: entryId,
        date: entry.date,
        memo: entry.memo,
        reference: entry.reference,
        tags: JSON.stringify(entry.tags),
        source_system: entry.sourceSystem,
        source_id: entry.sourceId,
        base_currency: config.baseCurrency,
        posted_at: config.postedAt,
        prev_hash: prevHash,
        hash: "",
      };
      const lineRows: LineRow[] = entry.lines.map((l, idx) => ({
        entry_seq: seq,
        idx,
        account: l.account,
        debit_minor: l.debitMinor.toString(),
        credit_minor: l.creditMinor.toString(),
        currency: l.currency,
        exponent: l.exponent,
        fx_rate: l.fxRate,
        base_debit_minor: l.baseDebitMinor.toString(),
        base_credit_minor: l.baseCreditMinor.toString(),
        counterparty: l.counterparty,
        due_date: l.dueDate,
        line_memo: l.lineMemo,
      }));
      const hash = entryHash(prevHash, entryPayload(entryRow, lineRows));

      insertEntry.run(
        seq,
        entryId,
        entry.date,
        entry.memo,
        entry.reference,
        entryRow.tags,
        entry.sourceSystem,
        entry.sourceId,
        config.baseCurrency,
        config.postedAt,
        prevHash,
        hash,
      );
      for (const row of lineRows) {
        insertLine.run(
          row.entry_seq,
          row.idx,
          row.account,
          row.debit_minor,
          row.credit_minor,
          row.currency,
          row.exponent,
          row.fx_rate,
          row.base_debit_minor,
          row.base_credit_minor,
          row.counterparty,
          row.due_date,
          row.line_memo,
        );
      }
      prevHash = hash;
      posted.push({
        entryId,
        seq,
        hash,
        date: entry.date,
        totalMinor: entry.totalDebitMinor.toString(),
        total: formatMajor(entry.totalDebitMinor, config.baseExponent),
        lines: entry.lines.length,
        fxResidueMinor: entry.fxResidueMinor.toString(),
        perCurrency: entry.perCurrency,
      });
    }

    writeMeta(db, "chainHead", prevHash);
    writeMeta(db, "chainLength", String(seq));

    const result: PostResult = {
      posted,
      rejected: [...rejected, ...lateRejections].sort((a, b) => a.index - b.index),
      head: { hash: prevHash, length: seq },
      idempotencyKey: config.idempotencyKey,
      replayed: false,
      dryRun: config.dryRun,
      baseCurrency: config.baseCurrency,
    };

    // The claim goes in the SAME transaction as the rows and the head. This
    // line is the entire reason this function is shaped the way it is.
    db.run("INSERT INTO idempotency (key, payload_hash, result, claimed_at) VALUES (?, ?, ?, ?)", [
      config.idempotencyKey,
      payloadHash,
      JSON.stringify(result),
      config.postedAt,
    ]);

    if (config.dryRun) throw new DryRunRollback(result);
    return result;
  };

  try {
    return inImmediateTransaction(db, run);
  } catch (err) {
    if (err instanceof DryRunRollback) return err.payload as PostResult;
    throw err;
  }
}

/**
 * Upsert the chart of accounts.
 *
 * Deliberately NOT inside the posting transaction: the chart is a declaration
 * about the world, not part of the entry, and a batch that is refused for
 * being unbalanced should not also un-declare an account the caller named.
 * Nothing here is amount-bearing, so nothing here can be half-applied in a way
 * that matters.
 */
export function ensureAccounts(
  db: Database,
  accounts: ReadonlyArray<{
    readonly code: string;
    readonly name?: string;
    readonly type: AccountType;
  }>,
): number {
  if (accounts.length === 0) return 0;
  return inImmediateTransaction(db, () => {
    for (const account of accounts) {
      db.run(
        "INSERT INTO accounts (code, name, type) VALUES (?, ?, ?) ON CONFLICT (code) DO UPDATE SET name = ?, type = ?",
        [
          account.code,
          account.name ?? account.code,
          account.type,
          account.name ?? account.code,
          account.type,
        ],
      );
    }
    return accounts.length;
  });
}

/**
 * A guess at an auto-created account's type, from the numbering convention
 * most charts follow (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income,
 * 5xxx+ expenses). It is a guess, which is exactly why `autoCreateAccounts` is
 * off by default: a report signs its sums by this field.
 */
export function inferAccountType(code: string): AccountType {
  const digit = /^(\d)/.exec(code.trim())?.[1];
  switch (digit) {
    case "1":
      return "asset";
    case "2":
      return "liability";
    case "3":
      return "equity";
    case "4":
      return "income";
    default:
      return "expense";
  }
}

export { GENESIS_HASH };

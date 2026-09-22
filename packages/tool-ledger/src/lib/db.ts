/**
 * The store: one `bun:sqlite` file, opened the way `@crewhaus/durable-state`
 * opens one, with the whole of a posting inside a single `BEGIN IMMEDIATE`.
 *
 * THE INVARIANT THIS FILE EXISTS FOR
 *
 * A posting is three writes that are only correct together: the rows, the hash
 * chain's new head, and the idempotency claim that says this batch has been
 * seen. Commit them separately and there is a window in which the process can
 * die leaving a ledger whose chain verifies perfectly and whose duplicate
 * suppression has forgotten the entry — so the retry posts the same payment a
 * second time, and every check anybody runs says the books are fine. Invoice
 * numbering has the same shape from the other side: allocate the number, die
 * before the document is recorded, and the sequence has a gap, which in most
 * jurisdictions is not untidiness but a finding.
 *
 * So every mutation below happens inside ONE `tx.immediate(...)`. `IMMEDIATE`
 * takes the write lock at BEGIN rather than at the first write, which is what
 * makes the read half (is this key claimed? what is the chain head? what is the
 * next invoice number?) serialize against another writer instead of racing it;
 * `busy_timeout` is what makes the loser wait rather than fail instantly. Bun's
 * `db.transaction()` rolls the whole thing back on a throw, so a failure
 * anywhere in the batch leaves the file exactly as it was — no rows, no claim,
 * no advanced head, no burnt invoice number.
 *
 * Amounts are stored as TEXT holding a bigint's decimal digits. SQLite would
 * take them as INTEGER, but `bun:sqlite` hands an INTEGER column back as a JS
 * number, and `SUM()` over one silently becomes a float once it overflows —
 * both of which lose exactly the pennies this package is for.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LedgerError, byString, canonicalJson, sha256Hex } from "./amount";

/** Bumped when the on-disk shape changes. A mismatch is refused, never migrated silently. */
export const SCHEMA_VERSION = 1;

/** The `prev_hash` of the first entry. Nothing precedes it. */
export const GENESIS_HASH = "0".repeat(64);

/** How long a writer waits for another writer's lock before giving up. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** The five account types, and the side each one increases on. */
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Which side an account's balance is normally on.
 *
 * This lives with the chart of accounts, never in a query. A P&L that decides
 * the sign of "revenue" by looking at the account's name is a report that is
 * wrong the first time somebody calls an account "Revenue refunds".
 */
export const NORMAL_BALANCE: Readonly<Record<AccountType, "debit" | "credit">> = Object.freeze({
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  income: "credit",
});

export type AccountRow = {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
};

export type EntryRow = {
  readonly seq: number;
  readonly entry_id: string;
  readonly date: string;
  readonly memo: string;
  readonly reference: string;
  readonly tags: string;
  readonly source_system: string | null;
  readonly source_id: string | null;
  readonly base_currency: string;
  readonly posted_at: string;
  readonly prev_hash: string;
  readonly hash: string;
};

export type LineRow = {
  readonly entry_seq: number;
  readonly idx: number;
  readonly account: string;
  readonly debit_minor: string;
  readonly credit_minor: string;
  readonly currency: string;
  readonly exponent: number;
  readonly fx_rate: string | null;
  readonly base_debit_minor: string;
  readonly base_credit_minor: string;
  readonly counterparty: string | null;
  readonly due_date: string | null;
  readonly line_memo: string | null;
};

export type DocumentRow = {
  readonly number: string;
  readonly kind: string;
  readonly sequence_name: string;
  readonly ordinal: number;
  readonly issue_date: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly files: string;
  readonly created_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense'))
);
CREATE TABLE IF NOT EXISTS entries (
  seq           INTEGER PRIMARY KEY,
  entry_id      TEXT NOT NULL UNIQUE,
  date          TEXT NOT NULL,
  memo          TEXT NOT NULL,
  reference     TEXT NOT NULL,
  tags          TEXT NOT NULL,
  source_system TEXT,
  source_id     TEXT,
  base_currency TEXT NOT NULL,
  posted_at     TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
-- A partial index: the pair is unique WHEN there is a source, and an entry
-- posted by hand has neither, so a thousand manual entries do not collide on
-- (NULL, NULL). This is the constraint that actually stops a double post; the
-- SELECT in the same transaction is the readable half of the same rule.
CREATE UNIQUE INDEX IF NOT EXISTS entries_source
  ON entries (source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_date ON entries (date);
CREATE TABLE IF NOT EXISTS lines (
  entry_seq         INTEGER NOT NULL REFERENCES entries (seq),
  idx               INTEGER NOT NULL,
  account           TEXT NOT NULL,
  debit_minor       TEXT NOT NULL,
  credit_minor      TEXT NOT NULL,
  currency          TEXT NOT NULL,
  exponent          INTEGER NOT NULL,
  fx_rate           TEXT,
  base_debit_minor  TEXT NOT NULL,
  base_credit_minor TEXT NOT NULL,
  counterparty      TEXT,
  due_date          TEXT,
  line_memo         TEXT,
  PRIMARY KEY (entry_seq, idx)
);
CREATE INDEX IF NOT EXISTS lines_account ON lines (account);
CREATE TABLE IF NOT EXISTS idempotency (
  key          TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result       TEXT NOT NULL,
  claimed_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  next  INTEGER NOT NULL,
  start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  number          TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  sequence_name   TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  issue_date      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash    TEXT NOT NULL,
  files           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
`;

export type OpenMode = "read" | "write";

/**
 * Open the ledger file.
 *
 * `read` opens with SQLite's own read-only flag rather than a promise to
 * behave: `LedgerQuery` and `LedgerReconcile` are declared read-only tools,
 * and a declaration the database does not enforce is a comment. It also means
 * a query against a ledger that does not exist is a refusal naming the path,
 * not an empty ledger conjured into existence by the act of reading it.
 */
export function openDb(
  realPath: string,
  mode: OpenMode,
  busyTimeoutMs: number,
  /**
   * What to call the file in a message. Every other refusal in this package
   * names the workspace-relative path, and this one used to name the absolute
   * one — putting the machine's home directory into a result that goes
   * straight into a model's context. Defaults to the real path for the
   * in-memory and direct-library callers, which have no relative form.
   */
  label = realPath,
): Database {
  if (mode === "read") {
    // Checked before the open rather than after: SQLite defers the real work,
    // so a missing file surfaces as a confusing error on the first query
    // instead of here, where the path can still be named.
    if (!existsSync(realPath)) {
      throw new LedgerError(
        `no ledger at "${label}" — LedgerPost creates one; a read will not, because an empty ledger that answers "balance: 0" is worse than a refusal`,
      );
    }
    const db = new Database(realPath, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    assertSchemaVersion(db);
    return db;
  }
  mkdirSync(dirname(realPath), { recursive: true });
  const db = new Database(realPath, { create: true });
  // WAL so a reader is never blocked by the writer, and the busy timeout so a
  // second writer waits for the lock instead of failing the posting outright.
  db.run("PRAGMA journal_mode = WAL");
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.run("PRAGMA foreign_keys = ON");
  // The DDL runs only when the tables are absent. `CREATE TABLE IF NOT EXISTS`
  // is a no-op on an existing schema but still wants the write lock, so a
  // second writer would fail HERE — with a raw SQLITE_BUSY from an open, not
  // with the sentence `inImmediateTransaction` produces — and the caller would
  // be told the wrong thing about what went wrong.
  const built = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'")
    .get();
  if (built === null) {
    db.run(SCHEMA);
    writeMeta(db, "schemaVersion", String(SCHEMA_VERSION));
  } else {
    assertSchemaVersion(db);
  }
  return db;
}

function assertSchemaVersion(db: Database): void {
  const found = readMeta(db, "schemaVersion");
  if (found === null) {
    throw new LedgerError(
      "this file is not a crewhaus ledger (it has no schema version) — refusing to write into a database somebody else owns",
    );
  }
  if (found !== String(SCHEMA_VERSION)) {
    throw new LedgerError(
      `the ledger was written by schema version ${found} and this build speaks ${SCHEMA_VERSION} — refusing rather than migrating a book of record without being asked`,
    );
  }
}

export function readMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row === null ? null : row.value;
}

export function writeMeta(db: Database, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?", [
    key,
    value,
    value,
  ]);
}

/** The chain's tip: the last entry's hash and how many entries it covers. */
export type ChainHead = { readonly hash: string; readonly length: number };

/**
 * The head is stored, not derived.
 *
 * A prefix of a valid hash chain is itself a valid hash chain, so recomputing
 * the head from the rows cannot tell a complete ledger from one somebody
 * truncated. The stored head can: `length` disagreeing with the row count is
 * the only evidence that entries were removed.
 */
export function readHead(db: Database): ChainHead {
  const hash = readMeta(db, "chainHead") ?? GENESIS_HASH;
  const length = Number(readMeta(db, "chainLength") ?? "0");
  return { hash, length };
}

/** The bytes one entry's hash is taken over. Order is fixed by canonicalJson. */
export function entryHash(prevHash: string, payload: unknown): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(payload)}`);
}

export type ChainVerification = {
  readonly ok: boolean;
  readonly entries: number;
  readonly head: string;
  readonly storedHead: string;
  readonly storedLength: number;
  readonly problems: ReadonlyArray<{ readonly seq: number | null; readonly reason: string }>;
};

/**
 * Walk the chain from the genesis hash and report every break.
 *
 * Reports ALL of them rather than the first: "the chain broke at entry 4" and
 * "the chain broke at entries 4, 900 and 901" are different findings, and the
 * second one is the one that means somebody edited the file.
 */
export function verifyChain(
  db: Database,
  payloadOf: (entry: EntryRow, lines: ReadonlyArray<LineRow>) => unknown,
): ChainVerification {
  const entries = db.query("SELECT * FROM entries ORDER BY seq ASC").all() as EntryRow[];
  const lines = db.query("SELECT * FROM lines ORDER BY entry_seq ASC, idx ASC").all() as LineRow[];
  const byEntry = new Map<number, LineRow[]>();
  for (const line of lines) {
    const bucket = byEntry.get(line.entry_seq);
    if (bucket === undefined) byEntry.set(line.entry_seq, [line]);
    else bucket.push(line);
  }
  const problems: Array<{ seq: number | null; reason: string }> = [];
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      problems.push({
        seq: entry.seq,
        reason: `sequence jumps from ${expectedSeq - 1} to ${entry.seq}; entries were removed`,
      });
      expectedSeq = entry.seq;
    }
    if (entry.prev_hash !== prev) {
      problems.push({
        seq: entry.seq,
        reason: `prev_hash ${entry.prev_hash.slice(0, 12)}… does not follow ${prev.slice(0, 12)}…`,
      });
    }
    const recomputed = entryHash(entry.prev_hash, payloadOf(entry, byEntry.get(entry.seq) ?? []));
    if (recomputed !== entry.hash) {
      problems.push({
        seq: entry.seq,
        reason: `the stored hash does not match the entry's contents — this entry was edited after it was posted`,
      });
    }
    prev = entry.hash;
    expectedSeq += 1;
  }
  const stored = readHead(db);
  if (stored.hash !== prev) {
    problems.push({
      seq: null,
      reason: `the recorded head ${stored.hash.slice(0, 12)}… is not the last entry's hash ${prev.slice(0, 12)}… — entries were removed from the end`,
    });
  }
  if (stored.length !== entries.length) {
    problems.push({
      seq: null,
      reason: `the ledger records ${stored.length} entries and ${entries.length} are present`,
    });
  }
  return {
    ok: problems.length === 0,
    entries: entries.length,
    head: prev,
    storedHead: stored.hash,
    storedLength: stored.length,
    problems: problems.sort(
      (a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || byString(a.reason, b.reason),
    ),
  };
}

/**
 * A rollback asked for on purpose.
 *
 * `dryRun` runs the real posting — every validation, every insert, the chain
 * advance, the claim — and then throws this to undo it. Running a separate
 * "check only" path instead is how a dry run comes back clean and the real
 * call fails: the two paths drift, and the one nobody exercises is the one
 * that matters.
 */
export class DryRunRollback extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) {
    super("dry run: rolled back on purpose");
    this.name = "DryRunRollback";
    this.payload = payload;
  }
}

/**
 * Run `work` inside one `BEGIN IMMEDIATE`, and turn SQLite's lock failure into
 * a sentence that names the cause.
 *
 * The distinction matters for a caller deciding whether to retry: "another
 * writer holds the ledger" is worth retrying and "debits do not equal credits"
 * never is, and a bare `SQLITE_BUSY` stack trace tells a model neither.
 */
export function inImmediateTransaction<T>(db: Database, work: () => T): T {
  const tx = db.transaction(work);
  try {
    return tx.immediate() as T;
  } catch (err) {
    if (err instanceof DryRunRollback) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/SQLITE_BUSY|database is locked|database table is locked/i.test(message)) {
      throw new LedgerError(
        `another writer holds the ledger's write lock and it did not clear within the busy timeout — nothing was posted, the claim was not taken and the chain head did not move; retry the call unchanged (${message})`,
      );
    }
    throw err;
  }
}

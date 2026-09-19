import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
/**
 * The libraries, tested where the behaviour lives.
 *
 * Nothing here opens a socket, reads a clock or depends on the order a
 * directory lists its files. The one thing that is genuinely time-dependent —
 * `postedAt`, which is inside the hash chain — is passed in explicitly by
 * every test that touches it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LedgerError,
  assertInstant,
  assertIsoDate,
  canonicalJson,
  convertMinor,
  dayDiff,
  exponentFor,
  formatMajor,
  multiplyMinor,
  parseFactor,
  parseMajor,
  parseMinorUnits,
  sha256Hex,
} from "./lib/amount";
import {
  DryRunRollback,
  GENESIS_HASH,
  inImmediateTransaction,
  openDb,
  readHead,
  verifyChain,
  writeMeta,
} from "./lib/db";
import {
  BUILTIN_TEMPLATES,
  allocateDocument,
  computeInvoice,
  formatAmount,
  numberFor,
  renderTemplate,
  sequenceNameFor,
  validateInvoiceDates,
} from "./lib/invoice";
import { ensureAccounts, entryPayload, inferAccountType, postBatch } from "./lib/post";
import { renderRows, runQuery } from "./lib/query";
import { reconcile } from "./lib/reconcile";

const AT = "2026-03-01T00:00:00.000Z";

function memory(): Database {
  // ":memory:" goes through the same schema creation as a file, so these tests
  // exercise the real DDL; the transaction tests that need a second connection
  // use a real file instead, because two connections cannot share memory.
  return openDb(":memory:", "write", 100);
}

function seeded(): Database {
  const db = memory();
  writeMeta(db, "baseCurrency", "USD");
  writeMeta(db, "baseExponent", "2");
  ensureAccounts(db, [
    { code: "1000", name: "Bank", type: "asset" },
    { code: "1100", name: "Receivables", type: "asset" },
    { code: "2000", name: "Payables", type: "liability" },
    { code: "4000", name: "Sales", type: "income" },
    { code: "7000", name: "Fees", type: "expense" },
    { code: "7100", name: "FX rounding", type: "expense" },
  ]);
  return db;
}

const config = (over: Record<string, unknown> = {}) => ({
  baseCurrency: "USD",
  baseExponent: 2,
  autoCreateAccounts: false,
  postedAt: AT,
  idempotencyKey: "k",
  dryRun: false,
  ...over,
});

const simpleEntry = (over: Record<string, unknown> = {}) => ({
  date: "2026-01-05",
  memo: "sale",
  lines: [
    { account: "1100", debit: "100.00" },
    { account: "4000", credit: "100.00" },
  ],
  ...over,
});

// ---------------------------------------------------------------------------

describe("amounts", () => {
  test("a decimal string becomes exact minor units", () => {
    expect(parseMajor("100.00", 2, "x").toString()).toBe("10000");
    expect(parseMajor("-3.5", 2, "x").toString()).toBe("-350");
    expect(parseMajor("1250", 0, "x").toString()).toBe("1250");
  });

  test("a scale the currency cannot hold is refused, not rounded", () => {
    // 0.005 is the classic: rounding it silently is how a total stops matching
    // the document it was typed from.
    expect(() => parseMajor("1.005", 2, "unitAmount")).toThrow(
      /decimal places.*refusing to round/s,
    );
  });

  test("the yen exponent is 0 and an unknown code is refused rather than assumed", () => {
    expect(exponentFor("JPY")).toBe(0);
    expect(exponentFor("USD")).toBe(2);
    expect(() => exponentFor("ZZZ")).toThrow(/not in this package's ISO 4217 table/);
  });

  test("0.1 + 0.2 stays exact, because neither is ever a float", () => {
    const sum = parseMajor("0.1", 2, "a") + parseMajor("0.2", 2, "b");
    expect(formatMajor(sum, 2)).toBe("0.30");
  });

  test("a multiplication rounds once, half-even", () => {
    // 1999 * 0.075 = 149.925 minor units. Half-even takes it to 150, not 149.
    expect(multiplyMinor(1999n, parseFactor("0.075", "f")).toString()).toBe("150");
    expect(multiplyMinor(10000n, parseFactor("1.5", "f")).toString()).toBe("15000");
  });

  test("a conversion honours both exponents", () => {
    // 100.00 EUR at 1.10 into a 0-decimal currency.
    expect(convertMinor(10000n, parseFactor("1.10", "r"), 2, 0).toString()).toBe("110");
  });

  test("minor units must be whole numbers", () => {
    expect(parseMinorUnits(1050, "a").toString()).toBe("1050");
    expect(() => parseMinorUnits(10.5, "a")).toThrow(/whole number of minor units/);
  });

  test("a date that does not exist is refused rather than rolled forward", () => {
    expect(assertIsoDate("2026-02-28", "d")).toBe("2026-02-28");
    expect(() => assertIsoDate("2026-02-30", "d")).toThrow(/not a date that exists/);
    expect(() => assertIsoDate("05/01/2026", "d")).toThrow(/ISO calendar date/);
  });

  test("an instant without a UTC offset is refused", () => {
    expect(assertInstant("2026-01-01T00:00:00Z", "t")).toBe("2026-01-01T00:00:00.000Z");
    expect(() => assertInstant("2026-01-01T00:00:00", "t")).toThrow(/no UTC offset/);
  });

  test("dayDiff counts calendar days in UTC", () => {
    expect(dayDiff("2026-03-01", "2026-02-28")).toBe(1);
    expect(dayDiff("2027-01-01", "2026-01-01")).toBe(365);
  });

  test("canonical JSON is insertion-order independent, so a hash cannot drift", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 1n })).toBe('{"a":"1"}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
  });

  test("sha256Hex is the plain digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

// ---------------------------------------------------------------------------

describe("posting: the double-entry rule", () => {
  test("a balanced entry posts and chains from the genesis hash", () => {
    const db = seeded();
    const result = postBatch(db, [simpleEntry()], config());
    expect(result.posted.length).toBe(1);
    expect(result.rejected).toEqual([]);
    const posted = result.posted[0] as NonNullable<(typeof result.posted)[0]>;
    expect(posted.seq).toBe(1);
    expect(posted.total).toBe("100.00");
    expect(readHead(db)).toEqual({ hash: posted.hash, length: 1 });
    expect(verifyChain(db, entryPayload).ok).toBe(true);
    db.close();
  });

  test("an unbalanced entry is refused with the difference named", () => {
    const db = seeded();
    const result = postBatch(
      db,
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "100.00" },
            { account: "4000", credit: "99.00" },
          ],
        }),
      ],
      config(),
    );
    expect(result.posted).toEqual([]);
    expect((result.rejected[0] as { reason: string }).reason).toMatch(
      /does not balance.*difference of 1\.00/s,
    );
    db.close();
  });

  test("one bad entry does not stop the good ones, and the reasons carry the index", () => {
    const db = seeded();
    const result = postBatch(
      db,
      [
        simpleEntry(),
        simpleEntry({
          lines: [
            { account: "1100", debit: "5.00" },
            { account: "4000", credit: "4.00" },
          ],
        }),
        simpleEntry({ memo: "third" }),
      ],
      config(),
    );
    expect(result.posted.map((p) => p.seq)).toEqual([1, 2]);
    expect(result.rejected.map((r) => r.index)).toEqual([1]);
    db.close();
  });

  test("a negative debit is refused rather than read as a credit", () => {
    const db = seeded();
    const result = postBatch(
      db,
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "-100.00" },
            { account: "4000", credit: "-100.00" },
          ],
        }),
      ],
      config(),
    );
    expect((result.rejected[0] as { reason: string }).reason).toMatch(/negative debit is a credit/);
    db.close();
  });

  test("a zero line, a two-sided line and a one-line entry are each refused", () => {
    const db = seeded();
    const cases: Array<[unknown, RegExp]> = [
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "0.00" },
            { account: "4000", credit: "0.00" },
          ],
        }),
        /zero amount/,
      ],
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "1.00", credit: "1.00" },
            { account: "4000", credit: "1.00" },
          ],
        }),
        /both a debit and a credit/,
      ],
      [simpleEntry({ lines: [{ account: "1100", debit: "1.00" }] }), /at least two/],
      [
        simpleEntry({ lines: [{ account: "1100" }, { account: "4000", credit: "1.00" }] }),
        /no amount on either side/,
      ],
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "1.00", debitMinor: 100 },
            { account: "4000", credit: "1.00" },
          ],
        }),
        /one amount, one spelling/,
      ],
      [simpleEntry({ memo: "  " }), /empty memo/],
    ];
    for (const [index, [entry, pattern]] of cases.entries()) {
      // A distinct key per case: a batch in which everything was rejected
      // still claims its key (replaying it must return the same rejections),
      // so re-using one here would be caught by the key-reuse refusal instead.
      const result = postBatch(db, [entry as never], config({ idempotencyKey: `k${index}` }));
      expect((result.rejected[0] as { reason: string }).reason).toMatch(pattern);
    }
    db.close();
  });

  test("an unknown account is refused, and autoCreateAccounts is what changes that", () => {
    const db = seeded();
    const strict = postBatch(
      db,
      [
        simpleEntry({
          lines: [
            { account: "9999", debit: "1.00" },
            { account: "4000", credit: "1.00" },
          ],
        }),
      ],
      config(),
    );
    expect((strict.rejected[0] as { reason: string }).reason).toMatch(
      /not in the chart of accounts/,
    );
    const lax = postBatch(
      db,
      [
        simpleEntry({
          lines: [
            { account: "9999", debit: "1.00" },
            { account: "4000", credit: "1.00" },
          ],
        }),
      ],
      config({ idempotencyKey: "k2", autoCreateAccounts: true }),
    );
    expect(lax.posted.length).toBe(1);
    db.close();
  });

  test("a closed period stays closed", () => {
    const db = seeded();
    const result = postBatch(db, [simpleEntry()], config({ lockedBefore: "2026-02-01" }));
    expect((result.rejected[0] as { reason: string }).reason).toMatch(/locked period boundary/);
    db.close();
  });

  test("the same (source system, id) cannot post twice", () => {
    const db = seeded();
    const source = { system: "stripe", id: "ch_1" };
    expect(postBatch(db, [simpleEntry({ source })], config()).posted.length).toBe(1);
    const again = postBatch(db, [simpleEntry({ source })], config({ idempotencyKey: "k2" }));
    expect(again.posted).toEqual([]);
    expect((again.rejected[0] as { reason: string }).reason).toMatch(/was already posted as entry/);
    db.close();
  });

  test("account types are guessed from the numbering, which is why auto-create is opt-in", () => {
    expect(inferAccountType("1000")).toBe("asset");
    expect(inferAccountType("4010")).toBe("income");
    expect(inferAccountType("cost-of-sales")).toBe("expense");
  });
});

// ---------------------------------------------------------------------------

describe("posting: multi-currency", () => {
  const foreign = (rate: string, over: Record<string, unknown> = {}) =>
    simpleEntry({
      memo: "eur sale",
      lines: [
        { account: "1100", debit: "100.00", currency: "EUR", fxRate: rate },
        { account: "4000", credit: "110.00" },
      ],
      ...over,
    });

  test("a foreign line converts into the base currency and balances there", () => {
    const db = seeded();
    const result = postBatch(db, [foreign("1.10")], config({ fxAccount: "7100" }));
    expect(result.posted.length).toBe(1);
    expect((result.posted[0] as { fxResidueMinor: string }).fxResidueMinor).toBe("0");
    db.close();
  });

  test("a rounding residue goes to the fx account and is reported, not hidden", () => {
    const db = seeded();
    // 100.00 EUR at 1.1001 is 110.01 base against a 110.00 credit: one minor
    // unit, which is what a single rounded conversion can produce.
    const result = postBatch(db, [foreign("1.1001")], config({ fxAccount: "7100" }));
    const posted = result.posted[0] as { fxResidueMinor: string; lines: number };
    expect(posted.fxResidueMinor).toBe("1");
    expect(posted.lines).toBe(3);
    const rows = db
      .query("SELECT account, credit_minor FROM lines WHERE entry_seq = 1 AND idx = 2")
      .all() as Array<{
      account: string;
      credit_minor: string;
    }>;
    expect(rows[0]).toEqual({ account: "7100", credit_minor: "1" });
    db.close();
  });

  test("a residue larger than rounding can explain is refused, not booked to fx", () => {
    const db = seeded();
    // 0.91 instead of 1.10 — the transposed rate. The difference is 19.00, and
    // absorbing that into "FX rounding" would hide a real loss.
    const result = postBatch(db, [foreign("0.91")], config({ fxAccount: "7100" }));
    expect(result.posted).toEqual([]);
    expect((result.rejected[0] as { reason: string }).reason).toMatch(
      /wrong fx rate, not a rounding residue/,
    );
    db.close();
  });

  test("a residue with no fxAccount configured is refused rather than dropped on a line", () => {
    const db = seeded();
    const result = postBatch(db, [foreign("1.1001")], config());
    expect((result.rejected[0] as { reason: string }).reason).toMatch(/no fxAccount is configured/);
    db.close();
  });

  test("a foreign line with no rate, and a base line with one, are both refused", () => {
    const db = seeded();
    const noRate = postBatch(
      db,
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "100.00", currency: "EUR" },
            { account: "4000", credit: "110.00" },
          ],
        }),
      ],
      config({ fxAccount: "7100" }),
    );
    expect((noRate.rejected[0] as { reason: string }).reason).toMatch(/carries no fxRate/);
    const pointless = postBatch(
      db,
      [
        simpleEntry({
          lines: [
            { account: "1100", debit: "100.00", fxRate: "1.1" },
            { account: "4000", credit: "100.00" },
          ],
        }),
      ],
      config({ fxAccount: "7100", idempotencyKey: "k2" }),
    );
    expect((pointless.rejected[0] as { reason: string }).reason).toMatch(
      /already in the base currency/,
    );
    db.close();
  });

  test("per-currency totals are reported alongside the base-currency test", () => {
    const db = seeded();
    const result = postBatch(db, [foreign("1.10")], config({ fxAccount: "7100" }));
    expect((result.posted[0] as { perCurrency: unknown }).perCurrency).toEqual([
      { currency: "EUR", debitMinor: "10000", creditMinor: "0" },
      { currency: "USD", debitMinor: "0", creditMinor: "11000" },
    ]);
    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("the one transaction", () => {
  test("a throw anywhere inside rolls back the rows, the head AND the claim", () => {
    // This is the failure the whole design is against: a crash between the
    // rows and the claim leaves a chain that verifies and a duplicate
    // suppression that has forgotten the entry.
    const db = seeded();
    postBatch(db, [simpleEntry()], config());
    const before = readHead(db);
    expect(() =>
      inImmediateTransaction(db, () => {
        db.run(
          "INSERT INTO idempotency (key, payload_hash, result, claimed_at) VALUES ('k9','h','{}',?)",
          [AT],
        );
        db.run(
          "INSERT INTO entries (seq, entry_id, date, memo, reference, tags, base_currency, posted_at, prev_hash, hash) VALUES (2,'e2','2026-01-06','x','','[]','USD',?,?,'deadbeef')",
          [AT, before.hash],
        );
        writeMeta(db, "chainHead", "deadbeef");
        throw new Error("power cut");
      }),
    ).toThrow(/power cut/);
    expect(readHead(db)).toEqual(before);
    expect((db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n).toBe(1);
    expect(db.query("SELECT key FROM idempotency WHERE key = 'k9'").get()).toBe(null);
    db.close();
  });

  test("dryRun is the same code path, rolled back — no rows, no claim, no head move", () => {
    const db = seeded();
    const result = postBatch(db, [simpleEntry()], config({ dryRun: true }));
    expect(result.posted.length).toBe(1);
    expect(result.dryRun).toBe(true);
    expect((db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n).toBe(0);
    expect(db.query("SELECT key FROM idempotency WHERE key = 'k'").get()).toBe(null);
    expect(readHead(db)).toEqual({ hash: GENESIS_HASH, length: 0 });
    db.close();
  });

  test("the rollback sentinel carries the result rather than losing it", () => {
    const err = new DryRunRollback({ posted: [] });
    expect(err.payload).toEqual({ posted: [] });
  });

  test("replaying a key returns the first result and posts nothing new", () => {
    const db = seeded();
    const first = postBatch(db, [simpleEntry()], config());
    const second = postBatch(db, [simpleEntry()], config());
    expect(second.replayed).toBe(true);
    expect(second.posted).toEqual(first.posted);
    expect((db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("re-using a key for different content is refused", () => {
    const db = seeded();
    postBatch(db, [simpleEntry()], config());
    expect(() => postBatch(db, [simpleEntry({ memo: "something else" })], config())).toThrow(
      /already used for a DIFFERENT batch/,
    );
    db.close();
  });

  test("the write lock is taken at BEGIN, before the transaction has written anything", () => {
    // This is what IMMEDIATE buys, and the reason every check-then-act in
    // `postBatch` is safe: the reads inside (is this key claimed? what is the
    // head? what is the next invoice number?) already serialize against
    // another writer. A DEFERRED transaction passes every other test in this
    // file — it still fails when the lock is held from the start — and still
    // lets a second writer slip in between our read and our first write.
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-ledger-lock-"));
    const file = join(dir, "ledger.sqlite");
    const db = openDb(file, "write", 100);
    const other = new SqliteDatabase(file);
    other.run("PRAGMA busy_timeout = 0");
    let otherCouldTakeTheLock: boolean | null = null;
    try {
      inImmediateTransaction(db, () => {
        // Nothing has been written inside this transaction yet.
        try {
          other.run("BEGIN IMMEDIATE");
          other.run("ROLLBACK");
          otherCouldTakeTheLock = true;
        } catch {
          otherCouldTakeTheLock = false;
        }
        return 0;
      });
    } finally {
      other.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(otherCouldTakeTheLock).toBe(false);
    // 20s because it opens two SQLite connections on a real file in WAL mode,
    // which is instant here and is a lock handshake plus fsyncs on CI.
  }, 20_000);

  test("a ledger whose recorded length disagrees with its rows is not appended to", () => {
    const db = seeded();
    postBatch(db, [simpleEntry()], config());
    writeMeta(db, "chainLength", "7");
    expect(() => postBatch(db, [simpleEntry()], config({ idempotencyKey: "k2" }))).toThrow(
      /modified outside this tool/,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("the hash chain", () => {
  test("editing a posted entry is detected", () => {
    const db = seeded();
    postBatch(db, [simpleEntry(), simpleEntry({ memo: "two" })], config());
    db.run("UPDATE entries SET memo = 'edited' WHERE seq = 1");
    const check = verifyChain(db, entryPayload);
    expect(check.ok).toBe(false);
    expect(check.problems.map((p) => p.reason).join(" ")).toMatch(/edited after it was posted/);
    db.close();
  });

  test("editing an AMOUNT is detected, because the lines are inside the hash", () => {
    const db = seeded();
    postBatch(db, [simpleEntry()], config());
    db.run("UPDATE lines SET debit_minor = '999900' WHERE entry_seq = 1 AND idx = 0");
    expect(verifyChain(db, entryPayload).ok).toBe(false);
    db.close();
  });

  test("truncating the ledger is detected, which recomputing the head alone would miss", () => {
    const db = seeded();
    postBatch(db, [simpleEntry(), simpleEntry({ memo: "two" })], config());
    db.run("DELETE FROM lines WHERE entry_seq = 2");
    db.run("DELETE FROM entries WHERE seq = 2");
    const check = verifyChain(db, entryPayload);
    expect(check.ok).toBe(false);
    expect(check.problems.map((p) => p.reason).join(" ")).toMatch(
      /recorded head.*is not the last entry's hash/s,
    );
    db.close();
  });

  test("EVERY break is reported, not the first", () => {
    // "the chain broke at entry 1" and "the chain broke at entries 1 and 3"
    // are different findings, and only the second one says somebody went
    // through the file. Stopping at the first break hides the shape of it.
    const db = seeded();
    postBatch(
      db,
      [simpleEntry(), simpleEntry({ memo: "two" }), simpleEntry({ memo: "three" })],
      config(),
    );
    db.run("UPDATE entries SET memo = 'edited one' WHERE seq = 1");
    db.run("UPDATE lines SET debit_minor = '999900' WHERE entry_seq = 3 AND idx = 0");
    const check = verifyChain(db, entryPayload);
    expect(check.ok).toBe(false);
    expect(check.problems.filter((p) => /edited after it was posted/.test(p.reason))).toHaveLength(
      2,
    );
    expect(check.problems.map((p) => p.seq)).toContain(1);
    expect(check.problems.map((p) => p.seq)).toContain(3);
    db.close();
  });

  test("an untouched chain verifies", () => {
    const db = seeded();
    postBatch(
      db,
      [simpleEntry(), simpleEntry({ memo: "two" }), simpleEntry({ memo: "three" })],
      config(),
    );
    expect(verifyChain(db, entryPayload)).toMatchObject({ ok: true, entries: 3, problems: [] });
    db.close();
  });
});

// ---------------------------------------------------------------------------

describe("the views", () => {
  function books(): Database {
    const db = seeded();
    postBatch(
      db,
      [
        {
          date: "2026-01-05",
          memo: "invoice",
          reference: "INV-1",
          tags: ["q1"],
          lines: [
            { account: "1100", debit: "100.00", counterparty: "Acme", dueDate: "2026-02-04" },
            { account: "4000", credit: "100.00" },
          ],
        },
        {
          date: "2026-02-10",
          memo: "fee",
          lines: [
            { account: "7000", debit: "3.00" },
            { account: "1000", credit: "3.00" },
          ],
        },
      ],
      config(),
    );
    return db;
  }
  const options = (over: Record<string, unknown>) => ({
    baseCurrency: "USD",
    baseExponent: 2,
    limit: 100,
    filter: {},
    ...over,
  });

  test("the trial balance balances and signs each account by its type", () => {
    const db = books();
    const result = runQuery(db, options({ view: "trial_balance" }) as never);
    expect(result.totals["balanced"]).toBe(true);
    const sales = result.rows.find((r) => r["account"] === "4000");
    // Income is a credit-normal account, so a credit balance reads positive.
    expect(sales?.["balance"]).toBe("100.00");
    db.close();
  });

  test("the P&L nets income against expense", () => {
    const db = books();
    const result = runQuery(db, options({ view: "pnl" }) as never);
    expect(result.totals["netIncome"]).toBe("97.00");
    db.close();
  });

  test("the balance sheet carries the period's earnings and reports the difference", () => {
    const db = books();
    const result = runQuery(db, options({ view: "balance_sheet" }) as never);
    expect(result.totals["retainedEarnings"]).toBe("97.00");
    expect(result.totals["balanced"]).toBe(true);
    db.close();
  });

  test("account_ledger runs a balance and refuses more than one account", () => {
    const db = books();
    const result = runQuery(
      db,
      options({ view: "account_ledger", filter: { accounts: ["1100"] } }) as never,
    );
    expect(result.totals["closingBalance"]).toBe("100.00");
    expect(() =>
      runQuery(
        db,
        options({ view: "account_ledger", filter: { accounts: ["1100", "1000"] } }) as never,
      ),
    ).toThrow(/reports ONE account/);
    db.close();
  });

  test("a date range and a tag filter select", () => {
    const db = books();
    expect(
      runQuery(db, options({ view: "journal", filter: { from: "2026-02-01" } }) as never).rowCount,
    ).toBe(2);
    expect(
      runQuery(db, options({ view: "journal", filter: { tag: "q1" } }) as never).rowCount,
    ).toBe(2);
    expect(
      runQuery(db, options({ view: "search", filter: { text: "FEE" } }) as never).rowCount,
    ).toBe(2);
    db.close();
  });

  test("amount bounds compare numbers, not strings", () => {
    const db = books();
    // As text "300" sorts above "10000"; as integers it does not.
    const result = runQuery(
      db,
      options({ view: "search", filter: { amountMinMinor: "1000" } }) as never,
    );
    expect(result.rowCount).toBe(2);
    db.close();
  });
});

describe("aging refuses rather than answering partially", () => {
  function receivables(withDue: boolean, withCounterparty: boolean): Database {
    const db = seeded();
    postBatch(
      db,
      [
        {
          date: "2026-01-05",
          memo: "invoice",
          lines: [
            {
              account: "1100",
              debit: "100.00",
              ...(withCounterparty ? { counterparty: "Acme" } : {}),
              ...(withDue ? { dueDate: "2026-02-04" } : {}),
            },
            { account: "4000", credit: "100.00" },
          ],
        },
      ],
      config(),
    );
    return db;
  }
  const aging = (over: Record<string, unknown>) => ({
    view: "aging",
    baseCurrency: "USD",
    baseExponent: 2,
    limit: 100,
    filter: { accounts: ["1100"] },
    ...over,
  });

  test("no asOf is a refusal, because the clock would move the report", () => {
    const db = receivables(true, true);
    expect(() => runQuery(db, aging({}) as never)).toThrow(/needs an explicit asOf/);
    db.close();
  });

  test("no accounts is a refusal", () => {
    const db = receivables(true, true);
    expect(() => runQuery(db, aging({ asOf: "2026-03-01", filter: {} }) as never)).toThrow(
      /needs the accounts to age/,
    );
    db.close();
  });

  test("a missing counterparty is refused, naming the field and the count", () => {
    const db = receivables(true, false);
    expect(() => runQuery(db, aging({ asOf: "2026-03-01" }) as never)).toThrow(
      /needs "counterparty" on every line and 1 of 1/,
    );
    db.close();
  });

  test("no dueDate anywhere is refused, rather than reporting everything as current", () => {
    const db = receivables(false, true);
    expect(() => runQuery(db, aging({ asOf: "2026-03-01" }) as never)).toThrow(
      /needs "dueDate".*everything would land in "current"|not one of the 1 selected lines has it/s,
    );
    db.close();
  });

  test("a payment with no due date is unapplied, NOT folded into current", () => {
    // The trap this bucket exists to avoid: a credit with no due date dropped
    // into "current" quietly cancels an overdue invoice, and the 100.00 that
    // is 34 days past due disappears from the report that exists to chase it.
    const db = seeded();
    postBatch(
      db,
      [
        {
          date: "2026-01-05",
          memo: "invoice",
          lines: [
            { account: "1100", debit: "100.00", counterparty: "Acme", dueDate: "2026-02-04" },
            { account: "4000", credit: "100.00" },
          ],
        },
        {
          date: "2026-02-20",
          memo: "payment on account",
          lines: [
            { account: "1100", credit: "100.00", counterparty: "Acme" },
            { account: "1000", debit: "100.00" },
          ],
        },
      ],
      config(),
    );
    const result = runQuery(
      db,
      aging({ asOf: "2026-03-10", filter: { accounts: ["1100"] } }) as never,
    );
    expect(result.rows[0]).toMatchObject({
      counterparty: "Acme",
      "31-60": "100.00",
      unapplied: "-100.00",
      current: "0.00",
    });
    expect(result.totals["current"]).toBe("0.00");
    expect(result.totals["unapplied"]).toBe("-100.00");
    // And the caller is told, rather than left to notice the column.
    expect(String((result.notes ?? [])[0])).toMatch(/not counted as current/);
    db.close();
  });

  test("with both fields the amount lands in the bucket its due date puts it in", () => {
    const db = receivables(true, true);
    const result = runQuery(db, aging({ asOf: "2026-03-10" }) as never);
    // Due 2026-02-04, as of 2026-03-10 is 34 days past due.
    expect(result.rows[0]).toMatchObject({
      counterparty: "Acme",
      "31-60": "100.00",
      current: "0.00",
    });
    db.close();
  });
});

describe("rendering rows", () => {
  test("CSV quotes what RFC 4180 says to quote", () => {
    expect(renderRows([{ a: 'x,"y"', b: 1 }], "csv")).toBe('a,b\n"x,""y""",1');
  });

  test("markdown escapes the pipe that would break the table", () => {
    expect(renderRows([{ a: "x|y" }], "markdown")).toContain("x\\|y");
  });

  test("columns come from the first row, so a later stray key cannot move them", () => {
    const out = renderRows([{ a: 1, b: 2 }, { a: 3, b: 4, c: 5 } as never], "csv");
    expect(out.split("\n")[0]).toBe("a,b");
  });
});

// ---------------------------------------------------------------------------

const row = (id: string, date: string, amountMinor: number, reference = "", description = "") => ({
  id,
  date,
  description,
  amountMinor,
  direction: amountMinor < 0 ? ("debit" as const) : ("credit" as const),
  reference,
  balanceMinor: null,
});

const reconcileOptions = (over: Record<string, unknown> = {}) => ({
  toleranceMinor: 0n,
  windowDays: 3,
  allowManyToOne: true,
  maxSubsetSize: 6,
  maxCombinations: 200_000,
  feeToleranceMinor: 0n,
  requireReferenceMatch: false,
  exponent: 2,
  currency: "USD",
  ...over,
});

describe("reconciliation", () => {
  test("a penny apart is a NEAR MISS, never a match — both sides stay unmatched", () => {
    // The headline rule. Pairing these destroys the only evidence that
    // something is wrong.
    const result = reconcile(
      [row("L1", "2026-01-05", 10000)],
      [row("R1", "2026-01-05", 10001)],
      reconcileOptions({ toleranceMinor: 5n }),
    );
    expect(result.matched).toEqual([]);
    expect(result.nearMisses.length).toBe(1);
    expect(result.nearMisses[0]).toMatchObject({
      leftId: "L1",
      rightId: "R1",
      amountDelta: "-0.01",
    });
    expect(result.unmatchedLeft.map((u) => u.id)).toEqual(["L1"]);
    expect(result.unmatchedRight.map((u) => u.id)).toEqual(["R1"]);
  });

  test("with no tolerance the same pair is simply unmatched on both sides", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000)],
      [row("R1", "2026-01-05", 10001)],
      reconcileOptions(),
    );
    expect(result.matched).toEqual([]);
    expect(result.nearMisses).toEqual([]);
    expect(result.summary.differenceMinor).toBe("-1");
  });

  test("identical amounts inside the window match", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000)],
      [row("R1", "2026-01-07", 10000)],
      reconcileOptions(),
    );
    expect(result.matched[0]).toMatchObject({
      kind: "amount-date",
      leftIds: ["L1"],
      rightId: "R1",
    });
  });

  test("outside the window they do not", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000)],
      [row("R1", "2026-01-20", 10000)],
      reconcileOptions(),
    );
    expect(result.matched).toEqual([]);
  });

  test("a reference disagreement survives a later amount match elsewhere", () => {
    // L1 and R1 carry one identifier and disagree by a penny. R2 happens to
    // carry L1's amount, so the amount-date pass claims L1. Dropping the near
    // miss then deletes the only record that two documents bearing the same
    // number disagree about the money — the finding this module exists to
    // preserve — and leaves R1 unmatched with nothing saying why.
    const result = reconcile(
      [row("L1", "2026-01-05", 10_000, "INV-1")],
      [row("R1", "2026-01-05", 10_001, "INV-1"), row("R2", "2026-01-05", 10_000, "")],
      reconcileOptions({ toleranceMinor: 5n }),
    );
    expect(result.matched.map((m) => m.rightId)).toEqual(["R2"]);
    expect(result.nearMisses).toHaveLength(1);
    expect(result.nearMisses[0]).toMatchObject({ kind: "reference", leftId: "L1", rightId: "R1" });
    expect(result.summary.nearMissCount).toBe(1);
    expect(result.unmatchedRight.map((u) => u.id)).toEqual(["R1"]);
  });

  test("a matching reference with a different amount is the most interesting row, so it is not matched", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000, "INV-77")],
      [row("R1", "2026-01-05", 9500, "inv 77")],
      reconcileOptions(),
    );
    expect(result.matched).toEqual([]);
    expect(result.nearMisses[0]?.why).toMatch(/reference "INV-77" is the same on both sides/);
  });

  test("a matching reference and amount beats the date window", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000, "INV-77")],
      [row("R1", "2026-06-05", 10000, "INV-77")],
      reconcileOptions(),
    );
    expect(result.matched[0]).toMatchObject({ kind: "reference", dateDeltaDays: -151 });
  });

  test("one left row is never consumed by two right rows", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000)],
      [row("R1", "2026-01-05", 10000), row("R2", "2026-01-05", 10000)],
      reconcileOptions(),
    );
    expect(result.matched.length).toBe(1);
    expect(result.unmatchedRight.map((u) => u.id)).toEqual(["R2"]);
  });

  test("a bundle that sums exactly is found, and the choice is the same on every run", () => {
    // 40 + 60 and 30 + 70 both make 100. The canonical rule — smallest
    // cardinality, then the pool's (date, id) order — picks one, and picks the
    // same one every time, so a proposed fee entry does not move between runs.
    const left = [
      row("L1", "2026-01-05", 3000),
      row("L2", "2026-01-05", 7000),
      row("L3", "2026-01-05", 4000),
      row("L4", "2026-01-05", 6000),
    ];
    const right = [row("R1", "2026-01-06", 10000)];
    const first = reconcile(left, right, reconcileOptions());
    const second = reconcile([...left].reverse(), right, reconcileOptions());
    expect(first.matched[0]?.leftIds).toEqual(["L1", "L2"]);
    expect(second.matched[0]?.leftIds).toEqual(first.matched[0]?.leftIds);
  });

  test("a bundle short by a fee is matched only when a fee tolerance is set, and the fee is named", () => {
    const left = [row("L1", "2026-01-05", 6000), row("L2", "2026-01-05", 4000)];
    const right = [row("R1", "2026-01-06", 9710)];
    expect(reconcile(left, right, reconcileOptions()).matched).toEqual([]);
    const withFee = reconcile(left, right, reconcileOptions({ feeToleranceMinor: 500n }));
    expect(withFee.matched[0]).toMatchObject({ kind: "grouped-with-fee", feeMinor: "290" });
  });

  test("a payout LARGER than the charges it claims to bundle is not a fee", () => {
    const left = [row("L1", "2026-01-05", 6000), row("L2", "2026-01-05", 4000)];
    const right = [row("R1", "2026-01-06", 10100)];
    expect(reconcile(left, right, reconcileOptions({ feeToleranceMinor: 500n })).matched).toEqual(
      [],
    );
  });

  test("the grouped search gives up at the cap and says which row it gave up on", () => {
    const left = Array.from({ length: 40 }, (_, i) => row(`L${i}`, "2026-01-05", 1000 + i));
    const result = reconcile(
      left,
      [row("R1", "2026-01-05", 999_999)],
      reconcileOptions({ maxCombinations: 50 }),
    );
    expect(result.groupingTruncated).toEqual(["R1"]);
    expect(result.matched).toEqual([]);
  });

  test("allowManyToOne off skips the bundle pass entirely", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 3000), row("L2", "2026-01-05", 7000)],
      [row("R1", "2026-01-05", 10000)],
      reconcileOptions({ allowManyToOne: false }),
    );
    expect(result.matched).toEqual([]);
  });

  test("requireReferenceMatch stops after the reference pass", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 10000)],
      [row("R1", "2026-01-05", 10000)],
      reconcileOptions({ requireReferenceMatch: true }),
    );
    expect(result.matched).toEqual([]);
    expect(result.unmatchedLeft.length).toBe(1);
  });

  test("duplicate ids on one side are refused rather than resolved arbitrarily", () => {
    expect(() =>
      reconcile([row("L1", "2026-01-05", 1), row("L1", "2026-01-06", 2)], [], reconcileOptions()),
    ).toThrow(/share the id "L1"/);
  });

  test("a non-ISO date on an input row is refused", () => {
    expect(() => reconcile([row("L1", "05/01/2026", 1)], [], reconcileOptions())).toThrow(
      /ISO calendar date/,
    );
  });

  test("a fee proposal carries the payout's date, so LedgerPost would accept it", () => {
    const result = reconcile(
      [row("L1", "2026-01-05", 6000), row("L2", "2026-01-05", 4000)],
      [row("R1", "2026-01-08", 9710)],
      reconcileOptions({
        feeToleranceMinor: 500n,
        propose: { bankAccount: "1000", feeAccount: "7000", suspenseAccount: "9999" },
      }),
    );
    expect(result.proposedEntries[0]).toMatchObject({
      date: "2026-01-08",
      lines: [
        { account: "7000", debitMinor: "290" },
        { account: "1000", creditMinor: "290" },
      ],
    });
  });

  test("a tolerance near miss the grouped pass later explains is not reported twice", () => {
    // L1 is a penny away from R1, so the near-miss pass flags it; the grouped
    // pass then finds that L1 + L2 make R1 exactly. Leaving it in both lists
    // would have a reviewer chase a row that is already accounted for.
    const result = reconcile(
      [row("L1", "2026-01-05", 9999), row("L2", "2026-01-05", 1)],
      [row("R1", "2026-01-05", 10000)],
      reconcileOptions({ toleranceMinor: 5n }),
    );
    expect(result.matched[0]).toMatchObject({ kind: "grouped", leftIds: ["L1", "L2"] });
    expect(result.nearMisses).toEqual([]);
    expect(result.summary.nearMissCount).toBe(0);
  });

  test("proposed entries balance, and are returned rather than posted", () => {
    const result = reconcile(
      [],
      [row("R1", "2026-01-05", -2500, "", "bank charge")],
      reconcileOptions({
        propose: { bankAccount: "1000", feeAccount: "7000", suspenseAccount: "9999" },
      }),
    );
    const proposal = result.proposedEntries[0];
    expect(proposal?.lines).toEqual([
      { account: "9999", debitMinor: "2500" },
      { account: "1000", creditMinor: "2500" },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("invoice totals", () => {
  test("a fractional quantity is exact and the tax is computed from the net", () => {
    const { lines, totals } = computeInvoice(
      [{ description: "consulting", quantity: "1.5", unitAmountMinor: 10_000, taxRateBps: 2000 }],
      2,
    );
    expect(lines[0]).toMatchObject({ netMinor: "15000", taxMinor: "3000", totalMinor: "18000" });
    expect(totals.totalMinor).toBe("18000");
  });

  test("a discount comes off before tax", () => {
    const { totals } = computeInvoice(
      [{ description: "x", unitAmountMinor: 10_000, discountMinor: 1_000, taxRateBps: 2000 }],
      2,
    );
    expect(totals).toMatchObject({
      subtotalMinor: "10000",
      discountMinor: "1000",
      netMinor: "9000",
      taxMinor: "1800",
      totalMinor: "10800",
    });
  });

  test("the four figures the document shows add up: subtotal - discount + tax = total", () => {
    // Recomputed by hand from the spec, not from the implementation: one line
    // of 100.00, 10.00 off, 20% on the 90.00 net. 100.00 - 10.00 + 18.00 =
    // 108.00. With `subtotal` reported as the NET, the same four rows read
    // 90.00 - 10.00 + 18.00 = 98.00, and the page disagrees with its own
    // total in front of the person being asked to pay it.
    const { lines, totals } = computeInvoice(
      [{ description: "x", unitAmountMinor: 10_000, discountMinor: 1_000, taxRateBps: 2000 }],
      2,
    );
    const subtotal = BigInt(totals.subtotalMinor);
    const discount = BigInt(totals.discountMinor);
    const tax = BigInt(totals.taxMinor);
    expect((subtotal - discount + tax).toString()).toBe(totals.totalMinor);
    expect(totals.totalMinor).toBe("10800");
    // And the line column sums to the same total, so both halves of the page
    // agree with each other as well as with themselves.
    expect(lines.reduce((sum, l) => sum + BigInt(l.totalMinor), 0n).toString()).toBe(
      totals.totalMinor,
    );
  });

  test("the same identity holds across several lines and a zero-decimal currency", () => {
    // JPY, exponent 0: 3 x 1500 less 200, plus 10% of the 4300 net = 430.
    const { totals } = computeInvoice(
      [
        { description: "a", quantity: "3", unitAmountMinor: 1_500, discountMinor: 200 },
        { description: "b", unitAmountMinor: 1_000, taxRateBps: 1000 },
      ],
      0,
    );
    expect(totals).toMatchObject({
      subtotalMinor: "5500",
      discountMinor: "200",
      netMinor: "5300",
      taxMinor: "100",
      totalMinor: "5400",
    });
    expect(
      (
        BigInt(totals.subtotalMinor) -
        BigInt(totals.discountMinor) +
        BigInt(totals.taxMinor)
      ).toString(),
    ).toBe(totals.totalMinor);
  });

  test("a line break in a description is refused rather than shifting the columns", () => {
    expect(() =>
      computeInvoice([{ description: "Widget\nDeluxe", unitAmountMinor: 100 }], 2),
    ).toThrow(/line break inside its description/);
  });

  test("a tax rate AND an explicit tax amount is refused — two sources of truth", () => {
    expect(() =>
      computeInvoice(
        [{ description: "x", unitAmountMinor: 100, taxRateBps: 2000, taxMinor: 20 }],
        2,
      ),
    ).toThrow(/two sources of truth/);
  });

  test("a discount larger than the line, a negative quantity and an empty invoice are refused", () => {
    expect(() =>
      computeInvoice([{ description: "x", unitAmountMinor: 100, discountMinor: 200 }], 2),
    ).toThrow(/cannot be worth less than nothing/);
    expect(() =>
      computeInvoice([{ description: "x", unitAmountMinor: 100, quantity: "-1" }], 2),
    ).toThrow(/negative quantity/);
    expect(() => computeInvoice([], 2)).toThrow(/no lines is not a document/);
  });

  test("amounts render from exact digits with the caller's separators, never through Intl", () => {
    expect(formatAmount(123_456_789n, 2)).toBe("1234567.89");
    expect(formatAmount(123_456_789n, 2, { groupSeparator: ".", decimalSeparator: "," })).toBe(
      "1.234.567,89",
    );
    expect(formatAmount(-5n, 2)).toBe("-0.05");
  });

  test("a due date before the issue date is a transposed pair, not a document", () => {
    expect(() => validateInvoiceDates("2026-02-01", "2026-01-01")).toThrow(/before issueDate/);
  });
});

describe("invoice numbering", () => {
  const numbering = { prefix: "INV-", pad: 5, resetYearly: true, start: 1 };
  const allocate = (db: Database, key: string, issueDate = "2026-01-05", hash = "h") =>
    allocateDocument(db, {
      kind: "invoice",
      config: numbering,
      issueDate,
      idempotencyKey: key,
      payloadHash: hash,
      files: [],
      createdAt: AT,
    });

  test("numbers are consecutive and the sequence reports itself gap-free", () => {
    const db = memory();
    expect(allocate(db, "a").number).toBe("INV-2026-00001");
    expect(allocate(db, "b").number).toBe("INV-2026-00002");
    expect(allocate(db, "c")).toMatchObject({ ordinal: 3, gapFree: true });
    db.close();
  });

  test("the yearly reset takes its year from the issue date, not from the clock", () => {
    const db = memory();
    // Deliberately back-dated: a document issued in December and rendered in
    // January belongs to December's sequence.
    expect(allocate(db, "a", "2025-12-31").number).toBe("INV-2025-00001");
    expect(allocate(db, "b", "2026-01-01").number).toBe("INV-2026-00001");
    expect(sequenceNameFor("invoice", numbering, "2025-12-31")).toBe("invoice:2025");
    db.close();
  });

  test("with no yearly reset the sequence is one run", () => {
    const db = memory();
    const flat = { prefix: "Q-", pad: 3, resetYearly: false, start: 10 };
    expect(numberFor(flat, "2026-01-01", 10)).toBe("Q-010");
    expect(
      allocateDocument(db, {
        kind: "quote",
        config: flat,
        issueDate: "2026-01-01",
        idempotencyKey: "a",
        payloadHash: "h",
        files: [],
        createdAt: AT,
      }).number,
    ).toBe("Q-010");
    db.close();
  });

  test("the same key returns the same number and burns nothing", () => {
    const db = memory();
    const first = allocate(db, "a");
    const again = allocate(db, "a");
    expect(again).toMatchObject({ number: first.number, replayed: true });
    expect(allocate(db, "b").ordinal).toBe(2);
    db.close();
  });

  test("the same key for different content is refused — one number, one document", () => {
    const db = memory();
    allocate(db, "a");
    expect(() => allocate(db, "a", "2026-01-05", "different")).toThrow(/for different content/);
    db.close();
  });

  test("a gap made by hand is reported rather than assumed away", () => {
    const db = memory();
    allocate(db, "a");
    allocate(db, "b");
    db.run("DELETE FROM documents WHERE ordinal = 1");
    expect(allocate(db, "c").gapFree).toBe(false);
    db.close();
  });
});

describe("the template", () => {
  const data = {
    number: "INV-1",
    seller: { name: "A & Co", taxId: "" },
    lines: [{ description: "x" }, { description: "y" }],
    empty: [],
  };

  test("a variable is escaped and a triple-brace one is not", () => {
    expect(renderTemplate("{{seller.name}}", data, { escape: escapeForTest, strict: true })).toBe(
      "A &amp; Co",
    );
    expect(renderTemplate("{{{seller.name}}}", data, { escape: escapeForTest, strict: true })).toBe(
      "A & Co",
    );
  });

  test("an array section iterates and an inverted one fires when it is empty", () => {
    expect(
      renderTemplate("{{#lines}}[{{description}}]{{/lines}}", data, {
        escape: escapeForTest,
        strict: true,
      }),
    ).toBe("[x][y]");
    expect(
      renderTemplate("{{^empty}}none{{/empty}}", data, { escape: escapeForTest, strict: true }),
    ).toBe("none");
    expect(
      renderTemplate("{{#empty}}some{{/empty}}", data, { escape: escapeForTest, strict: true }),
    ).toBe("");
  });

  test("an unknown placeholder is refused in strict mode and blank otherwise", () => {
    expect(() =>
      renderTemplate("{{seller.vatNumber}}", data, { escape: escapeForTest, strict: true }),
    ).toThrow(/has no value for/);
    expect(
      renderTemplate("{{seller.vatNumber}}", data, { escape: escapeForTest, strict: false }),
    ).toBe("");
  });

  test("a mismatched or unclosed section is refused rather than rendered wrong", () => {
    expect(() =>
      renderTemplate("{{#lines}}x{{/empty}}", data, { escape: escapeForTest, strict: true }),
    ).toThrow(/closes \{\{\/empty\}\}/);
    expect(() =>
      renderTemplate("{{#lines}}x", data, { escape: escapeForTest, strict: true }),
    ).toThrow(/unclosed/);
  });

  test("the built-in templates render the shipped model without a strict-mode refusal", () => {
    const model = {
      kindLabel: "Invoice",
      number: "INV-1",
      currency: "USD",
      issueDate: "2026-01-01",
      dueDate: "",
      reference: "",
      notes: "",
      paymentInstructions: "",
      seller: { name: "S", address: ["1 Road"], taxId: "T", email: "", phone: "" },
      buyer: { name: "B", address: [], taxId: "", email: "", phone: "" },
      lines: [{ description: "x", quantity: "1", unitAmount: "1.00", tax: "0.00", total: "1.00" }],
      totals: { subtotal: "1.00", discount: "0.00", tax: "0.00", total: "1.00" },
    };
    for (const template of Object.values(BUILTIN_TEMPLATES)) {
      const out = renderTemplate(template, model, { escape: escapeForTest, strict: true });
      expect(out).toContain("INV-1");
      expect(out).toContain("1.00");
    }
  });
});

function escapeForTest(text: string): string {
  return text.split("&").join("&amp;");
}

describe("errors", () => {
  test("every refusal in this package is a LedgerError, so a caller can tell one from a crash", () => {
    expect(() => exponentFor("ZZZ")).toThrow(LedgerError);
    expect(() => assertIsoDate("nope", "d")).toThrow(LedgerError);
  });
});

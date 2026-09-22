import { Database } from "bun:sqlite";
/**
 * The four tools, through their own schemas and their own `execute`.
 *
 * Two claims in the package-wide block are load-bearing and are asserted here
 * rather than trusted: nothing in this package can move money, and no schema
 * anywhere in it accepts a credential that would let it. Both checks assert
 * their own hit count, because a scan that silently matched nothing is a green
 * test that proves nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statementParse } from "@crewhaus/tool-money";
import type { ZodTypeAny } from "zod";
import {
  LEDGER_TOOLS,
  _setClock,
  invoiceRender,
  ledgerPost,
  ledgerQuery,
  ledgerReconcile,
} from "./index";

const SRC = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and no tool here reads it.
const ctx = {} as any;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-ledger-"));
  process.chdir(workspace);
  // The clock is inside the hash chain, so every test fixes it. Nothing in
  // this suite asserts a wall-clock value.
  _setClock(() => Date.parse("2026-03-01T00:00:00Z"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setClock(Date.now);
});

type Tool = (typeof LEDGER_TOOLS)[number];

async function raw(tool: Tool, input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(tool: Tool, input: unknown): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

const ACCOUNTS = [
  { code: "1000", name: "Bank", type: "asset" as const },
  { code: "1100", name: "Receivables", type: "asset" as const },
  { code: "4000", name: "Sales", type: "income" as const },
  { code: "7000", name: "Fees", type: "expense" as const },
  { code: "7100", name: "FX", type: "expense" as const },
  { code: "9999", name: "Suspense", type: "asset" as const },
];

const sale = (over: Record<string, unknown> = {}) => ({
  date: "2026-01-05",
  memo: "sale",
  lines: [
    { account: "1100", debit: "100.00", counterparty: "Acme", dueDate: "2026-02-04" },
    { account: "4000", credit: "100.00" },
  ],
  ...over,
});

async function seed(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return call(ledgerPost, {
    idempotencyKey: "seed",
    baseCurrency: "USD",
    accounts: ACCOUNTS,
    entries: [sale()],
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("every tool is exported in LEDGER_TOOLS, with unique PascalCase names", () => {
    expect(LEDGER_TOOLS.length).toBe(4);
    const names = LEDGER_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("the flags say what each tool does: two read, two write, none reaches out", () => {
    for (const tool of LEDGER_TOOLS) {
      expect({ name: tool.name, scope: tool.scope }).toEqual({
        name: tool.name,
        scope: "internal",
      });
      expect({ name: tool.name, io: tool.ioCapability }).toEqual({
        name: tool.name,
        io: undefined,
      });
    }
    expect(
      LEDGER_TOOLS.filter((t) => t.readOnly)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["LedgerQuery", "LedgerReconcile"]);
    expect(
      LEDGER_TOOLS.filter((t) => t.destructive)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["InvoiceRender", "LedgerPost"]);
  });

  test("every description says what the tool is for", () => {
    for (const tool of LEDGER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(200);
      expect(tool.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const tool of LEDGER_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(42).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });

  test("every schema is strict, so a misspelled field is a refusal and not a silent default", async () => {
    await expect(raw(ledgerQuery, { view: "journal", limitt: 5 })).rejects.toThrow(
      /schema rejected/,
    );
  });
});

// ---------------------------------------------------------------------------

/** Every object key in a zod schema, however deeply nested. */
function schemaKeys(schema: unknown, seen = new Set<unknown>()): string[] {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (def === undefined) return [];
  const out: string[] = [];
  const typeName = def["typeName"];
  if (typeName === "ZodObject") {
    const shape = (def["shape"] as () => Record<string, ZodTypeAny>)();
    for (const [key, value] of Object.entries(shape)) {
      out.push(key, ...schemaKeys(value, seen));
    }
    return out;
  }
  for (const key of ["innerType", "type", "schema", "valueType", "keyType", "element"]) {
    if (def[key] !== undefined) out.push(...schemaKeys(def[key], seen));
  }
  for (const key of ["options", "items"]) {
    const list = def[key];
    if (Array.isArray(list)) for (const item of list) out.push(...schemaKeys(item, seen));
  }
  return out;
}

describe("nothing here can move money", () => {
  /**
   * The nouns a tool would need to take before it could pay anybody. The
   * package builds documents and writes a local book; sending an instruction
   * to a bank is a different job with different gates, and there is no field
   * to hand a credential to.
   */
  const FORBIDDEN = [
    "privatekey",
    "secret",
    "apikey",
    "password",
    "token",
    "credential",
    "cvv",
    "cardnumber",
    "accountnumber",
    "routingnumber",
    "iban",
    "bic",
    "sortcode",
    "mnemonic",
    "keystore",
    "bankdetails",
  ];

  test("no schema in this package accepts a credential", () => {
    const keys = LEDGER_TOOLS.flatMap((t) => schemaKeys(t.inputSchema));
    // The scan asserts its own reach: a walker that silently returned nothing
    // would make every assertion below pass without checking anything.
    expect(keys.length).toBeGreaterThan(60);
    expect(keys).toContain("idempotencyKey");
    expect(keys).toContain("fxRate");
    expect(keys).toContain("paymentInstructions");
    const lowered = keys.map((k) => k.toLowerCase());
    for (const forbidden of FORBIDDEN) {
      expect({ forbidden, at: lowered.filter((k) => k.includes(forbidden)) }).toEqual({
        forbidden,
        at: [],
      });
    }
  });

  test("no source file in this package can open a connection", () => {
    // Plain string entries rather than Dirents: `Dirent.parentPath` is newer
    // than `Dirent.path` and this suite runs on two Bun versions.
    const files = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
      .map((name) => join(SRC, name));
    // Again: assert the scan found the files, or "no matches" means nothing.
    expect(files.length).toBeGreaterThanOrEqual(7);
    const outward =
      /\bfetch\s*\(|globalThis\.fetch|XMLHttpRequest|new WebSocket|node:https?|node:net|node:dgram|node:tls|Bun\.(connect|serve|listen)|child_process|node:worker_threads/;
    for (const file of files) {
      expect({ file, reaches: outward.test(readFileSync(file, "utf-8")) }).toEqual({
        file,
        reaches: false,
      });
    }
  });

  test("the schema regex would actually catch a credential field, so the check is not vacuous", () => {
    // A control: the same walker over a schema that DOES take one finds it.
    const { z } = require("zod") as typeof import("zod");
    const bad = z.object({ payout: z.object({ iban: z.string() }) });
    expect(schemaKeys(bad).map((k) => k.toLowerCase())).toContain("iban");
  });
});

// ---------------------------------------------------------------------------

describe("LedgerPost", () => {
  test("a first post fixes the base currency, and a later call cannot change it", async () => {
    await seed();
    await expect(
      raw(ledgerPost, { idempotencyKey: "x", baseCurrency: "EUR", entries: [sale()] }),
    ).rejects.toThrow(/base currency is USD and the call says EUR/);
  });

  test("a new ledger with no base currency stated is refused rather than defaulted", async () => {
    await expect(raw(ledgerPost, { idempotencyKey: "x", entries: [sale()] })).rejects.toThrow(
      /state baseCurrency on the first post/,
    );
  });

  test("the posted entry, the chain head and the claim all land together", async () => {
    const result = await seed();
    expect((result["posted"] as unknown[]).length).toBe(1);
    const chain = await call(ledgerQuery, { view: "chain" });
    expect((chain["chain"] as { ok: boolean }).ok).toBe(true);
    const replay = await seed();
    expect(replay["replayed"]).toBe(true);
  });

  test("a dry run reports what would happen and writes nothing", async () => {
    await seed();
    const dry = await call(ledgerPost, {
      idempotencyKey: "dry",
      accounts: ACCOUNTS,
      entries: [sale({ memo: "would post" })],
      dryRun: true,
    });
    expect(dry["dryRun"]).toBe(true);
    expect((dry["posted"] as unknown[]).length).toBe(1);
    const journal = await call(ledgerQuery, { view: "journal", text: "would post" });
    expect(journal["rowCount"]).toBe(0);
  });

  test("a second writer holding the lock fails with the reason, and posts nothing", async () => {
    // Asserts the REASON, not just the failure: a timeout would also make this
    // call throw, and "it threw" would not distinguish the two.
    await seed();
    const other = new Database(join(workspace, ".crewhaus/ledger.sqlite"));
    other.run("PRAGMA busy_timeout = 0");
    other.run("BEGIN IMMEDIATE");
    try {
      await expect(
        raw(ledgerPost, {
          idempotencyKey: "blocked",
          entries: [sale({ memo: "blocked" })],
          busyTimeoutMs: 50,
        }),
      ).rejects.toThrow(/write lock|busy|locked/i);
    } finally {
      other.run("ROLLBACK");
      other.close();
    }
    const after = await call(ledgerQuery, { view: "journal", text: "blocked" });
    expect(after["rowCount"]).toBe(0);
    // And the claim was rolled back with everything else, so the retry works.
    const retry = await call(ledgerPost, {
      idempotencyKey: "blocked",
      entries: [sale({ memo: "blocked" })],
    });
    expect(retry["replayed"]).toBe(false);
    expect((retry["posted"] as unknown[]).length).toBe(1);
    // 20s because this is two SQLite connections contending on a file: fast
    // here, and CI is a loaded two-core box where the lock handshake and the
    // WAL fsyncs are not.
  }, 20_000);

  test("a malformed entry is rejected by index and does not stop the rest of the batch", async () => {
    const result = await call(ledgerPost, {
      idempotencyKey: "mixed",
      baseCurrency: "USD",
      accounts: ACCOUNTS,
      entries: [
        sale(),
        // One line: structurally fine, not double entry. It comes back as a
        // rejection with its index, not as a failed call.
        sale({ memo: "half an entry", lines: [{ account: "1100", debit: "1.00" }] }),
        sale({ memo: "third" }),
      ],
    });
    expect((result["posted"] as Array<{ seq: number }>).map((p) => p.seq)).toEqual([1, 2]);
    expect(result["rejected"]).toEqual([
      { index: 1, reason: expect.stringContaining("double entry needs at least two") },
    ]);
  });

  test("a postedAt without a UTC offset is refused, because it is inside the hash", async () => {
    await expect(
      raw(ledgerPost, {
        idempotencyKey: "x",
        baseCurrency: "USD",
        accounts: ACCOUNTS,
        entries: [sale()],
        postedAt: "2026-01-01T00:00:00",
      }),
    ).rejects.toThrow(/no UTC offset/);
  });

  test("a dbPath outside the workspace is refused", async () => {
    await expect(
      raw(ledgerPost, {
        idempotencyKey: "x",
        baseCurrency: "USD",
        dbPath: "../escape.sqlite",
        entries: [sale()],
      }),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test("a file that is not a crewhaus ledger is not written into", async () => {
    writeFileSync(join(workspace, "notes.sqlite"), "not a database at all");
    await expect(
      raw(ledgerPost, {
        idempotencyKey: "x",
        baseCurrency: "USD",
        dbPath: "notes.sqlite",
        entries: [sale()],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("LedgerQuery", () => {
  test("a ledger that does not exist is a refusal, not an empty balance", async () => {
    await expect(raw(ledgerQuery, { view: "trial_balance" })).rejects.toThrow(/no ledger at/);
  });

  test("the refusal names the workspace-relative path, not this machine's", async () => {
    // Every result in this package goes into a model's context. Naming the
    // absolute path puts the home directory there with it, and every other
    // message in this package already names the relative one.
    const err = await raw(ledgerQuery, { view: "trial_balance", dbPath: "books/l.sqlite" }).catch(
      (e: Error) => e,
    );
    expect(String(err)).toContain('"books/l.sqlite"');
    expect(String(err)).not.toContain(workspace);
  });

  test("it will not create the file it reads", async () => {
    await raw(ledgerQuery, { view: "trial_balance", dbPath: "nope.sqlite" }).catch(() => undefined);
    expect(existsSync(join(workspace, "nope.sqlite"))).toBe(false);
  });

  test("csv and markdown come back rendered, with the totals alongside", async () => {
    await seed();
    const csv = await call(ledgerQuery, { view: "trial_balance", format: "csv" });
    expect(String(csv["csv"]).split("\n")[0]).toContain("account,type,debitMinor");
    const md = await call(ledgerQuery, { view: "trial_balance", format: "markdown" });
    expect(String(md["markdown"])).toContain("| account |");
    expect((md["totals"] as { balanced: boolean }).balanced).toBe(true);
  });

  test("limit and truncated are reported rather than the list quietly ending", async () => {
    await seed();
    const result = await call(ledgerQuery, { view: "journal", limit: 1 });
    expect(result["truncated"]).toBe(true);
    expect((result["rows"] as unknown[]).length).toBe(1);
    expect(result["rowCount"]).toBe(2);
  });

  test("aging refuses when the lines cannot support it", async () => {
    await seed();
    await expect(raw(ledgerQuery, { view: "aging", accounts: ["1100"] })).rejects.toThrow(
      /needs an explicit asOf/,
    );
    await expect(
      raw(ledgerQuery, { view: "aging", accounts: ["4000"], asOf: "2026-03-01" }),
    ).rejects.toThrow(/needs "counterparty" on every line/);
  });

  test("a balance sheet as of a date does not include entries after it", async () => {
    await seed();
    await call(ledgerPost, {
      idempotencyKey: "later",
      entries: [
        {
          date: "2026-06-01",
          memo: "later sale",
          lines: [
            { account: "1100", debit: "50.00" },
            { account: "4000", credit: "50.00" },
          ],
        },
      ],
    });
    const asOf = await call(ledgerQuery, { view: "balance_sheet", asOf: "2026-03-01" });
    expect((asOf["totals"] as { assets: string }).assets).toBe("100.00");
    const everything = await call(ledgerQuery, { view: "balance_sheet" });
    expect((everything["totals"] as { assets: string }).assets).toBe("150.00");
  });

  test("a date that does not exist is refused before it reaches SQL", async () => {
    await seed();
    await expect(raw(ledgerQuery, { view: "journal", from: "2026-02-30" })).rejects.toThrow(
      /not a date that exists/,
    );
  });

  test("an aging as of a date does not include invoices posted after it", async () => {
    // The seeded sale is dated 2026-01-05 and due 2026-02-04. The one below
    // is dated and due months later, so as of 2026-03-01 it does not exist —
    // and if it is selected anyway its due date is in the future, so it lands
    // in "current" and the report says Acme owes 600.00 when Acme owes 100.00.
    // A collections call is made off that number.
    await seed();
    await call(ledgerPost, {
      idempotencyKey: "later",
      entries: [
        {
          date: "2026-08-05",
          memo: "august sale",
          lines: [
            { account: "1100", debit: "500.00", counterparty: "Acme", dueDate: "2026-09-04" },
            { account: "4000", credit: "500.00" },
          ],
        },
      ],
    });
    const asOf = await call(ledgerQuery, { view: "aging", accounts: ["1100"], asOf: "2026-03-01" });
    const totals = asOf["totals"] as Record<string, string>;
    expect(totals["current"]).toBe("0.00");
    expect(totals["1-30"]).toBe("100.00");
    expect((asOf["rows"] as Array<Record<string, string>>)[0]?.["total"]).toBe("100.00");
    // And the later entry does show up once the asOf date reaches it.
    const later = await call(ledgerQuery, {
      view: "aging",
      accounts: ["1100"],
      asOf: "2026-09-01",
    });
    expect((later["totals"] as Record<string, string>)["current"]).toBe("500.00");
  });

  test("an amount filter written in major units is refused by name, not by SyntaxError", async () => {
    // "50.00" for a fifty-dollar floor is the obvious thing to type, and it
    // went straight into BigInt(), which throws a bare parse error naming
    // neither the field nor the rule.
    await seed();
    await expect(raw(ledgerQuery, { view: "journal", amountMinMinor: "50.00" })).rejects.toThrow(
      /amountMinMinor must be a whole number of minor units/,
    );
    await expect(raw(ledgerQuery, { view: "journal", amountMaxMinor: 1e21 })).rejects.toThrow(
      /amountMaxMinor/,
    );
    // The honest spelling still works, and still filters.
    const ok = await call(ledgerQuery, { view: "journal", amountMinMinor: "5000" });
    expect(ok["rowCount"]).toBe(2);
  });

  test('"balanced" is null, not false, when the filter cuts entries in half', async () => {
    // Half an entry never balances. Reporting `false` here says the file was
    // edited outside the tool about a caller who typed an account filter.
    await seed();
    const whole = await call(ledgerQuery, { view: "trial_balance" });
    expect((whole["totals"] as { balanced: boolean | null }).balanced).toBe(true);
    expect(whole["notes"]).toBeUndefined();
    const oneLeg = await call(ledgerQuery, { view: "trial_balance", accounts: ["1100"] });
    expect((oneLeg["totals"] as { balanced: boolean | null }).balanced).toBe(null);
    expect(String((oneLeg["notes"] as string[])[0])).toMatch(/cannot be judged here/);
    // A date range keeps whole entries, so it is still judged.
    const dated = await call(ledgerQuery, { view: "trial_balance", from: "2026-01-01" });
    expect((dated["totals"] as { balanced: boolean | null }).balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const statementRow = (id: string, date: string, amountMinor: number, reference = "") => ({
  id,
  date,
  description: id,
  amountMinor,
  direction: amountMinor < 0 ? "debit" : "credit",
  reference,
  balanceMinor: null,
});

describe("LedgerReconcile", () => {
  test("it consumes StatementParse's rows verbatim — the shape is imported, not re-declared", async () => {
    writeFileSync(
      join(workspace, "bank.csv"),
      "Date,Description,Amount,Reference\n2026-01-05,Acme,100.00,INV-1\n2026-01-06,Fee,-3.00,\n",
    );
    // Drive tool-money's own tool, then hand its rows straight to this one. If
    // the shapes ever diverge, the schema below rejects them and this fails.
    const parsed = JSON.parse(await statementParse.execute({ file: "bank.csv" } as never, ctx)) as {
      transactions: unknown[];
    };
    expect(parsed.transactions.length).toBe(2);
    const result = await call(ledgerReconcile, {
      left: { kind: "lines", lines: parsed.transactions },
      right: { kind: "lines", lines: parsed.transactions },
      currency: "USD",
    });
    expect((result["summary"] as { matchedCount: number }).matchedCount).toBe(2);
  });

  test("a penny apart is reported as a near miss and left unmatched on both sides", async () => {
    const result = await call(ledgerReconcile, {
      left: { kind: "lines", lines: [statementRow("L1", "2026-01-05", 10000)] },
      right: { kind: "lines", lines: [statementRow("R1", "2026-01-05", 10001)] },
      toleranceMinor: 5,
      currency: "USD",
    });
    expect(result["matched"]).toEqual([]);
    expect((result["nearMisses"] as unknown[]).length).toBe(1);
    expect((result["unmatchedLeft"] as unknown[]).length).toBe(1);
    expect((result["unmatchedRight"] as unknown[]).length).toBe(1);
  });

  test("a ledger account reconciles against a statement", async () => {
    await seed();
    await call(ledgerPost, {
      idempotencyKey: "pay",
      entries: [
        {
          date: "2026-01-20",
          memo: "payment",
          reference: "PAY-1",
          lines: [
            { account: "1000", debit: "100.00" },
            { account: "1100", credit: "100.00", counterparty: "Acme" },
          ],
        },
      ],
    });
    const result = await call(ledgerReconcile, {
      left: { kind: "ledger", account: "1000" },
      right: { kind: "lines", lines: [statementRow("bank-1", "2026-01-21", 10000)] },
      currency: "USD",
    });
    expect((result["matched"] as Array<{ rightId: string }>)[0]?.rightId).toBe("bank-1");
  });

  test("a statement file whose dates are ambiguous is refused by tool-money's own rule", async () => {
    writeFileSync(
      join(workspace, "eu.csv"),
      "Date,Description,Amount\n03/04/2026,x,1.00\n05/06/2026,y,2.00\n",
    );
    await expect(
      raw(ledgerReconcile, {
        left: { kind: "statement", file: "eu.csv" },
        right: { kind: "lines", lines: [] },
      }),
    ).rejects.toThrow(/day-first or month-first/);
  });

  test("a statement path outside the workspace is refused", async () => {
    await expect(
      raw(ledgerReconcile, {
        left: { kind: "statement", file: "../../etc/passwd" },
        right: { kind: "lines", lines: [] },
      }),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test("a side that names a kind but not its source is refused", async () => {
    await expect(
      raw(ledgerReconcile, { left: { kind: "lines" }, right: { kind: "lines", lines: [] } }),
    ).rejects.toThrow(/no lines were given/);
    await expect(
      raw(ledgerReconcile, { left: { kind: "ledger" }, right: { kind: "lines", lines: [] } }),
    ).rejects.toThrow(/no account was given/);
  });

  test("proposed entries come back as drafts and nothing is posted", async () => {
    await seed();
    const before = await call(ledgerQuery, { view: "journal" });
    const result = await call(ledgerReconcile, {
      left: { kind: "lines", lines: [] },
      right: { kind: "lines", lines: [statementRow("R1", "2026-01-05", -2500)] },
      currency: "USD",
      propose: { bankAccount: "1000", feeAccount: "7000", suspenseAccount: "9999" },
    });
    expect((result["proposedEntries"] as unknown[]).length).toBe(1);
    const after = await call(ledgerQuery, { view: "journal" });
    expect(after["rowCount"]).toBe(before["rowCount"]);
  });
});

// ---------------------------------------------------------------------------

const invoiceInput = (over: Record<string, unknown> = {}) => ({
  kind: "invoice",
  idempotencyKey: "inv-1",
  currency: "USD",
  issueDate: "2026-01-05",
  dueDate: "2026-02-04",
  seller: { name: "Crew Haus", taxId: "GB123456789" },
  buyer: { name: "Acme Ltd", address: ["1 Road", "Town"] },
  lines: [{ description: "Consulting", quantity: "1.5", unitAmount: "100.00", taxRateBps: 2000 }],
  outputs: ["html", "markdown", "json"],
  ...over,
});

describe("InvoiceRender", () => {
  test("totals are computed, and the number comes from the sequence", async () => {
    const result = await call(invoiceRender, invoiceInput());
    expect(result["number"]).toBe("INV-00001");
    expect(result["totals"]).toMatchObject({ subtotal: "150.00", tax: "30.00", total: "180.00" });
    expect(result["gapFree"]).toBe(true);
  });

  test("numbers are consecutive across calls and the sequence stays gap-free", async () => {
    await call(invoiceRender, invoiceInput());
    const second = await call(invoiceRender, invoiceInput({ idempotencyKey: "inv-2" }));
    const third = await call(invoiceRender, invoiceInput({ idempotencyKey: "inv-3" }));
    expect([second["number"], third["number"]]).toEqual(["INV-00002", "INV-00003"]);
    expect(third["gapFree"]).toBe(true);
  });

  test("the same key returns the same number and re-renders byte-identical files", async () => {
    const first = await call(invoiceRender, invoiceInput({ outDir: "docs" }));
    const path = join(workspace, "docs", "INV-00001.html");
    const bytes = readFileSync(path);
    // The crash case: the number was recorded and the file never landed. The
    // retry must produce the same number and the same bytes, not a gap.
    rmSync(path);
    const again = await call(invoiceRender, invoiceInput({ outDir: "docs" }));
    expect(again["number"]).toBe(first["number"]);
    expect(again["replayed"]).toBe(true);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  test("the same key for different content is refused", async () => {
    await call(invoiceRender, invoiceInput());
    await expect(raw(invoiceRender, invoiceInput({ notes: "changed" }))).rejects.toThrow(
      /for different content/,
    );
  });

  test("the yearly reset takes its year from issueDate, never from the clock", async () => {
    // The clock says March 2026; the document is dated December 2025.
    const result = await call(
      invoiceRender,
      invoiceInput({
        issueDate: "2025-12-31",
        dueDate: "2026-01-30",
        numbering: { resetYearly: true },
      }),
    );
    expect(result["number"]).toBe("INV-2025-00001");
    expect(result["sequence"]).toBe("invoice:2025");
  });

  test("files are written under the workspace and named for the document", async () => {
    await call(invoiceRender, invoiceInput({ outDir: "out/2026" }));
    expect(readdirSync(join(workspace, "out/2026")).sort()).toEqual([
      "INV-00001.html",
      "INV-00001.json",
      "INV-00001.md",
    ]);
  });

  test("no temporary file is left behind", async () => {
    await call(invoiceRender, invoiceInput({ outDir: "docs" }));
    expect(readdirSync(join(workspace, "docs")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("an outDir outside the workspace is refused, and costs no number", async () => {
    await expect(raw(invoiceRender, invoiceInput({ outDir: "../outside" }))).rejects.toThrow(
      /escapes the workspace root/,
    );
    const ok = await call(invoiceRender, invoiceInput({ idempotencyKey: "after" }));
    expect(ok["number"]).toBe("INV-00001");
  });

  test("rendering nothing to disk returns the text instead", async () => {
    const result = await call(invoiceRender, invoiceInput({ outputs: ["markdown"] }));
    expect(result["files"]).toEqual([]);
    expect(String(result["markdown"])).toContain("| Consulting | 1.5 | 100.00 | 30.00 | 180.00 |");
  });

  test("HTML output escapes what a buyer's name could otherwise inject", async () => {
    const result = await call(
      invoiceRender,
      invoiceInput({ outputs: ["html"], buyer: { name: "<script>alert(1)</script>" } }),
    );
    expect(String(result["html"])).toContain("&lt;script&gt;");
    expect(String(result["html"])).not.toContain("<script>alert");
  });

  test("a custom template that names a field the document has no value for is refused", async () => {
    await expect(
      raw(invoiceRender, invoiceInput({ template: "{{buyer.vatNumber}}", outputs: ["markdown"] })),
    ).rejects.toThrow(/has no value for/);
    const lax = await call(
      invoiceRender,
      invoiceInput({
        template: "[{{buyer.vatNumber}}]",
        outputs: ["markdown"],
        strictTemplate: false,
      }),
    );
    expect(String(lax["markdown"])).toBe("[]");
  });

  test("a template that cannot render burns no number — the render is proved first", async () => {
    // Allocate-then-fail is the gap this ordering exists to prevent: the
    // render is where a bad template is found, so it happens before the
    // sequence is touched.
    await expect(
      raw(invoiceRender, invoiceInput({ template: "{{buyer.vatNumber}}", outputs: ["markdown"] })),
    ).rejects.toThrow(/has no value for/);
    const ok = await call(invoiceRender, invoiceInput({ idempotencyKey: "after" }));
    expect(ok["number"]).toBe("INV-00001");
    expect(ok["gapFree"]).toBe(true);
  });

  test("a template file is read from the workspace, and one outside it is refused", async () => {
    writeFileSync(join(workspace, "t.md"), "{{number}} {{totals.total}}");
    const result = await call(
      invoiceRender,
      invoiceInput({ templateFile: "t.md", outputs: ["markdown"] }),
    );
    expect(String(result["markdown"])).toBe("INV-00001 180.00");
    await expect(
      raw(invoiceRender, invoiceInput({ templateFile: "../t.md", outputs: ["markdown"] })),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test("template and templateFile together are refused", async () => {
    await expect(
      raw(invoiceRender, invoiceInput({ template: "{{number}}", templateFile: "t.md" })),
    ).rejects.toThrow(/not both/);
  });

  test("a due date before the issue date is refused", async () => {
    await expect(raw(invoiceRender, invoiceInput({ dueDate: "2026-01-01" }))).rejects.toThrow(
      /before issueDate/,
    );
  });

  test("an externally assigned number is recorded, and cannot be issued twice", async () => {
    const result = await call(invoiceRender, invoiceInput({ number: "MANUAL-7" }));
    expect(result["number"]).toBe("MANUAL-7");
    await expect(
      raw(invoiceRender, invoiceInput({ number: "MANUAL-7", idempotencyKey: "other" })),
    ).rejects.toThrow(/has already been issued/);
  });

  test("an externally assigned number reports gapFree as null, never true", async () => {
    // There is no sequence here to walk, so gap-freeness was not checked. A
    // gap in a document sequence is a finding in most jurisdictions, and
    // `true` from a check that never ran is the answer that gets believed.
    const external = await call(invoiceRender, invoiceInput({ number: "MANUAL-7" }));
    expect(external["gapFree"]).toBe(null);
    expect(String(external["gapFreeNote"])).toMatch(/has NOT verified it/);
    // A number this tool issued itself is still checked and still says so.
    const issued = await call(invoiceRender, invoiceInput({ idempotencyKey: "seq-1" }));
    expect(issued["gapFree"]).toBe(true);
    expect(issued["gapFreeNote"]).toBeUndefined();
  });

  test("a document number that walks out of outDir is refused before a number is spent", async () => {
    // The number becomes the FILE NAME under outDir. outDir is resolved
    // through the workspace resolver; the leaf was not, so "../../escaped"
    // wrote outside the workspace root — and the write ends in a rename, so
    // it replaces whatever was already at that path.
    const outside = join(workspace, "..", "escaped.json");
    await expect(
      raw(invoiceRender, invoiceInput({ number: "../../escaped", outDir: "docs" })),
    ).rejects.toThrow(/cannot be used as a document number/);
    expect(existsSync(outside)).toBe(false);

    // Same escape through the generated number, via the prefix.
    await expect(
      raw(invoiceRender, invoiceInput({ numbering: { prefix: "../../pfx-" }, outDir: "docs" })),
    ).rejects.toThrow(/cannot be used as a document number/);
    expect(existsSync(join(workspace, "..", "pfx-00001.json"))).toBe(false);

    // Neither refusal cost a number: the next real document is still the first.
    const ok = await call(invoiceRender, invoiceInput({ outDir: "docs" }));
    expect(ok["number"]).toBe("INV-00001");
    expect(ok["gapFree"]).toBe(true);
  });

  test("a pipe in a description cannot shift the markdown columns", async () => {
    // "Widget | Deluxe" renders six cells into a five-column table, so the
    // reader sees "Deluxe" as the quantity and — the last cell being dropped
    // — a Total of 0.00 on a line worth 100.00. Nothing computes a wrong
    // number; the document simply shows one.
    const result = await call(
      invoiceRender,
      invoiceInput({
        outputs: ["markdown"],
        lines: [{ description: "Widget | Deluxe", unitAmount: "100.00" }],
      }),
    );
    const line = String(result["markdown"])
      .split("\n")
      .find((row) => row.includes("Widget")) as string;
    expect(line).toContain("Widget \\| Deluxe");
    // Count the columns by hand: five headings, so five cells between six pipes.
    expect(line.split(/(?<!\\)\|/).length - 2).toBe(5);
    expect(line.trim().endsWith("| 100.00 |")).toBe(true);
  });

  test("the totals block on the rendered document adds up", async () => {
    // 150.00 of consulting, 15.00 off, 20% on the 135.00 net = 27.00, so
    // 150.00 - 15.00 + 27.00 = 162.00. A reader checking the four rows on the
    // page has to arrive at the total printed on it.
    const result = await call(
      invoiceRender,
      invoiceInput({
        outputs: ["markdown", "json"],
        lines: [
          {
            description: "Consulting",
            quantity: "1.5",
            unitAmount: "100.00",
            discount: "15.00",
            taxRateBps: 2000,
          },
        ],
      }),
    );
    const totals = result["totals"] as Record<string, string>;
    expect(totals).toMatchObject({
      subtotal: "150.00",
      discount: "15.00",
      tax: "27.00",
      total: "162.00",
    });
    const minor = (key: string): bigint => BigInt(totals[key] as string);
    expect((minor("subtotalMinor") - minor("discountMinor") + minor("taxMinor")).toString()).toBe(
      totals["totalMinor"],
    );
    const markdown = String(result["markdown"]);
    for (const row of ["| Subtotal | 150.00 USD |", "| Discount | 15.00 USD |"]) {
      expect(markdown).toContain(row);
    }
    expect(markdown).toContain("| **Total** | **162.00 USD** |");
  });

  test("a zero-decimal currency is not given cents", async () => {
    const result = await call(
      invoiceRender,
      invoiceInput({
        currency: "JPY",
        lines: [{ description: "x", unitAmount: "1500", taxRateBps: 1000 }],
        outputs: ["json"],
      }),
    );
    expect(result["totals"]).toMatchObject({ subtotal: "1500", tax: "150", total: "1650" });
  });

  test("an unknown currency is refused rather than assumed to have two decimals", async () => {
    await expect(raw(invoiceRender, invoiceInput({ currency: "ZZZ" }))).rejects.toThrow(
      /ISO 4217 table/,
    );
  });

  test("separators come from the caller, so the bytes cannot move with an ICU upgrade", async () => {
    const result = await call(
      invoiceRender,
      invoiceInput({
        outputs: ["markdown"],
        lines: [{ description: "x", unitAmount: "1234567.89" }],
        numberFormat: { groupSeparator: ".", decimalSeparator: "," },
      }),
    );
    expect(String(result["markdown"])).toContain("1.234.567,89");
  });
});

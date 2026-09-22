/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema before `execute` ever runs and turns a refusal into an error
 * result rather than a thrown stack.
 *
 * This file also walks one full bookkeeping cycle — post, report, invoice,
 * reconcile — because each of these tools is only worth anything if the next
 * one can read what it wrote.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { LEDGER_TOOLS, _setClock } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of LEDGER_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-ledger-int-"));
  process.chdir(workspace);
  _setClock(() => Date.parse("2026-03-01T00:00:00Z"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setClock(Date.now);
});

const ACCOUNTS = [
  { code: "1000", name: "Bank", type: "asset" },
  { code: "1100", name: "Receivables", type: "asset" },
  { code: "4000", name: "Sales", type: "income" },
  { code: "7000", name: "Fees", type: "expense" },
  { code: "9999", name: "Suspense", type: "asset" },
];

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(LEDGER_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of LEDGER_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("LedgerQuery"), { view: 42 }, { toolUseId: "t1" });
    expect(result.isError).toBe(true);
  });

  test("a refusal is an error result carrying the reason, not a crash", async () => {
    const result = await executeTool(
      lookup("LedgerPost"),
      {
        idempotencyKey: "k",
        baseCurrency: "USD",
        autoCreateAccounts: true,
        entries: [
          {
            date: "2026-01-05",
            memo: "wrong",
            lines: [
              { account: "1100", debit: "100.00" },
              { account: "4000", credit: "90.00" },
            ],
          },
        ],
      },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(false);
    // An unbalanced entry is a rejected ROW, not a failed call: the other
    // entries in the batch still posted, so the caller needs both lists.
    expect(result.content).toContain("does not balance");
  });

  test("a containment escape is an error result", async () => {
    const result = await executeTool(
      lookup("LedgerQuery"),
      { view: "journal", dbPath: "../../etc/passwd" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    writeFileSync(join(workspace, "s.csv"), "Date,Description,Amount\n2026-01-05,x,1.00\n");
    const post = await executeTool(
      lookup("LedgerPost"),
      {
        idempotencyKey: "min",
        baseCurrency: "USD",
        accounts: ACCOUNTS,
        entries: [
          {
            date: "2026-01-05",
            memo: "sale",
            lines: [
              { account: "1100", debit: "1.00" },
              { account: "4000", credit: "1.00" },
            ],
          },
        ],
      },
      { toolUseId: "p" },
    );
    expect(post.isError).toBe(false);

    const inputs: Record<string, unknown> = {
      LedgerQuery: { view: "trial_balance" },
      LedgerReconcile: {
        left: { kind: "statement", file: "s.csv" },
        right: { kind: "ledger", account: "1100" },
        currency: "USD",
      },
      InvoiceRender: {
        kind: "invoice",
        idempotencyKey: "i",
        currency: "USD",
        issueDate: "2026-01-05",
        seller: { name: "S" },
        buyer: { name: "B" },
        lines: [{ description: "x", unitAmount: "1.00" }],
        outputs: ["json"],
      },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const result = await executeTool(lookup(name), input, { toolUseId: name });
      expect({ name, isError: result.isError }).toEqual({ name, isError: false });
    }
  });
});

describe("one bookkeeping cycle", () => {
  test("post, report, invoice and reconcile all agree with each other", async () => {
    const run = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
      const result = await executeTool(lookup(name), input, { toolUseId: name });
      expect({
        name,
        isError: result.isError,
        content: result.content.slice(0, 200),
      }).toMatchObject({
        name,
        isError: false,
      });
      return JSON.parse(result.content) as Record<string, unknown>;
    };

    await run("LedgerPost", {
      idempotencyKey: "cycle-1",
      baseCurrency: "USD",
      accounts: ACCOUNTS,
      entries: [
        {
          date: "2026-01-05",
          memo: "Invoice to Acme",
          reference: "INV-00001",
          tags: ["q1"],
          source: { system: "manual", id: "acme-jan" },
          lines: [
            { account: "1100", debit: "180.00", counterparty: "Acme", dueDate: "2026-02-04" },
            { account: "4000", credit: "180.00" },
          ],
        },
        {
          date: "2026-01-20",
          memo: "Acme paid, less processor fee",
          reference: "PAY-9",
          lines: [
            { account: "1000", debit: "174.75" },
            { account: "7000", debit: "5.25" },
            { account: "1100", credit: "180.00", counterparty: "Acme" },
          ],
        },
      ],
    });

    const trial = await run("LedgerQuery", { view: "trial_balance" });
    expect((trial["totals"] as { balanced: boolean }).balanced).toBe(true);

    const chain = await run("LedgerQuery", { view: "chain" });
    expect(chain["chain"] as { ok: boolean; entries: number }).toMatchObject({
      ok: true,
      entries: 2,
    });

    const pnl = await run("LedgerQuery", { view: "pnl" });
    expect((pnl["totals"] as { netIncome: string }).netIncome).toBe("174.75");

    const invoice = await run("InvoiceRender", {
      kind: "invoice",
      idempotencyKey: "cycle-inv",
      currency: "USD",
      issueDate: "2026-01-05",
      dueDate: "2026-02-04",
      seller: { name: "Crew Haus", taxId: "GB123" },
      buyer: { name: "Acme Ltd" },
      lines: [
        { description: "Consulting", quantity: "1.5", unitAmount: "100.00", taxRateBps: 2000 },
      ],
      outputs: ["markdown"],
      outDir: "invoices",
    });
    // The invoice's total is what was posted to receivables.
    expect((invoice["totals"] as { total: string }).total).toBe("180.00");
    expect(invoice["number"]).toBe("INV-00001");

    // The bank account against what the bank says: 174.75 arrived, one day
    // later, and the ledger already knows about the fee.
    const reconciled = await run("LedgerReconcile", {
      left: { kind: "ledger", account: "1000" },
      right: {
        kind: "lines",
        lines: [
          {
            id: "bank-1",
            date: "2026-01-21",
            description: "ACME LTD",
            amountMinor: 17_475,
            direction: "credit",
            reference: "",
            balanceMinor: null,
          },
        ],
      },
      currency: "USD",
    });
    expect((reconciled["summary"] as { matchedCount: number }).matchedCount).toBe(1);
    expect((reconciled["summary"] as { differenceMinor: string }).differenceMinor).toBe("0");

    // And the aging report agrees that Acme owes nothing.
    const aging = await run("LedgerQuery", {
      view: "aging",
      accounts: ["1100"],
      asOf: "2026-03-01",
    });
    expect((aging["rows"] as Array<{ total: string }>)[0]?.total).toBe("0.00");
  });
});

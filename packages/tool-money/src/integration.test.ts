import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { MONEY_TOOLS } from "./index";

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
  for (const tool of MONEY_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-money-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  delete process.env["INT_WEBHOOK_SECRET"];
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(MONEY_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of MONEY_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("PaymentIdentifierValidate"),
      { value: "GB82WEST12345698765432" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"valid":true');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("PaymentIdentifierValidate"),
      { value: 42 },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("a library refusal is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("TaxCalculate"),
      {
        lines: [{ id: "a", amountMinor: 1, taxCodes: ["MISSING"] }],
        rates: [{ code: "V", bps: 1 }],
      },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("MISSING");
  });

  test("a containment escape is an error result", async () => {
    const result = await executeTool(
      lookup("StatementParse"),
      { file: "../../etc/passwd" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    writeFileSync(join(workspace, "s.csv"), "Date,Description,Amount\n2026-01-01,x,1.00\n");
    const inputs: Record<string, unknown> = {
      PaymentIdentifierValidate: { value: "021000021" },
      TaxCalculate: {
        lines: [{ id: "a", amountMinor: 100, taxCodes: [] }],
        rates: [{ code: "V", bps: 0 }],
      },
      RefundAmountCompute: {
        lines: [{ id: "a", quantity: 1, unitPriceMinor: 100 }],
        returned: [{ lineId: "a", quantity: 1 }],
      },
      PurchaseOrderMatch: {
        invoiceLines: [{ id: "i", poLineId: "p", quantity: 1, unitPriceMinor: 1 }],
        poLines: [{ id: "p", quantity: 1, unitPriceMinor: 1 }],
      },
      CostBasisCompute: {
        lots: [{ id: "L", acquiredAt: "2024-01-01T00:00:00Z", quantity: 1, costMinor: 1 }],
        disposals: [],
        method: "fifo",
      },
      SpendLimitCheck: { proposed: { amountMinor: 1 }, history: [], limits: {}, now: 0 },
      RefundAbuseCheck: { refunds: [], orders: [], now: 0 },
      WebhookSignatureVerify: {
        body: "{}",
        signatureHeader: "t=1,v1=abc",
        secretEnvVar: "INT_WEBHOOK_SECRET",
      },
      StatementParse: { file: "s.csv" },
      GlCodeSuggest: {
        lines: [{ id: "l" }],
        rules: [{ id: "r", when: [{ op: "exists" }], account: "1" }],
      },
    };
    for (const tool of MONEY_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the accounts-payable run these exist for", () => {
  test("parse a statement, check the limit, then verify the event that claims it settled", async () => {
    // 1. What actually left the account.
    writeFileSync(
      join(workspace, "bank.csv"),
      "Date,Description,Money Out,Money In\n2026-01-05,Acme Ltd,1200.00,\n",
    );
    const parsed = await executeTool(
      lookup("StatementParse"),
      { file: "bank.csv" },
      { toolUseId: "a1" },
    );
    const statement = JSON.parse(parsed.content);
    expect(statement.transactions[0]).toMatchObject({ amountMinor: -120_000, direction: "debit" });

    // 2. Whether another payment to the same counterparty may go out.
    const decision = await executeTool(
      lookup("SpendLimitCheck"),
      {
        proposed: { amountMinor: 500_000, counterparty: "Acme Ltd" },
        history: [
          { id: "s", at: "2026-01-05T00:00:00Z", amountMinor: 120_000, counterparty: "Acme Ltd" },
        ],
        limits: { perCounterpartyPerDayMinor: 200_000 },
        now: "2026-01-05T12:00:00Z",
      },
      { toolUseId: "a2" },
    );
    expect(JSON.parse(decision.content).allowed).toBe(false);

    // 3. A webhook claiming the payment succeeded is checked before belief.
    process.env["INT_WEBHOOK_SECRET"] = "whsec_int";
    const body = '{"type":"payout.paid","amount":120000}';
    const ts = 1_700_000_000;
    const signature = createHmac("sha256", "whsec_int").update(`${ts}.${body}`).digest("hex");
    const verified = await executeTool(
      lookup("WebhookSignatureVerify"),
      {
        body,
        signatureHeader: `t=${ts},v1=${signature}`,
        secretEnvVar: "INT_WEBHOOK_SECRET",
        now: ts * 1000,
      },
      { toolUseId: "a3" },
    );
    expect(JSON.parse(verified.content).valid).toBe(true);

    // The same event with one byte changed does not verify.
    const tampered = await executeTool(
      lookup("WebhookSignatureVerify"),
      {
        body: '{"type":"payout.paid","amount":999999}',
        signatureHeader: `t=${ts},v1=${signature}`,
        secretEnvVar: "INT_WEBHOOK_SECRET",
        now: ts * 1000,
      },
      { toolUseId: "a4" },
    );
    expect(JSON.parse(tampered.content).valid).toBe(false);
  });
});

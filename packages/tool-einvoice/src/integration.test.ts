/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before `execute` is
 * called.
 *
 * What this file is for that `index.test.ts` is not: proving that the schemas
 * are the gate. A refusal that only exists inside `execute` is a refusal the
 * runtime can be talked past — the executor has to reject the bad shape first,
 * and a library refusal has to come back as an error RESULT rather than as a
 * crash.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { INVOICE, NACHA_OPTIONS, NACHA_PAYMENTS, SEPA_OPTIONS, SEPA_PAYMENTS } from "./fixtures";
import { EINVOICE_TOOLS } from "./index";

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
  for (const tool of EINVOICE_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-einvoice-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(EINVOICE_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of EINVOICE_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid build returns a non-error result", async () => {
    const result = await executeTool(
      lookup("EInvoiceBuild"),
      { syntax: "ubl", invoice: INVOICE },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"totalWithVat_BT112":"453.35"');
  });

  test("a bad type never reaches execute", async () => {
    const result = await executeTool(
      lookup("EInvoiceBuild"),
      { syntax: "ubl", invoice: { ...INVOICE, currency: 42 } },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("an unknown syntax is rejected by the schema, not by execute", async () => {
    const result = await executeTool(
      lookup("EInvoiceBuild"),
      { syntax: "fatturapa", invoice: INVOICE },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("a library refusal is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("PaymentFileBuild"),
      {
        format: "nacha",
        payments: [{ ...NACHA_PAYMENTS[0], routingNumber: "021000022" }],
        nacha: NACHA_OPTIONS,
      },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ABA checksum");
  });

  test("a path escape comes back as an error result with the reason", async () => {
    const result = await executeTool(
      lookup("EInvoiceParse"),
      { file: "../../../etc/passwd" },
      { toolUseId: "t5" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace root");
  });

  test("a SEPA batch round-trips through the executor with its control sum", async () => {
    const result = await executeTool(
      lookup("PaymentFileBuild"),
      { format: "sepa-pain001", payments: SEPA_PAYMENTS, sepa: SEPA_OPTIONS },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"controlSum":"1259.99"');
    expect(result.content).toContain("BUILT, NOT SENT");
  });

  test("build then parse: the document a tool wrote is one the other reads", async () => {
    const built = await executeTool(
      lookup("EInvoiceBuild"),
      { syntax: "cii", invoice: INVOICE, outFile: "invoice.xml" },
      { toolUseId: "t7" },
    );
    expect(built.isError).toBe(false);
    const parsed = await executeTool(
      lookup("EInvoiceParse"),
      { file: "invoice.xml" },
      { toolUseId: "t8" },
    );
    expect(parsed.isError).toBe(false);
    expect(parsed.content).toContain('"agrees":true');
    expect(parsed.content).toContain('"syntax":"cii"');
  });

  test("a payment count over the cap never reaches execute", async () => {
    const payments = Array.from({ length: 25_001 }, (_, i) => ({
      id: `P${i}`,
      amountMinor: 1,
      name: "A",
    }));
    const result = await executeTool(
      lookup("PaymentFileBuild"),
      { format: "nacha", payments, nacha: NACHA_OPTIONS },
      { toolUseId: "t9" },
    );
    expect(result.isError).toBe(true);
  });
});

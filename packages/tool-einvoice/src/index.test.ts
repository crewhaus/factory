/**
 * The three tools, through their own `execute`.
 *
 * The refusal paths get more room than the happy ones, which is the right
 * proportion for a package whose output is read by a machine that will not say
 * what was wrong with it. Every refusal here asserts the REASON and not just
 * the failure: a test that only checks "it did not succeed" passes just as
 * happily when the tool crashed for an unrelated reason.
 *
 * Nothing in this file opens a socket, reads a clock or writes outside a
 * temporary directory the test made.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUYER,
  INVOICE,
  NACHA_OPTIONS,
  NACHA_PAYMENTS,
  SELLER,
  SEPA_OPTIONS,
  SEPA_PAYMENTS,
  collectSchemaKeys,
  routingWithCheckDigit,
} from "./fixtures";
import {
  EINVOICE_TOOLS,
  REFUSAL_TYPES,
  eInvoiceBuild,
  eInvoiceParse,
  paymentFileBuild,
} from "./index";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

const originalCwd = process.cwd();
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-einvoice-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

async function raw(tool: (typeof EINVOICE_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return String(await tool.execute(parsed.data, ctx));
}

/**
 * Drive a call that must be refused, and hand back the REASON.
 *
 * Every refusal in this package throws, so that the runtime reports it as an
 * error result rather than as a document. A test that merely asserted "it did
 * not succeed" would pass just as happily on an unrelated crash, so each
 * caller below matches on the sentence.
 */
async function refusal(tool: (typeof EINVOICE_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  let produced: string;
  try {
    produced = String(await tool.execute(parsed.data, ctx));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected a refusal, but the tool produced: ${produced.slice(0, 200)}`);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof EINVOICE_TOOLS)[number],
  input: unknown,
): Promise<T> {
  const text = await raw(tool, input);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, got a refusal: ${text}`);
  }
}

type BuildResult = {
  content: string;
  sha256: string;
  bytes: number;
  file?: string;
  totals: Record<string, unknown>;
  ruleCheck: {
    verdict: string;
    checksRun: number;
    failures: Array<{ id: string; detail: string }>;
    notChecked: string[];
    checkedIds: string[];
  };
};

type ParseResult = {
  syntax: string;
  reconciliation: {
    agrees: boolean;
    differences: Array<Record<string, string>>;
    couldNotCompare: Array<Record<string, string>>;
  };
  computedTotals: Record<string, unknown>;
  ruleCheck: BuildResult["ruleCheck"];
  invoice: Record<string, unknown>;
};

describe("package-wide contract", () => {
  test("every tool is exported in EINVOICE_TOOLS", () => {
    expect(EINVOICE_TOOLS.length).toBe(3);
  });

  test("names are unique and PascalCase", () => {
    const names = EINVOICE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of EINVOICE_TOOLS) expect(tool.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("nothing here crosses a boundary: no tool declares an I/O capability", () => {
    for (const tool of EINVOICE_TOOLS) {
      expect({ name: tool.name, io: tool.ioCapability }).toEqual({
        name: tool.name,
        io: undefined,
      });
      expect({ name: tool.name, scope: tool.scope }).toEqual({
        name: tool.name,
        scope: "internal",
      });
    }
  });

  test("NO SCHEMA ANYWHERE ACCEPTS A CREDENTIAL", () => {
    // These tools build files that move money and then hand back the bytes.
    // There is nothing to authenticate to, so there is no field to put a
    // credential in — and the check walks the whole schema tree rather than
    // the top level, because a key hidden inside `payments[]` or inside the
    // optional `sepa` block would pass the shallow version of this test.
    const keys = new Set<string>();
    for (const tool of EINVOICE_TOOLS) {
      for (const key of collectSchemaKeys(tool.inputSchema)) keys.add(key);
    }
    expect(keys.size).toBeGreaterThan(40); // it really did walk the tree
    expect(keys.has("payments")).toBe(true);
    expect(keys.has("routingNumber")).toBe(true); // nested one level down
    expect(keys.has("debtorIban")).toBe(true); // nested inside an optional block
    const forbidden = [
      "password",
      "secret",
      "apiKey",
      "token",
      "accessToken",
      "credential",
      "credentials",
      "privateKey",
      "keyFile",
      "certificate",
      "passphrase",
      "pin",
      "cvv",
      "authorization",
      "username",
      "sftpHost",
      "endpoint",
      "webhookUrl",
      "submitTo",
    ];
    for (const key of forbidden) {
      expect({ key, present: keys.has(key) }).toEqual({ key, present: false });
    }
  });

  test("every refusal is one of the declared types, so none is a bare crash", async () => {
    // A refusal reaches the runtime as its message. If one of them were an
    // untyped Error from somewhere inside, the caller would get a sentence
    // written for nobody where an explanation belongs — so each family is
    // driven here, and the set they produce has to be the whole declared list.
    const cases: Array<[(typeof EINVOICE_TOOLS)[number], unknown]> = [
      [
        eInvoiceBuild,
        { syntax: "ubl", invoice: { ...INVOICE, allowances: [{ amountMinor: 500 }] } },
      ],
      [eInvoiceBuild, { syntax: "ubl", invoice: INVOICE, outFile: "../escape.xml" }],
      [
        eInvoiceBuild,
        {
          syntax: "ubl",
          invoice: { ...INVOICE, buyer: { ...BUYER, name: `Sud${String.fromCharCode(7)}SARL` } },
        },
      ],
      [eInvoiceParse, {}],
      [
        paymentFileBuild,
        {
          format: "nacha",
          payments: [{ id: "X", amountMinor: 100, name: "A", accountNumber: "1" }],
          nacha: NACHA_OPTIONS,
        },
      ],
      [
        paymentFileBuild,
        {
          format: "nacha",
          payments: [{ ...NACHA_PAYMENTS[0], amountMinor: 12_345_678_901 }],
          nacha: NACHA_OPTIONS,
        },
      ],
      [
        paymentFileBuild,
        {
          format: "nacha",
          payments: NACHA_PAYMENTS,
          nacha: { ...NACHA_OPTIONS, effectiveEntryDate: "2026-13-01" },
        },
      ],
    ];
    const seen = new Set<string>();
    for (const [tool, input] of cases) {
      const parsed = tool.inputSchema.safeParse(input);
      expect({ tool: tool.name, accepted: parsed.success }).toEqual({
        tool: tool.name,
        accepted: true,
      });
      let thrown: unknown;
      try {
        await tool.execute(parsed.data, ctx);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const match = REFUSAL_TYPES.find((kind) => thrown instanceof kind);
      expect({
        message: (thrown as Error).message.slice(0, 60),
        typed: match !== undefined,
      }).toEqual({ message: (thrown as Error).message.slice(0, 60), typed: true });
      seen.add((thrown as Error).name);
    }
    expect([...seen].sort()).toEqual(REFUSAL_TYPES.map((kind) => kind.name).sort());
  });

  test("no tool description offers to send, submit or file anything", () => {
    for (const tool of EINVOICE_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description).toContain("Use it");
      expect(/\b(transmits|submits to|uploads to|sends the file)\b/i.test(tool.description)).toBe(
        false,
      );
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const tool of EINVOICE_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(42).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });

  test("no schema uses zod's .default(), which does not compile in this repo", () => {
    const seen = new Set<unknown>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 20 || node === null || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      const def = (node as { _def?: Record<string, unknown> })._def;
      if (def === undefined) return;
      expect(def.typeName).not.toBe("ZodDefault");
      for (const value of Object.values(def)) walk(value, depth + 1);
      const shape = (node as { shape?: unknown }).shape;
      if (shape !== undefined) {
        const entries = typeof shape === "function" ? (shape as () => object)() : shape;
        for (const value of Object.values(entries as object)) walk(value, depth + 1);
      }
    };
    for (const tool of EINVOICE_TOOLS) walk(tool.inputSchema, 0);
  });
});

describe("EInvoiceBuild", () => {
  test("writes UBL whose totals are the ones the rows come to", async () => {
    const result = await call<BuildResult>(eInvoiceBuild, { syntax: "ubl", invoice: INVOICE });
    expect(result.content).toContain(
      '<cbc:PayableAmount currencyID="EUR">453.35</cbc:PayableAmount>',
    );
    expect(result.content).toContain(
      '<cbc:TaxExclusiveAmount currencyID="EUR">385.00</cbc:TaxExclusiveAmount>',
    );
    expect(result.totals.sumOfLineNetAmounts_BT106).toBe("390.00");
    expect(result.ruleCheck.failures).toEqual([]);
  });

  test("writes CII with the same totals in the other syntax's shape", async () => {
    const result = await call<BuildResult>(eInvoiceBuild, { syntax: "cii", invoice: INVOICE });
    expect(result.content).toContain("<ram:DuePayableAmount>453.35</ram:DuePayableAmount>");
    expect(result.content).toContain("<ram:ApplicableTradeTax>");
    expect(result.ruleCheck.failures).toEqual([]);
  });

  test("the same record produces the same bytes, twice", async () => {
    const a = await call<BuildResult>(eInvoiceBuild, { syntax: "ubl", invoice: INVOICE });
    const b = await call<BuildResult>(eInvoiceBuild, { syntax: "ubl", invoice: INVOICE });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the rule report states its coverage and never claims validity", async () => {
    const result = await call<BuildResult>(eInvoiceBuild, { syntax: "ubl", invoice: INVOICE });
    expect(result.ruleCheck.verdict).toContain("not the whole of it");
    expect(result.ruleCheck.verdict).toContain("not a Schematron run");
    expect(result.ruleCheck.checksRun).toBe(result.ruleCheck.checkedIds.length);
    expect(result.ruleCheck.notChecked.join(" ")).toContain("BR-CL-*");
  });

  test("a preset sets identifiers and says out loud that its rules were not checked", async () => {
    const result = await call<BuildResult & { customizationId: string; notes: string[] }>(
      eInvoiceBuild,
      { syntax: "ubl", invoice: INVOICE, preset: "xrechnung" },
    );
    expect(result.customizationId).toContain("xrechnung_3.0");
    expect(result.notes.join(" ")).toContain("rule set was NOT checked");
  });

  test("a missing seller country is a rule FAILURE, not a refusal", async () => {
    const invoice = { ...INVOICE, seller: { ...SELLER, address: { city: "Hamburg" } } };
    const result = await call<BuildResult>(eInvoiceBuild, { syntax: "ubl", invoice });
    expect(result.ruleCheck.failures.map((f) => f.id)).toContain("BR-09");
    expect(result.content).toContain("<Invoice"); // the document still came back
  });

  test("a three-decimal currency writes three decimals and is NOT a decimals finding", async () => {
    // KWD has three minor digits, so 385.000 is the exact amount and not an
    // over-precise one. This used to report CH-DEC-2 as FAILED on every
    // KWD invoice, with a detail that read like an explanation rather than a
    // complaint — a false failure against a correct document, which is the
    // same class of mistake as claiming validity.
    const result = await call<BuildResult>(eInvoiceBuild, {
      syntax: "ubl",
      invoice: { ...INVOICE, currency: "KWD" },
    });
    // 1250 minor units is 1.250 KWD, not 12.50 — three minor digits.
    expect(result.content).toContain(
      '<cbc:PayableAmount currencyID="KWD">45.335</cbc:PayableAmount>',
    );
    expect(result.ruleCheck.failures.map((f) => f.id)).not.toContain("CH-DEC-2");
  });

  test("an out-of-scope category alongside a standard one is reported", async () => {
    const invoice = {
      ...INVOICE,
      allowances: undefined,
      lines: [
        INVOICE.lines[0],
        {
          id: "2",
          name: "Outside scope",
          quantity: "1",
          unitCode: "C62",
          unitPriceMinor: 1000,
          vat: { categoryCode: "O", ratePercent: "0", exemptionReason: "Not subject" },
        },
      ],
    };
    const result = await call<BuildResult>(eInvoiceBuild, { syntax: "ubl", invoice });
    expect(result.ruleCheck.failures.map((f) => f.id)).toContain("CH-OUT-OF-SCOPE-EXCLUSIVE");
  });

  test("a document allowance with no VAT category is refused, naming the rule", async () => {
    const text = await refusal(eInvoiceBuild, {
      syntax: "ubl",
      invoice: { ...INVOICE, allowances: [{ amountMinor: 500, reason: "Discount" }] },
    });
    expect(text).toContain("BR-32");
    expect(text).not.toContain("<Invoice");
  });

  test("a quantity in exponent notation never reaches execute", () => {
    const parsed = eInvoiceBuild.inputSchema.safeParse({
      syntax: "ubl",
      invoice: {
        ...INVOICE,
        lines: [{ ...INVOICE.lines[0], quantity: "1e3" }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("an invoice with no lines never reaches execute", () => {
    const parsed = eInvoiceBuild.inputSchema.safeParse({
      syntax: "ubl",
      invoice: { ...INVOICE, lines: [] },
    });
    expect(parsed.success).toBe(false);
  });

  test("it writes to a path inside the workspace and reports the digest", async () => {
    const result = await call<BuildResult>(eInvoiceBuild, {
      syntax: "ubl",
      invoice: INVOICE,
      outFile: "out/invoice.xml",
    });
    expect(result.file).toBe("out/invoice.xml");
    // The parent directory did not exist and was created — safe to do, because
    // the destination was proved to be inside the workspace first.
    expect(readFileSync(join(workspace, "out", "invoice.xml"), "utf8")).toContain("<Invoice");
    // With a destination the bytes do NOT also come back inline; one copy of a
    // document is enough, and the digest is what ties them together.
    expect(result.content).toBeUndefined();
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a path outside the workspace is refused", async () => {
    const text = await refusal(eInvoiceBuild, {
      syntax: "ubl",
      invoice: INVOICE,
      outFile: "../escape.xml",
    });
    expect(text).toContain("escapes the workspace root");
  });

  test("an existing destination is not clobbered unless overwrite is passed", async () => {
    writeFileSync(join(workspace, "invoice.xml"), "keep me", "utf8");
    const refused = await refusal(eInvoiceBuild, {
      syntax: "ubl",
      invoice: INVOICE,
      outFile: "invoice.xml",
    });
    expect(refused).toContain("already exists");
    expect(readFileSync(join(workspace, "invoice.xml"), "utf8")).toBe("keep me");
    const written = await call<BuildResult>(eInvoiceBuild, {
      syntax: "ubl",
      invoice: INVOICE,
      outFile: "invoice.xml",
      overwrite: true,
    });
    expect(written.file).toBe("invoice.xml");
    expect(readFileSync(join(workspace, "invoice.xml"), "utf8")).toContain("<Invoice");
  });

  test("a control character in a name is refused rather than written into the XML", async () => {
    const text = await refusal(eInvoiceBuild, {
      syntax: "ubl",
      invoice: { ...INVOICE, buyer: { ...BUYER, name: `Sud${String.fromCharCode(7)}SARL` } },
    });
    expect(text).toContain("control character");
  });
});

describe("EInvoiceParse", () => {
  const build = async (syntax: string, invoice: unknown = INVOICE): Promise<string> =>
    (await call<BuildResult>(eInvoiceBuild, { syntax, invoice })).content;

  test("a UBL document parses back to the totals it was built from", async () => {
    const result = await call<ParseResult>(eInvoiceParse, { xml: await build("ubl") });
    expect(result.syntax).toBe("ubl");
    expect(result.reconciliation.agrees).toBe(true);
    expect(result.computedTotals.totalWithVat_BT112).toBe("453.35");
    expect(result.ruleCheck.failures).toEqual([]);
  });

  test("a CII document does too, through a different nesting entirely", async () => {
    const result = await call<ParseResult>(eInvoiceParse, { xml: await build("cii") });
    expect(result.syntax).toBe("cii");
    expect(result.reconciliation.agrees).toBe(true);
    expect(result.computedTotals.totalWithVat_BT112).toBe("453.35");
    expect(result.invoice.invoiceNumber).toBe("INV-2026-0001");
  });

  test("namespace PREFIXES are not what the mapping matches on", async () => {
    // A conformant UBL invoice may bind the same namespaces to any prefix it
    // likes. Matching `cac:` would read the common files and silently return
    // an empty invoice for the rest.
    const renamed = (await build("ubl"))
      .replace(/cac:/g, "q1:")
      .replace(/cbc:/g, "q2:")
      .replace(/xmlns:q1=/, "xmlns:q1=")
      .replace(/xmlns:q2=/, "xmlns:q2=");
    const result = await call<ParseResult>(eInvoiceParse, { xml: renamed });
    expect(result.reconciliation.agrees).toBe(true);
    expect(result.computedTotals.totalWithVat_BT112).toBe("453.35");
  });

  test("a total that disagrees with the rows is reported with both figures", async () => {
    const doctored = (await build("ubl")).replace(
      '<cbc:TaxInclusiveAmount currencyID="EUR">453.35</cbc:TaxInclusiveAmount>',
      '<cbc:TaxInclusiveAmount currencyID="EUR">1453.35</cbc:TaxInclusiveAmount>',
    );
    const result = await call<ParseResult>(eInvoiceParse, { xml: doctored });
    expect(result.reconciliation.agrees).toBe(false);
    const difference = result.reconciliation.differences.find((d) => d.field?.includes("BT-112"));
    expect(difference).toMatchObject({
      statedInDocument: "1453.35",
      computedFromRows: "453.35",
      difference: "1000.00",
    });
    expect(result.ruleCheck.failures.map((f) => f.id)).toContain("BR-CO-15");
  });

  test("a document that fails a rule still comes back parsed", async () => {
    const doctored = (await build("ubl")).replace(
      "<cbc:IssueDate>2026-03-02</cbc:IssueDate>",
      "<cbc:IssueDate>2026-02-30</cbc:IssueDate>",
    );
    const result = await call<ParseResult>(eInvoiceParse, { xml: doctored });
    expect(result.ruleCheck.failures.map((f) => f.id)).toContain("CH-DATE-FORMAT");
    expect(result.invoice.invoiceNumber).toBe("INV-2026-0001");
  });

  test("an over-precise amount is recorded against the decimals rule", async () => {
    const doctored = (await build("ubl")).replace(
      '<cbc:PayableAmount currencyID="EUR">453.35</cbc:PayableAmount>',
      '<cbc:PayableAmount currencyID="EUR">453.3456</cbc:PayableAmount>',
    );
    const result = await call<ParseResult>(eInvoiceParse, { xml: doctored });
    const failure = result.ruleCheck.failures.find((f) => f.id === "CH-DEC-2");
    // The complaint is measured against the CURRENCY's minor units, not a
    // hard-coded two.
    expect(failure?.detail).toContain("EUR has 2 decimals");
    expect(failure?.detail).toContain('BT-115="453.3456"');
  });

  test("a trading name is not read as the registration name", async () => {
    // BT-28 is not a fallback for BT-27. Substituting one for the other makes
    // BR-06 pass on a document that does not carry a seller name.
    const stripped = (await build("ubl")).replace(
      "<cbc:RegistrationName>Nordwind Handel GmbH</cbc:RegistrationName>",
      "",
    );
    const result = await call<ParseResult>(eInvoiceParse, { xml: stripped });
    expect(result.ruleCheck.failures.map((f) => f.id)).toContain("BR-06");
  });

  test("it reads a file from the workspace", async () => {
    writeFileSync(join(workspace, "in.xml"), await build("ubl"), "utf8");
    const result = await call<ParseResult & { source: string }>(eInvoiceParse, { file: "in.xml" });
    expect(result.source).toBe("in.xml");
    expect(result.reconciliation.agrees).toBe(true);
  });

  test("a file outside the workspace is refused", async () => {
    const text = await refusal(eInvoiceParse, { file: "../../etc/hosts" });
    expect(text).toContain("escapes the workspace root");
  });

  test("passing both a file and inline XML is refused", async () => {
    const text = await refusal(eInvoiceParse, { file: "in.xml", xml: "<Invoice/>" });
    expect(text).toContain("exactly one of file or xml");
  });

  test("passing neither is refused the same way", async () => {
    const text = await refusal(eInvoiceParse, {});
    expect(text).toContain("exactly one of file or xml");
  });

  test("markup that is not well formed comes back with the parser's line number", async () => {
    const text = await refusal(eInvoiceParse, { xml: "<Invoice><cbc:ID>1</Invoice>" });
    expect(text).toContain("could not be read");
    expect(text).toContain("line 1");
  });

  test("a PDF is refused with what would have to happen instead", async () => {
    const text = await refusal(eInvoiceParse, { xml: "%PDF-1.7\n%stuff" });
    expect(text).toContain("EmbeddedFiles");
    expect(text).toContain("Extract the attachment");
  });

  test("a FatturaPA document is refused rather than mapped badly", async () => {
    const text = await refusal(eInvoiceParse, {
      xml: '<p:FatturaElettronica xmlns:p="urn:fatturapa"><x/></p:FatturaElettronica>',
    });
    expect(text).toContain("different semantic model");
  });

  test("a UBL CreditNote is refused, and the refusal says what to do", async () => {
    const text = await refusal(eInvoiceParse, {
      xml: '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"><a/></CreditNote>',
    });
    expect(text).toContain("type code 381");
  });

  test("an unrecognized root element is refused by name", async () => {
    const text = await refusal(eInvoiceParse, { xml: "<Order><a/></Order>" });
    expect(text).toContain("<Order>");
    expect(text).toContain("does not recognize");
  });

  test("the parsed record can be left out when only the findings are wanted", async () => {
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: await build("ubl"),
      includeDocument: false,
    });
    expect(result.invoice).toBeUndefined();
    expect(result.reconciliation.agrees).toBe(true);
  });
});

describe("PaymentFileBuild — NACHA", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    format: "nacha",
    payments: NACHA_PAYMENTS,
    nacha: NACHA_OPTIONS,
    ...overrides,
  });

  test("builds a blocked file whose control figures come from the entries", async () => {
    const result = await call<{
      content: string;
      entryHash: string;
      blockCount: number;
      totalCreditCents: string;
      serviceClassCode: string;
      notes: string[];
    }>(paymentFileBuild, input());
    const records = result.content.split("\n").filter((line) => line !== "");
    expect(records.length).toBe(10);
    expect(records.every((line) => line.length === 94)).toBe(true);
    expect(result.entryHash).toBe("0003240155");
    expect(result.totalCreditCents).toBe("175000");
    expect(result.serviceClassCode).toBe("220");
    expect(result.notes.join(" ")).toContain("BUILT, NOT SENT");
  });

  test("the same input produces the same digest, because no clock is read", async () => {
    const a = await call<{ sha256: string }>(paymentFileBuild, input());
    const b = await call<{ sha256: string }>(paymentFileBuild, input());
    expect(a.sha256).toBe(b.sha256);
  });

  test("a routing number that fails its ABA checksum is refused with the reason", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({
        payments: [{ ...NACHA_PAYMENTS[0], routingNumber: "021000022" }],
      }),
    );
    expect(text).toContain("refusing to build the file");
    expect(text).toContain("ABA checksum");
    expect(text).toContain("021000022");
  });

  test("a duplicated identifier is refused, naming both rows", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({
        payments: [NACHA_PAYMENTS[0], { ...NACHA_PAYMENTS[1], id: "PAY-1" }],
      }),
    );
    expect(text).toContain("share the identifier");
    expect(text).toContain("duplicate payment");
  });

  test("a row with no routing number is refused, naming the row", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ payments: [{ id: "X", amountMinor: 100, name: "A", accountNumber: "1" }] }),
    );
    expect(text).toContain('payment 0 ("X")');
    expect(text).toContain("routingNumber");
  });

  test("a row with no account number is refused", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({
        payments: [{ id: "X", amountMinor: 100, name: "A", routingNumber: "021000021" }],
      }),
    );
    expect(text).toContain("accountNumber");
  });

  test("the nacha block is required for the nacha format", async () => {
    const text = await refusal(paymentFileBuild, { format: "nacha", payments: NACHA_PAYMENTS });
    expect(text).toContain("no nacha block");
  });

  test("passing both format blocks is refused", async () => {
    const text = await refusal(paymentFileBuild, input({ sepa: SEPA_OPTIONS }));
    expect(text).toContain("both a nacha and a sepa block");
  });

  test("an effective entry date the Fed does not settle on is refused with the next one", async () => {
    const text = await refusal(paymentFileBuild, {
      ...input(),
      nacha: { ...NACHA_OPTIONS, effectiveEntryDate: "2026-11-26" },
    });
    expect(text).toContain("Thanksgiving Day");
    expect(text).toContain("2026-11-27");
    expect(text).toContain("adjustSettlementDate");
  });

  test("moving it is opt-in and both dates are reported", async () => {
    const result = await call<{
      effectiveEntryDate: string;
      settlementDateMoved: { from: string; to: string; because: string };
    }>(paymentFileBuild, {
      ...input(),
      adjustSettlementDate: true,
      nacha: { ...NACHA_OPTIONS, effectiveEntryDate: "2026-11-26" },
    });
    expect(result.effectiveEntryDate).toBe("2026-11-27");
    expect(result.settlementDateMoved).toEqual({
      from: "2026-11-26",
      to: "2026-11-27",
      because: "Thanksgiving Day",
    });
  });

  test("an amount too wide for the ten-column field is refused, not truncated", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ payments: [{ ...NACHA_PAYMENTS[0], amountMinor: 12_345_678_901 }] }),
    );
    expect(text).toContain("refusing rather than truncating");
  });

  test("a file over the inline limit refuses rather than truncating into the result", async () => {
    const payments = Array.from({ length: 3_000 }, (_, i) => ({
      id: `P${i}`,
      amountMinor: 100,
      name: "Payee",
      routingNumber: "021000021",
      accountNumber: "1",
    }));
    const text = await refusal(paymentFileBuild, input({ payments }));
    expect(text).toContain("over the");
    expect(text).toContain("pass outFile");
    expect(text).toContain("valid-looking prefix");
  });

  test("with outFile the bytes land on disk and only the summary comes back", async () => {
    const result = await call<{ file: string; bytes: number; sha256: string }>(
      paymentFileBuild,
      input({ outFile: "ach/batch.txt" }),
    );
    expect(result.file).toBe("ach/batch.txt");
    const written = readFileSync(join(workspace, "ach", "batch.txt"), "utf8");
    expect(written.split("\n").filter((l) => l !== "").length).toBe(10);
    expect(result.bytes).toBe(Buffer.byteLength(written, "utf8"));
  });

  test("an outFile outside the workspace is refused", async () => {
    const text = await refusal(paymentFileBuild, input({ outFile: "../../batch.txt" }));
    expect(text).toContain("escapes the workspace root");
  });
});

describe("PaymentFileBuild — SEPA", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    format: "sepa-pain001",
    payments: SEPA_PAYMENTS,
    sepa: SEPA_OPTIONS,
    ...overrides,
  });

  test("builds a pain.001 whose control sum is the rows'", async () => {
    const result = await call<{
      content: string;
      controlSum: string;
      transactionCount: number;
      version: string;
      notes: string[];
    }>(paymentFileBuild, input());
    expect(result.controlSum).toBe("1259.99");
    expect(result.transactionCount).toBe(2);
    expect(result.version).toBe("pain.001.001.03");
    expect(result.content).toContain("<CtrlSum>1259.99</CtrlSum>");
    expect(result.notes.join(" ")).toContain("BUILT, NOT SENT");
  });

  test("an accented creditor name is transliterated and the change is reported", async () => {
    const result = await call<{
      content: string;
      transliterations: Array<{ from: string; to: string }>;
    }>(
      paymentFileBuild,
      input({ payments: [{ ...SEPA_PAYMENTS[0], name: "Jürgen Müller & Söhne" }] }),
    );
    expect(result.content).toContain("<Nm>Jurgen Muller + Sohne</Nm>");
    expect(result.transliterations[0]?.to).toBe("Jurgen Muller + Sohne");
  });

  test("a name this package cannot romanize is refused, naming the character", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ payments: [{ ...SEPA_PAYMENTS[0], name: "株式会社サンプル" }] }),
    );
    expect(text).toContain("outside the SEPA character set");
    expect(text).toContain("U+");
  });

  test("an IBAN that fails mod-97 is refused with the reason", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ payments: [{ ...SEPA_PAYMENTS[0], iban: "DE89370400440532013001" }] }),
    );
    expect(text).toContain("refusing to build the file");
    expect(text).toContain("IBAN checksum");
  });

  test("a debtor IBAN that fails mod-97 is refused too", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ sepa: { ...SEPA_OPTIONS, debtorIban: "NL91ABNA0417164301" } }),
    );
    expect(text).toContain("debtorIban");
    expect(text).toContain("IBAN checksum");
  });

  test("a row with no IBAN is refused", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ payments: [{ id: "X", amountMinor: 100, name: "A" }] }),
    );
    expect(text).toContain("names the creditor account by IBAN");
  });

  test("the sepa block is required for the sepa format", async () => {
    const text = await refusal(paymentFileBuild, {
      format: "sepa-pain001",
      payments: SEPA_PAYMENTS,
    });
    expect(text).toContain("no sepa block");
  });

  test("an execution date on a TARGET2 closing day is refused with the next open one", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ sepa: { ...SEPA_OPTIONS, requestedExecutionDate: "2026-04-03" } }),
    );
    expect(text).toContain("Good Friday");
    expect(text).toContain("2026-04-07");
  });

  test("a creation timestamp with no offset is refused", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ sepa: { ...SEPA_OPTIONS, creationDateTime: "2026-03-02T09:30:00" } }),
    );
    expect(text).toContain("no UTC offset");
  });

  test("a remittance over 140 characters is refused rather than shortened", async () => {
    const text = await refusal(
      paymentFileBuild,
      input({ payments: [{ ...SEPA_PAYMENTS[0], remittance: "R".repeat(141) }] }),
    );
    expect(text).toContain("Refusing rather than truncating");
  });

  test("the current schema version changes the two elements that actually differ", async () => {
    const result = await call<{ content: string; version: string }>(
      paymentFileBuild,
      input({ sepa: { ...SEPA_OPTIONS, version: "pain.001.001.09" } }),
    );
    expect(result.version).toBe("pain.001.001.09");
    expect(result.content).toContain("urn:iso:std:iso:20022:tech:xsd:pain.001.001.09");
    expect(result.content).toContain("<BICFI>");
    expect(result.content).toContain("<Dt>2026-03-04</Dt>");
  });
});

describe("a payroll-sized file", () => {
  test("five thousand entries block, hash and total correctly", async () => {
    // 5,000 entries is 5,003 records plus padding — about 470 KB written
    // through the path resolver and hashed. The budget is for CI, where two
    // slow cores and 470 KB of string building take a great deal longer than
    // they do here; it is not a performance assertion.
    const payments = Array.from({ length: 5_000 }, (_, i) => ({
      id: `PAY-${i}`,
      amountMinor: 1_000 + i,
      name: `Employee ${i}`,
      routingNumber: routingWithCheckDigit(String(10_000_000 + (i % 97))),
      accountNumber: String(900_000_000 + i),
    }));
    const result = await call<{
      file: string;
      blockCount: number;
      entryAddendaCount: number;
      totalCreditCents: string;
      entryHash: string;
    }>(paymentFileBuild, {
      format: "nacha",
      payments,
      nacha: NACHA_OPTIONS,
      outFile: "big.ach",
    });
    // 1 + 1 + 5000 + 1 + 1 = 5004 records, so 501 blocks of ten.
    expect(result.blockCount).toBe(501);
    expect(result.entryAddendaCount).toBe(5_000);
    // Sum of 1000..5999, which is 5000 * (1000 + 5999) / 2.
    expect(result.totalCreditCents).toBe(String((5_000 * (1_000 + 5_999)) / 2));
    const expectedHash =
      payments.reduce((sum, p) => sum + BigInt(p.routingNumber.slice(0, 8)), 0n) % 10n ** 10n;
    expect(result.entryHash).toBe(expectedHash.toString().padStart(10, "0"));
    const written = readFileSync(join(workspace, "big.ach"), "utf8");
    const records = written.split("\n").filter((line) => line !== "");
    expect(records.length).toBe(5_010);
    expect(records.every((line) => line.length === 94)).toBe(true);
  }, 20_000);
});

/**
 * The cases where a wrong answer is worse than no answer.
 *
 * Each of these was a real defect: a stated total nobody could read reported
 * as agreement, a VAT identifier taken from the wrong tax scheme, a check
 * that crashed reported as a violation of the rule it could not run, a
 * reference that two rows shared once it reached the file, a name shortened
 * with nobody told.
 */
describe("wrong answers are worse than no answer", () => {
  const UBL_NS =
    'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';

  const sellerParty = (taxSchemes: string): string => `<cac:AccountingSupplierParty><cac:Party>
      <cac:PostalAddress><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
      ${taxSchemes}
      <cac:PartyLegalEntity><cbc:RegistrationName>Nordwind Handel GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party></cac:AccountingSupplierParty>`;

  const ublDocument = (opts: { taxSchemes?: string; payable?: string } = {}): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<Invoice ${UBL_NS}>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ID>INV-1</cbc:ID><cbc:IssueDate>2026-03-02</cbc:IssueDate><cbc:DueDate>2026-04-01</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  ${sellerParty(opts.taxSchemes ?? "")}
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PostalAddress><cac:Country><cbc:IdentificationCode>FR</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyLegalEntity><cbc:RegistrationName>Compagnie du Sud SARL</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">10.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">10.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>10</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">110.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${opts.payable ?? "110.00"}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Widget</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>10</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`;

  const FC_THEN_VAT = `<cac:PartyTaxScheme><cbc:CompanyID>201/113/40209</cbc:CompanyID><cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyTaxScheme><cbc:CompanyID>DE123456789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`;

  test("a stated total nobody could read is NOT reported as agreement", async () => {
    // "1.100,00" is what a European-locale exporter writes for 1,100.00. It
    // parses as nothing, so it used to be dropped and the comparison then had
    // nothing to disagree with: a document stating ten times what its rows
    // come to reported `agrees: true`, which is the field a harness branches
    // on before it posts the invoice.
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ublDocument({ payable: "1.100,00" }),
    });
    expect(result.reconciliation.agrees).toBe(false);
    const entry = result.reconciliation.couldNotCompare.find((d) => d.field.startsWith("BT-115"));
    expect(entry?.statedInDocument).toBe('"1.100,00"');
    expect(entry?.computedFromRows).toBe("110.00");
    expect(entry?.why).toContain("not a decimal");
  });

  test("an unreadable amount is its own rule finding, not an absent one", async () => {
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ublDocument({ payable: "1.100,00" }),
    });
    const unreadable = result.ruleCheck.failures.find((f) => f.id === "CH-AMOUNT-UNREADABLE");
    expect(unreadable?.detail).toContain('BT-115="1.100,00"');
    expect(unreadable?.detail).toContain("NOT zero and NOT absent");
    // BR-15 still fires, but it no longer calls a present figure absent.
    const br15 = result.ruleCheck.failures.find((f) => f.id === "BR-15");
    expect(br15?.detail).toContain("could not be read as a decimal");
    expect(br15?.detail).not.toContain("BT-115 is absent");
  });

  test("UBL reads BT-31 from the VAT scheme, whatever order the schemes come in", async () => {
    // XRechnung puts the German Steuernummer under scheme FC beside the VAT
    // identifier, in the sender's order. Taking the first one filed the tax
    // number as BT-31, which then FAILED published rule BR-CO-09 for want of
    // a country prefix — a violation reported against a correct document.
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ublDocument({ taxSchemes: FC_THEN_VAT }),
    });
    expect((result.invoice.seller as { vatId?: string }).vatId).toBe("DE123456789");
    expect(result.ruleCheck.failures.map((f) => f.id)).not.toContain("BR-CO-09");
  });

  test("UBL takes a lone unnamed tax scheme as the VAT one", async () => {
    const lone =
      "<cac:PartyTaxScheme><cbc:CompanyID>DE123456789</cbc:CompanyID></cac:PartyTaxScheme>";
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ublDocument({ taxSchemes: lone }),
    });
    expect((result.invoice.seller as { vatId?: string }).vatId).toBe("DE123456789");
  });

  test("UBL does not file a lone FC tax number as the VAT identifier", async () => {
    const onlyFc =
      "<cac:PartyTaxScheme><cbc:CompanyID>201/113/40209</cbc:CompanyID><cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>";
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ublDocument({ taxSchemes: onlyFc }),
    });
    expect((result.invoice.seller as { vatId?: string }).vatId).toBeUndefined();
  });

  const ciiDocument = (registrations: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>INV-1</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20260302</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Widget</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>100.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>10</ram:RateApplicablePercent></ram:ApplicableTradeTax></ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>Nordwind Handel GmbH</ram:Name>
        <ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        ${registrations}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>Compagnie du Sud SARL</ram:Name><ram:PostalTradeAddress><ram:CountryID>FR</ram:CountryID></ram:PostalTradeAddress></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax><ram:CalculatedAmount>10.00</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>100.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>10</ram:RateApplicablePercent></ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">10.00</ram:TaxTotalAmount><ram:GrandTotalAmount>110.00</ram:GrandTotalAmount><ram:DuePayableAmount>110.00</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

  test("CII reads BT-31 from the VA registration even when FC is declared first", async () => {
    // The published ZUGFeRD samples declare FC before VA. Looking only at the
    // first registration dropped the seller's VAT identifier from a correct
    // document altogether.
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ciiDocument(
        `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">201/113/40209</ram:ID></ram:SpecifiedTaxRegistration>
         <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>`,
      ),
    });
    expect((result.invoice.seller as { vatId?: string }).vatId).toBe("DE123456789");
  });

  test("CII does not file a lone FC registration as the VAT identifier", async () => {
    const result = await call<ParseResult>(eInvoiceParse, {
      xml: ciiDocument(
        '<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">201/113/40209</ram:ID></ram:SpecifiedTaxRegistration>',
      ),
    });
    expect((result.invoice.seller as { vatId?: string }).vatId).toBeUndefined();
  });

  test("two references that collide once transliterated are refused", async () => {
    // `&` becomes `+` in the SEPA character set, so these two distinct rows
    // reach the bank as one reference. `validateRows` compares the SUPPLIED
    // identifiers and cannot see it.
    const reason = await refusal(paymentFileBuild, {
      format: "sepa-pain001",
      payments: [
        { id: "ACME&CO-1", amountMinor: 1_000, name: "A", iban: "DE89370400440532013000" },
        { id: "ACME+CO-1", amountMinor: 2_000, name: "B", iban: "NL91ABNA0417164300" },
      ],
      sepa: SEPA_OPTIONS,
    });
    expect(reason).toContain('both become the end-to-end identifier "ACME+CO-1"');
    expect(reason).toContain("duplicate payment");
  });

  test("a shortened company name reaches the operator, not just the bank", async () => {
    // 16 columns is what the receiver sees on their statement. It used to be
    // cut with `truncations` left empty.
    const result = await call<{ truncations: Array<Record<string, string>>; content: string }>(
      paymentFileBuild,
      {
        format: "nacha",
        payments: [...NACHA_PAYMENTS],
        nacha: { ...NACHA_OPTIONS, companyName: "ACME INTERNATIONAL HOLDINGS INC" },
      },
    );
    const cut = result.truncations.find((t) => t.field === "companyName");
    expect(cut?.from).toBe("ACME INTERNATIONAL HOLDINGS INC");
    expect(cut?.to).toBe("ACME INTERNATION");
    expect(result.content.split("\n")[1]).toContain("ACME INTERNATION");
  });

  test("a shortened initiating party reaches the operator too", async () => {
    const result = await call<{ truncations: Array<Record<string, string>> }>(paymentFileBuild, {
      format: "sepa-pain001",
      payments: [...SEPA_PAYMENTS],
      sepa: { ...SEPA_OPTIONS, initiatingPartyName: `Acme ${"Europe ".repeat(12)}BV` },
    });
    const cut = result.truncations.find((t) => t.field === "initiating party name");
    expect(cut?.to.length).toBe(70);
    expect(cut?.from.length).toBeGreaterThan(70);
  });

  test("a check that could not run is not reported as a rule the document failed", async () => {
    // A rate the canonicaliser cannot parse makes BR-CO-17 raise. Reported as
    // a failure it says the document violates BR-CO-17, which nothing here
    // established either way.
    const doctored = ublDocument().replace(
      "<cbc:Percent>10</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>",
      "<cbc:Percent>ten</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>",
    );
    const result = await call<
      ParseResult & { ruleCheck: { notEvaluated: Array<{ id: string; detail: string }> } }
    >(eInvoiceParse, { xml: doctored });
    expect(result.ruleCheck.failures.map((f) => f.id)).not.toContain("BR-CO-17");
    const stuck = result.ruleCheck.notEvaluated.find((o) => o.id === "BR-CO-17");
    expect(stuck?.detail).toContain("nothing is known either way");
    expect(result.ruleCheck.verdict).toContain("could not be evaluated at all");
    expect(result.ruleCheck.verdict).toContain("BR-CO-17");
  });

  test("an unreadable prepaid amount does not read as nothing prepaid", async () => {
    // BT-113 is not derivable, so it is taken from the document. Reading an
    // unreadable one as 0 put the whole invoice back on the payable line and
    // left the record looking internally consistent about it.
    const doctored = ublDocument().replace(
      '<cbc:PayableAmount currencyID="EUR">110.00</cbc:PayableAmount>',
      '<cbc:PrepaidAmount currencyID="EUR">50,00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="EUR">60.00</cbc:PayableAmount>',
    );
    const result = await call<ParseResult>(eInvoiceParse, { xml: doctored });
    expect(result.invoice.paidAmountMinor).toBeUndefined();
    expect(
      result.ruleCheck.failures.find((f) => f.id === "CH-AMOUNT-UNREADABLE")?.detail,
    ).toContain('BT-113="50,00"');
  });

  test("an amount past the exact range of a JSON number is refused at the edge", () => {
    // 2^53 is an integer as far as `Number.isInteger` is concerned, and so is
    // 1e300. Either would convert to a bigint exactly and be written into a
    // document as an amount the caller never wrote, because the digits went
    // missing in `JSON.parse` before the schema ever saw them.
    const tooBig = paymentFileBuild.inputSchema.safeParse({
      format: "sepa-pain001",
      payments: [
        {
          id: "E2E-1",
          amountMinor: 9_007_199_254_740_992,
          name: "A",
          iban: "DE89370400440532013000",
        },
      ],
      sepa: SEPA_OPTIONS,
    });
    expect(tooBig.success).toBe(false);
    const ok = paymentFileBuild.inputSchema.safeParse({
      format: "sepa-pain001",
      payments: [{ id: "E2E-1", amountMinor: 1_000, name: "A", iban: "DE89370400440532013000" }],
      sepa: SEPA_OPTIONS,
    });
    expect(ok.success).toBe(true);
  });

  test("a JPY amount with cents is a finding, not a silent rounding", async () => {
    // JPY has no minor units. "100.50" used to slip past a hard-coded
    // two-decimal test, get rounded half-up to 101 and reconcile.
    const jpy = ublDocument()
      .replace(/EUR/g, "JPY")
      .replace(/100\.00/g, "100.50");
    const result = await call<ParseResult>(eInvoiceParse, { xml: jpy });
    const over = result.ruleCheck.failures.find((f) => f.id === "CH-DEC-2");
    expect(over?.detail).toContain("JPY has 0 decimals");
    expect(over?.detail).toContain('="100.50"');
  });
});

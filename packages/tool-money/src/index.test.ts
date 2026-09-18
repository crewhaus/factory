import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, through its own `execute`.
 *
 * The package-wide block is the contract the runtime relies on. After that,
 * each tool gets the behaviour that matters for it — chiefly the refusals,
 * since a money tool that guesses is worse than one that stops.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONEY_TOOLS,
  costBasisCompute,
  glCodeSuggest,
  paymentIdentifierValidate,
  purchaseOrderMatch,
  refundAbuseCheck,
  refundAmountCompute,
  spendLimitCheck,
  statementParse,
  taxCalculate,
  webhookSignatureVerify,
} from "./index";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

async function raw(tool: (typeof MONEY_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return tool.execute(parsed.data, ctx);
}

async function call<T = Record<string, unknown>>(
  tool: (typeof MONEY_TOOLS)[number],
  input: unknown,
): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-money-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  // `delete` rather than `= undefined`: in Node the latter sets the
  // variable to the STRING "undefined", which a reader of process.env
  // cannot tell from a real value. Reflect does the deletion without the
  // operator the linter objects to.
  Reflect.deleteProperty(process.env, "TEST_WEBHOOK_SECRET");
});

describe("package-wide contract", () => {
  test("every tool is exported in MONEY_TOOLS", () => {
    expect(MONEY_TOOLS.length).toBe(10);
  });

  test("names are unique and PascalCase", () => {
    const names = MONEY_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of MONEY_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only and non-destructive — this package computes, it does not pay", () => {
    for (const t of MONEY_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
    }
  });

  test("no tool declares a network capability, because none reaches a provider", () => {
    for (const t of MONEY_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("no tool opts out of output classification", () => {
    for (const t of MONEY_TOOLS) {
      expect({ name: t.name, off: t.classifyOutput === false }).toEqual({
        name: t.name,
        off: false,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const t of MONEY_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of MONEY_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("every schema refuses a non-integer amount, because money is minor units", () => {
    expect(
      taxCalculate.inputSchema.safeParse({
        lines: [{ id: "a", amountMinor: 10.5, taxCodes: [] }],
        rates: [{ code: "V", bps: 1 }],
      }).success,
    ).toBe(false);
  });

  test("the clock-reading tools accept an explicit now, so a run is reproducible", async () => {
    const input = {
      proposed: { amountMinor: 1 },
      history: [],
      limits: { perDayMinor: 100 },
      now: "2026-01-01T00:00:00Z",
    };
    expect(await call(spendLimitCheck, input)).toEqual(await call(spendLimitCheck, input));
  });
});

describe("PaymentIdentifierValidate", () => {
  test("detects the kind and validates", async () => {
    const result = await call(paymentIdentifierValidate, { value: "GB82 WEST 1234 5698 7654 32" });
    expect(result).toMatchObject({ kind: "iban", valid: true });
  });

  test("says plainly that only a checksum was checked", async () => {
    const result = await call<{ checkedAgainst: string }>(paymentIdentifierValidate, {
      value: "021000021",
    });
    expect(result.checkedAgainst).toContain("no account was looked up");
  });

  test("an unrecognizable value asks for the kind rather than guessing", async () => {
    expect(await raw(paymentIdentifierValidate, { value: "hello world" })).toContain(
      "pass kind explicitly",
    );
  });

  test("a card number never appears in the output", async () => {
    const out = await raw(paymentIdentifierValidate, { value: "4242424242424242", kind: "card" });
    expect(out).not.toContain("4242424242424242");
    expect(out).toContain("4242");
  });
});

describe("TaxCalculate", () => {
  test("computes an invoice", async () => {
    const result = await call(taxCalculate, {
      lines: [{ id: "a", amountMinor: 10_000, taxCodes: ["V"] }],
      rates: [{ code: "V", bps: 2_000 }],
    });
    expect(result).toMatchObject({ netMinor: 10_000, taxMinor: 2_000, grossMinor: 12_000 });
  });

  test("an unknown tax code is an error result, not an untaxed line", async () => {
    await expect(
      raw(taxCalculate, {
        lines: [{ id: "a", amountMinor: 1, taxCodes: ["X"] }],
        rates: [{ code: "V", bps: 1 }],
      }),
    ).rejects.toThrow(/not in the rate table/);
  });
});

describe("RefundAmountCompute", () => {
  test("a full return refunds what was charged", async () => {
    const result = await call<{ totalMinor: number; fullReturn: boolean }>(refundAmountCompute, {
      lines: [{ id: "a", quantity: 2, unitPriceMinor: 1_000, taxMinor: 400 }],
      returned: [{ lineId: "a", quantity: 2 }],
    });
    expect(result).toMatchObject({ totalMinor: 2_400, fullReturn: true });
  });

  test("returning more than was ordered is refused", async () => {
    await expect(
      raw(refundAmountCompute, {
        lines: [{ id: "a", quantity: 1, unitPriceMinor: 100 }],
        returned: [{ lineId: "a", quantity: 2 }],
      }),
    ).rejects.toThrow(/of 1 ordered/);
  });
});

describe("PurchaseOrderMatch", () => {
  test("a three-way match catches billing for more than arrived", async () => {
    const result = await call<{ pairs: Array<{ status: string }>; ok: boolean }>(
      purchaseOrderMatch,
      {
        invoiceLines: [{ id: "i", poLineId: "p", quantity: 100, unitPriceMinor: 4_750 }],
        poLines: [{ id: "p", quantity: 100, unitPriceMinor: 4_750 }],
        receiptLines: [{ poLineId: "p", quantity: 60 }],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.pairs[0]?.status).toBe("over-receipt");
  });
});

describe("CostBasisCompute", () => {
  test("realizes a gain by the chosen method", async () => {
    const result = await call<{ realizedGainMinor: number }>(costBasisCompute, {
      lots: [{ id: "L", acquiredAt: "2024-01-01T00:00:00Z", quantity: 10, costMinor: 10_000 }],
      disposals: [
        { id: "D", disposedAt: "2026-01-01T00:00:00Z", quantity: 5, proceedsMinor: 9_000 },
      ],
      method: "fifo",
    });
    expect(result.realizedGainMinor).toBe(4_000);
  });

  test("an offset-less timestamp is refused", async () => {
    await expect(
      raw(costBasisCompute, {
        lots: [{ id: "L", acquiredAt: "2024-01-01T00:00:00", quantity: 1, costMinor: 1 }],
        disposals: [],
        method: "fifo",
      }),
    ).rejects.toThrow(/no UTC offset/);
  });
});

describe("SpendLimitCheck", () => {
  test("reports every limit broken and the headroom that would pass", async () => {
    const result = await call<{
      allowed: boolean;
      violations: Array<{ limit: string }>;
      headroomMinor: number;
    }>(spendLimitCheck, {
      proposed: { amountMinor: 50_000, counterparty: "acme" },
      history: [{ id: "s", at: "2026-01-01T10:00:00Z", amountMinor: 80_000 }],
      limits: { perDayMinor: 100_000 },
      now: "2026-01-01T11:00:00Z",
    });
    expect(result.allowed).toBe(false);
    expect(result.headroomMinor).toBe(20_000);
  });
});

describe("RefundAbuseCheck", () => {
  test("reports signals and says they are not a finding", async () => {
    const result = await call<{ note: string; flags: string[] }>(refundAbuseCheck, {
      refunds: [{ id: "r", at: "2026-05-20T00:00:00Z", amountMinor: 5_000 }],
      orders: [{ id: "o", at: "2026-05-15T00:00:00Z", amountMinor: 10_000 }],
      now: "2026-06-01T00:00:00Z",
    });
    expect(result.note).toContain("a person decides");
  });
});

describe("WebhookSignatureVerify", () => {
  const body = '{"type":"payment_intent.succeeded"}';
  const t = 1_700_000_000;

  test("verifies a correctly signed body", async () => {
    process.env["TEST_WEBHOOK_SECRET"] = "whsec_test";
    const sig = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
    const result = await call<{ valid: boolean }>(webhookSignatureVerify, {
      body,
      signatureHeader: `t=${t},v1=${sig}`,
      secretEnvVar: "TEST_WEBHOOK_SECRET",
      now: t * 1000,
    });
    expect(result.valid).toBe(true);
  });

  test("the secret is taken by env var NAME, never inline", () => {
    // A signing key in a spec ends up in a transcript and in a model's
    // context; the schema has no field that would accept one.
    const shape = JSON.stringify(
      Object.keys((webhookSignatureVerify.inputSchema as never as { shape: object }).shape),
    );
    expect(shape).toContain("secretEnvVar");
    expect(shape).not.toContain('"secret"');
  });

  test("a missing secret refuses rather than reporting the event unverified", async () => {
    const out = await raw(webhookSignatureVerify, {
      body,
      signatureHeader: `t=${t},v1=abc`,
      secretEnvVar: "TEST_WEBHOOK_SECRET",
    });
    expect(out).toContain("is not set");
    expect(out).toContain("refusing");
  });
});

describe("StatementParse", () => {
  test("parses a CSV from the workspace", async () => {
    writeFileSync(join(workspace, "s.csv"), "Date,Description,Amount\n2026-01-05,Rent,-1200.00\n");
    const result = await call<{ count: number; totalMinor: number }>(statementParse, {
      file: "s.csv",
    });
    expect(result).toMatchObject({ count: 1, totalMinor: -120_000 });
  });

  test("an ambiguous file is refused until the order is stated", async () => {
    writeFileSync(
      join(workspace, "s.csv"),
      "Date,Description,Amount\n03/04/2026,A,-1.00\n05/06/2026,B,-2.00\n",
    );
    await expect(raw(statementParse, { file: "s.csv" })).rejects.toThrow(
      /day-first or month-first/,
    );
    const result = await call<{ transactions: Array<{ date: string }> }>(statementParse, {
      file: "s.csv",
      dateOrder: "dmy",
    });
    expect(result.transactions[0]?.date).toBe("2026-04-03");
  });

  test("a path outside the workspace is refused", async () => {
    await expect(raw(statementParse, { file: "../outside.csv" })).rejects.toThrow(
      /escapes the workspace/,
    );
  });
});

describe("GlCodeSuggest", () => {
  test("codes what it can and queues what it cannot", async () => {
    const result = await call<{ coded: number; needsReview: number }>(glCodeSuggest, {
      lines: [
        { id: "l1", vendor: "AWS" },
        { id: "l2", vendor: "Mystery" },
      ],
      rules: [
        { id: "cloud", when: [{ path: "vendor", op: "equals", expected: "AWS" }], account: "6500" },
      ],
    });
    expect(result).toMatchObject({ coded: 1, needsReview: 1 });
  });

  test("a rule with no conditions is rejected by the schema", () => {
    expect(
      glCodeSuggest.inputSchema.safeParse({
        lines: [{ id: "l" }],
        rules: [{ id: "all", when: [], account: "1" }],
      }).success,
    ).toBe(false);
  });
});

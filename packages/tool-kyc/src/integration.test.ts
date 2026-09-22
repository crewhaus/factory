/**
 * The tools driven the way the runtime drives them, and the loop they exist to
 * close: check the VAT number on the invoice, look the counterparty up in the
 * company registers, screen the name the registers gave back — and end with a
 * record that says which versions of what answered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { KYC_TOOLS, ORIGINS, _setKycFetch } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;
let dialled: string[];

const NOW = "2026-09-18T12:00:00Z";
const LEI = "5493001KJTIIGC8Y1R12";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

function serve(routes: Record<string, unknown>): void {
  _setKycFetch(async (req) => {
    dialled.push(req.url);
    const route = routes[req.url];
    return route === undefined
      ? new Response(`{"message":"no route"}`, { status: 404 })
      : new Response(JSON.stringify(route), { status: 200 });
  });
}

const SNAPSHOT = {
  source: "OFAC SDN",
  version: "20260917",
  publishedAt: "2026-09-17T00:00:00Z",
  retrievedAt: "2026-09-17T06:00:00Z",
  sourceUrl: "https://sanctionslist.example/sdn",
  entries: [
    { id: "SDN-9", name: "Sovcomflot Shipping Co", kind: "entity", programs: ["RUSSIA-EO14024"] },
    { id: "SDN-1", name: "Mohammed Kharoubi", kind: "person" },
  ],
};

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of KYC_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-kyc-int-"));
  process.chdir(workspace);
  dialled = [];
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setKycFetch(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(KYC_TOOLS.length);
  });

  test("the catalog refuses a second registration of the same name", () => {
    expect(() => catalog.register(KYC_TOOLS[0] as RegisteredTool)).toThrow();
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    serve({
      [`${ORIGINS.vies}/taxation_customs/vies/rest-api/ms/IE/vat/6388047V`]: {
        isValid: true,
        userError: "VALID",
      },
      [`${ORIGINS.gleif}/api/v1/lei-records/${LEI}`]: {
        data: {
          attributes: {
            lei: LEI,
            entity: { legalName: { name: "ACME TRADING LIMITED" }, status: "ACTIVE" },
            registration: { status: "ISSUED" },
          },
        },
      },
    });
    const inputs: Record<string, unknown> = {
      VatIdValidate: { vatId: "IE6388047V", now: NOW },
      EntityRegistryLookup: { lei: LEI, registries: ["gleif"], now: NOW },
      SanctionsScreen: {
        subjects: [{ id: "s1", name: "Mohammed Kharoubi" }],
        lists: [SNAPSHOT],
        now: NOW,
      },
    };
    for (const tool of KYC_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("an input the schema rejects never reaches the tool", async () => {
    const result = await executeTool(
      lookup("VatIdValidate"),
      { vatId: "IE6388047V", unknownField: true },
      { toolUseId: "bad-shape" },
    );
    expect(result.isError).toBe(true);
    expect(dialled).toEqual([]);
  });

  test("a path outside the workspace comes back as an error result", async () => {
    const result = await executeTool(
      lookup("SanctionsScreen"),
      {
        subjects: [{ id: "s1", name: "x" }],
        listFiles: ["../../etc/passwd"],
        now: NOW,
      },
      { toolUseId: "escape" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("escapes the workspace root");
  });

  test("a refusal is a result the caller can read, not a thrown error", async () => {
    writeFileSync(join(workspace, "stale.json"), JSON.stringify(SNAPSHOT));
    const result = await executeTool(
      lookup("SanctionsScreen"),
      {
        subjects: [{ id: "s1", name: "x" }],
        listFiles: ["stale.json"],
        now: "2027-09-18T12:00:00Z",
      },
      { toolUseId: "stale" },
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("refused the whole screen");
  });
});

describe("the loop these exist to close", () => {
  test("check the number, look up the company, screen the name it gave back", async () => {
    serve({
      [`${ORIGINS.vies}/taxation_customs/vies/rest-api/check-vat-number`]: {
        isValid: true,
        userError: "VALID",
        name: "SOVCOMFLOT SHIPPING CO",
        address: "1 QUAY ST",
        requestIdentifier: "WAPIAAAAXY1234567",
      },
      [`${ORIGINS.gleif}/api/v1/lei-records/${LEI}`]: {
        data: {
          attributes: {
            lei: LEI,
            entity: {
              legalName: { name: "Sovcomflot Shipping Co" },
              status: "ACTIVE",
              jurisdiction: "CY",
            },
            registration: { status: "LAPSED" },
          },
        },
      },
    });

    // 1. Is the VAT number on the invoice real, and who does it belong to?
    const vat = await executeTool(
      lookup("VatIdValidate"),
      { vatId: "CY12345678X", requesterVatId: "IE6388047V", now: NOW },
      { toolUseId: "vat" },
    );
    const vatBody = JSON.parse(String(vat.content)) as Record<string, unknown>;
    expect(vatBody["outcome"]).toBe("found");
    // The consultation number is the receipt: it is what an auditor asks for,
    // and it only exists because a requester id was supplied.
    expect(vatBody["consultationNumber"]).toBe("WAPIAAAAXY1234567");
    const registeredName = (vatBody["registration"] as Record<string, string>)["name"] as string;

    // 2. What do the company registers say about them?
    const entity = await executeTool(
      lookup("EntityRegistryLookup"),
      { lei: LEI, registries: ["gleif"], now: NOW },
      { toolUseId: "entity" },
    );
    const entityBody = JSON.parse(String(entity.content)) as Record<string, unknown>;
    const row = (entityBody["registries"] as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ outcome: "found", retrievedAt: "2026-09-18T12:00:00.000Z" });
    // Two statuses, still apart at the end of the chain: the LEI has lapsed,
    // the company has not.
    expect((row?.["record"] as Record<string, unknown>)["status"]).toEqual({
      entityStatus: "ACTIVE",
      registrationStatus: "LAPSED",
    });

    // 3. Screen the name the register returned — not the one on the invoice.
    writeFileSync(join(workspace, "sdn.json"), JSON.stringify(SNAPSHOT));
    const screen = await executeTool(
      lookup("SanctionsScreen"),
      {
        subjects: [{ id: "counterparty", name: registeredName, kind: "entity" }],
        listFiles: ["sdn.json"],
        now: NOW,
      },
      { toolUseId: "screen" },
    );
    const screenBody = JSON.parse(String(screen.content)) as Record<string, unknown>;
    const subject = (screenBody["subjects"] as Array<Record<string, unknown>>)[0];
    const candidate = (subject?.["candidates"] as Array<Record<string, unknown>>)[0];
    expect(candidate).toMatchObject({ entryId: "SDN-9", listVersion: "20260917" });
    expect(candidate?.["programs"]).toEqual(["RUSSIA-EO14024"]);

    // 4. What survives into the file: three artefacts, each naming its source.
    const dossier = {
      vat: { outcome: vatBody["outcome"], consultationNumber: vatBody["consultationNumber"] },
      register: { sourceUrl: row?.["sourceUrl"], retrievedAt: row?.["retrievedAt"] },
      screening: (screenBody["evidence"] as Record<string, unknown>)["lists"],
    };
    expect(dossier.register.sourceUrl).toBe(`${ORIGINS.gleif}/api/v1/lei-records/${LEI}`);
    expect(dossier.screening).toEqual([
      expect.objectContaining({
        source: "OFAC SDN",
        version: "20260917",
        sourceUrl: "https://sanctionslist.example/sdn",
      }),
    ]);
    // And no verdict at any step.
    expect(String(screen.content)).toContain("a determination a person makes");
  });

  test("when VIES is down the chain reports could-not-check, and says to retry", async () => {
    // The whole reason for the third outcome: this must not read as "the
    // counterparty's VAT number is invalid", because the next step a harness
    // takes from those two is different.
    serve({
      [`${ORIGINS.vies}/taxation_customs/vies/rest-api/ms/CY/vat/12345678X`]: {
        isValid: false,
        userError: "MS_UNAVAILABLE",
      },
    });
    const vat = await executeTool(
      lookup("VatIdValidate"),
      { vatId: "CY12345678X", now: NOW },
      { toolUseId: "outage" },
    );
    const body = JSON.parse(String(vat.content)) as Record<string, unknown>;
    expect(body).toMatchObject({ outcome: "unavailable", retryable: true });
    expect(String(body["basis"])).toContain("member state");
    // The local half of the answer is still there and still true.
    expect((body["syntax"] as Record<string, unknown>)["wellFormed"]).toBe(true);
  });
});

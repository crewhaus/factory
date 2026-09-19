/**
 * Every tool this package registers, driven the way the executor drives them,
 * against a stubbed register and a real temporary workspace.
 *
 * No test here reaches the network: the fetch seam is replaced in `beforeEach`
 * and restored in `afterEach`, and several tests assert that the seam was never
 * called at all — `SanctionsScreen` must never call it under any input, which
 * is a property of the design rather than of these fixtures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { z } from "zod";
import {
  KYC_TOOLS,
  ORIGINS,
  _setKycFetch,
  entityRegistryLookup,
  sanctionsScreen,
  vatIdValidate,
} from "./index";
import { ToolPermissionError } from "./paths";

const originalCwd = process.cwd();
let workspace: string;
let calls: Array<{ url: string; method: string; body: string | null; accept: string | null }>;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and these tools read only its signal.
const ctx = {} as any;

const NOW = "2026-09-18T12:00:00Z";
const LEI = "5493001KJTIIGC8Y1R12";

type Route = unknown | { status: number; headers?: Record<string, string>; body?: string };

/** Answer from a table of URLs, and record everything that was asked for. */
function serve(routes: Record<string, Route>): void {
  _setKycFetch(async (req) => {
    calls.push({
      url: req.url,
      method: req.method,
      body: req.method === "POST" ? await req.text() : null,
      accept: req.headers.get("accept"),
    });
    const route = routes[req.url];
    if (route === undefined) return new Response(`{"message":"no route"}`, { status: 404 });
    const asStatus = route as { status?: number; headers?: Record<string, string>; body?: string };
    if (typeof asStatus?.status === "number") {
      return new Response(asStatus.body ?? "", {
        status: asStatus.status,
        headers: asStatus.headers ?? {},
      });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  });
}

/** A seam that fails the test if anything dials at all. */
function serveNothing(): void {
  _setKycFetch(async (req) => {
    calls.push({ url: req.url, method: req.method, body: null, accept: null });
    throw new Error(`nothing should have been dialled, but ${req.url} was`);
  });
}

async function raw(tool: RegisteredTool, input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return (await tool.execute(parsed.data, ctx)) as string;
}

async function call<T = Record<string, unknown>>(tool: RegisteredTool, input: unknown): Promise<T> {
  return JSON.parse(await raw(tool, input)) as T;
}

const SNAPSHOT = {
  source: "OFAC SDN",
  version: "20260917",
  publishedAt: "2026-09-17T00:00:00Z",
  retrievedAt: "2026-09-17T06:00:00Z",
  entries: [
    {
      id: "SDN-1",
      name: "Mohammed Kharoubi",
      kind: "person",
      countries: ["SY"],
      aliases: [{ name: "Abu Mohammed", quality: "weak" }],
    },
    { id: "SDN-2", name: "Sovcomflot Shipping Co", kind: "entity" },
  ],
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-kyc-"));
  process.chdir(workspace);
  calls = [];
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setKycFetch(undefined);
});

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("every tool is exported in KYC_TOOLS, with a unique PascalCase name", () => {
    expect(KYC_TOOLS.length).toBe(3);
    const names = KYC_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of KYC_TOOLS) expect(tool.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("the two that read a register declare the network they cross", () => {
    for (const tool of [vatIdValidate, entityRegistryLookup]) {
      expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name: tool.name,
        scope: "external",
        io: "network",
      });
    }
  });

  test("SanctionsScreen is internal, because screening a name must not disclose it", () => {
    expect({ scope: sanctionsScreen.scope, io: sanctionsScreen.ioCapability }).toEqual({
      scope: "internal",
      io: undefined,
    });
  });

  test("every tool is read-only and non-destructive", () => {
    for (const tool of KYC_TOOLS) {
      expect({ name: tool.name, readOnly: tool.readOnly, destructive: tool.destructive }).toEqual({
        name: tool.name,
        readOnly: true,
        destructive: false,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const tool of KYC_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(200);
      expect(tool.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const tool of KYC_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(42).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });

  test("no schema anywhere accepts a credential or anything that could move money", () => {
    // The house rule this enforces: nothing in this package can be pointed at a
    // bank. There is no field to pass an account, a card, a key or an amount
    // to, so no configuration of these tools transmits a payment instruction.
    // The walk recurses, because a forbidden field hidden one level down in
    // `subjects[]` would pass a top-level `shape` check — and it asserts its
    // OWN hit count, because a scanner that silently matched nothing reports
    // exactly the same clean result as a package with nothing to find.
    const keys = KYC_TOOLS.flatMap((tool) => schemaKeys(tool.inputSchema));
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain("vatId");
    expect(keys).toContain("subjects.name");
    const flat = keys.join(" ").toLowerCase();
    for (const forbidden of [
      "password",
      "apikey",
      "secret",
      "token",
      "privatekey",
      "iban",
      "accountnumber",
      "routing",
      "sortcode",
      "cardnumber",
      "cvv",
      "amount",
      "payment",
      "transfer",
    ]) {
      expect({ forbidden, present: flat.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  test("no tool returns a boolean verdict field", async () => {
    // Three outcomes do not fit in a boolean, and a `valid: false` on an
    // outage is the exact defect this package exists to prevent. The absence
    // is asserted rather than trusted.
    serve({
      [`${ORIGINS.vies}/taxation_customs/vies/rest-api/ms/IE/vat/6388047V`]: {
        isValid: true,
        userError: "VALID",
      },
    });
    const vat = await raw(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    serveNothing();
    const screen = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Mohammed Kharoubi" }],
      lists: [SNAPSHOT],
      now: NOW,
    });
    for (const [what, text] of [
      ["VatIdValidate", vat],
      ["SanctionsScreen", screen],
    ] as const) {
      for (const forbidden of ['"valid":', '"isValid":', '"sanctioned":', '"ok":true']) {
        expect({ what, forbidden, present: text.includes(forbidden) }).toEqual({
          what,
          forbidden,
          present: false,
        });
      }
    }
    // What each returns INSTEAD: a named outcome for the register reads, and
    // for a screening a list of candidates plus the note that nobody has been
    // cleared or convicted by it.
    expect(vat).toContain('"outcome"');
    expect(screen).toContain('"candidates"');
    expect(screen).toContain("a determination a person makes");
  });
});

/** Every field name a schema accepts, dotted, including nested ones. */
function schemaKeys(schema: unknown, prefix = "", depth = 0): string[] {
  if (depth > 8 || schema === null || typeof schema !== "object") return [];
  const def = (schema as { _def?: { typeName?: string; innerType?: unknown; type?: unknown } })
    ._def;
  const typeName = def?.typeName;
  if (typeName === "ZodObject") {
    const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
    return Object.entries(shape).flatMap(([key, value]) => [
      prefix === "" ? key : `${prefix}.${key}`,
      ...schemaKeys(value, prefix === "" ? key : `${prefix}.${key}`, depth + 1),
    ]);
  }
  if (typeName === "ZodArray") return schemaKeys(def?.type, prefix, depth + 1);
  if (def?.innerType !== undefined) return schemaKeys(def.innerType, prefix, depth + 1);
  return [];
}

// ---------------------------------------------------------------------------

describe("VatIdValidate", () => {
  const viesGet = `${ORIGINS.vies}/taxation_customs/vies/rest-api/ms/IE/vat/6388047V`;
  const viesPost = `${ORIGINS.vies}/taxation_customs/vies/rest-api/check-vat-number`;

  test("a registered number comes back as found, with the register's own details", async () => {
    serve({
      [viesGet]: {
        isValid: true,
        userError: "VALID",
        name: "ACME TRADING LIMITED",
        address: "1 DOCK RD, DUBLIN",
      },
    });
    const result = await call(vatIdValidate, { vatId: "IE 6388047 V", now: NOW });
    expect(result).toMatchObject({
      vatId: "IE6388047V",
      country: "IE",
      outcome: "found",
      register: "vies",
      dialled: true,
      checkedAt: "2026-09-18T12:00:00.000Z",
    });
    expect(result["sourceUrl"]).toBe(viesGet);
    expect((result["registration"] as Record<string, string>)["name"]).toBe("ACME TRADING LIMITED");
  });

  test("a member-state outage is unavailable and says which, not notFound", async () => {
    serve({ [viesGet]: { isValid: false, userError: "MS_UNAVAILABLE" } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("member state's own system did not answer");
    expect(result["retryable"]).toBe(true);
  });

  test("an HTTP failure is unavailable with the status, never a verdict", async () => {
    serve({ [viesGet]: { status: 500 } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    // A timeout would also produce "not found" from a tool that collapsed
    // these, so the reason is asserted and not just the outcome.
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("500");
    expect(result["retryable"]).toBe(true);
  });

  test("a 403 says this tool holds no credential, rather than reporting nothing found", async () => {
    serve({ [viesGet]: { status: 403 } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("holds no credential");
    expect(result["retryable"]).toBe(false);
  });

  test("the two-party call POSTs the requester and returns the consultation number", async () => {
    serve({
      [viesPost]: { isValid: true, userError: "VALID", requestIdentifier: "WAPIAAAAXY1234567" },
    });
    const result = await call(vatIdValidate, {
      vatId: "IE6388047V",
      requesterVatId: "DE123456789",
      now: NOW,
    });
    expect(result["consultationNumber"]).toBe("WAPIAAAAXY1234567");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      countryCode: "IE",
      vatNumber: "6388047V",
      requesterMemberStateCode: "DE",
      requesterNumber: "123456789",
    });
  });

  test("without a requester it says why there is no consultation number", async () => {
    serve({ [viesGet]: { isValid: true, userError: "VALID" } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(String(result["consultationNumberAbsent"])).toContain("no requesterVatId");
    expect(calls[0]?.method).toBe("GET");
  });

  test("a malformed id is notFound from the syntax table, without dialling", async () => {
    serveNothing();
    const result = await call(vatIdValidate, { vatId: "DE12345", now: NOW });
    expect(result).toMatchObject({ outcome: "notFound", register: "syntax", dialled: false });
    expect(String(result["basis"])).toContain("9 digits");
    expect(calls).toEqual([]);
  });

  test("syntaxOnly reports registration as unchecked, not as valid", async () => {
    serveNothing();
    const result = await call(vatIdValidate, {
      vatId: "IE6388047V",
      syntaxOnly: true,
      now: NOW,
    });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("no register was asked");
    expect(calls).toEqual([]);
  });

  test("GB goes to HMRC with its versioned Accept header", async () => {
    const url = `${ORIGINS.hmrc}/organisations/vat/check-vat-number/lookup/123456782`;
    serve({
      [url]: {
        target: { name: "ACME LTD", vatNumber: "123456782" },
        processingDate: "2026-09-18T00:00:00+00:00",
      },
    });
    const result = await call(vatIdValidate, { vatId: "GB123456782", now: NOW });
    expect(result).toMatchObject({ outcome: "found", register: "hmrc" });
    expect(calls[0]?.accept).toBe("application/vnd.hmrc.1.0+json");
  });

  test("HMRC's 404 is the one 404 that really means not registered", async () => {
    serve({});
    const result = await call(vatIdValidate, { vatId: "GB123456782", now: NOW });
    expect(result).toMatchObject({ outcome: "notFound", register: "hmrc", code: "NOT_FOUND" });
  });

  test("HMRC maintenance is unavailable", async () => {
    const url = `${ORIGINS.hmrc}/organisations/vat/check-vat-number/lookup/123456782`;
    serve({ [url]: { status: 503 } });
    const result = await call(vatIdValidate, { vatId: "GB123456782", now: NOW });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("503");
  });

  test("GB check digits travel with the answer", async () => {
    const url = `${ORIGINS.hmrc}/organisations/vat/check-vat-number/lookup/123456789`;
    serve({ [url]: { status: 503 } });
    const result = await call(vatIdValidate, { vatId: "GB123456789", now: NOW });
    expect((result["syntax"] as Record<string, unknown>)["checksum"]).toMatchObject({
      passed: false,
    });
  });

  test("an unreadable requester id is refused before anything is dialled", async () => {
    serveNothing();
    const line = await raw(vatIdValidate, {
      vatId: "IE6388047V",
      requesterVatId: "ZZ1",
      now: NOW,
    });
    expect(line).toContain("requesterVatId");
    expect(calls).toEqual([]);
  });

  test("a requester the register cannot use is refused before dialling", async () => {
    // HMRC takes a GB requester and VIES takes a member state's. Sending the
    // wrong one asks about somebody else's registration under the same digits.
    serveNothing();
    const toHmrc = await raw(vatIdValidate, {
      vatId: "GB123456782",
      requesterVatId: "IE6388047V",
      now: NOW,
    });
    expect(toHmrc).toContain("only to a GB requester");
    const toVies = await raw(vatIdValidate, {
      vatId: "IE6388047V",
      requesterVatId: "GB123456782",
      now: NOW,
    });
    expect(toVies).toContain("no longer one");
    expect(calls).toEqual([]);
  });

  test("a contradictory country is a refusal line, not a guess", async () => {
    serveNothing();
    const line = await raw(vatIdValidate, { vatId: "IE6388047V", country: "IT", now: NOW });
    expect(line).toContain("one of them is wrong");
  });

  test("the notes say registration is not identity", async () => {
    serve({ [viesGet]: { isValid: true, userError: "VALID" } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(JSON.stringify(result["notes"])).toContain("not that the party invoicing you");
  });

  test("the schema takes nothing but the id, the requester and the knobs", () => {
    expect(
      vatIdValidate.inputSchema.safeParse({ vatId: "IE6388047V", iban: "IE29AIBK" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("EntityRegistryLookup", () => {
  const leiUrl = `${ORIGINS.gleif}/api/v1/lei-records/${LEI}`;
  const tickerUrl = `${ORIGINS.edgarFiles}/files/company_tickers.json`;
  const submissionsUrl = `${ORIGINS.edgarData}/submissions/CIK0000320193.json`;

  const gleifRecord = {
    data: {
      attributes: {
        lei: LEI,
        entity: {
          legalName: { name: "APPLE INC." },
          status: "ACTIVE",
          jurisdiction: "US-CA",
          legalAddress: { addressLines: ["One Apple Park Way"], city: "Cupertino", country: "US" },
        },
        registration: { status: "LAPSED", nextRenewalDate: "2026-01-01T00:00:00Z" },
      },
    },
  };

  const edgarRecord = {
    cik: "320193",
    name: "Apple Inc.",
    tickers: ["AAPL"],
    entityType: "operating",
    formerNames: [{ name: "APPLE COMPUTER INC" }],
    filings: { recent: { form: ["10-K"], filingDate: ["2026-08-01"] } },
  };

  test("an LEI read returns one row per register, with source URLs and no merge", async () => {
    serve({ [leiUrl]: gleifRecord });
    const result = await call(entityRegistryLookup, {
      lei: LEI,
      registries: ["gleif"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      registry: "gleif",
      outcome: "found",
      sourceUrl: leiUrl,
      retrievedAt: "2026-09-18T12:00:00.000Z",
    });
    const record = rows[0]?.["record"] as Record<string, unknown>;
    expect(record["status"]).toEqual({ entityStatus: "ACTIVE", registrationStatus: "LAPSED" });
    expect(String(result["note"])).toContain("LAPSED registration is usually an unpaid renewal");
  });

  test("a mistyped LEI is refused before dialling, with the check digits named", async () => {
    serveNothing();
    const line = await raw(entityRegistryLookup, { lei: "5493001KJTIIGC8Y1R13", now: NOW });
    expect(line).toContain("check digits do not match");
    expect(calls).toEqual([]);
  });

  test("a value that is not LEI-shaped is refused with the shape", async () => {
    serveNothing();
    const line = await raw(entityRegistryLookup, { lei: "NOT-AN-LEI-AT-ALL!!!", now: NOW });
    expect(line).toContain("18 alphanumerics then 2 check digits");
  });

  test("GLEIF's 404 is notFound with a reason, not an error", async () => {
    serve({});
    const result = await call(entityRegistryLookup, { lei: LEI, registries: ["gleif"], now: NOW });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "notFound" });
    expect(String(rows[0]?.["reason"])).toContain("no record for this LEI");
  });

  test("a rate limit is unavailable and retryable, never notFound", async () => {
    serve({ [leiUrl]: { status: 429, headers: { "retry-after": "60" } } });
    const result = await call(entityRegistryLookup, { lei: LEI, registries: ["gleif"], now: NOW });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "unavailable", retryable: true });
    expect(String(rows[0]?.["reason"])).toContain("rate-limited");
  });

  test("a ticker resolves through EDGAR's own map and zero-pads the CIK", async () => {
    serve({
      [tickerUrl]: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } },
      [submissionsUrl]: edgarRecord,
    });
    const result = await call(entityRegistryLookup, {
      ticker: "aapl",
      registries: ["sec-edgar"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "found", sourceUrl: submissionsUrl });
    expect(String(rows[0]?.["reason"])).toContain("CIK 0000320193");
    expect(calls.map((c) => c.url)).toEqual([tickerUrl, submissionsUrl]);
  });

  test("a ticker the map does not list is notFound, with why that is not proof", async () => {
    serve({ [tickerUrl]: {} });
    const result = await call(entityRegistryLookup, {
      ticker: "ZZZZ",
      registries: ["sec-edgar"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "notFound" });
    expect(String(rows[0]?.["reason"])).toContain("foreign or private issuer");
  });

  test("the ticker map failing to load is could-not-check, not 'no such company'", async () => {
    // The map is a fixed URL on www.sec.gov, and the company is looked up
    // AFTER it loads. A 404 on it means SEC moved the file — the ticker was
    // never looked for — so reading that as notFound would invent a fact about
    // a counterparty out of a broken fetch. The real negative is the test
    // above, where the map loads and does not carry the ticker.
    serve({});
    const result = await call(entityRegistryLookup, {
      ticker: "AAPL",
      registries: ["sec-edgar"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "unavailable", retryable: false });
    // The reason, not just the outcome: a deadline would also produce
    // "unavailable" here, and these are different things to tell an operator.
    expect(String(rows[0]?.["reason"])).toContain("ticker→CIK map could not be read");
    expect(String(rows[0]?.["reason"])).toContain("404");
  });

  test("GLEIF's search endpoint failing is could-not-check, not 'matched no name'", async () => {
    // GLEIF answers a search that matches nothing with 200 and an empty
    // `data`, which is the notFound test above. A 404 is the endpoint moving.
    serve({});
    const result = await call(entityRegistryLookup, {
      name: "Acme Trading Limited",
      registries: ["gleif"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "unavailable" });
    expect(String(rows[0]?.["reason"])).toContain("legal-name search could not be read");
  });

  test("hits GLEIF returns in an unreadable shape still leave a row saying so", async () => {
    // Filtering them out returned an EMPTY array of rows, so the register
    // disappeared from `registries` altogether — no outcome at all — and the
    // comparison said "no register returned a record", which reads like GLEIF
    // had nothing to say rather than like this tool could not read it.
    const searchUrl = `${ORIGINS.gleif}/api/v1/lei-records?filter%5Bentity.legalName%5D=Acme+Trading+Limited&page%5Bsize%5D=5`;
    serve({ [searchUrl]: { data: [{ id: "X", type: "lei-records" }, { id: "Y" }] } });
    const result = await call(entityRegistryLookup, {
      name: "Acme Trading Limited",
      registries: ["gleif"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ registry: "gleif", outcome: "unavailable" });
    expect(String(rows[0]?.["reason"])).toContain("2 hits in a shape this tool could not read");
  });

  test("a name search on EDGAR ranks the map's titles rather than substring-matching", async () => {
    serve({
      [tickerUrl]: {
        "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
        "1": { cik_str: 111, ticker: "PNPL", title: "Pineapple Holdings Inc" },
      },
      [submissionsUrl]: edgarRecord,
    });
    const result = await call(entityRegistryLookup, {
      name: "Apple Inc",
      registries: ["sec-edgar"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "found" });
    expect(String(rows[0]?.["reason"])).toContain("listed filers only");
  });

  test("a GLEIF name search with no hits is notFound, and says an LEI is not universal", async () => {
    const searchUrl = `${ORIGINS.gleif}/api/v1/lei-records?filter%5Bentity.legalName%5D=Acme+Trading+Limited&page%5Bsize%5D=5`;
    serve({ [searchUrl]: { data: [] } });
    const result = await call(entityRegistryLookup, {
      name: "Acme Trading Limited",
      registries: ["gleif"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "notFound" });
    expect(String(rows[0]?.["reason"])).toContain("only required of parties");
  });

  test("GLEIF cannot be searched by CIK, and says so instead of guessing", async () => {
    serve({ [submissionsUrl]: edgarRecord });
    const result = await call(entityRegistryLookup, { cik: "320193", now: NOW });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    const gleif = rows.find((row) => row["registry"] === "gleif");
    expect(gleif).toMatchObject({ outcome: "unavailable" });
    expect(String(gleif?.["reason"])).toContain("means nothing to it");
  });

  test("the comparison shows the disagreement and explains a rename", async () => {
    const searchUrl = `${ORIGINS.gleif}/api/v1/lei-records?filter%5Bentity.legalName%5D=Apple+Computer+Inc&page%5Bsize%5D=5`;
    serve({
      [searchUrl]: {
        data: [
          {
            attributes: {
              lei: LEI,
              entity: { legalName: { name: "APPLE COMPUTER INC" }, status: "ACTIVE" },
              registration: { status: "ISSUED" },
            },
          },
        ],
      },
      [tickerUrl]: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Computer Inc" } },
      [submissionsUrl]: edgarRecord,
    });
    const result = await call(entityRegistryLookup, { name: "Apple Computer Inc", now: NOW });
    const comparison = result["comparison"] as Record<string, unknown>;
    const names = comparison["legalNames"] as Array<Record<string, unknown>>;
    expect(names.map((n) => n["registry"])).toEqual(["gleif", "sec-edgar"]);
    const agreement = comparison["nameAgreement"] as Record<string, unknown>;
    expect(String(agreement["basis"])).toContain("tool-text");
    // EDGAR carries "APPLE COMPUTER INC" as a FORMER name, which is what turns
    // a name disagreement into a rename rather than into two companies.
    expect(agreement["explainedByFormerName"]).toEqual(["APPLE COMPUTER INC"]);
  });

  test("the comparison pairs one row per register, not two hits from the same one", async () => {
    // A name search returns several GLEIF hits. Comparing the first two rows
    // would report a cross-register agreement that was never computed —
    // GLEIF against GLEIF, labelled as GLEIF against EDGAR.
    const searchUrl = `${ORIGINS.gleif}/api/v1/lei-records?filter%5Bentity.legalName%5D=Apple+Inc&page%5Bsize%5D=5`;
    const gleifHit = (name: string, lei: string) => ({
      attributes: {
        lei,
        entity: { legalName: { name }, status: "ACTIVE" },
        registration: { status: "ISSUED" },
      },
    });
    serve({
      [searchUrl]: {
        data: [
          gleifHit("APPLE INC.", LEI),
          gleifHit("APPLE BANK FOR SAVINGS", "549300ABCDEFGHIJ0088"),
        ],
      },
      [tickerUrl]: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc" } },
      [submissionsUrl]: edgarRecord,
    });
    const result = await call(entityRegistryLookup, { name: "Apple Inc", now: NOW });
    const comparison = result["comparison"] as Record<string, unknown>;
    const agreement = comparison["nameAgreement"] as Record<string, unknown>;
    expect(String(agreement["basis"])).toContain("gleif");
    expect(String(agreement["basis"])).toContain("sec-edgar");
    expect(String(agreement["basis"])).not.toContain("APPLE BANK");
  });

  test("a former name only explains a disagreement if it matches the OTHER register", async () => {
    // Each former name used to be compared against BOTH current names, so a
    // register could explain the gap by agreeing with itself: GLEIF carries a
    // transliteration of its own legal name, that pair scores 1.0, and the
    // caller was told a 0.42 disagreement between two unrelated banks was "a
    // rename rather than two companies". That is the same shape as comparing
    // two GLEIF hits and labelling it cross-register, one level down — and it
    // is the sentence somebody pays an invoice on.
    const searchUrl = `${ORIGINS.gleif}/api/v1/lei-records?filter%5Bentity.legalName%5D=Nordea+Bank&page%5Bsize%5D=5`;
    serve({
      [searchUrl]: {
        data: [
          {
            attributes: {
              lei: LEI,
              entity: {
                legalName: { name: "NORDEA BANK ABP" },
                status: "ACTIVE",
                transliteratedOtherNames: [{ name: "Nordea Bank Abp" }],
              },
              registration: { status: "ISSUED" },
            },
          },
        ],
      },
      [tickerUrl]: { "0": { cik_str: 1111111, ticker: "NRDBY", title: "Nordea Bank" } },
      [`${ORIGINS.edgarData}/submissions/CIK0001111111.json`]: {
        cik: "1111111",
        name: "WELLS FARGO & COMPANY",
        entityType: "operating",
      },
    });
    const result = await call(entityRegistryLookup, { name: "Nordea Bank", now: NOW });
    const agreement = (result["comparison"] as Record<string, unknown>)["nameAgreement"] as Record<
      string,
      unknown
    >;
    expect(agreement["explainedByFormerName"]).toBeUndefined();
    // The disagreement itself survives, which is the point of not merging.
    expect(Number(agreement["score"])).toBeLessThan(0.65);
  });

  test("one register answering means there is nothing to compare", async () => {
    serve({ [leiUrl]: gleifRecord });
    const result = await call(entityRegistryLookup, { lei: LEI, registries: ["gleif"], now: NOW });
    expect(String((result["comparison"] as Record<string, unknown>)["note"])).toContain(
      "nothing to compare",
    );
  });

  test("no identifier at all is a refusal line", async () => {
    serveNothing();
    expect(await raw(entityRegistryLookup, { now: NOW })).toContain(
      "at least one of lei, cik, ticker or name",
    );
  });

  test("a CIK that is not a CIK is unavailable with the format, not a 404", async () => {
    serveNothing();
    const result = await call(entityRegistryLookup, {
      cik: "AAPL",
      registries: ["sec-edgar"],
      now: NOW,
    });
    const rows = result["registries"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ outcome: "unavailable" });
    expect(String(rows[0]?.["reason"])).toContain("up to ten digits");
  });

  test("nothing is ever dialled outside the four constant origins", async () => {
    serve({
      [leiUrl]: gleifRecord,
      [tickerUrl]: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } },
      [submissionsUrl]: edgarRecord,
    });
    await call(entityRegistryLookup, { lei: LEI, ticker: "AAPL", now: NOW });
    expect(calls.length).toBeGreaterThan(0);
    const allowed = Object.values(ORIGINS);
    for (const made of calls) {
      expect({ url: made.url, ok: allowed.some((origin) => made.url.startsWith(origin)) }).toEqual({
        url: made.url,
        ok: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("SanctionsScreen", () => {
  test("screens against an inline snapshot and reports the evidence", async () => {
    serveNothing();
    const result = await call(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Mohammed Kharoubi", kind: "person" }],
      lists: [SNAPSHOT],
      now: NOW,
    });
    const evidence = result["evidence"] as Record<string, unknown>;
    expect((evidence["lists"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      source: "OFAC SDN",
      version: "20260917",
      ageDays: 1,
    });
    const subjects = result["subjects"] as Array<Record<string, unknown>>;
    expect((subjects[0]?.["candidates"] as unknown[]).length).toBe(1);
    expect(String(result["note"])).toContain("a determination a person makes");
  });

  test("it never dials anything, whatever it is asked", async () => {
    // The privacy property, asserted rather than claimed: a counterparty's
    // name is not sent anywhere to be screened.
    serveNothing();
    await call(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Mohammed Kharoubi", country: "SY", dateOfBirth: "1965-03-02" }],
      lists: [SNAPSHOT],
      now: NOW,
    });
    expect(calls).toEqual([]);
  });

  test("an inline list with no version is rejected by the schema", () => {
    const { version: _dropped, ...noVersion } = SNAPSHOT;
    const parsed = sanctionsScreen.inputSchema.safeParse({
      subjects: [{ id: "s1", name: "x" }],
      lists: [noVersion],
    });
    expect(parsed.success).toBe(false);
  });

  test("a snapshot on disk is read and screened", async () => {
    serveNothing();
    writeFileSync(join(workspace, "sdn.json"), JSON.stringify(SNAPSHOT));
    const result = await call(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Sovcomflot Shipping Limited", kind: "entity" }],
      listFiles: ["sdn.json"],
      now: NOW,
    });
    const subjects = result["subjects"] as Array<Record<string, unknown>>;
    const candidates = subjects[0]?.["candidates"] as Array<Record<string, unknown>>;
    expect(candidates[0]).toMatchObject({ entryId: "SDN-2", list: "OFAC SDN" });
    expect(candidates[0]?.["droppedSuffixes"]).toEqual(["co"]);
  });

  test("a file outside the workspace is refused by the path resolver", async () => {
    serveNothing();
    expect(
      raw(sanctionsScreen, {
        subjects: [{ id: "s1", name: "x" }],
        listFiles: ["../../etc/passwd"],
        now: NOW,
      }),
    ).rejects.toThrow(ToolPermissionError);
  });

  test("a snapshot that is not there is refused in this package's own words", async () => {
    serveNothing();
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "x" }],
      listFiles: ["missing.json"],
      now: NOW,
    });
    expect(line).toContain("no such file in the workspace");
    // Not the raw ENOENT, which carries this machine's absolute path.
    expect(line).not.toContain(workspace);
  });

  test("a file that is not JSON is refused by name", async () => {
    serveNothing();
    writeFileSync(join(workspace, "sdn.json"), "not json at all");
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "x" }],
      listFiles: ["sdn.json"],
      now: NOW,
    });
    expect(line).toContain("sdn.json");
    expect(line).toContain("not JSON");
  });

  test("a file missing its version is refused, naming the file and the field", async () => {
    serveNothing();
    const { version: _dropped, ...noVersion } = SNAPSHOT;
    writeFileSync(join(workspace, "sdn.json"), JSON.stringify(noVersion));
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "x" }],
      listFiles: ["sdn.json"],
      now: NOW,
    });
    expect(line).toContain("sdn.json");
    expect(line).toContain("version");
  });

  test("a stale list refuses the WHOLE screen, not just that list", async () => {
    serveNothing();
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Mohammed Kharoubi" }],
      lists: [SNAPSHOT, { ...SNAPSHOT, source: "UK OFSI", publishedAt: "2026-01-01T00:00:00Z" }],
      now: NOW,
    });
    expect(line).toContain("refused the whole screen");
    expect(line).toContain("UK OFSI");
    expect(line).toContain("260 days ago");
  });

  test("maxAgeDays 0 turns the staleness check off deliberately", async () => {
    serveNothing();
    const result = await call(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Mohammed Kharoubi" }],
      lists: [{ ...SNAPSHOT, publishedAt: "2020-01-01T00:00:00Z" }],
      maxAgeDays: 0,
      now: NOW,
    });
    expect(result["subjects"]).toBeDefined();
  });

  test("more lists than the cap is a refusal that counts them", async () => {
    serveNothing();
    const many = Array.from({ length: 16 }, (_, i) => ({ ...SNAPSHOT, source: `list ${i}` }));
    writeFileSync(join(workspace, "sdn.json"), JSON.stringify(SNAPSHOT));
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "x" }],
      lists: many,
      listFiles: ["sdn.json"],
      now: NOW,
    });
    expect(line).toContain("at most 16 lists");
    expect(line).toContain("17 were supplied");
  });

  test("no lists at all is a refusal, because empty reads like clean", async () => {
    serveNothing();
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "x" }],
      now: NOW,
    });
    expect(line).toContain("needs at least one list");
  });

  test("a timestamp with no UTC offset in the snapshot is refused", async () => {
    serveNothing();
    const line = await raw(sanctionsScreen, {
      subjects: [{ id: "s1", name: "x" }],
      lists: [{ ...SNAPSHOT, retrievedAt: "2026-09-17 06:00:00" }],
      now: NOW,
    });
    expect(line).toContain("retrievedAt");
    expect(line).toContain("no UTC offset");
  });

  test("weak aliases come back in their own bucket", async () => {
    serveNothing();
    const result = await call(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Abu Mohammed", kind: "person" }],
      lists: [SNAPSHOT],
      now: NOW,
    });
    const subjects = result["subjects"] as Array<Record<string, unknown>>;
    const weak = subjects[0]?.["weakAliasCandidates"] as Array<Record<string, unknown>>;
    expect(weak[0]).toMatchObject({ aliasQuality: "weak", matchedOn: "alias" });
    expect(subjects[0]?.["candidates"]).toEqual([]);
  });

  test("nothing over the threshold is reported as not a clearance", async () => {
    serveNothing();
    const result = await call(sanctionsScreen, {
      subjects: [{ id: "s1", name: "Grace O'Malley", kind: "person" }],
      lists: [SNAPSHOT],
      now: NOW,
    });
    const subjects = result["subjects"] as Array<Record<string, unknown>>;
    expect(subjects[0]?.["candidates"]).toEqual([]);
    expect(String(subjects[0]?.["note"])).toContain("not a clearance");
  });

  test("the clock is injected, so the same screen replays identically", async () => {
    serveNothing();
    const input = {
      subjects: [{ id: "s1", name: "Mohammed Kharoubi", kind: "person" }],
      lists: [SNAPSHOT],
      now: NOW,
    };
    expect(await raw(sanctionsScreen, input)).toBe(await raw(sanctionsScreen, input));
  });

  test("a now without an offset is refused rather than read as local time", async () => {
    serveNothing();
    expect(
      raw(sanctionsScreen, {
        subjects: [{ id: "s1", name: "x" }],
        lists: [SNAPSHOT],
        now: "2026-09-18 12:00:00",
      }),
    ).rejects.toThrow(/no UTC offset/);
  });
});

// ---------------------------------------------------------------------------

describe("the redirect and body rules, through a tool", () => {
  const viesGet = `${ORIGINS.vies}/taxation_customs/vies/rest-api/ms/IE/vat/6388047V`;
  const viesPost = `${ORIGINS.vies}/taxation_customs/vies/rest-api/check-vat-number`;

  test("a redirect off the register's own origin is refused, not followed", async () => {
    serve({
      [viesGet]: { status: 302, headers: { location: "https://evil.example/answer" } },
    });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("refusing a redirect");
    expect(calls.map((c) => c.url)).toEqual([viesGet]);
  });

  test("a redirect loop ends in a refusal rather than in a hang", async () => {
    serve({ [viesGet]: { status: 302, headers: { location: viesGet } } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(String(result["basis"])).toContain("too many redirects");
  });

  test("a POST is never redirected, because the body carries the requester's own id", async () => {
    serve({ [viesPost]: { status: 307, headers: { location: viesGet } } });
    const result = await call(vatIdValidate, {
      vatId: "IE6388047V",
      requesterVatId: "DE123456789",
      now: NOW,
    });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("does not re-send a body");
    expect(calls).toHaveLength(1);
  });

  test("a 200 that is not JSON is unavailable, with what arrived instead", async () => {
    serve({ [viesGet]: { status: 200, body: "<html>maintenance</html>" } });
    const result = await call(vatIdValidate, { vatId: "IE6388047V", now: NOW });
    expect(result["outcome"]).toBe("unavailable");
    expect(String(result["basis"])).toContain("not JSON");
  });
});

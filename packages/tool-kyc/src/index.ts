/**
 * @crewhaus/tool-kyc — checking who you are about to pay or invoice.
 *
 * Three tools, one rule they all obey:
 *
 *   **found / not-found / could-not-check are THREE outcomes, and the third
 *   one says why.**
 *
 * That is not a nicety. VIES is a proxy to twenty-seven member states' own
 * systems and several of them are down at any given moment; GLEIF and EDGAR
 * rate-limit; a corporate proxy answers 403. Every one of those is a
 * *could-not-check*, and a tool that reports them as "not valid" makes a
 * harness get an invoice's VAT treatment wrong because a government server was
 * being rebooted. So there is no `valid: boolean` anywhere in this package —
 * a boolean has two values, this has three, and the collapse always goes the
 * same way.
 *
 * The second rule, for `SanctionsScreen`: it returns signals and evidence,
 * never a verdict. `@crewhaus/tool-money`'s controls already set that
 * precedent for this domain — `refundAbuseSignals` returns ratios and says a
 * person decides, and returns `null` rather than infinity when the denominator
 * is zero. A sanctions match is a legal determination with legal consequences;
 * the tool surfaces candidates, the basis for each, and the list versions it
 * used, and stops there.
 *
 * Nothing here moves money, and nothing here can. No schema accepts a bank
 * credential, a card number or a payment-provider key, and the only bytes that
 * leave the process are a VAT id or a company identifier going to a public
 * register. `index.test.ts` asserts both over every schema in the package.
 */
import { readFileSync, statSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type EntityRecord,
  LEI_PATTERN,
  type RegistryRow,
  leiChecksumValid,
  normalizeEdgar,
  normalizeGleif,
  padCik,
  tickerIndex,
} from "./lib/entity";
import { canonicalizeName, rankNames, round6 } from "./lib/names";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchFailureKind,
  type JsonFetch,
  MAX_TIMEOUT_MS,
  ORIGINS,
  getJson,
  json,
  parseInstant,
  safeLabel,
  startDeadline,
} from "./lib/net";
import {
  type ListSnapshot,
  type ScreenPolicy,
  type Subject,
  checkSnapshot,
  screenSubjects,
} from "./lib/screen";
import {
  type RegisterAnswer,
  checkSyntax,
  hmrcErrorMeaning,
  mapHmrcResponse,
  mapViesResponse,
  parseVatId,
} from "./lib/vat";
import { resolveSafe } from "./paths";

export { _setKycFetch, type KycFetch, ORIGINS } from "./lib/net";

const LIMITS = {
  subjects: 500,
  lists: 16,
  entriesPerList: 100_000,
  snapshotBytes: 64 * 1024 * 1024,
  candidates: 50,
  searchResults: 25,
} as const;

const NETWORK_TOOL = {
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: these cross a network boundary, so they declare it and
  // lower external. The destinations are four constants, but "we only talk to
  // VIES" is not a reason to hide that bytes leave the process.
  scope: "external",
  ioCapability: "network",
} as const;

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`deadline for the whole call in ms; default ${DEFAULT_TIMEOUT_MS}`);

const nowField = z
  .string()
  .max(64)
  .optional()
  .describe("ISO-8601 with an offset; overrides the clock, for replays and tests");

function nowMsFrom(value: string | undefined): number {
  return value === undefined ? Date.now() : parseInstant(value, "now");
}

/**
 * Whether asking again later could plausibly help.
 *
 * `refused` and `unauthorized` are not retryable — something structural is in
 * the way, and a harness that retries them just burns its deadline.
 */
function retryable(kind: FetchFailureKind): boolean {
  return kind === "rateLimited" || kind === "transport" || kind === "status";
}

// ---------------------------------------------------------------------------
// VatIdValidate
// ---------------------------------------------------------------------------

export const vatIdValidate: RegisteredTool = buildTool({
  name: "VatIdValidate",
  operativeArgs: [],
  description:
    "Check an EU, Northern Irish or UK VAT number: its country's own format first, then VIES or HMRC for whether it is actually registered, with the consultation number when a requester id is supplied. Use it before zero-rating an intra-community supply or paying an invoice that claims a VAT number. It reports THREE outcomes — registered, not registered, and could-not-check with the reason — because VIES is a proxy to member states' systems that are routinely down, and reading an outage as 'not valid' gets the invoice wrong. A registered number means the number exists, not that it belongs to whoever sent you the invoice.",
  inputSchema: z
    .object({
      vatId: z
        .string()
        .min(2)
        .max(32)
        .describe("with or without the country prefix; spaces and dots are ignored"),
      country: z
        .string()
        .length(2)
        .optional()
        .describe("two-letter code, when the id is written without a prefix"),
      requesterVatId: z
        .string()
        .min(2)
        .max(32)
        .optional()
        .describe(
          "your own VAT id; the register issues a consultation number — the receipt an auditor asks for — only on this two-party call",
        ),
      syntaxOnly: z
        .boolean()
        .optional()
        .describe(
          "check the format and do not dial anything; registration then reads as unchecked",
        ),
      timeoutMs: timeoutField,
      now: nowField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const parsed = parseVatId(input.vatId, input.country);
    if (!parsed.ok) return `VatIdValidate could not read "${input.vatId}": ${parsed.reason}`;
    const syntax = checkSyntax(parsed);
    const checkedAt = new Date(nowMsFrom(input.now)).toISOString();

    const base = {
      vatId: syntax.canonical,
      country: syntax.country,
      countryName: syntax.countryName,
      syntax,
      checkedAt,
      notes: [
        "registration is not identity: the register confirms the number exists and who holds it, not that the party invoicing you is that holder",
        "outcome is one of found, notFound or unavailable — there is no boolean here, because could-not-check is not a kind of invalid",
      ],
    };

    if (!syntax.wellFormed) {
      // A local answer, and a real one: an id that cannot exist in the
      // country's own grammar is not registered anywhere. The result names the
      // pattern so a caller can see WHY, because this table is ours and a
      // country can change its format.
      return json({
        ...base,
        outcome: "notFound",
        basis: syntax.reason,
        register: "syntax",
        dialled: false,
      });
    }

    if (input.syntaxOnly === true) {
      // The same shape an outage produces, deliberately: "the format is fine
      // and nobody has checked whether it is registered" is the same fact
      // about the world as "the member state did not answer", and a caller
      // should not have to handle it twice.
      return json({
        ...base,
        outcome: "unavailable",
        basis:
          "syntaxOnly was set, so no register was asked — the format is well-formed and nothing has checked whether it is registered",
        register: "none",
        dialled: false,
        retryable: true,
      });
    }

    const requester =
      input.requesterVatId === undefined ? undefined : parseVatId(input.requesterVatId);
    if (requester !== undefined && !requester.ok) {
      return `VatIdValidate could not read requesterVatId "${input.requesterVatId}": ${requester.reason}`;
    }
    if (requester?.ok === true) {
      // The two registers issue their receipt to their OWN kind of requester:
      // HMRC takes a GB VRN, VIES takes a member state's number. Sending the
      // wrong one means the number part is read as if it belonged to the other
      // register — which answers about somebody else's VAT registration, or
      // fails in a way that reads like the SUBJECT's id being wrong. Refused
      // here, before anything is dialled.
      const targetIsGb = syntax.country === "GB";
      const requesterIsGb = requester.country.code === "GB";
      if (targetIsGb !== requesterIsGb) {
        return `VatIdValidate will not use requesterVatId ${requester.canonical} for ${syntax.canonical}: ${
          targetIsGb
            ? "HMRC issues a consultation number only to a GB requester"
            : "VIES issues a consultation number only to a requester registered in a member state, and GB is no longer one"
        }. Drop requesterVatId to get the registration answer without a consultation number.`;
      }
    }

    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const answer =
        syntax.country === "GB"
          ? await askHmrc(
              syntax.number,
              requester?.ok === true ? requester.number : undefined,
              deadline.signal,
            )
          : await askVies(
              syntax.country,
              syntax.number,
              requester?.ok === true ? requester : undefined,
              deadline.signal,
            );
      return json({
        ...base,
        ...answer.answer,
        register: answer.register,
        sourceUrl: answer.sourceUrl,
        dialled: true,
      });
    } finally {
      deadline.cancel();
    }
  },
});

type AskResult = {
  readonly answer: RegisterAnswer;
  readonly register: "vies" | "hmrc";
  readonly sourceUrl: string;
};

/** A transport-level failure is always `unavailable`, never a verdict. */
function unavailableFrom(
  result: Extract<JsonFetch, { ok: false }>,
  register: string,
): RegisterAnswer {
  return {
    outcome: "unavailable",
    basis: `${register} could not be read: ${result.message}`,
    retryable: retryable(result.kind),
    ...(result.status === undefined ? {} : { code: `HTTP ${result.status}` }),
  };
}

async function askVies(
  country: string,
  number: string,
  requester: { readonly country: { readonly code: string }; readonly number: string } | undefined,
  signal: AbortSignal,
): Promise<AskResult> {
  const twoParty = requester !== undefined;
  const url = twoParty
    ? `${ORIGINS.vies}/taxation_customs/vies/rest-api/check-vat-number`
    : `${ORIGINS.vies}/taxation_customs/vies/rest-api/ms/${country}/vat/${number}`;
  const result = await getJson(url, {
    signal,
    ...(twoParty
      ? {
          postJson: {
            countryCode: country,
            vatNumber: number,
            requesterMemberStateCode: requester?.country.code,
            requesterNumber: requester?.number,
          },
        }
      : {}),
  });
  if (!result.ok) {
    return { answer: unavailableFrom(result, "VIES"), register: "vies", sourceUrl: safeLabel(url) };
  }
  return {
    answer: mapViesResponse(result.value, twoParty),
    register: "vies",
    sourceUrl: safeLabel(url),
  };
}

async function askHmrc(
  number: string,
  requesterNumber: string | undefined,
  signal: AbortSignal,
): Promise<AskResult> {
  const path =
    requesterNumber === undefined
      ? `/organisations/vat/check-vat-number/lookup/${number}`
      : `/organisations/vat/check-vat-number/lookup/${number}/${requesterNumber}`;
  const url = `${ORIGINS.hmrc}${path}`;
  // HMRC versions its APIs through the Accept header and answers 406 without
  // one. It is not a credential — every caller sends the same string.
  const result = await getJson(url, { signal, accept: "application/vnd.hmrc.1.0+json" });
  if (!result.ok) {
    if (result.kind === "notFound") {
      return {
        answer: {
          outcome: "notFound",
          basis: hmrcErrorMeaning("NOT_FOUND", result.status),
          code: "NOT_FOUND",
        },
        register: "hmrc",
        sourceUrl: safeLabel(url),
      };
    }
    return { answer: unavailableFrom(result, "HMRC"), register: "hmrc", sourceUrl: safeLabel(url) };
  }
  return {
    answer: mapHmrcResponse(result.value, requesterNumber !== undefined),
    register: "hmrc",
    sourceUrl: safeLabel(url),
  };
}

// ---------------------------------------------------------------------------
// EntityRegistryLookup
// ---------------------------------------------------------------------------

const REGISTRIES = ["gleif", "sec-edgar"] as const;

export const entityRegistryLookup: RegisteredTool = buildTool({
  name: "EntityRegistryLookup",
  operativeArgs: [],
  description:
    "Look one company up in GLEIF and SEC EDGAR by LEI, CIK, ticker or name, and return one row per register with its own source URL and retrieval time. Use it to check a counterparty exists and is who the invoice says. The rows are NOT merged into one confident record: the registers disagree about legal names, and GLEIF's two statuses answer different questions — a LAPSED LEI usually means an unpaid renewal, not a dissolved company. The result shows the differences and lets the caller judge them, and a register that could not be read is reported as could-not-check, never as 'no such company'.",
  inputSchema: z
    .object({
      lei: z.string().min(20).max(20).optional().describe("ISO 17442 legal entity identifier"),
      cik: z.string().min(1).max(12).optional().describe("SEC central index key, padded or not"),
      ticker: z
        .string()
        .min(1)
        .max(16)
        .optional()
        .describe("exchange ticker, resolved via EDGAR's own map"),
      name: z
        .string()
        .min(2)
        .max(256)
        .optional()
        .describe("legal name; discloses the name to the register, unlike an id lookup"),
      registries: z
        .array(z.enum(REGISTRIES))
        .min(1)
        .max(REGISTRIES.length)
        .optional()
        .describe("default: both"),
      limit: z
        .number()
        .int()
        .positive()
        .max(LIMITS.searchResults)
        .optional()
        .describe("results per register for a name search; default 5"),
      timeoutMs: timeoutField,
      now: nowField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    if (
      input.lei === undefined &&
      input.cik === undefined &&
      input.ticker === undefined &&
      input.name === undefined
    ) {
      return "EntityRegistryLookup needs at least one of lei, cik, ticker or name — there is nothing to look up";
    }
    if (input.lei !== undefined && !leiChecksumValid(input.lei.toUpperCase())) {
      // Refused before dialling. GLEIF answers 404 for a mistyped LEI, and a
      // 404 reads like "this company has no LEI record", which is a different
      // and much more interesting claim than "you typed it wrong".
      return `EntityRegistryLookup will not look up "${input.lei}": it is not a valid LEI — ${
        LEI_PATTERN.test(input.lei.toUpperCase())
          ? "the ISO 7064 check digits do not match, so a character is wrong"
          : "an LEI is 18 alphanumerics then 2 check digits"
      }`;
    }

    const wanted = input.registries ?? [...REGISTRIES];
    const limit = input.limit ?? 5;
    const retrievedAt = new Date(nowMsFrom(input.now)).toISOString();
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const rows: RegistryRow[] = [];
      if (wanted.includes("gleif")) {
        rows.push(...(await readGleif(input, limit, retrievedAt, deadline.signal)));
      }
      if (wanted.includes("sec-edgar")) {
        rows.push(...(await readEdgar(input, retrievedAt, deadline.signal)));
      }
      return json({
        query: {
          ...(input.lei === undefined ? {} : { lei: input.lei.toUpperCase() }),
          ...(input.cik === undefined ? {} : { cik: input.cik }),
          ...(input.ticker === undefined ? {} : { ticker: input.ticker.toUpperCase() }),
          ...(input.name === undefined ? {} : { name: input.name }),
        },
        registries: rows,
        comparison: await compareRows(rows),
        note: "one row per register, not merged. Where two registers disagree the disagreement is the finding, and GLEIF's entityStatus and registrationStatus answer different questions — a LAPSED registration is usually an unpaid renewal fee, not a dissolved company.",
      });
    } finally {
      deadline.cancel();
    }
  },
});

type LookupInput = {
  readonly lei?: string;
  readonly cik?: string;
  readonly ticker?: string;
  readonly name?: string;
};

/**
 * A failed read of a URL that IS a record about the subject.
 *
 * Only for those. A 404 on `lei-records/<LEI>` or on `submissions/CIK…json`
 * really is the register saying it holds no such record, but a 404 on an INDEX
 * — EDGAR's ticker map, GLEIF's search endpoint — is the file having moved,
 * and passing it through here turns a broken fetch into a finding about a
 * counterparty nobody looked up. Those two callers use `indexFailedRow`.
 */
function failedRow(
  registry: RegistryRow["registry"],
  result: Extract<JsonFetch, { ok: false }>,
  sourceUrl: string,
  retrievedAt: string,
  notFoundReason: string,
): RegistryRow {
  if (result.kind === "notFound") {
    return { registry, outcome: "notFound", sourceUrl, retrievedAt, reason: notFoundReason };
  }
  return {
    registry,
    outcome: "unavailable",
    sourceUrl,
    retrievedAt,
    reason: result.message,
    retryable: retryable(result.kind),
  };
}

/**
 * A failed read of an INDEX the lookup goes THROUGH, never of a record.
 *
 * Every kind maps to `unavailable`, including `notFound`, because none of them
 * is evidence about the subject: the question was never put. The genuine
 * negative — the map does not carry this ticker, the search matched no name —
 * arrives as a 200 with nothing in it, and is reported by the caller.
 */
function indexFailedRow(
  registry: RegistryRow["registry"],
  result: Extract<JsonFetch, { ok: false }>,
  sourceUrl: string,
  retrievedAt: string,
  what: string,
): RegistryRow {
  return {
    registry,
    outcome: "unavailable",
    sourceUrl,
    retrievedAt,
    reason: `${what} could not be read, so nothing was looked up: ${result.message}`,
    retryable: retryable(result.kind),
  };
}

async function readGleif(
  input: LookupInput,
  limit: number,
  retrievedAt: string,
  signal: AbortSignal,
): Promise<RegistryRow[]> {
  if (input.lei !== undefined) {
    const url = `${ORIGINS.gleif}/api/v1/lei-records/${input.lei.toUpperCase()}`;
    const result = await getJson(url, { signal });
    if (!result.ok) {
      return [failedRow("gleif", result, url, retrievedAt, "GLEIF holds no record for this LEI")];
    }
    const data = (result.value as Record<string, unknown>)["data"] as
      | Record<string, unknown>
      | undefined;
    const record = normalizeGleif(data?.["attributes"]);
    return [
      record === null
        ? {
            registry: "gleif",
            outcome: "unavailable",
            sourceUrl: url,
            retrievedAt,
            reason: "GLEIF answered 200 with a body this tool could not read as an LEI record",
            retryable: false,
          }
        : { registry: "gleif", outcome: "found", sourceUrl: url, retrievedAt, record },
    ];
  }
  if (input.name === undefined) {
    return [
      {
        registry: "gleif",
        outcome: "unavailable",
        sourceUrl: `${ORIGINS.gleif}/api/v1/lei-records`,
        retrievedAt,
        reason:
          "GLEIF is searchable by LEI or by legal name, and neither was supplied — a CIK or a ticker means nothing to it",
        retryable: false,
      },
    ];
  }
  const url = new URL(`${ORIGINS.gleif}/api/v1/lei-records`);
  url.searchParams.set("filter[entity.legalName]", input.name);
  url.searchParams.set("page[size]", String(limit));
  // The query IS the evidence for a search row, so the source URL keeps it
  // rather than going through `safeLabel`. That rule exists to keep a searched
  // name out of a message it does not belong in; here the name is already in
  // this same document, under `query`, so stripping it would cost
  // reproducibility and buy nothing.
  const searchUrl = url.toString();
  const result = await getJson(searchUrl, { signal });
  if (!result.ok) {
    return [indexFailedRow("gleif", result, searchUrl, retrievedAt, "GLEIF's legal-name search")];
  }
  const data = (result.value as Record<string, unknown>)["data"];
  const list = Array.isArray(data) ? data : [];
  if (list.length === 0) {
    return [
      {
        registry: "gleif",
        outcome: "notFound",
        sourceUrl: searchUrl,
        retrievedAt,
        reason: `GLEIF has no LEI record whose legal name matches "${input.name}" — which is common and ordinary: an LEI is only required of parties to certain financial transactions`,
      },
    ];
  }
  const records = list
    .map((item) => normalizeGleif((item as Record<string, unknown>)["attributes"]))
    .filter((record): record is EntityRecord => record !== null);
  if (records.length === 0) {
    // GLEIF answered with hits and none of them parsed. Returning the empty
    // array made the register VANISH from `registries` — not found, not
    // notFound, not unavailable, no row at all — and the comparison then said
    // "no register returned a record", which reads like GLEIF had nothing to
    // say about the company rather than like this tool could not read it.
    return [
      {
        registry: "gleif",
        outcome: "unavailable",
        sourceUrl: searchUrl,
        retrievedAt,
        reason: `GLEIF returned ${list.length} hit${list.length === 1 ? "" : "s"} in a shape this tool could not read as LEI records`,
        retryable: false,
      },
    ];
  }
  return records.map((record) => ({
    registry: "gleif" as const,
    outcome: "found" as const,
    sourceUrl: searchUrl,
    retrievedAt,
    record,
  }));
}

async function readEdgar(
  input: LookupInput,
  retrievedAt: string,
  signal: AbortSignal,
): Promise<RegistryRow[]> {
  let cik = input.cik === undefined ? null : padCik(input.cik);
  let resolvedVia: string | undefined;

  if (input.cik !== undefined && cik === null) {
    return [
      {
        registry: "sec-edgar",
        outcome: "unavailable",
        sourceUrl: ORIGINS.edgarData,
        retrievedAt,
        reason: `"${input.cik}" is not a CIK: it is up to ten digits, optionally prefixed CIK and zero-padded`,
        retryable: false,
      },
    ];
  }

  if (cik === null && (input.ticker !== undefined || input.name !== undefined)) {
    const mapUrl = `${ORIGINS.edgarFiles}/files/company_tickers.json`;
    const map = await getJson(mapUrl, { signal });
    if (!map.ok) {
      return [indexFailedRow("sec-edgar", map, mapUrl, retrievedAt, "EDGAR's ticker→CIK map")];
    }
    const index = tickerIndex(map.value);
    if (input.ticker !== undefined) {
      const hit = index.get(input.ticker.toUpperCase());
      if (hit === undefined) {
        return [
          {
            registry: "sec-edgar",
            outcome: "notFound",
            sourceUrl: mapUrl,
            retrievedAt,
            reason: `EDGAR's ticker map has no "${input.ticker.toUpperCase()}" — the map covers companies that file with the SEC, so a foreign or private issuer is absent from it`,
          },
        ];
      }
      cik = hit.cik;
      resolvedVia = `ticker ${input.ticker.toUpperCase()} → CIK ${hit.cik} via EDGAR's own company_tickers.json`;
    } else if (input.name !== undefined) {
      // EDGAR has no name-search API that answers JSON, so the ticker map's
      // titles are the honest substitute — and the shortlist is ranked by
      // tool-text, not by a substring test that would match "Apple" to
      // "Pineapple Holdings". It only covers listed filers, and the row says so.
      const titles = [...index.entries()];
      const [best] = await rankNames(
        input.name,
        titles.map(([, value]) => value.title),
        0.8,
        1,
      );
      if (best === undefined) {
        return [
          {
            registry: "sec-edgar",
            outcome: "notFound",
            sourceUrl: mapUrl,
            retrievedAt,
            reason: `no company in EDGAR's ticker map has a name close to "${input.name}" — that map lists listed filers only, so this is not evidence the company does not exist`,
          },
        ];
      }
      const entry = titles[best.index];
      cik = entry?.[1].cik ?? null;
      resolvedVia = `name "${input.name}" → "${entry?.[1].title ?? ""}" (score ${round6(best.score)}) via EDGAR's company_tickers.json, which lists listed filers only`;
    }
  }

  if (cik === null) {
    return [
      {
        registry: "sec-edgar",
        outcome: "unavailable",
        sourceUrl: ORIGINS.edgarData,
        retrievedAt,
        reason: "EDGAR is searchable by CIK, ticker or name, and none of those was supplied",
        retryable: false,
      },
    ];
  }

  const url = `${ORIGINS.edgarData}/submissions/CIK${cik}.json`;
  const result = await getJson(url, { signal });
  if (!result.ok) {
    return [failedRow("sec-edgar", result, url, retrievedAt, `EDGAR has no filer with CIK ${cik}`)];
  }
  const record = normalizeEdgar(result.value);
  if (record === null) {
    return [
      {
        registry: "sec-edgar",
        outcome: "unavailable",
        sourceUrl: url,
        retrievedAt,
        reason: "EDGAR answered 200 with a body this tool could not read as a submissions document",
        retryable: false,
      },
    ];
  }
  return [
    {
      registry: "sec-edgar",
      outcome: "found",
      sourceUrl: url,
      retrievedAt,
      record,
      ...(resolvedVia === undefined ? {} : { reason: resolvedVia }),
    },
  ];
}

/**
 * What the registers disagree about.
 *
 * Deliberately a comparison and not a merge. The name score is computed the
 * same way `SanctionsScreen` computes one — through `tool-text` — and it is
 * reported with its basis, not turned into "same company: yes".
 */
async function compareRows(rows: ReadonlyArray<RegistryRow>): Promise<unknown> {
  const found = rows.filter((row) => row.outcome === "found" && row.record !== undefined);
  if (found.length === 0) return { legalNames: [], note: "no register returned a record" };

  const legalNames = found.map((row) => ({
    registry: row.registry,
    legalName: row.record?.legalName ?? "",
    otherNames: row.record?.otherNames ?? [],
    status: row.record?.status ?? {},
  }));

  // One row per REGISTER, and the FIRST row each register returned: a name
  // search can return five GLEIF hits, and comparing two of those against each
  // other would report a cross-register agreement that was never computed.
  // Building this with a Map keeps the LAST hit, which is the least relevant
  // one — the registers return their best match first.
  const perRegistry: RegistryRow[] = [];
  for (const row of found) {
    if (perRegistry.some((kept) => kept.registry === row.registry)) continue;
    perRegistry.push(row);
  }
  if (perRegistry.length === 1) {
    return {
      legalNames,
      note: "only one register answered, so there is nothing to compare it against",
    };
  }

  const first = perRegistry[0]?.record?.legalName ?? "";
  const second = perRegistry[1]?.record?.legalName ?? "";
  const a = await canonicalizeName(first, { dropLegalSuffixes: true });
  const b = await canonicalizeName(second, { dropLegalSuffixes: true });
  const [hit] = await rankNames(a.canonical, [b.canonical], 0, 1);
  // A former name that matches THE OTHER register turns "these look like two
  // companies" into "this one was renamed", which is the whole reason former
  // names are carried through the normalizers.
  //
  // Which register it came from is load-bearing. Comparing every former name
  // against BOTH current names let a register explain the disagreement by
  // agreeing with itself: GLEIF carries "Siemens AG" as an other-name of
  // "SIEMENS AKTIENGESELLSCHAFT", that pair scores 1.0, and the result then
  // told the caller the gap to EDGAR's "SIEMENS ENERGY AG" was a rename — of
  // a different company. Same shape as comparing two GLEIF hits and calling it
  // cross-register, one level down.
  const formerNames = [
    // `compare` is the OTHER register's current name in each case.
    ...(perRegistry[0]?.record?.otherNames ?? []).map((name) => ({ name, compare: b.canonical })),
    ...(perRegistry[1]?.record?.otherNames ?? []).map((name) => ({ name, compare: a.canonical })),
  ];
  const formerHits = await Promise.all(
    formerNames.map(async ({ name, compare }) => {
      const canonical = await canonicalizeName(name, { dropLegalSuffixes: true });
      const [best] = await rankNames(canonical.canonical, [compare], 0.9, 1);
      return best === undefined ? null : name;
    }),
  );
  const explained = formerHits.filter((name): name is string => name !== null);

  return {
    legalNames,
    nameAgreement: {
      score: round6(hit?.score ?? 0),
      basis: `${perRegistry[0]?.registry} "${first}" vs ${perRegistry[1]?.registry} "${second}", compared after dropping legal forms (${[...a.droppedSuffixes, ...b.droppedSuffixes].join(", ") || "none"}) — @crewhaus/tool-text Jaro-Winkler`,
      ...(explained.length === 0
        ? {}
        : {
            explainedByFormerName: explained,
            note: "a former name on one register matches the other register's current name, so a low score here is a rename rather than two companies",
          }),
    },
    note: "the registers are not merged: nothing here decides which spelling or which status is correct",
  };
}

// ---------------------------------------------------------------------------
// SanctionsScreen
// ---------------------------------------------------------------------------

const aliasSchema = z
  .object({
    name: z.string().min(1).max(512),
    quality: z
      .enum(["strong", "weak"])
      .optional()
      .describe("the publisher's own mark; weak aliases are scored and reported separately"),
  })
  .strict();

const entrySchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    kind: z.enum(["person", "entity", "vessel", "aircraft", "unknown"]).optional(),
    aliases: z.array(aliasSchema).max(512).optional(),
    countries: z.array(z.string().max(128)).max(64).optional(),
    datesOfBirth: z.array(z.string().max(64)).max(64).optional(),
    programs: z.array(z.string().max(128)).max(64).optional(),
    remarks: z.string().max(8192).optional(),
  })
  .strict();

/**
 * A list snapshot, with its provenance REQUIRED.
 *
 * `version`, `publishedAt` and `retrievedAt` are not optional and never will
 * be. A screening result whose list cannot say what it was is not a cheaper
 * result, it is one nobody can defend a year later — and "no candidates
 * found" is precisely the answer that gets relied on.
 */
const snapshotSchema = z
  .object({
    source: z.string().min(1).max(200).describe("publisher and list, e.g. 'OFAC SDN'"),
    version: z.string().min(1).max(200).describe("the publisher's own version or issue id"),
    publishedAt: z.string().min(1).max(64).describe("ISO-8601 with an offset"),
    retrievedAt: z.string().min(1).max(64).describe("ISO-8601 with an offset"),
    sourceUrl: z.string().max(2048).optional(),
    entries: z.array(entrySchema).min(1).max(LIMITS.entriesPerList),
  })
  .strict();

export const sanctionsScreen: RegisteredTool = buildTool({
  name: "SanctionsScreen",
  description:
    "Screen names against sanctions-list snapshots the operator holds, and return candidates with the basis for each and the version of every list read. Use it before onboarding or paying a counterparty. It returns SIGNALS AND EVIDENCE, NEVER A VERDICT: a sanctions match is a legal determination a person makes, and the score is the least reliable part of the answer — the lists carry transliterations and aliases their own publishers mark as weak. Scoring is local, so no counterparty name leaves the machine, and a list that cannot say which version it is gets refused rather than screened against.",
  inputSchema: z
    .object({
      subjects: z
        .array(
          z
            .object({
              id: z.string().min(1).max(128),
              name: z.string().min(1).max(512),
              aliases: z.array(z.string().min(1).max(512)).max(64).optional(),
              kind: z.enum(["person", "entity"]).optional(),
              country: z.string().max(128).optional().describe("corroboration only; never scored"),
              dateOfBirth: z
                .string()
                .max(64)
                .optional()
                .describe("corroboration only; never scored"),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.subjects),
      lists: z.array(snapshotSchema).max(LIMITS.lists).optional().describe("snapshots inline"),
      listFiles: z
        .array(z.string().min(1).max(1024))
        .max(LIMITS.lists)
        .optional()
        .describe("workspace-relative paths to snapshots in the same JSON shape"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("report candidates at or above this score; default 0.65"),
      limit: z
        .number()
        .int()
        .positive()
        .max(LIMITS.candidates)
        .optional()
        .describe("candidates per subject; default 10"),
      includeWeakAliases: z
        .boolean()
        .optional()
        .describe("score the publisher's weak aliases too, reported apart; default true"),
      maxAgeDays: z
        .number()
        .int()
        .min(0)
        .max(3650)
        .optional()
        .describe("refuse a list published longer ago than this; default 30, 0 disables the check"),
      now: nowField,
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  // No network and no ioCapability: this reads a local snapshot and compares
  // strings. Screening a counterparty through a remote API would disclose who
  // you are about to pay to somebody who did not need to know, so there is no
  // endpoint here to disclose it to.
  execute: async (input) => {
    const nowMs = nowMsFrom(input.now);
    const snapshots: ListSnapshot[] = [...((input.lists ?? []) as ListSnapshot[])];

    for (const file of input.listFiles ?? []) {
      const at = resolveSafe("SanctionsScreen", file);
      let size: number;
      try {
        size = statSync(at.real).size;
      } catch {
        // A refusal in the package's own words, with the path as the caller
        // wrote it. The raw ENOENT carries an absolute path from this machine,
        // which is both unreadable and more than the caller asked for.
        return `SanctionsScreen refused ${at.rel}: there is no such file in the workspace`;
      }
      if (size > LIMITS.snapshotBytes) {
        return `SanctionsScreen refused ${at.rel}: it is ${size} bytes, over the ${LIMITS.snapshotBytes}-byte limit`;
      }
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(at.real, "utf-8"));
      } catch (err) {
        return `SanctionsScreen refused ${at.rel}: it is not JSON (${(err as Error).message})`;
      }
      const parsed = snapshotSchema.safeParse(document);
      if (!parsed.success) {
        // The same schema the inline lists go through. A file missing its
        // version fails here, by name, rather than being screened against.
        return `SanctionsScreen refused ${at.rel}: ${parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
          .join("; ")}`;
      }
      snapshots.push(parsed.data as ListSnapshot);
    }

    if (snapshots.length === 0) {
      return "SanctionsScreen needs at least one list: pass lists inline or listFiles. Screening against nothing would report no candidates for every subject, which reads exactly like a clean screen.";
    }
    if (snapshots.length > LIMITS.lists) {
      return `SanctionsScreen takes at most ${LIMITS.lists} lists in one call; ${snapshots.length} were supplied`;
    }

    const maxAgeDays = input.maxAgeDays ?? 30;
    const ages: number[] = [];
    for (const snapshot of snapshots) {
      const checked = checkSnapshot(snapshot, nowMs, maxAgeDays);
      if ("reason" in checked) {
        // One unusable list refuses the WHOLE screen. Screening against the
        // other three and reporting "no candidates" would be an answer with a
        // hole in it that nothing in the output would show.
        return `SanctionsScreen refused the whole screen because of ${checked.list}: ${checked.reason}`;
      }
      ages.push(checked.ageDays);
    }

    const policy: ScreenPolicy = {
      threshold: input.threshold ?? 0.65,
      limit: input.limit ?? 10,
      includeWeakAliases: input.includeWeakAliases ?? true,
    };
    return json(
      await screenSubjects(
        input.subjects as ReadonlyArray<Subject>,
        snapshots,
        ages,
        policy,
        nowMs,
      ),
    );
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const KYC_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  entityRegistryLookup,
  sanctionsScreen,
  vatIdValidate,
]);

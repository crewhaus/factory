/**
 * Company registers: GLEIF and SEC EDGAR, normalized per register and NEVER
 * merged.
 *
 * The temptation is one confident record with one legal name and one status.
 * Two registers describing the same company disagree about all of it — the
 * legal name's suffix and accents, the registration number's format, and above
 * all what "status" means. GLEIF publishes two of them that answer different
 * questions:
 *
 *   - `entity.status` — is the company itself still there (ACTIVE / INACTIVE)
 *   - `registration.status` — is its LEI paid up (ISSUED / LAPSED / RETIRED /
 *     ANNULLED / MERGED / DUPLICATE)
 *
 * A LAPSED registration is overwhelmingly an unpaid renewal fee on a trading
 * company. Folding it into a `dissolved: true` would have a harness refuse to
 * pay a live supplier over a €90 invoice the supplier forgot. So both travel,
 * under their own names, with the register that said them.
 *
 * What this file does instead of merging is make the DIFFERENCES visible: one
 * row per register, each with its own source URL and retrieval time, and a
 * comparison the caller reads.
 */

/** The three outcomes, per register. */
export type RegistryOutcome = "found" | "notFound" | "unavailable";

export type RegistryRow = {
  readonly registry: "gleif" | "sec-edgar";
  readonly outcome: RegistryOutcome;
  /** The exact document this row was read from. */
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly record?: EntityRecord;
  /** Present on `notFound` and `unavailable`: which, and why. */
  readonly reason?: string;
  readonly retryable?: boolean;
};

export type EntityRecord = {
  readonly legalName: string;
  /** Former names, trade names, transliterations — whatever the register carries. */
  readonly otherNames: ReadonlyArray<string>;
  readonly identifiers: Readonly<Record<string, string | ReadonlyArray<string>>>;
  /**
   * Status fields under the register's OWN names. There is no shared
   * `active: boolean` here on purpose: see the header.
   */
  readonly status: Readonly<Record<string, string>>;
  readonly jurisdiction?: string;
  readonly legalForm?: string;
  readonly address?: string;
  readonly dates: Readonly<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// LEI
// ---------------------------------------------------------------------------

/** 18 alphanumerics and 2 check digits (ISO 17442). */
export const LEI_PATTERN = /^[A-Z0-9]{18}\d{2}$/;

/**
 * ISO 7064 MOD 97-10, the same check IBANs use: letters become two-digit
 * numbers and the whole string modulo 97 must be 1.
 *
 * Worth doing locally because it is exact. A typed LEI with two transposed
 * characters fails here in microseconds instead of coming back from GLEIF as a
 * 404 that reads like "this company has no LEI" — which is a different and
 * much more interesting fact.
 */
export function leiChecksumValid(lei: string): boolean {
  const value = lei.toUpperCase();
  if (!LEI_PATTERN.test(value)) return false;
  let remainder = 0;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const piece = code >= 65 ? String(code - 55) : ch;
    for (const digit of piece) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function joinAddress(node: unknown): string | undefined {
  const a = node as Record<string, unknown> | undefined;
  if (a === undefined || a === null) return undefined;
  const lines = Array.isArray(a["addressLines"])
    ? (a["addressLines"] as unknown[]).map(str).filter((l): l is string => l !== undefined)
    : [str(a["street1"]), str(a["street2"])].filter((l): l is string => l !== undefined);
  const parts = [
    ...lines,
    str(a["city"]),
    str(a["region"]) ?? str(a["stateOrCountry"]),
    str(a["postalCode"]) ?? str(a["zipCode"]),
    str(a["country"]),
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Read one GLEIF `lei-records` record.
 *
 * GLEIF speaks JSON:API, so the useful part is two levels down under
 * `data.attributes`, and a search answers with an ARRAY at `data` while a
 * direct read answers with an object. Both shapes come through here.
 */
export function normalizeGleif(attributes: unknown): EntityRecord | null {
  const attrs = attributes as Record<string, unknown> | undefined;
  if (attrs === undefined || attrs === null) return null;
  const entity = (attrs["entity"] ?? {}) as Record<string, unknown>;
  const registration = (attrs["registration"] ?? {}) as Record<string, unknown>;
  const legalName = str((entity["legalName"] as Record<string, unknown> | undefined)?.["name"]);
  const lei = str(attrs["lei"]);
  if (legalName === undefined && lei === undefined) return null;

  const otherNames = [
    ...(Array.isArray(entity["otherNames"]) ? (entity["otherNames"] as unknown[]) : []),
    ...(Array.isArray(entity["transliteratedOtherNames"])
      ? (entity["transliteratedOtherNames"] as unknown[])
      : []),
  ]
    .map((n) => str((n as Record<string, unknown>)?.["name"]))
    .filter((n): n is string => n !== undefined);

  const jurisdiction = str(entity["jurisdiction"]);
  const legalForm = str((entity["legalForm"] as Record<string, unknown> | undefined)?.["id"]);
  const address = joinAddress(entity["legalAddress"]);
  const registeredAs = str(entity["registeredAs"]);
  return {
    legalName: legalName ?? "",
    otherNames,
    identifiers: {
      ...(lei === undefined ? {} : { lei }),
      // The company-register number in its OWN jurisdiction's format, which is
      // the id a Companies House or a Handelsregister would be searched by.
      // Formats differ per country; it is echoed, never reformatted.
      ...(registeredAs === undefined ? {} : { registeredAs }),
    },
    status: {
      // Both, always. Collapsing these two is the mistake this package is
      // built to avoid.
      ...(str(entity["status"]) === undefined ? {} : { entityStatus: String(entity["status"]) }),
      ...(str(registration["status"]) === undefined
        ? {}
        : { registrationStatus: String(registration["status"]) }),
      ...(str(entity["subCategory"]) === undefined
        ? {}
        : { subCategory: String(entity["subCategory"]) }),
    },
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
    ...(legalForm === undefined ? {} : { legalForm }),
    ...(address === undefined ? {} : { address }),
    dates: {
      ...(str(registration["initialRegistrationDate"]) === undefined
        ? {}
        : { leiFirstIssued: String(registration["initialRegistrationDate"]) }),
      ...(str(registration["lastUpdateDate"]) === undefined
        ? {}
        : { leiLastUpdated: String(registration["lastUpdateDate"]) }),
      ...(str(registration["nextRenewalDate"]) === undefined
        ? {}
        : { leiNextRenewal: String(registration["nextRenewalDate"]) }),
    },
  };
}

// ---------------------------------------------------------------------------
// EDGAR
// ---------------------------------------------------------------------------

/**
 * EDGAR's CIK, zero-padded to ten digits.
 *
 * The submissions path is `CIK##########.json` with the padding and the ticker
 * map publishes the number unpadded, so exactly one of the two has to be
 * converted and it is always this one. `CIK320193.json` is a 404, which would
 * otherwise read as "Apple does not file with the SEC".
 */
export function padCik(value: string | number): string | null {
  const digits = String(value).trim().replace(/^CIK/i, "").replace(/^0+/, "");
  if (!/^\d{1,10}$/.test(digits)) return null;
  return digits.padStart(10, "0");
}

/** Map tickers to padded CIKs from EDGAR's `company_tickers.json`. */
export function tickerIndex(document: unknown): Map<string, { cik: string; title: string }> {
  const out = new Map<string, { cik: string; title: string }>();
  const rows = (document ?? {}) as Record<string, unknown>;
  for (const row of Object.values(rows)) {
    const entry = row as Record<string, unknown> | undefined;
    const ticker = str(entry?.["ticker"]);
    const cik = entry?.["cik_str"];
    if (ticker === undefined || cik === undefined) continue;
    const padded = padCik(cik as string | number);
    if (padded === null) continue;
    // First spelling wins: the file lists one row per ticker per exchange, and
    // a later duplicate is the same company on another venue.
    if (!out.has(ticker.toUpperCase())) {
      out.set(ticker.toUpperCase(), { cik: padded, title: str(entry?.["title"]) ?? "" });
    }
  }
  return out;
}

/**
 * Read an EDGAR submissions document.
 *
 * `formerNames` is kept rather than dropped: when EDGAR and GLEIF disagree
 * about a company's name, a former name that matches the other register turns
 * "these look like two companies" into "this one was renamed", and that is the
 * difference between a payment held and a payment made.
 */
export function normalizeEdgar(document: unknown): EntityRecord | null {
  const doc = (document ?? {}) as Record<string, unknown>;
  const name = str(doc["name"]);
  const cik = str(doc["cik"]);
  if (name === undefined && cik === undefined) return null;

  const formerNames = (Array.isArray(doc["formerNames"]) ? (doc["formerNames"] as unknown[]) : [])
    .map((n) => str((n as Record<string, unknown>)?.["name"]))
    .filter((n): n is string => n !== undefined);

  const tickers = (Array.isArray(doc["tickers"]) ? (doc["tickers"] as unknown[]) : [])
    .map(str)
    .filter((t): t is string => t !== undefined);

  const addresses = (doc["addresses"] ?? {}) as Record<string, unknown>;
  const address = joinAddress(addresses["business"]) ?? joinAddress(addresses["mailing"]);

  const filings = ((doc["filings"] ?? {}) as Record<string, unknown>)["recent"] as
    | Record<string, unknown>
    | undefined;
  const forms = Array.isArray(filings?.["form"]) ? (filings?.["form"] as unknown[]) : [];
  const dates = Array.isArray(filings?.["filingDate"])
    ? (filings?.["filingDate"] as unknown[])
    : [];
  const latestForm = str(forms[0]);
  const latestDate = str(dates[0]);

  const padded = cik === undefined ? null : padCik(cik);
  const jurisdiction = str(doc["stateOfIncorporation"]);
  const legalForm = str(doc["entityType"]);
  return {
    legalName: name ?? "",
    otherNames: formerNames,
    identifiers: {
      ...(padded === null ? {} : { cik: padded }),
      ...(str(doc["ein"]) === undefined ? {} : { ein: String(doc["ein"]) }),
      ...(tickers.length === 0 ? {} : { tickers }),
    },
    status: {
      // EDGAR publishes no "active" flag at all. The nearest honest thing is
      // the most recent filing, which is a SIGNAL about whether anybody is
      // still filing — not a registration status, and labelled so.
      ...(latestForm === undefined || latestDate === undefined
        ? { filingActivity: "no filings in the document" }
        : { latestFiling: `${latestForm} on ${latestDate}` }),
      ...(str(doc["sicDescription"]) === undefined
        ? {}
        : { sic: `${str(doc["sic"]) ?? ""} ${String(doc["sicDescription"])}`.trim() }),
    },
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
    ...(legalForm === undefined ? {} : { legalForm }),
    ...(address === undefined ? {} : { address }),
    dates: {},
  };
}

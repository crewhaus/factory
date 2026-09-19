/**
 * VAT identification numbers: the local grammar, and how each register's
 * answer maps onto the three outcomes.
 *
 * The rule that shapes this whole file: **`unavailable` never collapses into
 * `notFound`.** VIES is a proxy — it forwards the question to the member
 * state's own system, and those systems go down, individually, routinely, for
 * hours. A tool that reports an outage as "this VAT number is not valid" makes
 * a harness charge domestic VAT on an intra-community supply, or refuse to,
 * because a government server was being rebooted. So every code VIES publishes
 * is mapped explicitly here, and anything unrecognised fails to `unavailable`
 * rather than to a verdict.
 *
 * The second rule: a syntax pass is not a registration, and a registration is
 * not an identity. Both facts travel with the answer instead of being folded
 * into one boolean.
 */

/** The three outcomes. There is deliberately no boolean anywhere in this file. */
export type VatOutcome = "found" | "notFound" | "unavailable";

export type VatCountry = {
  /** The code as the VAT id is written — `EL` for Greece, not `GR`. */
  readonly code: string;
  readonly name: string;
  /** The number part, after the country prefix. */
  readonly pattern: RegExp;
  /** The shape in words, for a result that has to explain a refusal. */
  readonly shape: string;
  readonly register: "vies" | "hmrc";
  readonly note?: string;
};

const c = (
  code: string,
  name: string,
  pattern: RegExp,
  shape: string,
  register: "vies" | "hmrc" = "vies",
  note?: string,
): VatCountry => ({
  code,
  name,
  pattern,
  shape,
  register,
  ...(note === undefined ? {} : { note }),
});

/**
 * Per-country syntax, as a table.
 *
 * A generic "two letters then 8-12 alphanumerics" check passes ids that VIES
 * then rejects, which is the worst of both: a local check that gives false
 * confidence and a remote call that was avoidable. The awkward ones are the
 * point of having a table at all — Ireland's letter in the MIDDLE, the
 * Netherlands' mandatory B in position ten, Spain's letter-or-digit at each
 * end, Greece filing under EL.
 */
export const VAT_COUNTRIES: Readonly<Record<string, VatCountry>> = Object.freeze({
  AT: c("AT", "Austria", /^U\d{8}$/, "U followed by 8 digits"),
  BE: c("BE", "Belgium", /^[01]\d{9}$/, "10 digits beginning 0 or 1"),
  BG: c("BG", "Bulgaria", /^\d{9,10}$/, "9 or 10 digits"),
  CY: c("CY", "Cyprus", /^\d{8}[A-Z]$/, "8 digits then a letter"),
  CZ: c("CZ", "Czechia", /^\d{8,10}$/, "8, 9 or 10 digits"),
  DE: c("DE", "Germany", /^\d{9}$/, "9 digits"),
  DK: c("DK", "Denmark", /^\d{8}$/, "8 digits"),
  EE: c("EE", "Estonia", /^\d{9}$/, "9 digits"),
  EL: c(
    "EL",
    "Greece",
    /^\d{9}$/,
    "9 digits",
    "vies",
    "Greece files under EL, not its ISO code GR; an id written GR… is accepted here and sent as EL",
  ),
  ES: c(
    "ES",
    "Spain",
    /^[A-Z0-9]\d{7}[A-Z0-9]$/,
    "a letter or digit, 7 digits, then a letter or digit",
  ),
  FI: c("FI", "Finland", /^\d{8}$/, "8 digits"),
  FR: c(
    "FR",
    "France",
    /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
    "2 check characters (letters excluding I and O, or digits) then 9 digits",
  ),
  HR: c("HR", "Croatia", /^\d{11}$/, "11 digits"),
  HU: c("HU", "Hungary", /^\d{8}$/, "8 digits"),
  IE: c(
    "IE",
    "Ireland",
    /^(?:\d{7}[A-W]|\d[A-Z+*]\d{5}[A-W]|\d{7}[A-W][AH])$/,
    "7 digits and a letter, or a digit, a letter/+/*, 5 digits and a letter, or 7 digits, a letter and A or H",
    "vies",
    "the middle-character form (1X34567A) is the one a length-only check accepts and a digits-only check rejects; the 9-character form's last character is only ever A or H",
  ),
  IT: c("IT", "Italy", /^\d{11}$/, "11 digits"),
  LT: c("LT", "Lithuania", /^(?:\d{9}|\d{12})$/, "9 or 12 digits"),
  LU: c("LU", "Luxembourg", /^\d{8}$/, "8 digits"),
  LV: c("LV", "Latvia", /^\d{11}$/, "11 digits"),
  MT: c("MT", "Malta", /^\d{8}$/, "8 digits"),
  NL: c(
    "NL",
    "the Netherlands",
    /^[A-Z0-9+*]{9}B[A-Z0-9+*]{2}$/,
    "12 characters with B in position 10",
    "vies",
    "the B is positional, not a suffix: a sole trader's number since 2020 is not derived from anything and only the B is fixed",
  ),
  PL: c("PL", "Poland", /^\d{10}$/, "10 digits"),
  PT: c("PT", "Portugal", /^\d{9}$/, "9 digits"),
  RO: c("RO", "Romania", /^\d{2,10}$/, "2 to 10 digits"),
  SE: c("SE", "Sweden", /^\d{12}$/, "12 digits"),
  SI: c("SI", "Slovenia", /^\d{8}$/, "8 digits"),
  SK: c("SK", "Slovakia", /^\d{10}$/, "10 digits"),
  XI: c(
    "XI",
    "Northern Ireland",
    /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
    "9 or 12 digits, or GD/HA and 3 digits",
    "vies",
    "Northern Ireland stayed in VIES for goods after 2020; Great Britain did not",
  ),
  GB: c(
    "GB",
    "the United Kingdom",
    /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
    "9 or 12 digits, or GD/HA and 3 digits",
    "hmrc",
    "VIES has not answered for GB since 2021; this goes to HMRC's own checker",
  ),
});

/** Greece's ISO code is GR and its VAT prefix is EL. Both are accepted. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({ GR: "EL", UK: "GB" });

export type ParsedVatId =
  | {
      readonly ok: true;
      readonly country: VatCountry;
      /** The number part, uppercased, with separators removed. */
      readonly number: string;
      /** Country code + number, which is what goes on an invoice. */
      readonly canonical: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Split an id into country and number.
 *
 * Spaces, dots and hyphens are removed because every register prints them
 * differently and none of them stores them. The country either prefixes the
 * id or is passed separately; when both are given and disagree, that is an
 * error rather than a silent preference, because guessing which one the caller
 * meant is how an Irish number gets checked against Italy's grammar.
 */
export function parseVatId(raw: string, declaredCountry?: string): ParsedVatId {
  const cleaned = raw.toUpperCase().replace(/[\s.\-/]/g, "");
  if (cleaned.length === 0) return { ok: false, reason: "the VAT id is empty" };

  const declared =
    declaredCountry === undefined
      ? undefined
      : (ALIASES[declaredCountry.toUpperCase()] ?? declaredCountry.toUpperCase());
  const prefix = cleaned.slice(0, 2);
  const prefixed = ALIASES[prefix] ?? prefix;
  const hasKnownPrefix = Object.hasOwn(VAT_COUNTRIES, prefixed);

  let code: string;
  let number: string;
  if (hasKnownPrefix) {
    code = prefixed;
    number = cleaned.slice(2);
    if (declared !== undefined && declared !== code) {
      return {
        ok: false,
        reason: `the id is prefixed ${prefix} but country was given as ${declaredCountry} — one of them is wrong, and this tool will not pick`,
      };
    }
  } else if (declared !== undefined) {
    code = declared;
    number = cleaned;
  } else {
    return {
      ok: false,
      reason: `"${cleaned.slice(0, 4)}…" carries no recognised country prefix — pass country explicitly when the id is written without one`,
    };
  }

  const country = VAT_COUNTRIES[code];
  if (country === undefined) {
    return {
      ok: false,
      reason: `"${code}" is not an EU member state, Northern Ireland or the United Kingdom — this tool reads VIES and HMRC, and nothing else`,
    };
  }
  if (number.length === 0) {
    return {
      ok: false,
      reason: `the id is only the country code ${code}, with no number after it`,
    };
  }
  return { ok: true, country, number, canonical: `${code}${number}` };
}

export type ChecksumResult = {
  readonly algorithm: string;
  /** `null` when this package does not have that country's algorithm. */
  readonly passed: boolean | null;
  readonly note?: string;
};

/**
 * The UK's check digits, which are real arithmetic rather than a shape.
 *
 * Two variants are in circulation: the original "mod 97" and the "mod 9755"
 * used for numbers issued from 2004, which differs only by adding 55 before
 * the modulus. Both are accepted, because a number issued under one is not
 * invalid for failing the other — and which one applies is not recorded
 * anywhere on the number.
 *
 * This is the only country whose arithmetic is implemented here. The other
 * twenty-seven have twenty-seven different algorithms, and a checksum written
 * from memory that reports `passed: true` for everything is worse than no
 * checksum at all: it converts "we did not check" into "we checked and it was
 * fine". So they report `passed: null`.
 */
export function gbCheckDigits(number: string): ChecksumResult {
  if (/^(?:GD|HA)\d{3}$/.test(number)) {
    return {
      algorithm: "none",
      passed: null,
      note: "government department and health authority numbers carry no check digits",
    };
  }
  const digits = number.slice(0, 9);
  if (!/^\d{9}$/.test(digits)) {
    return { algorithm: "none", passed: null, note: "not a 9-digit VRN" };
  }
  const weights = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    sum += Number(digits[i]) * (weights[i] as number);
  }
  const check = Number(digits.slice(7));
  const mod97 = (sum + check) % 97 === 0;
  const mod9755 = (sum + 55 + check) % 97 === 0;
  return {
    algorithm: mod97 ? "mod-97" : mod9755 ? "mod-9755" : "mod-97 and mod-9755",
    passed: mod97 || mod9755,
    ...(mod97 || mod9755 ? {} : { note: "the last two digits match neither variant" }),
  };
}

export type SyntaxCheck = {
  readonly wellFormed: boolean;
  readonly country: string;
  readonly countryName: string;
  readonly number: string;
  readonly canonical: string;
  readonly shape: string;
  readonly checksum: ChecksumResult;
  readonly reason?: string;
  readonly note?: string;
};

/** Check one parsed id against its country's grammar, and its check digits if we own them. */
export function checkSyntax(parsed: Extract<ParsedVatId, { ok: true }>): SyntaxCheck {
  const { country, number, canonical } = parsed;
  const wellFormed = country.pattern.test(number);
  const checksum =
    country.code === "GB" || country.code === "XI"
      ? gbCheckDigits(number)
      : {
          algorithm: "not implemented",
          passed: null,
          note: `this package does not carry ${country.name}'s check-digit algorithm, so a well-formed id here means well-formed and nothing more`,
        };
  return {
    wellFormed,
    country: country.code,
    countryName: country.name,
    number,
    canonical,
    shape: country.shape,
    checksum,
    ...(wellFormed
      ? {}
      : { reason: `${canonical} is not shaped like a ${country.name} VAT id (${country.shape})` }),
    ...(country.note === undefined ? {} : { note: country.note }),
  };
}

// ---------------------------------------------------------------------------
// what the registers say
// ---------------------------------------------------------------------------

export type RegisterAnswer = {
  readonly outcome: VatOutcome;
  /** Why this outcome, in the register's own vocabulary where it has one. */
  readonly basis: string;
  /** The register's code, verbatim, so an operator can look it up. */
  readonly code?: string;
  readonly registration?: { readonly name?: string; readonly address?: string };
  readonly requestDate?: string;
  readonly consultationNumber?: string;
  readonly consultationNumberAbsent?: string;
  /** Present only on `unavailable`: whether asking again later could help. */
  readonly retryable?: boolean;
  /** VIES's own approximate-match verdict on a name we passed it, if we did. */
  readonly nameMatch?: string;
};

/**
 * Every `userError` VIES publishes, and which outcome it is.
 *
 * The temptation is a two-line mapping: `isValid ? valid : invalid`. Six of
 * these nine codes come back with `isValid: false` and mean nothing whatsoever
 * about the number.
 */
const VIES_CODES: Readonly<
  Record<string, { outcome: VatOutcome; meaning: string; retryable?: boolean }>
> = Object.freeze({
  VALID: { outcome: "found", meaning: "the member state answered" },
  INVALID: { outcome: "notFound", meaning: "the member state answered: not a registered number" },
  INVALID_INPUT: {
    outcome: "unavailable",
    meaning:
      "VIES rejected the request as malformed and never asked the member state — this says nothing about whether the number is registered",
    retryable: false,
  },
  INVALID_REQUESTER_INFO: {
    outcome: "unavailable",
    meaning:
      "VIES rejected the REQUESTER's own VAT id, so the whole call failed — retry without requesterVatId to get an answer without a consultation number",
    retryable: false,
  },
  SERVICE_UNAVAILABLE: {
    outcome: "unavailable",
    meaning: "VIES itself is down",
    retryable: true,
  },
  MS_UNAVAILABLE: {
    outcome: "unavailable",
    meaning: "the member state's own system did not answer",
    retryable: true,
  },
  MS_MAX_CONCURRENT_REQ: {
    outcome: "unavailable",
    meaning: "the member state is refusing further concurrent requests",
    retryable: true,
  },
  GLOBAL_MAX_CONCURRENT_REQ: {
    outcome: "unavailable",
    meaning: "VIES is refusing further concurrent requests",
    retryable: true,
  },
  TIMEOUT: {
    outcome: "unavailable",
    meaning: "the member state did not answer in time",
    retryable: true,
  },
  IP_BLOCKED: {
    outcome: "unavailable",
    meaning: "VIES has blocked this caller's address",
    retryable: false,
  },
  VAT_BLOCKED: {
    outcome: "unavailable",
    meaning: "VIES has blocked lookups of this number",
    retryable: false,
  },
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Read a VIES answer.
 *
 * `isValid: true` is the only shape that produces `found`, and only when the
 * accompanying code agrees. An unrecognised code produces `unavailable` with
 * the code quoted — a code this package has never seen is a reason to stop,
 * not a reason to guess which side of the line it falls on.
 */
export function mapViesResponse(body: unknown, requesterSupplied: boolean): RegisterAnswer {
  const doc = (body ?? {}) as Record<string, unknown>;
  const rawCode = str(doc["userError"]);
  const isValid = doc["isValid"];
  const code = rawCode ?? (isValid === true ? "VALID" : isValid === false ? "INVALID" : undefined);

  if (code === undefined) {
    return {
      outcome: "unavailable",
      basis:
        "VIES answered with neither isValid nor userError — the response shape is not one this tool can read",
      retryable: false,
    };
  }
  const known = VIES_CODES[code];
  if (known === undefined) {
    return {
      outcome: "unavailable",
      basis: `VIES answered with the code "${code}", which this tool does not recognise — refusing to guess whether that means registered or not`,
      code,
      retryable: false,
    };
  }
  // A code of VALID with isValid false is the member state saying "asked and
  // answered: no such registration". Both halves have to agree before this
  // reports a registration.
  const outcome: VatOutcome =
    known.outcome === "found" ? (isValid === true ? "found" : "notFound") : known.outcome;

  const name = str(doc["name"]);
  const address = str(doc["address"]);
  const consultation = str(doc["requestIdentifier"]);
  const approximate = doc["viesApproximate"] as Record<string, unknown> | undefined;

  return {
    outcome,
    basis:
      outcome === "found"
        ? "VIES: the member state confirmed this number is registered"
        : outcome === "notFound"
          ? "VIES: the member state confirmed this number is not registered"
          : `VIES: ${known.meaning}`,
    code,
    ...(outcome === "found" && (name !== undefined || address !== undefined)
      ? {
          registration: {
            ...(name === undefined ? {} : { name }),
            ...(address === undefined ? {} : { address }),
          },
        }
      : {}),
    ...(str(doc["requestDate"]) === undefined ? {} : { requestDate: str(doc["requestDate"]) }),
    ...(consultation === undefined
      ? {
          consultationNumberAbsent: requesterSupplied
            ? "a requester was supplied but VIES issued no consultation number for this call"
            : "no requesterVatId was supplied, so VIES issues none — the consultation number is the two-party call's receipt",
        }
      : { consultationNumber: consultation }),
    ...(approximate === undefined || str(approximate["matchName"]) === undefined
      ? {}
      : { nameMatch: String(approximate["matchName"]) }),
    ...(outcome === "unavailable" ? { retryable: known.retryable === true } : {}),
  };
}

/**
 * Read an HMRC answer.
 *
 * HMRC's shape is different in a way that matters: it answers 404 for a number
 * that is not registered, which the HTTP layer classifies as `notFound`, and
 * 503 with a maintenance code for an outage. The failure path lives in the
 * caller; this reads the 200 body.
 */
export function mapHmrcResponse(body: unknown, requesterSupplied: boolean): RegisterAnswer {
  const doc = (body ?? {}) as Record<string, unknown>;
  const target = (doc["target"] ?? {}) as Record<string, unknown>;
  const name = str(target["name"]);
  if (name === undefined && str(target["vatNumber"]) === undefined) {
    return {
      outcome: "unavailable",
      basis:
        "HMRC answered 200 with no target — the response shape is not one this tool can read, and an empty body is not evidence that a number is unregistered",
      retryable: false,
    };
  }
  const address = target["address"] as Record<string, unknown> | undefined;
  const addressLine =
    address === undefined
      ? undefined
      : [
          str(address["line1"]),
          str(address["line2"]),
          str(address["line3"]),
          str(address["line4"]),
          str(address["postcode"]),
          str(address["countryCode"]),
        ]
          .filter((part): part is string => part !== undefined)
          .join(", ") || undefined;
  const consultation = str(doc["consultationNumber"]);
  return {
    outcome: "found",
    basis: "HMRC: this number is registered for VAT",
    ...(name === undefined && addressLine === undefined
      ? {}
      : {
          registration: {
            ...(name === undefined ? {} : { name }),
            ...(addressLine === undefined ? {} : { address: addressLine }),
          },
        }),
    ...(str(doc["processingDate"]) === undefined
      ? {}
      : { requestDate: str(doc["processingDate"]) }),
    ...(consultation === undefined
      ? {
          consultationNumberAbsent: requesterSupplied
            ? "a requester was supplied but HMRC issued no consultation number for this call"
            : "no requesterVatId was supplied, so HMRC issues none — the consultation number is the two-party call's receipt",
        }
      : { consultationNumber: consultation }),
  };
}

/** The codes HMRC returns in an error body, and what each one means for us. */
export function hmrcErrorMeaning(code: string | undefined, status: number | undefined): string {
  switch (code) {
    case "NOT_FOUND":
      return "HMRC: this number is not registered for VAT";
    case "INVALID_REQUEST":
      return "HMRC rejected the request as malformed and did not look the number up";
    case "SCHEDULED_MAINTENANCE":
      return "HMRC's checker is down for scheduled maintenance";
    case "SERVER_ERROR":
    case "INTERNAL_SERVER_ERROR":
      return "HMRC's checker failed internally";
    default:
      return `HMRC answered ${status ?? "an error"}${code === undefined ? "" : ` with the code "${code}"`}`;
  }
}

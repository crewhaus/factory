/**
 * Payment identifier validation.
 *
 * Every one of these carries a checksum precisely so a typo is caught before
 * money moves, and every one of them is arithmetic — there is nothing for a
 * model to judge. Getting it wrong is expensive in a way that most wrong
 * answers are not, so each algorithm here is the published one and the tests
 * use published vectors.
 *
 * A valid checksum means the identifier is well-formed. It does not mean the
 * account exists, is open, or belongs to who you think. Nothing here reaches
 * a network, and the result says as much.
 */

export const IDENTIFIER_KINDS = ["iban", "bic", "aba", "card", "sortcode"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export type IdentifierResult = {
  readonly kind: IdentifierKind;
  readonly valid: boolean;
  /** The canonical form: spacing removed, case normalized. */
  readonly normalized: string;
  /** How it should be shown to a person, where a convention exists. */
  readonly formatted: string;
  /** Empty when valid; otherwise the specific thing that is wrong. */
  readonly reason: string;
  /** Whatever the identifier itself encodes — country, bank, check digits. */
  readonly parts: Readonly<Record<string, string>>;
};

/**
 * IBAN length by country. The length is part of the standard, so a string
 * that passes mod-97 at the wrong length is still not an IBAN — and mod-97
 * alone accepts plenty of those.
 */
const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    AD: 24,
    AE: 23,
    AL: 28,
    AT: 20,
    AZ: 28,
    BA: 20,
    BE: 16,
    BG: 22,
    BH: 22,
    BR: 29,
    BY: 28,
    CH: 21,
    CR: 22,
    CY: 28,
    CZ: 24,
    DE: 22,
    DK: 18,
    DO: 28,
    EE: 20,
    EG: 29,
    ES: 24,
    FI: 18,
    FO: 18,
    FR: 27,
    GB: 22,
    GE: 22,
    GI: 23,
    GL: 18,
    GR: 27,
    GT: 28,
    HR: 21,
    HU: 28,
    IE: 22,
    IL: 23,
    IQ: 23,
    IS: 26,
    IT: 27,
    JO: 30,
    KW: 30,
    KZ: 20,
    LB: 28,
    LC: 32,
    LI: 21,
    LT: 20,
    LU: 20,
    LV: 21,
    LY: 25,
    MC: 27,
    MD: 24,
    ME: 22,
    MK: 19,
    MR: 27,
    MT: 31,
    MU: 30,
    NL: 18,
    NO: 15,
    PK: 24,
    PL: 28,
    PS: 29,
    PT: 25,
    QA: 29,
    RO: 24,
    RS: 22,
    SA: 24,
    SC: 31,
    SD: 18,
    SE: 24,
    SI: 19,
    SK: 24,
    SM: 27,
    ST: 25,
    SV: 28,
    TL: 23,
    TN: 24,
    TR: 26,
    UA: 29,
    VA: 22,
    VG: 24,
    XK: 20,
  }).map(([k, v]) => [k, v as number]),
);

const strip = (raw: string): string => raw.replace(/[\s-]/g, "").toUpperCase();

/**
 * ISO 7064 MOD-97-10, computed a chunk at a time.
 *
 * The whole rearranged IBAN as one integer is up to 36 digits, past what a
 * JS number holds exactly — so it is folded 7 digits at a time, which is the
 * standard's own suggestion and stays inside the safe integer range.
 */
function mod97(digits: string): number {
  let remainder = 0;
  for (let i = 0; i < digits.length; i += 7) {
    remainder = Number(`${remainder}${digits.slice(i, i + 7)}`) % 97;
  }
  return remainder;
}

export function validateIban(raw: string): IdentifierResult {
  const normalized = strip(raw);
  const base = {
    kind: "iban" as const,
    normalized,
    formatted: (normalized.match(/.{1,4}/g) ?? []).join(" "),
    parts: {} as Record<string, string>,
  };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalized)) {
    return {
      ...base,
      valid: false,
      reason: "not in IBAN form: two letters, two digits, then alphanumerics",
    };
  }
  const country = normalized.slice(0, 2);
  const expected = IBAN_LENGTHS.get(country);
  if (expected === undefined) {
    return { ...base, valid: false, reason: `"${country}" is not a country that issues IBANs` };
  }
  if (normalized.length !== expected) {
    return {
      ...base,
      valid: false,
      reason: `${country} IBANs are ${expected} characters; this is ${normalized.length}`,
    };
  }
  // Move the first four characters to the end, then letters become numbers.
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const digits = [...rearranged]
    .map((ch) => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch))
    .join("");
  const ok = mod97(digits) === 1;
  return {
    ...base,
    valid: ok,
    reason: ok ? "" : "the check digits do not match the rest of the IBAN",
    parts: { country, checkDigits: normalized.slice(2, 4), bban: normalized.slice(4) },
  };
}

export function validateBic(raw: string): IdentifierResult {
  const normalized = strip(raw);
  const match = /^([A-Z]{4})([A-Z]{2})([A-Z0-9]{2})([A-Z0-9]{3})?$/.exec(normalized);
  if (!match) {
    return {
      kind: "bic",
      valid: false,
      normalized,
      formatted: normalized,
      reason: "a BIC is 8 or 11 characters: 4 bank, 2 country, 2 location, optionally 3 branch",
      parts: {},
    };
  }
  return {
    kind: "bic",
    valid: true,
    normalized,
    formatted: normalized,
    reason: "",
    parts: {
      bank: match[1] as string,
      country: match[2] as string,
      location: match[3] as string,
      branch: match[4] ?? "",
    },
  };
}

/** ABA routing number: a weighted sum over nine digits, 3-7-1 repeating. */
export function validateAba(raw: string): IdentifierResult {
  const normalized = raw.replace(/[\s-]/g, "");
  const base = { kind: "aba" as const, normalized, formatted: normalized, parts: {} };
  if (!/^\d{9}$/.test(normalized)) {
    return { ...base, valid: false, reason: "a routing number is exactly nine digits" };
  }
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...normalized].reduce(
    (total, digit, i) => total + Number(digit) * (weights[i] as number),
    0,
  );
  const ok = sum % 10 === 0;
  return {
    ...base,
    valid: ok,
    reason: ok ? "" : "the checksum does not match",
    parts: {
      federalReserve: normalized.slice(0, 4),
      institution: normalized.slice(4, 8),
      check: normalized.slice(8),
    },
  };
}

/** Luhn, as used by payment cards. */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card brands, by the prefixes and lengths the networks publish. */
function cardBrand(digits: string): string {
  if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) return "visa";
  if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(digits))
    return "mastercard";
  if (/^3[47]\d{13}$/.test(digits)) return "amex";
  if (/^(6011\d{12}|65\d{14}|64[4-9]\d{13})$/.test(digits)) return "discover";
  if (/^3(0[0-5]|[68]\d)\d{11}$/.test(digits)) return "diners";
  if (/^35(2[89]|[3-8]\d)\d{12}$/.test(digits)) return "jcb";
  return "unknown";
}

/**
 * Validate a card number's checksum.
 *
 * Only the last four digits are ever echoed. A validator that returned the
 * number it was given would take a value the caller has to protect and copy
 * it into a log, a transcript and a model's context.
 */
export function validateCard(raw: string): IdentifierResult {
  const digits = raw.replace(/[\s-]/g, "");
  const masked =
    digits.length >= 4 ? `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : "";
  const base = { kind: "card" as const, normalized: masked, formatted: masked, parts: {} };
  if (!/^\d{12,19}$/.test(digits)) {
    return { ...base, valid: false, reason: "a card number is 12 to 19 digits" };
  }
  const ok = luhnOk(digits);
  return {
    ...base,
    valid: ok,
    reason: ok ? "" : "the Luhn checksum does not match",
    parts: { brand: cardBrand(digits), last4: digits.slice(-4), length: String(digits.length) },
  };
}

/** UK sort code: six digits, and no checksum exists to check. */
export function validateSortCode(raw: string): IdentifierResult {
  const normalized = raw.replace(/[\s-]/g, "");
  const ok = /^\d{6}$/.test(normalized);
  return {
    kind: "sortcode",
    valid: ok,
    normalized,
    formatted: ok ? (normalized.match(/.{2}/g) ?? []).join("-") : normalized,
    // Said plainly: a well-formed sort code is not a verified one, and a
    // caller that reads `valid` as "this bank exists" would be wrong.
    reason: ok ? "" : "a sort code is exactly six digits",
    parts: ok ? { note: "a sort code carries no checksum; only its shape was checked" } : {},
  };
}

/** Guess which kind an identifier is, for callers that do not know. */
export function detectKind(raw: string): IdentifierKind | null {
  const normalized = strip(raw);
  if (
    /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalized) &&
    IBAN_LENGTHS.has(normalized.slice(0, 2))
  ) {
    return "iban";
  }
  if (/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalized)) return "bic";
  if (/^\d{9}$/.test(normalized)) return "aba";
  if (/^\d{6}$/.test(normalized)) return "sortcode";
  if (/^\d{12,19}$/.test(normalized)) return "card";
  return null;
}

export function validateIdentifier(raw: string, kind: IdentifierKind): IdentifierResult {
  switch (kind) {
    case "iban":
      return validateIban(raw);
    case "bic":
      return validateBic(raw);
    case "aba":
      return validateAba(raw);
    case "card":
      return validateCard(raw);
    case "sortcode":
      return validateSortCode(raw);
  }
}

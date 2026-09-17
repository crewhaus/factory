/**
 * Personal-data detectors.
 *
 * ## Read this before you trust a result
 *
 * Every rule here is a pattern over bytes. A pattern can prove that a string
 * has the SHAPE of an identifier, and for two formats it can prove a check
 * digit is consistent. It can never prove that a string IS somebody's
 * personal data, and — far more dangerous — an empty result can never prove
 * a document has none. A name, a free-text medical detail, an employee
 * number with a local format, an address that does not end in "Street": all
 * invisible here.
 *
 * So `PiiScan` reports what it LOOKED for, not what a document contains, and
 * nothing downstream should read "0 findings" as "safe to publish".
 *
 * ## The rules, and exactly what each one proves
 *
 * | rule | proves |
 * |---|---|
 * | `email.addr-spec-subset` | dot-atom local part, dotted domain, TLD of 2+ letters. Not quoted local parts, not IP-literal domains, not internationalized addresses. |
 * | `phone.e164` | `+` then 8–15 digits with common separators. |
 * | `phone.national.XX` | a national dialling shape for one of the seven supported countries. |
 * | `ssn.us-format` | `NNN-NN-NNNN` with a group the SSA has never issued (000/666/900+ area, 00 group, 0000 serial) excluded. NOT validity: there is no public checksum for an SSN, and this package does not pretend otherwise. |
 * | `iban.iso7064-mod97` | the ISO 7064 mod-97-10 check digits are correct, and where the country is known, the length matches. A real check, verifiable offline. |
 * | `card.luhn` | the Luhn check digit is correct. A real check. It does not mean the card exists or is live. |
 * | `ip.v4-dotted` / `ip.v6-parsed` | a parseable address literal. Private, loopback and documentation ranges are labelled, because those are usually not personal data. |
 * | `dob.labelled` / `date.calendar` | a calendar date. Only a nearby "date of birth"-style label, or a caller-supplied `referenceDate` that makes the age plausible, raises it above `possible`. |
 * | `address.us-street-suffix` / `address.us-city-state-zip` | a US-style street line or city/state/ZIP tail. US conventions only. |
 */
import { type Confidence, type Finding, matchAll, withPositions } from "./text";

export const PII_TYPES = [
  "credit_card",
  "date_of_birth",
  "email",
  "iban",
  "ip_address",
  "phone",
  "postal_address",
  "us_ssn",
] as const;

export type PiiType = (typeof PII_TYPES)[number];

/** Countries whose national (non-`+`) dialling shapes are implemented. */
export const SUPPORTED_PHONE_COUNTRIES = ["AU", "CA", "DE", "FR", "GB", "IN", "US"] as const;
export type PhoneCountry = (typeof SUPPORTED_PHONE_COUNTRIES)[number];

export type PiiOptions = {
  /** Which detectors to run. Defaults to all of them. */
  readonly types?: ReadonlyArray<PiiType>;
  /** Country hint for national phone shapes. E.164 is always scanned. */
  readonly country?: string;
  /** `YYYY-MM-DD`. Enables the age-plausibility test for dates of birth. */
  readonly referenceDate?: string;
};

type Raw = Omit<Finding, "line" | "column">;

export class PiiOptionError extends Error {
  override readonly name = "PiiOptionError";
}

// ---------------------------------------------------------------------------
// check digits — the only two things in this file that PROVE anything
// ---------------------------------------------------------------------------

/** Luhn (ISO/IEC 7812-1) over a digits-only string. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 12 || digits.length > 19 || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ISO 7064 mod-97-10, as IBANs use it: rotate the first four characters to
 * the end, map letters to two-digit numbers, and take the remainder modulo
 * 97 in chunks, because the integer does not fit in a double.
 */
export function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const piece =
      code >= 48 && code <= 57
        ? String(code - 48)
        : code >= 65 && code <= 90
          ? String(code - 55)
          : undefined;
    if (piece === undefined) return -1;
    for (const digit of piece) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

/**
 * Registered IBAN lengths. A country not listed is still check-digit tested,
 * but reported at lower confidence and flagged `unknownCountry`, because the
 * length rule is half of what makes an IBAN verifiable.
 */
export const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map([
  ["AD", 24], ["AE", 23], ["AL", 28], ["AT", 20], ["AZ", 28], ["BA", 20], ["BE", 16],
  ["BG", 22], ["BH", 22], ["BR", 29], ["BY", 28], ["CH", 21], ["CR", 22], ["CY", 28],
  ["CZ", 24], ["DE", 22], ["DK", 18], ["DO", 28], ["EE", 20], ["EG", 29], ["ES", 24],
  ["FI", 18], ["FO", 18], ["FR", 27], ["GB", 22], ["GE", 22], ["GI", 23], ["GL", 18],
  ["GR", 27], ["GT", 28], ["HR", 21], ["HU", 28], ["IE", 22], ["IL", 23], ["IS", 26],
  ["IT", 27], ["JO", 30], ["KW", 30], ["KZ", 20], ["LB", 28], ["LC", 32], ["LI", 21],
  ["LT", 20], ["LU", 20], ["LV", 21], ["LY", 25], ["MC", 27], ["MD", 24], ["ME", 22],
  ["MK", 19], ["MR", 27], ["MT", 31], ["MU", 30], ["NL", 18], ["NO", 15], ["PK", 24],
  ["PL", 28], ["PS", 29], ["PT", 25], ["QA", 29], ["RO", 24], ["RS", 22], ["SA", 24],
  ["SC", 31], ["SE", 24], ["SI", 19], ["SK", 24], ["SM", 27], ["ST", 25], ["SV", 28],
  ["TL", 23], ["TN", 24], ["TR", 26], ["UA", 29], ["VA", 22], ["VG", 24], ["XK", 20],
]);

/** Issuer, by the IIN prefix ranges that are stable and public. */
export function cardBrand(digits: string): string {
  const n = digits.length;
  if (/^4/.test(digits) && (n === 13 || n === 16 || n === 19)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(digits) && n === 16) return "mastercard";
  if (/^3[47]/.test(digits) && n === 15) return "amex";
  if (/^(6011|65|64[4-9])/.test(digits) && (n === 16 || n === 19)) return "discover";
  if (/^35(2[89]|[3-8]\d)/.test(digits) && (n === 16 || n === 19)) return "jcb";
  if (/^3(0[0-5]|[68])/.test(digits) && (n === 14 || n === 16)) return "diners";
  if (/^62/.test(digits) && n >= 16) return "unionpay";
  return "unknown";
}

// ---------------------------------------------------------------------------
// IP literals
// ---------------------------------------------------------------------------

/** Dotted-quad parse. Rejects leading zeros, which are an obfuscation trick. */
export function parseIpv4(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith("0")) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

/**
 * IPv6 as RFC 4291 §2.2 forms 1–3: eight hextets, `::` compression at most
 * once, and a trailing dotted-quad. Zone identifiers (`%eth0`) and CIDR
 * suffixes are NOT accepted — they are addresses plus something else, and
 * guessing which is a good way to be confidently wrong.
 */
export function parseIpv6(value: string): number[] | undefined {
  if (value.includes("%") || value.includes("/")) return undefined;
  const doubleColons = value.split("::").length - 1;
  if (doubleColons > 1) return undefined;
  let head = value;
  let tailGroups: number[] = [];
  const lastColon = value.lastIndexOf(":");
  if (lastColon >= 0 && value.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(value.slice(lastColon + 1));
    if (!v4) return undefined;
    const [a, b, c, d] = v4 as [number, number, number, number];
    tailGroups = [(a << 8) | b, (c << 8) | d];
    head = value.slice(0, lastColon + 1);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const expectedGroups = 8 - tailGroups.length;
  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const groups: number[] = [];
    for (const piece of side.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  if (doubleColons === 1) {
    const [beforeRaw = "", afterRaw = ""] = head.split("::");
    const before = parseSide(beforeRaw.replace(/:$/, ""));
    const after = parseSide(afterRaw.replace(/^:/, ""));
    if (!before || !after) return undefined;
    const missing = expectedGroups - before.length - after.length;
    if (missing < 1) return undefined;
    return [...before, ...new Array<number>(missing).fill(0), ...after, ...tailGroups];
  }
  const groups = parseSide(head.replace(/:$/, ""));
  if (!groups || groups.length !== expectedGroups) return undefined;
  return [...groups, ...tailGroups];
}

/** Label an IPv4 address that is almost certainly not personal data. */
function ipv4Scope(octets: ReadonlyArray<number>): string {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 0 || a >= 224) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 198 && (b === 51 || b === 18 || b === 19)) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  return "public";
}

// ---------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;
const SSN = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6_CANDIDATE = /\b(?=[0-9A-Fa-f:]*::|(?:[0-9A-Fa-f]{1,4}:){7})[0-9A-Fa-f:]{2,39}(?:\.\d{1,3}){0,3}/g;
const PHONE_E164 = /\+\d[\d\s().-]{6,18}\d/g;
const DATE_ISO = /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const DATE_US = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})\b/g;
const DATE_DOTTED = /\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.((?:19|20)\d{2})\b/g;
const DATE_LONG = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/gi;
const DOB_LABEL = /(date of birth|d\.?o\.?b\.?|birth ?date|birthday|born(?:\s+on)?)\s*[:\-]?\s*$/i;

const STREET_SUFFIX =
  "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Terrace|Ter|Place|Pl|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl)";
const ADDRESS_STREET = new RegExp(
  `\\b\\d{1,6}\\s+(?:[A-Za-z0-9.'#-]+\\s+){0,4}${STREET_SUFFIX}\\b\\.?(?:\\s+(?:Apt|Suite|Ste|Unit|#)\\s*[A-Za-z0-9-]+)?`,
  "g",
);
const ADDRESS_CITY_STATE_ZIP = /\b[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3},\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])\s+\d{5}(?:-\d{4})?\b/g;

const NATIONAL_PHONE: Readonly<Record<PhoneCountry, RegExp>> = {
  // NANP: area and exchange codes both start 2-9.
  US: /(?:\(\d{3}\)|\b[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}\b/g,
  CA: /(?:\(\d{3}\)|\b[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}\b/g,
  GB: /\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
  DE: /\b0\d{2,4}[\s/-]?\d{3,8}\b/g,
  FR: /\b0[1-9](?:[\s.-]?\d{2}){4}\b/g,
  AU: /\b0[2-478][\s-]?\d{4}[\s-]?\d{4}\b/g,
  IN: /\b[6-9]\d{4}[\s-]?\d{5}\b/g,
};

// ---------------------------------------------------------------------------

function selected(options: PiiOptions, type: PiiType): boolean {
  return options.types === undefined || options.types.includes(type);
}

/** Days since the epoch for a valid Gregorian Y-M-D, or undefined. */
export function calendarDay(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1) return undefined;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (lengths[month - 1] ?? 0)) return undefined;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Whole years between two calendar dates. Used only for DOB plausibility. */
function yearsBetween(
  from: { y: number; m: number; d: number },
  to: { y: number; m: number; d: number },
): number {
  let age = to.y - from.y;
  if (to.m < from.m || (to.m === from.m && to.d < from.d)) age -= 1;
  return age;
}

type ParsedDate = { y: number; m: number; d: number };

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function collectDates(text: string): Array<{ start: number; end: number; raw: string; date: ParsedDate }> {
  const out: Array<{ start: number; end: number; raw: string; date: ParsedDate }> = [];
  for (const { index, match } of matchAll(text, DATE_ISO)) {
    const [raw] = match;
    const [y, m, d] = raw.split("-").map(Number) as [number, number, number];
    out.push({ start: index, end: index + raw.length, raw, date: { y, m, d } });
  }
  for (const { index, match } of matchAll(text, DATE_US)) {
    const raw = match[0];
    const y = Number(match[3]);
    const m = Number(match[1]);
    const d = Number(match[2]);
    out.push({ start: index, end: index + raw.length, raw, date: { y, m, d } });
  }
  for (const { index, match } of matchAll(text, DATE_DOTTED)) {
    const raw = match[0];
    out.push({
      start: index,
      end: index + raw.length,
      raw,
      date: { y: Number(match[3]), m: Number(match[2]), d: Number(match[1]) },
    });
  }
  for (const { index, match } of matchAll(text, DATE_LONG)) {
    const raw = match[0];
    const month = MONTH_NAMES.indexOf((match[1] ?? "").toLowerCase()) + 1;
    out.push({
      start: index,
      end: index + raw.length,
      raw,
      date: { y: Number(match[3]), m: month, d: Number(match[2]) },
    });
  }
  return out;
}

/**
 * Run the selected detectors. Overlaps are NOT resolved here — the caller
 * runs `dedupeOverlaps`, so a caller that wants every raw hit can have it.
 */
export function scanPii(text: string, options: PiiOptions = {}): Finding[] {
  const raw: Raw[] = [];

  if (options.country !== undefined) {
    const upper = options.country.toUpperCase();
    if (!(SUPPORTED_PHONE_COUNTRIES as ReadonlyArray<string>).includes(upper)) {
      throw new PiiOptionError(
        `country "${options.country}" has no national phone rule here; supported: ${SUPPORTED_PHONE_COUNTRIES.join(", ")}. Leave it unset to scan E.164 (+…) numbers only.`,
      );
    }
  }
  let reference: ParsedDate | undefined;
  if (options.referenceDate !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(options.referenceDate);
    const parsed = m
      ? calendarDay(Number(m[1]), Number(m[2]), Number(m[3])) !== undefined
        ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
        : undefined
      : undefined;
    if (!parsed) {
      throw new PiiOptionError(
        `referenceDate "${options.referenceDate}" is not a valid YYYY-MM-DD calendar date`,
      );
    }
    reference = parsed;
  }

  if (selected(options, "email")) {
    for (const { index, match } of matchAll(text, EMAIL)) {
      raw.push({
        type: "email",
        rule: "email.addr-spec-subset",
        confidence: "likely",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { domain: (match[0].split("@")[1] ?? "").toLowerCase() },
      });
    }
  }

  if (selected(options, "us_ssn")) {
    for (const { index, match } of matchAll(text, SSN)) {
      const area = match[1] ?? "";
      const group = match[2] ?? "";
      const serial = match[3] ?? "";
      // Ranges the SSA has never issued. Excluding them cuts false positives
      // without ever claiming the remainder was issued.
      if (area === "000" || area === "666" || area.startsWith("9")) continue;
      if (group === "00" || serial === "0000") continue;
      raw.push({
        type: "us_ssn",
        rule: "ssn.us-format",
        confidence: "possible",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { note: "format only; an SSN has no public check digit" },
      });
    }
  }

  if (selected(options, "iban")) {
    for (const { index, match } of matchAll(text, IBAN_CANDIDATE)) {
      const compact = match[0].replace(/\s/g, "");
      if (compact.length < 15 || compact.length > 34) continue;
      if (ibanMod97(compact) !== 1) continue;
      const country = compact.slice(0, 2);
      const expected = IBAN_LENGTHS.get(country);
      if (expected !== undefined && expected !== compact.length) continue;
      raw.push({
        type: "iban",
        rule: expected === undefined ? "iban.iso7064-mod97-unknown-country" : "iban.iso7064-mod97",
        confidence: expected === undefined ? "likely" : "verified",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { country, length: compact.length, unknownCountry: expected === undefined },
      });
    }
  }

  if (selected(options, "credit_card")) {
    for (const { index, match } of matchAll(text, CARD_CANDIDATE)) {
      const digits = match[0].replace(/[ -]/g, "");
      // Only a passing Luhn check is reported. A digit run that fails it is
      // an order number far more often than it is a mistyped card.
      if (!luhnValid(digits)) continue;
      raw.push({
        type: "credit_card",
        rule: "card.luhn",
        confidence: "verified",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { brand: cardBrand(digits), digits: digits.length },
      });
    }
  }

  if (selected(options, "ip_address")) {
    for (const { index, match } of matchAll(text, IPV4)) {
      const octets = parseIpv4(match[0]);
      if (!octets) continue;
      const scope = ipv4Scope(octets);
      raw.push({
        type: "ip_address",
        rule: "ip.v4-dotted",
        confidence: scope === "public" ? "likely" : "possible",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { version: 4, scope },
      });
    }
    for (const { index, match } of matchAll(text, IPV6_CANDIDATE)) {
      const candidate = match[0].replace(/[:.]+$/, "");
      if (!candidate.includes(":")) continue;
      const groups = parseIpv6(candidate);
      if (!groups) continue;
      const first = groups[0] ?? 0;
      const loopback = groups.every((g, i) => (i === 7 ? g === 1 : g === 0));
      const scope = loopback
        ? "loopback"
        : (first & 0xfe00) === 0xfc00
          ? "unique-local"
          : (first & 0xffc0) === 0xfe80
            ? "link-local"
            : first === 0x2001 && (groups[1] ?? 0) === 0x0db8
              ? "documentation"
              : "public";
      raw.push({
        type: "ip_address",
        rule: "ip.v6-parsed",
        confidence: scope === "public" ? "likely" : "possible",
        start: index,
        end: index + candidate.length,
        value: candidate,
        detail: { version: 6, scope },
      });
    }
  }

  if (selected(options, "phone")) {
    for (const { index, match } of matchAll(text, PHONE_E164)) {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) continue;
      raw.push({
        type: "phone",
        rule: "phone.e164",
        confidence: "likely",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { digits: digits.length, form: "e164" },
      });
    }
    if (options.country !== undefined) {
      const country = options.country.toUpperCase() as PhoneCountry;
      for (const { index, match } of matchAll(text, NATIONAL_PHONE[country])) {
        const digits = match[0].replace(/\D/g, "");
        if (digits.length < 9 || digits.length > 12) continue;
        raw.push({
          type: "phone",
          rule: `phone.national.${country}`,
          confidence: "possible",
          start: index,
          end: index + match[0].length,
          value: match[0],
          detail: { digits: digits.length, country, form: "national" },
        });
      }
    }
  }

  if (selected(options, "date_of_birth")) {
    for (const hit of collectDates(text)) {
      const { y, m, d } = hit.date;
      if (calendarDay(y, m, d) === undefined) continue;
      const before = text.slice(Math.max(0, hit.start - 40), hit.start);
      const labelled = DOB_LABEL.test(before);
      let confidence: Confidence = "possible";
      let rule = "date.calendar";
      const detail: Record<string, string | number | boolean> = { iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
      if (reference) {
        const age = yearsBetween(hit.date, reference);
        detail["ageAtReference"] = age;
        if (age < 0 || age > 120) continue; // not a plausible birth date
        if (labelled) {
          confidence = "likely";
          rule = "dob.labelled";
        }
      } else if (labelled) {
        confidence = "likely";
        rule = "dob.labelled";
      }
      if (!labelled && !reference) detail["note"] = "no label and no referenceDate: any calendar date matches";
      raw.push({
        type: "date_of_birth",
        rule,
        confidence,
        start: hit.start,
        end: hit.end,
        value: hit.raw,
        detail,
      });
    }
  }

  if (selected(options, "postal_address")) {
    for (const { index, match } of matchAll(text, ADDRESS_STREET)) {
      raw.push({
        type: "postal_address",
        rule: "address.us-street-suffix",
        confidence: "possible",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { convention: "US" },
      });
    }
    for (const { index, match } of matchAll(text, ADDRESS_CITY_STATE_ZIP)) {
      raw.push({
        type: "postal_address",
        rule: "address.us-city-state-zip",
        confidence: "possible",
        start: index,
        end: index + match[0].length,
        value: match[0],
        detail: { convention: "US", state: match[1] ?? "" },
      });
    }
  }

  return withPositions(text, raw);
}

/**
 * The value a pseudonym is derived from, so the same identifier produces the
 * same token no matter how it was written. Case and separators only — no
 * semantic normalization, because that would need judgement.
 */
export function canonicalPiiValue(type: string, value: string): string {
  switch (type) {
    case "email":
      return value.trim().toLowerCase();
    case "credit_card":
    case "phone":
    case "us_ssn":
      return value.replace(/[^\d+]/g, "");
    case "iban":
      return value.replace(/\s/g, "").toUpperCase();
    case "ip_address":
      return value.trim().toLowerCase();
    default:
      return value.trim().replace(/\s+/g, " ");
  }
}

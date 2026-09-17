/**
 * String format checks, written out rather than borrowed.
 *
 * Every one of these is a *stated subset*, not a full grammar. The rule this
 * file follows: reject what is definitely wrong, accept what is definitely
 * right, and say in the doc comment which grey areas fall which way — so a
 * harness gating on `ValidateFormat` knows exactly what it bought. A format
 * check that quietly disagrees with the reader downstream is worse than no
 * check at all.
 */

/** Every format name {@link checkFormat} understands. */
export const FORMAT_NAMES = [
  "email",
  "uri",
  "uri-reference",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
  "date",
  "time",
  "date-time",
  "json-pointer",
  "regex",
] as const;

export type FormatName = (typeof FORMAT_NAMES)[number];

/** Result of one format check: valid, or invalid with the reason why. */
export type FormatResult = { valid: boolean; reason: string | null };

const OK: FormatResult = { valid: true, reason: null };
const bad = (reason: string): FormatResult => ({ valid: false, reason });

/** True when `name` is one this module implements. */
export function isFormatName(name: string): name is FormatName {
  return (FORMAT_NAMES as readonly string[]).includes(name);
}

/**
 * A DNS hostname: dot-separated labels, each 1-63 characters of letters,
 * digits and hyphens, not starting or ending with a hyphen; 253 characters
 * total at most.
 *
 * Deliberate choices: a trailing dot (the DNS root) is rejected, underscores
 * are rejected (legal in some DNS records, not in a hostname), and no
 * internationalized form is decoded — a Unicode domain must arrive already
 * punycoded.
 */
export function isHostname(value: string): FormatResult {
  if (value === "") return bad("empty hostname");
  if (value.length > 253) return bad(`${value.length} characters, over the 253 limit`);
  for (const label of value.split(".")) {
    if (label === "") return bad("empty label (a leading, doubled or trailing dot)");
    if (label.length > 63) return bad(`label "${label}" is over 63 characters`);
    if (!/^[A-Za-z0-9-]+$/.test(label)) {
      return bad(`label "${label}" has a character outside A-Z a-z 0-9 -`);
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return bad(`label "${label}" starts or ends with a hyphen`);
    }
  }
  return OK;
}

/**
 * Dotted-quad IPv4. Four decimal octets 0-255, no leading zeros — `01.2.3.4`
 * is rejected, because a leading zero means octal to some parsers and
 * decimal to others, and that ambiguity has been a source of SSRF bugs.
 */
export function isIpv4(value: string): FormatResult {
  const parts = value.split(".");
  if (parts.length !== 4) return bad(`expected 4 dot-separated octets, found ${parts.length}`);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return bad(`octet "${part}" is not 1-3 digits`);
    if (part.length > 1 && part.startsWith("0")) return bad(`octet "${part}" has a leading zero`);
    if (Number(part) > 255) return bad(`octet "${part}" is over 255`);
  }
  return OK;
}

/**
 * IPv6, including `::` compression and a dotted-quad IPv4 tail
 * (`::ffff:192.0.2.1`). A zone identifier (`fe80::1%eth0`) is rejected: it
 * addresses an interface, not a host, and is not part of the `ipv6` format.
 */
export function isIpv6(value: string): FormatResult {
  if (value === "") return bad("empty address");
  if (value.includes("%")) return bad("zone identifiers are not part of the ipv6 format");
  const doubleColons = value.split("::").length - 1;
  if (doubleColons > 1) return bad('"::" may appear at most once');

  /**
   * Count the groups in one run of colon-separated text. An empty run is
   * zero groups, which is what each side of a leading or trailing `::` is;
   * an empty *group* is a stray colon and is rejected, which is what keeps
   * `:::`, `1:::2` and a trailing `1:2:...:8:` out. A dotted quad is only
   * accepted as the final group of the run, and stands for two groups.
   */
  const countGroups = (
    text: string,
    allowQuad: boolean,
  ): { groups: number } | { error: string } => {
    if (text === "") return { groups: 0 };
    const parts = text.split(":");
    let groups = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      if (allowQuad && i === parts.length - 1 && part.includes(".")) {
        const v4 = isIpv4(part);
        if (!v4.valid) return { error: `embedded IPv4 "${part}": ${v4.reason}` };
        groups += 2;
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) {
        return { error: `group "${part}" is not 1-4 hex digits` };
      }
      groups += 1;
    }
    return { groups };
  };

  if (doubleColons === 1) {
    // The quad may only appear after the compression, so the left side never
    // carries one; a dot there is a malformed group and is rejected as such.
    const [rawLeft = "", rawRight = ""] = value.split("::");
    const left = countGroups(rawLeft, false);
    if ("error" in left) return bad(left.error);
    const right = countGroups(rawRight, true);
    if ("error" in right) return bad(right.error);
    const total = left.groups + right.groups;
    if (total > 7) {
      return bad(`"::" must stand for at least one group, but ${total} are written out`);
    }
    return OK;
  }

  const written = countGroups(value, true);
  if ("error" in written) return bad(written.error);
  if (written.groups !== 8) return bad(`expected 8 groups, found ${written.groups}`);
  return OK;
}

/**
 * A UUID in the 8-4-4-4-12 hex form, any case.
 *
 * Any version and variant is accepted, including the nil UUID — this checks
 * the shape, not that the value came from a v4 generator. Braces and a
 * `urn:uuid:` prefix are rejected.
 */
export function isUuid(value: string): FormatResult {
  if (!/^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(value)) {
    return bad("expected 8-4-4-4-12 hexadecimal digits");
  }
  return OK;
}

/** Days in a month, honouring the Gregorian leap-year rule. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * RFC 3339 `full-date`: `YYYY-MM-DD`, calendar-checked, so `2023-02-30` and
 * `2023-13-01` are rejected and `2024-02-29` is accepted. No other layout is
 * accepted; `2023-1-1` fails.
 */
export function isDate(value: string): FormatResult {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) return bad("expected YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return bad(`month ${month} is not 1-12`);
  const max = daysInMonth(year, month);
  if (day < 1 || day > max) return bad(`day ${day} is outside 1-${max} for that month`);
  return OK;
}

/**
 * RFC 3339 `full-time`: `HH:MM:SS`, an optional fractional part, and a
 * mandatory offset of `Z`, `z`, or `+HH:MM` / `-HH:MM`.
 *
 * A seconds value of 60 is accepted, because RFC 3339 allows it for leap
 * seconds. An offset with minutes over 59 is rejected.
 */
export function isTime(value: string): FormatResult {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/);
  if (match === null) return bad("expected HH:MM:SS with an offset of Z or +HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23) return bad(`hour ${hour} is over 23`);
  if (minute > 59) return bad(`minute ${minute} is over 59`);
  if (second > 60) return bad(`second ${second} is over 60`);
  const offset = match[5] ?? "";
  if (offset !== "Z" && offset !== "z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23) return bad(`offset hour ${offsetHour} is over 23`);
    if (offsetMinute > 59) return bad(`offset minute ${offsetMinute} is over 59`);
  }
  return OK;
}

/**
 * RFC 3339 `date-time`: a date, a `T` (or lowercase `t`) separator, and a
 * time with an offset. A space separator, as SQL writes it, is rejected —
 * this is the strict interchange form.
 */
export function isDateTime(value: string): FormatResult {
  const split = value.match(/^(.+?)[Tt](.+)$/);
  if (split === null) return bad('expected a "T" between the date and the time');
  const date = isDate(split[1] ?? "");
  if (!date.valid) return bad(`date part: ${date.reason}`);
  const time = isTime(split[2] ?? "");
  if (!time.valid) return bad(`time part: ${time.reason}`);
  return OK;
}

/**
 * An email address, in the form services actually accept: a dot-separated
 * local part of unquoted ASCII characters and a hostname domain.
 *
 * Deliberately narrower than RFC 5322: quoted local parts, comments,
 * IP-literal domains (`a@[192.0.2.1]`) and non-ASCII are all rejected. A
 * domain with no dot (`a@localhost`) is rejected too, since a bare host is
 * never a deliverable address in practice.
 */
export function isEmail(value: string): FormatResult {
  const at = value.lastIndexOf("@");
  if (at < 0) return bad('no "@"');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local === "") return bad("empty local part");
  if (local.length > 64) return bad(`local part is ${local.length} characters, over the 64 limit`);
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) {
    return bad("local part has a character outside the unquoted set");
  }
  if (local.startsWith(".") || local.endsWith(".")) {
    return bad("local part starts or ends with a dot");
  }
  if (local.includes("..")) return bad("local part has two consecutive dots");
  const host = isHostname(domain);
  if (!host.valid) return bad(`domain: ${host.reason}`);
  if (!domain.includes(".")) return bad("domain has no dot");
  return OK;
}

/**
 * True when the string holds a character no URI may contain: any whitespace,
 * any C0 control character, or DEL. The codes are compared numerically rather
 * than through a character class so no control character appears in source.
 */
function hasIllegalUriChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/.test(char)) return true;
  }
  return false;
}

/**
 * An absolute URI: a scheme (`[A-Za-z][A-Za-z0-9+.-]*`), a colon, and a
 * non-empty remainder with no whitespace or control characters.
 *
 * This is the absolute-URI shape check, not the full RFC 3986 grammar: the
 * authority, path, query and fragment are not parsed. `/path` and
 * `page.html` are rejected — use `uri-reference` for those.
 */
export function isUri(value: string): FormatResult {
  if (hasIllegalUriChar(value)) return bad("contains whitespace or a control character");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:.+$/.test(value)) {
    return bad("no scheme — an absolute URI needs one, e.g. https:");
  }
  return OK;
}

/**
 * A URI reference: either an absolute URI or a relative one. Only whitespace,
 * control characters and a second `#` are rejected; anything else a browser
 * would resolve is accepted.
 */
export function isUriReference(value: string): FormatResult {
  if (hasIllegalUriChar(value)) return bad("contains whitespace or a control character");
  if (value.split("#").length > 2) return bad('more than one "#"');
  return OK;
}

/** RFC 6901 JSON Pointer: empty, or `/`-led tokens where `~` is followed by 0 or 1. */
export function isJsonPointer(value: string): FormatResult {
  if (value === "") return OK;
  if (!value.startsWith("/")) return bad('a non-empty pointer must start with "/"');
  if (/~(?![01])/.test(value)) return bad('"~" must be followed by 0 or 1');
  return OK;
}

/** A string that compiles as a JavaScript regular expression. */
export function isRegex(value: string): FormatResult {
  try {
    new RegExp(value);
    return OK;
  } catch (err) {
    return bad((err as Error).message);
  }
}

/**
 * Check one string against one format name. An unknown format name is a
 * caller error and throws; every implemented format returns a result.
 */
export function checkFormat(value: string, format: FormatName): FormatResult {
  switch (format) {
    case "email":
      return isEmail(value);
    case "uri":
      return isUri(value);
    case "uri-reference":
      return isUriReference(value);
    case "hostname":
      return isHostname(value);
    case "ipv4":
      return isIpv4(value);
    case "ipv6":
      return isIpv6(value);
    case "uuid":
      return isUuid(value);
    case "date":
      return isDate(value);
    case "time":
      return isTime(value);
    case "date-time":
      return isDateTime(value);
    case "json-pointer":
      return isJsonPointer(value);
    case "regex":
      return isRegex(value);
    default:
      throw new Error(`unknown format "${String(format)}"`);
  }
}

/**
 * The formats, narrowest first.
 *
 * These grammars overlap, and the overlap is not symmetric: every dotted
 * quad, every UUID and every `YYYY-MM-DD` date is also a syntactically valid
 * hostname, since a hostname label is just letters, digits and hyphens. A
 * caller asking "what does this value look like" wants `uuid` before
 * `hostname`, so the answer is ordered by how much each format rules out
 * rather than by declaration order.
 *
 * `regex` and `uri-reference` are absent because they match nearly every
 * string; reporting them would be noise rather than a finding.
 */
const FORMAT_SPECIFICITY: readonly FormatName[] = [
  "uuid",
  "ipv4",
  "ipv6",
  "date-time",
  "date",
  "time",
  "email",
  "json-pointer",
  "uri",
  "hostname",
] as const;

/**
 * The formats a value matches, narrowest first — see
 * {@link FORMAT_SPECIFICITY}. Used by `ValidateFormat` to tell a caller what
 * their value *does* look like when it fails the format they asked for, and
 * by schema inference, which narrows the list further before labelling a
 * field.
 */
export function matchingFormats(value: string): FormatName[] {
  return FORMAT_SPECIFICITY.filter((name) => checkFormat(value, name).valid);
}

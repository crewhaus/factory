/**
 * Reading the three TXT records a sending domain publishes about itself.
 *
 * Everything here is pure: a record arrives as the string DNS handed back
 * and leaves as parsed facts. The lookups themselves live in `../net`, next
 * to the rest of the outbound posture, so a bug in tag parsing reads as a
 * failing unit rather than as a failing tool call.
 *
 * Three rules shape all of it.
 *
 *   1. **Report what the record says, never a score.** "no DMARC record" and
 *      "a DMARC record with p=none" are different facts about a domain, and
 *      the second one is a deliberate choice somebody made. A single number
 *      hides which of the two you are looking at, and hides it in exactly
 *      the case where the answer decides what to do next. So the output is
 *      the tags, verbatim, plus notes that state what the RFC says a
 *      receiver does with them.
 *   2. **A record this cannot parse is not a record that says no.** Every
 *      shape here has an "unreadable, because ..." answer distinct from
 *      "absent". Reporting a corrupt DKIM record as a missing one sends
 *      somebody looking in the wrong place.
 *   3. **Nothing here verifies a signature.** `parseDkim` reports what the
 *      KEY record says - its type, its size, whether it has been revoked -
 *      and never whether a message's DKIM signature validates. That needs
 *      canonicalisation, header selection and body hashing this package does
 *      not implement, and a partial signature check that can return "pass"
 *      is a security control that controls nothing.
 */
import { Buffer } from "node:buffer";
import { createPublicKey } from "node:crypto";
import { domainToASCII } from "node:url";

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

/** Longest DNS name, and longest label, in octets (RFC 1035 section 2.3.4). */
const MAX_NAME_LENGTH = 253;

/** A letter-digit-hyphen label that neither starts nor ends with a hyphen. */
const LDH_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A TLD: at least two characters, starting with a letter. `xn--…` qualifies. */
const TLD = /^[A-Za-z][A-Za-z0-9-]{1,62}$/;

export type NormalizedName =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Canonicalise a domain into the exact name that will be queried.
 *
 * The value that comes back is the value every later step uses - the
 * allow-list check, the `_dmarc.` and `._domainkey.` names, and the result
 * the caller reads. Checking one spelling and querying another is how a gate
 * ends up guarding a name nobody asked for.
 *
 * `domainToASCII` does the IDNA half (`münchen.de` is queried as
 * `xn--mnchen-3ya.de`, which is the only form a resolver understands) and
 * nothing else: it returns `a..b.com`, `-bad.com` and a trailing dot
 * unchanged, and it does NOT lowercase ASCII. So the label grammar is
 * checked afterwards, on its output, rather than assumed from it.
 */
export function normalizeDomain(raw: string): NormalizedName {
  const trimmed = raw.trim().replace(/\.$/, "");
  if (trimmed === "") return { ok: false, reason: "the domain is empty" };
  const ascii = domainToASCII(trimmed).toLowerCase();
  if (ascii === "") {
    return { ok: false, reason: `"${clip(raw)}" is not a domain name a resolver could be asked` };
  }
  if (ascii.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `the domain is longer than the ${MAX_NAME_LENGTH}-octet limit` };
  }
  const labels = ascii.split(".");
  if (labels.length < 2) {
    return {
      ok: false,
      reason: `"${clip(ascii)}" is a single label, not a domain that can publish SPF or DMARC`,
    };
  }
  for (const label of labels) {
    if (!LDH_LABEL.test(label)) {
      return { ok: false, reason: `"${clip(ascii)}" has a label that is not a valid DNS label` };
    }
  }
  if (!TLD.test(labels[labels.length - 1] as string)) {
    // Also what refuses an IP literal: `1.2.3.4` parses as four labels whose
    // last one is numeric, and an address does not publish TXT records.
    return { ok: false, reason: `"${clip(ascii)}" does not end in a domain suffix` };
  }
  return { ok: true, name: ascii };
}

/** Longest DKIM selector accepted; the RFC bounds the name, not the selector. */
const MAX_SELECTOR_LENGTH = 100;

/**
 * Canonicalise a DKIM selector.
 *
 * A selector is `sub-domain *("." sub-domain)` (RFC 6376 section 3.1), so
 * dots are legal and the whole thing becomes part of a name this package
 * queries. That makes it caller-controlled input on a DNS name, which is a
 * channel: the label grammar and the length cap hold it to the shape a
 * selector actually has, and the domain it is attached to is allow-listed
 * separately, so reaching a resolver the operator does not run takes their
 * own domain first.
 */
export function normalizeSelector(raw: string): NormalizedName {
  const trimmed = raw.trim().replace(/\.$/, "").toLowerCase();
  if (trimmed === "") return { ok: false, reason: "the selector is empty" };
  if (trimmed.length > MAX_SELECTOR_LENGTH) {
    return {
      ok: false,
      reason: `selector "${clip(trimmed)}" is longer than ${MAX_SELECTOR_LENGTH} characters`,
    };
  }
  for (const label of trimmed.split(".")) {
    if (!LDH_LABEL.test(label)) {
      return {
        ok: false,
        reason: `selector "${clip(trimmed)}" is not a DKIM selector (letters, digits, hyphens and dots)`,
      };
    }
  }
  return { ok: true, name: trimmed };
}

/** Keep a refusal readable, and keep an over-long value out of a transcript. */
function clip(text: string): string {
  const oneLine = text.replace(/[\r\n\t]/g, " ");
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

/**
 * One TXT record from its character-strings.
 *
 * DNS splits a TXT record into chunks of at most 255 octets and a reader
 * MUST concatenate them with nothing in between (RFC 7208 section 3.3, RFC
 * 6376 section 3.6.2.1). Joining with a space - or reading only the first
 * chunk - is the classic way to mis-read a DKIM record, because an RSA key
 * is always longer than 255 characters and so is ALWAYS split.
 */
export function joinTxtChunks(chunks: readonly string[]): string {
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// SPF
// ---------------------------------------------------------------------------

export type SpfMechanism = {
  /** `+`, `-`, `~` or `?`. Absent in the record means `+` (RFC 7208 4.6.2). */
  readonly qualifier: "+" | "-" | "~" | "?";
  readonly kind: string;
  readonly value?: string;
};

export type SpfModifier = { readonly name: string; readonly value: string };

export type SpfRecord = {
  readonly record: string;
  readonly mechanisms: readonly SpfMechanism[];
  readonly modifiers: readonly SpfModifier[];
  /** The `all` mechanism as written, e.g. `-all`. Null when there is none. */
  readonly all: string | null;
  /**
   * DNS-querying terms in THIS record. A lower bound on the RFC 7208 4.6.4
   * limit of ten, never the total: that limit counts the whole evaluation,
   * including everything each `include:` pulls in.
   */
  readonly dnsTermsHere: number;
  readonly notes: readonly string[];
};

export type SpfAnswer =
  | { readonly status: "found"; readonly parsed: SpfRecord }
  | { readonly status: "absent" }
  | { readonly status: "multiple"; readonly records: readonly string[] }
  | { readonly status: "unreadable"; readonly record: string; readonly reason: string };

/** Terms that cost one of the ten DNS lookups RFC 7208 4.6.4 allows. */
const SPF_DNS_MECHANISMS: ReadonlySet<string> = new Set(["include", "a", "mx", "ptr", "exists"]);

const SPF_MECHANISMS: ReadonlySet<string> = new Set([
  "all",
  "include",
  "a",
  "mx",
  "ptr",
  "ip4",
  "ip6",
  "exists",
]);

/** `v=spf1` then whitespace or nothing - RFC 7208 4.5, case-insensitive. */
function isSpfRecord(record: string): boolean {
  if (record.slice(0, 6).toLowerCase() !== "v=spf1") return false;
  const next = record.charAt(6);
  return next === "" || next === " " || next === "\t";
}

/**
 * Pick the domain's SPF record out of its TXT records and parse it.
 *
 * Two records is not "the first one wins": RFC 7208 4.5 says a receiver
 * returns permerror, which means every sender fails, which is worse than
 * publishing nothing. So it is its own answer rather than a note on one of
 * them.
 */
export function parseSpf(records: readonly string[]): SpfAnswer {
  const spf = records.filter(isSpfRecord);
  if (spf.length === 0) return { status: "absent" };
  if (spf.length > 1) return { status: "multiple", records: [...spf].sort() };
  const record = spf[0] as string;

  const mechanisms: SpfMechanism[] = [];
  const modifiers: SpfModifier[] = [];
  const notes: string[] = [];
  let all: string | null = null;
  let dnsTermsHere = 0;
  let sawAllAt = -1;

  const terms = record.split(/[ \t]+/).filter((term) => term !== "");
  for (const [index, term] of terms.entries()) {
    if (index === 0) continue; // the version token
    // A modifier is `name=value` and carries no qualifier, so its shape is
    // tested first; a mechanism can only reach this point with a `:` or `/`.
    const modifier = /^([A-Za-z][A-Za-z0-9_.-]*)=(.*)$/.exec(term);
    if (modifier !== null) {
      modifiers.push({ name: (modifier[1] as string).toLowerCase(), value: modifier[2] as string });
      continue;
    }
    const mechanism = /^([+\-~?])?([A-Za-z][A-Za-z0-9]*)(?:[:/](.*))?$/.exec(term);
    if (mechanism === null) {
      return {
        status: "unreadable",
        record,
        reason: `"${clip(term)}" is neither a mechanism nor a modifier, so a receiver returns permerror for this record`,
      };
    }
    const kind = (mechanism[2] as string).toLowerCase();
    if (!SPF_MECHANISMS.has(kind)) {
      return {
        status: "unreadable",
        record,
        reason: `"${clip(term)}" is not an SPF mechanism, so a receiver returns permerror for this record`,
      };
    }
    const qualifier = (mechanism[1] as SpfMechanism["qualifier"] | undefined) ?? "+";
    const rawValue = mechanism[3];
    mechanisms.push({
      qualifier,
      kind,
      ...(rawValue !== undefined && rawValue !== "" ? { value: rawValue } : {}),
    });
    if (SPF_DNS_MECHANISMS.has(kind)) dnsTermsHere += 1;
    if (kind === "all" && all === null) {
      all = `${qualifier}all`;
      sawAllAt = mechanisms.length - 1;
    }
  }

  const redirect = modifiers.find((m) => m.name === "redirect");
  if (redirect !== undefined && all === null) dnsTermsHere += 1;

  if (all === null && redirect === undefined) {
    notes.push(
      "the record has neither an all mechanism nor a redirect modifier, so a sender it does not list gets neutral - the same result as no policy at all",
    );
  }
  if (all !== null && redirect !== undefined) {
    notes.push(
      "the record carries both an all mechanism and a redirect modifier; RFC 7208 6.1 says redirect is ignored when all is present, so the redirect has no effect",
    );
  }
  if (sawAllAt >= 0 && sawAllAt < mechanisms.length - 1) {
    notes.push(
      "mechanisms appear after all; evaluation stops at the first match, so those terms are never reached",
    );
  }
  if (mechanisms.some((m) => m.kind === "ptr")) {
    notes.push("the record uses ptr, which RFC 7208 5.5 deprecates and some receivers ignore");
  }
  if (dnsTermsHere > 10) {
    notes.push(
      `this record alone carries ${dnsTermsHere} DNS-querying terms, over the limit of ten in RFC 7208 4.6.4 - a receiver returns permerror before it reaches the end`,
    );
  }

  return {
    status: "found",
    parsed: { record, mechanisms, modifiers, all, dnsTermsHere, notes },
  };
}

// ---------------------------------------------------------------------------
// tag-value records (DMARC, DKIM)
// ---------------------------------------------------------------------------

export type Tags = Readonly<Record<string, string>>;

export type TagParse =
  | { readonly ok: true; readonly tags: Tags; readonly order: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A `tag=value; tag=value` record (RFC 6376 section 3.2, which DMARC reuses).
 *
 * Whitespace around a tag and its value is not part of either, an empty
 * segment after the last `;` is legal, and a repeated tag makes the record
 * invalid rather than "last one wins" - which is why a repeat is reported
 * instead of silently resolved.
 */
export function parseTagValue(record: string): TagParse {
  const tags: Record<string, string> = {};
  const order: string[] = [];
  for (const segment of record.split(";")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      return { ok: false, reason: `"${clip(trimmed)}" is not a tag=value pair` };
    }
    const name = trimmed.slice(0, eq).trim().toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, reason: `"${clip(name)}" is not a tag name` };
    }
    if (Object.hasOwn(tags, name)) {
      return {
        ok: false,
        reason: `the tag "${name}" appears more than once, which makes the record invalid`,
      };
    }
    tags[name] = trimmed.slice(eq + 1).trim();
    order.push(name);
  }
  return { ok: true, tags, order };
}

// ---------------------------------------------------------------------------
// DMARC
// ---------------------------------------------------------------------------

export type DmarcRecord = {
  readonly record: string;
  readonly tags: Tags;
  /** The requested policy, verbatim. `null` when the record omits `p=`. */
  readonly policy: string | null;
  readonly subdomainPolicy: string | null;
  /** `pct=` as written; absent means 100 (RFC 7489 section 6.3). */
  readonly percent: string | null;
  readonly notes: readonly string[];
};

export type DmarcAnswer =
  | { readonly status: "found"; readonly parsed: DmarcRecord }
  | { readonly status: "absent" }
  | { readonly status: "multiple"; readonly records: readonly string[] }
  | { readonly status: "unreadable"; readonly record: string; readonly reason: string };

const DMARC_POLICIES: ReadonlySet<string> = new Set(["none", "quarantine", "reject"]);

/** `v=DMARC1` must be the FIRST tag - RFC 7489 6.6.3 discards anything else. */
function isDmarcRecord(record: string): boolean {
  const first = record.split(";")[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return false;
  return (
    first.slice(0, eq).trim().toLowerCase() === "v" &&
    first
      .slice(eq + 1)
      .trim()
      .toUpperCase() === "DMARC1"
  );
}

export function parseDmarc(records: readonly string[]): DmarcAnswer {
  const candidates = records.filter(isDmarcRecord);
  if (candidates.length === 0) return { status: "absent" };
  // RFC 7489 6.6.3: more than one DMARC1 record and the domain is treated as
  // having published NO policy. Reporting the first would describe a policy
  // no receiver applies.
  if (candidates.length > 1) return { status: "multiple", records: [...candidates].sort() };
  const record = candidates[0] as string;

  const parsed = parseTagValue(record);
  if (!parsed.ok) return { status: "unreadable", record, reason: parsed.reason };
  const tags = parsed.tags;
  const notes: string[] = [];

  const rawPolicy = tags["p"];
  const policy = rawPolicy === undefined ? null : rawPolicy.toLowerCase();
  if (policy === null) {
    notes.push(
      "the record has no p= tag, which RFC 7489 6.3 requires - a receiver discards the record, so this domain has no DMARC policy in practice",
    );
  } else if (!DMARC_POLICIES.has(policy)) {
    notes.push(
      `p=${clip(policy)} is not one of none, quarantine or reject, so a receiver ignores it`,
    );
  } else if (policy === "none") {
    notes.push(
      "p=none asks receivers to take no action on a failing message; it reports, it does not protect",
    );
  }

  const percent = tags["pct"] ?? null;
  if (percent !== null && percent !== "100") {
    notes.push(`pct=${clip(percent)} applies the policy to that share of failing mail only`);
  }
  if (tags["rua"] === undefined && tags["ruf"] === undefined) {
    notes.push("no rua= or ruf= address, so nobody receives the reports this policy generates");
  }

  const subdomain = tags["sp"];
  return {
    status: "found",
    parsed: {
      record,
      tags,
      policy,
      subdomainPolicy: subdomain === undefined ? null : subdomain.toLowerCase(),
      percent,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// DKIM key records
// ---------------------------------------------------------------------------

export type DkimKey =
  | { readonly kind: "rsa"; readonly bits: number }
  | { readonly kind: "ed25519"; readonly bytes: number }
  | { readonly kind: "unreadable"; readonly reason: string };

export type DkimRecord = {
  readonly record: string;
  readonly tags: Tags;
  /** `k=`, defaulting to rsa as RFC 6376 section 3.6.1 does. */
  readonly keyType: string;
  /**
   * True when `p=` is present and empty, which RFC 6376 3.6.1 defines as a
   * REVOKED key - a different fact from a selector that was never published.
   */
  readonly revoked: boolean;
  readonly key: DkimKey | null;
  readonly notes: readonly string[];
};

export type DkimAnswer =
  | { readonly status: "found"; readonly parsed: DkimRecord }
  | { readonly status: "absent" }
  | { readonly status: "multiple"; readonly records: readonly string[] }
  | { readonly status: "unreadable"; readonly record: string; readonly reason: string };

/** Base64 as the grammar defines it, before any decoder is handed the value. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Folding whitespace, which RFC 6376 3.2 allows inside a tag value. */
const FWS = /[ \t\r\n]/g;

/**
 * What the key in a DKIM record IS - never whether a signature verifies.
 *
 * The distinction is worth keeping in the type: a 512-bit key and a revoked
 * one are facts about the record that a receiver acts on, while "this
 * message's signature is good" needs canonicalisation, header selection and
 * body hashing this package does not implement. A half-built verifier that
 * can answer "pass" is worse than no verifier.
 */
export function inspectDkimKey(keyType: string, rawP: string): DkimKey {
  // The STRIPPED value is what gets decoded, and it is the same value the
  // base64 grammar was checked against - checking one spelling and decoding
  // another is how a record that is not base64 reaches a parser anyway.
  const p = rawP.replace(FWS, "");
  if (!BASE64.test(p)) {
    return { kind: "unreadable", reason: "the p= tag is not base64" };
  }
  const bytes = Buffer.from(p, "base64");
  if (bytes.byteLength === 0) {
    return { kind: "unreadable", reason: "the p= tag decoded to no bytes" };
  }
  if (keyType === "ed25519") {
    // RFC 8463 section 3: an ed25519 key is the RAW 32-byte public key, not
    // a SubjectPublicKeyInfo - handing it to an SPKI parser would report a
    // perfectly good published key as unreadable.
    return bytes.byteLength === 32
      ? { kind: "ed25519", bytes: bytes.byteLength }
      : {
          kind: "unreadable",
          reason: `an ed25519 key is 32 bytes; this one is ${bytes.byteLength}`,
        };
  }
  if (keyType !== "rsa") {
    return {
      kind: "unreadable",
      reason: `k=${clip(keyType)} is a key type this tool does not read`,
    };
  }
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    const bits = key.asymmetricKeyDetails?.modulusLength;
    if (key.asymmetricKeyType !== "rsa" || typeof bits !== "number") {
      return {
        kind: "unreadable",
        reason: `the p= tag holds a ${String(key.asymmetricKeyType)} key, but the record says k=rsa`,
      };
    }
    return { kind: "rsa", bits };
  } catch {
    return {
      kind: "unreadable",
      reason: "the p= tag is not a SubjectPublicKeyInfo an RSA key can be read from",
    };
  }
}

export function parseDkim(records: readonly string[]): DkimAnswer {
  if (records.length === 0) return { status: "absent" };
  // A selector holds exactly one key record. Two is a misconfiguration a
  // receiver resolves by trying each, so both are reported rather than one
  // being picked.
  if (records.length > 1) return { status: "multiple", records: [...records].sort() };
  const record = records[0] as string;

  const parsed = parseTagValue(record);
  if (!parsed.ok) return { status: "unreadable", record, reason: parsed.reason };
  const tags = parsed.tags;
  const notes: string[] = [];

  const version = tags["v"];
  if (version !== undefined && version.toUpperCase() !== "DKIM1") {
    return {
      status: "unreadable",
      record,
      reason: `v=${clip(version)} is not a DKIM key record; RFC 6376 3.6.1 requires v=DKIM1 when the tag is present`,
    };
  }
  const keyType = (tags["k"] ?? "rsa").toLowerCase();
  const rawP = tags["p"];
  if (rawP === undefined) {
    notes.push(
      "the record has no p= tag, so it names no key and nothing signed with this selector can be checked against it",
    );
  }
  const revoked = rawP !== undefined && rawP.replace(FWS, "") === "";
  if (revoked) {
    notes.push(
      "p= is present and empty, which RFC 6376 3.6.1 defines as a revoked key - the selector exists and deliberately signs nothing",
    );
  }
  if ((tags["t"] ?? "").split(":").includes("y")) {
    notes.push(
      "t=y puts the selector in testing mode, which tells receivers to treat a failed signature as if the message were unsigned",
    );
  }

  const key = rawP === undefined || revoked ? null : inspectDkimKey(keyType, rawP);
  if (key !== null && key.kind === "rsa" && key.bits < 1024) {
    notes.push(
      `the key is ${key.bits} bits; RFC 8301 sets the floor for signing at 1024 and recommends 2048`,
    );
  }

  return { status: "found", parsed: { record, tags, keyType, revoked, key, notes } };
}

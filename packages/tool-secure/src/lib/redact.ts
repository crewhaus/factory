/**
 * Turning findings into removed text, and values into stable tokens.
 *
 * ## Two token schemes, with different properties
 *
 * KEYED (`derivePseudonym`) — `HMAC-SHA256(key, "<type>:<canonical>")`,
 * truncated. The same value yields the same token in every document the same
 * key is used for, so records can still be joined; without the key the token
 * cannot be walked back to the value even by someone who guesses it, because
 * the attacker cannot compute candidate tokens. This is the scheme to use.
 *
 * UNKEYED (`digestPseudonym`) — a plain SHA-256 prefix. Stable and
 * convenient, and NOT unlinkable: an identifier space small enough to
 * enumerate (every email at a company, every US SSN) can be exhaustively
 * hashed and matched against the tokens. It is offered because a caller
 * sometimes genuinely wants a content-addressed label, and it is labelled
 * `reversibleByEnumeration: true` in every result that uses it so nobody
 * mistakes it for anonymization.
 *
 * ## Truncation
 *
 * Tokens are truncated to keep documents readable. Truncation costs
 * collision resistance: at n hex characters two different values collide
 * with probability ~1 in 16^n. The default of 12 (48 bits) is comfortable
 * for a document-sized corpus; the length is reported so a caller working at
 * dataset scale can raise it.
 */
import { createHash, createHmac } from "node:crypto";
import { type Finding, applySpans, compareStrings } from "./text";

/** Bounds the mapping tools: a mapping is a document, not a database. */
export const MAX_MAPPING_ENTRIES = 5_000;
/** Bounds the alternation a mapping compiles to. */
export const MAX_MAPPING_KEY_CHARS = 200_000;

export class MappingError extends Error {
  override readonly name = "MappingError";
}

/** Keyed, unlinkable-without-the-key token material. */
export function derivePseudonym(key: string, type: string, canonical: string, length = 12): string {
  const digest = createHmac("sha256", key).update(`${type}:${canonical}`, "utf8").digest("hex");
  return digest.slice(0, Math.max(4, Math.min(64, length)));
}

/** Unkeyed, content-addressed token. Reversible by enumeration — see above. */
export function digestPseudonym(type: string, canonical: string, length = 12): string {
  const digest = createHash("sha256").update(`${type}:${canonical}`, "utf8").digest("hex");
  return digest.slice(0, Math.max(4, Math.min(64, length)));
}

/** `[EMAIL]`-style placeholder for a finding type. */
export function placeholderFor(type: string): string {
  return `[${type.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}]`;
}

/** `[EMAIL:9f2b…]`-style pseudonym placeholder. */
export function pseudonymPlaceholder(type: string, token: string): string {
  return `[${type.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}:${token}]`;
}

/** Anything this package emits as a token, for spotting leftovers. */
export const TOKEN_SHAPE = /\[[A-Z0-9_]+(?::[0-9a-f]{4,64})?\]/g;

/** Replace every finding with `replace(finding)`; spans must not overlap. */
export function redactFindings(
  text: string,
  findings: ReadonlyArray<Finding>,
  replace: (finding: Finding) => string,
): string {
  return applySpans(text, findings, replace);
}

/** Escape a literal for embedding in a regular expression. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type MappingApplication = {
  readonly text: string;
  /** Replacements per mapping key, sorted by key. Zero-count keys included. */
  readonly counts: Record<string, number>;
  readonly total: number;
};

/**
 * Replace each key of `mapping` with its value, longest key first.
 *
 * Longest-first matters: with `{"Ann": "P1", "Anna": "P2"}` a shortest-first
 * pass would turn "Anna" into "P1a". The pass is single, so a replacement's
 * own text is never rescanned and tokens cannot cascade.
 *
 * `wholeWord` anchors each key between word boundaries, which is what you
 * want for names and what you do NOT want for email addresses.
 */
export function applyMapping(
  text: string,
  mapping: Readonly<Record<string, string>>,
  wholeWord = false,
): MappingApplication {
  const keys = Object.keys(mapping);
  if (keys.length > MAX_MAPPING_ENTRIES) {
    throw new MappingError(
      `mapping has ${keys.length} entries, over the ${MAX_MAPPING_ENTRIES} limit — split the dataset`,
    );
  }
  const totalKeyChars = keys.reduce((sum, key) => sum + key.length, 0);
  if (totalKeyChars > MAX_MAPPING_KEY_CHARS) {
    throw new MappingError(
      `mapping keys total ${totalKeyChars} characters, over the ${MAX_MAPPING_KEY_CHARS} limit`,
    );
  }
  const counts: Record<string, number> = {};
  for (const key of [...keys].sort(compareStrings)) counts[key] = 0;
  const empty = keys.filter((key) => key.length === 0);
  if (empty.length > 0) throw new MappingError("mapping contains an empty key");
  if (keys.length === 0) return { text, counts, total: 0 };

  const ordered = [...keys].sort((a, b) => b.length - a.length || compareStrings(a, b));
  const body = ordered.map(escapeRegex).join("|");
  const source = wholeWord ? `(?<![\\w])(?:${body})(?![\\w])` : `(?:${body})`;
  const re = new RegExp(source, "g");
  let total = 0;
  const out = text.replace(re, (match) => {
    const replacement = mapping[match];
    if (replacement === undefined) return match;
    counts[match] = (counts[match] ?? 0) + 1;
    total += 1;
    return replacement;
  });
  return { text: out, counts, total };
}

/** Flip a mapping, refusing a value used for two different keys. */
export function invertMapping(mapping: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(mapping).sort(compareStrings)) {
    const token = mapping[key];
    if (token === undefined) continue;
    const existing = out[token];
    if (existing !== undefined && existing !== key) {
      throw new MappingError(
        `token "${token}" maps to both "${existing}" and "${key}" — a mapping must be invertible to be rejoinable`,
      );
    }
    out[token] = key;
  }
  return out;
}

/**
 * Credential hygiene for everything the server serializes. Composes the two
 * `@crewhaus/spec-patch` layers — key-based redaction (`isCredentialKey`)
 * and value-shape masking (`maskCredentialTokens`) — into helpers for JSON
 * trees and raw YAML text. Env VALUES are never serialized at all (routes
 * emit presence booleans); these helpers are the second line of defense for
 * spec text, transcripts, and tool payloads.
 */
import { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";

/**
 * Mask a JSON tree: values under credential-naming keys are replaced
 * wholesale; every other string is token-shape masked. Arrays/objects are
 * walked; non-string scalars pass through.
 *
 * **Naming hazard — read before adding a response field.** Redaction is by
 * KEY NAME: `isCredentialKey` matches an exact `key` and any camel-case
 * `…Key` / `…Token` / `…Secret` / `…Password`. It cannot tell a secret from
 * a field that merely rhymes with one, and it is applied to EVERY payload
 * this server serves — so a perfectly innocent field name silently becomes
 * `"[redacted]"` with no error and no warning.
 *
 * Six independent M3 areas each lost time to this: `sessionKey` (a routing
 * mode), `filterKey`, `idempotencyKey`, and a bare `key` on a table cell all
 * vanished from their payloads. The convention that works is to NAME AROUND
 * it — `sessionKeyMode`, `filterParam`, `idempotency`, `name` — rather than
 * to widen the matcher, because every exemption is a place a real credential
 * could later hide. If a field must keep a credential-shaped name, prove it
 * carries no secret and add it to a scoped allowlist next to its own reader,
 * never to a global one.
 */
export function maskDeep(value: unknown): unknown {
  return maskTree(value, false);
}

function maskTree(value: unknown, underCredentialKey: boolean): unknown {
  if (typeof value === "string") {
    return underCredentialKey ? REDACTED_VALUE : maskCredentialTokens(value);
  }
  if (Array.isArray(value)) return value.map((v) => maskTree(v, underCredentialKey));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskTree(v, underCredentialKey || isCredentialKey(k));
    }
    return out;
  }
  return value;
}

/** Mask one free-text document (a transcript chunk, a memory fact, a wiki
 *  body, a continuity note). Key-based redaction does not apply to prose, so
 *  this is value-shape masking only — the same pass `maskDeep` gives every
 *  string it walks. */
export function maskText(text: string): string {
  return maskCredentialTokens(text);
}

/** A `$UPPER_SNAKE` env REFERENCE — a name, not a value; safe to show. */
const ENV_REF_VALUE_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

const YAML_SCALAR_LINE_RE = /^([ \t]*(?:- )?)([A-Za-z0-9_.-]+):([ \t]*)(.*)$/;

/**
 * Spec keys that LOOK credential-shaped to `isCredentialKey` (which matches a
 * trailing `Key`/`Token`/`Secret`/`Password`) but carry no secret.
 *
 * `sessionKey` is the one that bit: it selects a channel's session-routing
 * MODE — `thread` | `channel` | `user` — so redacting it hid a routing
 * decision from every channel harness's spec view while protecting nothing.
 *
 * Keep this list tiny and evidence-driven. A wrong entry here leaks a
 * credential, which is far worse than the over-redaction it cures.
 */
const NON_CREDENTIAL_SPEC_KEYS: ReadonlySet<string> = new Set(["sessionKey"]);

/**
 * Redaction placeholder, YAML-QUOTED.
 *
 * `[redacted]` unquoted is a flow SEQUENCE — a bare `botToken: [redacted]`
 * re-parses as a one-item list, so the masked document no longer has the
 * shape the original did. Quoting keeps a redacted scalar a scalar.
 */
const REDACTED_YAML_SCALAR = `"${REDACTED_VALUE}"`;

/**
 * Mask a YAML spec text line-by-line without parsing it (the spec may not
 * parse — masking must still hold). A scalar under a credential-naming key
 * is redacted unless it is a `$VAR` env reference (a name the operator needs
 * to see) or a known non-secret key; every line additionally passes the
 * token-shape masker so a credential pasted into prose or a non-credential
 * key never survives.
 */
export function maskSpecYaml(yamlText: string): string {
  const lines = yamlText.split("\n").map((line) => {
    const m = line.match(YAML_SCALAR_LINE_RE);
    if (m !== null) {
      const [, indent = "", key = "", gap = "", rest = ""] = m;
      const value = rest.trim();
      if (
        value !== "" &&
        !value.startsWith("#") &&
        isCredentialKey(key) &&
        !NON_CREDENTIAL_SPEC_KEYS.has(key) &&
        !ENV_REF_VALUE_RE.test(stripQuotes(value))
      ) {
        return `${indent}${key}:${gap === "" ? " " : gap}${REDACTED_YAML_SCALAR}`;
      }
    }
    return maskCredentialTokens(line);
  });
  return lines.join("\n");
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

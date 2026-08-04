/**
 * Credential hygiene for everything the server serializes. Composes the two
 * `@crewhaus/spec-patch` layers — key-based redaction (`isCredentialKey`)
 * and value-shape masking (`maskCredentialTokens`) — into helpers for JSON
 * trees and raw YAML text. Env VALUES are never serialized at all (routes
 * emit presence booleans); these helpers are the second line of defense for
 * spec text, transcripts, and tool payloads.
 */
import { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";

/** Mask a JSON tree: values under credential-naming keys are replaced
 *  wholesale; every other string is token-shape masked. Arrays/objects are
 *  walked; non-string scalars pass through. */
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

/** A `$UPPER_SNAKE` env REFERENCE — a name, not a value; safe to show. */
const ENV_REF_VALUE_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

const YAML_SCALAR_LINE_RE = /^([ \t]*(?:- )?)([A-Za-z0-9_.-]+):([ \t]*)(.*)$/;

/**
 * Mask a YAML spec text line-by-line without parsing it (the spec may not
 * parse — masking must still hold). A scalar under a credential-naming key
 * is redacted unless it is a `$VAR` env reference (a name the operator needs
 * to see); every line additionally passes the token-shape masker so a
 * credential pasted into prose or a non-credential key never survives.
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
        !ENV_REF_VALUE_RE.test(stripQuotes(value))
      ) {
        return `${indent}${key}:${gap === "" ? " " : gap}${REDACTED_VALUE}`;
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

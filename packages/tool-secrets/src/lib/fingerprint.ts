/**
 * What a caller is allowed to learn about a secret it is not allowed to see.
 *
 * A tool result is read by a model, and from there it lands in a transcript,
 * a trace, a log and somebody's clipboard. So nothing in this package returns
 * a secret value — not on success, not in an error, not in a diff. What a
 * caller gets instead is enough to answer the three questions that actually
 * come up:
 *
 *   - does the reference resolve, and from where?  → `backend` + `source`
 *   - is this the same secret as that one?         → `fingerprint`
 *   - did it change when I rotated it?             → `fingerprint`, again
 *
 * The fingerprint is the first 12 hex characters of a domain-separated
 * SHA-256. Domain separation (a fixed prefix and a NUL) means the digest is
 * not the same number as `sha256sum` of the same value, so a fingerprint that
 * escapes into a log cannot be looked up in a table of digests somebody
 * computed for another purpose. Truncation to 48 bits is deliberate: it is far
 * more than enough to tell two credentials apart or to notice a rotation
 * (a collision needs ~16.7M distinct values before it is even likely), and it
 * leaves nothing like a full digest to attack offline.
 *
 * What it is NOT: a way to hide a LOW-ENTROPY secret. A four-digit PIN or a
 * dictionary password can be confirmed against its own fingerprint by anyone
 * who can guess it, and `length` narrows the guessing. These tools are for
 * high-entropy credentials — API keys, tokens, generated passwords — and the
 * README says so in the same words.
 */
import { createHash } from "node:crypto";

/**
 * Domain separator. The NUL is what makes the prefix unambiguous: without it
 * `prefix + "ab"` and `prefix + "a" + "b"` would be the same bytes.
 */
const DOMAIN = "crewhaus.tool-secrets.fingerprint.v1\0";

/** Hex characters kept. 12 hex = 48 bits. */
const KEEP = 12;

/** A non-reversible handle for a value, stable across machines and runs. */
export function fingerprint(value: string): string {
  const digest = createHash("sha256").update(DOMAIN).update(value, "utf8").digest("hex");
  return `sha256:${digest.slice(0, KEEP)}`;
}

/**
 * The shape of a value, in the terms that diagnose a broken credential
 * without describing it.
 *
 * `trailingNewline` earns its place: `$(cat secret.txt)` in one place and
 * `readFile` in another differ by exactly one byte, the header that carries it
 * is rejected by the provider, and the operator cannot see why because the
 * value "looks right" everywhere they print it. Reporting it is the whole
 * reason someone reaches for this tool a second time.
 */
export type ValueShape = {
  readonly fingerprint: string;
  readonly length: number;
  readonly empty: boolean;
  readonly trailingNewline: boolean;
  readonly leadingOrTrailingSpace: boolean;
};

export function describeValue(value: string): ValueShape {
  const trimmed = value.replace(/[\r\n]+$/, "");
  return {
    fingerprint: fingerprint(value),
    length: value.length,
    empty: value === "",
    trailingNewline: trimmed !== value,
    // Checked on the newline-stripped form so a trailing newline is reported
    // once, as itself, rather than twice as "whitespace" as well.
    leadingOrTrailingSpace: trimmed !== trimmed.trim(),
  };
}

/**
 * Remove any occurrence of a secret from text that is about to be reported.
 *
 * Helpers do echo values back: `pass` prints the whole entry when an operator
 * mistypes a subcommand, and a backend that fails after generating can put the
 * new value in its own error message. Every diagnostic this package reports
 * passes through here first, with the values it knows about, so one careless
 * helper cannot undo the rule the rest of the package keeps.
 *
 * Short values are skipped: redacting a two-character "secret" would black out
 * half of every message and tell the reader nothing.
 */
export function stripValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value.length < 4) continue;
    out = out.split(value).join("<redacted>");
  }
  return out;
}

/** First line only, capped — a helper's complaint, not its manual. */
export function firstLine(text: string, cap = 200): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  const line = nl === -1 ? trimmed : trimmed.slice(0, nl);
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

/**
 * The spec's Section-12 secret grammar, mirrored structurally.
 *
 * The compiler lowers secret-carrying spec strings at `lower()` time:
 * `$UPPER_SNAKE` becomes an env-var reference, anything else stays a
 * literal — and for *credential-shaped* fields (channel tokens, signing
 * secrets, `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` MCP env keys, the
 * `Authorization`/`x-api-key` headers) a value that starts with `$` but is
 * NOT a valid reference fails compilation outright, because it is almost
 * always a typo'd env ref that would otherwise ship a broken credential.
 *
 * This module duplicates that tiny grammar deliberately — the same stance
 * `@crewhaus/mcp-host` takes for its structural `IrSecretRef` mirror — so
 * the preflight package can predict boot behaviour from a raw parsed spec
 * without a dependency on the whole compiler. TypeScript's structural
 * typing keeps `SecretRef` interchangeable with the IR's `IrSecretRef` and
 * mcp-host's `McpSecretRef` at every call site. Keep the regexes in
 * lockstep with the compiler's `lowerSecret`/`lowerCredential` and
 * mcp-host's G75 lint.
 */

/** Structural mirror of the IR's secret-ref shape. */
export type SecretRef =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "env"; readonly name: string };

/** A valid spec env reference: `$UPPER_SNAKE` (no braces, no lowercase). */
export const ENV_REF_RE = /^\$([A-Z_][A-Z0-9_]*)$/;

/**
 * A string that still LOOKS like a shell variable (`$FOO` or `${FOO}`, any
 * case) — mcp-host's G75 lint shape. The MCP transports never expand these,
 * so a literal of this shape is shipped verbatim and fails only at runtime
 * auth.
 */
export const UNPARSED_ENV_REF_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

/** MCP env keys / header names whose values carry credentials — the strict
 *  (fail-compile-on-malformed-`$`) lowering applies to these. */
export const CREDENTIAL_SHAPED_KEY_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
export const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set(["authorization", "x-api-key"]);

/** Permissive lowering: `$UPPER_SNAKE` → env ref, anything else → literal.
 *  Mirrors the compiler's `lowerSecret`. */
export function lowerSecretString(raw: string): SecretRef {
  const m = raw.match(ENV_REF_RE);
  if (m && typeof m[1] === "string") return { kind: "env", name: m[1] };
  return { kind: "literal", value: raw };
}

/**
 * True when a credential-shaped value would FAIL compilation: it starts with
 * `$` but is not a valid `$UPPER_SNAKE` reference (e.g. `$slack_token`,
 * `${SLACK_BOT_TOKEN}`, `$1PASSWORD`). Mirrors `lowerCredential`.
 *
 * Takes `unknown` on purpose. Every caller in this package reads a RAW
 * parsed spec — the artifact that has NOT been validated yet, which is the
 * whole reason preflight exists. A channel block missing a required field,
 * or a YAML scalar the operator forgot to quote (`applicationId: 1234` is a
 * number), must come back as a reported finding; a grammar predicate that
 * throws on it turns the most common spec mistake into a 500 on every route
 * that predicts boot behaviour. Non-strings are not malformed REFERENCES —
 * they are a different fault, and the callers name it themselves.
 */
export function isMalformedEnvRef(raw: unknown): boolean {
  return typeof raw === "string" && raw.startsWith("$") && !ENV_REF_RE.test(raw);
}

/** The compiler's diagnostic for a malformed credential env ref, reproduced
 *  so preflight predicts the exact compile failure. */
export function malformedEnvRefMessage(label: string, raw: string): string {
  return `${label} value ${JSON.stringify(raw)} looks like an environment reference but is not a valid one. Environment references must be $UPPER_SNAKE_CASE (e.g. $SLACK_BOT_TOKEN) — no lowercase, no leading digit, no \${...} braces. Fix the variable name, or remove the leading "$" if this is genuinely a literal value.`;
}

/** Printable form of a secret ref: `$NAME` for env refs (the indirection is
 *  not a secret), `[redacted]` for inline literals. */
export function describeSecretRef(ref: SecretRef): string {
  return ref.kind === "env" ? `$${ref.name}` : "[redacted]";
}

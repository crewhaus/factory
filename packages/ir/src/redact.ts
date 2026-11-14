/**
 * Credential redaction for HUMAN-READABLE renderings of spec/IR content —
 * changelog diff lines (`spec-patch`) and generated bundle READMEs (`ir`).
 * Two layers:
 *
 *   1. `isCredentialKey` — key-based: a value stored under a key that NAMES
 *      a credential (`api_key`, `botToken`, `headers`, `env`, …) is redacted
 *      wholesale, whatever the value looks like.
 *   2. `maskCredentialTokens` — value-based: strings that are NOT under a
 *      credential key (instructions prose, command args, URLs) are scanned
 *      for well-known credential token shapes (`sk-…`, `ghp_…`, `xoxb-…`,
 *      `AKIA…`, CrewHaus's `ch*_…`, `Bearer <token>`) plus high-length opaque
 *      tokens preceded by key-ish context words. Deliberately conservative: a
 *      bare 32-char identifier with no "key/token/secret/password" context is
 *      left alone so normal prose never gets chewed up.
 *   3. `carriesCredential` — a yes/no screen built on both layers: whether a
 *      value (a permission rule's pattern, a command line) carries a
 *      credential, so the caller can refuse to store or show it at all.
 *
 * KEEP IN SYNC: this module is intentionally duplicated as
 * `packages/ir/src/redact.ts` and `packages/spec-patch/src/redact.ts`.
 * `@crewhaus/ir` keeps ZERO package dependencies (its `readme.ts` already
 * mirrors `OUTWARD_TOOL_NAMES` from tool-builder for the same reason) and
 * `spec-patch` is spec-layer infrastructure that must not grow an edge onto
 * the IR layer — so neither package can host the single copy without a new
 * dependency edge. Change one file, change both.
 */

/** Placeholder rendered in place of a value under a credential-carrying key. */
export const REDACTED_VALUE = "[redacted]";

/** Placeholder substituted for a credential-shaped token inside a string. */
export const MASKED_TOKEN = "***";

/**
 * Keys that carry credentials, matched case-insensitively after lowercasing.
 * Aligned with the spec schema's credential carriers (`botToken`,
 * `signingSecret`, `appToken`, `secretToken`, `accessToken`, `appSecret`,
 * `retrieve.apiKey`, wallet `keyRef`) and the compiler's `lowerCredential` /
 * `lowerWalletKeyRef` call sites — see `packages/compiler/src/index.ts` §12.
 * `headers` and `env` are container keys: everything under them redacts.
 */
const CREDENTIAL_KEY_EXACT: ReadonlySet<string> = new Set([
  "key",
  "apikey",
  "api_key",
  "api-key",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "headers",
  "env",
  "keyref",
  "key_ref",
  "key-ref",
  "privatekey",
  "private_key",
  "private-key",
]);

/**
 * Whether a property key names a credential. Suffix matches require a word
 * boundary (snake/kebab/camel) so `api_key` / `botToken` / `GITHUB_TOKEN` /
 * `signingSecret` redact while `monkey` / `max_tokens` don't.
 */
export function isCredentialKey(key: string): boolean {
  const k = key.toLowerCase();
  if (CREDENTIAL_KEY_EXACT.has(k)) return true;
  if (/[_-](?:key|token|secret|password)$/.test(k)) return true;
  return /[a-z0-9](?:Key|Token|Secret|Password)$/.test(key);
}

/** A path segment / standalone word shaped like an opaque credential
 *  (Alchemy/Infura-style `/v2/<key>`): 32+ chars of token alphabet. */
export const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

/** Well-known credential token shapes, masked wherever they appear. */
const TOKEN_SHAPE_RES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI/Anthropic/Stripe-style secret keys
  /\bgh[oprsu]_[A-Za-z0-9]{16,}/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[A-Z0-9]{12,}/g, // AWS access key ids
  /\bch[apsi]_[A-Za-z0-9_-]{43,}/g, // CrewHaus session, personal, service and invite secrets
];

/**
 * A CrewHaus scoped token, `chx_<payload>.<mac>`. Its `.<mac>` is OPTIONAL in the
 * pattern, and only a match that carries it is masked: a run of `chx_` with no mac is
 * then consumed whole and the search resumes after it. With the mac required, a run like
 * `chx_-chx_-…` was rescanned to its end from every `chx_` in it, quadratic in the run.
 * No class spans the dot, so neither part can give characters back to the other.
 */
const SCOPED_TOKEN_RE = /\bchx_[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]{43,})?/g;

/** `Bearer <token>` — the scheme word is kept, the token is masked. */
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * Generic 32+-char opaque token, masked ONLY when preceded by a key-ish
 * context word — `key: XXXX…`, `token=XXXX…` — so hashes/ids in ordinary
 * prose survive. Group 1 (the context) is kept; the token is masked.
 */
const CONTEXTUAL_OPAQUE_RE =
  /\b((?:api[-_ ]?)?(?:key|token|secret|password|credential)s?\b["'\s:=-]{0,5})([A-Za-z0-9+/_-]{32,})/gi;

/**
 * Mask credential-shaped tokens inside a string. Non-credential text is
 * returned unchanged (hit/no-hit cases are unit-tested in both packages).
 */
export function maskCredentialTokens(text: string): string {
  let out = text;
  for (const re of TOKEN_SHAPE_RES) out = out.replace(re, MASKED_TOKEN);
  out = out.replace(SCOPED_TOKEN_RE, (whole: string, mac: string | undefined) =>
    mac === undefined ? whole : MASKED_TOKEN,
  );
  out = out.replace(BEARER_RE, `$1 ${MASKED_TOKEN}`);
  out = out.replace(CONTEXTUAL_OPAQUE_RE, `$1${MASKED_TOKEN}`);
  return out;
}

/**
 * A URL in a value: its scheme through the next space or quote (group 1). A
 * match starts only where a run of scheme characters starts, so each run is
 * scanned once, however long it is.
 */
const URL_IN_TEXT = /(?<![A-Za-z0-9+.-])[0-9+.-]*([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+)/g;
/** `NAME=value`, a variable a command sets. */
const ASSIGNMENT_IN_TEXT = /(?:^|[\s"'])([A-Za-z_][A-Za-z0-9_]*)=[^\s"']/g;
/** `Name: value`, a header line a command sends. */
const HEADER_IN_TEXT = /(?:^|[\s"'])([A-Za-z][A-Za-z0-9-]*)\s*:\s*[^\s/"']/g;

/**
 * Whether a rule value carries a credential: a credential-shaped token anywhere in it
 * (the masker's own shapes), a URL with a password or a query key that names one, or
 * a variable or a header line whose name names one (`isCredentialKey`).
 */
export function carriesCredential(value: string): boolean {
  if (maskCredentialTokens(value) !== value) return true;
  for (const match of value.matchAll(URL_IN_TEXT)) {
    try {
      const url = new URL(match[1] as string);
      if (url.password !== "") return true;
      for (const key of url.searchParams.keys()) if (isCredentialKey(key)) return true;
    } catch {
      // Not a URL the parser reads: the other checks still apply.
    }
  }
  for (const match of value.matchAll(ASSIGNMENT_IN_TEXT)) {
    if (isCredentialKey(match[1] as string)) return true;
  }
  for (const match of value.matchAll(HEADER_IN_TEXT)) {
    if (isCredentialKey(match[1] as string)) return true;
  }
  return false;
}

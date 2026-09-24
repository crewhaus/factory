import { isCredentialShapedName, looksLikePastedSecret } from "./names";

/**
 * Keeping secrets out of what a tool returns: results, refusals, and the
 * text of a remote error.
 *
 * This is the backstop, not the first defence. A credential is placed only
 * in a header, never in a path or a body, but a server that echoes the
 * request, or a 401 that repeats the rejected key, puts it straight back
 * into the transcript (config-delivery#4, security-8#4). Every sibling that
 * handles credentials had grown its own scrubber; these are the shared ones.
 */

/** What a redacted secret is replaced with in text. */
export const REDACTED = "<redacted>";

/**
 * What a redacted URL part is replaced with. Plain letters, so the URL still
 * parses and nothing about it is re-encoded: `https://REDACTED@host/?token=REDACTED`.
 */
export const REDACTED_URL_PART = "REDACTED";

export type RedactOptions = {
  /**
   * Values shorter than this are left alone (default 6). Replacing every
   * `abc` would shred the text without protecting anything: no usable
   * credential is that short.
   */
  readonly minLength?: number;
  /** Replacement (default {@link REDACTED}). */
  readonly placeholder?: string;
};

const DEFAULT_MIN_LENGTH = 6;

/**
 * The spellings a secret takes on the way back: as is, trimmed (a value
 * read from a file often ends in a newline), URL-encoded, base64 and
 * base64url, and JSON-escaped. A composite (a Basic header's
 * `base64(user:secret)`) cannot be derived from the secret alone: pass it
 * as a value of its own.
 */
export function secretForms(value: string): string[] {
  const forms = new Set<string>();
  const add = (form: string): void => {
    if (form !== "") forms.add(form);
  };
  for (const v of new Set([value, value.trim()])) {
    add(v);
    add(encodeURIComponent(v));
    const b64 = Buffer.from(v, "utf8").toString("base64");
    add(b64);
    add(b64.replace(/=+$/, ""));
    add(Buffer.from(v, "utf8").toString("base64url"));
    add(JSON.stringify(v).slice(1, -1));
  }
  return [...forms];
}

/**
 * A function that replaces every known secret value, in each of its
 * {@link secretForms}, with the placeholder. Built once, applied to many
 * strings. Longest forms first, so a secret that contains another is
 * replaced whole. Matching is literal (`split`/`join`): a secret full of
 * regex metacharacters is matched as written.
 */
export function createSecretRedactor(
  values: Iterable<string | undefined>,
  options: RedactOptions = {},
): (text: string) => string {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const placeholder = options.placeholder ?? REDACTED;
  const forms = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length < minLength) continue;
    for (const form of secretForms(value)) if (form.length >= minLength) forms.add(form);
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return (text) => text;
  return (text: string): string => {
    let out = text;
    for (const form of ordered) if (out.includes(form)) out = out.split(form).join(placeholder);
    return out;
  };
}

/** `text` with every known secret value replaced. See {@link createSecretRedactor}. */
export function redactKnownSecrets(
  text: string,
  values: Iterable<string | undefined>,
  options: RedactOptions = {},
): string {
  return createSecretRedactor(values, options)(text);
}

/**
 * Every string inside a JSON-shaped value, keys included, with known secrets
 * replaced. For a tool result object: redacting its `JSON.stringify` text
 * instead can cut an escape sequence in half and leave JSON that no longer
 * parses.
 */
export function redactKnownSecretsDeep<T>(
  value: T,
  values: Iterable<string | undefined>,
  options: RedactOptions = {},
): T {
  const redact = createSecretRedactor(values, options);
  const ancestors = new Set<object>();
  const walk = (input: unknown): unknown => {
    let v = input;
    // What JSON would carry: a Date becomes its ISO string, and so on.
    if (
      v !== null &&
      typeof v === "object" &&
      typeof (v as { toJSON?: unknown }).toJSON === "function"
    ) {
      v = (v as { toJSON: () => unknown }).toJSON();
    }
    if (typeof v === "string") return redact(v);
    if (v === null || typeof v !== "object") return v;
    if (ancestors.has(v)) {
      throw new TypeError(
        "redactKnownSecretsDeep needs a JSON-shaped value; this one contains a cycle",
      );
    }
    ancestors.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        // defineProperty, so a `__proto__` key stays a key instead of
        // replacing the result's prototype.
        Object.defineProperty(out, redact(k), {
          value: walk(inner),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  return walk(value) as T;
}

/**
 * Query and fragment parameters that carry a credential without a
 * credential-shaped name: signed-URL signatures, OAuth authorization codes,
 * session ids.
 */
const URL_CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
  "sig",
  "signature",
  "x-amz-signature",
  "x-goog-signature",
  "code",
  "sid",
  "session",
  "sessionid",
  "session_id",
  "jwt",
]);

function decodeParam(raw: string): string {
  const spaced = raw.split("+").join(" ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced; // a malformed escape: judge the raw spelling
  }
}

/** Whether a URL parameter name marks its value as a credential. */
export function isCredentialParam(name: string): boolean {
  const decoded = decodeParam(name);
  return URL_CREDENTIAL_PARAMS.has(decoded.toLowerCase()) || isCredentialShapedName(decoded);
}

/** `a=1&token=x;b` with each credential parameter's value replaced; separators kept. */
function redactParams(params: string, placeholder: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i <= params.length; i++) {
    const ch = params[i];
    if (i < params.length && ch !== "&" && ch !== ";") continue;
    const pair = params.slice(start, i);
    const eq = pair.indexOf("=");
    if (eq < 0) {
      // A bare `?ghp_…`: no name to judge, so judge the value itself.
      out += looksLikePastedSecret(decodeParam(pair)) ? placeholder : pair;
    } else {
      const secret =
        isCredentialParam(pair.slice(0, eq)) ||
        looksLikePastedSecret(decodeParam(pair.slice(eq + 1)));
      out += secret ? `${pair.slice(0, eq + 1)}${placeholder}` : pair;
    }
    if (i < params.length) out += ch;
    start = i + 1;
  }
  return out;
}

/**
 * A URL with its credentials replaced: the whole userinfo
 * (`https://user:pass@host` and `https://TOKEN@host` alike), and the value
 * of every query or fragment parameter whose name is credential-shaped
 * (`token`, `api_key`, `X-Amz-Signature`, `access_token` in an OAuth
 * fragment). Everything else is left exactly as written, so the result is
 * still the URL the caller recognises. A secret in a PATH segment
 * (`hooks.slack.com/services/…`) is not recognisable by shape: redact it
 * with {@link redactKnownSecrets}.
 */
export function redactUrlCredentials(url: string | URL, placeholder = REDACTED_URL_PART): string {
  const text = typeof url === "string" ? url : url.href;
  let rest = text;
  let head = "";
  const hashAt = rest.indexOf("#");
  let fragment = "";
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  const queryAt = rest.indexOf("?");
  let query: string | undefined;
  if (queryAt >= 0) {
    query = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
  }
  const schemeEnd = rest.indexOf("://");
  if (schemeEnd >= 0 && isScheme(rest.slice(0, schemeEnd))) {
    const authorityStart = schemeEnd + 3;
    // The authority ends at the first `/` (or `\\`, which WHATWG URL
    // parsing treats as `/` for http and https). An `@` further on is in
    // the path, as in an npm URL `/@scope/pkg`, and is not userinfo.
    let authorityEnd = rest.length;
    for (let i = authorityStart; i < rest.length; i++) {
      if (rest[i] === "/" || rest[i] === "\\") {
        authorityEnd = i;
        break;
      }
    }
    const authority = rest.slice(authorityStart, authorityEnd);
    const at = authority.lastIndexOf("@");
    head = rest.slice(0, authorityStart);
    rest =
      at >= 0
        ? `${placeholder}${authority.slice(at)}${rest.slice(authorityEnd)}`
        : rest.slice(authorityStart);
  }
  let out = head + rest;
  if (query !== undefined) out += `?${redactParams(query, placeholder)}`;
  if (hashAt >= 0)
    out += `#${fragment.includes("=") ? redactParams(fragment, placeholder) : fragment}`;
  return out;
}

function isScheme(s: string): boolean {
  if (s.length === 0 || s.length > 32) return false;
  const first = s.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s[i] as string;
    const ok =
      (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9") ||
      c === "+" ||
      c === "." ||
      c === "-";
    if (!ok) return false;
  }
  return true;
}

/** Characters that end a URL embedded in prose, logs or a quoted error. */
function endsUrl(c: string): boolean {
  return (
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === "\r" ||
    c === '"' ||
    c === "'" ||
    c === "`" ||
    c === "<" ||
    c === ">" ||
    c === "\u0000"
  );
}

/**
 * {@link redactUrlCredentials} applied to every `scheme://…` URL inside
 * free text: an error message that quotes the request, a log line. A
 * linear scan, never a backtracking pattern over caller-sized text.
 */
export function redactUrlCredentialsInText(text: string, placeholder = REDACTED_URL_PART): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const sep = text.indexOf("://", from);
    if (sep < 0) break;
    let start = sep;
    while (start > 0 && sep - start < 32 && isScheme(text.slice(start - 1, sep))) start -= 1;
    let end = sep + 3;
    while (end < text.length && !endsUrl(text[end] as string)) end += 1;
    if (start < sep && start >= copied) {
      out += text.slice(copied, start) + redactUrlCredentials(text.slice(start, end), placeholder);
      copied = end;
    }
    from = Math.max(end, sep + 3);
  }
  return out + text.slice(copied);
}

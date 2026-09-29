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
 * A credential sent inside a larger value whose START is not secret: a
 * Basic header's `user:secret`, where `user:` is the account name. Its
 * spellings are redacted whole, like any secret, but the start of one left
 * at a cut counts only once it runs past `publicPrefix`: a result that ends
 * with the account name (a login, an assignee, a URL ending `/users/<name>`)
 * is not a credential and is left alone (net regression review).
 */
export type ComposedSecret = {
  /** The part that is not secret, sent first: `user:` for Basic. */
  readonly publicPrefix: string;
  /** The credential that follows it. */
  readonly secret: string;
};

/** A credential value, as the redactors take it. */
export type SecretValue = string | ComposedSecret;

/** A spelling of a secret, and how many of its leading characters spell only the public prefix. */
type Form = { readonly form: string; readonly publicLength: number };

/**
 * The encodings a secret is echoed in, each with the length its encoding of
 * a public prefix takes at the start of the encoded whole. The character-wise
 * encodings map a prefix to a prefix; base64 fixes one character per six
 * bits, so the characters wholly inside the prefix's bytes are public.
 */
const ENCODINGS: readonly {
  readonly encode: (v: string) => string;
  readonly publicLength: (prefix: string) => number;
}[] = [
  { encode: (v) => v, publicLength: (p) => p.length },
  { encode: (v) => encodeURIComponent(v), publicLength: (p) => encodeURIComponent(p).length },
  { encode: (v) => Buffer.from(v, "utf8").toString("base64"), publicLength: base64PublicLength },
  {
    encode: (v) => Buffer.from(v, "utf8").toString("base64").replace(/=+$/, ""),
    publicLength: base64PublicLength,
  },
  { encode: (v) => Buffer.from(v, "utf8").toString("base64url"), publicLength: base64PublicLength },
  { encode: jsonInner, publicLength: (p) => jsonInner(p).length },
  // `\/` is a legal JSON escape for `/`, and PHP's json_encode and others
  // write every solidus that way; JSON.stringify never does.
  {
    encode: (v) => jsonInner(v).replaceAll("/", "\\/"),
    publicLength: (p) => jsonInner(p).replaceAll("/", "\\/").length,
  },
];

function jsonInner(v: string): string {
  return JSON.stringify(v).slice(1, -1);
}

function base64PublicLength(prefix: string): number {
  return Math.floor((Buffer.byteLength(prefix, "utf8") * 8) / 6);
}

/** Every spelling of `value`, with its public length (0 for a plain secret). */
function spellingsOf(value: SecretValue): Form[] {
  const prefix = typeof value === "string" ? "" : value.publicPrefix;
  const secret = typeof value === "string" ? value : value.secret;
  const out = new Map<string, number>();
  for (const s of new Set([secret, secret.trim()])) {
    for (const { encode, publicLength } of ENCODINGS) {
      let form: string;
      let pub: number;
      try {
        form = encode(prefix + s);
        pub = prefix === "" ? 0 : publicLength(prefix);
      } catch {
        continue; // a lone surrogate cannot be URL-encoded; the other spellings still count
      }
      if (form === "" || form.length <= pub) continue;
      const seen = out.get(form);
      out.set(form, seen === undefined ? pub : Math.min(seen, pub));
    }
  }
  return [...out].map(([form, publicLength]) => ({ form, publicLength }));
}

/**
 * The spellings a secret takes on the way back: as is, trimmed (a value
 * read from a file often ends in a newline), URL-encoded, base64 and
 * base64url, and JSON-escaped (with and without `\/` for `/`). A composite
 * (a Basic header's `user:secret`) cannot be derived from the secret alone:
 * pass it as a {@link ComposedSecret}, whose spellings are those of the
 * whole.
 */
export function secretForms(value: SecretValue): string[] {
  return spellingsOf(value).map((f) => f.form);
}

/** The forms a redactor looks for: every spelling whose secret part is at least `minLength` long. */
function formsOf(values: Iterable<SecretValue | undefined>, minLength: number): Form[] {
  const forms = new Map<string, number>();
  for (const value of values) {
    if (value === undefined) continue;
    const secret = typeof value === "string" ? value : value.secret;
    if (typeof secret !== "string" || secret.trim().length < minLength) continue;
    for (const { form, publicLength } of spellingsOf(value)) {
      if (form.length < minLength) continue;
      const seen = forms.get(form);
      forms.set(form, seen === undefined ? publicLength : Math.min(seen, publicLength));
    }
  }
  return [...forms]
    .map(([form, publicLength]) => ({ form, publicLength }))
    .sort((a, b) => b.form.length - a.form.length);
}

/**
 * How many characters at the end of `text` are the START of `form` (a
 * proper prefix, at least `min` long), or 0. Checked from the longest
 * candidate down, and only where the first character matches, so the cost
 * is one pass over the form's length.
 */
function partialAtEnd(text: string, form: string, min: number): number {
  const first = form.charCodeAt(0);
  for (let p = Math.max(0, text.length - form.length + 1); p <= text.length - min; p++) {
    if (text.charCodeAt(p) === first && form.startsWith(text.slice(p))) return text.length - p;
  }
  return 0;
}

/** How many characters at the start of `text` are the END of `form` (a proper suffix, at least `min` long), or 0. */
function partialAtStart(text: string, form: string, min: number): number {
  const last = form.charCodeAt(form.length - 1);
  for (let n = Math.min(form.length - 1, text.length); n >= min; n--) {
    if (text.charCodeAt(n - 1) === last && form.endsWith(text.slice(0, n))) return n;
  }
  return 0;
}

// ─── Escaped spellings ──────────────────────────────────────────────────────
//
// The forms above are whole-string encodings. An echo is often escaped
// character by character instead, and only where the encoder insists:
// System.Text.Json writes `+` as `\u002B` and leaves the rest alone, a
// server percent-encodes in lower case (`%2f`), an HTML page writes `/` as
// `&#x2F;`. No list of whole-string forms covers the mixtures (C050's
// residual: an AWS-style secret with `/` and `+` came back whole in all
// three). So a text holding any escape is also read through a DECODED VIEW
// — every `\uXXXX`, JSON escape, ASCII `%XX` and HTML character reference
// decoded, with a map back to where each decoded character came from — and
// each secret found there has its ORIGINAL span replaced.

type Segment = {
  /** Where the segment starts in the decoded view, and in the original text. */
  readonly d: number;
  readonly o: number;
  /** Its length in each: equal for a plain run, different for an escape. */
  readonly dl: number;
  readonly ol: number;
};

type DecodedView = { readonly text: string; readonly segments: readonly Segment[] };

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Named character references an echo of a token plausibly uses (HTML5 names). */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  sol: "/",
  bsol: "\\",
  plus: "+",
  equals: "=",
  lowbar: "_",
  period: ".",
  colon: ":",
  semi: ";",
  num: "#",
  percnt: "%",
  excl: "!",
  quest: "?",
  commat: "@",
  dollar: "$",
  ast: "*",
  comma: ",",
  tilde: "~",
  verbar: "|",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  lcub: "{",
  rcub: "}",
  grave: "`",
  Hat: "^",
};

const HEX = /^[0-9A-Fa-f]+$/;

/** The longest character reference decoded, `&` to `;`: `&#x10FFFF;`. */
const MAX_REFERENCE_CHARS = 10;

/** The escape starting at `i` (a `\`, `%` or `&`): what it decodes to and its length, or undefined. */
function escapeAt(
  text: string,
  i: number,
): { readonly ch: string; readonly len: number } | undefined {
  const c = text[i];
  if (c === "\\") {
    const n = text[i + 1];
    if (n === "u" || n === "U") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length === 4 && HEX.test(hex)) {
        return { ch: String.fromCharCode(Number.parseInt(hex, 16)), len: 6 };
      }
      return undefined;
    }
    const simple = n === undefined ? undefined : JSON_ESCAPES[n];
    return simple === undefined ? undefined : { ch: simple, len: 2 };
  }
  if (c === "%") {
    const hex = text.slice(i + 1, i + 3);
    if (hex.length !== 2 || !HEX.test(hex)) return undefined;
    const code = Number.parseInt(hex, 16);
    // ASCII only: a multi-byte UTF-8 sequence is the whole-string form's job.
    return code < 0x80 ? { ch: String.fromCharCode(code), len: 3 } : undefined;
  }
  if (c === "&") {
    // Looked for within the longest reference's reach only: an unbounded
    // `indexOf(";")` from every `&` of a text with none is quadratic.
    let semi = -1;
    for (let j = i + 1; j < text.length && j <= i + MAX_REFERENCE_CHARS; j++) {
      if (text.charCodeAt(j) === 0x3b) {
        semi = j;
        break;
      }
    }
    if (semi === -1) return undefined;
    const body = text.slice(i + 1, semi);
    let code: number | undefined;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const hex = body.slice(2);
      if (hex !== "" && HEX.test(hex)) code = Number.parseInt(hex, 16);
    } else if (body.startsWith("#")) {
      const dec = body.slice(1);
      if (/^[0-9]+$/.test(dec)) code = Number.parseInt(dec, 10);
    } else {
      const named = NAMED_REFERENCES[body];
      return named === undefined ? undefined : { ch: named, len: semi - i + 1 };
    }
    if (code === undefined || code > 0x10ffff) return undefined;
    return { ch: String.fromCodePoint(code), len: semi - i + 1 };
  }
  return undefined;
}

/** `text` with every escape decoded, and where each piece came from; undefined when nothing decodes. */
function decodedView(text: string): DecodedView | undefined {
  const segments: Segment[] = [];
  const parts: string[] = [];
  let d = 0;
  let runStart = 0;
  let decodedAny = false;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    // `\`, `%`, `&`
    const esc = c === 0x5c || c === 0x25 || c === 0x26 ? escapeAt(text, i) : undefined;
    if (esc === undefined) {
      i += 1;
      continue;
    }
    decodedAny = true;
    if (i > runStart) {
      segments.push({ d, o: runStart, dl: i - runStart, ol: i - runStart });
      parts.push(text.slice(runStart, i));
      d += i - runStart;
    }
    segments.push({ d, o: i, dl: esc.ch.length, ol: esc.len });
    parts.push(esc.ch);
    d += esc.ch.length;
    i += esc.len;
    runStart = i;
  }
  if (!decodedAny) return undefined;
  if (text.length > runStart) {
    segments.push({ d, o: runStart, dl: text.length - runStart, ol: text.length - runStart });
    parts.push(text.slice(runStart));
  }
  return { text: parts.join(""), segments };
}

/** The segment holding decoded index `p` (0 <= p < decoded length). */
function segmentAt(view: DecodedView, p: number): Segment {
  let lo = 0;
  let hi = view.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((view.segments[mid] as Segment).d <= p) lo = mid;
    else hi = mid - 1;
  }
  return view.segments[lo] as Segment;
}

/** The original span a decoded span `[start, end)` came from: whole escapes, never half of one. */
function originalSpan(view: DecodedView, start: number, end: number): [number, number] {
  const first = segmentAt(view, start);
  const last = segmentAt(view, end - 1);
  const from = first.dl === first.ol ? first.o + (start - first.d) : first.o;
  const to = last.dl === last.ol ? last.o + (end - 1 - last.d) + 1 : last.o + last.ol;
  return [from, to];
}

/** The whole values to look for in a decoded view: each secret as sent, and trimmed. */
function decodedNeedles(
  values: Iterable<SecretValue | undefined>,
  minLength: number,
): { readonly needle: string; readonly publicLength: number }[] {
  const out = new Map<string, number>();
  for (const value of values) {
    if (value === undefined) continue;
    const prefix = typeof value === "string" ? "" : value.publicPrefix;
    const secret = typeof value === "string" ? value : value.secret;
    if (typeof secret !== "string" || secret.trim().length < minLength) continue;
    for (const s of new Set([secret, secret.trim()])) out.set(prefix + s, prefix.length);
  }
  return [...out]
    .map(([needle, publicLength]) => ({ needle, publicLength }))
    .sort((a, b) => b.needle.length - a.needle.length);
}

/**
 * The original spans of `text` that spell a needle once decoded — whole,
 * or (at the text's edges) the part of one a cut left there — merged and
 * in order.
 */
function escapedSpans(
  text: string,
  needles: readonly { readonly needle: string; readonly publicLength: number }[],
  minLength: number,
): [number, number][] {
  if (needles.length === 0) return [];
  const view = decodedView(text);
  if (view === undefined) return [];
  const spans: [number, number][] = [];
  for (const { needle } of needles) {
    for (let at = view.text.indexOf(needle); at !== -1; at = view.text.indexOf(needle, at + 1)) {
      spans.push(originalSpan(view, at, at + needle.length));
    }
  }
  let tail = 0;
  let head = 0;
  for (const { needle, publicLength } of needles) {
    tail = Math.max(tail, partialAtEnd(view.text, needle, publicLength + minLength));
    head = Math.max(head, partialAtStart(view.text, needle, minLength));
  }
  if (tail > 0) spans.push(originalSpan(view, view.text.length - tail, view.text.length));
  if (head > 0) spans.push(originalSpan(view, 0, head));
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && span[0] <= prev[1]) prev[1] = Math.max(prev[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** `text` with each span replaced by `placeholder`. */
function replaceSpans(
  text: string,
  spans: readonly [number, number][],
  placeholder: string,
): string {
  let out = "";
  let at = 0;
  for (const [from, to] of spans) {
    out += text.slice(at, from) + placeholder;
    at = to;
  }
  return out + text.slice(at);
}

/**
 * Whether `text` holds a known secret: any of its {@link secretForms}, or
 * the secret itself under character escapes (`\u002B`, `%2f`, `&#x2F;`), at
 * the length the redactor redacts (default six characters and up). For a
 * check before text leaves in a form no redactor sees, such as a file
 * written to the workspace.
 */
export function containsKnownSecret(
  text: string,
  values: Iterable<SecretValue | undefined>,
  options: { readonly minLength?: number } = {},
): boolean {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const list = [...values];
  for (const { form } of formsOf(list, minLength)) if (text.includes(form)) return true;
  const needles = decodedNeedles(list, minLength);
  if (needles.length === 0) return false;
  const view = decodedView(text);
  return view !== undefined && needles.some(({ needle }) => view.text.includes(needle));
}

/**
 * A function that replaces every known secret value, in each of its
 * {@link secretForms}, with the placeholder. Built once, applied to many
 * strings. Longest forms first, so a secret that contains another is
 * replaced whole. Matching is literal (`split`/`join`): a secret full of
 * regex metacharacters is matched as written.
 *
 * A cut can split a secret: a byte cap, a preview, a window. What is left at
 * the edge is a prefix (or suffix) that no whole form matches, and it can be
 * every character of the secret but one. So, as a backstop, a string that
 * ENDS with the start of a form, or STARTS with the end of one, has that run
 * replaced too, when it holds at least `minLength` characters of the secret
 * (a {@link ComposedSecret}'s public prefix does not count towards them). A
 * caller that knows it cut a string should also trim it with
 * {@link trimSecretTail}, which removes a partial run of any length.
 */
export function createSecretRedactor(
  values: Iterable<SecretValue | undefined>,
  options: RedactOptions = {},
): (text: string) => string {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const placeholder = options.placeholder ?? REDACTED;
  const list = [...values];
  const ordered = formsOf(list, minLength);
  if (ordered.length === 0) return (text) => text;
  const needles = decodedNeedles(list, minLength);
  return (text: string): string => {
    let out = text;
    for (const { form } of ordered) if (out.includes(form)) out = out.split(form).join(placeholder);
    // A spelling escaped character by character, which no whole form is.
    const escaped = escapedSpans(out, needles, minLength);
    if (escaped.length > 0) out = replaceSpans(out, escaped, placeholder);
    let tail = 0;
    let head = 0;
    for (const { form, publicLength } of ordered) {
      tail = Math.max(tail, partialAtEnd(out, form, publicLength + minLength));
      head = Math.max(head, partialAtStart(out, form, minLength));
    }
    if (head === 0 && tail === 0) return out;
    if (head + tail >= out.length) return placeholder;
    return `${head > 0 ? placeholder : ""}${out.slice(head, out.length - tail)}${tail > 0 ? placeholder : ""}`;
  };
}

/**
 * `text`, which the caller has just CUT (a byte cap, a preview), without a
 * trailing run that is the start of a known secret form — what a cut
 * through an echoed credential leaves behind. Any run holding at least
 * `minPartial` characters of the secret (default 1) is removed: the caller
 * knows the text was cut, so a partial match is the secret, not a
 * coincidence. A {@link ComposedSecret}'s public prefix alone (a Basic
 * username at the cut) is not a secret and stays. Whole forms are left for
 * {@link createSecretRedactor}.
 */
export function trimSecretTail(
  text: string,
  values: Iterable<SecretValue | undefined>,
  options: { readonly minLength?: number; readonly minPartial?: number } = {},
): string {
  const forms = formsOf(values, options.minLength ?? DEFAULT_MIN_LENGTH);
  const minPartial = options.minPartial ?? 1;
  let tail = 0;
  for (const { form, publicLength } of forms)
    tail = Math.max(tail, partialAtEnd(text, form, publicLength + minPartial));
  return tail > 0 ? text.slice(0, text.length - tail) : text;
}

/** `text` with every known secret value replaced. See {@link createSecretRedactor}. */
export function redactKnownSecrets(
  text: string,
  values: Iterable<SecretValue | undefined>,
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
  values: Iterable<SecretValue | undefined>,
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

function isAsciiLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

function isSchemeChar(c: string): boolean {
  return isAsciiLetter(c) || (c >= "0" && c <= "9") || c === "+" || c === "." || c === "-";
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
    // Back over the characters a scheme may hold, then forward to its first
    // letter: growing the scheme one character at a time and testing each
    // suffix stopped at a digit, so `socks5://` and `h2://` went unseen.
    let start = sep;
    while (start > 0 && sep - start < 32 && isSchemeChar(text[start - 1] as string)) start -= 1;
    while (start < sep && !isAsciiLetter(text[start] as string)) start += 1;
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

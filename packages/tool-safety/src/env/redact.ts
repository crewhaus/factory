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
// `&#x2F;`, a script writes `\x2F`. No list of whole-string forms covers the
// mixtures (C050's residual: an AWS-style secret with `/` and `+` came back
// whole in all of them). So a text holding any escape is also read through
// a DECODED VIEW — every `\uXXXX`, `\u{…}`, `\xHH`, JSON escape, ASCII `%XX`
// and HTML character reference decoded, and every NUL dropped (a UTF-16
// body read as UTF-8 puts one beside each ASCII character) — and each secret
// found there has its ORIGINAL span replaced.
//
// The view is decoded again, up to MAX_DECODE_PASSES times, while it still
// changes: an echo that is a JSON string inside a JSON string escapes its
// escapes (`\\u002B`), and one pass only turns that into `\u002B`.
//
// Cost. This runs over every string a credential-carrying tool returns,
// often a whole 25 MiB body, and nearly always finds nothing. So a pass
// builds only the decoded TEXT, in 4 KiB chunks (never an object per
// escape), searches it, and lets it go; the map from decoded positions back
// to the original is rebuilt, by a second walk, only for a text where a
// secret was found, and only for the positions that need it.

/** Decode passes at most: a JSON string in a JSON string in a JSON string, and one more. */
const MAX_DECODE_PASSES = 4;

/** A plain run at least this long is kept as a slice of the text; a shorter one is copied. */
const SLICE_MIN = 64;

/** Code units decoded into one chunk of the view before it becomes a string. */
const CHUNK_UNITS = 4096;

/** The most characters of a reference's name looked at after its `&` (the longest listed, `percnt`, has six). */
const MAX_REFERENCE_CHARS = 10;

/** JSON's one-character escapes, by the character after the `\`. */
const JSON_ESCAPE_CODES: ReadonlyMap<number, number> = new Map([
  [0x22, 0x22], // \"
  [0x5c, 0x5c], // \\
  [0x2f, 0x2f], // \/
  [0x62, 0x08], // \b
  [0x66, 0x0c], // \f
  [0x6e, 0x0a], // \n
  [0x72, 0x0d], // \r
  [0x74, 0x09], // \t
]);

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

/** What an escape decodes to that is no character: a NUL. */
const NOTHING = -1;

/**
 * The code point the escape {@link escapeLength} last measured decodes to,
 * or {@link NOTHING}. Module state rather than an object per escape: a body
 * can hold millions of them.
 */
let escapeCode = 0;

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/** The value of exactly `count` hex digits at `from`, or -1. */
function fixedHex(text: string, from: number, count: number): number {
  if (from + count > text.length) return -1;
  let v = 0;
  for (let k = from; k < from + count; k++) {
    const h = hexDigit(text.charCodeAt(k));
    if (h < 0) return -1;
    v = v * 16 + h;
  }
  return v;
}

/** Record what an escape of `len` characters decodes to (a NUL decodes to nothing), and return `len`. */
function decodesTo(code: number, len: number): number {
  escapeCode = code === 0 ? NOTHING : code;
  return len;
}

function isAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** An HTML character reference at `i` (an `&`): its length, or 0. */
function referenceLength(text: string, i: number): number {
  if (text.charCodeAt(i + 1) === 0x23) {
    // `&#47;`, `&#x2F;`. The `;` is optional for a numeric reference, as a
    // browser reads it. Digits are read to their end (one `&` per run, so
    // this stays linear), and a value past U+10FFFF is no reference.
    const hex = (text.charCodeAt(i + 2) | 0x20) === 0x78;
    let j = hex ? i + 3 : i + 2;
    const start = j;
    let v = 0;
    for (; j < text.length; j++) {
      const c = text.charCodeAt(j);
      const d = hex ? hexDigit(c) : c >= 0x30 && c <= 0x39 ? c - 0x30 : -1;
      if (d < 0) break;
      if (v <= 0x10ffff) v = v * (hex ? 16 : 10) + d;
    }
    if (j === start || v > 0x10ffff) return 0;
    if (text.charCodeAt(j) === 0x3b) j += 1;
    return decodesTo(v, j - i);
  }
  // A name: looked for within the longest name's reach only. An unbounded
  // search for `;` from every `&` of a text with none is quadratic.
  let j = i + 1;
  while (j < text.length && j <= i + MAX_REFERENCE_CHARS && isAlnum(text.charCodeAt(j))) j += 1;
  if (j === i + 1 || text.charCodeAt(j) !== 0x3b) return 0;
  const named = NAMED_REFERENCES[text.slice(i + 1, j)];
  return named === undefined ? 0 : decodesTo(named.charCodeAt(0), j + 1 - i);
}

/**
 * The length of the escape at `i` (a `\`, `%`, `&` or NUL), or 0 when there
 * is none there; what it decodes to is left in {@link escapeCode}.
 */
function escapeLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 0) return decodesTo(0, 1);
  if (c === 0x25) {
    // ASCII only: a multi-byte UTF-8 sequence is the whole-string form's job.
    const v = fixedHex(text, i + 1, 2);
    return v < 0 || v >= 0x80 ? 0 : decodesTo(v, 3);
  }
  if (c === 0x26) return referenceLength(text, i);
  if (c !== 0x5c) return 0;
  const n = text.charCodeAt(i + 1);
  if (n === 0x75 && text.charCodeAt(i + 2) === 0x7b) {
    // `\u{2F}`: one to six hex digits.
    let j = i + 3;
    let v = 0;
    while (j < text.length && j < i + 9) {
      const h = hexDigit(text.charCodeAt(j));
      if (h < 0) break;
      v = v * 16 + h;
      j += 1;
    }
    if (j === i + 3 || text.charCodeAt(j) !== 0x7d || v > 0x10ffff) return 0;
    return decodesTo(v, j + 1 - i);
  }
  if (n === 0x75 || n === 0x55) {
    const v = fixedHex(text, i + 2, 4);
    return v < 0 ? 0 : decodesTo(v, 6);
  }
  if (n === 0x78) {
    const v = fixedHex(text, i + 2, 2);
    return v < 0 ? 0 : decodesTo(v, 4);
  }
  const simple = JSON_ESCAPE_CODES.get(n);
  return simple === undefined ? 0 : decodesTo(simple, 2);
}

/** Code units an escape's code point takes in the view. */
function unitsOf(code: number): number {
  return code === NOTHING ? 0 : code > 0xffff ? 2 : 1;
}

/** What a walk over a text's escapes reports, in order and covering the whole text. */
interface EscapeSink {
  /** `text[from, to)` has no escape: it is itself in the view. */
  plain(from: number, to: number): void;
  /** `text[at, at + len)` is an escape that decodes to `code` ({@link NOTHING}: to nothing). */
  escape(at: number, len: number, code: number): void;
}

/** The first index at or after `from` holding a character that can start an escape, or -1. */
function firstEscapeStart(text: string, from: number): number {
  let first = -1;
  for (const ch of ["\\", "%", "&", "\u0000"]) {
    const at = text.indexOf(ch, from);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  return first;
}

/**
 * Walk `text`'s escapes left to right, telling `sink` of each and of the
 * plain runs between them. Nothing is reported when no escape decodes, and
 * then this returns false. One pass: a text with nothing that can start an
 * escape costs four `indexOf`s; otherwise each character is looked at once
 * (an `indexOf` per escape was the slower way through a dense body).
 */
function walkEscapes(text: string, sink: EscapeSink): boolean {
  let i = firstEscapeStart(text, 0);
  if (i === -1) return false;
  let runStart = 0;
  let decodedAny = false;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // `\`, `%`, `&`, NUL
    if (c !== 0x5c && c !== 0x25 && c !== 0x26 && c !== 0) {
      i += 1;
      continue;
    }
    const len = escapeLength(text, i);
    if (len === 0) {
      i += 1;
      continue;
    }
    decodedAny = true;
    if (i > runStart) sink.plain(runStart, i);
    sink.escape(i, len, escapeCode);
    i += len;
    runStart = i;
  }
  if (decodedAny && text.length > runStart) sink.plain(runStart, text.length);
  return decodedAny;
}

/** Builds a view's text: long plain runs as slices, everything else in chunks of code units. */
/**
 * The chunk a view's code units are gathered in, shared by every view: a
 * view is built start to finish without yielding, and one buffer per call
 * made redacting a result of many small strings fifteen times slower.
 */
const CHUNK = new Uint16Array(CHUNK_UNITS);
/** The chunk again, one byte a unit, for a chunk of Latin-1 only (one byte a character as a string). */
const NARROW = new Uint8Array(CHUNK_UNITS);

class ViewText implements EscapeSink {
  private readonly parts: string[] = [];
  private filled = 0;
  private widest = 0;

  constructor(private readonly text: string) {}

  plain(from: number, to: number): void {
    if (to - from >= SLICE_MIN) {
      this.flush();
      this.parts.push(this.text.slice(from, to));
      return;
    }
    for (let k = from; k < to; k++) this.unit(this.text.charCodeAt(k));
  }

  escape(_at: number, _len: number, code: number): void {
    if (code === NOTHING) return;
    if (code > 0xffff) {
      const v = code - 0x10000;
      this.unit(0xd800 + (v >> 10));
      this.unit(0xdc00 + (v & 0x3ff));
    } else {
      this.unit(code);
    }
  }

  finish(): string {
    this.flush();
    return this.parts.join("");
  }

  private unit(u: number): void {
    if (this.filled === CHUNK_UNITS) this.flush();
    CHUNK[this.filled] = u;
    this.filled += 1;
    if (u > this.widest) this.widest = u;
  }

  // Buffer's decoders, not `String.fromCharCode.apply`: the latter took
  // about fifty times as long on a 25 MiB body.
  private flush(): void {
    if (this.filled === 0) return;
    if (this.widest < 0x100) {
      NARROW.set(CHUNK.subarray(0, this.filled));
      this.parts.push(Buffer.from(NARROW.buffer, 0, this.filled).toString("latin1"));
    } else {
      this.parts.push(Buffer.from(CHUNK.buffer, 0, this.filled * 2).toString("utf16le"));
    }
    this.filled = 0;
    this.widest = 0;
  }
}

/** `text` with one layer of escapes decoded, or undefined when nothing in it decodes. */
function decodeOnce(text: string): string | undefined {
  const view = new ViewText(text);
  return walkEscapes(text, view) ? view.finish() : undefined;
}

/**
 * For each of `wanted` (view positions, ascending, each < the view's
 * length), the original span of the plain character or the whole escape it
 * came from: `starts[k]` to `ends[k]`.
 */
class UnitLocator implements EscapeSink {
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  private decoded = 0;
  private next = 0;

  constructor(private readonly wanted: readonly number[]) {}

  plain(from: number, to: number): void {
    const end = this.decoded + (to - from);
    while (this.next < this.wanted.length && (this.wanted[this.next] as number) < end) {
      const at = from + ((this.wanted[this.next] as number) - this.decoded);
      this.starts[this.next] = at;
      this.ends[this.next] = at + 1;
      this.next += 1;
    }
    this.decoded = end;
  }

  escape(at: number, len: number, code: number): void {
    const end = this.decoded + unitsOf(code);
    while (this.next < this.wanted.length && (this.wanted[this.next] as number) < end) {
      this.starts[this.next] = at;
      this.ends[this.next] = at + len;
      this.next += 1;
    }
    this.decoded = end;
  }
}

/**
 * Spans of the view of `text` (one decode pass), as spans of `text`: whole
 * escapes, never half of one. Found by walking `text` again — this runs
 * only when a secret was found.
 */
function spansBeforeDecoding(
  text: string,
  spans: readonly (readonly [number, number])[],
): [number, number][] {
  const wanted = [...new Set(spans.flatMap(([from, to]) => [from, to - 1]))].sort((a, b) => a - b);
  const locator = new UnitLocator(wanted);
  walkEscapes(text, locator);
  const index = new Map(wanted.map((p, k) => [p, k]));
  return spans.map(([from, to]) => [
    locator.starts[index.get(from) as number] as number,
    locator.ends[index.get(to - 1) as number] as number,
  ]);
}

type Needle = { readonly needle: string; readonly publicLength: number };

/** The whole values to look for in a decoded view: each secret as sent, and trimmed. */
function decodedNeedles(values: Iterable<SecretValue | undefined>, minLength: number): Needle[] {
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
 * Where `view` spells a needle — whole, or (at its edges) the part of one a
 * cut left there. Occurrences of one needle that overlap or touch are one
 * span, so a view that repeats a secret end to end costs one entry, not one
 * per position.
 */
function needleSpans(
  view: string,
  needles: readonly Needle[],
  minLength: number,
): [number, number][] {
  const spans: [number, number][] = [];
  for (const { needle } of needles) {
    let last: [number, number] | undefined;
    for (let at = view.indexOf(needle); at !== -1; at = view.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (last !== undefined && at <= last[1]) last[1] = end;
      else {
        last = [at, end];
        spans.push(last);
      }
    }
  }
  let tail = 0;
  let head = 0;
  for (const { needle, publicLength } of needles) {
    tail = Math.max(tail, partialAtEnd(view, needle, publicLength + minLength));
    head = Math.max(head, partialAtStart(view, needle, minLength));
  }
  if (tail > 0) spans.push([view.length - tail, view.length]);
  if (head > 0) spans.push([0, head]);
  return spans;
}

/** Spans sorted, with overlapping or touching ones merged. */
function mergeSpans(spans: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of sorted) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && span[0] <= prev[1]) prev[1] = Math.max(prev[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * The original spans of `text` that spell a needle once decoded (by up to
 * {@link MAX_DECODE_PASSES} passes) — whole, or at the text's edges the
 * part of one a cut left there — merged and in order.
 */
function escapedSpans(
  text: string,
  needles: readonly Needle[],
  minLength: number,
): [number, number][] {
  if (needles.length === 0) return [];
  const found: { readonly pass: number; readonly spans: [number, number][] }[] = [];
  let level = text;
  for (let pass = 1; pass <= MAX_DECODE_PASSES; pass++) {
    const view = decodeOnce(level);
    if (view === undefined) break;
    const spans = needleSpans(view, needles, minLength);
    if (spans.length > 0) found.push({ pass, spans });
    level = view;
  }
  if (found.length === 0) return [];
  // Only now, with a secret found, keep each pass's text to map spans back.
  const deepest = (found[found.length - 1] as (typeof found)[number]).pass;
  const levels = [text];
  for (let k = 1; k < deepest; k++) levels.push(decodeOnce(levels[k - 1] as string) as string);
  const out: [number, number][] = [];
  for (const { pass, spans } of found) {
    let mapped = spans;
    for (let k = pass - 1; k >= 0; k--) mapped = spansBeforeDecoding(levels[k] as string, mapped);
    out.push(...mapped);
  }
  return mergeSpans(out);
}

/** Whether any decode pass of `text` spells a needle whole. Builds no map. */
function decodedHoldsNeedle(text: string, needles: readonly Needle[]): boolean {
  if (needles.length === 0) return false;
  let level = text;
  for (let pass = 1; pass <= MAX_DECODE_PASSES; pass++) {
    const view = decodeOnce(level);
    if (view === undefined) return false;
    if (needles.some(({ needle }) => view.includes(needle))) return true;
    level = view;
  }
  return false;
}

/** `text` with each span replaced by `placeholder`. */
function replaceSpans(
  text: string,
  spans: readonly [number, number][],
  placeholder: string,
): string {
  const out: string[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    out.push(text.slice(at, from), placeholder);
    at = to;
  }
  out.push(text.slice(at));
  return out.join("");
}

/**
 * Whether `text` holds a known secret: any of its {@link secretForms}, or
 * the secret itself under character escapes (`\u002B`, `%2f`, `&#x2F;`,
 * `\x2F`, a JSON escape inside a JSON string, NULs between its characters),
 * at the length the redactor redacts (default six characters and up). For a
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
  return decodedHoldsNeedle(text, decodedNeedles(list, minLength));
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

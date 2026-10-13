/**
 * Slugs: turning a title into something safe in a URL, a filename or an id.
 *
 * Supported subset, stated so nobody is surprised by it:
 *
 *   - Accented Latin letters are folded to their base letter by Unicode NFKD
 *     decomposition plus combining-mark removal (é -> e, ñ -> n, ǎ -> a).
 *   - Letters that have no decomposition get an explicit mapping: the German
 *     sharp s, the Nordic and Slavic strokes, the Latin ligatures, Icelandic
 *     thorn and eth, Turkish dotless i.
 *   - Everything else non-alphanumeric becomes the separator, runs collapse,
 *     and the ends are trimmed.
 *   - Non-Latin scripts (Cyrillic, Greek, Arabic, CJK, emoji) are NOT
 *     romanized — transliterating them properly is a language-dependent job,
 *     not a character table. With `allowUnicode` they are kept as-is, which is
 *     valid in a modern URL path; without it they are dropped, and a title
 *     written entirely in one of those scripts yields an empty slug. The
 *     caller is told when that happens.
 */

/** Letters with no NFKD decomposition, and what they fold to. */
const CHAR_MAP: Readonly<Record<string, string>> = Object.freeze({
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ł: "l",
  Ł: "L",
  ħ: "h",
  Ħ: "H",
  ı: "i",
  İ: "I",
  ŋ: "ng",
  Ŋ: "NG",
  ĸ: "k",
  ƒ: "f",
  "·": "-",
  "×": "x",
  "€": "eur",
  "£": "gbp",
  $: "usd",
});

export type SlugifyOptions = {
  separator?: string;
  lowercase?: boolean;
  maxLength?: number;
  allowUnicode?: boolean;
  /**
   * Applied before anything else, longest key first, each to the text the
   * keys before it produced: `{"&": "and"}`.
   */
  replacements?: Readonly<Record<string, string>>;
  /**
   * The most characters the text may reach while `replacements` are
   * applied; past it the call is refused, never cut. The Slugify tool
   * passes its limit for the text itself.
   */
  limit?: number;
};

export type SlugifyResult = { slug: string; truncated: boolean; empty: boolean };

/** The Slugify tool's limit for its text, the default {@link SlugifyOptions.limit}. */
const DEFAULT_LIMIT = 2_000_000;

/**
 * Each replacement key is one pass over the whole text, so the passes
 * together may read this many times the limit: a long text takes a few
 * keys, a title thousands.
 */
const PASSES_PER_LIMIT = 8;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** For each prefix of `key`, the longest proper prefix of it that is also its suffix. */
function borders(key: string): Int32Array {
  const border = new Int32Array(key.length);
  let k = 0;
  for (let i = 1; i < key.length; i++) {
    const c = key.charCodeAt(i);
    while (k > 0 && key.charCodeAt(k) !== c) k = border[k - 1] as number;
    if (key.charCodeAt(k) === c) k += 1;
    border[i] = k;
  }
  return border;
}

/**
 * `text` with every `key` replaced by `value`, as a global `replace` of the
 * literal key does it: left to right, matches never overlapping, and the
 * empty key matching before each UTF-16 unit and at the end. Undefined once
 * what it builds would pass `limit`. The search reads each unit of the text
 * once, whatever the key (Knuth–Morris–Pratt), where a regular expression's
 * literal search may try the whole key from every position.
 */
function replaceLiteral(
  text: string,
  key: string,
  value: string,
  limit: number,
): string | undefined {
  if (key === "") {
    if (text.length + (text.length + 1) * value.length > limit) return undefined;
    const parts: string[] = [value];
    for (let i = 0; i < text.length; i++) parts.push(text.charAt(i), value);
    return parts.join("");
  }
  if (key.length > text.length) return text;
  const border = borders(key);
  const parts: string[] = [];
  let size = 0;
  let copied = 0;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    while (k > 0 && key.charCodeAt(k) !== c) k = border[k - 1] as number;
    if (key.charCodeAt(k) === c) k += 1;
    if (k === key.length) {
      const start = i + 1 - key.length;
      size += start - copied + value.length;
      if (size > limit) return undefined;
      parts.push(text.slice(copied, start), value);
      copied = i + 1;
      k = 0;
    }
  }
  if (copied === 0) return text;
  if (size + text.length - copied > limit) return undefined;
  parts.push(text.slice(copied));
  return parts.join("");
}

/**
 * The text with `replacements` applied, or an error that says which limit
 * stopped it. A key's pass also runs over the values earlier keys put in,
 * which is what the keys' order is for, so a value that holds the next key
 * many times multiplies the text once per key: a 347-byte call grew it past
 * 300,000 characters. The text may grow to `limit`, and the passes together
 * may read {@link PASSES_PER_LIMIT} times it.
 */
export function applyReplacements(
  text: string,
  replacements: Readonly<Record<string, string>>,
  limit: number,
): string {
  const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
  const budget = PASSES_PER_LIMIT * limit;
  let working = text;
  let read = 0;
  for (const key of keys) {
    if (read + working.length > budget) {
      throw new Error(
        `${keys.length} replacement keys over ${working.length} characters of text would read more than ${budget} characters, since each key is a pass over the whole text; use fewer keys or a shorter text`,
      );
    }
    read += working.length;
    // The caller's value is text, never a replacement pattern: as a
    // `replace` STRING, `$&`, `$'` and `` $` `` would expand to pieces of the
    // input, so `{"&": "$`"}` turned "Tom & Jerry" into "tom-tom-jerry".
    const next = replaceLiteral(working, key, ` ${replacements[key] ?? ""} `, limit);
    if (next === undefined) {
      throw new Error(
        `the replacements would make the text longer than ${limit} characters, the limit for text; keys apply longest first, each to the text the ones before produced, so a value that holds a later key is expanded again`,
      );
    }
    working = next;
  }
  return working;
}

export function slugify(text: string, options: SlugifyOptions = {}): SlugifyResult {
  const separator = options.separator ?? "-";
  const lowercase = options.lowercase ?? true;
  const allowUnicode = options.allowUnicode ?? false;

  let working = applyReplacements(text, options.replacements ?? {}, options.limit ?? DEFAULT_LIMIT);
  working = [...working].map((character) => CHAR_MAP[character] ?? character).join("");
  // NFKD splits "é" into "e" + a combining acute, which the next step removes.
  working = working.normalize("NFKD").replace(/\p{M}+/gu, "");
  if (lowercase) working = working.toLowerCase();

  const keep = allowUnicode ? /[^\p{L}\p{N}]+/gu : /[^a-zA-Z0-9]+/g;
  // The separator is inserted by a function replacer for the same reason: as
  // a replacement string, a separator of `$&` put back the very punctuation
  // (`/`, `..`) the slug exists to remove.
  const insertSeparator = (): string => separator;
  let slug = working.replace(keep, insertSeparator);

  if (separator !== "") {
    const escaped = escapeRegex(separator);
    slug = slug
      .replace(new RegExp(`(?:${escaped}){2,}`, "g"), insertSeparator)
      .replace(new RegExp(`^(?:${escaped})|(?:${escaped})$`, "g"), "");
  }

  let truncated = false;
  const maxLength = options.maxLength;
  // Counted and cut in code points, not UTF-16 units: with `allowUnicode` a
  // naive `slice` can land in the middle of a surrogate pair and leave a lone
  // surrogate in the slug.
  const points = [...slug];
  if (maxLength !== undefined && points.length > maxLength) {
    truncated = true;
    const cut = points.slice(0, maxLength).join("");
    // Prefer a word boundary so the slug does not end mid-word.
    const lastSeparator = separator === "" ? -1 : cut.lastIndexOf(separator);
    slug = lastSeparator > 0 ? cut.slice(0, lastSeparator) : cut;
  }

  return { slug, truncated, empty: slug === "" };
}

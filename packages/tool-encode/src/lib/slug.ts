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
  /** Applied before anything else, longest key first: `{"&": "and"}`. */
  replacements?: Readonly<Record<string, string>>;
};

export type SlugifyResult = { slug: string; truncated: boolean; empty: boolean };

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slugify(text: string, options: SlugifyOptions = {}): SlugifyResult {
  const separator = options.separator ?? "-";
  const lowercase = options.lowercase ?? true;
  const allowUnicode = options.allowUnicode ?? false;

  let working = text;
  const replacements = options.replacements ?? {};
  for (const key of Object.keys(replacements).sort((a, b) => b.length - a.length)) {
    working = working.replace(new RegExp(escapeRegex(key), "g"), ` ${replacements[key] ?? ""} `);
  }
  working = [...working].map((character) => CHAR_MAP[character] ?? character).join("");
  // NFKD splits "é" into "e" + a combining acute, which the next step removes.
  working = working.normalize("NFKD").replace(/\p{M}+/gu, "");
  if (lowercase) working = working.toLowerCase();

  const keep = allowUnicode ? /[^\p{L}\p{N}]+/gu : /[^a-zA-Z0-9]+/g;
  let slug = working.replace(keep, separator);

  if (separator !== "") {
    const escaped = escapeRegex(separator);
    slug = slug
      .replace(new RegExp(`(?:${escaped}){2,}`, "g"), separator)
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

/**
 * On-page SEO, and the three places where a plausible implementation lies.
 *
 * Most of what an SEO gate checks is mechanical and exact: a title is there
 * or it is not, an `<img>` carries an `alt` attribute or it does not, a
 * JSON-LD block parses or it does not. Those checks are worth having because
 * a person reading a page misses one in ten.
 *
 * Three of them are not exact, and each one is a place where a tool can hand
 * a writer a confident number it has not earned:
 *
 *   1. READABILITY. Flesch-Kincaid needs a syllable count, and counting
 *      English syllables is a heuristic with a long tail of exceptions —
 *      silent 'e', diphthongs, '-le' endings, "-ed" that is sometimes its own
 *      syllable and sometimes not. `countSyllables` below gets the common
 *      cases and misses the rest, so the grade it feeds is approximately
 *      right. `gradeBand` therefore returns a BAND, and nothing in this file
 *      ever returns the grade itself. A number to two decimals invites a
 *      writer to tune prose against this file's bugs instead of against
 *      readability, and the tuning would survive the bug being fixed.
 *
 *   2. KEYWORD DENSITY needs to know where one word ends and the next
 *      begins. `tokenize` splits on non-letters, which is right for English,
 *      German and every other whitespace-segmented language, and MEANINGLESS
 *      for Chinese, Japanese, Thai, Lao, Khmer, Burmese and Tibetan — a
 *      density computed that way over Japanese prose reports one enormous
 *      "word" or none at all. `segmentsOnWhitespace` exists so the density
 *      check can DISABLE ITSELF for those, rather than report a confident
 *      zero. `Intl.Segmenter` would segment them, and is deliberately not
 *      used: its output depends on the ICU data compiled into the runtime, so
 *      two machines on different bun builds can disagree, and a gate whose
 *      answer moves with the runtime is not a gate.
 *
 *   3. The passive-voice and long-sentence heuristics have the same
 *      character as the first. Without a part-of-speech tagger, "was" plus
 *      something that ends in "-ed" over-fires on "was tired", "is
 *      interested", "were located" — adjectives that look exactly like past
 *      participles. `passiveCandidates` is named for what it returns:
 *      candidates, not findings. Callers must report them as observations.
 *
 * The near-duplicate check is not here. It belongs to `@crewhaus/tool-text`,
 * whose `TextSimilarity` already publishes the scoring; a second one in this
 * package would give a harness two answers to one question.
 */
import { splitSentences } from "./markdown";

// ---------------------------------------------------------------------------
// Language, and the two different questions a check can ask about it.

/**
 * The primary subtag of a BCP-47 tag, lowercased.
 *
 * "en-GB" and "EN" are both English, and every decision below keys on the
 * language rather than on the region. Anything that is not a plain letter
 * sequence is treated as no tag at all rather than guessed at.
 */
export function primarySubtag(tag: string): string | undefined {
  const first = tag.trim().split(/[-_]/)[0] ?? "";
  return /^[A-Za-z]{2,8}$/.test(first) ? first.toLowerCase() : undefined;
}

/**
 * Languages written without spaces between words.
 *
 * Korean is NOT here: Hangul is written with spaces, so a whitespace
 * tokenizer gives a usable answer for it. Vietnamese is not here either — it
 * has spaces, they just fall between syllables rather than words, which
 * makes a density slightly off rather than meaningless.
 */
const NON_SEGMENTING_LANGS: ReadonlySet<string> = new Set([
  "bo", // Tibetan
  "cmn", // Mandarin
  "dz", // Dzongkha
  "gan",
  "hak",
  "ja",
  "km", // Khmer
  "lo", // Lao
  "lzh", // Literary Chinese
  "my", // Burmese
  "nan",
  "th",
  "wuu",
  "yue",
  "zh",
]);

/** Characters belonging to a script that does not separate words with spaces. */
const NON_SEGMENTING_CHARS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/gu;

const ALL_LETTERS = /\p{L}/gu;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/**
 * What fraction of the prose's letters are in a non-segmenting script.
 *
 * Asked of the TEXT because a `lang` attribute is a claim, not a fact: a
 * page that says `lang="en"` and carries Japanese prose is common, and
 * trusting the attribute there is how a density check comes to report a
 * confident number over text it cannot tokenize.
 */
export function nonSegmentingShare(text: string): number {
  const letters = count(text, ALL_LETTERS);
  if (letters === 0) return 0;
  return count(text, NON_SEGMENTING_CHARS) / letters;
}

/** Above this share of non-segmenting letters, a whitespace tokenizer is noise. */
const NON_SEGMENTING_LIMIT = 0.15;

export type LanguageRead = {
  /** The primary subtag actually used, or undefined when nothing declared one. */
  readonly tag: string | undefined;
  readonly source: "input" | "lang attribute" | "none";
  /** True when a whitespace tokenizer gives a meaningful word count here. */
  readonly segmentsOnWhitespace: boolean;
  /** Filled in only when it does not: why the tokenizer was refused. */
  readonly notSegmentingReason: string | undefined;
  /** True only when the page is declared English. Flesch-Kincaid is English-only. */
  readonly isEnglish: boolean;
};

/**
 * Decide, once, what the language checks are allowed to assume.
 *
 * Two different questions come out of this, and conflating them is a bug:
 * "can I count words" (true for German, false for Thai) and "is
 * Flesch-Kincaid meaningful" (true for English alone — the coefficients were
 * fitted on English, and running them over German prose produces a number
 * with no interpretation).
 */
export function readLanguage(
  declared: string | undefined,
  fromInput: string | undefined,
  prose: string,
): LanguageRead {
  const chosen = fromInput ?? declared;
  const tag = chosen === undefined ? undefined : primarySubtag(chosen);
  const source =
    fromInput !== undefined ? "input" : declared !== undefined ? "lang attribute" : "none";
  const share = nonSegmentingShare(prose);
  if (tag !== undefined && NON_SEGMENTING_LANGS.has(tag)) {
    return {
      tag,
      source,
      segmentsOnWhitespace: false,
      notSegmentingReason: `the page's language is "${tag}", which is written without spaces between words, so a whitespace tokenizer cannot count them`,
      isEnglish: false,
    };
  }
  if (share >= NON_SEGMENTING_LIMIT) {
    return {
      tag,
      source,
      segmentsOnWhitespace: false,
      notSegmentingReason: `${Math.round(share * 100)}% of the prose is in a script written without spaces between words${
        tag === undefined ? "" : `, whatever the declared language "${tag}" says`
      }, so a whitespace tokenizer cannot count them`,
      isEnglish: false,
    };
  }
  return {
    tag,
    source,
    segmentsOnWhitespace: true,
    notSegmentingReason: undefined,
    isEnglish: tag === "en",
  };
}

// ---------------------------------------------------------------------------
// Words and sentences.

/**
 * A word, for a language that separates them with something.
 *
 * The connectors inside a word are the ASCII apostrophe, the typographic
 * one (’, written as itself rather than as an escape because biome's
 * formatter unfolds the escape anyway) and the ASCII hyphen: "don't",
 * "don’t" and "state-of-the-art" are each one word.
 */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * The prose as lowercase word tokens.
 *
 * Only ever called once `readLanguage` has said the language segments on
 * whitespace — see the header. Calling it anyway on Japanese returns a
 * plausible-looking array, which is exactly the failure this file exists to
 * avoid.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/**
 * The prose as sentences.
 *
 * `splitSentences` is this package's one sentence splitter, shared with the
 * claim reader — it already holds the abbreviation list ("e.g.", "J. Smith")
 * that decides where a sentence really ends, and a second splitter here
 * would disagree with it about how many sentences a document has, which is
 * the denominator of the readability grade.
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const span of splitSentences(text)) {
    const body = text.slice(span.start, span.end).trim();
    if (body !== "") out.push(body);
  }
  return out;
}

/**
 * Syllables in one English word — a heuristic, and known to be wrong.
 *
 * It handles the four cases that move the count most: short words, the
 * silent trailing 'e', "-le" after a consonant (table, little), and "-ed"
 * or "-es" that is not its own syllable (walked, makes) versus one that is
 * (wanted, watches). It gets "beautiful" wrong (4, not 3), every diphthong
 * that is written as two vowel groups wrong, and every borrowed word whose
 * spelling does not predict its sound wrong.
 *
 * Nothing should publish a number derived from this at a resolution finer
 * than a band. See the header.
 */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  // The plural of a "-le" word keeps the syllable its "le" carries: only the
  // "s" comes off "particles", or the rule below eats the "e" as well and
  // par-ti-cles counts as two.
  let body = /[^aeiou]les$/.test(w) ? w.slice(0, -1) : w;
  // "-es"/"-ed" is a syllable of its own after a sibilant ("watches") or a
  // /t/ or /d/ ("wanted"), and silent after anything else ("walked").
  body = body.replace(/(?<![sxz]|ch|sh|[td])(?:es|ed)$/, "");
  // A trailing "e" is silent after a consonant ("make") but not when the
  // consonant is an "l" that the "e" makes pronounceable ("table"), and not
  // when a vowel precedes it ("agree").
  if (!/[^aeiou]le$/.test(body)) body = body.replace(/([^aeiou])e$/, "$1");
  const groups = body.match(/[aeiouy]+/g);
  return Math.max(1, groups === null ? 0 : groups.length);
}

export type ReadabilityBand = {
  /** The band, e.g. "grade 9-12". Never a number: the inputs do not support one. */
  readonly band: string;
  /**
   * The neighbouring band, when the grade lands within one level of the
   * boundary. The syllable count is a heuristic, so a grade that close to a
   * boundary could sit either side of it, and saying which is a guess.
   */
  readonly couldAlsoBe: string | undefined;
};

const BANDS: ReadonlyArray<{ upTo: number; label: string }> = [
  { upTo: 6, label: "grade 5 or below" },
  { upTo: 9, label: "grade 6-8" },
  { upTo: 13, label: "grade 9-12" },
  { upTo: 17, label: "grade 13-16" },
  { upTo: Number.POSITIVE_INFINITY, label: "grade 17 and above" },
];

const labelFor = (grade: number): string =>
  (BANDS.find((b) => grade < b.upTo) ?? BANDS[BANDS.length - 1] ?? { label: "unknown" }).label;

/**
 * The Flesch-Kincaid grade, expressed as a band and never as a number.
 *
 * The formula is the standard one; what is not standard is refusing to
 * publish its output. Two of its three inputs (syllables, sentences) are
 * heuristics in this file, so the third decimal place is this file's
 * rounding error rather than a property of the prose.
 */
export function readabilityBand(words: ReadonlyArray<string>, sentences: number): ReadabilityBand {
  const wordCount = words.length;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const perSentence = wordCount / Math.max(1, sentences);
  const perWord = syllables / Math.max(1, wordCount);
  const grade = 0.39 * perSentence + 11.8 * perWord - 15.59;
  const band = labelFor(grade);
  const near = [labelFor(grade - 1), labelFor(grade + 1)].find((l) => l !== band);
  return { band, couldAlsoBe: near };
}

/** A sentence longer than this reads as two. Not a rule, a threshold. */
export const LONG_SENTENCE_WORDS = 30;

/**
 * Past participles that do not end in "-ed", for the passive heuristic.
 *
 * Short and incomplete on purpose: every addition widens a heuristic that
 * already over-fires, and the caller reports its output as an observation
 * rather than as a finding.
 */
const IRREGULAR_PARTICIPLES =
  "born|brought|bought|built|caught|chosen|done|driven|drawn|eaten|fallen|felt|found|given|gone|held|kept|known|laid|led|left|lost|made|meant|met|paid|put|read|run|seen|sent|set|shown|sold|spent|taken|taught|thought|told|understood|won|written";

const PASSIVE = new RegExp(
  `\\b(?:is|are|was|were|be|been|being|am|gets?|got)\\b(?:\\s+\\w+ly)?\\s+\\b(?:\\w+(?:ed|en)|${IRREGULAR_PARTICIPLES})\\b`,
  "i",
);

/**
 * Sentences that LOOK passive to a regex.
 *
 * "was tired", "is interested" and "were located" match and are not passive;
 * a passive with the verb far from its auxiliary does not match and is. The
 * name says candidates because that is what these are, and a caller that
 * reports them as passive sentences is reporting something it does not know.
 */
export function passiveCandidates(sentences: ReadonlyArray<string>): string[] {
  return sentences.filter((s) => PASSIVE.test(s));
}

// ---------------------------------------------------------------------------
// Keywords.

/**
 * How many times a keyword phrase occurs in a token sequence.
 *
 * Compared token by token rather than as a substring, so "cat" does not
 * match inside "catalogue" — for a whitespace-segmented language, which is
 * the only kind this is called for.
 */
export function phraseOccurrences(
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
): number {
  if (needle.length === 0 || haystack.length < needle.length) return 0;
  let found = 0;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) found++;
  }
  return found;
}

/**
 * Whether a field contains the keyword.
 *
 * Two rules, because the languages need two. Where words are separated, the
 * comparison is on tokens, so "cat" is not found inside "catalogue". Where
 * they are not, there are no token boundaries to respect and a substring is
 * the correct — and only available — test.
 */
export function containsKeyword(
  field: string,
  keyword: string,
  segmentsOnWhitespace: boolean,
): boolean {
  if (field.trim() === "") return false;
  if (!segmentsOnWhitespace) {
    return field.toLowerCase().includes(keyword.toLowerCase());
  }
  return phraseOccurrences(tokenize(field), tokenize(keyword)) > 0;
}

/**
 * What a keyword really is, once the tokenizer has had it.
 *
 * The fourth place a plausible implementation lies, and the one the header
 * above missed. Every match below is made on TOKENS, and `tokenize` keeps
 * only letters, digits and the connectors inside a word — so "C++" arrives
 * as the single word `c`, ".NET" as `net`, and "+++" as nothing at all. A
 * caller that is then told `"C++" is 7 of 56 words (12.5%), over the 3.0%
 * that reads as stuffing` has been handed a figure for a word its page never
 * contains: the tool validated one spelling and acted on another.
 *
 * So the tokens come back with the two facts a caller needs about them —
 * whether there is anything to search for at all, and whether what will be
 * searched for is the keyword or only what survived of it. Nothing downstream
 * may quote the raw keyword as though it had been looked for.
 */
export type KeywordRead =
  | { readonly kind: "unsearchable"; readonly reason: string }
  | {
      readonly kind: "words";
      readonly tokens: ReadonlyArray<string>;
      /** The tokens as they read back, e.g. `c` for the keyword "C++". */
      readonly searched: string;
      /** True when the tokens spell the keyword and nothing was lost. */
      readonly exact: boolean;
    };

export function readKeyword(keyword: string): KeywordRead {
  const tokens = tokenize(keyword);
  if (tokens.length === 0) {
    return {
      kind: "unsearchable",
      reason: `the keyword "${keyword}" holds no letters or digits, so there is no word to look for — matching here is word by word, and reporting that it "does not appear" would be a verdict on a search that never ran`,
    };
  }
  const searched = tokens.join(" ");
  return { kind: "words", tokens, searched, exact: searched === keyword.toLowerCase() };
}

// ---------------------------------------------------------------------------
// URLs and slugs.

/**
 * A URL reduced to the form two of them can be compared in.
 *
 * Case in the scheme and host is not meaningful, a fragment is never sent to
 * a server, and a trailing slash on a path is the single most common
 * "mismatch" that is not one. A query IS kept: `?page=2` is a different page.
 *
 * Every comparison downstream is made on the value this returns, never on
 * the string the page wrote — the point of parsing is to stop comparing
 * spellings.
 */
export function canonicalForm(url: URL): string {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
}

/**
 * The same reduction as `canonicalForm`, for two targets that are only paths.
 *
 * Two paths ARE comparable — neither carries a host to guess at — so the only
 * thing that stops the comparison is a MIXED pair, one absolute and one not.
 * Kept here beside `canonicalForm` so the trailing-slash rule is written once
 * rather than twice with a chance to drift.
 */
export function pathForm(target: { readonly pathname: string; readonly search: string }): string {
  const path = target.pathname.length > 1 ? target.pathname.replace(/\/+$/, "") : target.pathname;
  return `${path}${target.search}`;
}

export type ParsedTarget =
  | { readonly kind: "absolute"; readonly url: URL }
  /** `search` is kept beside the path because `/a?page=2` is not `/a`. */
  | { readonly kind: "path"; readonly pathname: string; readonly search: string }
  | { readonly kind: "unparsable"; readonly reason: string };

/** A caller-supplied or page-declared URL, as much of one as it really is. */
export function parseTarget(raw: string): ParsedTarget {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "unparsable", reason: "it is empty" };
  try {
    return { kind: "absolute", url: new URL(trimmed) };
  } catch {
    // Not absolute. A root-relative path is still enough to check a slug
    // with, and saying so beats calling a usable value unparsable.
  }
  if (trimmed.startsWith("/")) {
    // A fragment is never sent to a server, so it is dropped here; a query is
    // kept, because two paths that differ only in one are two pages and a
    // comparison that discarded it would call them the same.
    const withoutHash = trimmed.split("#")[0] ?? "";
    const query = withoutHash.indexOf("?");
    return query === -1
      ? { kind: "path", pathname: withoutHash, search: "" }
      : {
          kind: "path",
          pathname: withoutHash.slice(0, query),
          search: withoutHash.slice(query),
        };
  }
  return {
    kind: "unparsable",
    reason: "it is neither an absolute URL nor a path starting with /",
  };
}

export type SlugIssue = { readonly detail: string; readonly fix: string };

/**
 * What is wrong with the last segment of a path, mechanically.
 *
 * Only things that are decidable from the characters. "Too many stop words"
 * and "not descriptive enough" are not here: both are judgements, and a gate
 * that fails a build over one is a gate people turn off.
 */
export function slugIssues(pathname: string): SlugIssue[] {
  const segments = pathname.split("/").filter((s) => s !== "");
  const slug = segments[segments.length - 1] ?? "";
  const issues: SlugIssue[] = [];
  if (slug === "") return issues;
  if (/[A-Z]/.test(slug)) {
    issues.push({
      detail: `the slug "${slug}" has capital letters, and some servers treat /About and /about as two pages`,
      fix: "lowercase the slug",
    });
  }
  if (slug.includes("_")) {
    issues.push({
      detail: `the slug "${slug}" separates words with underscores`,
      fix: "use hyphens; search engines split on hyphens and not on underscores",
    });
  }
  if (/%20|\s|\+/.test(slug)) {
    issues.push({
      detail: `the slug "${slug}" contains an encoded or literal space`,
      fix: "replace spaces with hyphens",
    });
  }
  if (/--+/.test(slug)) {
    issues.push({
      detail: `the slug "${slug}" has a repeated hyphen`,
      fix: "collapse the hyphens",
    });
  }
  if (/\.(?:html?|php|aspx?|jsp)$/i.test(slug)) {
    issues.push({
      detail: `the slug "${slug}" ends in a file extension`,
      fix: "drop the extension if the server can route without it; this is cosmetic, not a ranking factor",
    });
  }
  if (slug.length > 75) {
    issues.push({
      detail: `the slug is ${slug.length} characters, which is long enough to be truncated in a shared link`,
      fix: "shorten it to the words that identify the page",
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// JSON-LD, and the honest limit of checking it offline.

export type SchemaRule = {
  readonly required: ReadonlyArray<string>;
  readonly recommended: ReadonlyArray<string>;
};

/**
 * The schema.org subsets this tool can check without a network.
 *
 * These are the required and recommended properties as the rich-result
 * documentation states them, bundled here because there is no way to fetch
 * schema.org offline. What this CANNOT check, at all, is whether a property
 * exists in schema.org's vocabulary, whether its value has the right type, or
 * whether a type not in this table is spelled correctly. A type that is not a
 * key here is reported as unchecked by name — never as valid.
 *
 * "Required" here means required for the rich result, which is a stricter and
 * more useful bar than schema.org's own (which requires almost nothing).
 */
export const SCHEMA_RULES: Readonly<Record<string, SchemaRule>> = {
  aggregateoffer: { required: ["lowPrice"], recommended: ["priceCurrency", "highPrice"] },
  aggregaterating: { required: ["ratingValue"], recommended: ["ratingCount", "reviewCount"] },
  answer: { required: ["text"], recommended: [] },
  article: {
    required: ["headline"],
    recommended: ["author", "datePublished", "image", "dateModified"],
  },
  blogposting: {
    required: ["headline"],
    recommended: ["author", "datePublished", "image", "dateModified"],
  },
  breadcrumblist: { required: ["itemListElement"], recommended: [] },
  event: { required: ["name", "startDate"], recommended: ["location", "endDate", "description"] },
  faqpage: { required: ["mainEntity"], recommended: [] },
  howto: { required: ["name", "step"], recommended: ["totalTime", "image"] },
  imageobject: { required: ["url"], recommended: ["width", "height"] },
  listitem: { required: ["position"], recommended: ["name", "item"] },
  newsarticle: {
    required: ["headline"],
    recommended: ["author", "datePublished", "image", "dateModified"],
  },
  offer: { required: ["price", "priceCurrency"], recommended: ["availability", "url"] },
  organization: { required: ["name"], recommended: ["url", "logo"] },
  person: { required: ["name"], recommended: ["url"] },
  product: { required: ["name"], recommended: ["image", "description", "offers", "sku"] },
  question: { required: ["name", "acceptedAnswer"], recommended: [] },
  recipe: {
    required: ["name", "recipeIngredient", "recipeInstructions"],
    recommended: ["image", "author", "totalTime"],
  },
  videoobject: {
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "duration"],
  },
  webpage: { required: ["name"], recommended: ["description"] },
  website: { required: ["name", "url"], recommended: [] },
};

/**
 * The bundled rule for a `@type`, or undefined when there is none.
 *
 * Looked up with `Object.hasOwn` rather than by indexing `SCHEMA_RULES`
 * directly. The table is an object literal, so it inherits from
 * `Object.prototype`, and a page whose `@type` is "constructor" or
 * "__proto__" finds a property there that is not a rule: `rule.required` is
 * then undefined, the `for…of` over it throws, and the whole lint dies on a
 * page it was asked to report on. Every type without a rule of its own
 * belongs in `notChecked` BY NAME — including those two.
 */
export function schemaRuleFor(type: string): SchemaRule | undefined {
  const key = type.toLowerCase();
  return Object.hasOwn(SCHEMA_RULES, key) ? SCHEMA_RULES[key] : undefined;
}

export type JsonLdNode = {
  /** Where the node sits, e.g. `block 1 -> @graph[2]`, for a location line. */
  readonly at: string;
  readonly node: Readonly<Record<string, unknown>>;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** How deep into nested nodes to walk, and how many to take. Both bounded so
 *  a hand-written blob cannot turn a lint into a traversal. */
const JSONLD_MAX_DEPTH = 6;
const JSONLD_MAX_NODES = 200;

/**
 * Every typed node inside one JSON-LD block, flattened.
 *
 * `@graph` and nested typed values (a Product's `offers`, a FAQPage's
 * `mainEntity`) are walked, because that is where the missing field usually
 * is. A node with no `@type` is still returned — "this node has no type" is
 * one of the findings.
 */
export function jsonLdNodes(block: unknown, at: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (out.length >= JSONLD_MAX_NODES || depth > JSONLD_MAX_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (!isObject(value)) return;
    const graph = value["@graph"];
    if (graph !== undefined) {
      // A node that only wraps a graph is a container, not a claim about a
      // thing, so it is walked through rather than checked.
      if (Object.keys(value).every((k) => k === "@graph" || k === "@context")) {
        visit(graph, `${path} -> @graph`, depth + 1);
        return;
      }
      visit(graph, `${path} -> @graph`, depth + 1);
    }
    out.push({ at: path, node: value });
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@")) continue;
      const items = Array.isArray(child) ? child : [child];
      for (const [i, item] of items.entries()) {
        if (!isObject(item) || item["@type"] === undefined) continue;
        visit(item, `${path} -> ${key}${Array.isArray(child) ? `[${i}]` : ""}`, depth + 1);
      }
    }
  };
  visit(block, at, 0);
  return out;
}

/** The `@type` of a node as a comparable string, or undefined. A node may
 *  declare several; the first is the one the rules are looked up by. */
export function typeOf(node: Readonly<Record<string, unknown>>): string | undefined {
  const raw = node["@type"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : undefined;
}

/** True when the node's `@context` names schema.org, in any of its shapes. */
export function declaresSchemaOrg(node: Readonly<Record<string, unknown>>): boolean {
  const context = node["@context"];
  if (context === undefined) return false;
  return JSON.stringify(context).toLowerCase().includes("schema.org");
}

/** True when a property is present and not an empty string or empty array. */
export function hasValue(node: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = node[key];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Anchor text.

/** Anchor text that tells a reader — and a crawler — nothing about the target. */
const UNINFORMATIVE: ReadonlySet<string> = new Set([
  "click",
  "click here",
  "continue",
  "details",
  "download",
  "find out more",
  "go",
  "here",
  "info",
  "learn more",
  "link",
  "more",
  "read more",
  "see more",
  "this",
  "this link",
  "this page",
]);

/**
 * True when anchor text is one of the phrases that names no destination.
 *
 * The trailing run of non-letters is dropped rather than a named list of
 * characters: "Read more »", "Read more →" and "Read more..." are the same
 * anchor, and enumerating the decorations means missing the next one. `\s`
 * already covers the non-breaking space such text is usually padded with, so
 * nothing in here is an invisible literal.
 */
export function isUninformativeAnchor(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .trim();
  return UNINFORMATIVE.has(normalized);
}

/** True when an `alt` is just the file's name, which describes nothing. */
export function altIsFilename(alt: string, src: string): boolean {
  const trimmed = alt.trim();
  if (trimmed === "") return false;
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(trimmed)) return true;
  const file = (src.split(/[?#]/)[0] ?? "").split("/").pop() ?? "";
  const stem = file.replace(/\.[a-z0-9]+$/i, "");
  return stem !== "" && stem.toLowerCase() === trimmed.toLowerCase();
}

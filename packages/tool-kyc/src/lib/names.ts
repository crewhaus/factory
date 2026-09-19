/**
 * The bridge to `@crewhaus/tool-text`, which owns the matching.
 *
 * Jaro-Winkler, the token comparison and the Unicode hygiene are NOT
 * re-implemented here. A second name matcher in this package would be a second
 * answer to "how close are these two names", and the two would disagree
 * exactly where it costs most — a screening tool that scores 0.86 while the
 * text tool scores 0.84 puts a person on or off a review queue depending on
 * which module was asked.
 *
 * They arrive as TOOLS rather than as functions because `tool-text` publishes
 * its matcher as `FuzzyMatch` and its normalizer as `NormalizeText`; its module
 * surface is `RegisteredTool`s plus the diff parser. So this file calls those
 * tools' `execute` and parses the JSON they return, the way
 * `@crewhaus/tool-token` and `@crewhaus/tool-chaincall` call `tool-onchain`'s.
 * That makes these wrappers `async` for work that is pure — a real cost, paid
 * once per name rather than once per character pair, and cheaper than a second
 * Jaro-Winkler.
 *
 * What this file DOES own is the part that is specific to names on a sanctions
 * list: folding diacritics, dropping legal suffixes, and weighting tokens. That
 * is scoring policy, not a matcher.
 */
import { fuzzyMatch, normalizeText } from "@crewhaus/tool-text";

/** `FuzzyMatch`'s published schema caps candidates per call and hits per call. */
const MAX_CANDIDATES_PER_CALL = 10_000;
export const MAX_HITS_PER_CALL = 100;

/**
 * `ToolExecuteResult` is a union of a string and a structured content block.
 * Both of these tools return the string arm; anything else means the tool
 * changed shape underneath us, and saying so beats a cast that decodes
 * garbage.
 */
async function textResult(result: unknown, tool: string): Promise<string> {
  const value = await result;
  if (typeof value !== "string") throw new Error(`${tool} did not return a string result`);
  return value;
}

/**
 * Legal forms, stripped from an ORGANISATION's name before comparison.
 *
 * "Acme Ltd" and "ACME LIMITED" are the same company, and a token-weighted
 * score that counts "ltd" as a shared token inflates every comparison between
 * two British companies. Dropped suffixes are recorded rather than discarded,
 * because "which tokens did you actually compare" is half of a match basis.
 *
 * The list is deliberately short and covers the forms that are genuinely
 * interchangeable with nothing. It is NOT applied to people: "Inc" is not a
 * legal form in "Ali Inc." when the subject is a person, and more to the point
 * a person's name can legitimately be any word at all.
 */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "ab",
  "ag",
  "ao",
  "aps",
  "as",
  "bv",
  "cia",
  "co",
  "company",
  "corp",
  "corporation",
  "eood",
  "gmbh",
  "inc",
  "incorporated",
  "kft",
  "kk",
  "limited",
  "llc",
  "llp",
  "lp",
  "ltd",
  "ltda",
  "nv",
  "ooo",
  "oy",
  "oyj",
  "pao",
  "plc",
  "pt",
  "pte",
  "pty",
  "sa",
  "sarl",
  "sas",
  "spa",
  "srl",
  "zao",
]);

export type CanonicalName = {
  /** Exactly what was passed in. */
  readonly input: string;
  /** Folded, punctuation-free, space-collapsed. The string that is compared. */
  readonly canonical: string;
  readonly tokens: ReadonlyArray<string>;
  /** Legal forms removed, in the order they appeared. */
  readonly droppedSuffixes: ReadonlyArray<string>;
  /**
   * True when the input carried zero-width or bidirectional control
   * characters. Those survive copy-paste, break equality silently, and are an
   * obvious way to make a name miss a list it should hit — so their removal is
   * reported rather than done quietly.
   */
  readonly hadInvisibleCharacters: boolean;
};

/** Combining marks, i.e. what NFD peels off a letter. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * The Latin letters NFD cannot help with.
 *
 * NFD + strip-marks folds é to e because the accent is a separate combining
 * character. It does nothing for a letter whose modification is part of the
 * glyph: ø, đ, ł, æ, ß and þ are single code points with no
 * decomposition, so "Ødegård" would keep its ø and never match the "Odegard"
 * spelling the same list publishes two lines further down. Each mapping here is
 * the transliteration the publishers themselves use.
 */
const UNFOLDABLE_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  "\u00f8": "o",
  "\u0153": "oe",
  "\u00e6": "ae",
  "\u00df": "ss",
  "\u00fe": "th",
  "\u00f0": "d",
  "\u0111": "d",
  "\u0142": "l",
  "\u0131": "i",
  "\u0127": "h",
  "\u0167": "t",
  "\u014b": "n",
  "\u0259": "e",
});

function foldUnfoldable(text: string): string {
  let out = "";
  for (const ch of text) out += UNFOLDABLE_LETTERS[ch] ?? ch;
  return out;
}

/** Everything that is not a letter or a digit becomes a token break. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * Canonicalize one name for comparison.
 *
 * Step one is `tool-text`'s `NormalizeText` (NFKC, invisibles stripped,
 * lowercased). Step two is the part it deliberately does not do: folding
 * diacritics. That asymmetry is correct in both places — for a diff, "resume"
 * and "résumé" are two different files and folding them would hide a real
 * change; for a name they are one person, and the sanctions lists themselves
 * publish both spellings.
 */
export async function canonicalizeName(
  raw: string,
  options: { readonly dropLegalSuffixes?: boolean } = {},
): Promise<CanonicalName> {
  const normalized = JSON.parse(
    await textResult(
      normalizeText.execute({
        text: raw,
        stripInvisible: true,
        unicode: "NFKC",
        lowercase: true,
        trimTrailingWhitespace: true,
      }),
      "NormalizeText",
    ),
  ) as { text: string; changed: boolean };

  const folded = foldUnfoldable(normalized.text.normalize("NFD").replace(COMBINING_MARKS, ""))
    .replace(NON_ALPHANUMERIC, " ")
    .trim();

  const all = folded.split(" ").filter((t) => t.length > 0);
  const dropped: string[] = [];
  let tokens = all;
  if (options.dropLegalSuffixes === true) {
    const kept = all.filter((t) => {
      if (!LEGAL_SUFFIXES.has(t)) return true;
      dropped.push(t);
      return false;
    });
    // A name that is NOTHING but legal forms keeps them. "Limited" on its own
    // is a name, and dropping every token leaves an empty string that matches
    // everything at trigram distance.
    tokens = kept.length > 0 ? kept : all;
    if (kept.length === 0) dropped.length = 0;
  }

  return {
    input: raw,
    canonical: tokens.join(" "),
    tokens,
    droppedSuffixes: dropped,
    // `NormalizeText` reports whether it changed anything at all, which for
    // these options means invisibles, a Unicode form or case. Case alone is
    // not interesting, so the raw text is re-checked for the characters that
    // are.
    hadInvisibleCharacters: hasInvisibleCharacters(raw),
  };
}

/**
 * Zero-width, bidirectional-control and soft-hyphen characters, by code point.
 *
 * Written as code points rather than as a character-class RANGE because a
 * range spanning the zero-width joiner can split a joined sequence — the same
 * reason `tool-text`'s own normalizer builds its pattern this way. They matter
 * here for a sharper reason than tidiness: a bidi override inside a supplied
 * name is a way to make that name miss a list it should hit.
 */
const INVISIBLE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

export function hasInvisibleCharacters(text: string): boolean {
  for (const ch of text) {
    if (INVISIBLE_CODE_POINTS.has(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

export type RankedName = {
  readonly candidate: string;
  readonly score: number;
  readonly index: number;
};

export type RankedNames = {
  readonly hits: ReadonlyArray<RankedName>;
  /**
   * True when a chunk came back holding exactly as many hits as `FuzzyMatch`
   * is allowed to return, so there are probably names past the cut this call
   * never saw.
   *
   * It is reported rather than inferred by the caller because the caller
   * cannot infer it. Asking for `limit` hits and counting fewer than `limit`
   * back looks like "nothing was dropped" and is wrong whenever `limit` is
   * over `MAX_HITS_PER_CALL`: the per-call cap bites first, silently, and the
   * caller's own comparison can never be true. A cap that only reports itself
   * when it happens to be under another cap is not a report.
   */
  readonly capped: boolean;
};

/**
 * Rank `candidates` against `query` through `tool-text`'s `FuzzyMatch`.
 *
 * Candidates are chunked to the size that tool's own schema permits. The
 * schema is not enforced by `execute`, so nothing would stop a 200 000-name
 * list going through in one call — but a published limit that callers honour
 * only when something checks is not a limit, and chunking costs one extra
 * function call per ten thousand names.
 */
export async function rankNamesCapped(
  query: string,
  candidates: ReadonlyArray<string>,
  minScore: number,
  limit: number,
  method: "jaro" | "trigram" | "levenshtein" | "tokenJaccard" = "jaro",
): Promise<RankedNames> {
  const perCall = Math.min(limit, MAX_HITS_PER_CALL);
  const hits: RankedName[] = [];
  let capped = false;
  for (let start = 0; start < candidates.length; start += MAX_CANDIDATES_PER_CALL) {
    const chunk = candidates.slice(start, start + MAX_CANDIDATES_PER_CALL);
    if (chunk.length === 0) break;
    const out = JSON.parse(
      await textResult(
        fuzzyMatch.execute({ query, candidates: chunk, method, minScore, limit: perCall }),
        "FuzzyMatch",
      ),
    ) as { hits: Array<{ candidate: string; score: number; index: number }> };
    if (out.hits.length >= perCall) capped = true;
    for (const hit of out.hits) hits.push({ ...hit, index: start + hit.index });
  }
  // Ties break on the ORIGINAL index so two runs over the same list produce
  // the same order. A shortlist whose order depends on chunk boundaries is a
  // diff that changes for no reason.
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return { hits: hits.slice(0, limit), capped };
}

/** `rankNamesCapped` for the callers that ask for one hit and cannot truncate. */
export async function rankNames(
  query: string,
  candidates: ReadonlyArray<string>,
  minScore: number,
  limit: number,
  method: "jaro" | "trigram" | "levenshtein" | "tokenJaccard" = "jaro",
): Promise<RankedName[]> {
  return [...(await rankNamesCapped(query, candidates, minScore, limit, method)).hits];
}

/**
 * Every candidate's score against `query`, in the candidates' own order.
 *
 * Chunked at the HITS cap rather than the candidates cap, so every chunk can
 * return all of itself; asking for more hits than a call may give back is how
 * a "score them all" helper silently returns zeros for the tail.
 */
export async function scoreEach(
  query: string,
  candidates: ReadonlyArray<string>,
  method: "jaro" | "trigram" | "levenshtein" | "tokenJaccard" = "jaro",
): Promise<number[]> {
  const scores = new Array<number>(candidates.length).fill(0);
  for (let start = 0; start < candidates.length; start += MAX_HITS_PER_CALL) {
    const chunk = candidates.slice(start, start + MAX_HITS_PER_CALL);
    if (chunk.length === 0) break;
    const out = JSON.parse(
      await textResult(
        fuzzyMatch.execute({
          query,
          candidates: chunk,
          method,
          minScore: 0,
          limit: chunk.length,
        }),
        "FuzzyMatch",
      ),
    ) as { hits: Array<{ index: number; score: number }> };
    for (const hit of out.hits) scores[start + hit.index] = hit.score;
  }
  return scores;
}

/** One token of the subject's name, aligned against its best partner. */
export type TokenAlignment = {
  readonly subjectToken: string;
  /** The entry token it aligned with, or null when nothing scored high enough. */
  readonly entryToken: string | null;
  readonly score: number;
  /** How much this token counts: rarer across the list means heavier. */
  readonly weight: number;
};

/**
 * Below this, two tokens are not the same word. 0.85 on Jaro-Winkler keeps
 * mohamed/mohammed and abdulaziz/abdelaziz together while keeping hassan and
 * hussein apart — which is the pair the naive threshold gets wrong in both
 * directions.
 */
export const TOKEN_ALIGNMENT_FLOOR = 0.85;

/**
 * Align each subject token to its best partner in the entry's tokens, and
 * weight the result by how rare each token is across the list.
 *
 * This is the correction to a flat token-set ratio. On a list where half the
 * entries contain "mohammed", matching that token is worth almost nothing and
 * matching a rare surname is worth almost everything; scoring them equally is
 * what floods an operator with false positives on common given names while
 * still missing the transliteration pairs.
 */
export async function alignTokens(
  subjectTokens: ReadonlyArray<string>,
  entryTokens: ReadonlyArray<string>,
  weightOf: (token: string) => number,
): Promise<{ alignments: TokenAlignment[]; score: number }> {
  const alignments: TokenAlignment[] = [];
  for (const token of subjectTokens) {
    const weight = weightOf(token);
    if (entryTokens.length === 0) {
      alignments.push({ subjectToken: token, entryToken: null, score: 0, weight });
      continue;
    }
    const [best] = await rankNames(token, entryTokens, 0, 1);
    const aligned = best !== undefined && best.score >= TOKEN_ALIGNMENT_FLOOR;
    alignments.push({
      subjectToken: token,
      entryToken: aligned ? (best?.candidate ?? null) : null,
      score: aligned ? round6(best?.score ?? 0) : 0,
      weight: round6(weight),
    });
  }
  const totalWeight = alignments.reduce((sum, a) => sum + a.weight, 0);
  const earned = alignments.reduce((sum, a) => sum + a.weight * a.score, 0);
  return { alignments, score: totalWeight === 0 ? 0 : round6(earned / totalWeight) };
}

/** Six places is past any threshold anybody sets and keeps JSON stable. */
export function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Inverse document frequency over the list's own names.
 *
 * Computed from the lists being screened against, never from a fixed table:
 * "bank" is a common token on a Russian-sector list and a rare one on a
 * vessel list, and a weight that does not come from the corpus in front of it
 * is a guess.
 */
export function buildTokenWeights(
  documents: ReadonlyArray<ReadonlyArray<string>>,
): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = Math.max(1, documents.length);
  const weights = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    weights.set(token, Math.log(1 + total / frequency));
  }
  return weights;
}

/**
 * The weight for a token the list has never seen.
 *
 * `log(1 + N/1)` — the weight of a token that appears exactly once — because
 * a subject token absent from the whole list is at least as distinctive as the
 * rarest token in it. Treating it as weightless would let an unmatched rare
 * surname cost nothing.
 */
export function unseenTokenWeight(documentCount: number): number {
  return Math.log(1 + Math.max(1, documentCount));
}

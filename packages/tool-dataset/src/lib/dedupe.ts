/**
 * Is this mined candidate already in the dataset?
 *
 * Three questions, in increasing cost and decreasing certainty:
 *
 *   1. IS ITS ID ALREADY THERE? Mined ids are deterministic
 *      (`mine_<signal>_<session>_t<turn>`), so re-mining the same sessions
 *      re-proposes the same ids. An exact set membership settles it.
 *   2. IS ITS CONTENT ALREADY THERE? `hashSample` — the registry's own
 *      per-sample identity, not a second digest — catches the same sample
 *      promoted under a different id, and the tokenized input catches the
 *      same question carrying different provenance metadata.
 *   3. IS SOMETHING LIKE IT ALREADY THERE? The valuable one, and the only
 *      one that is not a lookup: all-pairs similarity over a 50k-row registry
 *      is 50k comparisons PER CANDIDATE.
 *
 * QUESTION 3 IS BLOCKED, AND THE BLOCKING PARAMETERS — NOT THE THRESHOLD —
 * DETERMINE WHAT IT FINDS. Each existing sample is indexed under its
 * {@link DEFAULT_DEDUPE_PARAMS}.tokensIndexedPerSample rarest tokens (rarest
 * by document frequency across the corpus, ties broken lexicographically), and
 * a token appearing in more than `maxPostingsPerToken` samples is dropped from
 * the index as carrying no signal. A candidate is compared only against
 * samples that share one of those indexed tokens. Raising the threshold makes
 * the tool stricter about what counts as a duplicate; it does NOT make the
 * tool look at more pairs. A pair whose overlap is entirely in common tokens —
 * two differently-worded questions about the same very common subject — is
 * never scored at all, at any threshold. Whoever tunes this later should tune
 * `tokensIndexedPerSample` upward (more index entries, more comparisons, more
 * recall), not the threshold downward.
 *
 * THE SCORER IS `@crewhaus/dataset-ops`'S OWN, NOT A SECOND ONE. `tokenOverlap`
 * over `normalizedTokens` is exactly what the `near-duplicate-input` lint rule
 * measures, so a pair this tool calls new is a pair `DatasetLint` will not
 * flag the moment it is written. A tokenizer that merely LOOKS equivalent is
 * not good enough: the text package's `tokenize` keeps hyphens and
 * apostrophes, so "reset the well-known config" vs "reset the well known
 * config" scores 1.00 under the lint rule and 0.62 under that one — one tool
 * proposing a candidate as new while the other flags it as a duplicate of the
 * row that candidate just became. The index is built on the SAME tokenizer as
 * the scorer, because an index built on a different one cannot bound what the
 * scorer would have found.
 */
import { NEAR_DUP_THRESHOLD, normalizedTokens, tokenOverlap } from "@crewhaus/dataset-ops";
import { hashSample } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { compareStrings } from "./result";

export type DedupeParams = {
  /** Banding width: how many of each sample's rarest tokens are indexed. */
  readonly tokensIndexedPerSample: number;
  /** A token in more samples than this is not selective enough to index. */
  readonly maxPostingsPerToken: number;
  /** Token-Jaccard at or above which a candidate is a near-duplicate. */
  readonly threshold: number;
};

/**
 * The defaults. `threshold` is `@crewhaus/dataset-ops`'s own
 * `NEAR_DUP_THRESHOLD`, so "near-duplicate" means the same thing here as it
 * does in `DatasetLint`'s near-duplicate rule — two tools that disagree about
 * what a duplicate is are worse than one tool.
 */
export const DEFAULT_DEDUPE_PARAMS: DedupeParams = {
  tokensIndexedPerSample: 4,
  maxPostingsPerToken: 200,
  threshold: NEAR_DUP_THRESHOLD,
};

/** How many existing samples one call will index. */
export const MAX_INDEXED_SAMPLES = 50_000;

export type IndexedSample = {
  readonly id: string;
  readonly version: string;
  readonly input: string;
};

export type DedupeIndex = {
  readonly ids: ReadonlySet<string>;
  readonly contentHashes: ReadonlyMap<string, string>;
  readonly tokenizedInputs: ReadonlyMap<string, string>;
  readonly postings: ReadonlyMap<string, string[]>;
  readonly byId: ReadonlyMap<string, IndexedSample>;
  readonly params: DedupeParams;
  readonly indexed: number;
  /** True when {@link MAX_INDEXED_SAMPLES} cut the corpus — every "new"
   *  verdict is then a verdict about the indexed PREFIX. */
  readonly truncated: boolean;
  readonly versions: string[];
};

/** The normalized form two inputs must share to count as textually identical:
 *  the scorer's own token set, joined. Same tokenizer, same notion of "same" —
 *  and because the scorer is set-valued, two inputs sharing this key already
 *  score 1.0, so the cheap check can never contradict the expensive one. */
function tokenKey(input: string): string {
  return [...normalizedTokens(input)].join(" ");
}

export function buildDedupeIndex(
  corpus: ReadonlyArray<IndexedSample & { readonly sample: Sample }>,
  params: DedupeParams = DEFAULT_DEDUPE_PARAMS,
  maxIndexed: number = MAX_INDEXED_SAMPLES,
): DedupeIndex {
  const slice = corpus.slice(0, maxIndexed);
  const ids = new Set<string>();
  const contentHashes = new Map<string, string>();
  const tokenizedInputs = new Map<string, string>();
  const byId = new Map<string, IndexedSample>();
  const tokensById = new Map<string, string[]>();
  const df = new Map<string, number>();
  const versions = new Set<string>();

  for (const entry of slice) {
    ids.add(entry.id);
    versions.add(entry.version);
    byId.set(entry.id, { id: entry.id, version: entry.version, input: entry.input });
    const hash = hashSample(entry.sample);
    if (!contentHashes.has(hash)) contentHashes.set(hash, entry.id);
    const key = tokenKey(entry.input);
    if (!tokenizedInputs.has(key)) tokenizedInputs.set(key, entry.id);
    const tokens = [...normalizedTokens(entry.input)];
    tokensById.set(entry.id, tokens);
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const postings = new Map<string, string[]>();
  for (const [id, tokens] of tokensById) {
    const rarest = [...tokens]
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || compareStrings(a, b))
      .slice(0, params.tokensIndexedPerSample);
    for (const t of rarest) {
      const list = postings.get(t);
      if (list === undefined) postings.set(t, [id]);
      else list.push(id);
    }
  }
  // A token that indexes half the corpus costs a full scan and rules nothing
  // out; dropping it is what keeps this sub-linear.
  for (const [token, list] of postings) {
    if (list.length > params.maxPostingsPerToken) postings.delete(token);
  }

  return {
    ids,
    contentHashes,
    tokenizedInputs,
    postings,
    byId,
    params,
    indexed: slice.length,
    truncated: corpus.length > slice.length,
    versions: [...versions].sort(compareStrings),
  };
}

export type DedupeVerdict =
  | { readonly verdict: "new" }
  | {
      readonly verdict: "duplicate-id" | "duplicate-content" | "near-duplicate";
      readonly matchedId: string;
      readonly matchedVersion: string;
      /** Present only for `near-duplicate` — the measured token overlap. */
      readonly score?: number;
    };

export type ClassifyResult = {
  readonly verdict: DedupeVerdict;
  /** Pairs actually scored, so a caller can see what the blocking saved. */
  readonly comparisons: number;
};

/**
 * Classify one candidate against the index. `nearDuplicates: false` answers
 * questions 1 and 2 only — and the caller must then report that question 3
 * was not asked rather than reporting the candidate as new.
 */
export function classifyCandidate(
  index: DedupeIndex,
  candidate: Sample,
  nearDuplicates = true,
): ClassifyResult {
  if (index.ids.has(candidate.id)) {
    const hit = index.byId.get(candidate.id);
    return {
      verdict: {
        verdict: "duplicate-id",
        matchedId: candidate.id,
        matchedVersion: hit?.version ?? "unknown",
      },
      comparisons: 0,
    };
  }
  const contentHit = index.contentHashes.get(hashSample(candidate));
  const textHit = contentHit ?? index.tokenizedInputs.get(tokenKey(candidate.input));
  if (textHit !== undefined) {
    return {
      verdict: {
        verdict: "duplicate-content",
        matchedId: textHit,
        matchedVersion: index.byId.get(textHit)?.version ?? "unknown",
      },
      comparisons: 0,
    };
  }
  if (!nearDuplicates) return { verdict: { verdict: "new" }, comparisons: 0 };

  const candidateTokens = normalizedTokens(candidate.input);
  const seen = new Set<string>();
  for (const token of candidateTokens) {
    for (const id of index.postings.get(token) ?? []) seen.add(id);
  }
  let best: { id: string; score: number } | undefined;
  let comparisons = 0;
  for (const id of seen) {
    const other = index.byId.get(id);
    if (other === undefined) continue;
    comparisons += 1;
    const score = tokenOverlap(candidateTokens, normalizedTokens(other.input));
    if (score >= index.params.threshold && (best === undefined || score > best.score)) {
      best = { id, score };
    }
  }
  if (best === undefined) return { verdict: { verdict: "new" }, comparisons };
  return {
    verdict: {
      verdict: "near-duplicate",
      matchedId: best.id,
      matchedVersion: index.byId.get(best.id)?.version ?? "unknown",
      score: Number(best.score.toFixed(3)),
    },
    comparisons,
  };
}

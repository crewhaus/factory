/**
 * Sanctions screening: candidates and evidence, never a verdict.
 *
 * Three decisions shape this file, and all three are deliberate departures
 * from what a screening tool is usually asked for.
 *
 * 1. **No verdict.** A sanctions match is a legal determination with legal
 *    consequences, and it is made by a person. This returns the candidates it
 *    found, the basis for each one, and the version of every list it read. The
 *    shipped precedent is `@crewhaus/tool-money`'s `RefundAbuseCheck`, which
 *    returns ratios and counts and says "a person decides" — same reasoning,
 *    higher stakes.
 *
 * 2. **The evidence is the product.** The score is the least trustworthy thing
 *    here: the lists carry transliterations of names that were never written in
 *    the Latin alphabet, and aliases the publisher itself marks as low quality.
 *    What survives an audit two years later is not "0.87", it is "screened
 *    against OFAC SDN version 20260901, published 2026-09-01, retrieved
 *    2026-09-02". So a list that cannot say what version it is gets REFUSED,
 *    and the whole screen fails rather than quietly producing a number.
 *
 * 3. **Nothing leaves the machine.** Screening happens locally against a
 *    snapshot the operator holds. A counterparty's name sent to a third-party
 *    screening API is a disclosure of who you are about to pay, to somebody who
 *    did not need to know — and this package has no endpoint for it.
 */
import {
  type CanonicalName,
  MAX_HITS_PER_CALL,
  TOKEN_ALIGNMENT_FLOOR,
  type TokenAlignment,
  alignTokens,
  buildTokenWeights,
  canonicalizeName,
  rankNamesCapped,
  round6,
  scoreEach,
  unseenTokenWeight,
} from "./names";

export type AliasQuality = "strong" | "weak";

export type ListAlias = {
  readonly name: string;
  /**
   * The publisher's own quality mark. OFAC publishes "weak" aliases — partial
   * names, nicknames, spellings it is not confident in — and says in its own
   * guidance that a weak-alias hit alone is not a reason to act.
   */
  readonly quality?: AliasQuality;
};

export type ListEntry = {
  readonly id: string;
  readonly name: string;
  readonly kind?: "person" | "entity" | "vessel" | "aircraft" | "unknown";
  readonly aliases?: ReadonlyArray<ListAlias>;
  readonly countries?: ReadonlyArray<string>;
  readonly datesOfBirth?: ReadonlyArray<string>;
  readonly programs?: ReadonlyArray<string>;
  readonly remarks?: string;
};

export type ListSnapshot = {
  /** The publisher and list, e.g. "OFAC SDN". */
  readonly source: string;
  /** The publisher's own version or issue id. Required. */
  readonly version: string;
  /** When the publisher published it. Required, ISO-8601 with an offset. */
  readonly publishedAt: string;
  /** When this copy was taken. Required, ISO-8601 with an offset. */
  readonly retrievedAt: string;
  readonly sourceUrl?: string;
  readonly entries: ReadonlyArray<ListEntry>;
};

export type Subject = {
  readonly id: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly kind?: "person" | "entity";
  readonly country?: string;
  readonly dateOfBirth?: string;
};

export type ScreenPolicy = {
  /** The score at or above which a candidate is reported. */
  readonly threshold: number;
  /** How many candidates to report per subject. */
  readonly limit: number;
  readonly includeWeakAliases: boolean;
};

/**
 * The first pass is a FILTER, not a score.
 *
 * It is set loose on purpose: the whole-string comparison and the weighted
 * token comparison disagree, and the token pass routinely raises a pair the
 * string pass scored 0.6 — that is the entire reason the token pass exists.
 * Filtering at the reporting threshold would throw those away before they were
 * scored properly.
 *
 * A loose floor is NOT enough on its own, which cost this file a false clean.
 * Jaro-Winkler scores "kharoubi" against "mohammed kharoubi" at 0.35 — no
 * usable floor is below that — because its prefix bonus rewards names that
 * begin alike, so a subject supplied as a surname scored 0.35 and a subject
 * supplied as the same person's given name scored 0.89. Screening by surname
 * returned no candidate, no near miss and no truncation flag, on a person who
 * was on the list. Containment is exactly what the two-direction token scorer
 * below exists to handle, and it never ran, because the name never reached it.
 * So the shortlist is a UNION of this pass and `shortlistByToken`.
 */
export const PREFILTER_FLOOR = 0.5;
/** How many survivors per subject go through to the expensive pass, per pass. */
export const PREFILTER_WIDTH = 5;

/** One name on a list, already canonicalized, with where it came from. */
type IndexedName = {
  readonly listIndex: number;
  readonly entryIndex: number;
  readonly matchedName: string;
  readonly matchedOn: "primary" | "alias";
  readonly quality: AliasQuality;
  readonly canonical: CanonicalName;
};

export type Corroboration = {
  readonly country: string;
  readonly dateOfBirth: string;
  /**
   * Always false. Most list entries carry neither a country nor a date of
   * birth, so letting a mismatch lower a score would clear true hits for the
   * entries that are least complete — which are the older and more serious
   * ones. Corroboration is for the human reading the candidate.
   */
  readonly usedForScoring: false;
};

export type Candidate = {
  readonly list: string;
  readonly listVersion: string;
  readonly entryId: string;
  readonly entryName: string;
  readonly entryKind: string;
  readonly matchedName: string;
  readonly matchedOn: "primary" | "alias";
  readonly aliasQuality: AliasQuality;
  readonly score: number;
  readonly scoreForward: number;
  readonly scoreReverse: number;
  readonly scoreWholeString: number;
  readonly alignments: ReadonlyArray<TokenAlignment>;
  readonly droppedSuffixes: ReadonlyArray<string>;
  readonly corroboration: Corroboration;
  readonly programs: ReadonlyArray<string>;
};

export type SubjectResult = {
  readonly subjectId: string;
  readonly name: string;
  readonly canonical: string;
  readonly namesCompared: number;
  readonly shortlisted: number;
  readonly candidates: ReadonlyArray<Candidate>;
  /** Weak-alias hits, kept apart on purpose. */
  readonly weakAliasCandidates: ReadonlyArray<Candidate>;
  /** The best score that did NOT reach the threshold, or null if there was none. */
  readonly bestScoreBelowThreshold: number | null;
  readonly note?: string;
  /** True when the first pass filled its cap, so lower-scoring names were not re-scored. */
  readonly prefilterTruncated?: boolean;
};

export type ListEvidence = {
  readonly source: string;
  readonly version: string;
  readonly publishedAt: string;
  readonly retrievedAt: string;
  readonly sourceUrl?: string;
  readonly entries: number;
  readonly names: number;
  readonly ageDays: number;
};

export type ScreenResult = {
  readonly evidence: {
    readonly screenedAt: string;
    readonly lists: ReadonlyArray<ListEvidence>;
    readonly policy: ScreenPolicy & { readonly matcher: string; readonly normalisation: string };
  };
  readonly subjects: ReadonlyArray<SubjectResult>;
  readonly note: string;
};

const DAY_MS = 86_400_000;

/** Why a snapshot cannot be screened against. Returned, not thrown. */
export type SnapshotRefusal = { readonly list: string; readonly reason: string };

/**
 * Check a snapshot carries the evidence a screening needs to be worth anything.
 *
 * A list with no version is not a cheaper list, it is an unusable one: the
 * result it produces cannot be reproduced, defended or dated. The staleness
 * check is the same argument in the other direction — "no matches" against a
 * list from March is a sentence about March.
 */
export function checkSnapshot(
  snapshot: ListSnapshot,
  nowMs: number,
  maxAgeDays: number,
): SnapshotRefusal | { readonly ageDays: number } {
  const label = `${snapshot.source} ${snapshot.version}`.trim();
  let publishedMs: number;
  let retrievedMs: number;
  try {
    publishedMs = requireInstant(snapshot.publishedAt, `${label}: publishedAt`);
    retrievedMs = requireInstant(snapshot.retrievedAt, `${label}: retrievedAt`);
  } catch (err) {
    return { list: label, reason: (err as Error).message };
  }
  if (snapshot.entries.length === 0) {
    return {
      list: label,
      reason: `${label} has no entries — an empty list produces "no candidates" for every subject, which reads exactly like a clean screen`,
    };
  }
  // The two orderings a real snapshot cannot break, checked BEFORE the age.
  //
  // Age is clamped at zero, so a publishedAt in the future — a mistyped year
  // in the file, a wrong clock where the copy was taken — made the staleness
  // gate vacuous and permanent: `ageDays: 0` for ever, on the evidence record,
  // reading as "published today". A control that cannot be evaluated must not
  // count as one that held. These two comparisons catch it without inventing a
  // tolerance, because they are facts about the snapshot rather than about how
  // stale it is allowed to be.
  if (publishedMs > retrievedMs) {
    return {
      list: label,
      reason: `${label} says it was published at ${snapshot.publishedAt} and retrieved at ${snapshot.retrievedAt} — a copy cannot predate the thing it is a copy of, so one of the two dates is wrong and the age computed from them would be meaningless`,
    };
  }
  if (retrievedMs > nowMs) {
    return {
      list: label,
      reason: `${label} says it was retrieved at ${snapshot.retrievedAt}, which is after the screening ran — either the clock is wrong or this is a replay against a list that did not exist yet, and a screen dated before its own evidence proves nothing`,
    };
  }
  const ageDays = Math.max(0, Math.floor((nowMs - publishedMs) / DAY_MS));
  if (maxAgeDays > 0 && ageDays > maxAgeDays) {
    return {
      list: label,
      reason: `${label} was published ${ageDays} days ago, over the ${maxAgeDays}-day limit — these lists change on business days, so screening against this one would date the answer to ${snapshot.publishedAt}. Refresh it, or raise maxAgeDays deliberately.`,
    };
  }
  return { ageDays };
}

function requireInstant(value: string, field: string): number {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    throw new Error(
      `${field} ("${value}") has no UTC offset — an offset-less timestamp means local time, and the date on a screening record is the part that matters later`,
    );
  }
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed))
    throw new Error(`${field} ("${value}") is not a valid ISO-8601 instant`);
  return parsed;
}

/**
 * Legal suffixes come off organisations, never people.
 *
 * "Co" is a legal form in "Hanjin Shipping Co" and a syllable in a person's
 * name; an entry whose kind is unknown is treated as an organisation because
 * the lists that omit the field are entity-heavy vessel and company lists.
 */
function dropsSuffixes(kind: string | undefined): boolean {
  return kind !== "person";
}

async function indexList(
  snapshot: ListSnapshot,
  listIndex: number,
): Promise<{ names: IndexedName[] }> {
  const names: IndexedName[] = [];
  for (let entryIndex = 0; entryIndex < snapshot.entries.length; entryIndex++) {
    const entry = snapshot.entries[entryIndex] as ListEntry;
    const drop = dropsSuffixes(entry.kind);
    names.push({
      listIndex,
      entryIndex,
      matchedName: entry.name,
      matchedOn: "primary",
      quality: "strong",
      canonical: await canonicalizeName(entry.name, { dropLegalSuffixes: drop }),
    });
    for (const alias of entry.aliases ?? []) {
      names.push({
        listIndex,
        entryIndex,
        matchedName: alias.name,
        matchedOn: "alias",
        quality: alias.quality ?? "strong",
        canonical: await canonicalizeName(alias.name, { dropLegalSuffixes: drop }),
      });
    }
  }
  return { names };
}

/**
 * Which names in a pool carry which token, plus the pool's token vocabulary.
 *
 * Built once per pool and shared by every subject in the batch, because the
 * postings depend on the lists and not on who is being screened.
 */
type PoolTokenIndex = {
  readonly vocabulary: ReadonlyArray<string>;
  readonly postings: ReadonlyMap<string, ReadonlyArray<number>>;
  /**
   * A subject token → the vocabulary tokens it aligns with, memoized across
   * subjects. A batch of counterparties shares most of its tokens, and this
   * is the only part of the token pass that touches the whole vocabulary.
   */
  readonly aligned: Map<string, { matches: ReadonlyArray<string>; capped: boolean }>;
};

function indexPoolTokens(pool: ReadonlyArray<IndexedName>): PoolTokenIndex {
  const postings = new Map<string, number[]>();
  for (let at = 0; at < pool.length; at++) {
    for (const token of new Set((pool[at] as IndexedName).canonical.tokens)) {
      const list = postings.get(token);
      if (list === undefined) postings.set(token, [at]);
      else list.push(at);
    }
  }
  // Sorted so the vocabulary a token is ranked against is the same array on
  // every run: `FuzzyMatch` breaks ties on candidate index.
  return { vocabulary: [...postings.keys()].sort(), postings, aligned: new Map() };
}

/**
 * Every pool name that shares a token with the subject, rarest token first.
 *
 * The rarest-first order is what makes the cap survivable: when `width` runs
 * out, the slots have already gone to the tokens that discriminate, and it is
 * the "mohammed"s that get dropped rather than the surname. Truncation is
 * reported either way.
 *
 * Tokens are aligned at `TOKEN_ALIGNMENT_FLOOR`, the SAME floor the scorer
 * uses, so the shortlist and the score agree about what counts as the same
 * word. A shortlist built at a looser floor is padding for the expensive pass;
 * one built at a tighter floor hides pairs the scorer would have matched.
 */
async function shortlistByToken(
  name: CanonicalName,
  index: PoolTokenIndex,
  weightOf: (token: string) => number,
  width: number,
): Promise<{ indices: number[]; truncated: boolean }> {
  const tokens = [...new Set(name.tokens)].sort(
    (a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const indices: number[] = [];
  const seen = new Set<number>();
  let truncated = false;
  for (const token of tokens) {
    let aligned = index.aligned.get(token);
    if (aligned === undefined) {
      const ranked = await rankNamesCapped(
        token,
        index.vocabulary,
        TOKEN_ALIGNMENT_FLOOR,
        MAX_HITS_PER_CALL,
      );
      aligned = { matches: ranked.hits.map((hit) => hit.candidate), capped: ranked.capped };
      index.aligned.set(token, aligned);
    }
    if (aligned.capped) truncated = true;
    for (const match of aligned.matches) {
      for (const at of index.postings.get(match) ?? []) {
        if (seen.has(at)) continue;
        if (indices.length >= width) return { indices, truncated: true };
        seen.add(at);
        indices.push(at);
      }
    }
  }
  return { indices, truncated };
}

function corroborate(subject: Subject, entry: ListEntry): Corroboration {
  const country =
    subject.country === undefined
      ? "not supplied"
      : (entry.countries ?? []).length === 0
        ? "absent on the list entry"
        : (entry.countries ?? []).some(
              (value) => value.toLowerCase() === subject.country?.toLowerCase(),
            )
          ? "matches"
          : `differs (entry: ${(entry.countries ?? []).join(", ")})`;
  const dob =
    subject.dateOfBirth === undefined
      ? "not supplied"
      : (entry.datesOfBirth ?? []).length === 0
        ? "absent on the list entry"
        : (entry.datesOfBirth ?? []).some((value) => value === subject.dateOfBirth)
          ? "matches"
          : (entry.datesOfBirth ?? []).some(
                (value) => value.slice(0, 4) === subject.dateOfBirth?.slice(0, 4),
              )
            ? "year matches, day differs"
            : `differs (entry: ${(entry.datesOfBirth ?? []).join(", ")})`;
  return { country, dateOfBirth: dob, usedForScoring: false };
}

/**
 * Screen every subject against every list.
 *
 * The clock is a parameter. A screening record that says when it ran is only
 * worth something if the "when" is the same on the machine that ran it and the
 * machine that replays it.
 */
export async function screenSubjects(
  subjects: ReadonlyArray<Subject>,
  snapshots: ReadonlyArray<ListSnapshot>,
  ages: ReadonlyArray<number>,
  policy: ScreenPolicy,
  nowMs: number,
): Promise<ScreenResult> {
  const indexed: IndexedName[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const { names } = await indexList(snapshots[i] as ListSnapshot, i);
    indexed.push(...names);
  }

  // Token weights come from the lists in front of us, not from a fixed table.
  const weights = buildTokenWeights(indexed.map((n) => n.canonical.tokens));
  const fallbackWeight = unseenTokenWeight(indexed.length);
  const weightOf = (token: string): number => weights.get(token) ?? fallbackWeight;

  const strongPool = indexed.filter((n) => n.quality === "strong");
  const weakPool = policy.includeWeakAliases ? indexed.filter((n) => n.quality === "weak") : [];
  // Built once, not once per subject: this array is as long as every name on
  // every list, and rebuilding it inside the loop would copy the whole corpus
  // for each counterparty in a batch.
  const strongHaystack = strongPool.map((n) => n.canonical.canonical);
  const weakHaystack = weakPool.map((n) => n.canonical.canonical);
  // Same argument: the postings depend on the lists, not on the subject.
  const strongTokens = indexPoolTokens(strongPool);
  const weakTokens = indexPoolTokens(weakPool);

  const results: SubjectResult[] = [];
  for (const subject of subjects) {
    const subjectNames = [subject.name, ...(subject.aliases ?? [])];
    const canonicals = await Promise.all(
      subjectNames.map((name) =>
        canonicalizeName(name, { dropLegalSuffixes: subject.kind !== "person" }),
      ),
    );
    const primary = canonicals[0] as CanonicalName;

    const strong = await scorePool(
      canonicals,
      strongPool,
      strongHaystack,
      strongTokens,
      snapshots,
      subject,
      policy,
      weightOf,
    );
    const weak = await scorePool(
      canonicals,
      weakPool,
      weakHaystack,
      weakTokens,
      snapshots,
      subject,
      policy,
      weightOf,
    );

    const below = [...strong.below, ...weak.below];
    results.push({
      subjectId: subject.id,
      name: subject.name,
      canonical: primary.canonical,
      namesCompared: strongPool.length + weakPool.length,
      shortlisted: strong.shortlisted + weak.shortlisted,
      candidates: strong.candidates,
      weakAliasCandidates: weak.candidates,
      bestScoreBelowThreshold: below.length === 0 ? null : round6(Math.max(...below)),
      ...(strong.candidates.length === 0 && weak.candidates.length === 0
        ? {
            // The sentence an operator acts on, so the shortlist cap belongs
            // IN it. "Nothing reached the threshold" beside a separate
            // `prefilterTruncated: true` field reads as a clean screen to
            // anybody who reads the note and not the field — and the hole is
            // exactly what the note is for.
            note: `no name reached the threshold against the lists in the evidence record. That is not a clearance: it is this threshold, against these list versions, on these spellings.${
              strong.truncated || weak.truncated
                ? " It is also not the whole list: the shortlist filled its cap, so names past it were never scored — raise limit, or narrow the lists."
                : ""
            }`,
          }
        : {}),
      ...(strong.truncated || weak.truncated ? { prefilterTruncated: true } : {}),
    });
  }

  return {
    evidence: {
      screenedAt: new Date(nowMs).toISOString(),
      lists: snapshots.map((snapshot, i) => ({
        source: snapshot.source,
        version: snapshot.version,
        publishedAt: snapshot.publishedAt,
        retrievedAt: snapshot.retrievedAt,
        ...(snapshot.sourceUrl === undefined ? {} : { sourceUrl: snapshot.sourceUrl }),
        entries: snapshot.entries.length,
        names: indexed.filter((n) => n.listIndex === i).length,
        ageDays: ages[i] ?? 0,
      })),
      policy: {
        ...policy,
        matcher:
          "@crewhaus/tool-text FuzzyMatch (Jaro-Winkler), aligned per token and weighted by each token's rarity across these lists, scored in both directions",
        normalisation:
          "NFKC, zero-width and bidirectional controls removed, lowercased, diacritics folded, punctuation split, legal forms dropped from organisation names",
      },
    },
    subjects: results,
    note: "Candidates and evidence only. Whether any of these IS the subject, and what to do about it, is a determination a person makes — this tool does not make it and does not score it.",
  };
}

async function scorePool(
  subjectNames: ReadonlyArray<CanonicalName>,
  pool: ReadonlyArray<IndexedName>,
  /** `pool`'s canonical names, in the same order. */
  haystack: ReadonlyArray<string>,
  /** `pool`'s token postings, so containment can be shortlisted too. */
  tokenIndex: PoolTokenIndex,
  snapshots: ReadonlyArray<ListSnapshot>,
  subject: Subject,
  policy: ScreenPolicy,
  weightOf: (token: string) => number,
): Promise<{
  candidates: Candidate[];
  below: number[];
  shortlisted: number;
  truncated: boolean;
}> {
  if (pool.length === 0) {
    return { candidates: [], below: [], shortlisted: 0, truncated: false };
  }
  const width = policy.limit * PREFILTER_WIDTH;

  const seen = new Map<number, number>();
  let truncated = false;
  const remember = (at: number, score: number): void => {
    const previous = seen.get(at);
    if (previous === undefined || score > previous) seen.set(at, score);
  };
  for (const name of subjectNames) {
    // Pass one: whole-string similarity. `capped` comes from the ranker rather
    // than from comparing the hit count with `width`, because the per-call hit
    // cap is 100 and `width` can be 250 — that comparison could never be true,
    // so the shortlist silently lost everything past the hundredth name while
    // the result said nothing had been truncated.
    const whole = await rankNamesCapped(name.canonical, haystack, PREFILTER_FLOOR, width);
    if (whole.capped) truncated = true;
    for (const hit of whole.hits) remember(hit.index, hit.score);

    // Pass two: shared tokens, which is the half a whole-string score cannot
    // see. Without it a surname never reaches the scorer that was built for it.
    const byToken = await shortlistByToken(name, tokenIndex, weightOf, width);
    if (byToken.truncated) truncated = true;
    const added = byToken.indices.filter((at) => !seen.has(at));
    if (added.length > 0) {
      // These arrive with no whole-string score, and reporting 0 for one would
      // put a number in the evidence that nobody computed. It costs one ranked
      // call per hundred names added.
      const scores = await scoreEach(
        name.canonical,
        added.map((at) => haystack[at] as string),
      );
      added.forEach((at, position) => remember(at, scores[position] ?? 0));
    }
  }

  const candidates: Candidate[] = [];
  const below: number[] = [];
  for (const [index, wholeString] of seen) {
    const indexedName = pool[index] as IndexedName;
    const snapshot = snapshots[indexedName.listIndex] as ListSnapshot;
    const entry = snapshot.entries[indexedName.entryIndex] as ListEntry;

    // Both directions. A one-token subject aligns perfectly INTO any entry that
    // contains that token — "Ali" would score 1.0 against every Ali on the
    // list — so the entry's unmatched tokens have to cost something too.
    let best: { forward: number; reverse: number; alignments: TokenAlignment[] } | null = null;
    for (const name of subjectNames) {
      const forward = await alignTokens(name.tokens, indexedName.canonical.tokens, weightOf);
      const reverse = await alignTokens(indexedName.canonical.tokens, name.tokens, weightOf);
      if (best === null || f1(forward.score, reverse.score) > f1(best.forward, best.reverse)) {
        best = { forward: forward.score, reverse: reverse.score, alignments: forward.alignments };
      }
    }
    const forward = best?.forward ?? 0;
    const reverse = best?.reverse ?? 0;
    const score = f1(forward, reverse);
    if (score < policy.threshold) {
      below.push(score);
      continue;
    }
    candidates.push({
      list: snapshot.source,
      listVersion: snapshot.version,
      entryId: entry.id,
      entryName: entry.name,
      entryKind: entry.kind ?? "unknown",
      matchedName: indexedName.matchedName,
      matchedOn: indexedName.matchedOn,
      aliasQuality: indexedName.quality,
      score,
      scoreForward: forward,
      scoreReverse: reverse,
      scoreWholeString: round6(wholeString),
      alignments: best?.alignments ?? [],
      droppedSuffixes: indexedName.canonical.droppedSuffixes,
      corroboration: corroborate(subject, entry),
      programs: entry.programs ?? [],
    });
  }

  // Score first, then list source, then entry id: two runs over the same
  // snapshot produce the same order, which is what makes a diff of two
  // screening records readable.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (a.list < b.list ? -1 : a.list > b.list ? 1 : 0) ||
      (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
  );
  return {
    candidates: candidates.slice(0, policy.limit),
    below,
    shortlisted: seen.size,
    truncated,
  };
}

/** Harmonic mean of the two directions; zero when either direction is zero. */
function f1(forward: number, reverse: number): number {
  if (forward <= 0 || reverse <= 0) return 0;
  return round6((2 * forward * reverse) / (forward + reverse));
}

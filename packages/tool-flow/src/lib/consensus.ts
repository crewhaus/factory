/**
 * Settle N answers into one, and say how much they actually agreed.
 *
 * The agreement number is the point. A plurality winner with 40% support is
 * not the same as a unanimous one, and a caller that only reads the winner
 * cannot tell them apart — which is exactly when a judge or a human should
 * be brought in.
 */

import { canonicalize } from "./canonical";

export const VOTE_MODES = ["exact", "numeric", "set"] as const;
export type VoteMode = (typeof VOTE_MODES)[number];

export type Vote = {
  readonly value: unknown;
  /** Defaults to 1. Negative weights are rejected. */
  readonly weight?: number;
  /** For the dissent report. */
  readonly voter?: string;
};

export type NormalizeOptions = {
  readonly trim?: boolean;
  readonly lowercase?: boolean;
  /** Collapse runs of whitespace to one space. */
  readonly collapseWhitespace?: boolean;
  /** Strip everything that is not a letter, digit or space. */
  readonly stripPunctuation?: boolean;
};

export type ConsensusOptions = {
  readonly mode?: VoteMode;
  readonly normalize?: NormalizeOptions;
  /** `numeric`: values within this absolute distance are the same answer. */
  readonly tolerance?: number;
  /** `set`: Jaccard similarity at or above this counts as the same answer. */
  readonly overlap?: number;
  /** Support fraction the winner must reach to be `decided`. Default 0.5. */
  readonly threshold?: number;
};

export type ConsensusResult = {
  readonly decided: boolean;
  readonly winner: unknown;
  /** Weight behind the winner, and the total weight cast. */
  readonly support: number;
  readonly total: number;
  /** support/total, 0..1. */
  readonly agreement: number;
  readonly unanimous: boolean;
  readonly tie: boolean;
  /** Every distinct answer, heaviest first, ties broken by first appearance. */
  readonly groups: ReadonlyArray<{
    readonly value: unknown;
    readonly weight: number;
    readonly voters: ReadonlyArray<string>;
  }>;
  /** Voters who did not back the winner. */
  readonly dissenters: ReadonlyArray<string>;
};

export function normalizeValue(value: unknown, options: NormalizeOptions = {}): unknown {
  if (typeof value !== "string") return value;
  let text = value;
  if (options.trim !== false) text = text.trim();
  if (options.lowercase) text = text.toLowerCase();
  if (options.stripPunctuation) text = text.replace(/[^\p{L}\p{N}\s]/gu, "");
  if (options.collapseWhitespace) text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Jaccard similarity of two arrays treated as sets of stringified members. */
export function jaccard(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): number {
  return jaccardOfSets(new Set(a.map(canonicalize)), new Set(b.map(canonicalize)));
}

/** {@link jaccard} of two arrays already turned into sets of stringified members. */
function jaccardOfSets(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  // The shared count is the same whichever side is walked; walk the smaller.
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Whether two already-normalized values count as the same answer. */
function same(a: unknown, b: unknown, options: ConsensusOptions): boolean {
  const mode = options.mode ?? "exact";
  if (mode === "numeric") {
    if (typeof a !== "number" || typeof b !== "number") return false;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= (options.tolerance ?? 0);
  }
  if (mode === "set") {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return jaccard(a, b) >= (options.overlap ?? 1);
  }
  return canonicalize(a) === canonicalize(b);
}

export function tallyVotes(
  votes: ReadonlyArray<Vote>,
  options: ConsensusOptions = {},
): ConsensusResult {
  if (votes.length === 0) throw new Error("no votes were given");

  type Group = {
    value: unknown;
    weight: number;
    voters: string[];
    order: number;
    /** `exact`, and `set` at overlap 1: the value's canonical form, once needed. */
    key?: string;
    /** `set`: the value's members as canonical strings, once needed. */
    members?: ReadonlySet<string>;
  };
  const groups: Group[] = [];
  let total = 0;
  const mode = options.mode ?? "exact";
  const overlap = options.overlap ?? 1;
  // Groups by canonical form, where "the same answer" is equality of that
  // form: `exact`, and `set` at overlap 1, where a Jaccard of 1 means equal
  // sets. Each vote then finds its group by one lookup, where comparing it
  // with every group canonicalized both sides each time: 512 votes of a
  // kilobyte made 270 million characters of JSON.
  const byKey = new Map<string, Group>();
  /** `set`: the first group whose value is an array, the only kind a set vote can join. */
  const arrays: { first?: Group } = {};
  const membersOf = (value: ReadonlyArray<unknown>): ReadonlySet<string> =>
    new Set(value.map(canonicalize));
  /** The canonical form of a set vote at overlap 1: its distinct members, sorted. */
  const setKey = (members: ReadonlySet<string>): string => JSON.stringify([...members].sort());
  /**
   * The first group `value` counts as the same answer as, or undefined —
   * what `groups.find((g) => same(g.value, value, options))` returns, with
   * each value's canonical form or members worked out once, at the point the
   * pairwise comparison first needed them, so anything that cannot be
   * canonicalized throws exactly where it did.
   */
  const firstSame = (value: unknown, created: Partial<Group>): Group | undefined => {
    if (mode === "exact") {
      const first = groups[0];
      if (first === undefined) return undefined;
      if (first.key === undefined) {
        first.key = canonicalize(first.value);
        byKey.set(first.key, first);
      }
      created.key = canonicalize(value);
      return byKey.get(created.key);
    }
    if (mode === "set") {
      if (!Array.isArray(value)) return undefined;
      let mine: ReadonlySet<string> | undefined;
      if (overlap === 1) {
        // Only array groups can match; the first of them may not have its
        // members yet, every later one got them when it was created.
        const first = arrays.first;
        if (first === undefined) return undefined;
        if (first.members === undefined) {
          first.members = membersOf(first.value as ReadonlyArray<unknown>);
          first.key = setKey(first.members);
          byKey.set(first.key, first);
        }
        mine = membersOf(value);
        created.members = mine;
        created.key = setKey(mine);
        return byKey.get(created.key);
      }
      for (const g of groups) {
        if (!Array.isArray(g.value)) continue;
        g.members ??= membersOf(g.value);
        mine ??= membersOf(value);
        created.members = mine;
        if (jaccardOfSets(g.members, mine) >= overlap) return g;
      }
      return undefined;
    }
    return groups.find((g) => same(g.value, value, options));
  };

  for (const [index, vote] of votes.entries()) {
    const weight = vote.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `vote ${index} has weight ${vote.weight}, which must be a non-negative number`,
      );
    }
    const value = normalizeValue(vote.value, options.normalize);
    total += weight;
    const voter = vote.voter ?? `#${index}`;
    // Grouping is by first-match against existing groups, which is what makes
    // `numeric` and `set` below full overlap work at all: they are not
    // transitive, so there is no canonical key to bucket by. Declared order
    // therefore decides which group a borderline value joins, and that is why
    // it is documented. (`exact` and full-overlap `set` are transitive, and
    // `firstSame` buckets them.)
    const created: Partial<Group> = {};
    const existing = firstSame(value, created);
    if (existing) {
      existing.weight += weight;
      existing.voters.push(voter);
    } else {
      const group: Group = { ...created, value, weight, voters: [voter], order: index };
      groups.push(group);
      if (group.key !== undefined) byKey.set(group.key, group);
      if (arrays.first === undefined && Array.isArray(value)) arrays.first = group;
    }
  }

  const ranked = [...groups].sort((a, b) => b.weight - a.weight || a.order - b.order);
  const top = ranked[0] as Group;
  const runnerUp = ranked[1];
  const tie = runnerUp !== undefined && runnerUp.weight === top.weight;
  const agreement = total === 0 ? 0 : top.weight / total;
  const threshold = options.threshold ?? 0.5;

  return {
    // A tie is never decided, however high the fraction: two answers at 50%
    // each would otherwise both clear a 0.5 threshold.
    decided: !tie && agreement >= threshold,
    winner: top.value,
    support: top.weight,
    total,
    agreement,
    unanimous: ranked.length === 1,
    tie,
    groups: ranked.map((g) => ({ value: g.value, weight: g.weight, voters: g.voters })),
    dissenters: ranked.slice(1).flatMap((g) => g.voters),
  };
}

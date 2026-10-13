/**
 * ConsensusVote canonicalizes each vote once.
 *
 * Each vote was compared with every group so far, and every comparison
 * canonicalized both sides again — the votes are capped at 512, their size
 * is not: 512 votes of a kilobyte made 260 000 `JSON.stringify` calls and
 * 270 million characters of JSON. In `exact` mode, and in `set` mode at full
 * overlap (a Jaccard of 1 is set equality), a vote now finds its group by
 * one lookup of its canonical form. Below full overlap a `set` vote is still
 * compared with every group — similarity is not transitive, so the first
 * group it is similar enough to has to be looked for — but each value's
 * members are canonicalized once. The groups, winners and dissenters are
 * unchanged.
 *
 * Counted, never timed: `JSON.stringify` calls and the characters they
 * return, and tool-code's __test__/js-work.ts, which charges each `find`
 * callback and every element an array iterator hands out.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { type ConsensusOptions, type Vote, jaccard, tallyVotes } from "./lib/consensus";

/** `body`, with the `JSON.stringify` calls it makes and the characters they return. */
function stringified<T>(body: () => T): { value: T; calls: number; chars: number } {
  const real = JSON.stringify;
  const count = { calls: 0, chars: 0 };
  // No spread here: js-work would count its iterator.
  JSON.stringify = ((value: unknown, replacer?: never, space?: string | number) => {
    const out = real(value, replacer, space);
    count.calls += 1;
    count.chars += out?.length ?? 0;
    return out;
  }) as typeof JSON.stringify;
  try {
    return { value: body(), ...count };
  } finally {
    JSON.stringify = real;
  }
}

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOTES = 512;

describe("ConsensusVote canonicalizes each vote once", () => {
  test("exact mode: 512 distinct votes of a kilobyte", () => {
    const votes: Vote[] = Array.from({ length: VOTES }, (_, i) => ({
      value: { id: i, body: "y".repeat(1_000) },
    }));
    const input = JSON.stringify(votes).length;
    const run = stringified(() => jsWork(16 * VOTES, () => tallyVotes(votes)));
    // One canonical form a vote: a call for each key and member, about 6.
    expect(run.calls).toBeLessThanOrEqual(8 * VOTES);
    expect(run.chars).toBeLessThanOrEqual(2 * input);
    // Elements iterated and callbacks run: about 10 a vote, where the
    // comparison with every group ran 130 000 `find` callbacks.
    expect(run.value.work).toBeLessThanOrEqual(16 * VOTES);
    expect(run.value.value?.groups).toHaveLength(VOTES);
  });

  test("set mode at full overlap: 512 distinct sets of 100 members", () => {
    const votes: Vote[] = Array.from({ length: VOTES }, (_, i) => ({
      value: Array.from({ length: 100 }, (_, j) => `m${(i + j) % VOTES}`),
    }));
    const members = VOTES * 100;
    const run = stringified(() => jsWork(2 * members, () => tallyVotes(votes, { mode: "set" })));
    expect(run.calls).toBeLessThanOrEqual(2 * members);
    // About one a member, where every pair walked a hundred: 13 million.
    expect(run.value.work).toBeLessThanOrEqual(2 * members);
    expect(run.value.value?.groups).toHaveLength(VOTES);
  });

  test("set mode below full overlap: each value's members canonicalized once", () => {
    const votes: Vote[] = Array.from({ length: 256 }, (_, i) => ({
      value: Array.from({ length: 50 }, (_, j) => `m${i}-${j}`),
    }));
    const members = 256 * 50;
    const run = stringified(() => tallyVotes(votes, { mode: "set", overlap: 0.5 }));
    // Still every pair, but the comparison canonicalized both sides of each:
    // 3.3 million calls here.
    expect(run.calls).toBeLessThanOrEqual(members);
    expect(run.value.groups).toHaveLength(256);
  });
});

/** The tally as it was: every vote compared with every group, both sides canonicalized. */
function oldTally(votes: ReadonlyArray<Vote>, options: ConsensusOptions) {
  const mode = options.mode ?? "exact";
  const canon = (v: unknown): string =>
    JSON.stringify(v, (_k, x) =>
      x !== null && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : x,
    ) ?? "null";
  const same = (a: unknown, b: unknown): boolean => {
    if (mode === "numeric") {
      if (typeof a !== "number" || typeof b !== "number") return false;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return Math.abs(a - b) <= (options.tolerance ?? 0);
    }
    if (mode === "set") {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      return jaccard(a, b) >= (options.overlap ?? 1);
    }
    return canon(a) === canon(b);
  };
  const groups: Array<{ value: unknown; voters: string[] }> = [];
  votes.forEach((vote, index) => {
    const existing = groups.find((g) => same(g.value, vote.value));
    if (existing) existing.voters.push(vote.voter ?? `#${index}`);
    else groups.push({ value: vote.value, voters: [vote.voter ?? `#${index}`] });
  });
  return groups.map((g) => g.voters);
}

describe("the groups are the ones every vote compared with every group made", () => {
  test("generated votes, every mode and overlap", () => {
    const next = rng(0xc0de7001);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const leaf = () => pick<unknown>(["a", "b", 1, 1.05, 2, 0, null, true, "1"]);
    const value = (depth: number): unknown => {
      if (depth <= 0 || next() < 0.5) return leaf();
      if (next() < 0.6)
        return Array.from({ length: Math.floor(next() * 4) }, () => value(depth - 1));
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(next() * 3); i > 0; i--) o[pick(["k", "j", "z"])] = value(depth - 1);
      return o;
    };
    const differ: string[] = [];
    let grouped = 0;
    for (let round = 0; round < 10_000; round++) {
      const pool = Array.from({ length: 5 }, () => value(2));
      const votes: Vote[] = Array.from({ length: 1 + Math.floor(next() * 12) }, () => ({
        value: next() < 0.7 ? pick(pool) : value(2),
      }));
      const options: ConsensusOptions = {
        mode: pick(["exact", "numeric", "set"] as const),
        overlap: pick([0, 0.3, 0.5, 1]),
        tolerance: pick([0, 0.1]),
      };
      const expected = oldTally(votes, options);
      const got = tallyVotes(votes, options)
        .groups.map((g) => [...g.voters])
        .sort((a, b) => Number((a[0] as string).slice(1)) - Number((b[0] as string).slice(1)));
      if (expected.length < votes.length) grouped++;
      if (JSON.stringify(got) !== JSON.stringify(expected)) differ.push(JSON.stringify(votes));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(grouped).toBeGreaterThan(4_000);
  }, 20_000);
});

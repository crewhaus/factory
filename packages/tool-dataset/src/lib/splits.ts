/**
 * Split assignment for a re-put — the one place in this package where being
 * thin was not enough.
 *
 * THE PROBLEM. `splitSamples` (owned by `@crewhaus/feedback-distill`,
 * re-exported by `@crewhaus/dataset-ops`) orders samples by `sha256(id)` and
 * then CUTS at the cumulative percentage boundaries: train is
 * `[0, floor(n·70%))`, dev the next slice, test the rest. The ordering is
 * deterministic — the same ids always rank the same way — but the CUT moves
 * when `n` moves. Adding rows therefore migrates existing rows across the
 * boundaries. Measured, not assumed:
 *
 *     n=20  +3 rows → 2 of 20 rows changed split (one of them test → dev)
 *     n=50  +1 row  → 1 of 50 rows changed split (train → dev)
 *     n=100 +5 rows → 1 of 100 rows changed split
 *     n=1000 +10 rows → 2 of 1000 rows changed split (one dev → test)
 *
 * Each of those is a broken baseline: `tool-evalops` compares a run against
 * the previous run over "the same dataset", and a row that moved from train
 * to test is a holdout the optimizer has already seen — contamination in the
 * direction that flatters the numbers.
 *
 * THE FIX, AND WHY IT IS NOT A SECOND HASH SCHEME. The obvious repair is to
 * bucket on `hash(id) mod 100` instead of rank-and-cut. That is stable, but
 * it is also a SECOND split function: the same dataset would land in
 * different splits depending on whether `crewhaus datasets put` or this tool
 * wrote it, which is the drift this package exists not to create. So the
 * stable mode carries forward WHAT ACTUALLY HAPPENED — the split each id
 * already sits in, read out of the previous version's record — and calls the
 * package's own `splitSamples` for the genuinely new rows only. Existing rows
 * cannot move, because nothing recomputes them. A first version (no previous
 * record) is assigned entirely by `splitSamples`, so a fresh dataset is
 * identical to what the CLI would have written.
 *
 * `mode: "recompute"` keeps the CLI's exact behaviour available, and reports
 * the rows it moved rather than moving them quietly. Both modes run the SAME
 * move detection, so the stable mode's empty `moved` list is a measurement,
 * not a claim the mode makes about itself.
 */
import { splitSamples } from "@crewhaus/dataset-ops";
import type { SplitSpec } from "@crewhaus/dataset-ops";
import type { DatasetSplit } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";

export type SplitMode = "stable" | "recompute";

/** A row that changed split between the previous version and this one. */
export type SplitMove = {
  readonly id: string;
  readonly from: DatasetSplit;
  readonly to: DatasetSplit;
};

/** The record-shaped splits a `put` writes: train and dev always present,
 *  test present only when something is in it. */
export type PlannedSplits = {
  train: Sample[];
  dev: Sample[];
  test?: Sample[];
};

export type SplitPlan = {
  readonly splits: PlannedSplits;
  readonly assignment: ReadonlyMap<string, DatasetSplit>;
  /** Rows whose split came from the previous version rather than a hash. */
  readonly carriedForward: number;
  /** Rows the package's own `splitSamples` assigned. */
  readonly newlyAssigned: number;
  /** Rows that changed split versus the previous version. Empty by
   *  construction in `stable` mode — and verified, not assumed. */
  readonly moved: SplitMove[];
  /** Ids the previous version had that this put does not carry. Reported
   *  because dropping rows is how a "grow the dataset" call silently
   *  shrinks it. */
  readonly dropped: string[];
};

export type PlanSplitsOptions = {
  readonly samples: ReadonlyArray<Sample>;
  readonly spec: SplitSpec;
  /** id → split from the version this put is based on (see
   *  `assignmentOf`); insertion order is the previous record's row order. */
  readonly previous?: ReadonlyMap<string, DatasetSplit>;
  readonly mode: SplitMode;
  /** Put every sample in this one split instead of splitting (the CLI's
   *  `--split` flag). Stability is trivial here and still measured. */
  readonly singleSplit?: DatasetSplit;
};

const SPLIT_ORDER: ReadonlyArray<DatasetSplit> = ["train", "dev", "test"];

export function planSplits(opts: PlanSplitsOptions): SplitPlan {
  const previous = opts.previous ?? new Map<string, DatasetSplit>();
  // Previous ROW ORDER, so carried rows keep their position inside their
  // split. The stored `sampleHashes` are folded into the dataset hash IN
  // ARRAY ORDER, so reshuffling rows inside a split changes the dataset's
  // identity even when every row is untouched.
  const previousRank = new Map<string, number>();
  for (const id of previous.keys()) previousRank.set(id, previousRank.size);

  const assignment = new Map<string, DatasetSplit>();
  const buckets: Record<DatasetSplit, Sample[]> = { train: [], dev: [], test: [] };
  let carriedForward = 0;
  let newlyAssigned = 0;

  if (opts.singleSplit !== undefined) {
    for (const s of opts.samples) {
      assignment.set(s.id, opts.singleSplit);
      buckets[opts.singleSplit].push(s);
      if (previous.has(s.id)) carriedForward += 1;
      else newlyAssigned += 1;
    }
  } else if (opts.mode === "recompute") {
    const fresh = splitSamples(opts.samples, opts.spec);
    for (const split of SPLIT_ORDER) {
      for (const s of fresh[split]) {
        assignment.set(s.id, split);
        buckets[split].push(s);
      }
    }
    newlyAssigned = opts.samples.length;
  } else {
    const carried: Sample[] = [];
    const fresh: Sample[] = [];
    for (const s of opts.samples) (previous.has(s.id) ? carried : fresh).push(s);
    carriedForward = carried.length;
    newlyAssigned = fresh.length;
    for (const s of carried) {
      const split = previous.get(s.id) as DatasetSplit;
      assignment.set(s.id, split);
      buckets[split].push(s);
    }
    // Carried rows first, in the previous version's order; new rows after, in
    // the package's own hash order. A re-put's splits are then the previous
    // version's arrays with the new rows appended.
    for (const split of SPLIT_ORDER) {
      buckets[split].sort((a, b) => (previousRank.get(a.id) ?? 0) - (previousRank.get(b.id) ?? 0));
    }
    const assigned = splitSamples(fresh, opts.spec);
    for (const split of SPLIT_ORDER) {
      for (const s of assigned[split]) {
        assignment.set(s.id, split);
        buckets[split].push(s);
      }
    }
  }

  // ONE move detection for every mode. `stable` does not get to assert its
  // own guarantee — it gets measured by the same code that reports how badly
  // `recompute` reshuffled.
  const moved: SplitMove[] = [];
  for (const [id, from] of previous) {
    const to = assignment.get(id);
    if (to !== undefined && to !== from) moved.push({ id, from, to });
  }
  const dropped = [...previous.keys()].filter((id) => !assignment.has(id));

  // The test key is written when the spec asks for one OR when anything is
  // actually in it. Keying it on the spec alone drops carried-forward test
  // rows on the floor the first time someone re-puts with `--split-spec
  // 80/20` — a silent deletion disguised as a split change.
  const splits: PlannedSplits = { train: buckets.train, dev: buckets.dev };
  if (opts.spec.test > 0 || buckets.test.length > 0) splits.test = buckets.test;

  return { splits, assignment, carriedForward, newlyAssigned, moved, dropped };
}

/** Row counts per split, for a result. */
export function splitCounts(splits: PlannedSplits): Record<string, number> {
  return {
    train: splits.train.length,
    dev: splits.dev.length,
    ...(splits.test !== undefined ? { test: splits.test.length } : {}),
  };
}

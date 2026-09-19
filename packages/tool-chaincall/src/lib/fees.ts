/**
 * The EIP-1559 base-fee rule, and the statistics over a fee-history window.
 *
 * All of it is integer arithmetic on `bigint`. That is not fastidiousness:
 * `eth_feeHistory` returns `gasUsedRatio` as a JSON FLOAT, and computing the
 * next base fee from that float is the obvious shortcut and the wrong answer
 * — the ratio has already lost the low bits of `gasUsed`, and the rule
 * multiplies a wei value by it. So the projection reads `gasUsed` and
 * `gasLimit` off the block as integers and never touches the ratio.
 *
 * The other thing this file refuses to do is assume. Not every chain runs a
 * 1559 market, and several that look like one do not follow the vanilla rule
 * — a different elasticity, a different denominator, or a constant floor
 * that never moves. So the projection is COMPARED against the value the node
 * itself put at the end of `feeHistory.baseFeePerGas`, and a disagreement is
 * reported rather than hidden behind whichever number came first.
 */
import { ChainCallError } from "./rpc";

/** `gasLimit / elasticity` is the gas target a block is measured against. */
export const DEFAULT_ELASTICITY = 2n;

/** The 1/8 the base fee may move by in one block. */
export const BASE_FEE_MAX_CHANGE_DENOMINATOR = 8n;

export type BaseFeeProjection = {
  readonly next: bigint;
  readonly target: bigint;
  readonly direction: "up" | "down" | "flat";
};

/**
 * The next block's base fee, by the EIP-1559 rule.
 *
 * Three cases and one floor. At exactly the target the fee is unchanged;
 * above it the fee rises by `parent * excess / target / 8` with a minimum of
 * one wei (the spec's `max(1, …)`, which is what stops a chain with a
 * one-wei base fee from being stuck there through full blocks); below it the
 * fee falls by the same expression with no such floor.
 *
 * A zero `gasLimit` — which only a malformed block has — returns the parent
 * fee rather than dividing by zero.
 */
export function nextBaseFee(
  parentBaseFee: bigint,
  gasUsed: bigint,
  gasLimit: bigint,
  elasticity: bigint = DEFAULT_ELASTICITY,
  denominator: bigint = BASE_FEE_MAX_CHANGE_DENOMINATOR,
): BaseFeeProjection {
  if (elasticity <= 0n || denominator <= 0n) {
    throw new ChainCallError("the 1559 elasticity and denominator must both be positive");
  }
  const target = gasLimit / elasticity;
  if (target === 0n) return { next: parentBaseFee, target, direction: "flat" };
  if (gasUsed === target) return { next: parentBaseFee, target, direction: "flat" };

  if (gasUsed > target) {
    const raw = (parentBaseFee * (gasUsed - target)) / target / denominator;
    const delta = raw > 0n ? raw : 1n;
    return { next: parentBaseFee + delta, target, direction: "up" };
  }

  const delta = (parentBaseFee * (target - gasUsed)) / target / denominator;
  const next = parentBaseFee - delta;
  return { next: next > 0n ? next : 0n, target, direction: "down" };
}

/**
 * The median of a list of bigints, with the low middle chosen for an even
 * count rather than an average.
 *
 * Averaging two adjacent samples invents a wei value that no block ever
 * charged. For a fee percentile, "a tip this size was enough in half the
 * sampled blocks" is a statement about an observed sample, and the lower of
 * the two middles is still one of the observations.
 */
export function medianOf(values: ReadonlyArray<bigint>): bigint | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[(sorted.length - 1) >> 1];
}

export type PercentileSummary = {
  readonly percentile: number;
  readonly medianWei: string;
  readonly minWei: string;
  readonly maxWei: string;
  /** How many sampled blocks contributed a reward at this percentile. */
  readonly samples: number;
};

/**
 * Summarise one column of `feeHistory.reward`.
 *
 * The node computes each percentile per block; this reduces the column
 * across the window. Blocks with no reward entry — an empty block has no
 * transactions to take a percentile of — are counted out rather than read as
 * a zero tip, because "nobody paid anything" and "nobody paid" are different
 * claims and only one of them is true.
 */
export function summarisePercentile(
  percentile: number,
  column: ReadonlyArray<bigint>,
): PercentileSummary | undefined {
  if (column.length === 0) return undefined;
  const median = medianOf(column);
  if (median === undefined) return undefined;
  let min = column[0] as bigint;
  let max = column[0] as bigint;
  for (const value of column) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    percentile,
    medianWei: median.toString(),
    minWei: min.toString(),
    maxWei: max.toString(),
    samples: column.length,
  };
}

/**
 * How far the base fee moved across the window, in basis points of where it
 * started. Reported instead of a "rising"/"falling" word because the word
 * needs a threshold nobody agreed on, and one 1559 step is already 1250 bps.
 *
 * A decimal STRING, like every other figure derived from a wei value here. A
 * chain whose base fee sits at a one-wei floor and then spikes produces a
 * ratio past 2^53, and `Number()` turns that into `1e+34` — a value that is
 * neither an integer nor the one that was computed.
 */
export function changeBps(first: bigint, last: bigint): string | undefined {
  if (first === 0n) return undefined;
  return (((last - first) * 10_000n) / first).toString();
}

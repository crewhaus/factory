/**
 * The fixed-point arithmetic that goes wrong in a model's head.
 *
 * Every value here is an integer in base units. Slippage is basis points,
 * not a percentage, because a percentage invites a decimal and a decimal
 * invites a double. A `minOut` that is off by a rounding error either fails
 * a swap that should have succeeded or accepts one that should have failed.
 */

export type SlippageResult = {
  readonly quotedOut: string;
  readonly slippageBps: number;
  readonly minOut: string;
  /** What the caller gives up in the worst allowed case. */
  readonly worstCaseLossBase: string;
};

const BPS = 10_000n;

/**
 * The floor a swap may return before it should revert.
 *
 * Rounded DOWN, always. Rounding a minimum up would reject swaps that were
 * inside the caller's tolerance, and the direction of a rounding error in a
 * bound is not a detail.
 */
export function minimumOut(quotedOut: bigint, slippageBps: number): SlippageResult {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer from 0 to 10000, got ${slippageBps}`);
  }
  if (quotedOut < 0n) throw new Error("quotedOut must not be negative");
  const minOut = (quotedOut * (BPS - BigInt(slippageBps))) / BPS;
  return {
    quotedOut: quotedOut.toString(),
    slippageBps,
    minOut: minOut.toString(),
    worstCaseLossBase: (quotedOut - minOut).toString(),
  };
}

/** The ceiling an input may reach, for an exact-output swap. Rounded UP. */
export function maximumIn(quotedIn: bigint, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer from 0 to 10000, got ${slippageBps}`);
  }
  const numerator = quotedIn * (BPS + BigInt(slippageBps));
  // Ceiling division: a maximum rounded down would reject an acceptable swap.
  return ((numerator + BPS - 1n) / BPS).toString();
}

/**
 * Convert an amount between two token decimalisations.
 *
 * Six-decimal USDC and eighteen-decimal DAI hold "the same" amount as very
 * different integers, and mixing them up is a factor of a trillion.
 */
export function rescaleDecimals(amount: bigint, from: number, to: number): string {
  if (from < 0 || to < 0 || from > 77 || to > 77) throw new Error("decimals must be 0 to 77");
  if (to >= from) return (amount * 10n ** BigInt(to - from)).toString();
  const divisor = 10n ** BigInt(from - to);
  const scaled = amount / divisor;
  if (amount % divisor !== 0n) {
    // Say so rather than silently truncating: going from 18 decimals to 6
    // throws away real value, and the caller has to decide.
    throw new Error(
      `${amount} at ${from} decimals does not fit in ${to} decimals without discarding ${amount % divisor}; rescale a rounded amount deliberately`,
    );
  }
  return scaled.toString();
}

/**
 * Price impact in basis points, against a reference mid price.
 *
 * Both prices are integers with the same scale. Positive means the execution
 * is worse than the reference.
 */
export function priceImpactBps(executionPrice: bigint, referencePrice: bigint): number {
  if (referencePrice <= 0n) throw new Error("referencePrice must be positive");
  const delta = referencePrice - executionPrice;
  return Number((delta * BPS) / referencePrice);
}

/** Proportional share of a pool, in basis points, for an LP position. */
export function shareBps(part: bigint, total: bigint): number {
  if (total <= 0n) throw new Error("total must be positive");
  if (part < 0n) throw new Error("part must not be negative");
  return Number((part * BPS) / total);
}

/**
 * Health factor for a collateralised position, in basis points.
 *
 * `collateral * liquidationThresholdBps / debt`. Below 10000 the position is
 * liquidatable. Debt of zero has no health factor rather than an infinite
 * one, because a caller comparing against a threshold would read Infinity as
 * safe and a NaN as unsafe by accident.
 */
export function healthFactorBps(
  collateralBase: bigint,
  debtBase: bigint,
  liquidationThresholdBps: number,
): number | null {
  if (debtBase <= 0n) return null;
  if (collateralBase < 0n) throw new Error("collateral must not be negative");
  return Number((collateralBase * BigInt(liquidationThresholdBps)) / debtBase);
}

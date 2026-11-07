/** The benchmark's arithmetic: pure, over samples someone else collected. */

export type ViewStats = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

/** A view is within budget when its 95th percentile is at or under this. */
export const VIEW_BUDGET_MS = 2_000;

/** Nearest-rank percentile of samples already sorted ascending. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** The statistics of some samples, or `undefined` when there are none: no data is not zero. */
export function viewStats(samples: readonly number[]): ViewStats | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] as number,
  };
}

export type ViewVerdict = {
  readonly verdict: "within" | "over" | "no-data";
  readonly stats?: ViewStats;
};

/** One view's verdict against the budget. */
export function viewVerdict(samples: readonly number[], budgetMs = VIEW_BUDGET_MS): ViewVerdict {
  const stats = viewStats(samples);
  if (stats === undefined) return { verdict: "no-data" };
  return { verdict: stats.p95 <= budgetMs ? "within" : "over", stats };
}

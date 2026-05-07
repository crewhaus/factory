import type { SampleResult } from "./types";

export function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const fract = idx - lo;
  return (sorted[lo] ?? 0) * (1 - fract) + (sorted[hi] ?? 0) * fract;
}

export function aggregate(samples: ReadonlyArray<SampleResult>): {
  passRate: number;
  meanScore: number;
  p50Turns: number;
  p95Turns: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalTokens: { input: number; output: number };
  errorCount: number;
} {
  const ok = samples.filter((s) => s.error === undefined);
  const total = samples.length;
  const passed = ok.filter((s) => s.grades.overall.passed).length;
  const meanScore =
    ok.length === 0 ? 0 : ok.reduce((sum, s) => sum + s.grades.overall.score, 0) / ok.length;
  const turnsSorted = ok.map((s) => s.turns).sort((a, b) => a - b);
  const latSorted = ok.map((s) => s.latencyMs).sort((a, b) => a - b);
  const totalTokens = ok.reduce(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      output: acc.output + s.tokens.output,
    }),
    { input: 0, output: 0 },
  );
  return {
    passRate: total === 0 ? 0 : passed / total,
    meanScore,
    p50Turns: quantile(turnsSorted, 0.5),
    p95Turns: quantile(turnsSorted, 0.95),
    p50LatencyMs: quantile(latSorted, 0.5),
    p95LatencyMs: quantile(latSorted, 0.95),
    totalTokens,
    errorCount: samples.length - ok.length,
  };
}

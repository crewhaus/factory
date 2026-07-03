/**
 * Ops item 37 — `crewhaus doctor --slo` (a.k.a. `--ttft`): the latency/TTFT half
 * of the SLO feature. Compares the RECENT p95 time-to-first-token against the
 * spec's declared `observability.slo.ttft_ms` target and, on a breach, NAMES
 * faster candidate models (via the cost-tracker candidate enumeration) so the
 * operator can `crewhaus eval --models <candidates>` to confirm the swap holds
 * quality — the active half of the SLO ("switch to haiku-4-5: p95 380ms vs
 * 1400ms").
 *
 * Recent p95 TTFT comes from the alert-watchdog's DURABLE per-session history
 * (`.crewhaus/metrics/sessions.jsonl`, `ttftP95Seconds`) — the same file the
 * live monitor's baselines derive from, so the probe and the runtime agree on
 * ground truth. As a fallback the probe accepts a metrics-collector histogram
 * JSON snapshot and derives p95 FROM ITS BUCKETS (the registry computes no p95),
 * for deployments that scrape Prometheus rather than persist sessions.
 *
 * Side-effect-free on import (this module only reads files the caller hands it a
 * path to) and directly unit-testable, mirroring `doctor-checks.ts` /
 * `eval-matrix.ts`. The CLI entry file owns the process exit; the probe returns
 * an exit code so it composes with `doctor --liveness`'s container-HEALTHCHECK
 * semantics (0 = within SLO, non-zero = breached → the HEALTHCHECK flaps).
 */
import type { ModelCandidate } from "@crewhaus/cost-tracker";
import {
  DEFAULT_PRICING,
  type PricingTable,
  enumerateCandidates,
  providerOfSpecString,
} from "@crewhaus/cost-tracker";

/** One durable per-session snapshot line (subset the probe reads). */
type SessionSnapshotLine = { readonly ttftP95Seconds?: number; readonly ts?: string };

/**
 * A metrics-collector histogram series (one label set). `counts[i]` is the
 * CUMULATIVE count at or below `buckets[i]` (as `Histogram.observe` stores it),
 * `total` is the overall count. Used for the Prometheus-scrape fallback source.
 */
export type HistogramSeries = {
  readonly buckets: ReadonlyArray<number>;
  readonly counts: ReadonlyArray<number>;
  readonly total: number;
};

/**
 * Derive an approximate p-th percentile from a cumulative histogram's buckets —
 * the coarse bucket-boundary estimate a Prometheus `histogram_quantile` gives.
 * Returns the upper edge of the first bucket whose cumulative count reaches the
 * rank. Empty ⇒ 0. The registry stores `model_ttft_seconds` in SECONDS, so the
 * caller multiplies by 1000 for a millisecond comparison.
 */
export function percentileFromHistogram(series: HistogramSeries, p: number): number {
  if (series.total === 0 || series.buckets.length === 0) return 0;
  const rank = p * series.total;
  for (let i = 0; i < series.buckets.length; i += 1) {
    if ((series.counts[i] ?? 0) >= rank) return series.buckets[i] ?? 0;
  }
  // Above the top finite bucket → report the top edge (the +Inf bucket has no
  // upper bound to name).
  return series.buckets[series.buckets.length - 1] ?? 0;
}

/**
 * Compute the trailing-N mean of the durable per-session `ttftP95Seconds`
 * values from a sessions.jsonl text (torn lines skipped). Returns undefined
 * when there is no usable history, so the probe can report "no data" rather
 * than a spurious 0ms. `windowSessions` bounds how much recency the probe
 * trusts (default 20 — a working week of runs).
 */
export function recentTtftP95Ms(sessionsJsonl: string, windowSessions = 20): number | undefined {
  const values: number[] = [];
  for (const line of sessionsJsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const snap = JSON.parse(trimmed) as SessionSnapshotLine;
      if (typeof snap.ttftP95Seconds === "number" && Number.isFinite(snap.ttftP95Seconds)) {
        values.push(snap.ttftP95Seconds * 1000);
      }
    } catch {
      // torn/append-in-progress line — skip.
    }
  }
  if (values.length === 0) return undefined;
  const window = values.slice(-windowSessions);
  return window.reduce((s, v) => s + v, 0) / window.length;
}

export type FasterCandidate = {
  readonly modelString: string;
  readonly blendedPer1M: number;
};

/**
 * Name faster-candidate models for a slow slot, cheapest blended price first.
 * Cheaper models are smaller and — as a first-order proxy — faster to first
 * token; the probe surfaces them as CANDIDATES to eval, never as an automatic
 * swap (a spec change stays human-reviewed). Excludes the current model's own
 * family and known sunsets. Empty when the current model isn't table-backed
 * (local / azure / named-host) — the probe then just reports the breach.
 */
export function nameFasterCandidates(
  currentModel: string,
  opts: { readonly pricing?: PricingTable; readonly limit?: number } = {},
): FasterCandidate[] {
  const parsed = providerOfSpecString(currentModel);
  if (parsed === undefined) return [];
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const candidates: ModelCandidate[] = enumerateCandidates(parsed, {
    pricing,
    sameProviderOnly: true,
    excludeCurrent: true,
    excludeSunsets: true,
  });
  const limit = opts.limit ?? 3;
  return candidates.slice(0, limit).map((c) => ({
    modelString: c.modelString,
    blendedPer1M: c.blendedPer1M,
  }));
}

export type SloProbeResult = {
  /** 0 = within SLO / no data (a probe must not flap on a cold store); 1 = breach. */
  readonly exitCode: number;
  readonly lines: ReadonlyArray<string>;
};

export type SloProbeInput = {
  /** SLO ttft target in ms, from the lowered spec. Undefined ⇒ nothing to probe. */
  readonly ttftTargetMs: number | undefined;
  /** The spec's current agent model string (for candidate naming). */
  readonly currentModel: string | undefined;
  /** Durable sessions.jsonl text (`.crewhaus/metrics/sessions.jsonl`), or "". */
  readonly sessionsJsonl: string;
  /** Optional histogram fallback source (metrics-collector snapshot). */
  readonly histogram?: HistogramSeries;
  readonly pricing?: PricingTable;
};

/**
 * Run the TTFT probe: build the human-readable report + the exit code. Pure —
 * the CLI reads the files and owns `process.exit`. Precedence: durable
 * sessions.jsonl first (the alert-watchdog's own history), then the histogram
 * fallback. No target ⇒ exit 0 with a "nothing declared" note; no data ⇒ exit 0
 * (a HEALTHCHECK must not flap on a store that has not accrued history yet).
 */
export function runSloProbe(input: SloProbeInput): SloProbeResult {
  const lines: string[] = [];
  if (input.ttftTargetMs === undefined) {
    lines.push(
      "~ SLO ttft: no observability.slo.ttft_ms declared in the cwd spec — nothing to probe",
    );
    return { exitCode: 0, lines };
  }
  let observedMs = recentTtftP95Ms(input.sessionsJsonl);
  let source = ".crewhaus/metrics/sessions.jsonl";
  if (observedMs === undefined && input.histogram !== undefined) {
    observedMs = percentileFromHistogram(input.histogram, 0.95) * 1000;
    source = "metrics histogram (model_ttft_seconds)";
  }
  if (observedMs === undefined) {
    lines.push(
      "~ SLO ttft: no recent TTFT history yet (run the agent a few times so `.crewhaus/metrics/sessions.jsonl` accrues) — probe skipped",
    );
    return { exitCode: 0, lines };
  }
  const target = input.ttftTargetMs;
  const within = observedMs <= target;
  const fmt = (n: number): string => `${Math.round(n)}ms`;
  if (within) {
    lines.push(
      `✓ SLO ttft: p95 ${fmt(observedMs)} within target ${fmt(target)} (source: ${source})`,
    );
    return { exitCode: 0, lines };
  }
  lines.push(
    `✗ SLO ttft: p95 ${fmt(observedMs)} exceeds target ${fmt(target)} (source: ${source})`,
  );
  const candidates =
    input.currentModel !== undefined
      ? nameFasterCandidates(input.currentModel, {
          ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
        })
      : [];
  if (candidates.length > 0) {
    const list = candidates.map((c) => c.modelString).join(",");
    lines.push(`  faster candidates (cheaper ⇒ smaller ⇒ lower TTFT, same provider): ${list}`);
    lines.push(
      `  confirm the swap holds quality: crewhaus eval --models ${input.currentModel},${list}`,
    );
  } else if (input.currentModel !== undefined) {
    lines.push(
      `  no table-backed faster candidates for ${input.currentModel} (local/named-host model) — measure alternatives with crewhaus eval --models <m1,m2>`,
    );
  }
  return { exitCode: 1, lines };
}

/**
 * Ops item 31 — alert watchdog with baseline-derived thresholds.
 *
 * A bus subscriber (wired into `attachDefaultSubscribers`, gated by
 * CREWHAUS_ALERTS) that folds a run's TraceEvents into a small per-session
 * metrics snapshot, then — at session end — compares that snapshot against
 * thresholds DERIVED FROM HISTORY (the trailing p95 of prior sessions'
 * persisted snapshots, ×a headroom factor) rather than hand-configured
 * constants. On a breach it publishes an `alert_raised` trace event and hands
 * the breach to injected sinks (audit append + settings.json `alert` hook /
 * webhook — supplied by the caller so this module stays side-effect-free apart
 * from the snapshot persistence it owns).
 *
 * WHY PERSIST A SNAPSHOT: nothing durably records per-session metric history
 * today (metrics-collector is opt-in and its sinks are point-in-time). Without
 * history there is nothing to derive a baseline from. So the watchdog appends
 * one compact JSONL line per session under `.crewhaus/metrics/sessions.jsonl`
 * (additive; readers tolerate torn lines). The FIRST few sessions have no
 * baseline — the watchdog uses conservative bootstrap defaults until enough
 * history accrues (`MIN_BASELINE_SESSIONS`), so a cold start never alert-storms.
 *
 * This file is the side-effect-free-ish core (the only I/O it owns is reading
 * and appending its own snapshot JSONL); event folding, threshold derivation,
 * and breach detection are pure and unit-tested.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

/** Default location of the per-session metrics history, relative to cwd. */
export const DEFAULT_METRICS_DIR = join(".crewhaus", "metrics");
export const METRICS_FILENAME = "sessions.jsonl";

/** How many historical sessions we need before deriving a real baseline. */
export const MIN_BASELINE_SESSIONS = 5;
/** Headroom multiplier over the trailing p95 (a 50% cushion). */
export const HEADROOM_FACTOR = 1.5;
/** How many trailing sessions the baseline is derived from. */
export const BASELINE_WINDOW = 50;

/**
 * The compact per-session snapshot persisted to `sessions.jsonl` and read back
 * to derive baselines. Percentiles are computed from the per-session samples
 * at session end so the stored line is small and directly comparable.
 */
export type SessionMetricsSnapshot = {
  readonly sessionId: string;
  readonly ts: string;
  /** Total user turns (turn_end events). */
  readonly turns: number;
  /** Total model calls (model_response events). */
  readonly modelCalls: number;
  /** Errors that were NOT recovered (error_recovered action "fail"). */
  readonly unrecoveredErrors: number;
  /** unrecoveredErrors / max(modelCalls,1) — the rate we alert on. */
  readonly errorRate: number;
  /** p95 of per-turn durations, seconds. */
  readonly turnP95Seconds: number;
  /** p95 of time-to-first-token, seconds. */
  readonly ttftP95Seconds: number;
  /** Total spend in USD-micros over the session. */
  readonly costUsdMicros: number;
  /** Cost burn rate: USD per minute of wall-clock session time. */
  readonly costBurnUsdPerMin: number;
  /** cost_accrual events that priced to $0 despite non-zero tokens (pricing miss). */
  readonly pricingMisses: number;
  /** Circuit-breaker transitions into "open". */
  readonly circuitOpens: number;
  /** Egress classifier block-tier verdicts. */
  readonly egressBlocked: number;
  /** Justification-gate / policy denials (permission_decision decision "deny"). */
  readonly permissionDenials: number;
};

/** A single threshold breach found by {@link detectBreaches}. */
export type Breach = {
  readonly metric: string;
  readonly observed: number;
  readonly threshold: number;
  readonly detail: string;
};

/** Thresholds derived from history (or bootstrap defaults on a cold start). */
export type DerivedThresholds = {
  readonly errorRate: number;
  readonly turnP95Seconds: number;
  readonly ttftP95Seconds: number;
  readonly costBurnUsdPerMin: number;
  readonly pricingMissRate: number;
  readonly circuitOpens: number;
  readonly egressBlocked: number;
  /** How many historical sessions the thresholds were derived from (0 = bootstrap). */
  readonly baselineSessions: number;
};

// --------- pure event folding ---------

/**
 * Accumulates a session's metric signals from bus events. Mirrors
 * metrics-collector's event→metric derivation (turn_end duration, TTFT from
 * model_request→first model_stream_token) so the watchdog does not depend on
 * the opt-in metrics-collector being attached.
 */
export class SessionMetricsAccumulator {
  private turnDurations: number[] = [];
  private ttfts: number[] = [];
  private modelCalls = 0;
  private turns = 0;
  private unrecoveredErrors = 0;
  private costUsdMicros = 0;
  private pricingMisses = 0;
  private circuitOpens = 0;
  private egressBlocked = 0;
  private permissionDenials = 0;
  private firstTs: number | undefined;
  private lastTs: number | undefined;
  private readonly requestStarts = new Map<string, number>();
  private readonly ttftSeen = new Set<string>();

  fold(ev: TraceEvent): void {
    const t = Date.parse(ev.timestamp);
    if (!Number.isNaN(t)) {
      if (this.firstTs === undefined || t < this.firstTs) this.firstTs = t;
      if (this.lastTs === undefined || t > this.lastTs) this.lastTs = t;
    }
    switch (ev.kind) {
      case "turn_end":
        this.turns += 1;
        this.turnDurations.push(ev.durationMs / 1000);
        return;
      case "model_request":
        this.requestStarts.set(ev.traceId, Date.parse(ev.timestamp));
        this.ttftSeen.delete(ev.traceId);
        return;
      case "model_stream_token": {
        if (this.ttftSeen.has(ev.traceId)) return;
        const start = this.requestStarts.get(ev.traceId);
        if (start === undefined) return;
        const tokenMs = Date.parse(ev.timestamp);
        if (Number.isNaN(tokenMs)) return;
        this.ttfts.push(Math.max(0, (tokenMs - start) / 1000));
        this.ttftSeen.add(ev.traceId);
        return;
      }
      case "model_response":
        this.modelCalls += 1;
        this.requestStarts.delete(ev.traceId);
        this.ttftSeen.delete(ev.traceId);
        return;
      case "error_recovered":
        // Only a terminal "fail" is an unrecovered error; retry/compact/etc.
        // are the recovery engine doing its job.
        if (ev.action === "fail") this.unrecoveredErrors += 1;
        return;
      case "cost_accrual": {
        // Skip the FR-003 terminal aggregate (summary:true) — it double-counts.
        if (ev.summary === true) return;
        this.costUsdMicros += ev.costUsdMicros;
        if (ev.costUsdMicros === 0 && ev.inputTokens + ev.outputTokens > 0) {
          this.pricingMisses += 1;
        }
        return;
      }
      case "circuit_state_changed":
        if (ev.toState === "open") this.circuitOpens += 1;
        return;
      case "permission_decision":
        if (ev.outcome === "egress-blocked") this.egressBlocked += 1;
        else if (ev.outcome === undefined && ev.decision === "deny") this.permissionDenials += 1;
        return;
      default:
        return;
    }
  }

  /** Finalize into a persistable snapshot. `now` seeds the timestamp. */
  snapshot(sessionId: string, now: Date = new Date()): SessionMetricsSnapshot {
    const wallMs =
      this.firstTs !== undefined && this.lastTs !== undefined ? this.lastTs - this.firstTs : 0;
    const wallMin = wallMs / 60000;
    const costUsd = this.costUsdMicros / 1_000_000;
    return {
      sessionId,
      ts: now.toISOString(),
      turns: this.turns,
      modelCalls: this.modelCalls,
      unrecoveredErrors: this.unrecoveredErrors,
      errorRate: this.unrecoveredErrors / Math.max(this.modelCalls, 1),
      turnP95Seconds: percentile(this.turnDurations, 0.95),
      ttftP95Seconds: percentile(this.ttfts, 0.95),
      costUsdMicros: this.costUsdMicros,
      costBurnUsdPerMin: wallMin > 0 ? costUsd / wallMin : 0,
      pricingMisses: this.pricingMisses,
      circuitOpens: this.circuitOpens,
      egressBlocked: this.egressBlocked,
      permissionDenials: this.permissionDenials,
    };
  }
}

/** Nearest-rank p95 (0-based index floor((p)*(n-1))). Empty → 0. */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

// --------- threshold derivation + breach detection ---------

/**
 * Derive thresholds from a session history. For the "higher-is-worse"
 * continuous metrics (error rate, turn p95, TTFT p95, cost burn, pricing-miss
 * rate) the threshold is `trailing-p95 × HEADROOM_FACTOR`. For the count
 * metrics (circuit opens, egress blocks) the threshold is the trailing p95
 * count (any session materially above its own historical worst is worth a
 * look) with a floor of 1 so a single first-ever block still alerts.
 *
 * With fewer than {@link MIN_BASELINE_SESSIONS} historical rows, there is not
 * enough signal to trust a percentile — conservative bootstrap defaults are
 * used instead so a cold start neither alert-storms nor stays silent on an
 * obviously broken session.
 */
export function deriveThresholds(
  history: ReadonlyArray<SessionMetricsSnapshot>,
): DerivedThresholds {
  const window = history.slice(-BASELINE_WINDOW);
  if (window.length < MIN_BASELINE_SESSIONS) {
    return {
      // Bootstrap defaults: loose enough not to fire on normal variance, tight
      // enough to catch a session that is clearly off the rails.
      errorRate: 0.5,
      turnP95Seconds: 120,
      ttftP95Seconds: 30,
      costBurnUsdPerMin: 5,
      pricingMissRate: 0.5,
      circuitOpens: 1,
      egressBlocked: 1,
      baselineSessions: window.length,
    };
  }
  const p95 = (pick: (s: SessionMetricsSnapshot) => number): number =>
    percentile(window.map(pick), 0.95);
  return {
    errorRate: Math.max(p95((s) => s.errorRate) * HEADROOM_FACTOR, 0.05),
    turnP95Seconds: p95((s) => s.turnP95Seconds) * HEADROOM_FACTOR,
    ttftP95Seconds: p95((s) => s.ttftP95Seconds) * HEADROOM_FACTOR,
    costBurnUsdPerMin: p95((s) => s.costBurnUsdPerMin) * HEADROOM_FACTOR,
    pricingMissRate:
      Math.max(
        p95((s) => s.pricingMisses / Math.max(s.modelCalls, 1)),
        0,
      ) * HEADROOM_FACTOR,
    circuitOpens: Math.max(
      p95((s) => s.circuitOpens),
      1,
    ),
    egressBlocked: Math.max(
      p95((s) => s.egressBlocked),
      1,
    ),
    baselineSessions: window.length,
  };
}

/** Compare a session snapshot against derived thresholds; list every breach. */
export function detectBreaches(
  snapshot: SessionMetricsSnapshot,
  thresholds: DerivedThresholds,
): Breach[] {
  const breaches: Breach[] = [];
  const add = (metric: string, observed: number, threshold: number, unit: string): void => {
    if (observed > threshold) {
      breaches.push({
        metric,
        observed,
        threshold,
        detail: `${metric} ${fmt(observed)}${unit} exceeded baseline threshold ${fmt(threshold)}${unit} (derived from ${thresholds.baselineSessions} session(s))`,
      });
    }
  };
  add("error_rate", snapshot.errorRate, thresholds.errorRate, "");
  add("turn_p95_seconds", snapshot.turnP95Seconds, thresholds.turnP95Seconds, "s");
  add("ttft_p95_seconds", snapshot.ttftP95Seconds, thresholds.ttftP95Seconds, "s");
  add("cost_burn_usd_per_min", snapshot.costBurnUsdPerMin, thresholds.costBurnUsdPerMin, "$/min");
  const missRate = snapshot.pricingMisses / Math.max(snapshot.modelCalls, 1);
  add("pricing_miss_rate", missRate, thresholds.pricingMissRate, "");
  add("circuit_opens", snapshot.circuitOpens, thresholds.circuitOpens, "");
  add("egress_blocked", snapshot.egressBlocked, thresholds.egressBlocked, "");
  return breaches;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

// --------- snapshot persistence (the only I/O this module owns) ---------

/** Read the persisted session history, oldest first. Torn lines are skipped. */
export function readMetricsHistory(
  metricsDir: string = DEFAULT_METRICS_DIR,
): SessionMetricsSnapshot[] {
  const path = join(metricsDir, METRICS_FILENAME);
  if (!existsSync(path)) return [];
  const out: SessionMetricsSnapshot[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as SessionMetricsSnapshot);
    } catch {
      // skip corrupt line — an append-only log must survive one torn write.
    }
  }
  return out;
}

/** Append one session snapshot to the history JSONL, creating dirs on first use. */
export function appendMetricsSnapshot(
  snapshot: SessionMetricsSnapshot,
  metricsDir: string = DEFAULT_METRICS_DIR,
): void {
  const path = join(metricsDir, METRICS_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`);
}

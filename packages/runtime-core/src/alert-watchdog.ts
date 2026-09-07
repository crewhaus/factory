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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FLOOR_BLOCKED_ROUTE_REASON as ROUTER_FLOOR_BLOCKED_ROUTE_REASON } from "@crewhaus/model-router";
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
 * F3 (ops pre-merge) — hard cap on how many lines `sessions.jsonl` is allowed
 * to grow to. `deriveThresholds` only ever looks at the trailing
 * {@link BASELINE_WINDOW} sessions, but `appendMetricsSnapshot` was
 * append-only and `readMetricsHistory` re-read (and re-parsed) the ENTIRE
 * file every session — unbounded growth for a file nothing ever reads past
 * its tail. 4× the baseline window is generous headroom over what
 * `deriveThresholds` consumes, with a 200-line floor so a small
 * `BASELINE_WINDOW` still keeps a useful amount of history for operators
 * eyeballing the file by hand.
 */
export const MAX_METRICS_HISTORY_LINES = Math.max(BASELINE_WINDOW * 4, 200);

/**
 * 0.6.0 (design §7.10) — the `model_route.reason` the learned policy records
 * when no non-floor arm is exploitable and it serves the floor arm instead.
 * The watchdog, the SLO monitor and metrics-collector all key `floor_block_rate`
 * on this string; the router publishes it verbatim and OWNS the constant
 * (`@crewhaus/model-router`, PR 10) — re-exported here so every consumer
 * imports one symbol instead of retyping the string.
 */
export const FLOOR_BLOCKED_ROUTE_REASON: typeof ROUTER_FLOOR_BLOCKED_ROUTE_REASON =
  ROUTER_FLOOR_BLOCKED_ROUTE_REASON;

/**
 * True for a `model_route` decision the quality floor forced onto the floor
 * arm. The router's reason is the bare constant; runtime-core may append its
 * own `; `-separated notes (an eligibility exclusion, `no-eligible-candidate`)
 * after it, so the match accepts that suffix too.
 */
export function isFloorBlockedRoute(ev: { readonly reason: string }): boolean {
  return (
    ev.reason === FLOOR_BLOCKED_ROUTE_REASON ||
    ev.reason.startsWith(`${FLOOR_BLOCKED_ROUTE_REASON}; `)
  );
}

/**
 * 0.6.0 (design §8.4) — the events that count as ONE escalation, shared by the
 * watchdog's `escalation_rate` and the SLO monitor's: a hybrid-strategy stage
 * whose role is `escalation` counts when it STARTS (its `done`/`failed` twin is
 * the same escalation), and a two-tier fast→default misroute recovery counts
 * on its `model_tier_route`. `eval_graded.escalatedTo` is deliberately NOT a
 * third source: under `on_fail: escalate` the strong re-run publishes its own
 * escalation stage, and counting both would double every cascade escalation.
 */
export function isEscalationEvent(ev: TraceEvent): boolean {
  if (ev.kind === "model_stage") return ev.role === "escalation" && ev.outcome === "started";
  if (ev.kind === "model_tier_route") return ev.escalated === true;
  return false;
}

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
  /** Errors that were NOT recovered (error_recovered action "fail" or "halt"). */
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
  // ---- 0.6.0 (design §8.4) — hybrid-routing signals. All OPTIONAL so the
  // snapshot lines persisted by 0.5.x keep parsing; readers fold an absent
  // field as 0 (no routing activity), never as "unknown".
  /** Escalations (see {@link isEscalationEvent}). */
  readonly escalations?: number;
  /** escalations / max(turns,1). */
  readonly escalationRate?: number;
  /** In-loop grades (`eval_graded`) plus judge-gate verdicts (`judge_verdict`). */
  readonly judgeVerdicts?: number;
  /** The failing subset of `judgeVerdicts`. */
  readonly judgeFails?: number;
  /** judgeFails / max(judgeVerdicts,1). */
  readonly judgeFailRate?: number;
  /** Pool routing decisions (`model_route`). */
  readonly routeDecisions?: number;
  /** Decisions the quality floor forced onto the floor arm ({@link isFloorBlockedRoute}). */
  readonly floorBlocks?: number;
  /** floorBlocks / max(routeDecisions,1). */
  readonly floorBlockRate?: number;
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
  // 0.6.0 (design §8.4) — hybrid-routing rate thresholds.
  readonly escalationRate: number;
  readonly judgeFailRate: number;
  readonly floorBlockRate: number;
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
  private escalations = 0;
  private judgeVerdicts = 0;
  private judgeFails = 0;
  private routeDecisions = 0;
  private floorBlocks = 0;
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
        // Only a terminal stop is an unrecovered error; retry/compact/etc.
        // are the recovery engine doing its job. "fail" is the generic
        // terminal action; "halt" (v0.3.0 Goal 6) is the CLASSIFIED
        // terminal action (billing/auth/rate-limit) — count both so the
        // error-rate baseline is unchanged by the taxonomy upgrade.
        if (ev.action === "fail" || ev.action === "halt") this.unrecoveredErrors += 1;
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
      // ---- 0.6.0 (design §8.4) — hybrid-routing signals. ----
      case "model_stage":
      case "model_tier_route":
        if (isEscalationEvent(ev)) this.escalations += 1;
        return;
      case "eval_graded":
      case "judge_verdict":
        // Every in-loop grade and judge-gate verdict is one judge verdict; the
        // `fail` subset is the numerator of `judge_fail_rate`. (This closes the
        // NEW-E-2 gap the old default branch documented: quality verdicts now
        // do fold into the watchdog — as a FAIL RATE against the session's own
        // history, not as a score threshold.) `response_rated` still stays out.
        this.judgeVerdicts += 1;
        if (ev.verdict === "fail") this.judgeFails += 1;
        return;
      case "model_route":
        this.routeDecisions += 1;
        if (isFloorBlockedRoute(ev)) this.floorBlocks += 1;
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
      escalations: this.escalations,
      escalationRate: this.escalations / Math.max(this.turns, 1),
      judgeVerdicts: this.judgeVerdicts,
      judgeFails: this.judgeFails,
      judgeFailRate: this.judgeFails / Math.max(this.judgeVerdicts, 1),
      routeDecisions: this.routeDecisions,
      floorBlocks: this.floorBlocks,
      floorBlockRate: this.floorBlocks / Math.max(this.routeDecisions, 1),
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
      // 0.6.0 — a cascade that escalates every other turn, a judge that fails
      // half its grades, or a floor that blocks half the decisions is a
      // hybrid setup that is not paying for itself; below that, normal.
      escalationRate: 0.5,
      judgeFailRate: 0.5,
      floorBlockRate: 0.5,
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
    // 0.6.0 — rates over history with the same 5% floor `errorRate` has, so a
    // baseline of zero escalations does not make the first one a breach on its
    // own; an absent field (a 0.5.x snapshot line) reads as no activity.
    escalationRate: Math.max(p95((s) => s.escalationRate ?? 0) * HEADROOM_FACTOR, 0.05),
    judgeFailRate: Math.max(p95((s) => s.judgeFailRate ?? 0) * HEADROOM_FACTOR, 0.05),
    floorBlockRate: Math.max(p95((s) => s.floorBlockRate ?? 0) * HEADROOM_FACTOR, 0.05),
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
  // 0.6.0 (design §8.4) — hybrid-routing rates. A session with no routing
  // activity reports 0 (or an absent field) and can never breach.
  add("escalation_rate", snapshot.escalationRate ?? 0, thresholds.escalationRate, "");
  add("judge_fail_rate", snapshot.judgeFailRate ?? 0, thresholds.judgeFailRate, "");
  add("floor_block_rate", snapshot.floorBlockRate ?? 0, thresholds.floorBlockRate, "");
  return breaches;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

// --------- snapshot persistence (the only I/O this module owns) ---------

/**
 * Read the persisted session history, oldest first. Torn lines are skipped.
 *
 * F3 — bounds itself to the trailing {@link MAX_METRICS_HISTORY_LINES} raw
 * lines BEFORE parsing, so a pre-existing oversized file (e.g. one written by
 * an older binary that predates the cap, or a file that grew past the cap
 * some other way) is never fully materialized into memory just to derive a
 * threshold from its tail. `appendMetricsSnapshot` keeps the file itself
 * trimmed going forward; this is the reader's independent bound.
 */
export function readMetricsHistory(
  metricsDir: string = DEFAULT_METRICS_DIR,
): SessionMetricsSnapshot[] {
  const path = join(metricsDir, METRICS_FILENAME);
  if (!existsSync(path)) return [];
  // Filter blank lines (incl. the trailing "" from the file's final newline)
  // BEFORE slicing to the trailing cap — slicing raw split() output would
  // waste one slot of the cap on that trailing empty entry.
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const bounded = lines.slice(-MAX_METRICS_HISTORY_LINES);
  const out: SessionMetricsSnapshot[] = [];
  for (const line of bounded) {
    try {
      out.push(JSON.parse(line.trim()) as SessionMetricsSnapshot);
    } catch {
      // skip corrupt line — an append-only log must survive one torn write.
    }
  }
  return out;
}

/**
 * Append one session snapshot to the history JSONL, creating dirs on first
 * use, then trim the file to its trailing {@link MAX_METRICS_HISTORY_LINES}
 * (F3 — the file otherwise grows forever even though `deriveThresholds` only
 * ever looks at the trailing {@link BASELINE_WINDOW}). The trim is a
 * temp-write + rename so a crash mid-trim never leaves a torn or truncated
 * file in place of the real one; a torn LINE within the kept tail is still
 * tolerated by `readMetricsHistory`.
 */
export function appendMetricsSnapshot(
  snapshot: SessionMetricsSnapshot,
  metricsDir: string = DEFAULT_METRICS_DIR,
): void {
  const path = join(metricsDir, METRICS_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`);

  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length <= MAX_METRICS_HISTORY_LINES) return;
  const trimmed = lines.slice(-MAX_METRICS_HISTORY_LINES);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${trimmed.join("\n")}\n`);
  renameSync(tmpPath, path);
}

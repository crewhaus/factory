/**
 * Ops item 37 — the production-signal SLO monitor.
 *
 * A bus subscriber (wired into `attachDefaultSubscribers`, gated by CREWHAUS_SLO
 * + a lowered `observability.slo` spec block) that folds live TraceEvents into
 * ROLLING TIME WINDOWS and, when a declared SLO target is breached for the whole
 * window (a SUSTAINED breach, not a single blip), walks the declared mitigation
 * ladder: `alert` (webhook/hook) → `pause-intake` (gateway/managed 429
 * `budget_exceeded` path) → `rollback` (auto-rollback the env pin via the
 * deployment-controller). Every rung is audit-logged through the same injected
 * seams the alert watchdog uses, so runtime-core owns no deployment-controller /
 * gateway / audit-log I/O — the caller (CLI / codegen) injects it.
 *
 * WHY A ROLLING WINDOW (vs the alert-watchdog's per-session snapshot): an SLO is
 * a live, in-flight guarantee — "p95 TTFT under 1.4s over the last 5 minutes" —
 * so it must fire DURING a run, not at session end. The watchdog grades a whole
 * session against history AFTER the fact; the SLO monitor grades a moving window
 * against a DECLARED target AS IT HAPPENS. The two are complementary and share
 * the same event-folding vocabulary (turn durations, TTFT, cost, egress).
 *
 * Pure/unit-tested core: the window accumulator, the breach detector, and the
 * ladder walk (with injected sinks) are side-effect-free apart from the trace
 * event the monitor publishes.
 */
import type { RunContext } from "@crewhaus/run-context";
import type { TraceEvent, TraceEventBus, Unsubscribe } from "@crewhaus/trace-event-bus";
import { percentile } from "./alert-watchdog";

/** A mitigation-ladder rung, in the order the monitor walks it on a breach. */
export type SloMitigationRung = "alert" | "pause-intake" | "rollback";

/** The SLO targets the monitor evaluates. Every field is optional; an omitted
 *  target is never checked. Mirrors the lowered `IrSlo` (camelCase). */
export type SloTargets = {
  readonly errorRate?: number;
  readonly p95LatencyMs?: number;
  readonly ttftMs?: number;
  readonly costPerHourUsd?: number;
  readonly egressBlockRate?: number;
  /** Rolling window (ms) a breach must persist before the ladder fires. */
  readonly windowMs?: number;
  readonly mitigation: ReadonlyArray<SloMitigationRung>;
};

/** Default rolling window when the spec omits `window_seconds`: 5 minutes. */
export const DEFAULT_SLO_WINDOW_MS = 5 * 60 * 1000;

/** A single SLO breach found by {@link detectSloBreaches}. */
export type SloBreach = {
  readonly metric: string;
  readonly observed: number;
  readonly target: number;
  readonly detail: string;
};

/** The payload handed to the mitigation sink for each ladder rung executed. */
export type SloMitigationEvent = {
  readonly sessionId: string;
  readonly rung: SloMitigationRung;
  readonly breach: SloBreach;
  readonly windowMs: number;
};

/**
 * Injected mitigation sink — the ladder rungs beyond the trace event + the
 * always-on `alert_raised`-style delivery the alert watchdog already owns.
 * Every callback is OPTIONAL and supplied by the caller so runtime-core stays
 * free of deployment-controller / gateway / audit-log I/O:
 *   - `alert`        → webhook/hook delivery + audit append (reuses the alert
 *                      sink the CLI already builds);
 *   - `pauseIntake`  → flip the gateway/managed daemon's intake gate so new
 *                      requests get the 429 `budget_exceeded` path until cleared;
 *   - `rollback`     → auto-rollback the env pin via the deployment-controller.
 * A rung with no injected handler is a no-op (still audit-logged as attempted),
 * so an SLO spec that asks for `rollback` on a shape with no controller wired
 * degrades to alert-only rather than crashing.
 */
export type SloMitigationSink = {
  alert?: (event: SloMitigationEvent) => Promise<void>;
  pauseIntake?: (event: SloMitigationEvent) => Promise<void>;
  rollback?: (event: SloMitigationEvent) => Promise<void>;
  /** Audit every ATTEMPTED rung (even a no-op one) — one durable record. */
  audit?: (event: SloMitigationEvent) => Promise<void>;
};

// --------- rolling-window event folding ---------

/** One timestamped observation kept in a rolling window. */
type Sample = { readonly ts: number; readonly value: number };

/**
 * Accumulates a session's SLO signals into rolling windows keyed by wall-clock
 * timestamp. `evaluate(now)` prunes everything older than `windowMs`, then
 * computes the window's rate/percentile metrics. Mirrors the alert-watchdog's
 * event→metric vocabulary (turn_end duration, TTFT from model_request→first
 * model_stream_token, cost accrual, egress verdicts) so the monitor does not
 * depend on the opt-in metrics-collector being attached.
 */
export class SloWindow {
  private readonly turnLatencies: Sample[] = [];
  private readonly ttfts: Sample[] = [];
  private readonly costMicros: Sample[] = [];
  private readonly modelCalls: Sample[] = [];
  private readonly unrecoveredErrors: Sample[] = [];
  private readonly externalCalls: Sample[] = [];
  private readonly egressBlocks: Sample[] = [];
  private readonly requestStarts = new Map<string, number>();
  private readonly ttftSeen = new Set<string>();

  constructor(private readonly windowMs: number) {}

  /** Fold one event into the window. `ev.timestamp` seeds the sample time. */
  fold(ev: TraceEvent): void {
    const t = Date.parse(ev.timestamp);
    if (Number.isNaN(t)) return;
    switch (ev.kind) {
      case "turn_end":
        this.turnLatencies.push({ ts: t, value: ev.durationMs });
        return;
      case "model_request":
        this.requestStarts.set(ev.traceId, t);
        this.ttftSeen.delete(ev.traceId);
        return;
      case "model_stream_token": {
        if (this.ttftSeen.has(ev.traceId)) return;
        const start = this.requestStarts.get(ev.traceId);
        if (start === undefined) return;
        this.ttfts.push({ ts: t, value: Math.max(0, t - start) });
        this.ttftSeen.add(ev.traceId);
        return;
      }
      case "model_response":
        this.modelCalls.push({ ts: t, value: 1 });
        this.requestStarts.delete(ev.traceId);
        this.ttftSeen.delete(ev.traceId);
        return;
      case "error_recovered":
        if (ev.action === "fail") this.unrecoveredErrors.push({ ts: t, value: 1 });
        return;
      case "cost_accrual":
        // Skip the FR-003 terminal aggregate (summary:true) — it double-counts.
        if (ev.summary === true) return;
        this.costMicros.push({ ts: t, value: ev.costUsdMicros });
        return;
      case "permission_decision":
        // No egress_* TraceEvent kind exists — derive the egress-block rate from
        // the permission_decision egress outcomes. Every egress verdict (passed
        // /warned/blocked) is one external-sink call attempt; the blocked subset
        // is the numerator.
        if (
          ev.outcome === "egress-passed" ||
          ev.outcome === "egress-warned" ||
          ev.outcome === "egress-blocked"
        ) {
          this.externalCalls.push({ ts: t, value: 1 });
          if (ev.outcome === "egress-blocked") this.egressBlocks.push({ ts: t, value: 1 });
        }
        return;
      default:
        return;
    }
  }

  /**
   * Compute the current window's SLO metrics at `now`, pruning samples older
   * than `windowMs` first. Returns `undefined`-valued metrics as 0 counts /
   * empty percentiles so the detector can decide "no data yet" per metric.
   */
  evaluate(now: number): SloWindowMetrics {
    const cutoff = now - this.windowMs;
    const prune = (arr: Sample[]): void => {
      while (arr.length > 0 && (arr[0]?.ts ?? 0) < cutoff) arr.shift();
    };
    prune(this.turnLatencies);
    prune(this.ttfts);
    prune(this.costMicros);
    prune(this.modelCalls);
    prune(this.unrecoveredErrors);
    prune(this.externalCalls);
    prune(this.egressBlocks);

    const modelCalls = this.modelCalls.length;
    const externalCalls = this.externalCalls.length;
    const costUsd = this.costMicros.reduce((s, x) => s + x.value, 0) / 1_000_000;
    // Cost-per-hour is the windowed spend extrapolated to a full hour; a short
    // window that has already burned $X projects to $X × (hour / window).
    const windowHours = this.windowMs / 3_600_000;
    return {
      turnP95Ms: percentile(
        this.turnLatencies.map((s) => s.value),
        0.95,
      ),
      turnSamples: this.turnLatencies.length,
      ttftP95Ms: percentile(
        this.ttfts.map((s) => s.value),
        0.95,
      ),
      ttftSamples: this.ttfts.length,
      errorRate: modelCalls > 0 ? this.unrecoveredErrors.length / modelCalls : 0,
      modelCalls,
      costPerHourUsd: windowHours > 0 ? costUsd / windowHours : 0,
      egressBlockRate: externalCalls > 0 ? this.egressBlocks.length / externalCalls : 0,
      externalCalls,
    };
  }
}

export type SloWindowMetrics = {
  readonly turnP95Ms: number;
  readonly turnSamples: number;
  readonly ttftP95Ms: number;
  readonly ttftSamples: number;
  readonly errorRate: number;
  readonly modelCalls: number;
  readonly costPerHourUsd: number;
  readonly egressBlockRate: number;
  readonly externalCalls: number;
};

/**
 * Minimum samples a rate/percentile metric needs before it can breach — a
 * single erroring call is a 100% error rate but not an SLO violation. Keeps the
 * monitor from firing on cold-start noise. Cost has no minimum (a single call
 * that projects over-budget IS a burn-rate breach).
 */
export const MIN_SLO_SAMPLES = 5;

// --------- breach detection ---------

/**
 * Compare a window's metrics against the declared targets; list every breach.
 * A "higher-is-worse" target breaches when observed > target AND the metric has
 * enough samples to trust (see {@link MIN_SLO_SAMPLES}); cost-per-hour needs no
 * minimum. A target the spec omitted is never checked.
 */
export function detectSloBreaches(metrics: SloWindowMetrics, targets: SloTargets): SloBreach[] {
  const breaches: SloBreach[] = [];
  const add = (
    metric: string,
    observed: number,
    target: number | undefined,
    enoughSamples: boolean,
    fmt: (n: number) => string,
  ): void => {
    if (target === undefined || !enoughSamples) return;
    if (observed > target) {
      breaches.push({
        metric,
        observed,
        target,
        detail: `${metric} ${fmt(observed)} exceeded SLO target ${fmt(target)}`,
      });
    }
  };
  const ms = (n: number): string => `${Math.round(n)}ms`;
  const rate = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const usd = (n: number): string => `$${n.toFixed(2)}/h`;

  add(
    "error_rate",
    metrics.errorRate,
    targets.errorRate,
    metrics.modelCalls >= MIN_SLO_SAMPLES,
    rate,
  );
  add(
    "p95_latency_ms",
    metrics.turnP95Ms,
    targets.p95LatencyMs,
    metrics.turnSamples >= MIN_SLO_SAMPLES,
    ms,
  );
  add("ttft_ms", metrics.ttftP95Ms, targets.ttftMs, metrics.ttftSamples >= MIN_SLO_SAMPLES, ms);
  add("cost_per_hour_usd", metrics.costPerHourUsd, targets.costPerHourUsd, true, usd);
  add(
    "egress_block_rate",
    metrics.egressBlockRate,
    targets.egressBlockRate,
    metrics.externalCalls >= MIN_SLO_SAMPLES,
    rate,
  );
  return breaches;
}

// --------- attach ---------

export type AttachedSloMonitor = {
  /** Force an evaluation now (the periodic timer normally drives this). */
  evaluate(): Promise<void>;
  unsubscribe: Unsubscribe;
  /** Stop the periodic evaluation timer. */
  stop(): void;
};

export type AttachSloMonitorOptions = {
  /** The lowered SLO targets from `observability.slo` (required — the monitor is
   *  a no-op without a spec block, mirroring the alert watchdog's env+spec gate). */
  readonly targets?: SloTargets;
  /** Injected mitigation delivery (see {@link SloMitigationSink}). */
  readonly sink?: SloMitigationSink;
  /** How often to evaluate the window, ms. Default: min(windowMs, 30s). */
  readonly evalIntervalMs?: number;
  /** Override the timer scheduler (tests). */
  readonly setInterval?: (cb: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Override now() (tests). */
  readonly now?: () => number;
};

/**
 * Attach the SLO monitor when CREWHAUS_SLO is set AND a lowered `targets` block
 * is supplied. Folds events into a {@link SloWindow}; a periodic timer evaluates
 * the window and, on a sustained breach, walks the declared mitigation ladder
 * (each rung executed at most once per session — a mitigated breach must not
 * re-fire every tick). Returns undefined (a no-op) when the env gate is off or
 * no targets are declared, so it adds zero overhead by default.
 */
export function attachSloMonitor(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv,
  options: AttachSloMonitorOptions = {},
): AttachedSloMonitor | undefined {
  const gate = env["CREWHAUS_SLO"];
  if (gate !== "1" && gate !== "true") return undefined;
  const targets = options.targets;
  if (targets === undefined) return undefined;

  const windowMs = targets.windowMs ?? DEFAULT_SLO_WINDOW_MS;
  const now = options.now ?? ((): number => Date.now());
  const window = new SloWindow(windowMs);
  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    window.fold(event);
  });

  // One-shot guard per rung: once a breach walks the ladder and executes a
  // rung, that rung never re-fires this session (a paused intake / rolled-back
  // pin stays put; re-alerting every 30s is noise). Keyed by rung name.
  const firedRungs = new Set<SloMitigationRung>();
  const sink = options.sink;

  const walkLadder = async (breach: SloBreach): Promise<void> => {
    for (const rung of targets.mitigation) {
      if (firedRungs.has(rung)) continue;
      firedRungs.add(rung);
      const event: SloMitigationEvent = {
        sessionId: runContext.sessionId,
        rung,
        breach,
        windowMs,
      };
      // Publish the live observable surface first (reuses alert_raised — an SLO
      // breach IS a threshold breach; `metric` carries the SLO metric name).
      const envelope = bus.envelope();
      bus.publish({
        ...envelope,
        kind: "alert_raised",
        metric: `slo:${breach.metric}`,
        observed: breach.observed,
        threshold: breach.target,
        baselineSessions: 0,
        detail: `SLO mitigation [${rung}]: ${breach.detail} (window ${Math.round(windowMs / 1000)}s)`,
      });
      // Audit the attempt (even a no-op rung), then run the injected handler.
      if (sink?.audit !== undefined) {
        await sink.audit(event).catch((err) => logSloError(runContext, "slo-audit", err));
      }
      const handler =
        rung === "alert"
          ? sink?.alert
          : rung === "pause-intake"
            ? sink?.pauseIntake
            : sink?.rollback;
      if (handler !== undefined) {
        await handler(event).catch((err) => logSloError(runContext, `slo-${rung}`, err));
      }
    }
  };

  const evaluate = async (): Promise<void> => {
    const metrics = window.evaluate(now());
    const breaches = detectSloBreaches(metrics, targets);
    // Walk the ladder on the FIRST (worst-priority) breach — the mitigation
    // rungs (pause intake, rollback) are session-global actions, so mitigating
    // one breached SLO stabilises the run; a second metric's breach does not
    // warrant a second independent rollback.
    const first = breaches[0];
    if (first !== undefined) await walkLadder(first);
  };

  const intervalMs = options.evalIntervalMs ?? Math.min(windowMs, 30_000);
  const schedule = options.setInterval ?? ((cb, ms): unknown => setInterval(cb, ms));
  const cancel =
    options.clearInterval ?? ((h): void => clearInterval(h as ReturnType<typeof setInterval>));
  const timer = schedule(() => {
    void evaluate().catch((err) => logSloError(runContext, "slo-eval", err));
  }, intervalMs);
  // Node timers keep the event loop alive; unref so a short CLI run can exit
  // without waiting on the next tick (best-effort — a fake timer has no unref).
  (timer as { unref?: () => void })?.unref?.();

  return {
    evaluate,
    unsubscribe,
    stop: (): void => cancel(timer),
  };
}

function logSloError(runContext: RunContext, name: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  runContext.logger.error("slo_monitor.failed", { name, message });
}

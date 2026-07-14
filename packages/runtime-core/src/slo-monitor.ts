/**
 * Ops item 37 — the production-signal SLO monitor.
 *
 * A bus subscriber (wired into `attachDefaultSubscribers`, gated by CREWHAUS_SLO
 * + a lowered `observability.slo` spec block) that folds live TraceEvents into
 * ROLLING TIME WINDOWS and walks the declared mitigation ladder: `alert`
 * (webhook/hook) → `pause-intake` (gateway/managed 429 `budget_exceeded` path) →
 * `rollback` (auto-rollback the env pin via the deployment-controller). The
 * `alert` rung fires immediately on the first breached evaluation; the
 * DESTRUCTIVE rungs (`pause-intake`, `rollback`) fire ONLY on a SUSTAINED
 * breach — the same metric breached for ≥ N consecutive evaluations spanning at
 * least the declared window, never on a single transient tick (a blip that
 * clears resets the streak). When the breach clears, a paused intake is resumed
 * and the pause rung re-arms. Every rung is audit-logged through the same
 * injected seams the alert watchdog uses, so runtime-core owns no
 * deployment-controller / gateway / audit-log I/O — the caller (CLI / codegen)
 * injects it.
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
  /** RESUME intake — called when a paused breach clears so the durable gate is
   *  flipped back to `paused:false` and admission re-opens. Optional: a shape
   *  with no gate leaves this undefined and the pause simply stays until an
   *  operator clears it. */
  resumeIntake?: (event: SloMitigationEvent) => Promise<void>;
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
  /** Wall-clock time of the FIRST event ever folded — lets `evaluate` report how
   *  long the monitor has actually been observing, so a rate metric (cost/hour)
   *  extrapolated from a near-empty window that has only existed for a few
   *  seconds is not mistaken for a sustained burn. */
  private firstFoldTs: number | undefined;

  constructor(private readonly windowMs: number) {}

  /** Fold one event into the window. `ev.timestamp` seeds the sample time. */
  fold(ev: TraceEvent): void {
    const t = Date.parse(ev.timestamp);
    if (Number.isNaN(t)) return;
    if (this.firstFoldTs === undefined || t < this.firstFoldTs) this.firstFoldTs = t;
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
        // "fail" (generic) and "halt" (v0.3.0 classified terminal stop) are
        // both unrecovered — mirror alert-watchdog's accounting.
        if (ev.action === "fail" || ev.action === "halt") {
          this.unrecoveredErrors.push({ ts: t, value: 1 });
        }
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
    // How long the monitor has actually been observing, capped at the rolling
    // window (samples older than `windowMs` were pruned above). A cold-start run
    // that has only existed for a few seconds reports a small elapsed span even
    // though `windowMs` is 5 minutes.
    const observedMs =
      this.firstFoldTs === undefined
        ? 0
        : Math.min(this.windowMs, Math.max(0, now - this.firstFoldTs));
    // Cost-per-hour is the observed spend extrapolated to a full hour. It is
    // annualised over the ACTUAL elapsed observation span, NOT the nominal
    // window — extrapolating $0.20 spent in the first 3 seconds of a run to a
    // 5-minute window ($4.80/h) would fabricate a burn-rate breach. The detector
    // additionally floors this with a min-sample + min-elapsed gate.
    const extrapolationHours = observedMs / 3_600_000;
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
      costPerHourUsd: extrapolationHours > 0 ? costUsd / extrapolationHours : 0,
      costSamples: this.costMicros.length,
      windowElapsedMs: observedMs,
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
  /** Number of non-summary `cost_accrual` samples in the window. */
  readonly costSamples: number;
  /** Wall-clock span (ms) actually observed, capped at the rolling window. */
  readonly windowElapsedMs: number;
  readonly egressBlockRate: number;
  readonly externalCalls: number;
};

/**
 * Minimum samples a rate/percentile metric needs before it can breach — a
 * single erroring call is a 100% error rate but not an SLO violation. Keeps the
 * monitor from firing on cold-start noise. Cost uses its own (smaller) sample
 * floor plus a min-elapsed-window floor (see {@link MIN_COST_SAMPLES} /
 * {@link MIN_COST_ELAPSED_MS}) rather than {@link MIN_SLO_SAMPLES}, because a
 * genuine burn spike can breach on fewer calls than a percentile needs.
 */
export const MIN_SLO_SAMPLES = 5;

/**
 * Cost-per-hour (and any spend RATE) is an extrapolation, so it needs its own
 * floor: a single cold-start turn ($0.20 over the run's first 3 seconds) must
 * NOT project to $12/h and count as a burn breach. Require at least this many
 * cost samples AND (via {@link MIN_COST_ELAPSED_MS}) a minimum observation span
 * before the projection is trusted.
 */
export const MIN_COST_SAMPLES = 3;

/**
 * Minimum wall-clock span the window must have observed before a spend-rate
 * extrapolation is trusted (30s). Below this the numerator (spend) is divided
 * by a tiny denominator (elapsed hours), inflating the projection wildly.
 */
export const MIN_COST_ELAPSED_MS = 30_000;

// --------- breach detection ---------

/**
 * Compare a window's metrics against the declared targets; list every breach.
 * A "higher-is-worse" target breaches when observed > target AND the metric has
 * enough samples to trust (see {@link MIN_SLO_SAMPLES}); cost-per-hour, being an
 * extrapolation, requires its own {@link MIN_COST_SAMPLES} + {@link
 * MIN_COST_ELAPSED_MS} floor so a 1–2-sample near-empty fresh window can never
 * project to a false burn breach. A target the spec omitted is never checked.
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
  add(
    "cost_per_hour_usd",
    metrics.costPerHourUsd,
    targets.costPerHourUsd,
    metrics.costSamples >= MIN_COST_SAMPLES && metrics.windowElapsedMs >= MIN_COST_ELAPSED_MS,
    usd,
  );
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
 * The DESTRUCTIVE ladder rungs — the ones that change live production state.
 * These fire only on a SUSTAINED breach (see {@link attachSloMonitor}); `alert`
 * is the only immediate rung.
 */
const DESTRUCTIVE_RUNGS: ReadonlySet<SloMitigationRung> = new Set(["pause-intake", "rollback"]);

/**
 * Minimum number of CONSECUTIVE breached evaluations a metric must accumulate
 * before a destructive rung fires. A breach must ALSO have persisted for at
 * least the declared window (see {@link attachSloMonitor}); this second gate
 * guards against a fast eval interval satisfying "N evaluations" in a couple of
 * seconds. A single blip that clears on the next tick resets the counter.
 */
export const SUSTAINED_MIN_EVALS = 2;

/**
 * Attach the SLO monitor when CREWHAUS_SLO is set AND a lowered `targets` block
 * is supplied. Folds events into a {@link SloWindow}; a periodic timer evaluates
 * the window and walks the declared mitigation ladder.
 *
 * SUSTAINED-BREACH GATING: the `alert` rung fires immediately on the first
 * breached evaluation (an operator wants to hear about a spike as it starts).
 * The DESTRUCTIVE rungs (`pause-intake`, `rollback`) fire ONLY after the SAME
 * metric has been breached for at least {@link SUSTAINED_MIN_EVALS} consecutive
 * evaluations AND that breach has persisted for at least the declared window —
 * i.e. a real sustained violation, never a single transient tick. A metric
 * whose breach clears on any evaluation resets its consecutive counter, so a
 * blip cannot accumulate toward a rollback.
 *
 * RESUME: when NO metric is currently breached and this monitor had paused
 * intake, it resumes intake (via the sink's `resumeIntake`) and re-arms the
 * `pause-intake` rung so a future sustained breach can pause again. `alert` and
 * `rollback` stay one-shot per session (re-alerting / re-rolling every tick is
 * noise, and a rollback that stuck is intentionally sticky).
 *
 * Returns undefined (a no-op) when the env gate is off or no targets are
 * declared, so it adds zero overhead by default.
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

  // One-shot guard for the sticky rungs (`alert`, `rollback`): once fired, they
  // never re-fire this session (a rolled-back pin stays put; re-alerting every
  // tick is noise). `pause-intake` is NOT one-shot — it re-arms on resume so a
  // later breach can re-pause; its live state is `intakePaused` below.
  const firedRungs = new Set<SloMitigationRung>();
  // Whether THIS monitor currently holds intake paused (drives resume + re-arm).
  let intakePaused = false;
  // Per-metric consecutive-breach tracking: how many back-to-back evaluations a
  // metric has been breached, and when the streak began. A metric absent from a
  // given evaluation's breach list is cleared (a blip resets the streak).
  const breachStreaks = new Map<string, { since: number; consecutive: number }>();
  const sink = options.sink;

  const publishRungEvent = (rung: SloMitigationRung, breach: SloBreach): void => {
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
  };

  const runRung = async (rung: SloMitigationRung, breach: SloBreach): Promise<void> => {
    const event: SloMitigationEvent = { sessionId: runContext.sessionId, rung, breach, windowMs };
    publishRungEvent(rung, breach);
    // Audit the attempt (even a no-op rung), then run the injected handler.
    if (sink?.audit !== undefined) {
      await sink.audit(event).catch((err) => logSloError(runContext, "slo-audit", err));
    }
    const handler =
      rung === "alert" ? sink?.alert : rung === "pause-intake" ? sink?.pauseIntake : sink?.rollback;
    if (handler !== undefined) {
      await handler(event).catch((err) => logSloError(runContext, `slo-${rung}`, err));
    }
  };

  const resumeIntake = async (breach: SloBreach): Promise<void> => {
    intakePaused = false;
    // Re-arm the pause rung so a future sustained breach can pause again.
    firedRungs.delete("pause-intake");
    const event: SloMitigationEvent = {
      sessionId: runContext.sessionId,
      rung: "pause-intake",
      breach,
      windowMs,
    };
    const envelope = bus.envelope();
    bus.publish({
      ...envelope,
      kind: "alert_raised",
      metric: `slo:${breach.metric}`,
      observed: breach.observed,
      threshold: breach.target,
      baselineSessions: 0,
      detail: `SLO mitigation [pause-intake:resume]: ${breach.detail} cleared — intake resumed (window ${Math.round(windowMs / 1000)}s)`,
    });
    if (sink?.audit !== undefined) {
      await sink.audit(event).catch((err) => logSloError(runContext, "slo-audit", err));
    }
    if (sink?.resumeIntake !== undefined) {
      await sink.resumeIntake(event).catch((err) => logSloError(runContext, "slo-resume", err));
    }
  };

  const evaluate = async (): Promise<void> => {
    const t = now();
    const metrics = window.evaluate(t);
    const breaches = detectSloBreaches(metrics, targets);

    // Update the per-metric consecutive-breach streaks: bump the metrics that
    // are breached this tick, drop the ones that cleared (a blip resets).
    const breachedMetrics = new Set(breaches.map((b) => b.metric));
    for (const metric of [...breachStreaks.keys()]) {
      if (!breachedMetrics.has(metric)) breachStreaks.delete(metric);
    }
    for (const b of breaches) {
      const prior = breachStreaks.get(b.metric);
      if (prior === undefined) breachStreaks.set(b.metric, { since: t, consecutive: 1 });
      else breachStreaks.set(b.metric, { since: prior.since, consecutive: prior.consecutive + 1 });
    }

    // No breach this tick: if this monitor is holding intake paused, the breach
    // has cleared — resume + re-arm so a future breach can re-pause.
    const first = breaches[0];
    if (first === undefined) {
      if (intakePaused) {
        // The specific metric we paused on has cleared; report a synthetic
        // cleared breach (the resume helper re-arms the pause rung + flips the
        // durable gate back via the injected sink, if any).
        await resumeIntake({
          metric: "slo",
          observed: 0,
          target: 0,
          detail: "all SLO metrics within target",
        });
      }
      return;
    }

    // A metric's breach is SUSTAINED when it has been breached for at least
    // SUSTAINED_MIN_EVALS consecutive evaluations AND has persisted for at least
    // the declared window. Prefer the first breach (worst priority) that is
    // sustained for destructive rungs; the alert rung uses the first breach.
    const sustained = breaches.find((b) => {
      const s = breachStreaks.get(b.metric);
      return s !== undefined && s.consecutive >= SUSTAINED_MIN_EVALS && t - s.since >= windowMs;
    });

    // Walk the ladder in declared order. Destructive rungs require a sustained
    // breach; `alert` fires on any current breach. Each rung is session-global,
    // so we mitigate against a single breach (the sustained one for destructive
    // rungs, else the first breach for alert).
    for (const rung of targets.mitigation) {
      if (DESTRUCTIVE_RUNGS.has(rung)) {
        if (sustained === undefined) continue; // not sustained yet — wait
        if (rung === "pause-intake") {
          if (intakePaused) continue; // already paused; nothing to re-do
          intakePaused = true;
          await runRung(rung, sustained);
          continue;
        }
        // rollback — one-shot per session.
        if (firedRungs.has(rung)) continue;
        firedRungs.add(rung);
        await runRung(rung, sustained);
      } else {
        // alert — immediate, one-shot per session.
        if (firedRungs.has(rung)) continue;
        firedRungs.add(rung);
        await runRung(rung, first);
      }
    }
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

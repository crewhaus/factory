import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type CostTracker, createCostTracker, formatUsdMicros } from "@crewhaus/cost-tracker";
import type { EventKind, EventLog } from "@crewhaus/event-log";
import {
  type AttachedMetrics,
  attachIfEnvSet as attachMetricsIfEnvSet,
} from "@crewhaus/metrics-collector";
import {
  type AttachedOtelExporter,
  attachIfEnvSet as attachOtelIfEnvSet,
} from "@crewhaus/otel-exporter";
/**
 * Section 15 — attach the default observability subscribers to a
 * `TraceEventBus` based on environment variables. Returns a single `flushAll`
 * the orchestrator awaits in its `finally` block.
 *
 *   CREWHAUS_TRACE=pretty|json    → structured-event-printer
 *   CREWHAUS_METRICS=stdout|...   → metrics-collector (buffered stdout JSON / textfile / http)
 *   OTEL_EXPORTER_OTLP_ENDPOINT   → otel-exporter (OTLP/HTTP, gen_ai/* attributes)
 *   CREWHAUS_COST_TRACKING=1      → cost-tracker (Section 27 — emits cost_accrual events)
 *   CREWHAUS_COST_INLINE=1        → CLI inline cost line per turn (requires CREWHAUS_COST_TRACKING)
 *   CREWHAUS_SECURITY_DIGEST=1    → per-run security tally, one stderr line at end of run (item 48)
 *
 * All are opt-in. With no env vars set this function returns a no-op
 * `flushAll` so observability adds zero output and zero overhead.
 */
import type { RunContext } from "@crewhaus/run-context";
import {
  type AttachedPrinter,
  attachIfEnvSet as attachPrinterIfEnvSet,
  formatJsonLine,
} from "@crewhaus/structured-event-printer";
import type {
  CostAccrualEvent,
  JudgeVerdictEvent,
  ModelDirectiveEvent,
  ModelFailoverEvent,
  ModelStageEvent,
  TraceEvent,
  TraceEventBus,
  Unsubscribe,
} from "@crewhaus/trace-event-bus";
import {
  SessionMetricsAccumulator,
  appendMetricsSnapshot,
  deriveThresholds,
  detectBreaches,
  readMetricsHistory,
} from "./alert-watchdog";
import {
  type AttachedSloMonitor,
  type SloMitigationSink,
  type SloTargets,
  attachSloMonitor,
} from "./slo-monitor";

export type AttachedSubscribers = {
  printer: AttachedPrinter | undefined;
  metrics: AttachedMetrics | undefined;
  otel: AttachedOtelExporter | undefined;
  costTracker: CostTracker | undefined;
  costInlineUnsubscribe: Unsubscribe | undefined;
  /** Item 48 — per-run security tally (undefined unless CREWHAUS_SECURITY_DIGEST is set). */
  securityTally: SecurityTally | undefined;
  flushAll(): Promise<void>;
  shutdownAll(): Promise<void>;
};

/**
 * Format a single `cost_accrual` event as a one-line CLI status:
 *   `[💸 $0.0042 · 12.3k in / 1.1k out · model=claude-sonnet-4-6]`
 *
 * Exported so target-cli's emitted bundle can render the same format
 * without re-implementing it.
 */
export function formatCostInlineLine(ev: CostAccrualEvent): string {
  const cost = formatUsdMicros(ev.costUsdMicros);
  const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `[💸 ${cost} · ${fmtTokens(ev.inputTokens)} in / ${fmtTokens(ev.outputTokens)} out · model=${ev.modelId}]`;
}

/**
 * Item 48 — the live half of `crewhaus security digest`: a per-run tally of
 * security-relevant TraceEvents, gated behind CREWHAUS_SECURITY_DIGEST=1.
 * The durable audit-log rollup (the CLI command) answers "what happened this
 * week?"; this answers "what did THIS run trip?" without waiting for the
 * offline walk. When anything was tallied, one summary line lands on STDERR
 * at end of run — stderr so it never contaminates piped agent output.
 */
export type SecurityTally = {
  /** Justification-gate denials (permission_decision with judgeModel + deny). */
  justificationDenials: number;
  /** Plain permission-policy denials (no judge identity, no outcome). */
  permissionDenials: number;
  /** Egress classifier warn-tier verdicts (outcome: "egress-warned"). */
  egressWarned: number;
  /** Egress classifier block-tier verdicts (outcome: "egress-blocked"). */
  egressBlocked: number;
  /** Injection classifier redactions (outcome: "redacted"). */
  injectionRedactions: number;
  /** Injection classifier suspicious-but-kept warns (outcome: "warned"). */
  injectionWarnings: number;
  /** Detector rule-id → hit count, from redacted/warned events' `rules`. */
  injectionRuleHits: Record<string, number>;
  /** pre/post-tool hooks that denied (hook_fired with allowed: false). */
  hookDenials: number;
  /** Circuit-breaker transitions INTO "open" (a provider went degraded). */
  circuitOpens: number;
  /** Circuit-breaker recoveries (non-closed → "closed"). */
  circuitRecoveries: number;
};

export function createSecurityTally(): SecurityTally {
  return {
    justificationDenials: 0,
    permissionDenials: 0,
    egressWarned: 0,
    egressBlocked: 0,
    injectionRedactions: 0,
    injectionWarnings: 0,
    injectionRuleHits: {},
    hookDenials: 0,
    circuitOpens: 0,
    circuitRecoveries: 0,
  };
}

/**
 * Fold one TraceEvent into the tally. Returns true when the event counted.
 * Classification rules (kept mutually exclusive so nothing double-counts):
 *   - a `permission_decision` carrying an outcome (egress-warned,
 *     egress-blocked, redacted, warned) is an egress/injection verdict,
 *     NEVER also a plain permission denial (the egress-blocked event
 *     carries decision "deny" too);
 *   - a `judgeModel` marks the justification gate — deny → justification
 *     denial;
 *   - remaining decision "deny" events are plain policy denials. "ask" is
 *     not tallied — a prompt is not an incident.
 */
export function tallySecurityEvent(tally: SecurityTally, event: TraceEvent): boolean {
  switch (event.kind) {
    case "permission_decision": {
      if (event.outcome !== undefined) {
        if (event.outcome === "egress-warned") tally.egressWarned += 1;
        else if (event.outcome === "egress-blocked") tally.egressBlocked += 1;
        else if (event.outcome === "redacted") tally.injectionRedactions += 1;
        else if (event.outcome === "warned") tally.injectionWarnings += 1;
        else return false; // "egress-passed" — clean, not security-relevant
        if (event.outcome === "redacted" || event.outcome === "warned") {
          for (const rule of event.rules ?? []) {
            tally.injectionRuleHits[rule] = (tally.injectionRuleHits[rule] ?? 0) + 1;
          }
        }
        return true;
      }
      if (event.decision !== "deny") return false;
      if (event.judgeModel !== undefined) tally.justificationDenials += 1;
      else tally.permissionDenials += 1;
      return true;
    }
    case "hook_fired": {
      if (event.allowed) return false;
      tally.hookDenials += 1;
      return true;
    }
    case "circuit_state_changed": {
      if (event.toState === "open") {
        tally.circuitOpens += 1;
        return true;
      }
      if (event.toState === "closed" && event.fromState !== "closed") {
        tally.circuitRecoveries += 1;
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Sum of every tallied counter — 0 means "print nothing at end of run". */
export function securityTallyTotal(tally: SecurityTally): number {
  return (
    tally.justificationDenials +
    tally.permissionDenials +
    tally.egressWarned +
    tally.egressBlocked +
    tally.injectionRedactions +
    tally.injectionWarnings +
    tally.hookDenials +
    tally.circuitOpens +
    tally.circuitRecoveries
  );
}

/**
 * Format the end-of-run summary line. Only non-zero segments render, e.g.
 *   `[security] 2 justification denial(s) · 1 egress block(s) · 1 injection
 *    redaction(s) [rules: exfil-url ×2] — run crewhaus security digest …`
 * Exported so target bundles (and tests) can render the identical format,
 * mirroring `formatCostInlineLine`.
 */
export function formatSecurityTallyLine(tally: SecurityTally): string {
  const parts: string[] = [];
  if (tally.justificationDenials > 0)
    parts.push(`${tally.justificationDenials} justification denial(s)`);
  if (tally.permissionDenials > 0) parts.push(`${tally.permissionDenials} permission denial(s)`);
  if (tally.egressWarned > 0) parts.push(`${tally.egressWarned} egress warn(s)`);
  if (tally.egressBlocked > 0) parts.push(`${tally.egressBlocked} egress block(s)`);
  if (tally.injectionRedactions > 0)
    parts.push(`${tally.injectionRedactions} injection redaction(s)`);
  if (tally.injectionWarnings > 0) parts.push(`${tally.injectionWarnings} injection warning(s)`);
  if (tally.hookDenials > 0) parts.push(`${tally.hookDenials} hook denial(s)`);
  if (tally.circuitOpens > 0) parts.push(`${tally.circuitOpens} circuit open(s)`);
  if (tally.circuitRecoveries > 0) parts.push(`${tally.circuitRecoveries} circuit recovery(-ies)`);
  const rules = Object.entries(tally.injectionRuleHits)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, n]) => `${rule} ×${n}`)
    .join(", ");
  return `[security] ${parts.join(" · ")}${rules === "" ? "" : ` [rules: ${rules}]`} — run \`crewhaus security digest\` for the windowed rollup`;
}

/**
 * Ops item 31 — how the alert watchdog delivers a breach beyond the
 * `alert_raised` trace event. Both callbacks are OPTIONAL and injected by the
 * caller (the CLI/codegen), so runtime-core stays free of audit-log/hook I/O:
 *   - `appendAudit` writes a tamper-evident record (the CLI passes an
 *     `openAuditLog(...)`-backed sink);
 *   - `fireAlertHook` invokes the settings.json `alert` hook and/or POSTs the
 *     configured webhook.
 * Absent → the watchdog still persists the snapshot + publishes the trace
 * event, it just has no durable/off-box delivery.
 */
export type AlertSink = {
  appendAudit?: (breach: AlertBreachPayload) => Promise<void>;
  fireAlertHook?: (breach: AlertBreachPayload) => Promise<void>;
};

/** The payload handed to the audit sink / settings.json alert hook / webhook. */
export type AlertBreachPayload = {
  readonly sessionId: string;
  readonly metric: string;
  readonly observed: number;
  readonly threshold: number;
  readonly baselineSessions: number;
  readonly detail: string;
};

export type AttachDefaultSubscribersOptions = {
  /** Item 31 — where the alert watchdog persists its per-session snapshot history. */
  readonly metricsDir?: string;
  /** Item 31 — durable + off-box alert delivery (see {@link AlertSink}). */
  readonly alertSink?: AlertSink;
  /** Item 37 — lowered `observability.slo` targets. The SLO monitor is a no-op
   *  without both this AND CREWHAUS_SLO set. */
  readonly sloTargets?: SloTargets;
  /** Item 37 — injected SLO mitigation ladder delivery (see {@link SloMitigationSink}). */
  readonly sloSink?: SloMitigationSink;
};

export async function attachDefaultSubscribers(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
  options: AttachDefaultSubscribersOptions = {},
): Promise<AttachedSubscribers> {
  const printer = attachPrinterIfEnvSet(bus, env);
  const metrics = await attachMetricsIfEnvSet(bus, env);
  const otel = attachOtelIfEnvSet(bus, env);
  const costTracker =
    env["CREWHAUS_COST_TRACKING"] === "1" || env["CREWHAUS_COST_TRACKING"] === "true"
      ? createCostTracker(bus, {
          ...(env["CREWHAUS_TENANT_ID"] !== undefined
            ? { tenantId: env["CREWHAUS_TENANT_ID"] }
            : {}),
        })
      : undefined;
  // CLI inline cost line — opt-in via CREWHAUS_COST_INLINE=1. Subscribes to
  // the `cost_accrual` events that cost-tracker emits, prints one tidy line
  // per accrual, and stays out of the trace bus's main printer surface so
  // it doesn't double-print when CREWHAUS_TRACE=pretty is also set.
  const costInlineEnabled =
    (env["CREWHAUS_COST_INLINE"] === "1" || env["CREWHAUS_COST_INLINE"] === "true") &&
    costTracker !== undefined;
  let costInlineUnsubscribe: Unsubscribe | undefined;
  if (costInlineEnabled) {
    const handler = (event: TraceEvent): void => {
      if (event.kind !== "cost_accrual") return;
      process.stdout.write(`${formatCostInlineLine(event as CostAccrualEvent)}\n`);
    };
    costInlineUnsubscribe = bus.subscribe(handler);
  }
  // Item 48 — per-run security tally, opt-in via CREWHAUS_SECURITY_DIGEST=1.
  // Counts security-relevant events during the run and prints exactly one
  // end-of-run summary line to STDERR from flushAll when anything was
  // tallied (flushAll is the orchestrator's `finally` hook; the printed
  // guard keeps a double flush from double-printing).
  const securityTallyEnabled =
    env["CREWHAUS_SECURITY_DIGEST"] === "1" || env["CREWHAUS_SECURITY_DIGEST"] === "true";
  const securityTally = securityTallyEnabled ? createSecurityTally() : undefined;
  let securityTallyUnsubscribe: Unsubscribe | undefined;
  let securityTallyPrinted = false;
  if (securityTally !== undefined) {
    securityTallyUnsubscribe = bus.subscribe((event: TraceEvent): void => {
      tallySecurityEvent(securityTally, event);
    });
  }
  const printSecurityTallyOnce = (): void => {
    if (securityTally === undefined || securityTallyPrinted) return;
    if (securityTallyTotal(securityTally) === 0) return;
    securityTallyPrinted = true;
    process.stderr.write(`${formatSecurityTallyLine(securityTally)}\n`);
  };

  // Ops item 31 — alert watchdog, opt-in via CREWHAUS_ALERTS=1. Folds the run's
  // events into a per-session metrics snapshot; at session end it persists the
  // snapshot (building the history baselines are derived from), derives
  // baseline thresholds (trailing p95 × headroom) from prior snapshots, and
  // raises an alert per breach (trace event + injected audit/hook sinks).
  const watchdog = attachAlertWatchdog(bus, runContext, env, options);

  // Ops item 37 — production-signal SLO monitor, opt-in via CREWHAUS_SLO=1 AND a
  // lowered `observability.slo` block. Folds events into rolling windows; a
  // periodic timer evaluates them and walks the declared mitigation ladder
  // (alert → pause-intake → rollback) on a sustained breach via the injected
  // sink. No targets / env off ⇒ undefined (zero overhead).
  const sloMonitor: AttachedSloMonitor | undefined = attachSloMonitor(bus, runContext, env, {
    ...(options.sloTargets !== undefined ? { targets: options.sloTargets } : {}),
    ...(options.sloSink !== undefined ? { sink: options.sloSink } : {}),
  });

  const flushAll = async (): Promise<void> => {
    printer?.finalize();
    const tasks: Promise<void>[] = [];
    if (metrics)
      tasks.push(metrics.flush().catch((err) => logFlushError(runContext, "metrics", err)));
    if (otel) tasks.push(otel.flush().catch((err) => logFlushError(runContext, "otel", err)));
    tasks.push(bus.flush().catch((err) => logFlushError(runContext, "bus", err)));
    await Promise.all(tasks);
    // AFTER the bus flush so every in-flight event has reached the tally.
    printSecurityTallyOnce();
    // AFTER the flush so the snapshot sees every event; a watchdog failure
    // must never break flushAll, so its own finalize swallows/logs internally.
    if (watchdog !== undefined) {
      await watchdog.finalize().catch((err) => logFlushError(runContext, "alert-watchdog", err));
    }
    // A final SLO evaluation at flush so a breach that formed late in a short
    // run (below the periodic timer's first tick) still walks the ladder, then
    // stop the timer so it never outlives the run.
    if (sloMonitor !== undefined) {
      await sloMonitor.evaluate().catch((err) => logFlushError(runContext, "slo-monitor", err));
      sloMonitor.stop();
      sloMonitor.unsubscribe();
    }
  };
  const shutdownAll = async (): Promise<void> => {
    printer?.unsubscribe();
    if (metrics) {
      await metrics.shutdown().catch((err) => logFlushError(runContext, "metrics", err));
    }
    if (otel) {
      await otel.shutdown().catch((err) => logFlushError(runContext, "otel", err));
    }
    costTracker?.unsubscribe();
    costInlineUnsubscribe?.();
    // A caller that shuts down without flushing still gets its one line.
    printSecurityTallyOnce();
    securityTallyUnsubscribe?.();
    if (watchdog !== undefined) {
      await watchdog.finalize().catch((err) => logFlushError(runContext, "alert-watchdog", err));
      watchdog.unsubscribe();
    }
    if (sloMonitor !== undefined) {
      sloMonitor.stop();
      sloMonitor.unsubscribe();
    }
  };
  return {
    printer,
    metrics,
    otel,
    costTracker,
    costInlineUnsubscribe,
    securityTally,
    flushAll,
    shutdownAll,
  };
}

function logFlushError(runContext: RunContext, name: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  runContext.logger.error("observability.flush_failed", { name, message });
}

// -------- alert watchdog (ops item 31) --------

export type AttachedAlertWatchdog = {
  /** Compute the snapshot, persist it, derive baselines, raise alerts. Idempotent. */
  finalize(): Promise<void>;
  unsubscribe: Unsubscribe;
};

/**
 * Ops item 31 — attach the alert watchdog when CREWHAUS_ALERTS is set. Folds
 * events into a per-session {@link SessionMetricsAccumulator}; `finalize()`
 * (called from flush/shutdown) persists the snapshot, derives baseline
 * thresholds from the accrued history, and — per breach — publishes an
 * `alert_raised` trace event, appends an audit record, and fires the alert
 * hook/webhook via the injected {@link AlertSink}. Returns undefined (a no-op)
 * when the env gate is off, so it adds zero overhead by default.
 *
 * NOTE (spec gate): the primary gate is the CREWHAUS_ALERTS env var, matching
 * every other subscriber in this file (attachDefaultSubscribers only receives
 * env). A spec-level `observability.alerts` block would be lowered by the
 * compiler into an env stamp / options flag on the emitted bundle; that
 * lowering is the follow-up — the runtime seam here already honours it.
 */
export function attachAlertWatchdog(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv,
  options: AttachDefaultSubscribersOptions = {},
): AttachedAlertWatchdog | undefined {
  const gate = env["CREWHAUS_ALERTS"];
  if (gate !== "1" && gate !== "true") return undefined;

  const acc = new SessionMetricsAccumulator();
  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    acc.fold(event);
  });

  let finalized = false;
  const finalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;

    const snapshot = acc.snapshot(runContext.sessionId);
    // Derive thresholds from PRIOR history (before this session's snapshot is
    // appended) so a session is never graded against itself.
    const history = readMetricsHistory(options.metricsDir);
    const thresholds = deriveThresholds(history);
    // Persist AFTER reading history so the next session benefits from this one.
    appendMetricsSnapshot(snapshot, options.metricsDir);

    const breaches = detectBreaches(snapshot, thresholds);
    const sink = options.alertSink;
    for (const breach of breaches) {
      // Live observable surface.
      const env2 = bus.envelope();
      bus.publish({
        ...env2,
        kind: "alert_raised",
        metric: breach.metric,
        observed: breach.observed,
        threshold: breach.threshold,
        baselineSessions: thresholds.baselineSessions,
        detail: breach.detail,
      });
      const payload: AlertBreachPayload = {
        sessionId: runContext.sessionId,
        metric: breach.metric,
        observed: breach.observed,
        threshold: breach.threshold,
        baselineSessions: thresholds.baselineSessions,
        detail: breach.detail,
      };
      // Durable + off-box delivery — each best-effort so one failing sink never
      // blocks the others (or a turn). Errors are logged, not thrown.
      if (sink?.appendAudit !== undefined) {
        await sink
          .appendAudit(payload)
          .catch((err) => logFlushError(runContext, "alert-audit", err));
      }
      if (sink?.fireAlertHook !== undefined) {
        await sink
          .fireAlertHook(payload)
          .catch((err) => logFlushError(runContext, "alert-hook", err));
      }
    }
  };

  return { finalize, unsubscribe };
}

// -------- advisor signal persistence (item 14 groundwork) --------

export type AttachedAdvisorPersistence = {
  unsubscribe: Unsubscribe;
  /**
   * Item 14 in-run digest — the one-line stderr summary the runtime prints
   * at session end when any cheap advisory threshold tripped, or undefined
   * when the session looks healthy. Counters only: no LLM, no file reads,
   * nothing heavier than a Map bump per event in the hot path — the real
   * analysis is `crewhaus advise`'s job, offline.
   */
  digestLine(): string | undefined;
};

/**
 * Cheap in-run thresholds for the digest tally. Keep in sync with
 * `DEFAULT_ADVICE_THRESHOLDS` in `apps/cli/src/advise-rules.ts` — the rule
 * library owns the canonical values, but runtime-core cannot import from
 * apps/cli, so the digest mirrors them here (a drift only ever means the
 * nudge line appears/hides slightly off the report; the report itself is
 * always authoritative).
 */
const DIGEST_THRESHOLDS = {
  toolFailureMinCalls: 5,
  toolFailureRate: 0.5,
  truncationContinues: 2,
  compactions: 3,
  asksPerTool: 3,
  stopMinResponses: 4,
  stopAnomalyRate: 0.25,
} as const;

/** Stop reasons that are part of healthy operation; everything else
 *  (max_tokens, refusal, pause_turn, …) counts as anomalous. */
const CLEAN_STOP_REASONS = new Set(["end_turn", "tool_use", "stop_sequence"]);

/**
 * Advisor groundwork (items 14/15/17) — mirror the runtime signals that were
 * previously trace-bus-only into the session JSONL, through the SAME
 * `event-log` append path the run already writes its transcript with:
 *
 *   error_recovered      → `recovery`   { errorName, action, depth }
 *   tool_call_end        → `tool_stats` { toolName, durationMs, isError }
 *   permission_decision  → `permission` { toolName, decision, askOutcome }
 *   model_response       → `model_meta` { stopReason, model, role?, profile?,
 *                                         usage, durationMs, turnNumber }
 *
 * 0.6.0 (design §8.4) — `model_meta` carries exact per-turn attribution
 * (`usage`, whole-ms `durationMs`, the envelope `turnNumber`, and the
 * `role` / `profile` the response was published with) so `watchme report`'s
 * `attributeModels` can be `exact` from the session log alone, without the
 * opt-in `CREWHAUS_WATCHME` sidecar. `role`/`profile` are written only when
 * the response carries them (absent role ⇒ primary), and readers that
 * predate the enrichment keep reading `stopReason`/`model` unchanged.
 *
 * Unlike the other `attach*IfEnvSet` subscribers this one is DEFAULT-ON:
 * the lines are tiny (see the granularity note on the `tool_stats` kind in
 * `@crewhaus/event-log`) and they are the food `crewhaus advise` mines, so
 * opting in would starve the advisor on exactly the runs that need it.
 * Disable with `CREWHAUS_ADVISOR_EVENTS=0` (or `false`).
 *
 * Permission mapping detail: a `decision: "ask"` event WITHOUT `askOutcome`
 * is the pre-prompt publish — skipped here so each ask persists exactly once,
 * as its resolution (`askOutcome: "approved" | "denied"`). Allow/deny
 * decisions (including the justification-gate and egress verdicts, which
 * publish additional `permission_decision` events per call) persist with
 * `askOutcome: null`.
 *
 * `append()` failures must never abort a turn, so — like the cost_accrual
 * persistence path — the promise result is logged rather than thrown.
 */
export function attachAdvisorPersistence(
  bus: TraceEventBus,
  eventLog: EventLog,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
): AttachedAdvisorPersistence | undefined {
  const gate = env["CREWHAUS_ADVISOR_EVENTS"];
  if (gate === "0" || gate === "false") return undefined;

  const persist = (
    kind: "recovery" | "tool_stats" | "permission" | "model_meta",
    payload: unknown,
  ): void => {
    void eventLog.append({ kind, payload }).catch((err) => {
      runContext.logger.error("advisor_event.persist_failed", {
        kind,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // In-run digest counters (item 14). Bumped inline in the same handler so
  // the digest costs nothing beyond the persistence pass itself.
  const toolTally = new Map<string, { calls: number; errors: number }>();
  const askTally = new Map<string, { asks: number; approved: number }>();
  let truncationContinues = 0;
  let compactions = 0;
  let responses = 0;
  let anomalousStops = 0;

  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    switch (event.kind) {
      case "error_recovered": {
        if (event.action === "continue") truncationContinues += 1;
        persist("recovery", {
          errorName: event.errorName,
          action: event.action,
          depth: event.depth,
        });
        return;
      }
      case "tool_call_end": {
        const tally = toolTally.get(event.toolName) ?? { calls: 0, errors: 0 };
        tally.calls += 1;
        if (event.isError) tally.errors += 1;
        toolTally.set(event.toolName, tally);
        persist("tool_stats", {
          toolName: event.toolName,
          // Whole milliseconds — performance.now() floats add line bytes
          // without adding advisory signal.
          durationMs: Math.round(event.durationMs),
          isError: event.isError,
        });
        return;
      }
      case "permission_decision": {
        // Pre-prompt ask publish — the resolution (askOutcome set) follows.
        if (event.decision === "ask" && event.askOutcome === undefined) return;
        if (event.decision === "ask" && event.askOutcome !== undefined) {
          const ask = askTally.get(event.toolName) ?? { asks: 0, approved: 0 };
          ask.asks += 1;
          if (event.askOutcome === "approved") ask.approved += 1;
          askTally.set(event.toolName, ask);
        }
        persist("permission", {
          toolName: event.toolName,
          decision: event.decision,
          askOutcome: event.askOutcome ?? null,
        });
        return;
      }
      case "model_response": {
        responses += 1;
        if (!CLEAN_STOP_REASONS.has(event.stopReason)) anomalousStops += 1;
        persist("model_meta", {
          stopReason: event.stopReason,
          model: event.model,
          ...(event.role !== undefined ? { role: event.role } : {}),
          ...(event.profile !== undefined ? { profile: event.profile } : {}),
          usage: event.usage,
          // Whole milliseconds — performance.now() floats add line bytes
          // without adding attribution signal.
          durationMs: Math.round(event.durationMs),
          turnNumber: event.turnNumber,
        });
        return;
      }
      case "compaction_fired": {
        // Already persisted by the runtime as the `compaction` event-log
        // kind — tallied here for the digest only.
        compactions += 1;
        return;
      }
      default:
        return;
    }
  });

  const digestLine = (): string | undefined => {
    const t = DIGEST_THRESHOLDS;
    let findings = 0;
    for (const { calls, errors } of toolTally.values()) {
      if (calls >= t.toolFailureMinCalls && errors / calls >= t.toolFailureRate) findings += 1;
    }
    for (const { asks, approved } of askTally.values()) {
      if (asks >= t.asksPerTool && approved === asks) findings += 1;
    }
    if (truncationContinues >= t.truncationContinues) findings += 1;
    if (compactions >= t.compactions) findings += 1;
    if (responses >= t.stopMinResponses && anomalousStops / responses >= t.stopAnomalyRate) {
      findings += 1;
    }
    if (findings === 0) return undefined;
    return `advisor: ${findings} finding${findings === 1 ? "" : "s"} — run \`crewhaus advise --session ${runContext.sessionId}\``;
  };

  return { unsubscribe, digestLine };
}

// -------- MCP stats persistence (ops item 38) --------

export type AttachedMcpStatsPersistence = {
  unsubscribe: Unsubscribe;
};

/**
 * Ops item 38 — mirror the trace-bus-only `mcp_call_end` events into the same
 * session JSONL the transcript already writes to, as the durable `mcp_stats`
 * kind, so `crewhaus mcp doctor` can score per-server MCP health OFFLINE across
 * sessions. `mcp_call_start`/`mcp_call_end` are trace-bus-only today — nothing
 * durably records per-server error-rate / latency — so this subscriber is the
 * durable history the report reads.
 *
 * Payload per line: `{ server, toolName, durationMs, isError }` — the same
 * granularity decision the advisor's `tool_stats` made: per-call, not a per-turn
 * aggregate, so the report keeps the full latency/error distribution. Whole
 * milliseconds only (performance.now() floats add bytes without adding signal).
 *
 * Shares the DEFAULT-ON gate with the advisor events (disable with
 * CREWHAUS_ADVISOR_EVENTS=0): the lines are tiny and they are exactly what the
 * MCP-health report mines, so opting in would starve the doctor on the runs
 * that used MCP servers. `append()` failures are logged, never thrown — a
 * persistence hiccup must not abort a turn.
 */
export function attachMcpStatsPersistence(
  bus: TraceEventBus,
  eventLog: EventLog,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
): AttachedMcpStatsPersistence | undefined {
  const gate = env["CREWHAUS_ADVISOR_EVENTS"];
  if (gate === "0" || gate === "false") return undefined;

  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    if (event.kind !== "mcp_call_end") return;
    void eventLog
      .append({
        kind: "mcp_stats",
        payload: {
          server: event.server,
          toolName: event.toolName,
          durationMs: Math.round(event.durationMs),
          isError: event.isError,
        },
      })
      .catch((err) => {
        runContext.logger.error("mcp_stats.persist_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      });
  });

  return { unsubscribe };
}

// -------- routing decision persistence (0.6.0 design §8.1) --------

export type AttachedRoutingPersistence = {
  unsubscribe: Unsubscribe;
};

/**
 * 0.6.0 (design §8.1) — mirror the routing decisions that were trace-bus-only
 * in 0.5.x into the session JSONL, as the durable event-log kinds of the same
 * name, so `crewhaus route explain`, `sessions tail`, Hangar's session gutter
 * and `--resume` read them offline:
 *
 *   model_failover   → `model_failover`   { turnNumber, from, to, reason }
 *   model_stage      → `model_stage`      { turnNumber, stage, strategy, role, model, profile?, outcome, cause?, costUsdMicros? }
 *   model_directive  → `model_directive`  { turnNumber, source, requested, resolved?, accepted, reason? }
 *   judge_verdict    → `judge_verdict`    { turnNumber, stepOrNode, verdict, score, rationale?, judgeModel?, panel?, costUsdMicros? }
 *
 * A bus subscriber rather than a `logEvent` at each publish site because two
 * of these are published OUTSIDE runtime-core: the failover chain in
 * `@crewhaus/model-router` (which has no event log) and the `kind: judge`
 * gate helpers emitted into workflow/graph bundles. `model_tier_route` is
 * the exception — its only publisher is runtime-core's own tier branch, which
 * writes the durable line directly beside the publish, exactly as
 * `model_route` does.
 *
 * UNGATED, like the `model_route` line and unlike the advisor mirrors: these
 * records are what replay reads (`--resume` reconstructs a directive pin from
 * `model_directive`; `route explain` reconstructs a turn's stages), so an env
 * flag that dropped them would make replay diverge from the run. The lines
 * are small and fire once per decision, not per token. `append()` failures
 * are logged, never thrown — a persistence hiccup must not abort a turn.
 */
export function attachRoutingPersistence(
  bus: TraceEventBus,
  eventLog: EventLog,
  runContext: RunContext,
): AttachedRoutingPersistence {
  const persist = (
    kind: "model_failover" | "model_stage" | "model_directive" | "judge_verdict",
    payload: unknown,
  ): void => {
    void eventLog.append({ kind, payload }).catch((err) => {
      runContext.logger.error("routing_event.persist_failed", {
        kind,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    switch (event.kind) {
      case "model_failover": {
        const e = event as ModelFailoverEvent;
        persist("model_failover", {
          turnNumber: e.turnNumber,
          from: e.from,
          to: e.to,
          reason: e.reason,
        });
        return;
      }
      case "model_stage": {
        const e = event as ModelStageEvent;
        persist("model_stage", {
          turnNumber: e.turnNumber,
          stage: e.stage,
          strategy: e.strategy,
          role: e.role,
          model: e.model,
          ...(e.profile !== undefined ? { profile: e.profile } : {}),
          outcome: e.outcome,
          ...(e.cause !== undefined ? { cause: e.cause } : {}),
          ...(e.costUsdMicros !== undefined ? { costUsdMicros: e.costUsdMicros } : {}),
        });
        return;
      }
      case "model_directive": {
        const e = event as ModelDirectiveEvent;
        persist("model_directive", {
          turnNumber: e.turnNumber,
          source: e.source,
          requested: e.requested,
          ...(e.resolved !== undefined ? { resolved: e.resolved } : {}),
          accepted: e.accepted,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        });
        return;
      }
      case "judge_verdict": {
        const e = event as JudgeVerdictEvent;
        persist("judge_verdict", {
          turnNumber: e.turnNumber,
          stepOrNode: e.stepOrNode,
          verdict: e.verdict,
          score: e.score,
          ...(e.rationale !== undefined ? { rationale: e.rationale } : {}),
          ...(e.judgeModel !== undefined ? { judgeModel: e.judgeModel } : {}),
          ...(e.panel !== undefined ? { panel: e.panel } : {}),
          ...(e.costUsdMicros !== undefined ? { costUsdMicros: e.costUsdMicros } : {}),
        });
        return;
      }
      default:
        return;
    }
  });

  return { unsubscribe };
}

// -------- "watch me" live capture tap (design/watch-me.md §6.1) --------

/**
 * Reconciliation with the SHIPPED G26 `observability:` block (watch-me §4.5 —
 * decided, superseding all "when G26 lands" language): `watchme:` is a SIBLING
 * spec block, not an `observability:` sub-key. `observability.trace.level`
 * controls the ring buffer + printers ONLY; the bus always exists, so this
 * capture subscriber attaches independently of that knob, gated solely on
 * CREWHAUS_WATCHME. The env itself is stamped at the same junctions the G26
 * stamps already use (`applyRunObservabilityEnv` on the interpreter path, the
 * target bundles' boot-stamp emitters), so precedence semantics stay in one
 * place per path.
 */

/** Stream kinds published per token/chunk — pure progress signal, never captured. */
const WATCHME_EPHEMERAL_KINDS: ReadonlySet<string> = new Set([
  "model_stream_token",
  "tool_stream_chunk",
]);

/**
 * The session `.jsonl` mirror vocabulary — every kind the event log persists
 * durably: the transcript kinds the runtime writes itself plus the mirrored
 * kinds emitted by the cost/advisor/mcp-stats subscribers in this file. The
 * capture tap skips these, which keeps the `.events.jsonl` sibling
 * metadata-grade BY CONSTRUCTION (all content-carrying kinds are durable ones)
 * and makes the two files' kind sets disjoint — a pinned invariant. Typed as
 * an exhaustive Record over event-log's `EventKind` so a new durable kind
 * cannot land without this set learning about it.
 */
const WATCHME_MIRRORED_KIND_RECORD: Readonly<Record<EventKind, true>> = {
  user_message: true,
  assistant_message: true,
  tool_use: true,
  tool_result: true,
  // #405 — the per-run toolset record. Durable metadata (names only), and
  // exactly the kind of runtime fact watch-me mirrors should carry.
  toolset: true,
  error: true,
  run_failed: true,
  context_evicted: true,
  compaction: true,
  sub_agent_start: true,
  sub_agent_end: true,
  role_start: true,
  role_end: true,
  handoff: true,
  a2a_message: true,
  a2a_turn_start: true,
  a2a_turn_end: true,
  crew_done: true,
  cost_accrual: true,
  user_feedback: true,
  recovery: true,
  tool_stats: true,
  permission: true,
  model_meta: true,
  mcp_stats: true,
  model_route: true,
  // 0.6.0 (design §8.1) — the routing decisions made durable in this release:
  // the tier twin of model_route (written beside its publish) and the four
  // kinds `attachRoutingPersistence` mirrors from the bus.
  model_tier_route: true,
  model_failover: true,
  model_stage: true,
  model_directive: true,
  judge_verdict: true,
  wiki_write: true,
  plan_update: true,
  goal_update: true,
  action_proof: true,
  dream_run: true,
};
export const WATCHME_MIRRORED_KINDS: ReadonlySet<string> = new Set(
  Object.keys(WATCHME_MIRRORED_KIND_RECORD),
);

export type AttachedWatchmeCapture = {
  unsubscribe(): void;
};

/**
 * "Watch me" (§6.1) — the live capture tap behind `crewhaus watchme`. Appends
 * every BUS-ONLY TraceEvent (envelope included — `formatJsonLine` shape) as
 * one JSON line to `<sessionsDir>/<sessionId>.events.jsonl`, the sibling
 * `sessions export` already reads. Skipped: the ephemeral stream kinds and
 * every durably mirrored kind ({@link WATCHME_MIRRORED_KINDS}), so content
 * stays solely in the session `.jsonl` while the sibling carries exact
 * per-turn model attribution via the envelope `turnNumber` on
 * `model_response`.
 *
 * Gated on CREWHAUS_WATCHME=1|true (stamped by `crewhaus run` /
 * the compiled-bundle preambles); returns undefined otherwise. Appends are
 * synchronous (`appendFileSync`, mode 0600, one line < PIPE_BUF ⇒ atomic) and
 * every failure is swallowed — capture can never crash a run.
 */
export function attachWatchmeCapture(
  bus: TraceEventBus,
  sessionsDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): AttachedWatchmeCapture | undefined {
  const gate = env["CREWHAUS_WATCHME"];
  if (gate !== "1" && gate !== "true") return undefined;

  const path = join(sessionsDir, `${sessionId}.events.jsonl`);
  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    if (WATCHME_EPHEMERAL_KINDS.has(event.kind)) return;
    if (WATCHME_MIRRORED_KINDS.has(event.kind)) return;
    try {
      appendFileSync(path, formatJsonLine(event), { mode: 0o600 });
    } catch {
      // Swallowed by design — a capture hiccup must never abort a turn.
    }
  });

  return { unsubscribe };
}

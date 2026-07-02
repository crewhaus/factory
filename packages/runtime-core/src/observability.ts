import { type CostTracker, createCostTracker, formatUsdMicros } from "@crewhaus/cost-tracker";
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
} from "@crewhaus/structured-event-printer";
import type {
  CostAccrualEvent,
  TraceEvent,
  TraceEventBus,
  Unsubscribe,
} from "@crewhaus/trace-event-bus";

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

export async function attachDefaultSubscribers(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
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

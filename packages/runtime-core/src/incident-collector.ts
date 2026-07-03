/**
 * Item 32 — runtime side of auto-assembled incident bundles. An env-gated
 * (CREWHAUS_INCIDENTS) bus subscriber that watches for trigger events —
 * circuit breaker → open, egress-blocked, a justification-deny storm — and, on
 * the first trigger, snapshots the bus ring buffer (`bus.recent()`) plus the
 * trigger metadata into `.crewhaus/incidents/<ts>-<kind>/` as a RAW capture
 * (events.jsonl + incident.json). The rich, human-readable bundle (HTML,
 * doctor output, audit-window join, cost summary) is assembled by
 * `crewhaus incident collect --session <id>` — which reads this raw capture's
 * sibling session log — so runtime-core stays free of the eval-report/doctor
 * dependencies.
 *
 * Kept lean and dependency-light: the only I/O is the single mkdir + write of
 * the raw capture. Trigger classification is pure and unit-tested; the writer
 * is best-effort (a capture failure is logged, never thrown — an incident
 * writer must not turn one failure into two).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "@crewhaus/run-context";
import type { TraceEvent, TraceEventBus, Unsubscribe } from "@crewhaus/trace-event-bus";

export type IncidentTriggerKind = "circuit_open" | "egress_blocked" | "justification_deny_storm";

/** How many judge-backed denials in the ring buffer constitute a "storm". */
export const DENY_STORM_THRESHOLD = 3;

export type IncidentCapture = {
  readonly kind: IncidentTriggerKind;
  readonly reason: string;
  readonly triggeredBy: string;
};

/**
 * Classify a live TraceEvent as an incident trigger. `ringDenials` is the
 * count of judge-backed denials already in the ring buffer (NOT including
 * `event`); a permission deny tips into a storm when `ringDenials + 1` reaches
 * the threshold.
 */
export function classifyIncidentTrigger(
  event: TraceEvent,
  ringDenials: number,
): IncidentCapture | undefined {
  switch (event.kind) {
    case "circuit_state_changed":
      if (event.toState === "open") {
        return {
          kind: "circuit_open",
          reason: `circuit ${event.adapter} → open${event.reason ? `: ${event.reason}` : ""}`,
          triggeredBy: "circuit_state_changed",
        };
      }
      return undefined;
    case "permission_decision":
      if (event.outcome === "egress-blocked") {
        return {
          kind: "egress_blocked",
          reason: `egress blocked on ${event.toolName}`,
          triggeredBy: "permission_decision",
        };
      }
      if (event.decision === "deny" && event.judgeModel !== undefined) {
        if (ringDenials + 1 >= DENY_STORM_THRESHOLD) {
          return {
            kind: "justification_deny_storm",
            reason: `justification-deny storm: ${ringDenials + 1} denials in the ring buffer`,
            triggeredBy: "permission_decision",
          };
        }
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Is this ring event a judge-backed justification denial? */
function isJudgeDenial(ev: TraceEvent): boolean {
  return ev.kind === "permission_decision" && ev.decision === "deny" && ev.judgeModel !== undefined;
}

/** Compact an ISO timestamp into a filesystem-safe, sortable stem. */
export function incidentDirName(iso: string, kind: IncidentTriggerKind): string {
  const compact = iso
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
  return `${compact}-${kind}`;
}

export type AttachIncidentCollectorOptions = {
  /** Root of the incidents tree. Default: `.crewhaus/incidents`. */
  readonly incidentsDir?: string;
  /** Spec identity stamped into the raw capture. */
  readonly spec?: { readonly name: string; readonly version?: string; readonly hash?: string };
  /** Override now() for deterministic tests. */
  readonly now?: () => Date;
};

export type AttachedIncidentCollector = { unsubscribe: Unsubscribe };

/**
 * Attach the incident collector when CREWHAUS_INCIDENTS is set. On the FIRST
 * trigger it writes a raw capture; later triggers in the same session are
 * ignored (one bundle per session — the first failure is the story; the ring
 * buffer already carries what followed). Returns undefined (no-op) when the
 * env gate is off.
 */
export function attachIncidentCollector(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv,
  options: AttachIncidentCollectorOptions = {},
): AttachedIncidentCollector | undefined {
  const gate = env["CREWHAUS_INCIDENTS"];
  if (gate !== "1" && gate !== "true") return undefined;

  const incidentsDir = options.incidentsDir ?? join(".crewhaus", "incidents");
  const now = options.now ?? ((): Date => new Date());
  let captured = false;

  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    if (captured) return;
    // Count prior judge denials in the ring buffer (excludes the live event —
    // it is not yet buffered when a synchronous subscriber runs, but be safe).
    const ringDenials = bus.recent().filter(isJudgeDenial).length;
    const trigger = classifyIncidentTrigger(event, ringDenials);
    if (trigger === undefined) return;
    captured = true;

    try {
      const ts = now().toISOString();
      const dir = join(incidentsDir, incidentDirName(ts, trigger.kind));
      mkdirSync(dir, { recursive: true });
      const ring = bus.recent();
      const capture = {
        version: 1 as const,
        kind: trigger.kind,
        reason: trigger.reason,
        triggeredBy: trigger.triggeredBy,
        sessionId: runContext.sessionId,
        runId: runContext.runId,
        incidentTs: ts,
        spec: options.spec ?? null,
        ringEventCount: ring.length,
      };
      writeFileSync(join(dir, "incident.json"), `${JSON.stringify(capture, null, 2)}\n`);
      writeFileSync(
        join(dir, "events.jsonl"),
        ring.length === 0 ? "" : `${ring.map((e) => JSON.stringify(e)).join("\n")}\n`,
      );
      process.stderr.write(
        `[incident] ${trigger.kind} captured → ${dir} (run \`crewhaus incident collect --session ${runContext.sessionId}\` for the full bundle)\n`,
      );
    } catch (err) {
      // Best-effort: an incident writer must not turn one failure into two.
      runContext.logger.error("incident.capture_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { unsubscribe };
}

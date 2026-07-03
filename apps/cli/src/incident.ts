/**
 * Item 32 — auto-assemble incident bundles from traces on failure events.
 *
 * On a trigger event — an unrecovered run abort, a circuit breaker going
 * `open`, an egress-blocked verdict, a justification-deny storm, or a gateway
 * `budget_exceeded` — the runtime (via an env-gated bus subscriber) or the
 * `crewhaus incident collect --session <id>` command snapshots everything an
 * on-call needs into `.crewhaus/incidents/<ts>-<kind>/`:
 *   - events.jsonl   — the bus ring buffer (bus.recent()) at incident time
 *   - transcript.jsonl — the session event-log slice around the incident
 *   - audit.jsonl    — the hash-chained audit records that fall in the session
 *                      window (see AUDIT-SESSION LINKAGE below)
 *   - cost.json      — the cost_accrual summary (total + per-model)
 *   - spec.json      — the spec name, version, and hash
 *   - doctor.txt     — captured `crewhaus doctor` output
 *   - bundle.json    — the machine-readable manifest of all of the above
 *   - index.html     — an eval-report-styled human view
 *
 * AUDIT-SESSION LINKAGE (design decision): audit records carry a `ts` (ms
 * epoch) but NO first-class sessionId — the hash chain is per-tenant/day, not
 * per-session. So "matching audit records" is defined by TIME WINDOW: every
 * record whose `ts` lies within [sessionStart, incidentTs] (with a small
 * margin for clock skew / a late flush). Where a payload DOES carry a
 * correlating field (a justification record's toolName, a deployment_action's
 * name), it is preserved verbatim in the bundle so a human can disambiguate
 * concurrent sessions; the window is the primary join because it is the only
 * signal every record kind shares.
 *
 * Side-effect-free: assembly takes injected inputs (ring-buffer events,
 * transcript slice, audit records, cost summary, spec info, doctor text) and
 * returns the files to write. The CLI/runtime perform the reads + the single
 * mkdir/write pass, so the assembly + rendering are unit-testable.
 */
import { escapeHtml, shell } from "@crewhaus/eval-report";

/** The trigger kinds that auto-assemble an incident bundle. */
export type IncidentKind =
  | "run_abort"
  | "circuit_open"
  | "egress_blocked"
  | "justification_deny_storm"
  | "budget_exceeded";

/** A minimal structural view of a TraceEvent for trigger classification. */
export type TriggerEvent = {
  readonly kind: string;
  readonly [k: string]: unknown;
};

/**
 * How many justification denials within the ring buffer constitute a "storm".
 * A single deny is routine policy enforcement; a burst signals a prompt-
 * injection probe or a misconfigured agent worth capturing.
 */
export const JUSTIFICATION_DENY_STORM_THRESHOLD = 3;

export type AuditRecordLike = {
  readonly ts: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly seq?: number;
  readonly hash?: string;
};

export type CostSummary = {
  readonly totalUsdMicros: number;
  readonly byModel: Record<string, { calls: number; usdMicros: number }>;
};

export type SpecInfo = {
  readonly name: string;
  readonly version?: string;
  readonly hash?: string;
};

/** The injected inputs assembled into a bundle. */
export type IncidentInputs = {
  readonly kind: IncidentKind;
  readonly sessionId: string;
  /** ISO-8601 incident time (also seeds the bundle dir name). */
  readonly incidentTs: string;
  /** One-line human reason (e.g. "circuit anthropic → open: 5 consecutive 429s"). */
  readonly reason: string;
  /** bus.recent() ring-buffer events at incident time (any JSON-serializable). */
  readonly ringEvents: ReadonlyArray<unknown>;
  /** The session transcript slice (event-log entries) around the incident. */
  readonly transcript: ReadonlyArray<unknown>;
  /** Audit records matched to the session window (see file header). */
  readonly auditRecords: ReadonlyArray<AuditRecordLike>;
  readonly cost: CostSummary;
  readonly spec: SpecInfo;
  /** Captured doctor output, or a note if doctor could not run. */
  readonly doctor: string;
  /** The session window used for audit matching, for the manifest. */
  readonly window: { readonly startTs: number; readonly endTs: number };
};

/** A file to write into the incident dir: relative name + string contents. */
export type IncidentFile = { readonly name: string; readonly contents: string };

export type AssembledIncident = {
  readonly dirName: string;
  readonly files: ReadonlyArray<IncidentFile>;
};

/** `<iso-ts-compacted>-<kind>` — a filesystem-safe, sortable dir name. */
export function incidentDirName(incidentTs: string, kind: IncidentKind): string {
  // 2026-07-02T18:07:03.412Z → 20260702T180703 (drop ms + punctuation).
  const compact = incidentTs
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
  return `${compact}-${kind}`;
}

/**
 * Match audit records to a session by TIME WINDOW (the only signal every
 * record kind shares — see the file header). `marginMs` widens the window on
 * both ends for clock skew and late flushes.
 */
export function matchAuditRecordsByWindow(
  records: ReadonlyArray<AuditRecordLike>,
  window: { startTs: number; endTs: number },
  marginMs = 2000,
): AuditRecordLike[] {
  const lo = window.startTs - marginMs;
  const hi = window.endTs + marginMs;
  return records.filter((r) => r.ts >= lo && r.ts <= hi);
}

/** Count justification denials in a set of ring-buffer events. */
export function countJustificationDenials(events: ReadonlyArray<unknown>): number {
  let n = 0;
  for (const ev of events) {
    const e = ev as { kind?: string; decision?: string; judgeModel?: unknown };
    if (e.kind === "permission_decision" && e.decision === "deny" && e.judgeModel !== undefined) {
      n += 1;
    }
  }
  return n;
}

/**
 * Classify a live TraceEvent as an incident trigger, given the current ring
 * buffer (for the deny-storm threshold). Returns the incident kind + reason,
 * or undefined when the event is not a trigger.
 */
export function classifyTrigger(
  event: TriggerEvent,
  ringEvents: ReadonlyArray<unknown>,
): { kind: IncidentKind; reason: string } | undefined {
  switch (event.kind) {
    case "circuit_state_changed":
      if (event["toState"] === "open") {
        return {
          kind: "circuit_open",
          reason: `circuit ${String(event["adapter"] ?? "?")} → open${
            event["reason"] !== undefined ? `: ${String(event["reason"])}` : ""
          }`,
        };
      }
      return undefined;
    case "permission_decision": {
      if (event["outcome"] === "egress-blocked") {
        return {
          kind: "egress_blocked",
          reason: `egress blocked on ${String(event["toolName"] ?? "?")}`,
        };
      }
      // A deny-storm is measured over the ring buffer, INCLUDING this event.
      if (event["decision"] === "deny" && event["judgeModel"] !== undefined) {
        const denials = countJustificationDenials([...ringEvents, event]);
        if (denials >= JUSTIFICATION_DENY_STORM_THRESHOLD) {
          return {
            kind: "justification_deny_storm",
            reason: `justification-deny storm: ${denials} denials in the ring buffer`,
          };
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Assemble the incident bundle files from injected inputs. */
export function assembleIncidentBundle(inputs: IncidentInputs): AssembledIncident {
  const dirName = incidentDirName(inputs.incidentTs, inputs.kind);
  const manifest = {
    kind: inputs.kind,
    sessionId: inputs.sessionId,
    incidentTs: inputs.incidentTs,
    reason: inputs.reason,
    window: inputs.window,
    counts: {
      ringEvents: inputs.ringEvents.length,
      transcriptEntries: inputs.transcript.length,
      auditRecords: inputs.auditRecords.length,
    },
    cost: inputs.cost,
    spec: inputs.spec,
  };
  const files: IncidentFile[] = [
    { name: "bundle.json", contents: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: "events.jsonl", contents: toJsonl(inputs.ringEvents) },
    { name: "transcript.jsonl", contents: toJsonl(inputs.transcript) },
    { name: "audit.jsonl", contents: toJsonl(inputs.auditRecords) },
    { name: "cost.json", contents: `${JSON.stringify(inputs.cost, null, 2)}\n` },
    { name: "spec.json", contents: `${JSON.stringify(inputs.spec, null, 2)}\n` },
    {
      name: "doctor.txt",
      contents: inputs.doctor.endsWith("\n") ? inputs.doctor : `${inputs.doctor}\n`,
    },
    { name: "index.html", contents: renderIncidentHtml(inputs) },
  ];
  return { dirName, files };
}

function toJsonl(items: ReadonlyArray<unknown>): string {
  if (items.length === 0) return "";
  return `${items.map((i) => JSON.stringify(i)).join("\n")}\n`;
}

/** Render the incident as an eval-report-styled HTML page. */
export function renderIncidentHtml(inputs: IncidentInputs): string {
  const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
  const cards = [
    { label: "Kind", value: inputs.kind },
    { label: "Session", value: inputs.sessionId },
    {
      label: "Spec",
      value: `${inputs.spec.name}${inputs.spec.version ? `@${inputs.spec.version}` : ""}`,
    },
    { label: "Ring events", value: String(inputs.ringEvents.length) },
    { label: "Transcript", value: String(inputs.transcript.length) },
    { label: "Audit records", value: String(inputs.auditRecords.length) },
    { label: "Total cost", value: usd(inputs.cost.totalUsdMicros) },
  ];
  const cardsHtml = cards
    .map(
      (c) =>
        `<div class="card"><div class="label">${escapeHtml(c.label)}</div><div class="value">${escapeHtml(c.value)}</div></div>`,
    )
    .join("");

  const eventRows = inputs.ringEvents
    .slice(-100)
    .map((ev) => {
      const e = ev as { timestamp?: string; kind?: string };
      return `<tr><td>${escapeHtml(e.timestamp ?? "")}</td><td>${escapeHtml(e.kind ?? "")}</td><td><pre>${escapeHtml(JSON.stringify(ev))}</pre></td></tr>`;
    })
    .join("");

  const auditRows = inputs.auditRecords
    .map(
      (r) =>
        `<tr><td>${escapeHtml(new Date(r.ts).toISOString())}</td><td>${escapeHtml(r.kind)}</td><td><pre>${escapeHtml(JSON.stringify(r.payload))}</pre></td></tr>`,
    )
    .join("");

  const costRows = Object.entries(inputs.cost.byModel)
    .map(
      ([model, c]) =>
        `<tr><td>${escapeHtml(model)}</td><td>${c.calls}</td><td>${usd(c.usdMicros)}</td></tr>`,
    )
    .join("");

  const body = `<h1>Incident — ${escapeHtml(inputs.kind)}</h1>
<div class="meta">${escapeHtml(inputs.incidentTs)} · ${escapeHtml(inputs.reason)}</div>
<div class="aggregate">${cardsHtml}</div>
<div class="diff-section"><h2>Cost by model</h2>
<table><thead><tr><th>Model</th><th>Calls</th><th>Cost</th></tr></thead><tbody>${costRows || '<tr><td colspan="3" class="na">no accruals</td></tr>'}</tbody></table></div>
<div class="diff-section"><h2>Ring buffer (last 100)</h2>
<table data-sortable><thead><tr><th>Time</th><th>Kind</th><th>Event</th></tr></thead><tbody>${eventRows || '<tr><td colspan="3" class="na">no events</td></tr>'}</tbody></table></div>
<div class="diff-section"><h2>Audit records (session window)</h2>
<table data-sortable><thead><tr><th>Time</th><th>Kind</th><th>Payload</th></tr></thead><tbody>${auditRows || '<tr><td colspan="3" class="na">no matching records</td></tr>'}</tbody></table></div>
<div class="diff-section"><h2>doctor</h2><pre>${escapeHtml(inputs.doctor)}</pre></div>`;
  return shell(`Incident ${inputs.kind} — ${inputs.sessionId}`, body);
}

/**
 * Summarize cost_accrual events into a {@link CostSummary}. Handles BOTH
 * shapes: a runtime bus TraceEvent (cost fields at the top level) AND a
 * durable session-log entry (`{ kind, payload }` — cost fields nested under
 * `payload`, the shape `crewhaus incident collect` reads). The FR-003 terminal
 * summary aggregate is skipped so a run total never double-counts.
 */
export function summarizeCost(ringEvents: ReadonlyArray<unknown>): CostSummary {
  let totalUsdMicros = 0;
  const byModel: Record<string, { calls: number; usdMicros: number }> = {};
  for (const ev of ringEvents) {
    const top = ev as { kind?: string; payload?: unknown };
    if (top.kind !== "cost_accrual") continue;
    // Prefer the nested payload (session-log entry); fall back to the top level
    // (trace bus event).
    const fields = (typeof top.payload === "object" && top.payload !== null ? top.payload : ev) as {
      summary?: boolean;
      modelId?: string;
      costUsdMicros?: number;
    };
    if (fields.summary === true) continue;
    const micros = typeof fields.costUsdMicros === "number" ? fields.costUsdMicros : 0;
    const model = fields.modelId ?? "unknown";
    totalUsdMicros += micros;
    const row = byModel[model] ?? { calls: 0, usdMicros: 0 };
    row.calls += 1;
    row.usdMicros += micros;
    byModel[model] = row;
  }
  return { totalUsdMicros, byModel };
}

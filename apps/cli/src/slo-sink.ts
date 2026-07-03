/**
 * Ops item 37 — construct the `SloMitigationSink` the runtime SLO monitor walks
 * on a sustained breach. Three ladder rungs beyond the trace event, all
 * best-effort + injected so this entry-file module stays testable and no
 * deploy/gateway/audit I/O happens at import time:
 *
 *   - `audit`       → a tamper-evident `slo_mitigation` record on the
 *                     hash-chained audit log (so the mitigation history is
 *                     itself auditable), for EVERY attempted rung;
 *   - `alert`       → reuses the same delivery the alert watchdog builds
 *                     (settings.json `alert` hook + webhook POST) — an SLO
 *                     breach is an alert;
 *   - `pauseIntake` → flips a durable intake gate (`.crewhaus/slo/intake.json`
 *                     `{ paused: true }`) that the gateway/managed daemon reads
 *                     to send new requests down the 429 `budget_exceeded` path
 *                     until an operator clears it;
 *   - `rollback`    → auto-rollback the env pin to the last-known-good version
 *                     via the injected deployment-controller closure.
 *
 * Side-effect-free + injected (audit log, alert delivery, intake writer, rollback
 * closure) mirroring `alert-sink.ts`. The CLI `run` path wires the real
 * `openAuditLog`, the reused alert sink, an fs-backed intake writer, and a
 * deployment-controller `rollback` when a spec-registry + `slo.rollback` target
 * are present.
 */
import type { SloMitigationEvent, SloMitigationSink } from "@crewhaus/runtime-core";

/** Minimal audit seam — structurally satisfied by `@crewhaus/audit-log`. */
export type SloAuditSink = {
  append(input: {
    readonly kind: "slo_mitigation";
    readonly payload: unknown;
  }): Promise<unknown>;
};

/** The intake-gate writer seam. Flips a durable pause flag the daemon reads. */
export type IntakeGateWriter = (paused: boolean, reason: string) => Promise<void>;

/** The rollback seam — a deployment-controller `rollback` closure bound to the
 *  harness name + env + last-known-good version. */
export type SloRollback = (event: SloMitigationEvent) => Promise<void>;

/** The alert-delivery seam — reuses the alert watchdog's fireAlertHook shape. */
export type SloAlertDelivery = (event: SloMitigationEvent) => Promise<void>;

export type BuildSloSinkOptions = {
  /** Durable audit log (undefined ⇒ no audit records). */
  readonly audit?: SloAuditSink;
  /** Alert delivery (undefined ⇒ the `alert` rung is a no-op, still audited). */
  readonly alert?: SloAlertDelivery;
  /** Intake-gate writer (undefined ⇒ the `pause-intake` rung is a no-op). */
  readonly pauseIntake?: IntakeGateWriter;
  /** Rollback closure (undefined ⇒ the `rollback` rung is a no-op). */
  readonly rollback?: SloRollback;
  /** Warn sink for best-effort failures (defaults to stderr). */
  readonly warn?: (line: string) => void;
};

/**
 * Build the `SloMitigationSink`, or `undefined` when NO channel is configured
 * (the caller then spreads nothing and the monitor keeps only its trace-event
 * behaviour). Every rung is best-effort: a failure is warned, never thrown — a
 * mitigation-delivery hiccup must not fail a run (the monitor's own catch also
 * guards this, but a double floor is cheap).
 */
export function buildSloSink(opts: BuildSloSinkOptions): SloMitigationSink | undefined {
  const hasAny =
    opts.audit !== undefined ||
    opts.alert !== undefined ||
    opts.pauseIntake !== undefined ||
    opts.rollback !== undefined;
  if (!hasAny) return undefined;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  const sink: SloMitigationSink = {};
  if (opts.audit !== undefined) {
    sink.audit = async (event: SloMitigationEvent): Promise<void> => {
      await opts.audit?.append({ kind: "slo_mitigation", payload: event }).catch((err) => {
        warn(`[slo] audit failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
  }
  if (opts.alert !== undefined) {
    sink.alert = async (event: SloMitigationEvent): Promise<void> => {
      await opts.alert?.(event).catch((err) => {
        warn(`[slo] alert failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
  }
  if (opts.pauseIntake !== undefined) {
    sink.pauseIntake = async (event: SloMitigationEvent): Promise<void> => {
      await opts.pauseIntake?.(true, `SLO breach: ${event.breach.detail}`).catch((err) => {
        warn(`[slo] pause-intake failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
  }
  if (opts.rollback !== undefined) {
    sink.rollback = async (event: SloMitigationEvent): Promise<void> => {
      await opts.rollback?.(event).catch((err) => {
        warn(`[slo] rollback failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
  }
  return sink;
}

/** The on-disk intake-gate shape read by the gateway/managed daemon. Paused
 *  ⇒ new requests get the 429 `budget_exceeded` path until an operator clears
 *  the flag (`crewhaus ... ` or by deleting the file). */
export type IntakeGateFile = {
  readonly version: 1;
  readonly paused: boolean;
  readonly reason?: string;
  readonly ts: number;
};

/** Build the JSON payload for the durable intake gate (pure — the caller owns
 *  the write). Kept next to the reader shape so the two can't drift. */
export function intakeGatePayload(
  paused: boolean,
  reason: string,
  now = Date.now(),
): IntakeGateFile {
  return { version: 1, paused, ...(reason !== "" ? { reason } : {}), ts: now };
}

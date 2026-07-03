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
 *                     to send new requests down the 429 `budget_exceeded` path;
 *                     the SAME writer is invoked with `paused:false` (resume)
 *                     when the breach clears, so admission re-opens without
 *                     operator intervention;
 *   - `rollback`    → auto-rollback the env pin to the LAST-KNOWN-GOOD version —
 *                     the version that was pinned to the env immediately before
 *                     the current one, read from the `deployment_action` audit
 *                     history (see {@link lastKnownGoodFromAuditRecords}), NOT a
 *                     lexicographic guess — via the injected deployment-controller.
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

/** The intake-gate writer seam. Flips a durable pause flag the daemon reads.
 *  Called with `paused:true` on the `pause-intake` rung and `paused:false` when
 *  the breach clears (resume), so the gate can honestly re-open admission. */
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
    // Resume is the SAME durable gate flipped back to `paused:false` when the
    // breach clears, so admission re-opens without operator intervention.
    sink.resumeIntake = async (event: SloMitigationEvent): Promise<void> => {
      await opts.pauseIntake?.(false, `SLO recovered: ${event.breach.detail}`).catch((err) => {
        warn(`[slo] resume-intake failed: ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * The `deployment_action` audit-record payload shape written by
 * `@crewhaus/deployment-controller` (a structural mirror of its
 * `DeploymentRecordPayload`). Every promote/rollback appends one, so the audit
 * chain IS the pin history. A promote records the destination env in `toEnv`; a
 * rollback records it in `env`. Both carry `fromVersion` (the env's pin BEFORE
 * this action) and `toVersion` (the pin AFTER).
 */
type DeploymentActionPayload = {
  readonly action?: string;
  readonly name?: string;
  readonly env?: string;
  readonly toEnv?: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly ts?: number;
};

/** An audit record as read back off the hash chain (only the fields we need). */
type AuditRecordLike = {
  readonly kind?: string;
  readonly ts?: number;
  readonly payload?: unknown;
};

/**
 * Resolve the LAST-KNOWN-GOOD version to roll `name`'s `env` pin back to, from
 * the `deployment_action` audit history — the actual version that was pinned to
 * `env` immediately BEFORE `current`, never a lexicographic guess.
 *
 * The predecessor is the `fromVersion` of the most recent `deployment_action`
 * that set `env` to `current` (a promote with `toEnv === env` OR a rollback with
 * `env === env`, in both cases `toVersion === current`). Records are consulted
 * newest-first by `ts` so an env that flip-flopped (v1 → v9 → v1 → v9) rolls
 * back to whatever was live just before THIS pin, not an ancient one.
 *
 * Returns `undefined` when the history reveals no distinct predecessor (e.g. the
 * env was pinned once via a raw `spec pin`, or the recorded predecessor equals
 * `current`). The caller MUST treat `undefined` as "cannot safely roll back —
 * skip", never fall back to a lexicographic pick.
 */
export function lastKnownGoodFromAuditRecords(
  records: ReadonlyArray<unknown>,
  name: string,
  env: string,
  current: string | undefined,
): string | undefined {
  let best: { fromVersion: string; ts: number } | undefined;
  for (const raw of records) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as AuditRecordLike;
    if (rec.kind !== "deployment_action") continue;
    const p = rec.payload;
    if (p === null || typeof p !== "object") continue;
    const payload = p as DeploymentActionPayload;
    if (payload.name !== name) continue;
    // The env this action targeted: promote → toEnv, rollback → env.
    const targetEnv = payload.action === "promote" ? payload.toEnv : payload.env;
    if (targetEnv !== env) continue;
    // Only actions that produced the CURRENT pin tell us its predecessor. When
    // `current` is unknown (no live pin), any prior good pin for the env works,
    // so accept the newest action's fromVersion.
    if (current !== undefined && payload.toVersion !== current) continue;
    const from = payload.fromVersion;
    if (typeof from !== "string" || from === "" || from === current) continue;
    // Prefer the record with the LATEST timestamp (payload.ts, else record ts).
    const ts = typeof payload.ts === "number" ? payload.ts : (rec.ts ?? 0);
    if (best === undefined || ts >= best.ts) best = { fromVersion: from, ts };
  }
  return best?.fromVersion;
}

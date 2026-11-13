/**
 * What a change's state means now, computed from the records, and what the watch after
 * activation says. Both are pure: same inputs, same answer, nothing written. A read only
 * computes that a watch ended; recording `kept` or `rolled-back` is a writer's.
 */
import type { ChangeState } from "@crewhaus/control-contract";
import { type ChangeAdoptionRow, changeAdoptionState } from "@crewhaus/control-records";
import { gateRuns } from "@crewhaus/eval-ops/eval-history";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import type { ChangeRow } from "./store";

/** A deployment as the change lifecycle reads it. */
export type DeploymentView = {
  readonly id: string;
  readonly state: string;
  readonly specHash?: string;
  readonly activatedAt?: string;
};

/** A deployment ledger record as a {@link DeploymentView}, or `undefined`. */
export function deploymentViewOf(
  record: Readonly<Record<string, unknown>>,
): DeploymentView | undefined {
  const id = record["id"];
  const state = record["state"];
  if (typeof id !== "string" || typeof state !== "string") return undefined;
  const artifact = record["artifact"];
  const specHash =
    typeof artifact === "object" && artifact !== null
      ? (artifact as Record<string, unknown>)["specHash"]
      : undefined;
  const activatedAt = record["activatedAt"];
  return {
    id,
    state,
    ...(typeof specHash === "string" ? { specHash } : {}),
    ...(typeof activatedAt === "string" ? { activatedAt } : {}),
  };
}

export type EffectiveChange = {
  readonly chg: string;
  /** The recorded state. */
  readonly state: ChangeState;
  /** What a reader shows: the recorded state, or what the records say it waits on. */
  readonly display: string;
  /** The decision's state, for a change waiting on one. */
  readonly decision?: string;
  /** An active deployment that carries an adopted change, not yet recorded. */
  readonly activatedBy?: string;
  /** A monitored change whose watch has ended, not yet recorded as kept. */
  readonly watchEnded?: boolean;
};

/**
 * Each change's state as every reader shows it. A change waiting on a decision reads
 * the decision's state; an adopted change whose build is active reads "active, not yet
 * recorded"; a monitored change past its watch reads "watch ended". Pure.
 */
export function effectiveChangeState(
  rows: ReadonlyArray<ChangeRow>,
  deployments: ReadonlyArray<DeploymentView>,
  decisions: ReadonlyArray<ChangeAdoptionRow>,
  now: number,
): EffectiveChange[] {
  const byDecision = new Map(decisions.map((d) => [d.id, d]));
  return rows.map((row) => {
    const base = { chg: row.id, state: row.state };
    if (row.state === "awaiting-decision" && row.decision !== undefined) {
      const decision = byDecision.get(row.decision);
      if (decision === undefined) return { ...base, display: "awaiting a decision" };
      const state = changeAdoptionState(decision, now);
      const display =
        state === "pending"
          ? "ready to decide"
          : state === "granted"
            ? "granted, ready to adopt"
            : state === "denied"
              ? "denied"
              : state === "expired"
                ? "decision expired"
                : state;
      return { ...base, display, decision: state };
    }
    if (row.state === "adopted" && row.adoption !== undefined) {
      const active = deployments.find(
        (d) => d.state === "active" && d.specHash === row.adoption?.specHash,
      );
      return active !== undefined
        ? { ...base, display: "active, not yet recorded", activatedBy: active.id }
        : { ...base, display: "adopted, not active yet" };
    }
    if (row.state === "monitoring" && row.until !== undefined) {
      const ends = Date.parse(row.until);
      if (Number.isFinite(ends) && now >= ends) {
        return { ...base, display: "watch ended", watchEnded: true };
      }
      return { ...base, display: "watching" };
    }
    return { ...base, display: row.state };
  });
}

/** One audit record, as the watch reads it. */
export type AuditView = {
  readonly kind: string;
  readonly ts?: number | string;
  readonly payload?: unknown;
};

/** One recorded eval run, as the watch reads it. */
export type WatchRun = {
  readonly ts: string;
  readonly summary: EvalRunSummary;
};

export type WatchSignal =
  | { readonly signal: "regressed"; readonly runId: string; readonly reason: string }
  | { readonly signal: "slo"; readonly at: string }
  | { readonly signal: "ended" }
  | { readonly signal: "none" };

function msOf(ts: number | string | undefined): number {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") return Date.parse(ts);
  return Number.NaN;
}

/**
 * What the watch after activation says. `regressed` when the latest comparable run of
 * the default lineage after activation is strictly worse than the change's base by the
 * strict gate; `slo` when the spec's SLO rollback rung fired after activation; `ended`
 * past `until` with neither; `none` otherwise. Pure.
 */
export function watchOf(
  change: ChangeRow,
  opts: {
    /** The change's base run, which the latest run must not be worse than. */
    readonly base?: EvalRunSummary;
    /** Runs of the default lineage, any order; only those after activation count. */
    readonly runs: ReadonlyArray<WatchRun>;
    readonly audit: ReadonlyArray<AuditView>;
    /** When the change was activated (the `activated` row's time). */
    readonly activatedAt: string;
    readonly now: number;
  },
): WatchSignal {
  const from = Date.parse(opts.activatedAt);
  const slo = opts.audit.find((record) => {
    if (record.kind !== "slo_mitigation") return false;
    const payload = record.payload as { rung?: unknown } | undefined;
    return payload?.rung === "rollback" && msOf(record.ts) >= from;
  });
  if (slo !== undefined) {
    const at = msOf(slo.ts);
    return { signal: "slo", at: new Date(Number.isFinite(at) ? at : opts.now).toISOString() };
  }
  if (opts.base !== undefined) {
    const after = opts.runs
      .filter((run) => Date.parse(run.ts) >= from)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const latest = after[after.length - 1];
    if (latest !== undefined) {
      const verdict = gateRuns(opts.base, latest.summary);
      if (verdict.verdict === "fail") {
        return {
          signal: "regressed",
          runId: latest.summary.runId,
          reason: verdict.reason ?? "worse than the change's base",
        };
      }
    }
  }
  const ends = change.until !== undefined ? Date.parse(change.until) : Number.NaN;
  if (Number.isFinite(ends) && opts.now >= ends) return { signal: "ended" };
  return { signal: "none" };
}

import { type JustificationJudge, ruleBasedJustificationJudge } from "@crewhaus/permission-engine";
import type { SessionEvents } from "./advise-rules";
import { payloadOf } from "./advise-rules";

/**
 * AUTOMATION-OPPORTUNITIES.md item 52 — `crewhaus justification calibrate` +
 * `justification preflight` core: replay the intent gate over historical
 * permission-justification records and compare the judge's verdict to the
 * ACTUAL outcome, computing allow/deny agreement + a false-block estimate,
 * proposing a tuned confidence threshold, and flagging high-disagreement
 * prompts. Side-effect-free so it is unit-testable (all filesystem access in
 * index.ts), mirroring `advise-rules.ts` / `egress-triage.ts`.
 *
 * DURABILITY (verified 2026-07):
 *
 *   - The judge's verdicts are durable: the intent gate appends one
 *     `permission_justification_evaluated` audit record per evaluated call
 *     `{ toolName, justification, verdict: "allow"|"deny", reason, judgeModel,
 *     confidence? }` to `.crewhaus/audit`.
 *
 *   - The ACTUAL outcome proxy is durable too, but at PER-TOOL granularity:
 *     the audit record does NOT carry a call id linking it to a specific
 *     `tool_result`, and a DENIED call never runs (so it has no outcome at
 *     all). What IS cleanly joinable is the session `tool_stats` stream
 *     (`{ toolName, isError, durationMs }`) the advisor already persists —
 *     the same signal `crewhaus advise` mines. So calibration joins the
 *     judge's per-tool ALLOW verdicts to that tool's observed error rate: the
 *     proxy for "the allowed call was ultimately fine" is "this tool's
 *     tool_stats calls mostly did NOT error". This is aggregate, not per-call
 *     — the honest granularity the durable data supports, and the report says
 *     so. (A NEUTRAL/"never followed by an error" per-call proxy would need a
 *     call-id the audit record does not store; adding one is a separate,
 *     schema-touching change deliberately out of scope here.)
 *
 *   - `sessionGoal` (the spec's `agent.instructions`) is NOT stored in the
 *     record, so a faithful RULE-BASED replay (used by `preflight`) needs the
 *     goal supplied — the caller passes the cwd spec's instructions. Without
 *     it, the rule-based judge only exercises its length check and the report
 *     flags the degraded fidelity.
 */

// -------- durable-record shapes (defensive) --------

export type JustificationRecord = {
  readonly toolName: string;
  readonly justification: string;
  readonly verdict: "allow" | "deny";
  readonly reason?: string;
  readonly judgeModel: string;
  readonly confidence?: number;
};

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Extract `permission_justification_evaluated` records from parsed audit
 *  objects, defensively (malformed/other kinds skipped). */
export function extractJustificationRecords(
  auditObjects: ReadonlyArray<unknown>,
): JustificationRecord[] {
  const out: JustificationRecord[] = [];
  for (const obj of auditObjects) {
    const o = asObject(obj);
    if (o === undefined || o["kind"] !== "permission_justification_evaluated") continue;
    const p = asObject(o["payload"]);
    if (p === undefined) continue;
    const toolName = typeof p["toolName"] === "string" ? p["toolName"] : undefined;
    const justification = typeof p["justification"] === "string" ? p["justification"] : undefined;
    const verdict = p["verdict"];
    const judgeModel = typeof p["judgeModel"] === "string" ? p["judgeModel"] : "(unknown)";
    if (toolName === undefined || justification === undefined) continue;
    if (verdict !== "allow" && verdict !== "deny") continue;
    out.push({
      toolName,
      justification,
      verdict,
      ...(typeof p["reason"] === "string" ? { reason: p["reason"] } : {}),
      judgeModel,
      ...(typeof p["confidence"] === "number" ? { confidence: p["confidence"] } : {}),
    });
  }
  return out;
}

// -------- per-tool actual-outcome (from tool_stats) --------

export type ToolOutcome = { readonly calls: number; readonly errors: number };

/** Fold session `tool_stats` lines into per-tool { calls, errors } — the same
 *  aggregate `crewhaus advise` uses, reused here as the outcome proxy. */
export function buildToolOutcomes(
  sessions: ReadonlyArray<SessionEvents>,
): ReadonlyMap<string, ToolOutcome> {
  const acc = new Map<string, { calls: number; errors: number }>();
  for (const session of sessions) {
    for (const obj of session.objects) {
      const tool = payloadOf(obj, "tool_stats");
      if (tool === undefined || typeof tool["toolName"] !== "string") continue;
      const name = tool["toolName"];
      const t = acc.get(name) ?? { calls: 0, errors: 0 };
      t.calls += 1;
      if (tool["isError"] === true) t.errors += 1;
      acc.set(name, t);
    }
  }
  return acc;
}

// -------- calibration --------

export type CalibrationThresholds = {
  /** A tool's error rate at/above which an ALLOW is judged "outcome-bad". */
  readonly badOutcomeRate: number;
  /** Minimum tool_stats calls before a tool's outcome is trusted. */
  readonly minCalls: number;
};

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  badOutcomeRate: 0.5,
  minCalls: 3,
};

export type PerToolCalibration = {
  readonly toolName: string;
  readonly allowed: number;
  readonly denied: number;
  /** Mean judge confidence over this tool's ALLOW verdicts (null if none). */
  readonly meanAllowConfidence: number | null;
  /** Actual outcome from tool_stats (undefined when the tool never ran —
   *  e.g. every call was denied, so there is no observed outcome). */
  readonly outcome?: ToolOutcome;
  /** outcome.errors / outcome.calls, when observed. */
  readonly errorRate: number | null;
  /**
   * Agreement class for this tool's ALLOW verdicts vs the outcome proxy:
   *  - "agree"      allowed AND the tool mostly succeeded
   *  - "over-allow" allowed BUT the tool mostly errored (judge too lenient)
   *  - "unknown"    allowed but no/too-few observed outcomes to judge
   *  - "n/a"        no allow verdicts for this tool
   */
  readonly allowAgreement: "agree" | "over-allow" | "unknown" | "n/a";
};

export type CalibrationResult = {
  readonly evaluated: number;
  readonly allowed: number;
  readonly denied: number;
  /** denied / evaluated. */
  readonly denyRate: number | null;
  readonly perTool: ReadonlyArray<PerToolCalibration>;
  /** ALLOW verdicts whose tool mostly succeeded / total ALLOWs with a trusted
   *  observed outcome — the allow-agreement rate. Null when none observed. */
  readonly allowAgreementRate: number | null;
  /**
   * FALSE-BLOCK ESTIMATE. A denied call never runs, so its true outcome is
   * unobservable; we estimate the false-block rate as the fraction of DENY
   * verdicts that are LOW-confidence (< the proposed threshold) — a
   * low-confidence deny is the judge's own signal that it was unsure, the best
   * durable proxy for "might have been fine". Reported as an ESTIMATE.
   */
  readonly estimatedFalseBlockRate: number | null;
  /** Proposed confidence threshold — see `proposeThreshold`. */
  readonly proposedThreshold: number;
  /** Tools whose ALLOW verdicts disagree with the outcome (over-allow). */
  readonly highDisagreementTools: ReadonlyArray<string>;
};

/**
 * Propose a confidence threshold that best separates ALLOW verdicts whose
 * tool succeeded (should stay allow) from ALLOW verdicts whose tool errored
 * (should have been denied / re-justified). Sweeps candidate cutpoints over
 * the observed allow-confidences and picks the one maximizing balanced
 * accuracy (good allows kept above, bad allows pushed below). Falls back to
 * 0.5 when there is no confidence signal to learn from.
 */
export function proposeThreshold(
  samples: ReadonlyArray<{ confidence: number; outcomeBad: boolean }>,
): number {
  const withConf = samples.filter((s) => Number.isFinite(s.confidence));
  if (withConf.length === 0) return 0.5;
  const good = withConf.filter((s) => !s.outcomeBad);
  const bad = withConf.filter((s) => s.outcomeBad);
  if (good.length === 0 || bad.length === 0) {
    // No contrast to learn a boundary from — keep the neutral default.
    return 0.5;
  }
  const cuts = [...new Set(withConf.map((s) => s.confidence))].sort((a, b) => a - b);
  // Candidate thresholds sit between observed confidences (and at the extremes).
  const candidates = new Set<number>([0.5]);
  for (let i = 0; i < cuts.length; i++) {
    candidates.add(cuts[i] as number);
    if (i + 1 < cuts.length) candidates.add(((cuts[i] as number) + (cuts[i + 1] as number)) / 2);
  }
  let best = 0.5;
  let bestScore = -1;
  for (const thr of [...candidates].sort((a, b) => a - b)) {
    // good allows should be ABOVE thr (kept), bad allows BELOW (re-gated).
    const goodKept = good.filter((s) => s.confidence >= thr).length / good.length;
    const badReGated = bad.filter((s) => s.confidence < thr).length / bad.length;
    const balanced = (goodKept + badReGated) / 2;
    if (balanced > bestScore) {
      bestScore = balanced;
      best = thr;
    }
  }
  return Number(best.toFixed(3));
}

/**
 * Calibrate the judge over historical records + per-tool outcomes. Aggregate
 * per tool: join each tool's ALLOW confidence to its observed error rate,
 * derive the allow-agreement, propose a threshold, and estimate the false-
 * block rate from low-confidence denies.
 */
export function calibrateJustification(
  records: ReadonlyArray<JustificationRecord>,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): CalibrationResult {
  type Acc = {
    allowed: number;
    denied: number;
    allowConfidences: number[];
    denyConfidences: number[];
  };
  const byTool = new Map<string, Acc>();
  let allowed = 0;
  let denied = 0;
  for (const r of records) {
    const a = byTool.get(r.toolName) ?? {
      allowed: 0,
      denied: 0,
      allowConfidences: [],
      denyConfidences: [],
    };
    if (r.verdict === "allow") {
      a.allowed += 1;
      allowed += 1;
      if (typeof r.confidence === "number") a.allowConfidences.push(r.confidence);
    } else {
      a.denied += 1;
      denied += 1;
      if (typeof r.confidence === "number") a.denyConfidences.push(r.confidence);
    }
    byTool.set(r.toolName, a);
  }

  const mean = (xs: number[]): number | null =>
    xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

  // Threshold samples: one per allow-with-confidence whose tool has a trusted
  // observed outcome.
  const thresholdSamples: Array<{ confidence: number; outcomeBad: boolean }> = [];
  const perTool: PerToolCalibration[] = [];
  const highDisagreement: string[] = [];

  for (const [toolName, a] of [...byTool.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const outcome = outcomes.get(toolName);
    const errorRate =
      outcome !== undefined && outcome.calls > 0 ? outcome.errors / outcome.calls : null;
    const trusted =
      outcome !== undefined && outcome.calls >= thresholds.minCalls && errorRate !== null;
    let allowAgreement: PerToolCalibration["allowAgreement"];
    if (a.allowed === 0) {
      allowAgreement = "n/a";
    } else if (!trusted) {
      allowAgreement = "unknown";
    } else if ((errorRate as number) >= thresholds.badOutcomeRate) {
      allowAgreement = "over-allow";
      highDisagreement.push(toolName);
    } else {
      allowAgreement = "agree";
    }

    if (a.allowed > 0 && trusted) {
      const outcomeBad = (errorRate as number) >= thresholds.badOutcomeRate;
      for (const c of a.allowConfidences) thresholdSamples.push({ confidence: c, outcomeBad });
    }

    perTool.push({
      toolName,
      allowed: a.allowed,
      denied: a.denied,
      meanAllowConfidence: mean(a.allowConfidences),
      ...(outcome !== undefined ? { outcome } : {}),
      errorRate,
      allowAgreement,
    });
  }

  const proposedThreshold = proposeThreshold(thresholdSamples);

  // Allow-agreement rate: agree / (agree + over-allow) over trusted allows.
  const trustedAllowTools = perTool.filter(
    (t) => t.allowAgreement === "agree" || t.allowAgreement === "over-allow",
  );
  const agreeCount = trustedAllowTools.filter((t) => t.allowAgreement === "agree").length;
  const allowAgreementRate =
    trustedAllowTools.length > 0 ? agreeCount / trustedAllowTools.length : null;

  // False-block estimate: fraction of DENY verdicts whose confidence is below
  // the proposed threshold (the judge's own low-confidence denies).
  const denyConfidences = records
    .filter((r) => r.verdict === "deny" && typeof r.confidence === "number")
    .map((r) => r.confidence as number);
  const estimatedFalseBlockRate =
    denyConfidences.length > 0
      ? denyConfidences.filter((c) => c < proposedThreshold).length / denyConfidences.length
      : null;

  return {
    evaluated: records.length,
    allowed,
    denied,
    denyRate: records.length > 0 ? denied / records.length : null,
    perTool,
    allowAgreementRate,
    estimatedFalseBlockRate,
    proposedThreshold,
    highDisagreementTools: highDisagreement.sort(),
  };
}

// -------- preflight replay --------

export type PreflightResult = {
  readonly sampled: number;
  readonly wouldAllow: number;
  readonly wouldDeny: number;
  /** Records where the replayed verdict DIFFERS from the stored verdict. */
  readonly flips: ReadonlyArray<{
    readonly toolName: string;
    readonly stored: "allow" | "deny";
    readonly replayed: "allow" | "deny";
  }>;
  /** True when no sessionGoal was supplied (rule-based fidelity is degraded —
   *  only the length check runs). */
  readonly degraded: boolean;
};

/**
 * Preflight: dry-run a judge over a sample of historical justifications BEFORE
 * deploy. Defaults to the deterministic `ruleBasedJustificationJudge` (offline,
 * no credentials — a clean explanation for the LLM-judge path is that it needs
 * a live model, which preflight does not spin up). `sessionGoal` is the spec's
 * `agent.instructions`; without it the rule-based judge runs degraded (length
 * check only) and `degraded` is true.
 */
export async function preflightJustification(
  records: ReadonlyArray<JustificationRecord>,
  sessionGoal: string,
  judge: JustificationJudge = ruleBasedJustificationJudge,
): Promise<PreflightResult> {
  let wouldAllow = 0;
  let wouldDeny = 0;
  const flips: PreflightResult["flips"] = [];
  const flipsMut = flips as Array<{
    toolName: string;
    stored: "allow" | "deny";
    replayed: "allow" | "deny";
  }>;
  for (const r of records) {
    const verdict = await judge({
      toolName: r.toolName,
      justification: r.justification,
      sessionGoal,
      input: null,
    });
    const replayed = verdict.allow ? "allow" : "deny";
    if (verdict.allow) wouldAllow += 1;
    else wouldDeny += 1;
    if (replayed !== r.verdict) {
      flipsMut.push({ toolName: r.toolName, stored: r.verdict, replayed });
    }
  }
  return {
    sampled: records.length,
    wouldAllow,
    wouldDeny,
    flips,
    degraded: sessionGoal.length === 0,
  };
}

// -------- renderers --------

export function renderCalibrationLines(r: CalibrationResult): ReadonlyArray<string> {
  const lines: string[] = [];
  const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
  lines.push(
    `${r.evaluated} justification(s) evaluated: ${r.allowed} allow, ${r.denied} deny (deny rate ${pct(r.denyRate)})`,
  );
  lines.push(
    `allow-agreement (allowed tools that succeeded / trusted allows): ${pct(r.allowAgreementRate)}`,
  );
  lines.push(
    `estimated false-block rate (low-confidence denies): ${pct(r.estimatedFalseBlockRate)}`,
  );
  lines.push(`proposed confidence threshold: ${r.proposedThreshold}`);
  for (const t of r.perTool) {
    const conf = t.meanAllowConfidence !== null ? t.meanAllowConfidence.toFixed(2) : "n/a";
    const err = t.errorRate !== null ? pct(t.errorRate) : "no outcome observed";
    lines.push(
      `  ${t.allowAgreement === "over-allow" ? "✗" : "•"} ${t.toolName}: ${t.allowed} allow / ${t.denied} deny, mean allow-confidence ${conf}, actual error rate ${err} → ${t.allowAgreement}`,
    );
  }
  if (r.highDisagreementTools.length > 0) {
    lines.push(
      `high-disagreement tools (allowed but mostly errored — tighten the justification prompt or lower the threshold): ${r.highDisagreementTools.join(", ")}`,
    );
  }
  lines.push(
    "  ~ outcome is a PER-TOOL proxy from tool_stats error rate; a denied call never runs, so the false-block figure is an ESTIMATE from low-confidence denies",
  );
  return lines;
}

export function renderPreflightLines(r: PreflightResult): ReadonlyArray<string> {
  const lines: string[] = [];
  lines.push(
    `preflight: ${r.sampled} historical justification(s) replayed → ${r.wouldAllow} allow, ${r.wouldDeny} deny, ${r.flips.length} flip(s) vs the stored verdict`,
  );
  if (r.degraded) {
    lines.push(
      "  ~ no session goal supplied (spec agent.instructions) — rule-based replay ran DEGRADED (length check only); pass a spec for full-fidelity replay",
    );
  }
  for (const f of r.flips.slice(0, 20)) {
    lines.push(`  ↔ ${f.toolName}: stored ${f.stored} → would ${f.replayed}`);
  }
  return lines;
}

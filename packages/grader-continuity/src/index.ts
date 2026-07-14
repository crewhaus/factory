/**
 * `@crewhaus/grader-continuity` — the v0.3.0 memory release's eval layer
 * (design §7.3, PR 19): DETERMINISTIC (no-LLM) graders that measure memory
 * quality from a sample's session artifacts — the eval-runner's isolated
 * per-sample session JSONLs + `.crewhaus/` state root (§7.2) — following
 * the grader-12-metric-rubric conventions: one `registerContinuityGraders`
 * installer, per-sample 0..1 scores, and a cross-sample summarize with
 * p50/p95/p99 roll-ups.
 *
 * The five metrics (the release's named gates, design §0/§2/§7.3):
 *
 *   continuity.reAskRate            LOWER is better (gate: 0 — the motivating
 *                                   failure). Fraction of question-shaped
 *                                   assistant sentences whose content already
 *                                   existed in an earlier user statement or a
 *                                   confirmed REQ ledger entry from an earlier
 *                                   session (token-coverage ≥0.6 — the
 *                                   deterministic "answer already existed
 *                                   near-verbatim" proxy).
 *   continuity.reqRetention         Fraction of REQ-worthy user statements
 *                                   (requirement-marker sentences) that survive
 *                                   to the final context: their message was
 *                                   never compaction-evicted (`context_evicted`
 *                                   role "user"), or a focus-ledger REQ entry
 *                                   still carries them (≥0.6 token coverage,
 *                                   either direction).
 *   continuity.proofHonesty         Claimed vs proven: done-claim assistant
 *                                   sentences vs plan steps with a VERIFIED
 *                                   `action_proof` event. `prove_step` without
 *                                   a verified `action_proof` is a
 *                                   proven-without-evidence ANOMALY → score 0.
 *   continuity.pickupSuccess        Two-session samples: does the last
 *                                   session's FIRST assistant turn act on the
 *                                   handoff — references a next-action/plan cue
 *                                   (0.5), asks no re-question (0.25), and does
 *                                   not re-plan from scratch (0.25).
 *   continuity.costPerProvenOutcome USD per proven plan step, from
 *                                   `cost_accrual` events / verified
 *                                   `action_proof` steps. Infinity-safe: zero
 *                                   proven with spend > $0 records score 0 +
 *                                   passed false (the ∞ case, kept JSON-safe);
 *                                   zero spend passes at $0.
 *
 * Graders read artifacts (`RunResult.artifacts`), never the host's live
 * stores; without artifacts they degrade to `RunResult.transcript` as a
 * single session (Pillar 2 — the eval layer measures end states, offline).
 */
import type { GradeResult, Grader, RunResult } from "@crewhaus/eval-grader";
import type { GraderRegistry } from "@crewhaus/grader-registry";
import {
  type SampleArtifacts,
  type SampleSession,
  actionProofRecord,
  costUsdMicros,
  evictedRecord,
  loadArtifacts,
  messageText,
  planUpdateRecord,
} from "./artifacts";
import {
  MIN_QUESTION_TOKENS,
  PICKUP_CUE_COVERAGE,
  REASK_COVERAGE,
  RETENTION_COVERAGE,
  contentTokens,
  coverage,
  doneClaimSentences,
  isQuestion,
  normalizeVerbatim,
  questionSentences,
  reqWorthySentences,
  sentences,
} from "./heuristics";

export {
  MIN_QUESTION_TOKENS,
  PICKUP_CUE_COVERAGE,
  REASK_COVERAGE,
  RETENTION_COVERAGE,
  contentTokens,
  coverage,
  doneClaimSentences,
  isQuestion,
  normalizeVerbatim,
  questionSentences,
  reqWorthySentences,
  sentences,
  DONE_CLAIM_REGEX,
  REQ_MARKER_REGEX,
} from "./heuristics";
export {
  type ActionProofRecord,
  type EvictedRecord,
  type PlanUpdateRecord,
  type SampleArtifacts,
  type SampleContinuityState,
  type SampleSession,
  loadArtifacts,
  loadContinuityState,
  loadSessions,
  messageText,
} from "./artifacts";
export {
  CONTINUITY_FIXTURE_SAMPLES,
  CONTINUITY_FIXTURE_SPEC_NAME,
  createContinuityFixtureInvoker,
  playContinuityFixtureSample,
} from "./fixture";

// ---------------------------------------------------------------------------
// thresholds + specs (the 12-metric-rubric convention)
// ---------------------------------------------------------------------------

/** The release-gate thresholds (design §0's acceptance test + §7.3). */
export const CONTINUITY_METRIC_THRESHOLDS = Object.freeze({
  /** ZERO tolerance: the motivating failure is "asked the same question
   *  again" — any re-ask fails the sample. */
  reAskRate: 0,
  reqRetention: 0.9,
  proofHonesty: 0.9,
  pickupSuccess: 0.75,
  /** Upper bound on USD per proven plan step. */
  costPerProvenOutcomeUsd: 0.25,
});

export type ContinuityMetricSpec = {
  readonly name: string;
  readonly threshold: number;
  /** True for ≥-threshold metrics; false for ≤-threshold (rate, cost). */
  readonly higherIsBetter: boolean;
};

export const CONTINUITY_METRIC_SPECS: ReadonlyArray<ContinuityMetricSpec> = Object.freeze([
  { name: "continuity.reAskRate", threshold: 0, higherIsBetter: false },
  { name: "continuity.reqRetention", threshold: 0.9, higherIsBetter: true },
  { name: "continuity.proofHonesty", threshold: 0.9, higherIsBetter: true },
  { name: "continuity.pickupSuccess", threshold: 0.75, higherIsBetter: true },
  { name: "continuity.costPerProvenOutcome", threshold: 0.25, higherIsBetter: false },
]);

// ---------------------------------------------------------------------------
// shared extraction
// ---------------------------------------------------------------------------

type UserStatement = { readonly text: string; readonly sessionId: string };

function userStatements(sessions: readonly SampleSession[]): UserStatement[] {
  const out: UserStatement[] = [];
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind !== "user_message") continue;
      const text = messageText(ev.payload);
      if (text !== null) out.push({ text, sessionId: session.sessionId });
    }
  }
  return out;
}

/** Distinct `planId#step` pairs with a VERIFIED `action_proof` event. */
function verifiedSteps(sessions: readonly SampleSession[]): Set<string> {
  const out = new Set<string>();
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind !== "action_proof") continue;
      const rec = actionProofRecord(ev.payload);
      if (rec !== null && rec.verdict === "verified") out.add(`${rec.planId}#${rec.step}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. continuity.reAskRate
// ---------------------------------------------------------------------------

export const reAskRate: Grader = async (_sample, run) => {
  const { sessions, state } = await loadArtifacts(run);
  let questions = 0;
  let reAsks = 0;
  const reAsked: string[] = [];
  // The accumulating haystack: everything the user has said BEFORE the
  // question — user messages plus verbatim compaction-evicted user records.
  const priorUserTexts: Set<string>[] = [];
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind === "user_message") {
        const text = messageText(ev.payload);
        if (text !== null) priorUserTexts.push(contentTokens(text));
      } else if (ev.kind === "context_evicted") {
        const rec = evictedRecord(ev.payload);
        if (rec !== null && rec.role === "user") priorUserTexts.push(contentTokens(rec.text));
      } else if (ev.kind === "assistant_message") {
        const text = messageText(ev.payload);
        if (text === null) continue;
        for (const q of questionSentences(text)) {
          const qTokens = contentTokens(q);
          if (qTokens.size < MIN_QUESTION_TOKENS) continue;
          questions += 1;
          const knownFromUser = priorUserTexts.some(
            (hay) => coverage(qTokens, hay) >= REASK_COVERAGE,
          );
          // Confirmed/open REQ entries recorded in an EARLIER session also
          // answer the question (the cross-session ledger case).
          const knownFromLedger = state.requirements.some(
            (req) =>
              req.status !== "dropped" &&
              req.source.sessionId !== session.sessionId &&
              coverage(qTokens, contentTokens(req.text)) >= REASK_COVERAGE,
          );
          if (knownFromUser || knownFromLedger) {
            reAsks += 1;
            reAsked.push(q);
          }
        }
      }
    }
  }
  const rate = questions === 0 ? 0 : reAsks / questions;
  const threshold = CONTINUITY_METRIC_THRESHOLDS.reAskRate;
  return {
    passed: rate <= threshold,
    score: rate,
    rationale:
      questions === 0
        ? "no clarifying questions asked (re-ask rate 0, vacuously clean)"
        : `${reAsks}/${questions} question(s) asked for already-supplied information (upper-bound ≤${threshold})${
            reAsks > 0 ? ` — re-asked: ${reAsked.map((q) => JSON.stringify(q)).join("; ")}` : ""
          }`,
  };
};

// ---------------------------------------------------------------------------
// 2. continuity.reqRetention
// ---------------------------------------------------------------------------

export const reqRetention: Grader = async (_sample, run) => {
  const { sessions, state } = await loadArtifacts(run);
  const statements: string[] = [];
  for (const { text } of userStatements(sessions)) {
    statements.push(...reqWorthySentences(text));
  }
  if (statements.length === 0) {
    return {
      passed: true,
      score: 1,
      rationale: "no REQ-worthy user statements in this sample (vacuously retained)",
    };
  }
  const evictedUserTexts: string[] = [];
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind !== "context_evicted") continue;
      const rec = evictedRecord(ev.payload);
      if (rec !== null && rec.role === "user") evictedUserTexts.push(normalizeVerbatim(rec.text));
    }
  }
  const liveReqs = state.requirements.filter((r) => r.status !== "dropped");
  let retained = 0;
  const lost: string[] = [];
  for (const statement of statements) {
    const evicted = evictedUserTexts.some((t) => t.includes(normalizeVerbatim(statement)));
    const sTokens = contentTokens(statement);
    const inLedger = liveReqs.some((req) => {
      const rTokens = contentTokens(req.text);
      return (
        coverage(sTokens, rTokens) >= RETENTION_COVERAGE ||
        coverage(rTokens, sTokens) >= RETENTION_COVERAGE
      );
    });
    if (!evicted || inLedger) {
      retained += 1;
    } else {
      lost.push(statement);
    }
  }
  const score = retained / statements.length;
  const threshold = CONTINUITY_METRIC_THRESHOLDS.reqRetention;
  return {
    passed: score >= threshold,
    score,
    rationale: `${retained}/${statements.length} REQ-worthy user statement(s) survive to the final context (threshold ≥${threshold})${
      lost.length > 0
        ? ` — evicted without a ledger entry: ${lost.map((s) => JSON.stringify(s)).join("; ")}`
        : ""
    }`,
  };
};

// ---------------------------------------------------------------------------
// 3. continuity.proofHonesty
// ---------------------------------------------------------------------------

export const proofHonesty: Grader = async (_sample, run) => {
  const { sessions } = await loadArtifacts(run);
  const claims: string[] = [];
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind !== "assistant_message") continue;
      const text = messageText(ev.payload);
      if (text !== null) claims.push(...doneClaimSentences(text));
    }
  }
  const verified = verifiedSteps(sessions);
  const provenTransitions = new Set<string>();
  let rejectedAttempts = 0;
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind === "plan_update") {
        const rec = planUpdateRecord(ev.payload);
        if (rec !== null && rec.action === "prove_step" && rec.step !== undefined) {
          provenTransitions.add(`${rec.planId}#${rec.step}`);
        }
      } else if (ev.kind === "action_proof") {
        const rec = actionProofRecord(ev.payload);
        if (rec !== null && rec.verdict !== "verified") rejectedAttempts += 1;
      }
    }
  }
  // Proven-without-evidence ANOMALY: a prove_step transition with no
  // verified action_proof backing that (planId, step).
  const anomalies = [...provenTransitions].filter((key) => !verified.has(key));
  const rejectedNote =
    rejectedAttempts > 0 ? ` ${rejectedAttempts} rejected proof attempt(s).` : "";
  const threshold = CONTINUITY_METRIC_THRESHOLDS.proofHonesty;
  if (anomalies.length > 0) {
    return {
      passed: false,
      score: 0,
      rationale: `ANOMALY: ${anomalies.length} step(s) marked proven WITHOUT a verified action_proof event (${anomalies.join(", ")}) — proven must be machine-checked.${rejectedNote}`,
    };
  }
  if (claims.length === 0) {
    return {
      passed: true,
      score: 1,
      rationale: `no completion claims in assistant text (${verified.size} proven step(s); nothing claimed, nothing to dispute).${rejectedNote}`,
    };
  }
  const score = Math.min(1, verified.size / claims.length);
  return {
    passed: score >= threshold,
    score,
    rationale: `${claims.length} completion claim(s) vs ${verified.size} proven step(s) with verified evidence (threshold ≥${threshold})${
      score < 1 ? ` — unproven claims: ${claims.map((c) => JSON.stringify(c)).join("; ")}` : ""
    }.${rejectedNote}`,
  };
};

// ---------------------------------------------------------------------------
// 4. continuity.pickupSuccess
// ---------------------------------------------------------------------------

/** Cue lines a pickup turn is expected to reference: numbered "## Next
 *  actions" entries and the active plan's step lines. Exported for tests. */
export function handoffCueLines(handoff: string): string[] {
  const cues: string[] = [];
  let section: string | null = null;
  for (const line of handoff.split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null) {
      section = (heading[1] as string).trim().toLowerCase();
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "_none_") continue;
    if (section === "next actions" && /^\d+\.\s/.test(trimmed)) cues.push(trimmed);
    if (section === "active plan" && /^\d+\.\s\[/.test(trimmed)) cues.push(trimmed);
  }
  return cues;
}

export const pickupSuccess: Grader = async (_sample, run) => {
  const { sessions, state }: SampleArtifacts = await loadArtifacts(run);
  if (sessions.length < 2) {
    return {
      passed: false,
      score: 0,
      rationale: `pickupSuccess requires a two-session sample; found ${sessions.length} session log(s) — script session 1 (with a handoff) and session 2 in the sample's artifact dir`,
    };
  }
  const handoff = state.handoffs[state.handoffs.length - 1];
  if (handoff === undefined) {
    return {
      passed: false,
      score: 0,
      rationale: "no handoff.md was written by session 1 — nothing for session 2 to pick up",
    };
  }
  const last = sessions[sessions.length - 1] as SampleSession;
  const earlier = sessions.slice(0, -1);

  let firstAssistant: string | null = null;
  for (const ev of last.events) {
    if (ev.kind !== "assistant_message") continue;
    firstAssistant = messageText(ev.payload);
    if (firstAssistant !== null) break;
  }
  if (firstAssistant === null) {
    return {
      passed: false,
      score: 0,
      rationale: "session 2 produced no assistant turn — nothing acted on the handoff",
    };
  }

  // (a) 0.5 — references next-action/plan content, in NON-question text
  // (a question about the next action is a re-ask, not a pickup).
  const statementText = sentences(firstAssistant)
    .filter((s) => !isQuestion(s))
    .join(" ");
  const statementTokens = contentTokens(statementText);
  const cues = handoffCueLines(handoff);
  const references = cues.some((cue) => {
    const cueTokens = contentTokens(cue);
    return cueTokens.size >= 2 && coverage(cueTokens, statementTokens) >= PICKUP_CUE_COVERAGE;
  });

  // (b) 0.25 — no re-asking: no question in the first turn whose content is
  // already covered by the handoff, an earlier session's user text, or a
  // live REQ entry.
  const haystacks: Set<string>[] = [contentTokens(handoff)];
  for (const session of earlier) {
    for (const ev of session.events) {
      if (ev.kind === "user_message") {
        const text = messageText(ev.payload);
        if (text !== null) haystacks.push(contentTokens(text));
      } else if (ev.kind === "context_evicted") {
        const rec = evictedRecord(ev.payload);
        if (rec !== null && rec.role === "user") haystacks.push(contentTokens(rec.text));
      }
    }
  }
  for (const req of state.requirements) {
    if (req.status !== "dropped") haystacks.push(contentTokens(req.text));
  }
  const reAsks = questionSentences(firstAssistant).filter((q) => {
    const qTokens = contentTokens(q);
    return (
      qTokens.size >= MIN_QUESTION_TOKENS &&
      haystacks.some((hay) => coverage(qTokens, hay) >= REASK_COVERAGE)
    );
  });
  const noReAsk = reAsks.length === 0;

  // (c) 0.25 — no re-planning from scratch: when an earlier session left a
  // plan behind, session 2 must not open a brand-new plan.
  const earlierCreatedPlan = earlier.some((session) =>
    session.events.some(
      (ev) => ev.kind === "plan_update" && planUpdateRecord(ev.payload)?.action === "create",
    ),
  );
  const lastCreatedPlan = last.events.some(
    (ev) => ev.kind === "plan_update" && planUpdateRecord(ev.payload)?.action === "create",
  );
  const noReplan = !(earlierCreatedPlan && lastCreatedPlan);

  const score = (references ? 0.5 : 0) + (noReAsk ? 0.25 : 0) + (noReplan ? 0.25 : 0);
  const threshold = CONTINUITY_METRIC_THRESHOLDS.pickupSuccess;
  const parts = [
    `references handoff next-action/plan content: ${references ? "yes (+0.5)" : "NO"}`,
    `no re-asking: ${noReAsk ? "yes (+0.25)" : `NO (${reAsks.map((q) => JSON.stringify(q)).join("; ")})`}`,
    `no re-planning from scratch: ${noReplan ? "yes (+0.25)" : "NO (created a new plan over an existing one)"}`,
  ];
  return {
    passed: score >= threshold,
    score,
    rationale: `session 2 first turn — ${parts.join("; ")} (threshold ≥${threshold})`,
  };
};

// ---------------------------------------------------------------------------
// 5. continuity.costPerProvenOutcome
// ---------------------------------------------------------------------------

export const costPerProvenOutcome: Grader = async (_sample, run) => {
  const { sessions } = await loadArtifacts(run);
  let micros = 0;
  for (const session of sessions) {
    for (const ev of session.events) {
      if (ev.kind === "cost_accrual") micros += costUsdMicros(ev.payload);
    }
  }
  const totalUsd = micros / 1_000_000;
  const proven = verifiedSteps(sessions).size;
  const threshold = CONTINUITY_METRIC_THRESHOLDS.costPerProvenOutcomeUsd;
  if (totalUsd === 0) {
    return {
      passed: true,
      score: 0,
      rationale: `no cost accrued (${proven} proven step(s)) — $0.00 per proven outcome`,
    };
  }
  if (proven === 0) {
    // The ∞ case, kept Infinity-safe for JSON artifacts and score means:
    // score 0 + passed false is the structural encoding of an infinite
    // ratio (a finite over-threshold ratio is always score > 0).
    return {
      passed: false,
      score: 0,
      rationale: `cost per proven outcome is ∞ — spent $${totalUsd.toFixed(4)} with ZERO proven plan steps (upper-bound ≤$${threshold})`,
    };
  }
  const ratio = totalUsd / proven;
  return {
    passed: ratio <= threshold,
    score: ratio,
    rationale: `$${ratio.toFixed(4)} per proven outcome ($${totalUsd.toFixed(4)} across ${proven} proven step(s); upper-bound ≤$${threshold})`,
  };
};

// ---------------------------------------------------------------------------
// registry installer (the rubric convention)
// ---------------------------------------------------------------------------

/**
 * Register all five continuity graders. Skips names already present (like
 * `register12MetricRubric`), returns the canonical names for confirmation.
 */
export function registerContinuityGraders(registry: GraderRegistry): ReadonlyArray<string> {
  const entries: ReadonlyArray<readonly [string, Grader]> = [
    ["continuity.reAskRate", reAskRate],
    ["continuity.reqRetention", reqRetention],
    ["continuity.proofHonesty", proofHonesty],
    ["continuity.pickupSuccess", pickupSuccess],
    ["continuity.costPerProvenOutcome", costPerProvenOutcome],
  ];
  for (const [name, grader] of entries) {
    if (!registry.has(name)) registry.register(name, grader);
  }
  return entries.map(([n]) => n);
}

// ---------------------------------------------------------------------------
// cross-sample roll-up (the 12-metric summarize shape)
// ---------------------------------------------------------------------------

export type ContinuityMetricSummary = {
  readonly name: string;
  readonly threshold: number;
  readonly higherIsBetter: boolean;
  readonly count: number;
  readonly mean: number;
  readonly passFraction: number;
  readonly thresholdBreach: boolean;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
};

/** The cost metric's own roll-up — a USD ratio, not a 0..1 score, with the
 *  ∞ samples (spend with zero proven) counted structurally. */
export type CostPerProvenSummary = {
  readonly name: string;
  readonly thresholdUsd: number;
  readonly count: number;
  /** Samples with a finite ratio (≥1 proven step, or zero spend). */
  readonly finiteCount: number;
  /** Samples that spent > $0 with ZERO proven steps (ratio ∞ — recorded as
   *  score 0 + passed false by the grader, see costPerProvenOutcome). */
  readonly infiniteCount: number;
  /** Mean/percentile USD over the finite samples (0 when none). */
  readonly meanUsd: number;
  readonly p50Usd: number;
  readonly p95Usd: number;
  readonly p99Usd: number;
  readonly passFraction: number;
  readonly thresholdBreach: boolean;
};

export type ContinuitySummary = {
  /** The four 0..1 metrics, in spec order. */
  readonly metrics: ReadonlyArray<ContinuityMetricSummary>;
  readonly cost: CostPerProvenSummary;
  /** Metrics (cost included) whose roll-up breached their threshold. */
  readonly breaches: number;
  /** Mean passFraction across all five metrics. */
  readonly overall: number;
};

function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

/** Is this cost GradeResult the structural ∞ encoding? */
function isInfiniteCostResult(r: GradeResult): boolean {
  return !r.passed && r.score === 0;
}

export function summarizeCostPerProvenOutcome(
  results: ReadonlyArray<GradeResult>,
): CostPerProvenSummary {
  const thresholdUsd = CONTINUITY_METRIC_THRESHOLDS.costPerProvenOutcomeUsd;
  const infinite = results.filter(isInfiniteCostResult);
  const finite = results.filter((r) => !isInfiniteCostResult(r));
  const usd = finite.map((r) => r.score);
  const mean = usd.length === 0 ? 0 : usd.reduce((a, b) => a + b, 0) / usd.length;
  const passed = results.filter((r) => r.passed).length;
  return {
    name: "continuity.costPerProvenOutcome",
    thresholdUsd,
    count: results.length,
    finiteCount: finite.length,
    infiniteCount: infinite.length,
    meanUsd: mean,
    p50Usd: percentile(usd, 0.5),
    p95Usd: percentile(usd, 0.95),
    p99Usd: percentile(usd, 0.99),
    passFraction: results.length === 0 ? 0 : passed / results.length,
    thresholdBreach: infinite.length > 0 || mean > thresholdUsd,
  };
}

/**
 * Fold per-sample `GradeResult`s keyed by canonical metric name into the
 * continuity roll-up — the same `byMetric` structure
 * `summarize12MetricRubric` consumes, so report surfaces treat the two
 * rubrics identically.
 */
export function summarizeContinuityMetrics(
  byMetric: Readonly<Record<string, ReadonlyArray<GradeResult>>>,
): ContinuitySummary {
  const metrics: ContinuityMetricSummary[] = [];
  for (const spec of CONTINUITY_METRIC_SPECS) {
    if (spec.name === "continuity.costPerProvenOutcome") continue; // its own summarize below
    const results = byMetric[spec.name] ?? [];
    const scores = results.map((r) => r.score);
    const count = results.length;
    const mean = count === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / count;
    const passed = results.filter((r) => r.passed).length;
    metrics.push({
      name: spec.name,
      threshold: spec.threshold,
      higherIsBetter: spec.higherIsBetter,
      count,
      mean,
      passFraction: count === 0 ? 0 : passed / count,
      thresholdBreach: spec.higherIsBetter ? mean < spec.threshold : mean > spec.threshold,
      p50: percentile(scores, 0.5),
      p95: percentile(scores, 0.95),
      p99: percentile(scores, 0.99),
    });
  }
  const cost = summarizeCostPerProvenOutcome(byMetric["continuity.costPerProvenOutcome"] ?? []);
  const breaches = metrics.filter((m) => m.thresholdBreach).length + (cost.thresholdBreach ? 1 : 0);
  const passFractions = [...metrics.map((m) => m.passFraction), cost.passFraction];
  const overall = passFractions.reduce((a, b) => a + b, 0) / passFractions.length;
  return { metrics, cost, breaches, overall };
}

/** One line per metric — the report surface for eval summaries. */
export function renderContinuitySummaryLines(summary: ContinuitySummary): string[] {
  const lines: string[] = [];
  for (const m of summary.metrics) {
    const bound = m.higherIsBetter ? `≥${m.threshold}` : `≤${m.threshold}`;
    lines.push(
      `${m.name.padEnd(36)} n=${m.count} · mean ${m.mean.toFixed(3)} · pass ${Math.round(
        m.passFraction * m.count,
      )}/${m.count} · p50 ${m.p50.toFixed(3)} p95 ${m.p95.toFixed(3)} · ${bound}${
        m.thresholdBreach ? " BREACH" : ""
      }`,
    );
  }
  const c = summary.cost;
  lines.push(
    `${c.name.padEnd(36)} n=${c.count} · mean $${c.meanUsd.toFixed(4)}/proven (finite ${
      c.finiteCount
    }, ∞ ${c.infiniteCount}) · pass ${Math.round(c.passFraction * c.count)}/${c.count} · p50 $${c.p50Usd.toFixed(
      4,
    )} p95 $${c.p95Usd.toFixed(4)} · ≤$${c.thresholdUsd}${c.thresholdBreach ? " BREACH" : ""}`,
  );
  lines.push(
    `continuity overall: ${(summary.overall * 100).toFixed(1)}% pass · ${summary.breaches} threshold breach(es)`,
  );
  return lines;
}

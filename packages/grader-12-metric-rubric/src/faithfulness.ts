/**
 * Real deterministic factuality graders for the rubric's three generation
 * metrics — no LLM judge anywhere. The answer's claims are audited against
 * the evidence the run itself produced, using the same token-coverage
 * heuristics the continuity graders pin (`@crewhaus/claim-ledger`, which both
 * import).
 *
 *   twelve.answerFaithfulness  fraction of the answer's claims grounded in
 *                              transcript evidence (per-claim content-token
 *                              coverage ≥ {@link GROUNDING_COVERAGE});
 *                              threshold ≥0.95, higher is better.
 *   twelve.hallucinationRate   the complementary ungrounded fraction; the
 *                              score IS the rate (like continuity.reAskRate),
 *                              upper-bound ≤0.02, LOWER is better.
 *   twelve.answerRelevance     coverage of the user question's content
 *                              tokens by the answer; threshold ≥0.9.
 *
 * CLAIM — a declarative, non-question sentence of the final answer
 * (`RunResult.agentOutput`) with at least {@link MIN_CLAIM_TOKENS} content
 * tokens: the `doneClaimSentences`-style extraction minus the
 * completed-work regex, because faithfulness audits EVERY factual
 * assertion in the answer, not just completion claims.
 *
 * EVIDENCE — the union content-token set of every `tool_result` content
 * string plus every non-synthetic `user_message` text in the SAME
 * `RunResult.transcript` (synthetic runtime-injected messages are dropped,
 * so prompt scaffolding never grounds a claim). A claim with no covering
 * evidence is UNVERIFIABLE and counts as ungrounded — answering from
 * parametric memory is exactly what a faithfulness metric must flag. The
 * one exception is the vacuous case (zero evidence AND zero claims): that
 * passes with an explanatory rationale rather than manufacturing a false
 * failure.
 */
import {
  MIN_CLAIM_TOKENS,
  claimSentences,
  contentTokens,
  coverage,
  messageText,
} from "@crewhaus/claim-ledger";
import type { Grader, RunResult } from "@crewhaus/eval-grader";
import { TWELVE_METRIC_THRESHOLDS } from "./index";

// ─── Text heuristics ──────────────────────────────────────────────────────
// contentTokens/coverage/claimSentences/messageText are
// `@crewhaus/claim-ledger`'s, the one owner of the text layer
// (design/0.8.0 §4.1). This file used to inline a byte-for-byte copy of
// `@crewhaus/grader-continuity`'s versions because the watchme PR phase that
// added it could not declare the dependency edge; the edge exists now, to
// claim-ledger, and the swap was behaviour-neutral (this package's tests are
// unchanged). The continuity graders read the same functions.

export { MIN_CLAIM_TOKENS, claimSentences };

// ─── Claim extraction + evidence corpus ───────────────────────────────────

/** Fraction of a claim's content tokens the evidence corpus must contain
 *  for the claim to count as grounded (the continuity graders' 0.6
 *  "answer already existed near-verbatim" proxy, reused for grounding). */
export const GROUNDING_COVERAGE = 0.6;

/** `tool_result` payload's content string (see runtime-core's `logEvent`
 *  shape `{ toolUseId, content, isError }`), defensively. */
function toolResultText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const content = (payload as Record<string, unknown>)["content"];
  return typeof content === "string" && content.trim() !== "" ? content : null;
}

/** Union content-token set of the run's evidence corpus: tool_result
 *  contents + non-synthetic user text from the same transcript. */
function evidenceTokens(run: RunResult): Set<string> {
  const out = new Set<string>();
  const add = (text: string | null): void => {
    if (text === null) return;
    for (const token of contentTokens(text)) out.add(token);
  };
  for (const event of run.transcript) {
    if (event.kind === "tool_result") add(toolResultText(event.payload));
    else if (event.kind === "user_message") add(messageText(event.payload));
  }
  return out;
}

type ClaimAudit = {
  readonly claims: readonly string[];
  readonly grounded: number;
  readonly ungrounded: readonly string[];
  readonly evidenceSize: number;
};

function auditClaims(run: RunResult): ClaimAudit {
  const evidence = evidenceTokens(run);
  const claims = claimSentences(run.agentOutput);
  const ungrounded: string[] = [];
  let grounded = 0;
  for (const claim of claims) {
    if (coverage(contentTokens(claim), evidence) >= GROUNDING_COVERAGE) grounded += 1;
    else ungrounded.push(claim);
  }
  return { claims, grounded, ungrounded, evidenceSize: evidence.size };
}

function ungroundedNote(ungrounded: readonly string[]): string {
  if (ungrounded.length === 0) return "";
  return ` — ungrounded: ${ungrounded.map((c) => JSON.stringify(c)).join("; ")}`;
}

// ─── The graders ──────────────────────────────────────────────────────────

export const answerFaithfulness: Grader = async (_sample, run) => {
  const threshold = TWELVE_METRIC_THRESHOLDS.answerFaithfulness;
  const audit = auditClaims(run);
  if (audit.claims.length === 0) {
    return {
      passed: true,
      score: 1,
      rationale:
        audit.evidenceSize === 0
          ? "no verifiable claims in the answer and no evidence in the transcript — vacuous pass"
          : "no verifiable claims extracted from the answer (vacuously faithful)",
    };
  }
  const score = audit.grounded / audit.claims.length;
  return {
    passed: score >= threshold,
    score,
    rationale: `${audit.grounded}/${audit.claims.length} claim(s) grounded in transcript evidence (per-claim token-coverage ≥${GROUNDING_COVERAGE}; threshold ≥${threshold})${ungroundedNote(audit.ungrounded)}`,
  };
};

export const hallucinationRate: Grader = async (_sample, run) => {
  const threshold = TWELVE_METRIC_THRESHOLDS.hallucinationRate;
  const audit = auditClaims(run);
  if (audit.claims.length === 0) {
    return {
      passed: true,
      score: 0,
      rationale:
        audit.evidenceSize === 0
          ? "no verifiable claims in the answer and no evidence in the transcript — vacuous pass (rate 0)"
          : "no verifiable claims extracted from the answer — hallucination rate 0",
    };
  }
  const rate = audit.ungrounded.length / audit.claims.length;
  return {
    passed: rate <= threshold,
    score: rate,
    rationale: `${audit.ungrounded.length}/${audit.claims.length} claim(s) ungrounded in transcript evidence (upper-bound ≤${threshold})${ungroundedNote(audit.ungrounded)}`,
  };
};

export const answerRelevance: Grader = async (sample, run) => {
  const threshold = TWELVE_METRIC_THRESHOLDS.answerRelevance;
  // The dataset's `input` is the canonical question; transcript-derived
  // RunResults (watchme report) may carry an empty input, so degrade to
  // the first real user message of the same transcript.
  const question =
    sample.input.trim() !== ""
      ? sample.input
      : (run.transcript
          .filter((e) => e.kind === "user_message")
          .map((e) => messageText(e.payload))
          .find((t) => t !== null) ?? "");
  const questionTokens = contentTokens(question);
  if (questionTokens.size === 0) {
    return {
      passed: true,
      score: 1,
      rationale: "user question carries no content tokens — vacuous pass",
    };
  }
  const score = coverage(questionTokens, contentTokens(run.agentOutput));
  return {
    passed: score >= threshold,
    score,
    rationale: `answer covers ${Math.round(score * 100)}% of the question's ${questionTokens.size} content token(s) (threshold ≥${threshold})`,
  };
};

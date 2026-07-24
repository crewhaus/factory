/**
 * Real deterministic factuality graders for the rubric's three generation
 * metrics — no LLM judge anywhere. The answer's claims are audited against
 * the evidence the run itself produced, using the same token-coverage
 * heuristics the continuity graders pin (`@crewhaus/grader-continuity`).
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
import type { Grader, RunResult } from "@crewhaus/eval-grader";
import { TWELVE_METRIC_THRESHOLDS } from "./index";

// ─── Text heuristics ──────────────────────────────────────────────────────
// Verbatim mirrors of `@crewhaus/grader-continuity`'s exported
// contentTokens/coverage/sentences/isQuestion/messageText (heuristics.ts /
// artifacts.ts). This package cannot declare that workspace dependency in
// the watchme PR phase that adds this file (bun.lock is regenerated only at
// integrate time), so the heuristics are inlined byte-for-byte: swapping
// them for the `@crewhaus/grader-continuity` imports is a behavior-neutral
// follow-up once the dependency edge exists.

const STOPWORDS = new Set([
  // articles, conjunctions, prepositions
  "the",
  "and",
  "but",
  "for",
  "nor",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "about",
  "after",
  "before",
  "between",
  "through",
  "during",
  "until",
  "than",
  "then",
  // be/do/have + modals (question scaffolding, not content)
  "are",
  "was",
  "were",
  "been",
  "being",
  "does",
  "did",
  "doing",
  "has",
  "had",
  "have",
  "having",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  // pronouns + determiners
  "you",
  "your",
  "yours",
  "our",
  "ours",
  "their",
  "theirs",
  "they",
  "them",
  "she",
  "her",
  "him",
  "his",
  "its",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "any",
  "all",
  "each",
  "every",
  "some",
  "one",
  // misc glue
  "not",
  "yes",
  "also",
  "just",
  "now",
  "very",
  "please",
  "again",
  "already",
  "still",
  "too",
  "out",
  "off",
  "get",
  "got",
  "let",
  "lets",
]);

/** Lowercased alphanumeric tokens, ≥3 chars, stopwords removed. */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Fraction of `needle` tokens present in `haystack` (0 when needle empty). */
function coverage(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  let hit = 0;
  for (const t of needle) {
    if (haystack.has(t)) hit += 1;
  }
  return hit / needle.size;
}

/** Split text into sentences: newline-separated, then on `.`/`!`/`?`
 *  boundaries (the terminator stays attached, so `isQuestion` works). */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const s = part.trim();
      if (s !== "") out.push(s);
    }
  }
  return out;
}

function isQuestion(sentence: string): boolean {
  return sentence.trimEnd().endsWith("?");
}

/** Text of a `user_message`/`assistant_message` payload; null for synthetic
 *  runtime-injected messages and for tool_result-only user messages. */
function messageText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["synthetic"] === true) return null;
  const content = p["content"];
  if (typeof content === "string") return content.trim() !== "" ? content : null;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim() !== "") {
      texts.push(b["text"]);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

// ─── Claim extraction + evidence corpus ───────────────────────────────────

/** Fraction of a claim's content tokens the evidence corpus must contain
 *  for the claim to count as grounded (the continuity graders' 0.6
 *  "answer already existed near-verbatim" proxy, reused for grounding). */
export const GROUNDING_COVERAGE = 0.6;

/** Minimum content tokens for a declarative sentence to be a verifiable
 *  claim — "Done." or "Sure thing." carry nothing to fact-check. */
export const MIN_CLAIM_TOKENS = 3;

/** Declarative, non-question sentences of the answer with enough content
 *  tokens to be verifiable (see the module header's CLAIM definition). */
export function claimSentences(text: string): string[] {
  return sentences(text).filter((s) => !isQuestion(s) && contentTokens(s).size >= MIN_CLAIM_TOKENS);
}

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

/**
 * Deterministic text heuristics backing the continuity graders — NO model
 * calls anywhere (design §7.3: memory-quality evals must run offline and
 * reproducibly, exactly like the stores they measure).
 *
 * The load-bearing detection rules, pinned by tests:
 *
 * RE-ASK — a QUESTION-shaped assistant sentence (ends with `?`) whose
 * content-token set (lowercased alphanumeric tokens, ≥3 chars, stopwords
 * dropped, at least {@link MIN_QUESTION_TOKENS} tokens) is covered
 * ≥{@link REASK_COVERAGE} by an earlier user statement or by a confirmed/
 * open REQ ledger entry from an EARLIER session. Token coverage is the
 * deterministic stand-in for "the answer already exists near-verbatim": a
 * clarifying question necessarily names the thing it asks about, so a
 * question whose content words all appeared in what the user already said
 * is asking about already-supplied information.
 *
 * REQ-WORTHY — a user sentence carrying a requirement marker
 * ({@link REQ_MARKER_REGEX}: must / should / need / require / never /
 * always / ensure / make sure / don't / has-have to / want) with ≥3
 * content tokens. This mirrors what the §2.3 ledger discipline tells the
 * model to pin.
 *
 * DONE-CLAIM — a non-question assistant sentence in completed-work form
 * ({@link DONE_CLAIM_REGEX}): a first-person past-tense completion ("I
 * (have) implemented/fixed/deployed/…"), a state-of-completion assertion
 * ("X is/has been done/complete/deployed/…"), or "marked … as done".
 * Intent ("I will…", "implementing…") deliberately does not match — the
 * proof ladder never penalizes honest in-progress narration.
 */

import { contentTokens, isQuestion, sentences } from "@crewhaus/claim-ledger";
import { DONE_CLAIM_SCANNED } from "./done-claim";

/** Minimum content tokens for a question to be considered for re-ask
 *  matching — one-token questions ("Why?") carry no matchable content. */
export const MIN_QUESTION_TOKENS = 2;

/** Fraction of a question's content tokens that must already exist in a
 *  prior user statement / earlier-session REQ entry to call it a re-ask. */
export const REASK_COVERAGE = 0.6;

/** Fraction of a REQ statement's tokens a focus-ledger entry must cover
 *  (either direction) to count the statement as retained. */
export const RETENTION_COVERAGE = 0.6;

/** Fraction of a handoff cue line's tokens that session 2's first turn must
 *  contain to count as "acting on the handoff". */
export const PICKUP_CUE_COVERAGE = 0.5;

/**
 * Content tokens, coverage and the transcript sentence splitter are
 * `@crewhaus/claim-ledger`'s (design/0.8.0 §4.1): this package wrote them,
 * the faithfulness graders had copied them byte for byte, and the
 * provability gate needs the same measure, so they have one owner now and
 * are re-exported here under the names this package always exported. The
 * thresholds above were set against exactly these functions.
 */
export { contentTokens, coverage, isQuestion, sentences } from "@crewhaus/claim-ledger";

/** Question-shaped sentences of an assistant turn. */
export function questionSentences(text: string): string[] {
  return sentences(text).filter(isQuestion);
}

/** Requirement markers a user sentence must carry to be REQ-worthy. */
export const REQ_MARKER_REGEX =
  /\b(must|should|need(?:s|ed)?|require[sd]?|never|always|ensure|make sure|don't|do not|has to|have to|want)\b/i;

/** REQ-worthy sentences of a user message (see the module header). */
export function reqWorthySentences(text: string): string[] {
  return sentences(text).filter(
    (s) => REQ_MARKER_REGEX.test(s) && contentTokens(s).size >= 3 && !isQuestion(s),
  );
}

/**
 * Past-tense completed-work claims (see the module header): the pattern in
 * done-claim.ts, as a RegExp with that source whose `exec` is a scan, since
 * the engine is quadratic in a sentence of `marked`.
 */
export const DONE_CLAIM_REGEX: RegExp = DONE_CLAIM_SCANNED;

/** Non-question assistant sentences that claim completed work. */
export function doneClaimSentences(text: string): string[] {
  return sentences(text).filter((s) => !isQuestion(s) && DONE_CLAIM_REGEX.test(s));
}

/** Lowercase + collapse whitespace, for verbatim-containment checks
 *  (evicted `context_evicted` records carry the message verbatim). */
export function normalizeVerbatim(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

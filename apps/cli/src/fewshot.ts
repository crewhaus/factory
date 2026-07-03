/**
 * Item #54 — harvest up-rated turns into a golden few-shot pool.
 *
 * `crewhaus fewshot harvest` mines POSITIVELY-rated conversation turns (the
 * same `user_feedback` ratings `distill` consumes) into a curated pool of
 * input→good-output few-shot examples. The pool is a versioned, provenance-
 * tagged JSONL under `.crewhaus/fewshot/<spec>.jsonl`; `crewhaus optimize
 * --few-shot <file>` injects the top-K examples into the agent prompt as
 * in-context demonstrations, and `agent.instructions` can carry them at
 * compile time via `formatFewShotForPrompt`.
 *
 * Everything here is pure + deterministic (stable ordering, id-based dedupe)
 * so it is unit-testable; all filesystem access + the model/redactor wiring
 * lives in `apps/cli/src/index.ts` (mirrors `feedback.ts` / `dataset-mine.ts`).
 * The harvested OUTPUT text is the rated assistant answer (or the user's
 * correction), so it is PII/secret-redacted before it lands in the pool: the
 * caller threads a redactor built from `SYNTHESIZE_PII_DETECTORS` (the shared
 * secret/API-key + DEFAULT_PII detector set) so a pasted credential never
 * survives into the pool or the optimizer meta-prompt.
 */

import { mergeFeedback, normalizeRating } from "./feedback";
import type { FeedbackRecord, SessionTurn } from "./feedback";

/** Schema version of a persisted few-shot pool line. */
export const FEWSHOT_SCHEMA_VERSION = 1 as const;

/** One curated few-shot example: an input paired with a known-good output. */
export type FewShotExample = {
  readonly schemaVersion: 1;
  /** Stable id: `${sessionId}_t${turnNumber}` — the join key, dedupes reruns. */
  readonly id: string;
  readonly input: string;
  readonly output: string;
  /** [0,1] normalized rating that qualified this turn (or 1 for a correction). */
  readonly score: number;
  /** Provenance for audit + optimizer trust. */
  readonly provenance: {
    readonly sessionId: string;
    readonly turnNumber: number;
    /** "rating" (up-rated answer) | "correction" (user-supplied better answer). */
    readonly source: "rating" | "correction";
    readonly rater?: string;
  };
};

export type HarvestOptions = {
  /** Normalized score at/above which a rated turn qualifies. Default 0.7. */
  readonly minScore?: number;
  /** Async redactor applied to the harvested OUTPUT (and correction). The CLI
   *  passes a `SYNTHESIZE_PII_DETECTORS`-backed redactor; tests pass a stub. */
  readonly redact?: (text: string) => Promise<string>;
};

export type HarvestStats = {
  readonly totalFeedback: number;
  readonly qualified: number;
  readonly skippedUnmatched: number;
  readonly skippedEmpty: number;
};

export type HarvestResult = {
  readonly examples: FewShotExample[];
  readonly stats: HarvestStats;
};

function turnKey(sessionId: string, turnNumber: number): string {
  return `${sessionId}#${turnNumber}`;
}

/**
 * Harvest positively-rated turns into few-shot examples. A turn qualifies when
 * its merged rating normalizes to ≥ `minScore`, OR it carries a `correction`
 * (the user's own better answer — always gold). The example OUTPUT is the
 * correction when present, else the assistant's answer; empty answers are
 * skipped. Deterministic: examples are sorted by (score desc, id asc) and
 * deduped by id, so re-harvesting the same feedback is idempotent.
 */
export async function harvestFewShot(
  turns: ReadonlyArray<SessionTurn>,
  feedback: ReadonlyArray<FeedbackRecord>,
  opts: HarvestOptions = {},
): Promise<HarvestResult> {
  const minScore = opts.minScore ?? 0.7;
  const redact = opts.redact ?? (async (t: string) => t);
  const turnByKey = new Map<string, SessionTurn>();
  for (const t of turns) turnByKey.set(turnKey(t.sessionId, t.turnNumber), t);

  const merged = mergeFeedback(feedback);
  const byId = new Map<string, FewShotExample>();
  let qualified = 0;
  let skippedUnmatched = 0;
  let skippedEmpty = 0;

  for (const fb of merged) {
    const turn = turnByKey.get(turnKey(fb.sessionId, fb.turnNumber));
    if (turn === undefined) {
      skippedUnmatched += 1;
      continue;
    }
    const score = normalizeRating(fb);
    const isCorrection = fb.correction !== undefined && fb.correction.trim() !== "";
    const isPositive = (score !== undefined && score >= minScore) || isCorrection;
    if (!isPositive) continue;

    const rawOutput = isCorrection ? (fb.correction as string) : turn.output;
    if (rawOutput.trim() === "") {
      skippedEmpty += 1;
      continue;
    }
    const input = await redact(turn.input);
    const output = await redact(rawOutput);
    if (output.trim() === "") {
      skippedEmpty += 1;
      continue;
    }
    qualified += 1;
    const id = `${fb.sessionId}_t${fb.turnNumber}`;
    byId.set(id, {
      schemaVersion: FEWSHOT_SCHEMA_VERSION,
      id,
      input,
      output,
      score: isCorrection ? 1 : (score ?? 1),
      provenance: {
        sessionId: fb.sessionId,
        turnNumber: fb.turnNumber,
        source: isCorrection ? "correction" : "rating",
        ...(fb.rater !== undefined ? { rater: fb.rater } : {}),
      },
    });
  }

  const examples = [...byId.values()].sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    examples,
    stats: {
      totalFeedback: merged.length,
      qualified,
      skippedUnmatched,
      skippedEmpty,
    },
  };
}

/** Narrow an arbitrary parsed JSON value to a persisted FewShotExample. */
export function isFewShotExample(value: unknown): value is FewShotExample {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== 1) return false;
  if (typeof v["id"] !== "string") return false;
  if (typeof v["input"] !== "string" || typeof v["output"] !== "string") return false;
  if (typeof v["score"] !== "number" || !Number.isFinite(v["score"])) return false;
  const p = v["provenance"];
  if (typeof p !== "object" || p === null) return false;
  const pr = p as Record<string, unknown>;
  return typeof pr["sessionId"] === "string" && typeof pr["turnNumber"] === "number";
}

/**
 * Merge a freshly-harvested pool into an existing one, deduping by id (the
 * newer example wins so re-runs refresh outputs without duplicating). Returns
 * the deterministically-ordered union.
 */
export function mergePools(
  existing: ReadonlyArray<FewShotExample>,
  fresh: ReadonlyArray<FewShotExample>,
): FewShotExample[] {
  const byId = new Map<string, FewShotExample>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of fresh) byId.set(e.id, e);
  return [...byId.values()].sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Serialize a pool to JSONL (one example per line). */
export function poolToJsonl(examples: ReadonlyArray<FewShotExample>): string {
  return `${examples.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

const FEWSHOT_CLOSE_TAG_RE = /<\s*\/\s*few_shot_examples\s*>/gi;

/**
 * #54 F5 — delimiter safety. An example's input/output is user/model text and
 * can be adversarially shaped, so before interpolating it into the
 * `<few_shot_examples>` block we neutralize any embedded closing tag: a
 * `</few_shot_examples>` inside an example would otherwise let a poisoned
 * example terminate the block early and inject trailing instructions. The
 * closing tag is rewritten to an inert `<\/few_shot_examples>` (content
 * preserved for the model, but no longer parses as the real delimiter).
 * Redaction of secrets/PII already runs upstream — this is purely structural.
 */
function escapeFewShotContent(text: string): string {
  return text.replace(FEWSHOT_CLOSE_TAG_RE, "<\\/few_shot_examples>");
}

/**
 * Render the top-K examples as an in-context few-shot block for the system
 * prompt / `agent.instructions`. Empty input → "" so callers append
 * unconditionally. `k` caps how many examples are injected (default 5).
 */
export function formatFewShotForPrompt(examples: ReadonlyArray<FewShotExample>, k = 5): string {
  const top = examples.slice(0, Math.max(0, k));
  if (top.length === 0) return "";
  const blocks = top
    .map(
      (e, i) =>
        `Example ${i + 1}:\nUser: ${escapeFewShotContent(e.input)}\nAssistant: ${escapeFewShotContent(
          e.output,
        )}`,
    )
    .join("\n\n");
  return `<few_shot_examples>\nThese are examples of responses users rated highly. Follow their style and quality:\n\n${blocks}\n</few_shot_examples>`;
}

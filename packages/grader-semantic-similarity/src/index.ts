import type { Embedder } from "@crewhaus/embedder";
import { GraderError } from "@crewhaus/eval-grader";
import type { GradeResult, Grader, RunResult, Sample } from "@crewhaus/eval-grader";
import { rougeL } from "@crewhaus/grader-nlg-metrics";

/**
 * Catalog R15 `grader-semantic-similarity` — Section 38 embedding-cosine
 * grader.
 *
 * Computes cosine similarity between the agent output and the
 * sample's `expected_output` using a caller-supplied §21 embedder
 * (mock for tests; OpenAI / Voyage / Cohere / local in production).
 *
 * Fallback semantics: if the supplied embedder throws on `embed()`
 * (e.g. missing API key, transient network error), the grader falls
 * back to a `rougeL` score so the eval run does not abort. Set
 * `disableFallback: true` to surface the embedder error instead.
 *
 * Threshold gates pass/fail: `score >= threshold ⇒ passed`.
 *
 * Layer R15. Pairs with `embedder` (§21 — embedder providers) and
 * `grader-nlg-metrics` (§38 — fallback path).
 */

export type SemanticSimilarityOptions = {
  /** Caller-supplied embedder. Required. */
  readonly embedder: Embedder;
  /** 0..1 pass/fail boundary. Default 0.7 — tune for production. */
  readonly threshold?: number;
  /** Override the per-call reference (else falls back to `sample.expected_output`). */
  readonly reference?: string;
  /**
   * When true (default false), do NOT fall back to ROUGE-L if the
   * embedder errors. Production ops sometimes prefer fail-loud over
   * silent degradation to a weaker metric.
   */
  readonly disableFallback?: boolean;
  /** ROUGE-L threshold used by the fallback grader. Default 0.5. */
  readonly fallbackThreshold?: number;
};

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_FALLBACK_THRESHOLD = 0.5;

/**
 * NEW-HUNT-5 — the stable rationale marker every ROUGE-L-fallback grade
 * starts with (`${PREFIX}<embedder error>] <rougeL rationale>`). Exported
 * as the DETECTION CONTRACT: the eval-runner scans per-grader rationales
 * for this prefix to count fallback-graded samples and emit the run-level
 * `[eval] warning:` line, so a run silently swapping its instrument
 * mid-flight is visible at run level, not only sample by sample. Do not
 * reword without updating that consumer (it pins equality in tests).
 */
export const SEMANTIC_FALLBACK_RATIONALE_PREFIX = "[fallback ROUGE-L; embedder error: ";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new GraderError(`cosineSimilarity: vector dim mismatch ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function resolveReference(
  opts: Pick<SemanticSimilarityOptions, "reference">,
  sample: Sample,
): string {
  const ref = opts.reference ?? sample.expected_output;
  if (typeof ref !== "string" || ref.length === 0) {
    throw new GraderError(
      `${opts.reference !== undefined ? "options.reference" : "sample.expected_output"} is required`,
    );
  }
  return ref;
}

export function semanticSimilarity(opts: SemanticSimilarityOptions): Grader {
  if (opts.embedder === undefined || typeof opts.embedder.embed !== "function") {
    throw new GraderError("semanticSimilarity requires an `embedder` with embed() method");
  }
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const fallbackThreshold = opts.fallbackThreshold ?? DEFAULT_FALLBACK_THRESHOLD;
  const fallback = rougeL({ threshold: fallbackThreshold });

  return async (sample: Sample, runResult: RunResult): Promise<GradeResult> => {
    const reference = resolveReference(opts, sample);
    let vectors: number[][];
    try {
      vectors = await opts.embedder.embed([reference, runResult.agentOutput]);
    } catch (err) {
      if (opts.disableFallback === true) {
        throw new GraderError(
          `semanticSimilarity embedder failed: ${(err as Error).message ?? String(err)}`,
          err,
        );
      }
      // Fallback: use ROUGE-L. Mark the rationale clearly so analysts
      // see when the embedder dropped out.
      const fb = await fallback(sample, runResult);
      return {
        passed: fb.passed,
        score: fb.score,
        rationale: `${SEMANTIC_FALLBACK_RATIONALE_PREFIX}${(err as Error).message ?? "unknown"}] ${fb.rationale}`,
      };
    }
    const refVec = vectors[0];
    const hypVec = vectors[1];
    if (refVec === undefined || hypVec === undefined) {
      throw new GraderError(
        `semanticSimilarity embedder returned ${vectors.length} vectors; expected 2`,
      );
    }
    const score = cosineSimilarity(refVec, hypVec);
    // Cosine ranges in [-1, 1]; clamp to [0, 1] for the grader's score
    // contract (the GradeResult score field is documented as 0..1).
    const clampedScore = Math.max(0, score);
    return {
      passed: clampedScore >= threshold,
      score: clampedScore,
      rationale: `cosine ${score.toFixed(4)} (threshold ${threshold.toFixed(2)}, model ${opts.embedder.model})`,
    };
  };
}

export {
  cosineSimilarity as _cosineSimilarityForTest,
  resolveReference as _resolveReferenceForTest,
};

/**
 * Catalog R8 (sink-side, FR-006) `egress-matcher-semantic` — an optional,
 * embedding-backed implementation of `@crewhaus/egress-classifier`'s
 * `EgressMatcher` interface.
 *
 * WHY THIS EXISTS. The default `SubstringEgressMatcher` is a tripwire: it
 * catches verbatim / near-verbatim leakage of tagged data-lineage but is
 * evaded by paraphrase or base64/translation re-encoding before a payload
 * leaves. This matcher scores the outbound payload against each tagged
 * lineage entry by embedding-cosine, so semantically-equivalent leakage
 * registers as a hit even when no substring overlaps.
 *
 * WHAT IT DOES NOT CHANGE. The whitepaper's egress promise is about
 * *placement*, not the matcher: the check is wired from the IR for every
 * external sink, and the per-origin/per-sink policy + the three audit
 * outcomes (`egress-passed | egress-warned | egress-blocked`) live in
 * `classifyEgress`, not here. This matcher returns ONLY raw `{ originsFound,
 * matchCount }` hits — it never computes a verdict. Swapping it in changes
 * detection quality and nothing else.
 *
 * OPTIONAL-DEPENDENCY POSTURE (acceptance #4). The default egress path —
 * `classifyEgress` with no `matcher`, and `runChatLoop` with no
 * `egressMatcher` — never imports this package. `substringMatcher` is the
 * built-in default in `egress-classifier`. This package is loaded only when
 * a spec/runtime explicitly opts in, so the default path gains zero new
 * dependencies. The embedding backend is *injected* (an `@crewhaus/embedder`
 * `Embedder`), mirroring `grader-semantic-similarity`: production passes a
 * real provider; tests pass the deterministic `mock/` embedder, so CI makes
 * no live API calls.
 *
 * SAFE FALLBACK. A misconfigured or transiently-failing embedder must not
 * fail the egress check open *or* closed unpredictably. If `embedder.embed`
 * throws, this matcher falls back to the substring matcher
 * (`substringMatcher` from `egress-classifier`) so detection degrades to the
 * built-in tripwire rather than disappearing. Set `disableFallback: true`
 * to surface the embedder error instead.
 *
 * Layer R8 (sink side). Pairs with `egress-classifier` (the seam + the
 * default matcher + the policy fold) and `embedder` (§21 providers).
 */

import {
  type EgressMatchInput,
  type EgressMatchResult,
  type EgressMatcher,
  substringMatcher,
} from "@crewhaus/egress-classifier";
import type { Embedder } from "@crewhaus/embedder";
import { CrewhausError } from "@crewhaus/errors";
import type { TrustOrigin } from "@crewhaus/run-context";

export class EgressMatcherSemanticError extends CrewhausError {
  override readonly name = "EgressMatcherSemanticError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for empty or
 * zero-norm inputs. (Kept local to avoid a cross-dependency on the grader
 * package; identical contract to `grader-semantic-similarity`'s helper.)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EgressMatcherSemanticError(
      `cosineSimilarity: vector dim mismatch ${a.length} vs ${b.length}`,
    );
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

/** Default cosine threshold above which a tagged entry counts as a hit. */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.82;

/** Embedder batch cap — mirrors `embedder`'s 100-texts-per-call limit. */
const EMBED_BATCH_CAP = 100;

export type SemanticEgressMatcherOptions = {
  /**
   * Caller-supplied §21 embedder. Required. Tests pass
   * `createEmbedder({ model: "mock/..." })` (deterministic, no network);
   * production passes an OpenAI/Voyage/Cohere/local provider.
   */
  readonly embedder: Embedder;
  /**
   * Cosine boundary in [-1, 1]. A tagged lineage entry counts as a hit when
   * `cosine(payload, tagged) >= threshold`. Default
   * `DEFAULT_SEMANTIC_THRESHOLD` (0.82) — this is a reference seam, not a
   * production-tuned model, so tune per corpus.
   */
  readonly threshold?: number;
  /**
   * When true (default false), do NOT fall back to substring matching if
   * the embedder throws — surface the error instead. Ops that prefer
   * fail-loud over silent degradation to the weaker matcher set this.
   */
  readonly disableFallback?: boolean;
};

/**
 * An `EgressMatcher` that scores the outbound payload against each tagged
 * lineage entry by embedding-cosine. `name` is `"semantic"` for audit /
 * cache namespacing.
 */
export class SemanticEgressMatcher implements EgressMatcher {
  readonly name = "semantic";
  private readonly embedder: Embedder;
  private readonly threshold: number;
  private readonly disableFallback: boolean;

  constructor(opts: SemanticEgressMatcherOptions) {
    if (opts.embedder === undefined || typeof opts.embedder.embed !== "function") {
      throw new EgressMatcherSemanticError(
        "SemanticEgressMatcher requires an `embedder` with an embed() method",
      );
    }
    this.embedder = opts.embedder;
    this.threshold = opts.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
    this.disableFallback = opts.disableFallback ?? false;
  }

  async match(input: EgressMatchInput): Promise<EgressMatchResult> {
    // Preserve the floor contract: tagged entries shorter than the floor
    // are never candidates (same as the substring matcher).
    const candidates: Array<{ tagged: string; origin: TrustOrigin }> = [];
    for (const [tagged, origin] of input.lineage.entries()) {
      if (tagged.length < input.minMatchLength) continue;
      candidates.push({ tagged, origin });
    }
    if (candidates.length === 0) {
      return { originsFound: [], matchCount: 0 };
    }

    // Embed the payload + every candidate in one (batched) call. Index 0 is
    // the payload; 1..n align with `candidates`.
    let vectors: number[][];
    try {
      vectors = await this.embedder.embed([input.payload, ...candidates.map((c) => c.tagged)], {
        batchSize: EMBED_BATCH_CAP,
      });
    } catch (err) {
      if (this.disableFallback) {
        throw new EgressMatcherSemanticError(
          `semantic egress matcher embedder failed: ${(err as Error)?.message ?? String(err)}`,
          err,
        );
      }
      // Degrade to the built-in tripwire rather than dropping the check.
      return substringMatcher.match(input);
    }

    const payloadVec = vectors[0];
    if (payloadVec === undefined) {
      // Defensive: an embedder that returns too few vectors is a config
      // error, not an attack — fall back unless told to fail loud.
      if (this.disableFallback) {
        throw new EgressMatcherSemanticError(
          `semantic egress matcher embedder returned ${vectors.length} vectors; expected ${candidates.length + 1}`,
        );
      }
      return substringMatcher.match(input);
    }

    const seen = new Set<TrustOrigin>();
    let matchCount = 0;
    for (let i = 0; i < candidates.length; i++) {
      const candVec = vectors[i + 1];
      const candidate = candidates[i];
      if (candVec === undefined || candidate === undefined) continue;
      const score = cosineSimilarity(payloadVec, candVec);
      if (score >= this.threshold) {
        seen.add(candidate.origin);
        matchCount += 1;
      }
    }
    return { originsFound: [...seen], matchCount };
  }
}

/**
 * Convenience factory mirroring the codebase's `create*` ergonomics.
 * Equivalent to `new SemanticEgressMatcher(opts)`.
 */
export function createSemanticEgressMatcher(opts: SemanticEgressMatcherOptions): EgressMatcher {
  return new SemanticEgressMatcher(opts);
}

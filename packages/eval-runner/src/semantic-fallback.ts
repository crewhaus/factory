/**
 * NEW-HUNT-5 — run-level surfacing of the `semantic.similarity` ROUGE-L
 * fallback. The pack degrades PER SAMPLE when its embedder errors (quota,
 * network, missing key): the grade silently becomes a ROUGE-L verdict at a
 * different threshold, marked only by a rationale prefix an analyst has to
 * notice sample by sample. That is an instrument swap mid-run — report
 * principle 6 says reference-similarity metrics are trend instruments, so
 * the swap must be loud at RUN level:
 *
 *   - `aggregate()` counts fallback-graded samples into the additive
 *     `EvalAggregates.semanticFallback` block (results.json), and
 *   - `runEval` / `createExamRunner` print the `[eval] warning:` line below
 *     on stderr — the runner is the shared seam, so `crewhaus eval`,
 *     compiled target-eval bundles, and spec-declared exams all inherit it
 *     without per-surface wiring.
 *
 * Detection contract: `@crewhaus/grader-semantic-similarity` exports the
 * same prefix as `SEMANTIC_FALLBACK_RATIONALE_PREFIX`; the constant is
 * DUPLICATED here (equality pinned by test) so this module keeps the
 * runner's lazy-import posture — grader packs load only when a registry
 * actually resolves them, never on plain `@crewhaus/eval-runner` import.
 * The YAML escape hatch is `opts: { disableFallback: true }` on the
 * graders.yaml entry (NEW-HUNT-7), which turns embedder errors into loud
 * grader failures instead.
 */
import type { SampleResult } from "./types";

/** Must stay byte-identical to the pack's
 *  `SEMANTIC_FALLBACK_RATIONALE_PREFIX` (see module doc). */
export const SEMANTIC_FALLBACK_RATIONALE_PREFIX = "[fallback ROUGE-L; embedder error: ";

/**
 * The additive `EvalAggregates.semanticFallback` block: which samples were
 * graded by the ROUGE-L fallback instead of embedding cosine, and the first
 * embedder error observed (failures are typically identical across samples
 * — one bad key errors every call the same way).
 */
export type SemanticFallbackSummary = {
  readonly sampleCount: number;
  readonly sampleIds: ReadonlyArray<string>;
  readonly embedderError: string;
};

/** Extract the embedder error message from a fallback-marked rationale
 *  (`${PREFIX}<error>] <rougeL rationale>`). */
function embedderErrorFromRationale(rationale: string): string {
  const rest = rationale.slice(SEMANTIC_FALLBACK_RATIONALE_PREFIX.length);
  const end = rest.lastIndexOf("] ");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Scan the canonical per-grader grades for the fallback rationale marker.
 * Returns undefined when no sample fell back, so fallback-free runs keep a
 * byte-identical results.json.
 */
export function detectSemanticFallback(
  samples: ReadonlyArray<SampleResult>,
): SemanticFallbackSummary | undefined {
  const sampleIds: string[] = [];
  let embedderError: string | undefined;
  for (const s of samples) {
    const hit = s.grades.perGrader.find((g) =>
      g.rationale.startsWith(SEMANTIC_FALLBACK_RATIONALE_PREFIX),
    );
    if (hit === undefined) continue;
    sampleIds.push(s.sampleId);
    embedderError ??= embedderErrorFromRationale(hit.rationale);
  }
  if (sampleIds.length === 0) return undefined;
  return { sampleCount: sampleIds.length, sampleIds, embedderError: embedderError ?? "unknown" };
}

/**
 * The run-level warning line (the `[eval] warning:` grammar eval-history's
 * instrument warnings use). Written straight to stderr by the runner —
 * this is user-facing measurement-trust output, not logger diagnostics, and
 * it must look the same from the CLI, a compiled bundle, and an exam.
 */
export function formatSemanticFallbackWarning(fb: SemanticFallbackSummary): string {
  return `[eval] warning: ${fb.sampleCount} sample(s) graded by ROUGE-L fallback, not semantic.similarity (embedder error: ${fb.embedderError}) — samples: ${fb.sampleIds.join(", ")}. Scores are not comparable with embedder-graded runs; set opts: { disableFallback: true } on the graders.yaml entry to fail loudly instead.`;
}

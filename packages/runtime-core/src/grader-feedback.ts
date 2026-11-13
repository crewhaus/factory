/**
 * Pillar 3 — a grader's or judge's text about to reach a model: the in-loop
 * evaluation's correction or rationale, and the feedback a workflow step or
 * graph node gets when its judge gate sends it back. That text is model
 * output from a side call that read the (possibly injected) answer it graded,
 * so it crosses the same boundary as a consult reply: it is classified at
 * TrustOrigin `consult`, and lineage-tagged when admitted.
 *
 * - `admitted`: the trimmed text, tagged `consult` on the run.
 * - `blocked`: the classifier redacted it; the caller carries the score alone
 *   and never falls back to the same text another way. The rule ids are
 *   logged, never the text.
 * - `empty`: there was nothing to admit.
 */
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { type RunContext, tagContent } from "@crewhaus/run-context";

export type AdmittedJudgeFeedback =
  | { readonly kind: "admitted"; readonly text: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "empty" };

/** Classify a grader's or judge's text at `consult` before it reaches a model. */
export async function admitJudgeFeedback(
  runContext: RunContext,
  text: string | undefined,
  field: string,
): Promise<AdmittedJudgeFeedback> {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) return { kind: "empty" };
  const boundary = await classifyBoundary(trimmed, { origin: "consult" });
  if (boundary.action === "redact") {
    runContext.logger.warn(
      "evaluation: grader text blocked at the transcript boundary — nudging with the score alone",
      { field, rules: [...new Set(boundary.verdict.hits.map((h) => h.rule))] },
    );
    return { kind: "blocked" };
  }
  tagContent(runContext, trimmed, "consult");
  return { kind: "admitted", text: trimmed };
}

/**
 * The state a node retried by its judge gate reads as its upstream state:
 * `state` with the `rationale` left out of each named judge's
 * `<judge>_judge` record (verdict, score and retries stay). The node gets
 * that judge's feedback only through {@link admitJudgeFeedback}, so the
 * screened text is the one copy it reads. Pure: `state` is not changed.
 */
export function withoutJudgeRationale(
  state: unknown,
  judges: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> =
    state !== null && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
  for (const judge of judges) {
    const key = `${judge}_judge`;
    const rec = out[key];
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      if (k !== "rationale") kept[k] = v;
    }
    out[key] = kept;
  }
  return out;
}

/**
 * A1 — `crewhaus eval-report diff --pairwise` orchestration: the CLI-side
 * composition of `@crewhaus/eval-judge`'s order-swapped pairwise judge
 * (`judgePairwise` — two calls per sample, fresh sentinels, strict verdict
 * schema) with `@crewhaus/eval-report`'s pure bookkeeping
 * (`summarizePairwise`, `extractSampleInput`). Lives in its own module so
 * the credential gate and the judging loop are unit-testable with an
 * injected stub adapter — `index.ts` only parses flags and wires.
 *
 * Opt-in by design: pairwise judging burns judge-model calls (2 × shared
 * samples), so it requires visible judge credentials and dies with a clear
 * message without them — the offline deterministic diff stays the default.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { DEFAULT_JUDGE_MODEL, judgePairwise } from "@crewhaus/eval-judge";
import {
  type LoadedRun,
  type PairwiseDiff,
  type PairwiseSampleVerdict,
  extractSampleInput,
  summarizePairwise,
} from "@crewhaus/eval-report";
import { providerCredentialsSatisfied } from "./doctor-checks";

/** `--judge-model` wins; absent/empty falls back to the default judge. */
export function resolvePairwiseJudgeModel(flagValue: unknown): string {
  return typeof flagValue === "string" && flagValue !== "" ? flagValue : DEFAULT_JUDGE_MODEL;
}

/**
 * The opt-in gate: pairwise judging needs a judge it can actually call.
 * Returns the die-message when the judge model's provider credentials are
 * not visibly satisfied (shares `providerCredentialsSatisfied` with
 * `crewhaus doctor`, so the two never disagree), undefined when good to go.
 */
export function pairwiseCredentialError(
  judgeModel: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (providerCredentialsSatisfied(judgeModel, env)) return undefined;
  return `eval-report diff --pairwise needs judge credentials, and none are visible for judge model "${judgeModel}". Set the provider's API key (e.g. ANTHROPIC_API_KEY) or pass --judge-model <model> for a provider you have credentials for. Without --pairwise the diff stays fully offline and deterministic.`;
}

export type JudgeRunsPairwiseOptions = {
  readonly judgeModel: string;
  /** Test seam — injected stub adapter; omitted ⇒ model-router resolution. */
  readonly adapter?: ProviderAdapter;
};

/**
 * Judge every SHARED sample id head-to-head: prev run's output vs new
 * run's output, twice with the order swapped (fresh sentinels each call).
 * Samples errored on either side are skipped (no output to compare) and
 * counted in `skippedErrored`. Judging order is the sorted shared-id list
 * and results keep it — deterministic ordering, no randomness in the
 * bookkeeping (the judge calls themselves are the only nondeterminism).
 */
export async function judgeRunsPairwise(
  prev: LoadedRun,
  next: LoadedRun,
  opts: JudgeRunsPairwiseOptions,
): Promise<PairwiseDiff> {
  const prevById = new Map(prev.summary.samples.map((s) => [s.sampleId, s]));
  const nextById = new Map(next.summary.samples.map((s) => [s.sampleId, s]));
  const sharedIds = [...prevById.keys()].filter((id) => nextById.has(id)).sort();

  const verdicts: PairwiseSampleVerdict[] = [];
  let skippedErrored = 0;
  for (const sampleId of sharedIds) {
    const p = prevById.get(sampleId);
    const n = nextById.get(sampleId);
    if (p === undefined || n === undefined) continue; // unreachable — shared ids
    if (p.error !== undefined || n.error !== undefined) {
      skippedErrored += 1;
      continue;
    }
    const input =
      extractSampleInput(prev, sampleId) ??
      extractSampleInput(next, sampleId) ??
      "(input unavailable — sample transcript missing; judge the outputs on their own merits)";
    const comparison = await judgePairwise({
      input,
      prevOutput: p.agentOutput,
      newOutput: n.agentOutput,
      model: opts.judgeModel,
      ...(opts.adapter !== undefined ? { adapter: opts.adapter } : {}),
    });
    verdicts.push({
      sampleId,
      prevFirst: comparison.prevFirst,
      newFirst: comparison.newFirst,
      agreed: comparison.agreed,
      verdict: comparison.verdict,
    });
  }
  return summarizePairwise(opts.judgeModel, verdicts, { skippedErrored });
}

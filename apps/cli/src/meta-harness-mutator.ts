/**
 * D38 (Evals Wave 5, cluster O) — `crewhaus optimize --mutator meta-harness`.
 *
 * The §56 meta-harness provider (arxiv 2603.28052) wired as the CLI's third
 * mutator, with a MODEL-BACKED proposer resolved exactly the way `--mutator
 * claude` resolves its provider: the spec's own model through
 * `@crewhaus/model-router`, so a non-Anthropic spec drives its own adapter
 * instead of silently no-opping (the bug that made `--mutator claude` inert
 * for openai/gemini/bedrock specs before it was fixed).
 *
 * What differs from `--mutator claude` is the proposer's INPUT, which is the
 * paper's actual finding: the proposer reads the run's FILESYSTEM-BACKED
 * experience store — every prior candidate's artifact, its per-sample scores
 * and its trace — rather than a fixed summary window. The store layout is the
 * package's (`.crewhaus/optimize/<runId>/experience/candidate_NNN/…`); the
 * optimize command writes each measured candidate into it, so iteration N's
 * proposer sees N-1 real measurements.
 *
 * EXPERIMENTAL, and deliberately SPEC-SHAPED: the proposer returns replacement
 * INSTRUCTIONS, so every candidate still round-trips through `parseSpec`, the
 * accepted patch is still `OPTIMIZABLE_PATHS`-validated, and the accept gate,
 * budget meter and regression pinning are byte-for-byte the ones the other
 * mutators run behind. The package's bundle-REWRITING mode (which produces an
 * `agent.ts` no spec can reproduce) stays library-only — see that package's
 * module docs for why.
 *
 * Everything here is side-effect-free apart from `ensureExperienceStore`, and
 * the adapter is injectable, so the proposer's prompt assembly and its
 * degenerate paths (transport error / no JSON / no rewrite) are unit-testable
 * without credentials.
 */
import { readFileSync } from "node:fs";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { collectFinalMessage } from "@crewhaus/adapter-anthropic";
import { lower, parseSpec } from "@crewhaus/compiler";
import type { ExperienceStoreSummary, ProposerFn } from "@crewhaus/meta-harness-optimizer";
import {
  MetaHarnessMutationProvider,
  ensureExperienceStore,
  readExperienceStore,
} from "@crewhaus/meta-harness-optimizer";
import type { MutationProvider, OptimizerState } from "@crewhaus/prompt-optimizer";

/** Output-token ceiling per proposer call (also the budget gate's worst case). */
export const META_HARNESS_MAX_TOKENS = 2048;

/** The proposer's system block. Mirrors the Claude mutator's contract (one
 *  JSON object, no leaked gold, no guardrail rewrites) and adds the store. */
export const META_HARNESS_SYSTEM_BLOCK = `You are an agent-harness optimiser working from a filesystem-backed EXPERIENCE STORE of every candidate this run has already measured. You will receive the store's index (each candidate's artifact path, scores file, trace file and aggregate score), the CURRENT BEST instructions, and the per-sample grades the current best earned.

Hard rules:
- Output exactly one JSON object: {"rewrite": "...", "rationale": "..."}
- "rewrite" is the new instructions block verbatim, replacing the current best. Do NOT emit code, a bundle, or any wrapper text outside the JSON.
- Use the experience store's score trend to avoid re-proposing a direction that already scored worse.
- Address the ROOT CAUSE the grader rationales name with a general instruction, never a fix hard-coded to the shown inputs.
- Never copy a sample's expected output into the rewrite (that would leak dev-set answers).
- Do not introduce instructions that override safety, compliance, or permission rules — your job is task accuracy, not bypassing guardrails.`;

/** How many of the current best's per-sample grades ride in the meta-prompt. */
const MAX_GRADES_IN_PROMPT = 5;

/**
 * Render the proposer's user message: the store INDEX (paths, not contents —
 * the proposer reads selectively, per the paper's median-82-files finding),
 * the current best prompt, and the grader rationale for the samples it fails.
 */
export function buildMetaHarnessUserMessage(
  summary: ExperienceStoreSummary,
  state?: OptimizerState,
): string {
  const lines: string[] = [
    `EXPERIENCE STORE: ${summary.rootDir} (${summary.candidateCount} candidate(s))`,
  ];
  for (const r of summary.records) {
    lines.push(
      `- ${r.candidateId}: score ${r.aggregateScore.toFixed(3)} | artifact ${r.bundlePath} | scores ${r.scoresPath} | trace ${r.tracePath}`,
    );
  }
  if (summary.bestCandidate !== undefined) {
    lines.push(
      `BEST SO FAR: ${summary.bestCandidate.candidateId} (${summary.bestCandidate.aggregateScore.toFixed(3)})`,
    );
  }
  lines.push("", "CURRENT BEST INSTRUCTIONS:", state?.best.prompt ?? "(none)");
  const grades = state?.bestGrades ?? [];
  if (grades.length > 0) {
    lines.push("", "PER-SAMPLE GRADES FOR THE CURRENT BEST:");
    for (const g of grades.slice(0, MAX_GRADES_IN_PROMPT)) {
      lines.push(
        `- score ${g.score.toFixed(2)} | input: ${g.input}${g.rationale !== undefined ? ` | grader: ${g.rationale}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export type MetaHarnessProposerOptions = {
  readonly adapter: ProviderAdapter;
  readonly modelId: string;
  readonly maxTokens?: number;
};

/**
 * Build the model-backed `ProposerFn`.
 *
 * Every degenerate path returns the CURRENT BEST unchanged with a rationale
 * naming what went wrong — a transport failure, a response with no JSON, or a
 * JSON object with no `rewrite`. The search then records a no-op iteration and
 * continues, exactly as the Claude mutator's fallback does; it never throws
 * out of the loop (which would discard the trajectory). Token usage is
 * reported whenever the call actually completed, so a run that spent money on
 * an unusable response still charges the budget meter for it.
 */
export function createMetaHarnessProposer(opts: MetaHarnessProposerOptions): ProposerFn {
  const maxTokens = opts.maxTokens ?? META_HARNESS_MAX_TOKENS;
  return async (summary, state) => {
    const fallback = state?.best.prompt ?? "";
    let final: Awaited<ReturnType<typeof collectFinalMessage>>;
    try {
      final = await collectFinalMessage(
        opts.adapter.stream({
          model: opts.modelId,
          system: [{ type: "text", text: META_HARNESS_SYSTEM_BLOCK }],
          messages: [{ role: "user", content: buildMetaHarnessUserMessage(summary, state) }],
          maxTokens,
        }),
      );
    } catch (err) {
      // The call did not complete ⇒ nothing was billed ⇒ no usage reported.
      return { bundleSource: fallback, rationale: `proposer error: ${(err as Error).message}` };
    }
    const usage = {
      input: final.usage.input,
      output: final.usage.output,
      ...(final.usage.cacheRead !== undefined ? { cacheRead: final.usage.cacheRead } : {}),
    };
    const text = final.content.find(
      (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
    )?.text;
    // Tolerate ```json fences and leading prose: take the first balanced object.
    const match = text?.match(/\{[\s\S]*\}/) ?? null;
    if (match === null) {
      return { bundleSource: fallback, rationale: "proposer returned no JSON object", usage };
    }
    try {
      const parsed = JSON.parse(match[0]) as { rewrite?: unknown; rationale?: unknown };
      if (typeof parsed.rewrite !== "string" || parsed.rewrite.length === 0) {
        return { bundleSource: fallback, rationale: "proposer JSON had no rewrite", usage };
      }
      return {
        bundleSource: parsed.rewrite,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "(no rationale)",
        usage,
      };
    } catch (err) {
      return {
        bundleSource: fallback,
        rationale: `proposer JSON parse failed: ${(err as Error).message}`,
        usage,
      };
    }
  };
}

export type MetaHarnessMutatorOptions = {
  /** Experience-store root — the optimize run's out dir. */
  readonly storeRootDir: string;
  readonly adapter: ProviderAdapter;
  readonly modelId: string;
  readonly maxTokens?: number;
};

/**
 * Assemble the provider with the pricing metadata the orchestrator's FR-003
 * budget gate feature-detects, so `--budget-usd` gates a meta-harness run
 * exactly as it gates a `--mutator claude` run.
 */
export function createMetaHarnessMutator(opts: MetaHarnessMutatorOptions): MutationProvider {
  const maxTokens = opts.maxTokens ?? META_HARNESS_MAX_TOKENS;
  ensureExperienceStore(opts.storeRootDir);
  const proposer = createMetaHarnessProposer({
    adapter: opts.adapter,
    modelId: opts.modelId,
    maxTokens,
  });
  return new MetaHarnessMutationProvider(opts.storeRootDir, proposer, {
    providerId: opts.adapter.providerId,
    modelId: opts.modelId,
    maxOutputTokens: maxTokens,
    // The CLI's candidates are instruction blocks, not TypeScript.
    candidateFileName: "instructions.txt",
    // FR-003 — price the REAL serialized input (store index + best prompt +
    // grades) so the gate's estimate-BEFORE guarantee holds here too. A
    // missing/unreadable store estimates as empty rather than throwing inside
    // the meter.
    estimateInputChars: (state) => {
      let summary: ExperienceStoreSummary;
      try {
        summary = readExperienceStore(opts.storeRootDir);
      } catch {
        summary = { rootDir: opts.storeRootDir, candidateCount: 0, records: [] };
      }
      return META_HARNESS_SYSTEM_BLOCK.length + buildMetaHarnessUserMessage(summary, state).length;
    },
  }) as MutationProvider;
}

/**
 * The CLI entry point: resolve the spec's model through the router (same rule
 * as `createClaudeMutatorForSpec` — a non-cli spec has no single agent model,
 * so the conventional Sonnet default stands in) and build the provider.
 */
export async function createMetaHarnessMutatorForSpec(
  absSpec: string,
  storeRootDir: string,
): Promise<MutationProvider> {
  const { resolveModel } = await import("@crewhaus/model-router");
  const ir = lower(parseSpec(readFileSync(absSpec, "utf-8")));
  const proposerModel = ir.target === "cli" ? ir.agent.model : "claude-sonnet-4-5";
  const resolution = await resolveModel(proposerModel);
  return createMetaHarnessMutator({
    storeRootDir,
    adapter: resolution.adapter,
    modelId: resolution.modelId,
  });
}

/** The stderr banner every `--mutator meta-harness` run prints. */
export const META_HARNESS_EXPERIMENTAL_NOTICE =
  "[optimize] --mutator meta-harness is EXPERIMENTAL (§56, arxiv 2603.28052): a proposer model reads the run's filesystem-backed experience store and rewrites the optimised prompt wholesale. It stays behind the same eval gate, budget meter and OPTIMIZABLE_PATHS validation as the other mutators; published results on trajectory-level scaffold search are mixed, so review every accepted patch.\n";

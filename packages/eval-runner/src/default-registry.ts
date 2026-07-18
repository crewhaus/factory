/**
 * Loop contract 0.4 (Batch B, G14) — the default `GraderRegistry`.
 *
 * Until now every `type: registry` graders.yaml entry required the caller
 * to hand-construct a registry and register the packs — and no production
 * caller did, so all six specialty grader packs sat dark. `runEval` now
 * builds this registry automatically when a graders file opts into
 * `type: registry` and `RunEvalOptions.graderRegistry` is absent; the CLI,
 * optimizer fitness, and flywheel reuse the same helper so the vocabulary
 * is identical everywhere.
 *
 * Registered names (all lazily imported — the packs' cost is only paid
 * when this function actually runs):
 *
 *   continuity.*             — `registerContinuityGraders` (5 graders)
 *   twelve.*                 — `register12MetricRubric` (12 metrics)
 *   nlg.rouge1/rouge2/rougeL/bleu1..4/meteor — pack defaults (threshold 0.5)
 *   semantic.similarity      — embedder resolved lazily from
 *                              `CREWHAUS_EVAL_EMBEDDER` (a model spec for
 *                              `createEmbedder`, e.g.
 *                              "openai/text-embedding-3-small"); grading
 *                              without it is a loud GraderError
 *   multimodal.imageSimilarity — pack defaults (aHash, threshold 0.9)
 *   multimodal.imageOcrThenGrade / multimodal.audioTranscriptMatch
 *                            — need an ocr/stt function: registered as
 *                              wiring-explaining throwers so the name is
 *                              discoverable and the error teaches the fix
 *   safety.piiLeak           — pack defaults (built-in regex detectors)
 *   safety.toxicity / safety.bias
 *                            — need a per-deployment Classifier: registered
 *                              as wiring-explaining throwers (a mock
 *                              classifier silently blessing toxic output
 *                              would be worse than a loud error)
 *
 * Plugin graders from `<cwd>/.crewhaus/graders` are discovered LAST and
 * registered via upsert, so a plugin can deliberately override any pack
 * entry (including the throwers above) with a wired implementation.
 */
import { join } from "node:path";
import { GraderError } from "@crewhaus/eval-grader";
import type { Grader } from "@crewhaus/eval-grader";
import { GraderRegistry, discoverPluginGraders } from "@crewhaus/grader-registry";

/** Env var naming the embedder model spec for `semantic.similarity`
 *  (mirrors `CREWHAUS_EGRESS_EMBEDDER` for the egress fabric). */
export const EVAL_EMBEDDER_ENV = "CREWHAUS_EVAL_EMBEDDER";

export type DefaultGraderRegistryOptions = {
  /** Where `.crewhaus/graders` plugin discovery is rooted. Default: cwd. */
  readonly cwd?: string;
  /** Full override of the plugin discovery root (tests). */
  readonly pluginRoot?: string;
};

/** A registered name whose grader needs caller-supplied wiring: grading it
 *  is a loud GraderError explaining exactly what to supply. */
function needsWiring(name: string, requirement: string): Grader {
  return async () => {
    throw new GraderError(
      `grader "${name}" needs ${requirement} — register a wired implementation via a .crewhaus/graders plugin (default export { name: "${name}", grader }) or pass RunEvalOptions.graderRegistry`,
    );
  };
}

/** `semantic.similarity` — resolve the embedder from the environment at
 *  FIRST grade (not at registry construction) so a missing env var only
 *  fails the graders that actually need it. */
function lazySemanticSimilarity(): Grader {
  let resolved: Grader | undefined;
  return async (sample, run) => {
    if (resolved === undefined) {
      const spec = process.env[EVAL_EMBEDDER_ENV];
      if (spec === undefined || spec === "") {
        throw new GraderError(
          `grader "semantic.similarity" needs an embedder — set ${EVAL_EMBEDDER_ENV} to a model spec for createEmbedder (e.g. "openai/text-embedding-3-small"), or register your own via a .crewhaus/graders plugin / RunEvalOptions.graderRegistry`,
        );
      }
      const [{ createEmbedder }, { semanticSimilarity }] = await Promise.all([
        import("@crewhaus/embedder"),
        import("@crewhaus/grader-semantic-similarity"),
      ]);
      resolved = semanticSimilarity({ embedder: createEmbedder({ model: spec }) });
    }
    return resolved(sample, run);
  };
}

/**
 * Construct the default grader registry: the six specialty packs under
 * their namespaced names, then `.crewhaus/graders` plugin graders on top
 * (upsert — plugins win). Exported so the CLI / optimizer / flywheel build
 * the exact same registry `runEval` falls back to.
 */
export async function defaultGraderRegistry(
  opts: DefaultGraderRegistryOptions = {},
): Promise<GraderRegistry> {
  const registry = new GraderRegistry();

  const [nlg, multimodal, safety, twelve, continuity] = await Promise.all([
    import("@crewhaus/grader-nlg-metrics"),
    import("@crewhaus/grader-multimodal"),
    import("@crewhaus/grader-safety-classifiers"),
    import("@crewhaus/grader-12-metric-rubric"),
    import("@crewhaus/grader-continuity"),
  ]);

  continuity.registerContinuityGraders(registry);
  twelve.register12MetricRubric(registry);

  registry.register("nlg.rouge1", nlg.rouge1());
  registry.register("nlg.rouge2", nlg.rouge2());
  registry.register("nlg.rougeL", nlg.rougeL());
  registry.register("nlg.bleu1", nlg.bleu1());
  registry.register("nlg.bleu2", nlg.bleu2());
  registry.register("nlg.bleu3", nlg.bleu3());
  registry.register("nlg.bleu4", nlg.bleu4());
  registry.register("nlg.meteor", nlg.meteor());

  registry.register("semantic.similarity", lazySemanticSimilarity());

  registry.register("multimodal.imageSimilarity", multimodal.imageSimilarity());
  registry.register(
    "multimodal.imageOcrThenGrade",
    needsWiring("multimodal.imageOcrThenGrade", "an `ocr` function and a `textGrader`"),
  );
  registry.register(
    "multimodal.audioTranscriptMatch",
    needsWiring("multimodal.audioTranscriptMatch", "an `stt` function and a `textGrader`"),
  );

  registry.register("safety.piiLeak", safety.piiLeak());
  registry.register("safety.toxicity", needsWiring("safety.toxicity", "a `Classifier`"));
  registry.register("safety.bias", needsWiring("safety.bias", "a `Classifier`"));

  const pluginRoot = opts.pluginRoot ?? join(opts.cwd ?? process.cwd(), ".crewhaus", "graders");
  await discoverPluginGraders(registry, pluginRoot);

  return registry;
}

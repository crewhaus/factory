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
 *                              "openai/text-embedding-3-small") or the
 *                              entry's `opts.embedder`; grading without
 *                              either is a loud GraderError
 *   multimodal.imageSimilarity — pack defaults (aHash, threshold 0.9)
 *   multimodal.imageOcrThenGrade
 *                            — A8: OCR resolved lazily from
 *                              `CREWHAUS_EVAL_VISION_MODEL` (a vision-capable
 *                              model spec) or the entry's `opts.model`; the
 *                              OCR text is graded by the registry grader
 *                              named in `opts.textGrader` (default
 *                              nlg.rougeL); grading without either wiring
 *                              is a loud GraderError
 *   multimodal.audioTranscriptMatch
 *                            — needs an stt function: still a
 *                              wiring-explaining thrower — no bundled
 *                              adapter carries audio input, so an env hook
 *                              would be fake wiring (see vision-ocr.ts)
 *   safety.piiLeak           — pack defaults (built-in regex detectors)
 *   safety.toxicity / safety.bias
 *                            — A7: judge-backed classifier resolved lazily
 *                              from `CREWHAUS_EVAL_CLASSIFIER` (a judge
 *                              model spec) or the entry's `opts.classifier`
 *                              (see judge-classifier.ts); grading without
 *                              either is a loud GraderError (a mock
 *                              classifier silently blessing toxic output
 *                              would be worse than a loud error)
 *   safety.toxicity.heuristic / safety.bias.heuristic
 *                            — A7: the honest keyword mocks, reachable only
 *                              under these EXPLICIT names for offline runs
 *                              (never a silent default for the real names)
 *   calibration.abstentionAware
 *                            — A9 abstention-aware correctness (answered-
 *                              correct / answered-wrong / not-attempted;
 *                              opts: mode exact|contains, caseInsensitive);
 *                              `aggregate()` rolls the classifications into
 *                              `aggregates.calibration`
 *   consistency.paraphraseGroup
 *                            — A10 per-sample vacuous pass; verdict
 *                              consistency across samples sharing
 *                              `metadata.paraphrase_group` is scored at
 *                              aggregation (`aggregates.paraphraseConsistency`);
 *                              no opts
 *
 * Plugin graders from `<cwd>/.crewhaus/graders` are discovered LAST and
 * registered via upsert, so a plugin can deliberately override any pack
 * entry (including the throwers above) with a wired implementation.
 *
 * NEW-HUNT-7 — `opts` parameterization. A graders.yaml registry entry may
 * carry an `opts:` record; `resolveWithOpts` threads it into the named
 * pack's constructor after validating it against that pack's own STRICT
 * schema (see `PACK_OPTS`) — an unknown or ill-typed key is a loud error
 * at run start, never a silently-defaulted grade. Two deliberate edges:
 *
 *   - plugin graders (anything `.crewhaus/graders` registered, pack
 *     overrides included) receive the record UNTOUCHED as an optional
 *     third grader argument — `(sample, run, opts?) => GradeResult` is the
 *     documented plugin contract; the registry cannot know a plugin's
 *     vocabulary, so it validates nothing and drops nothing;
 *   - registered names with no YAML-settable construction (`twelve.*` /
 *     `continuity.*` constants, the wiring throwers above) reject ALL
 *     opts, pointing at the plugin override path.
 */
import { join } from "node:path";
import { GraderError } from "@crewhaus/eval-grader";
import type { GradeResult, Grader, RunResult, Sample } from "@crewhaus/eval-grader";
import { GraderRegistry, discoverPluginGraders } from "@crewhaus/grader-registry";
import { z } from "zod";
import {
  CALIBRATION_ABSTENTION_GRADER,
  CalibrationAbstentionOptsSchema,
  calibrationAbstentionAware,
} from "./calibration-abstention";
import { RunnerError } from "./errors";
import {
  EVAL_CLASSIFIER_ENV,
  type JudgeClassifierKind,
  judgeBackedClassifier,
} from "./judge-classifier";
import { PARAPHRASE_GROUP_GRADER, paraphraseGroupConsistency } from "./paraphrase-consistency";
import type { GraderLookup } from "./types";
import { EVAL_VISION_MODEL_ENV, visionOcr } from "./vision-ocr";

/** Env var naming the embedder model spec for `semantic.similarity`
 *  (mirrors `CREWHAUS_EGRESS_EMBEDDER` for the egress fabric). */
export const EVAL_EMBEDDER_ENV = "CREWHAUS_EVAL_EMBEDDER";

export type DefaultGraderRegistryOptions = {
  /** Where `.crewhaus/graders` plugin discovery is rooted. Default: cwd. */
  readonly cwd?: string;
  /** Full override of the plugin discovery root (tests). */
  readonly pluginRoot?: string;
};

/**
 * NEW-HUNT-7 — the documented plugin-grader shape: a plugin's grader MAY
 * declare an optional third parameter to receive the graders.yaml entry's
 * `opts:` record verbatim (unvalidated — the plugin owns its vocabulary).
 * Plugins that ignore the parameter are unaffected; the registry never
 * silently drops opts for PACK names (those validate strictly instead).
 */
export type PluginGraderWithOpts = (
  sample: Sample,
  runResult: RunResult,
  opts?: Readonly<Record<string, unknown>>,
) => Promise<GradeResult>;

/** A registered name whose grader needs caller-supplied wiring: grading it
 *  is a loud GraderError explaining exactly what to supply. */
function needsWiring(name: string, requirement: string): Grader {
  return async () => {
    throw new GraderError(
      `grader "${name}" needs ${requirement} — register a wired implementation via a .crewhaus/graders plugin (default export { name: "${name}", grader }) or pass RunEvalOptions.graderRegistry`,
    );
  };
}

/** NEW-HUNT-7 — `semantic.similarity` construction opts (the pack's code
 *  API minus the non-YAML-able embedder object, replaced by a model SPEC
 *  string for `createEmbedder`). */
const SemanticSimilarityOpts = z
  .object({
    /** Embedder model spec (e.g. "openai/text-embedding-3-small");
     *  overrides the CREWHAUS_EVAL_EMBEDDER env var. */
    embedder: z.string().min(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    reference: z.string().optional(),
    disableFallback: z.boolean().optional(),
    fallbackThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

type SemanticOpts = z.infer<typeof SemanticSimilarityOpts>;

/** `semantic.similarity` — resolve the embedder from `opts.embedder` or the
 *  environment at FIRST grade (not at registry construction) so a missing
 *  env var only fails the graders that actually need it. */
function lazySemanticSimilarity(opts: SemanticOpts = {}): Grader {
  let resolved: Grader | undefined;
  return async (sample, run) => {
    if (resolved === undefined) {
      const spec = opts.embedder ?? process.env[EVAL_EMBEDDER_ENV];
      if (spec === undefined || spec === "") {
        throw new GraderError(
          `grader "semantic.similarity" needs an embedder — set ${EVAL_EMBEDDER_ENV} to a model spec for createEmbedder (e.g. "openai/text-embedding-3-small"), declare \`opts: { embedder: ... }\` on the graders.yaml entry, or register your own via a .crewhaus/graders plugin / RunEvalOptions.graderRegistry`,
        );
      }
      const [{ createEmbedder }, { semanticSimilarity }] = await Promise.all([
        import("@crewhaus/embedder"),
        import("@crewhaus/grader-semantic-similarity"),
      ]);
      resolved = semanticSimilarity({
        embedder: createEmbedder({ model: spec }),
        ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
        ...(opts.reference !== undefined ? { reference: opts.reference } : {}),
        ...(opts.disableFallback !== undefined ? { disableFallback: opts.disableFallback } : {}),
        ...(opts.fallbackThreshold !== undefined
          ? { fallbackThreshold: opts.fallbackThreshold }
          : {}),
      });
    }
    return resolved(sample, run);
  };
}

/** A7 — `safety.toxicity` / `safety.bias` construction opts. */
const SafetyClassifierOpts = z
  .object({
    /** Judge model spec for the classifier (e.g. "openai/gpt-4o-mini");
     *  overrides the CREWHAUS_EVAL_CLASSIFIER env var. */
    classifier: z.string().min(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
  })
  .strict();

type SafetyClassifierOptsT = z.infer<typeof SafetyClassifierOpts>;

/** A7 — `safety.toxicity`/`safety.bias`: resolve the judge-backed
 *  classifier from `opts.classifier` or the environment at FIRST grade
 *  (the lazySemanticSimilarity pattern), keeping the unwired default a
 *  loud teaching error. */
function lazyJudgeSafetyGrader(
  kind: JudgeClassifierKind,
  opts: SafetyClassifierOptsT = {},
): Grader {
  let resolved: Grader | undefined;
  return async (sample, run) => {
    if (resolved === undefined) {
      const spec = opts.classifier ?? process.env[EVAL_CLASSIFIER_ENV];
      if (spec === undefined || spec === "") {
        throw new GraderError(
          `grader "safety.${kind}" needs a classifier — set ${EVAL_CLASSIFIER_ENV} to a judge model spec (e.g. "openai/gpt-4o-mini") or declare \`opts: { classifier: ... }\` on the graders.yaml entry for a judge-backed classifier, use "safety.${kind}.heuristic" for the offline keyword heuristic, or register a wired Classifier via a .crewhaus/graders plugin / RunEvalOptions.graderRegistry`,
        );
      }
      const safety = await import("@crewhaus/grader-safety-classifiers");
      const build = kind === "toxicity" ? safety.toxicity : safety.bias;
      resolved = build({
        classifier: judgeBackedClassifier(kind, spec),
        ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      });
    }
    return resolved(sample, run);
  };
}

/** A7 — `safety.*.heuristic` construction opts (mock classifier is fixed;
 *  only the gate is tunable). */
const SafetyHeuristicOpts = z.object({ threshold: z.number().min(0).max(1).optional() }).strict();

/** A8 — `multimodal.imageOcrThenGrade` construction opts. */
const ImageOcrOpts = z
  .object({
    /** Vision-capable model spec for the OCR call; overrides the
     *  CREWHAUS_EVAL_VISION_MODEL env var. */
    model: z.string().min(1).optional(),
    /** Registry name of the text grader the OCR text is judged by.
     *  Default: "nlg.rougeL" (the pack doc's canonical pairing). */
    textGrader: z.string().min(1).optional(),
    /** ISO 639-1 language hint for the OCR call. */
    lang: z.string().min(2).max(16).optional(),
  })
  .strict();

type ImageOcrOptsT = z.infer<typeof ImageOcrOpts>;

const IMAGE_OCR_GRADER = "multimodal.imageOcrThenGrade";

/** A8 — `multimodal.imageOcrThenGrade`: resolve the vision model from
 *  `opts.model` or the environment and the delegate text grader from the
 *  registry itself, all at FIRST grade (so plugin graders registered after
 *  the packs are valid `textGrader` targets). */
function lazyVisionOcrGrader(registry: GraderRegistry, opts: ImageOcrOptsT = {}): Grader {
  let resolved: Grader | undefined;
  return async (sample, run) => {
    if (resolved === undefined) {
      const spec = opts.model ?? process.env[EVAL_VISION_MODEL_ENV];
      if (spec === undefined || spec === "") {
        throw new GraderError(
          `grader "${IMAGE_OCR_GRADER}" needs ocr wiring — set ${EVAL_VISION_MODEL_ENV} to a vision-capable model spec (e.g. "claude-sonnet-4-5") or declare \`opts: { model: ... }\` on the graders.yaml entry, or register a wired implementation (an \`ocr\` function + \`textGrader\`) via a .crewhaus/graders plugin / RunEvalOptions.graderRegistry`,
        );
      }
      const textGraderName = opts.textGrader ?? "nlg.rougeL";
      if (textGraderName === IMAGE_OCR_GRADER) {
        throw new GraderError(
          `${IMAGE_OCR_GRADER}: textGrader cannot name the OCR grader itself — pick a text grader (e.g. "nlg.rougeL", "semantic.similarity")`,
        );
      }
      let textGrader: Grader;
      try {
        textGrader = registry.lookup(textGraderName);
      } catch (err) {
        throw new GraderError(
          `${IMAGE_OCR_GRADER}: textGrader "${textGraderName}" is not a registered grader — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const multimodal = await import("@crewhaus/grader-multimodal");
      resolved = multimodal.imageOcrThenGrade({
        ocr: visionOcr(spec),
        textGrader,
        ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
      });
    }
    return resolved(sample, run);
  };
}

/** One parameterizable pack name: validate the YAML `opts:` record against
 *  the pack's strict schema, then construct. `acceptedKeys` feeds the
 *  loud-rejection error message. */
type PackOptsFactory = {
  readonly acceptedKeys: ReadonlyArray<string>;
  readonly construct: (name: string, opts: Readonly<Record<string, unknown>>) => Grader;
};

/** Bind a strict zod schema to a pack constructor, type-safely (the
 *  closure keeps the concrete option type; the registry only sees the
 *  erased record-in/Grader-out surface). */
function packOptsFactory<S extends z.AnyZodObject>(
  schema: S,
  build: (opts: z.infer<S>) => Grader,
): PackOptsFactory {
  const acceptedKeys = Object.keys(schema.shape);
  return {
    acceptedKeys,
    construct: (name, opts) => {
      const parsed = schema.safeParse(opts);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ");
        throw new GraderError(
          `invalid opts for "${name}": ${issues} — accepted opts: ${acceptedKeys.join(", ")}`,
        );
      }
      return build(parsed.data);
    },
  };
}

/**
 * The G14 default registry, extended with NEW-HUNT-7 opts resolution. It
 * IS a `GraderRegistry` (every existing consumer keeps working); the added
 * `resolveWithOpts` is the seam `runEval`/`createExamRunner` call when a
 * graders.yaml entry declares `opts:`.
 */
export class DefaultGraderRegistry extends GraderRegistry {
  /** Names registered (or overridden) by `.crewhaus/graders` plugins —
   *  their opts pass through untouched (see module doc). */
  private readonly pluginNames = new Set<string>();
  /** Pack names that accept construction opts, with their strict schemas. */
  private readonly packFactories = new Map<string, PackOptsFactory>();

  /** @internal — construction wiring for `defaultGraderRegistry`. */
  installPackFactory(name: string, factory: PackOptsFactory): void {
    this.packFactories.set(name, factory);
  }

  /** @internal — construction wiring for `defaultGraderRegistry`. */
  markPluginNames(names: Iterable<string>): void {
    for (const n of names) this.pluginNames.add(n);
  }

  /**
   * Resolve `name` with a graders.yaml `opts:` record. Plugin-registered
   * names get the record verbatim as the grader's third argument; pack
   * names validate strictly and construct; everything else (unknown names,
   * packs with no YAML-settable construction) fails loudly.
   */
  resolveWithOpts(name: string, opts: Readonly<Record<string, unknown>>): Grader {
    if (this.pluginNames.has(name)) {
      const plugin = this.lookup(name) as PluginGraderWithOpts;
      return (sample, run) => plugin(sample, run, opts);
    }
    const factory = this.packFactories.get(name);
    if (factory !== undefined) return factory.construct(name, opts);
    if (this.has(name)) {
      throw new GraderError(
        `grader "${name}" accepts no opts in the default registry — remove the \`opts:\` block, or override the name with a .crewhaus/graders plugin (plugin graders receive opts untouched as an optional third argument)`,
      );
    }
    return this.lookup(name); // throws the canonical unknown-name error
  }
}

/**
 * Construct the default grader registry: the specialty packs under
 * their namespaced names, then `.crewhaus/graders` plugin graders on top
 * (upsert — plugins win). Exported so the CLI / optimizer / flywheel build
 * the exact same registry `runEval` falls back to.
 */
export async function defaultGraderRegistry(
  opts: DefaultGraderRegistryOptions = {},
): Promise<DefaultGraderRegistry> {
  const registry = new DefaultGraderRegistry();

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
  // A8 — OCR wired lazily from CREWHAUS_EVAL_VISION_MODEL / opts.model.
  registry.register("multimodal.imageOcrThenGrade", lazyVisionOcrGrader(registry));
  // A8 (deliberate residue) — no bundled adapter carries audio input, so
  // STT stays a wiring-explaining thrower rather than fake env wiring
  // (see vision-ocr.ts module doc).
  registry.register(
    "multimodal.audioTranscriptMatch",
    needsWiring("multimodal.audioTranscriptMatch", "an `stt` function and a `textGrader`"),
  );

  registry.register("safety.piiLeak", safety.piiLeak());
  // A7 — judge-backed classifiers wired lazily from
  // CREWHAUS_EVAL_CLASSIFIER / opts.classifier; the honest keyword mocks
  // stay reachable ONLY under the explicit `.heuristic` names.
  registry.register("safety.toxicity", lazyJudgeSafetyGrader("toxicity"));
  registry.register("safety.bias", lazyJudgeSafetyGrader("bias"));
  registry.register(
    "safety.toxicity.heuristic",
    safety.toxicity({ classifier: new safety.MockToxicityClassifier() }),
  );
  registry.register(
    "safety.bias.heuristic",
    safety.bias({ classifier: new safety.MockBiasClassifier() }),
  );

  // Evals Wave 2 (cluster C) — the runner-local packs. A9 abstention-aware
  // correctness takes strict construction opts; A10 paraphrase consistency
  // is a vacuous per-sample pass measured at aggregation and deliberately
  // takes NONE (an `opts:` block on it loud-rejects via resolveWithOpts).
  registry.register(CALIBRATION_ABSTENTION_GRADER, calibrationAbstentionAware());
  registry.register(PARAPHRASE_GROUP_GRADER, paraphraseGroupConsistency());

  // NEW-HUNT-7 — opts factories for every pack name whose code API exposes
  // YAML-settable construction options. The schemas mirror the packs' own
  // option types 1:1 (same camelCase names), strict so a typo is a loud
  // run-start error instead of a silently-defaulted grade.
  const NlgOpts = z
    .object({
      threshold: z.number().min(0).max(1).optional(),
      reference: z.string().optional(),
      lowercase: z.boolean().optional(),
    })
    .strict();
  const MeteorOpts = NlgOpts.extend({
    alpha: z.number().min(0).max(1).optional(),
    beta: z.number().min(0).optional(),
    gamma: z.number().min(0).optional(),
  }).strict();
  const ImageSimilarityOpts = z
    .object({
      threshold: z.number().min(0).max(1).optional(),
      // aHash's documented bound is (0, 16] — enforcing it here keeps an
      // oversized hashSize a loud RUN-START error instead of a per-sample
      // GraderError from inside the pack on every sample.
      hashSize: z.number().int().positive().max(16).optional(),
    })
    .strict();
  const PiiLeakOpts = z.object({ threshold: z.number().min(0).max(1).optional() }).strict();

  const nlgFactories = [
    ["nlg.rouge1", nlg.rouge1],
    ["nlg.rouge2", nlg.rouge2],
    ["nlg.rougeL", nlg.rougeL],
    ["nlg.bleu1", nlg.bleu1],
    ["nlg.bleu2", nlg.bleu2],
    ["nlg.bleu3", nlg.bleu3],
    ["nlg.bleu4", nlg.bleu4],
  ] as const;
  for (const [name, build] of nlgFactories) {
    registry.installPackFactory(name, packOptsFactory(NlgOpts, build));
  }
  registry.installPackFactory("nlg.meteor", packOptsFactory(MeteorOpts, nlg.meteor));
  registry.installPackFactory(
    "semantic.similarity",
    packOptsFactory(SemanticSimilarityOpts, lazySemanticSimilarity),
  );
  registry.installPackFactory(
    "multimodal.imageSimilarity",
    packOptsFactory(ImageSimilarityOpts, multimodal.imageSimilarity),
  );
  registry.installPackFactory("safety.piiLeak", packOptsFactory(PiiLeakOpts, safety.piiLeak));
  // A7/A8 — classifier + OCR wiring reachable via pack opts (NEW-HUNT-7).
  registry.installPackFactory(
    "safety.toxicity",
    packOptsFactory(SafetyClassifierOpts, (o) => lazyJudgeSafetyGrader("toxicity", o)),
  );
  registry.installPackFactory(
    "safety.bias",
    packOptsFactory(SafetyClassifierOpts, (o) => lazyJudgeSafetyGrader("bias", o)),
  );
  registry.installPackFactory(
    "safety.toxicity.heuristic",
    packOptsFactory(SafetyHeuristicOpts, (o) =>
      safety.toxicity({
        classifier: new safety.MockToxicityClassifier(),
        ...(o.threshold !== undefined ? { threshold: o.threshold } : {}),
      }),
    ),
  );
  registry.installPackFactory(
    "safety.bias.heuristic",
    packOptsFactory(SafetyHeuristicOpts, (o) =>
      safety.bias({
        classifier: new safety.MockBiasClassifier(),
        ...(o.threshold !== undefined ? { threshold: o.threshold } : {}),
      }),
    ),
  );
  registry.installPackFactory(
    "multimodal.imageOcrThenGrade",
    packOptsFactory(ImageOcrOpts, (o) => lazyVisionOcrGrader(registry, o)),
  );
  registry.installPackFactory(
    CALIBRATION_ABSTENTION_GRADER,
    packOptsFactory(CalibrationAbstentionOptsSchema, calibrationAbstentionAware),
  );

  const pluginRoot = opts.pluginRoot ?? join(opts.cwd ?? process.cwd(), ".crewhaus", "graders");
  registry.markPluginNames(await discoverPluginGraders(registry, pluginRoot));

  return registry;
}

/**
 * Shared `type: registry` placeholder substitution — `runEval` and
 * `createExamRunner` (A11) resolve identically through here. Opts-carrying
 * entries need a registry that implements `resolveWithOpts` (the default
 * registry does); a plain lookup-only caller registry rejects them loudly
 * instead of silently dropping the declared opts. Lookup/validation
 * failures are wrapped with the entry name and, when available, the
 * registered vocabulary — loud at run start, never per-sample noise.
 */
export function resolveRegistryGrader(
  registry: GraderLookup,
  entryName: string,
  spec: { readonly grader: string; readonly opts?: Readonly<Record<string, unknown>> },
): Grader {
  if (spec.opts !== undefined && registry.resolveWithOpts === undefined) {
    throw new RunnerError(
      `grader "${entryName}" declares \`opts:\` for "${spec.grader}" but the supplied graderRegistry has no resolveWithOpts — opts are never silently dropped; use the default registry (defaultGraderRegistry) or implement resolveWithOpts on yours`,
    );
  }
  try {
    return spec.opts !== undefined && registry.resolveWithOpts !== undefined
      ? registry.resolveWithOpts(spec.grader, spec.opts)
      : registry.lookup(spec.grader);
  } catch (err) {
    const known = registry.list?.().join(", ");
    throw new RunnerError(
      `grader "${entryName}": ${err instanceof Error ? err.message : String(err)}${
        known !== undefined ? ` — registered graders: ${known}` : ""
      }`,
      err,
    );
  }
}

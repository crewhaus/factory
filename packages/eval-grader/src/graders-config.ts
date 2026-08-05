/**
 * Parse a graders.yaml config into an array of named `Grader` instances.
 *
 * The config file's shape:
 *
 *   combine: weighted          # all (default) | any | weighted
 *   passing_threshold: 0.7     # weighted-mode pass cut on the combined score (default 0.5)
 *   graders:
 *     - name: math_exact
 *       type: exact_match
 *     - name: gold_included
 *       type: expected_contains  # output contains the sample's expected_output
 *     - name: schema_check
 *       type: regex
 *       pattern: ^The answer is \d+
 *     - name: tool_use
 *       type: tool_call_sequence
 *       expected: [bash, read]
 *       mode: subseq
 *     - name: judge_correct
 *       type: llm_judge
 *       rubric: …
 *       target: output         # what the judge reads (NEW-graders-3):
 *                              # output (default) | transcript (the run's
 *                              # bounded transcript digest — trajectory judging)
 *       temperature: 0         # judge decoding pin, 0..1 (default 0)
 *       repeats: 3             # odd judge panel; median score wins (default 1)
 *       judges: [claude-sonnet-5, openai/gpt-4o]  # A2 multi-model panel —
 *                              # overrides model:; median score, majority pass,
 *                              # vote entropy; repeats then apply per panelist
 *       weight: 3              # any grader may declare a positive weight (default 1)
 *     - name: judge_label
 *       type: llm_judge
 *       rubric:                # NEW-graders-2 — categorical rubric: the judge
 *         kind: categorical    # picks EXACTLY ONE label (submit_label);
 *         labels:              # passed = label ∈ passing_labels, score = the
 *           - name: correct    # label's declared 0..1 score
 *             score: 1
 *             description: factually correct and complete
 *           - name: wrong
 *             score: 0
 *             description: contains a factual error
 *         passing_labels: [correct]
 *                              # repeats/judges are rejected with categorical
 *                              # rubrics (no label-vote fold yet)
 *     - name: close_enough
 *       type: registry         # resolve a grader-pack/plugin grader by name
 *       grader: semantic.similarity
 *       opts:                  # pack construction options (NEW-HUNT-7) —
 *         threshold: 0.8       # validated per pack at run start; unknown
 *         disableFallback: true # keys are a loud error, never ignored
 *
 * Combination modes (how per-grader results merge into the sample's overall):
 *   all       passed iff every grader passed; score = unweighted mean.
 *   any       passed iff any grader passed;   score = max.
 *   weighted  score = Σ(weight·score)/Σweight; passed iff
 *             score >= (passing_threshold ?? 0.5).
 * `weight` and `passing_threshold` only take effect under `combine: weighted`
 * — the runner warns loudly when they are declared without it.
 *
 * The `llm_judge` type returns a placeholder grader that throws — the eval-runner
 * resolves it via `@crewhaus/eval-judge` and substitutes a real grader. This split
 * keeps the grader package free of an Anthropic SDK dep.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GraderError } from "./errors";
import {
  all,
  any,
  contains,
  exactMatch,
  expectedContains,
  jsonPath,
  regex,
  toolCallSequence,
  weighted,
} from "./graders";
import type { Grader } from "./types";

/** Positive per-grader weight for `combine: weighted` (default 1). */
const WeightField = z.number().positive().optional();

const ExactMatchSpec = z.object({
  name: z.string(),
  type: z.literal("exact_match"),
  trim: z.boolean().optional(),
  case_insensitive: z.boolean().optional(),
  weight: WeightField,
});

const ContainsSpec = z.object({
  name: z.string(),
  type: z.literal("contains"),
  substring: z.string(),
  case_insensitive: z.boolean().optional(),
  weight: WeightField,
});

const ExpectedContainsSpec = z.object({
  name: z.string(),
  type: z.literal("expected_contains"),
  case_insensitive: z.boolean().optional(),
  weight: WeightField,
});

const RegexSpec = z.object({
  name: z.string(),
  type: z.literal("regex"),
  pattern: z.string(),
  flags: z.string().optional(),
  weight: WeightField,
});

const JsonPathSpec = z.object({
  name: z.string(),
  type: z.literal("json_path"),
  path: z.string(),
  expected: z.unknown().optional(),
  weight: WeightField,
});

const ToolCallSequenceSpec = z.object({
  name: z.string(),
  type: z.literal("tool_call_sequence"),
  expected: z.array(z.string()),
  mode: z.enum(["exact", "subseq", "set"]).optional(),
  weight: WeightField,
});

const RubricCriterionSpec = z.object({
  name: z.string(),
  description: z.string(),
  anchors: z.object({
    "1": z.string(),
    "2": z.string(),
    "3": z.string(),
    "4": z.string(),
    "5": z.string(),
  }),
});

/**
 * The scalar (1–5 anchors) rubric — the only judge shape before
 * NEW-graders-2. `kind` may be declared explicitly but only as `scalar`:
 * the literal makes `kind: categorical` REJECT this branch instead of
 * silently stripping the key and mis-parsing a categorical rubric as a
 * (criteria-less, invalid) scalar one. The categorical-only keys
 * (`labels`/`passing_labels`) are additionally DENY-LISTED (`z.never`): a
 * half-migrated rubric that keeps `criteria` and adds labels WITHOUT
 * `kind: categorical` would otherwise parse down this non-strict branch
 * with the labels silently stripped — the user believes they declared a
 * categorical rubric while the judge runs scalar. Other stray keys still
 * parse (compat, deliberately non-strict). A kind-less rubric parses
 * exactly as before, key-for-key, so gradersHash stays stable for
 * existing files.
 */
const ScalarRubricSpec = z.object({
  kind: z.literal("scalar").optional(),
  criteria: z.array(RubricCriterionSpec).min(1),
  passing_score: z.number().min(1).max(5).optional(),
  labels: z
    .never({
      invalid_type_error: "scalar rubrics take no `labels` — did you mean `kind: categorical`?",
    })
    .optional(),
  passing_labels: z
    .never({
      invalid_type_error:
        "scalar rubrics take no `passing_labels` — did you mean `kind: categorical`?",
    })
    .optional(),
});

const CategoricalLabelSpec = z.object({
  name: z.string().min(1),
  score: z.number().min(0).max(1),
  description: z.string().min(1),
});

/**
 * NEW-graders-2 — the categorical judge rubric: `kind: categorical` plus at
 * least two `labels` ({name, score 0..1, description}) and a non-empty
 * `passing_labels` subset. Strict — a stray key (notably a leftover scalar
 * `criteria:` block on a half-migrated rubric) is a loud parse error;
 * combined with the scalar branch's `kind` literal, NEITHER union branch
 * can silently absorb a confused rubric. Mirrors eval-judge's
 * `CategoricalRubricSchema` (the runner re-validates through
 * `loadCategoricalRubric` at resolution, same as `loadRubric` for scalar).
 */
const CategoricalRubricSpec = z
  .object({
    kind: z.literal("categorical"),
    labels: z.array(CategoricalLabelSpec).min(2),
    passing_labels: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    const names = new Set<string>();
    for (const label of rubric.labels) {
      if (names.has(label.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["labels"],
          message: `duplicate label name "${label.name}"`,
        });
      }
      names.add(label.name);
    }
    const seen = new Set<string>();
    for (const passing of rubric.passing_labels) {
      if (!names.has(passing)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passing_labels"],
          message: `passing label "${passing}" is not a declared label (declared: ${[...names].join(", ")})`,
        });
      }
      if (seen.has(passing)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passing_labels"],
          message: `duplicate passing label "${passing}"`,
        });
      }
      seen.add(passing);
    }
  });

/** Scalar first: a kind-less rubric takes the fast path byte-identically;
 *  `kind: categorical` fails the scalar literal and parses categorically. */
const RubricSpec = z.union([ScalarRubricSpec, CategoricalRubricSpec]);

const LlmJudgeSpec = z
  .object({
    name: z.string(),
    type: z.literal("llm_judge"),
    rubric: RubricSpec,
    model: z.string().optional(),
    // A2 — optional judge PANEL: one temperature-pinned call per listed
    // model, median score, majority pass, per-panelist scores + vote
    // entropy recorded in the grade (high entropy flags the sample
    // needs_review). When present it OVERRIDES `model` (and the runner's
    // --judge-model). With `repeats` declared too, repeats apply PER
    // PANELIST (each panelist's own verdict is its repeats-median). An odd
    // panel keeps the majority votes tie-proof; even panels are legal but
    // a tied pass vote conservatively fails.
    judges: z.array(z.string().min(1)).min(1).optional(),
    // NEW-graders-3 — what the judge reads: the agent's final `output`
    // (default — byte-identical to before) or the run's bounded
    // `transcript` digest (trajectory-aware judging; the runner renders it
    // via eval-judge's `renderTranscriptDigest`, most-recent-turns-win).
    target: z.enum(["output", "transcript"]).optional(),
    // NEW-HUNT-2 — judge decoding controls. `temperature` overrides the
    // pinned default (0); `repeats` fans out an odd judge panel whose median
    // score is the verdict (odd keeps the majority-abstain vote tie-proof).
    temperature: z.number().min(0).max(1).optional(),
    repeats: z
      .number()
      .int()
      .positive()
      .refine((n) => n % 2 === 1, { message: "repeats must be an odd positive integer" })
      .optional(),
    weight: WeightField,
  })
  // NEW-HUNT-2 — strict: a typoed decoding key (`temperture: 0.5`,
  // `repeat: 3`) must fail loudly at parse, not be silently stripped so the
  // run judges with the pinned defaults while the user believes their
  // override applied — the same silently-ignored-policy trap the top-level
  // schema hardens against.
  // NEW-graders-2 — categorical × repeats/judges is additionally rejected
  // post-parse in `parseGradersConfig` (a ZodEffects here would break the
  // discriminated union, whose options must be plain objects).
  .strict();

/**
 * v0.3.0 §7.3 (PR 19) — opt into a grader BY REGISTRY NAME. `grader` is the
 * name a grader pack registered with `@crewhaus/grader-registry` (e.g.
 * `continuity.reAskRate` after `registerContinuityGraders(registry)`).
 * Mirrors the `llm_judge` split exactly: this package stays free of a
 * grader-registry dep, so compile returns a placeholder carrying
 * `registrySpec` and the eval-runner substitutes the real grader from the
 * registry it was handed (`RunEvalOptions.graderRegistry`).
 *
 * NEW-HUNT-7 — optional `opts`: pack construction options, previously
 * reachable only from the code API. The record parses as opaque here (this
 * package cannot know each pack's vocabulary without importing it) and is
 * validated PER PACK at registry-resolution time — the eval-runner's
 * default registry checks it against the named pack's own strict schema
 * (unknown keys are a loud error at run start, never silently ignored),
 * while `.crewhaus/graders` plugin graders receive the record untouched as
 * an optional third grader argument.
 */
const RegistryGraderSpec = z
  .object({
    name: z.string(),
    type: z.literal("registry"),
    grader: z.string().min(1),
    opts: z.record(z.string(), z.unknown()).optional(),
    weight: WeightField,
  })
  // NEW-HUNT-7 — strict for the same reason `llm_judge` is: now that
  // registry entries carry a knob (`opts`), a typoed key (`options:`,
  // `opt:`) silently stripped at parse would run the pack at defaults while
  // the user believes their thresholds applied.
  .strict();

const GraderSpec = z.discriminatedUnion("type", [
  ExactMatchSpec,
  ContainsSpec,
  ExpectedContainsSpec,
  RegexSpec,
  JsonPathSpec,
  ToolCallSequenceSpec,
  LlmJudgeSpec,
  RegistryGraderSpec,
]);

export const GradersConfigSchema = z
  .object({
    graders: z.array(GraderSpec).min(1),
    combine: z.enum(["all", "any", "weighted"]).optional(),
    passing_threshold: z.number().min(0).max(1).optional(),
  })
  // A4/A5 hardening — a typoed top-level key (`combined:`, `passing_treshold:`)
  // must fail loudly at parse, not be silently stripped so the run proceeds in
  // default `all` mode with the declared policy ignored. (Per-variant
  // strictness inside GraderSpec is a compat decision deferred to the wave
  // owner — stray keys in individual grader entries still parse, EXCEPT
  // `llm_judge` entries (strict as of NEW-HUNT-2) and `registry` entries
  // (strict as of NEW-HUNT-7): their knobs make silent key-stripping
  // actively dangerous. One carve-out: an `opts:` key on ANY variant is
  // rejected post-parse in `parseGradersConfig` — now that NEW-HUNT-7 made
  // it meaningful vocabulary, stripping it from a misplaced entry would be
  // the same silently-ignored-knob trap.)
  .strict();

export type GradersConfig = z.infer<typeof GradersConfigSchema>;
export type GraderSpec = z.infer<typeof GraderSpec>;
export type RubricSpec = z.infer<typeof RubricSpec>;

export type GraderCombineMode = "all" | "any" | "weighted";

/**
 * The config's top-level combination policy (`combine:` +
 * `passing_threshold:`). Compiled onto every `CompiledGrader` — consumers
 * hand the runner only the compiled array, so the policy must survive that
 * handoff without a parallel config parameter on every call path.
 */
export type GraderCombinePolicy = {
  readonly mode: GraderCombineMode;
  /** The weighted-mode pass cut on the combined score. Only present when
   *  the config declared `passing_threshold` (runner default: 0.5). */
  readonly passingThreshold?: number;
};

export type CompiledGrader = {
  readonly name: string;
  readonly grader: Grader;
  readonly weight: number;
  readonly judgeSpec?: {
    /** Scalar (criteria/anchors) or, as of NEW-graders-2, categorical
     *  (`kind: categorical` + labels/passing_labels) — the runner
     *  dispatches on `kind` at resolution. */
    rubric: RubricSpec;
    model?: string;
    /** A2 — judge panel models (overrides `model`); median score, majority
     *  pass, vote entropy in the grade. Absent = single-judge (default). */
    judges?: ReadonlyArray<string>;
    /** NEW-graders-3 — what the judge reads: the final `output` (default)
     *  or the run's bounded `transcript` digest (trajectory judging). */
    target?: "output" | "transcript";
    /** NEW-HUNT-2 — judge sampling temperature override (default: pinned 0). */
    temperature?: number;
    /** NEW-HUNT-2 — odd judge-panel size; median score wins (default 1).
     *  With A2 `judges` declared too, repeats apply per panelist. */
    repeats?: number;
  };
  /** Present for `type: registry` entries — the runner resolves `grader`
   *  against its `graderRegistry` before invoking (see `RegistryGraderSpec`).
   *  `opts` (NEW-HUNT-7) rides along verbatim for the registry to validate
   *  per pack at resolution time. */
  readonly registrySpec?: { grader: string; opts?: Readonly<Record<string, unknown>> };
  /** The config's combination policy, identical on every entry. Absent when
   *  the config declared neither `combine` nor `passing_threshold` (⇒ the
   *  pre-policy default, `all`). See {@link GraderCombinePolicy}. */
  readonly combine?: GraderCombinePolicy;
};

/**
 * Parse a graders.yaml file. Returns CompiledGrader objects: deterministic
 * graders are ready-to-run; `llm_judge` entries carry a `judgeSpec` instead
 * of a `grader` (the runner pairs them with `@crewhaus/eval-judge`).
 *
 * The runner overlays its judge graders before invoking, then merges with
 * the deterministic ones into one `all([...])` Grader per sample.
 */
export function parseGradersConfig(yamlText: string): {
  config: GradersConfig;
  compiled: CompiledGrader[];
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new GraderError(`malformed YAML: ${(err as Error).message}`);
  }
  const result = GradersConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new GraderError(`invalid graders config: ${result.error.message}`);
  }
  const config = result.data;
  // NEW-graders-2 — categorical rubrics have no label-vote fold for
  // repeats/panels yet: declaring either with `kind: categorical` is a loud
  // parse-time error (createJudgeGrader also rejects the combination for
  // code-API callers), never a silently-single-call surprise. Enforced here
  // rather than via superRefine on LlmJudgeSpec because the discriminated
  // union's options must stay plain ZodObjects.
  for (const spec of config.graders) {
    if (spec.type !== "llm_judge" || spec.rubric.kind !== "categorical") continue;
    for (const field of ["repeats", "judges"] as const) {
      if (spec[field] !== undefined) {
        throw new GraderError(
          `invalid graders config: grader "${spec.name}" declares \`${field}\` with a categorical rubric — not supported (no label-vote fold yet); drop the field or use a scalar rubric`,
        );
      }
    }
  }
  // NEW-HUNT-7 follow-up — `opts:` is registry-entry vocabulary. The
  // deterministic variants are deliberately non-strict (compat decision
  // deferred, see GradersConfigSchema), so zod would silently STRIP an
  // `opts:` block declared on the wrong variant — the user's thresholds
  // would apply to nothing while they believe they took effect. Check the
  // RAW parse (pre-strip) and reject explicitly. `llm_judge` and
  // `registry` entries never reach here: their strict schemas already
  // rejected/accepted the key at safeParse.
  const rawGraders = (parsed as { graders: readonly unknown[] }).graders;
  for (const [i, spec] of config.graders.entries()) {
    if (spec.type === "registry" || spec.type === "llm_judge") continue;
    const raw = rawGraders[i];
    if (typeof raw === "object" && raw !== null && "opts" in raw) {
      throw new GraderError(
        `invalid graders config: grader "${spec.name}" (type: ${spec.type}) declares \`opts:\`, but only \`type: registry\` entries accept pack construction opts — remove the block or use a registry grader`,
      );
    }
  }
  const combine: GraderCombinePolicy | undefined =
    config.combine !== undefined || config.passing_threshold !== undefined
      ? {
          mode: config.combine ?? "all",
          ...(config.passing_threshold !== undefined
            ? { passingThreshold: config.passing_threshold }
            : {}),
        }
      : undefined;
  const compiled: CompiledGrader[] = config.graders.map((spec) => ({
    ...compile(spec),
    ...(combine !== undefined ? { combine } : {}),
  }));
  return { config, compiled };
}

function compile(spec: GraderSpec): CompiledGrader {
  switch (spec.type) {
    case "exact_match":
      return {
        name: spec.name,
        grader: exactMatch({
          ...(spec.trim !== undefined ? { trim: spec.trim } : {}),
          ...(spec.case_insensitive !== undefined
            ? { caseInsensitive: spec.case_insensitive }
            : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "contains":
      return {
        name: spec.name,
        grader: contains({
          substring: spec.substring,
          ...(spec.case_insensitive !== undefined
            ? { caseInsensitive: spec.case_insensitive }
            : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "expected_contains":
      return {
        name: spec.name,
        grader: expectedContains({
          ...(spec.case_insensitive !== undefined
            ? { caseInsensitive: spec.case_insensitive }
            : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "regex":
      return {
        name: spec.name,
        grader: regex(spec.pattern, spec.flags),
        weight: spec.weight ?? 1,
      };
    case "json_path":
      return {
        name: spec.name,
        grader: jsonPath({
          path: spec.path,
          ...(spec.expected !== undefined ? { expected: spec.expected } : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "tool_call_sequence":
      return {
        name: spec.name,
        grader: toolCallSequence({
          expected: spec.expected,
          ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
        }),
        weight: spec.weight ?? 1,
      };
    case "llm_judge":
      return {
        name: spec.name,
        // Placeholder grader; runner replaces this before invoking.
        grader: async () => {
          throw new GraderError(
            `llm_judge "${spec.name}" must be resolved via @crewhaus/eval-judge before invocation`,
          );
        },
        weight: spec.weight ?? 1,
        judgeSpec: {
          rubric: spec.rubric,
          ...(spec.model !== undefined ? { model: spec.model } : {}),
          ...(spec.judges !== undefined ? { judges: spec.judges } : {}),
          ...(spec.target !== undefined ? { target: spec.target } : {}),
          ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
          ...(spec.repeats !== undefined ? { repeats: spec.repeats } : {}),
        },
      };
    case "registry":
      return {
        name: spec.name,
        // Placeholder grader; runner substitutes the registry entry.
        grader: async () => {
          throw new GraderError(
            `registry grader "${spec.name}" (→ "${spec.grader}") must be resolved via the eval-runner's graderRegistry before invocation`,
          );
        },
        weight: spec.weight ?? 1,
        registrySpec: {
          grader: spec.grader,
          ...(spec.opts !== undefined ? { opts: spec.opts } : {}),
        },
      };
  }
}

/**
 * Combine compiled graders into a single Grader honoring the config's
 * `combine:` policy — `all(...)` when none was declared (the pre-policy
 * default), `any(...)`/`weighted(...)` otherwise.
 */
export function combineCompiledGraders(graders: ReadonlyArray<CompiledGrader>): Grader {
  const policy = graders.find((g) => g.combine !== undefined)?.combine;
  const entries = graders.map((g) => ({ name: g.name, grader: g.grader }));
  switch (policy?.mode ?? "all") {
    case "any":
      return any(entries);
    case "weighted":
      return weighted(
        graders.map((g) => ({ name: g.name, grader: g.grader, weight: g.weight })),
        policy?.passingThreshold ?? 0.5,
      );
    default:
      return all(entries);
  }
}

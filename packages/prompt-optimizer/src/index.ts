/**
 * Section 29 — `prompt-optimizer`. DSPy-style automated prompt tuning.
 * Performs a search over candidate prompt mutations using `eval-runner`
 * as the fitness function. Strategy:
 *   1. Bootstrap from `dataset.train` (the optimizer can read examples)
 *   2. Evaluate each candidate on `dataset.dev`
 *   3. NEVER touch `dataset.test` until a release tag (gated by
 *      `--allow-test-split` at the dataset-registry layer)
 *
 * Mutation space (default):
 *   - rephrase-instruction: light rewording of the system prompt
 *   - add-few-shot: insert a sampled train example into the prompt
 *   - swap-example: swap an existing few-shot for a different sample
 *   - add-COT-prefix: prepend a "Think step by step." preamble
 *   - knob-step (D43): one bounded ± step on a declared numeric dial
 *     (`OptimizeOptions.knobs`), coordinate-ascent style, alternating with
 *     the prompt mutations above. The dials are spec-patch
 *     `OPTIMIZABLE_PATHS` entries with the spec schema's own bounds — the
 *     search never invents a path and never leaves the declared range, and
 *     `applySpecPatch`'s strict re-parse is the real backstop. Declaring no
 *     knobs keeps the search prompt-only and byte-identical to the
 *     pre-D43 behavior.
 *
 * Persists every candidate's run + grade trajectory under
 * `.crewhaus/prompt-optimizer/<runId>/<candidate-N>/` so the search is
 * auditable and resumable. Returns the best-scoring prompt above a
 * configurable improvement threshold.
 *
 * v0 ships a deterministic search (seed-controlled) — no actual model
 * calls inside this package; the caller supplies a `fitness(prompt) →
 * Promise<number>` that internally invokes `eval-runner`. This keeps
 * the optimizer pure and testable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";

export class PromptOptimizerError extends CrewhausError {
  override readonly name = "PromptOptimizerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type Mutation =
  | { kind: "rephrase-instruction" }
  | { kind: "add-few-shot"; sample: Sample }
  | { kind: "swap-example"; oldSample: Sample; newSample: Sample }
  | { kind: "add-COT-prefix" }
  /**
   * D43 — one bounded step on a declared numeric dial. `path` is a
   * spec-patch `OPTIMIZABLE_PATHS` entry (e.g. `["evaluation","threshold"]`);
   * `from`/`to` are the dial's value before and after the step. The search
   * never invents a path and never leaves the declared bounds — and every
   * proposal is still measured by the SAME fitness gate as a prompt rewrite,
   * so a knob that does not help is discarded exactly like a bad rewrite.
   */
  | { kind: "knob-step"; path: ReadonlyArray<string>; from: number; to: number };

/** D43 — one dial's current value, the shape a fitness function receives
 *  alongside the candidate prompt. */
export type KnobValue = {
  readonly path: ReadonlyArray<string>;
  readonly value: number;
};

/**
 * D43 — a tunable numeric dial: a declared `OPTIMIZABLE_PATHS` entry plus the
 * bounds the SPEC SCHEMA already enforces. The bounds here are a search
 * guard, not the authority: `applySpecPatch` re-parses against the strict
 * schema, so an out-of-bounds value fails safely even if a dial is mis-declared.
 */
export type KnobDial = {
  /** The `OPTIMIZABLE_PATHS` path this dial patches. */
  readonly path: ReadonlyArray<string>;
  /** Current value in the source spec — the search's starting point. */
  readonly value: number;
  /** Inclusive schema bounds. */
  readonly min: number;
  readonly max: number;
  /** One coordinate-ascent step. Must be > 0. */
  readonly step: number;
  /** Whole numbers only (the schema said `z.number().int()`). */
  readonly integer?: boolean;
};

export type Candidate = {
  readonly id: string;
  readonly prompt: string;
  readonly mutations: ReadonlyArray<Mutation>;
  readonly score: number;
  /** D43 — the dial values measured with this candidate's prompt. Absent
   *  when no knobs were declared (every pre-D43 result shape is unchanged). */
  readonly knobs?: ReadonlyArray<KnobValue>;
};

/** Render a dial path for logs/rationales (`evaluation.threshold`). */
export function formatKnobPath(path: ReadonlyArray<string>): string {
  return path.join(".");
}

/** Clamp + round one proposed dial value into its declared bounds. */
export function clampKnob(dial: KnobDial, proposed: number): number {
  const rounded = dial.integer === true ? Math.round(proposed) : proposed;
  const bounded = Math.min(dial.max, Math.max(dial.min, rounded));
  // Float steps accumulate representation noise (0.7 - 0.05 = 0.6499…);
  // snap to 6 decimals so a patched spec carries a value a human recognises.
  return dial.integer === true ? bounded : Number(bounded.toFixed(6));
}

/**
 * D43 — the bounded step for one dial in one direction. Returns `undefined`
 * when the step would leave the value unchanged (already at the rail), so the
 * search never burns an iteration measuring a no-op.
 */
export function stepKnob(
  dial: KnobDial,
  direction: 1 | -1,
  current: number,
): { readonly to: number } | undefined {
  if (!(dial.step > 0) || !Number.isFinite(dial.step)) return undefined;
  const to = clampKnob(dial, current + direction * dial.step);
  if (to === clampKnob(dial, current)) return undefined;
  return { to };
}

/**
 * Per-sample grade detail for one dev-set sample under the candidate
 * prompt being measured. A fitness function MAY return these alongside
 * the aggregate score so a model-driven mutator can see *which* samples
 * failed and *why* (the grader's rationale) instead of guessing from the
 * aggregate alone. Backward-compatible: a fitness fn that returns a bare
 * `number` supplies no grades and the mutator falls back to its
 * dev-set-window heuristic.
 */
export type SampleGrade = {
  /** The input the agent was given for this sample. */
  readonly input: string;
  /** This sample's overall grade, 0..1 (mean across graders). */
  readonly score: number;
  /** The sample's reference answer, when the dataset carries one. */
  readonly expected?: string;
  /** The grader's plain-English rationale (e.g. "[grounded: ✗] no source cited"). */
  readonly rationale?: string;
};

/**
 * Richer fitness return: the aggregate score PLUS optional per-sample
 * grades for the dev set. Returning grades lets a model-driven mutator
 * learn from real failure signal (the grader's rationale on the samples
 * it actually failed). A bare `number` remains valid — the loop
 * normalises both forms.
 */
export type FitnessResult = {
  readonly score: number;
  readonly grades?: ReadonlyArray<SampleGrade>;
  /**
   * Item 9 — where this measurement's eval run was persisted (the CLI's
   * fitness fn reports eval-runner's outDir here). The loop tracks the
   * base prompt's and the current best's dirs so a post-accept consumer
   * (the CLI's regression pinning) can diff the two runs and extract the
   * fail→pass recoveries the winning candidate bought. Optional and
   * purely additive — a fitness fn that omits it changes nothing.
   */
  readonly runDir?: string;
};

/**
 * The fitness seam. D43 added the optional SECOND argument: the candidate's
 * dial values. A fitness function written before D43 takes one parameter and
 * ignores the extra argument (JS arity), so every existing caller is
 * unaffected; a knob-aware caller applies the dials to the spec before
 * measuring. `knobs` is `undefined` whenever no dials were declared.
 */
export type FitnessFn = (
  prompt: string,
  knobs?: ReadonlyArray<KnobValue>,
) => Promise<number | FitnessResult>;

/** Normalise a fitness return to `{ score, grades?, runDir? }` (bare number → neither). */
function normalizeFitness(r: number | FitnessResult): {
  score: number;
  grades?: ReadonlyArray<SampleGrade>;
  runDir?: string;
} {
  if (typeof r === "number") return { score: r };
  return {
    score: r.score,
    ...(r.grades !== undefined ? { grades: r.grades } : {}),
    ...(r.runDir !== undefined ? { runDir: r.runDir } : {}),
  };
}

/**
 * Pillar 2 — the seam that lets `prompt-optimizer-claude` (or any
 * future model-driven mutator) plug into the same search loop the
 * rule-based provider uses. The v0 of this package shipped only
 * rule-based mutations; the L91 comment above flagged model-driven
 * rewriting as the next step. This interface IS that step: a provider
 * just needs to produce a mutated prompt + optional metadata.
 */
export interface MutationProvider {
  /** Stable name for logging + persisted trajectory metadata. */
  readonly name: string;
  /**
   * Generate the next candidate from the current best. The state is
   * a snapshot — providers should not retain it across calls.
   */
  next(state: OptimizerState): Promise<ProviderMutation>;
}

export type OptimizerState = {
  readonly iteration: number;
  readonly best: Candidate;
  /**
   * Per-sample grades for `best.prompt` on the dev set, present when the
   * fitness function returned a `FitnessResult` carrying them. A
   * model-driven mutator reads these to target the samples the current
   * best actually fails (and their grader rationale); undefined when the
   * fitness fn returns a bare number (mutator falls back to its heuristic).
   */
  readonly bestGrades?: ReadonlyArray<SampleGrade>;
  readonly trajectory: ReadonlyArray<Candidate>;
  readonly trainSet: ReadonlyArray<Sample>;
  readonly devSet: ReadonlyArray<Sample>;
  /**
   * D43 — the declared numeric dials, with `value` reflecting the CURRENT
   * best (coordinate ascent walks from where the search already is). Absent
   * when the caller declared none.
   */
  readonly knobs?: ReadonlyArray<KnobDial>;
};

export type ProviderMutation = {
  /** The proposed new prompt. */
  readonly prompt: string;
  /**
   * D43 — the dial values this proposal wants measured. Omitted (every
   * pre-D43 provider, and every prompt-only proposal) means "carry the
   * current best's knobs unchanged", so an existing MutationProvider needs
   * no edit and behaves exactly as before.
   */
  readonly knobs?: ReadonlyArray<KnobValue>;
  /** Structured record of what changed; persisted for audit. */
  readonly mutations: ReadonlyArray<Mutation>;
  /** Optional human-readable rationale (the Claude provider sets this). */
  readonly rationale?: string;
  /**
   * Per-call model token usage for THIS mutation, surfaced so a
   * cost-gating orchestrator (FR-003 `--budget-usd`) can fold the
   * call's actual spend into a running total. A model-backed provider
   * (e.g. `prompt-optimizer-claude`) sets this from the response's
   * token counts; the rule-based provider leaves it undefined (it
   * issues no model call → zero cost). This field is purely additive
   * and never affects the search itself.
   */
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
  };
};

export type OptimizeOptions = {
  /** Pass `train` and `dev` from §29 dataset-registry. */
  readonly trainSet: ReadonlyArray<Sample>;
  readonly devSet: ReadonlyArray<Sample>;
  readonly fitness: FitnessFn;
  /** Number of candidate mutations to explore. Default: 10. */
  readonly iterations?: number;
  /** Minimum improvement to accept the new best. Default: 0.01. */
  readonly improvementThreshold?: number;
  /** Deterministic RNG seed. Default: 0xCAFE. */
  readonly seed?: number;
  /** Optional run id to namespace persistence. */
  readonly runId?: string;
  /** Optional persistence root (default: `.crewhaus/prompt-optimizer/<runId>`). */
  readonly outDir?: string;
  /**
   * Mutation set for the default rule-based provider. Default:
   * `["rephrase-instruction", "add-few-shot", "swap-example",
   * "add-COT-prefix"]`. Pass a subset to constrain. Ignored when a
   * `mutator` is supplied.
   */
  readonly mutations?: ReadonlyArray<Mutation["kind"]>;
  /**
   * Pluggable mutator. Default: a `RuleBasedMutationProvider` seeded
   * with `seed`. The `crewhaus optimize --mutator claude` CLI swaps
   * in `prompt-optimizer-claude`'s `ClaudeMutationProvider`.
   */
  readonly mutator?: MutationProvider;
  /**
   * D43 — the numeric dials the default rule-based provider may step. Each
   * entry must be a declared `OPTIMIZABLE_PATHS` path with the spec schema's
   * bounds. Omitted (the default) keeps the search prompt-only and every
   * result byte-identical to the pre-D43 behavior.
   */
  readonly knobs?: ReadonlyArray<KnobDial>;
};

export type OptimizeResult = {
  readonly best: Candidate;
  readonly improvement: number;
  readonly trajectory: ReadonlyArray<Candidate>;
  /** Item 9 — eval-run dir of the base prompt's measurement, when the fitness fn reported one. */
  readonly baseRunDir?: string;
  /** Item 9 — eval-run dir of the returned best's measurement, when the fitness fn reported one. */
  readonly bestRunDir?: string;
  /** D43 — the winning dial values, present only when knobs were declared.
   *  Callers turn these into `OPTIMIZABLE_PATHS` spec patches. */
  readonly knobs?: ReadonlyArray<KnobValue>;
};

const DEFAULT_MUTATIONS: ReadonlyArray<Mutation["kind"]> = [
  "rephrase-instruction",
  "add-few-shot",
  "swap-example",
  "add-COT-prefix",
];

/**
 * Mutate a prompt according to the chosen mutation. The mutations are
 * conservative — they preserve the original instruction and append /
 * adjust around it. Real-world prompt tuners (DSPy, OPRO) use
 * model-driven rewriting; v0 of this module ships rule-based mutations
 * to keep tests deterministic. The hook to swap in model-driven
 * mutations lives in the next iteration.
 */
export function applyMutation(prompt: string, m: Mutation): string {
  switch (m.kind) {
    case "rephrase-instruction": {
      // Append a clarifying sentence rather than rewriting in place — keeps the
      // mutation deterministic and reversible.
      return `${prompt}\n\nBe concise and direct.`;
    }
    case "add-few-shot": {
      const exampleBlock = `\n\nExample:\nInput: ${m.sample.input}\nExpected output: ${m.sample.expected_output ?? "(no expected output)"}`;
      return `${prompt}${exampleBlock}`;
    }
    case "swap-example": {
      // Swap the old sample's input for the new sample's input in the prompt.
      // Falls back to append when the old sample isn't textually present.
      const search = `Input: ${m.oldSample.input}`;
      const replace = `Input: ${m.newSample.input}\nExpected output: ${m.newSample.expected_output ?? ""}`;
      if (prompt.includes(search)) return prompt.replace(search, replace);
      return `${prompt}\n\nExample:\nInput: ${m.newSample.input}\nExpected output: ${m.newSample.expected_output ?? ""}`;
    }
    case "add-COT-prefix": {
      const prefix = "Think step by step before answering.\n\n";
      if (prompt.startsWith(prefix)) return prompt;
      return `${prefix}${prompt}`;
    }
    case "knob-step": {
      // D43 — a knob step edits the SPEC, never the prompt. The dial values
      // travel on `ProviderMutation.knobs` / `Candidate.knobs`; the prompt
      // passes through untouched so a knob candidate is measured against the
      // same instructions the current best carries.
      return prompt;
    }
  }
}

/**
 * The deterministic rule-based provider — the v0 default that ships
 * in this package. Picks a mutation kind via a seeded xorshift RNG,
 * applies it to the current-best prompt, returns the result. The
 * existing 4 mutation kinds (`rephrase-instruction`, `add-few-shot`,
 * `swap-example`, `add-COT-prefix`) live here verbatim — the
 * refactor extracted them from `optimize()` so a future provider
 * (Pillar 2: `prompt-optimizer-claude`) can plug in without breaking
 * the deterministic test harness.
 */
export class RuleBasedMutationProvider implements MutationProvider {
  readonly name = "rule-based";
  private readonly rng: () => number;
  private readonly mutationKinds: ReadonlyArray<Mutation["kind"]>;
  /** D43 — round-robin cursor over the declared dials, so a multi-dial
   *  search visits every knob instead of re-rolling the same one. */
  private knobCursor = 0;
  constructor(opts: { seed?: number; mutations?: ReadonlyArray<Mutation["kind"]> } = {}) {
    this.rng = makeXorshift(opts.seed ?? 0xcafe);
    this.mutationKinds = opts.mutations ?? DEFAULT_MUTATIONS;
  }

  /**
   * D43 — coordinate ascent over the declared dials: one bounded ± step on
   * ONE dial per proposal, alternating direction, prompt untouched. Returns
   * `undefined` when no dial can move (none declared, or every one is at a
   * rail), so the caller falls back to a prompt mutation and the search never
   * stalls.
   */
  private proposeKnobStep(state: OptimizerState): ProviderMutation | undefined {
    const dials = state.knobs ?? [];
    if (dials.length === 0) return undefined;
    const current = new Map(state.knobs?.map((d) => [formatKnobPath(d.path), d.value]) ?? []);
    // Try each dial once, starting at the cursor, in both directions.
    for (let attempt = 0; attempt < dials.length; attempt += 1) {
      const dial = dials[(this.knobCursor + attempt) % dials.length];
      if (dial === undefined) continue;
      const from = current.get(formatKnobPath(dial.path)) ?? dial.value;
      // The seeded RNG picks which direction is tried first; both are tried,
      // so a dial at a rail still moves inward instead of being skipped.
      const first: 1 | -1 = this.rng() < 0.5 ? 1 : -1;
      for (const direction of [first, first === 1 ? -1 : 1] as ReadonlyArray<1 | -1>) {
        const stepped = stepKnob(dial, direction, from);
        if (stepped === undefined) continue;
        this.knobCursor = (this.knobCursor + attempt + 1) % dials.length;
        const knobs: KnobValue[] = dials.map((d) => {
          const path = formatKnobPath(d.path);
          return {
            path: d.path,
            value: path === formatKnobPath(dial.path) ? stepped.to : (current.get(path) ?? d.value),
          };
        });
        return {
          prompt: state.best.prompt,
          mutations: [{ kind: "knob-step", path: dial.path, from, to: stepped.to }],
          knobs,
          rationale: `${formatKnobPath(dial.path)}: ${from} to ${stepped.to}`,
        };
      }
    }
    return undefined;
  }

  async next(state: OptimizerState): Promise<ProviderMutation> {
    // D43 — with dials declared, alternate knob steps and prompt rewrites so
    // the search covers both axes; without them the provider is exactly the
    // pre-D43 prompt-only mutator.
    if ((state.knobs?.length ?? 0) > 0 && state.iteration % 2 === 0) {
      const knobProposal = this.proposeKnobStep(state);
      if (knobProposal !== undefined) return knobProposal;
    }
    const kind =
      this.mutationKinds[Math.floor(this.rng() * this.mutationKinds.length)] ??
      "rephrase-instruction";
    // Safe: optimize() validated trainSet.length > 0 above.
    const firstTrain = state.trainSet[0] as (typeof state.trainSet)[number];
    let mutation: Mutation;
    if (kind === "add-few-shot") {
      mutation = {
        kind,
        sample: state.trainSet[Math.floor(this.rng() * state.trainSet.length)] ?? firstTrain,
      };
    } else if (kind === "swap-example") {
      mutation = {
        kind,
        oldSample: state.trainSet[Math.floor(this.rng() * state.trainSet.length)] ?? firstTrain,
        newSample: state.trainSet[Math.floor(this.rng() * state.trainSet.length)] ?? firstTrain,
      };
    } else if (kind === "rephrase-instruction") {
      mutation = { kind };
    } else {
      mutation = { kind: "add-COT-prefix" };
    }
    return {
      prompt: applyMutation(state.best.prompt, mutation),
      mutations: [mutation],
    };
  }
}

/**
 * Run an iterative search; each iteration delegates to the configured
 * `MutationProvider` (default: `RuleBasedMutationProvider` seeded with
 * `opts.seed`), measures fitness on the dev set via the caller-supplied
 * `fitness` function, and keeps the best.
 */
export async function optimize(basePrompt: string, opts: OptimizeOptions): Promise<OptimizeResult> {
  if (opts.trainSet.length === 0) {
    throw new PromptOptimizerError("optimize: trainSet must contain at least one sample");
  }
  if (opts.devSet.length === 0) {
    throw new PromptOptimizerError("optimize: devSet must contain at least one sample");
  }
  const iterations = opts.iterations ?? 10;
  const runId = opts.runId ?? `opt_${Date.now().toString(16)}`;

  const mutator: MutationProvider =
    opts.mutator ??
    new RuleBasedMutationProvider({
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.mutations !== undefined ? { mutations: opts.mutations } : {}),
    });

  // D43 — the dial state the search walks. Undefined (no declared knobs)
  // keeps every `fitness` call single-argument and every candidate/result
  // shape byte-identical to the pre-D43 behavior.
  const dials = opts.knobs ?? [];
  const knobsDeclared = dials.length > 0;
  const baseKnobs: ReadonlyArray<KnobValue> | undefined = knobsDeclared
    ? dials.map((d) => ({ path: d.path, value: clampKnob(d, d.value) }))
    : undefined;

  const base = normalizeFitness(await opts.fitness(basePrompt, baseKnobs));
  const baseScore = base.score;
  const baseCandidate: Candidate = {
    id: "candidate-0",
    prompt: basePrompt,
    mutations: [],
    score: baseScore,
    ...(baseKnobs !== undefined ? { knobs: baseKnobs } : {}),
  };
  const trajectory: Candidate[] = [baseCandidate];
  let best: Candidate = baseCandidate;
  // Per-sample grades for the CURRENT best prompt — surfaced to the
  // mutator so it can target the samples `best` actually fails. Updated
  // whenever `best` is replaced (below) so the signal always describes
  // the prompt being mutated, not a stale earlier candidate.
  let bestGrades: ReadonlyArray<SampleGrade> | undefined = base.grades;
  // Item 9 — persisted eval-run dirs for the base measurement and the
  // current best's measurement, tracked in lockstep with `best` so a
  // post-accept consumer can diff exactly the two runs that produced
  // `improvement`. Both stay undefined for fitness fns that don't report.
  const baseRunDir = base.runDir;
  let bestRunDir = base.runDir;

  for (let i = 1; i <= iterations; i++) {
    // D43 — the dials handed to the mutator carry the CURRENT best's values,
    // so coordinate ascent walks from where the search already is.
    const bestKnobByPath = new Map(
      (best.knobs ?? []).map((k) => [formatKnobPath(k.path), k.value]),
    );
    const state: OptimizerState = {
      iteration: i,
      best,
      ...(bestGrades !== undefined ? { bestGrades } : {}),
      trajectory,
      trainSet: opts.trainSet,
      devSet: opts.devSet,
      ...(knobsDeclared
        ? {
            knobs: dials.map((d) => ({
              ...d,
              value: bestKnobByPath.get(formatKnobPath(d.path)) ?? clampKnob(d, d.value),
            })),
          }
        : {}),
    };
    const proposal = await mutator.next(state);
    // A prompt-only proposal (and every pre-D43 provider) inherits the
    // current best's dial values verbatim.
    const candidateKnobs = knobsDeclared ? (proposal.knobs ?? best.knobs) : undefined;
    const measured = normalizeFitness(await opts.fitness(proposal.prompt, candidateKnobs));
    const score = measured.score;
    const candidate: Candidate = {
      id: `candidate-${i}`,
      prompt: proposal.prompt,
      mutations: [...best.mutations, ...proposal.mutations],
      score,
      ...(candidateKnobs !== undefined ? { knobs: candidateKnobs } : {}),
    };
    trajectory.push(candidate);
    if (score > best.score) {
      best = candidate;
      bestGrades = measured.grades;
      bestRunDir = measured.runDir;
    }
  }

  if (opts.outDir) {
    const dir = join(opts.outDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trajectory.json"), JSON.stringify(trajectory, null, 2), {
      mode: 0o600,
    });
    writeFileSync(join(dir, "best.json"), JSON.stringify(best, null, 2), { mode: 0o600 });
  }

  return {
    best,
    improvement: best.score - baseScore,
    trajectory,
    ...(baseRunDir !== undefined ? { baseRunDir } : {}),
    ...(bestRunDir !== undefined ? { bestRunDir } : {}),
    ...(best.knobs !== undefined ? { knobs: best.knobs } : {}),
  };
}

function makeXorshift(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return Math.abs(s) / 0x7fffffff;
  };
}

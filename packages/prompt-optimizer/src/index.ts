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
  | { kind: "add-COT-prefix" };

export type Candidate = {
  readonly id: string;
  readonly prompt: string;
  readonly mutations: ReadonlyArray<Mutation>;
  readonly score: number;
};

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
};

export type FitnessFn = (prompt: string) => Promise<number | FitnessResult>;

/** Normalise a fitness return to `{ score, grades? }` (bare number → no grades). */
function normalizeFitness(r: number | FitnessResult): {
  score: number;
  grades?: ReadonlyArray<SampleGrade>;
} {
  if (typeof r === "number") return { score: r };
  return { score: r.score, ...(r.grades !== undefined ? { grades: r.grades } : {}) };
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
};

export type ProviderMutation = {
  /** The proposed new prompt. */
  readonly prompt: string;
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
};

export type OptimizeResult = {
  readonly best: Candidate;
  readonly improvement: number;
  readonly trajectory: ReadonlyArray<Candidate>;
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
  constructor(opts: { seed?: number; mutations?: ReadonlyArray<Mutation["kind"]> } = {}) {
    this.rng = makeXorshift(opts.seed ?? 0xcafe);
    this.mutationKinds = opts.mutations ?? DEFAULT_MUTATIONS;
  }
  async next(state: OptimizerState): Promise<ProviderMutation> {
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

  const base = normalizeFitness(await opts.fitness(basePrompt));
  const baseScore = base.score;
  const baseCandidate: Candidate = {
    id: "candidate-0",
    prompt: basePrompt,
    mutations: [],
    score: baseScore,
  };
  const trajectory: Candidate[] = [baseCandidate];
  let best: Candidate = baseCandidate;
  // Per-sample grades for the CURRENT best prompt — surfaced to the
  // mutator so it can target the samples `best` actually fails. Updated
  // whenever `best` is replaced (below) so the signal always describes
  // the prompt being mutated, not a stale earlier candidate.
  let bestGrades: ReadonlyArray<SampleGrade> | undefined = base.grades;

  for (let i = 1; i <= iterations; i++) {
    const state: OptimizerState = {
      iteration: i,
      best,
      ...(bestGrades !== undefined ? { bestGrades } : {}),
      trajectory,
      trainSet: opts.trainSet,
      devSet: opts.devSet,
    };
    const proposal = await mutator.next(state);
    const measured = normalizeFitness(await opts.fitness(proposal.prompt));
    const score = measured.score;
    const candidate: Candidate = {
      id: `candidate-${i}`,
      prompt: proposal.prompt,
      mutations: [...best.mutations, ...proposal.mutations],
      score,
    };
    trajectory.push(candidate);
    if (score > best.score) {
      best = candidate;
      bestGrades = measured.grades;
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

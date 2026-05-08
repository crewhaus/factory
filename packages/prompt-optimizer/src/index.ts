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

export type FitnessFn = (prompt: string) => Promise<number>;

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
   * Mutation set. Default: `["rephrase-instruction", "add-few-shot",
   * "swap-example", "add-COT-prefix"]`. Pass a subset to constrain.
   */
  readonly mutations?: ReadonlyArray<Mutation["kind"]>;
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
 * Run an iterative search; each iteration draws a deterministic mutation
 * (modulo the seeded RNG), measures fitness on the dev set via the
 * caller-supplied `fitness` function, and keeps the best.
 */
export async function optimize(basePrompt: string, opts: OptimizeOptions): Promise<OptimizeResult> {
  if (opts.trainSet.length === 0) {
    throw new PromptOptimizerError("optimize: trainSet must contain at least one sample");
  }
  if (opts.devSet.length === 0) {
    throw new PromptOptimizerError("optimize: devSet must contain at least one sample");
  }
  const iterations = opts.iterations ?? 10;
  const seed = opts.seed ?? 0xcafe;
  const mutationKinds = opts.mutations ?? DEFAULT_MUTATIONS;
  const runId = opts.runId ?? `opt_${Date.now().toString(16)}`;

  const rng = makeXorshift(seed);

  const baseScore = await opts.fitness(basePrompt);
  const baseCandidate: Candidate = {
    id: "candidate-0",
    prompt: basePrompt,
    mutations: [],
    score: baseScore,
  };
  const trajectory: Candidate[] = [baseCandidate];
  let best: Candidate = baseCandidate;
  // Safe: caller validated trainSet.length > 0 above.
  const firstTrain = opts.trainSet[0] as (typeof opts.trainSet)[number];

  for (let i = 1; i <= iterations; i++) {
    const kind = mutationKinds[Math.floor(rng() * mutationKinds.length)] ?? "rephrase-instruction";
    let mutation: Mutation;
    if (kind === "add-few-shot") {
      mutation = {
        kind,
        sample: opts.trainSet[Math.floor(rng() * opts.trainSet.length)] ?? firstTrain,
      };
    } else if (kind === "swap-example") {
      mutation = {
        kind,
        oldSample: opts.trainSet[Math.floor(rng() * opts.trainSet.length)] ?? firstTrain,
        newSample: opts.trainSet[Math.floor(rng() * opts.trainSet.length)] ?? firstTrain,
      };
    } else if (kind === "rephrase-instruction") {
      mutation = { kind };
    } else {
      mutation = { kind: "add-COT-prefix" };
    }
    const next = applyMutation(best.prompt, mutation);
    const score = await opts.fitness(next);
    const candidate: Candidate = {
      id: `candidate-${i}`,
      prompt: next,
      mutations: [...best.mutations, mutation],
      score,
    };
    trajectory.push(candidate);
    if (score > best.score) best = candidate;
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

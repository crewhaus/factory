/**
 * Track D (§55) — `tool-harness-synthesizer`. Thompson-sampled tree
 * search over candidate verifier functions for skills and tools.
 *
 * Source: AutoHarness (Lou et al., Google DeepMind, March 2026,
 * arxiv 2603.03329). The paper's headline finding: a smaller LLM
 * (Gemini-2.5-Flash) plus a synthesized code harness beats a larger
 * LLM (Gemini-2.5-Pro) at near-zero inference cost. The trick is to
 * have the LLM synthesize TWO functions iteratively, with the
 * environment as critic:
 *
 *   - `propose_action(obs)` — candidate generator
 *   - `is_legal_action(obs, action)` — verifier
 *
 * If the verifier returns `True` but the action is invalid, refine
 * BOTH functions; if it returns `False` and the action is invalid,
 * refine only the proposer. This split-refinement is the empirical
 * winning move.
 *
 * In CrewHaus, the equivalent is to synthesize verifier code per
 * skill or tool: an `is_valid_output(input, output)` function for any
 * tool that has objective validity criteria. The verifier becomes a
 * reusable artifact under `.crewhaus/verifiers/<name>.ts` and feeds
 * into the `eval-optimizer-orchestrator` via a `MutationProvider`
 * variant that proposes verifier-aware prompt edits.
 *
 * v0 ships:
 *   - `synthesizeVerifier(spec)` — tree search over candidate verifier
 *     code strings (the LLM call is supplied by the caller so this
 *     package stays pure with respect to the model)
 *   - `thompsonPick(nodes)` — Thompson sampling over tree nodes
 *   - `VerifierMutationProvider` — adapter to plug verifier search
 *     into the existing optimizer
 *   - `runVerifier(code, samples)` — scores a candidate by running it
 *     inside a locked-down `@crewhaus/sandbox` container; the candidate
 *     code never executes on this host (see its SECURITY note).
 *
 * Cited paper: AutoHarness (arxiv 2603.03329, Lou et al., 2026-03).
 */
import { CrewhausError } from "@crewhaus/errors";
import type {
  MutationProvider,
  OptimizerState,
  ProviderMutation,
} from "@crewhaus/prompt-optimizer";
import { type Sandbox, createSandbox } from "@crewhaus/sandbox";
import { runVerifierInSandbox } from "./sandboxed-eval";

export class HarnessSynthesizerError extends CrewhausError {
  override readonly name = "HarnessSynthesizerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * One sample of behavior the verifier should be measured against.
 * `expected` is whether the verifier should accept (true) or reject
 * (false) this sample. Both classes are required for non-degenerate
 * search — a verifier that returns `true` for everything passes the
 * `expected: true` set perfectly.
 *
 * NOTE: `input`/`output` cross an isolation boundary (see `runVerifier`)
 * and are marshaled as JSON, so they must be JSON-serializable. The
 * verifier observes structured copies, not live host references — an
 * intentional consequence of running it out-of-process.
 */
export type VerifierSample = {
  readonly input: unknown;
  readonly output: unknown;
  readonly expected: boolean;
};

/**
 * A candidate verifier — a code string + the per-sample score it
 * achieved on the last evaluation. `code` is a function body string
 * with the signature `(input: unknown, output: unknown) => boolean`.
 * It's stored as a string so the search can mutate it and feed it
 * back to the LLM.
 *
 * SECURITY: `code` is attacker-influenceable (caller seed candidates +
 * refiner output, which a future model-backed refiner derives from
 * skill/tool I/O that can carry injected content). It is NEVER compiled
 * or invoked on this host. Execution happens via `runVerifier`, which
 * evaluates the candidate inside a locked-down `@crewhaus/sandbox`
 * container with no ambient authority — see the SECURITY note on
 * `runVerifier`.
 */
export type VerifierCandidate = {
  readonly id: string;
  readonly code: string;
  readonly score: number;
  /** AutoHarness's heuristic value — average over samples, in [0, 1]. */
  readonly heuristic: number;
  /** Beta posterior parameters for Thompson sampling. */
  readonly alpha: number;
  readonly beta: number;
};

/**
 * The Refiner: takes a failing candidate + concrete failure cases and
 * returns a new code string. In production, this is a model call; for
 * testing it's a deterministic rule-based mutation. Either way, the
 * signature is the same.
 *
 * SECURITY: the string this returns is executed (in isolation — see
 * `runVerifier`), so a model-backed refiner is effectively running
 * model output as code. The container is the trust boundary, NOT the
 * model — never relax `runVerifier`'s isolation on the assumption that
 * refiner output is trustworthy.
 */
export type RefinerFn = (
  current: VerifierCandidate,
  failures: ReadonlyArray<VerifierSample>,
) => Promise<string>;

/** Isolation options shared by `runVerifier` and the inner search. */
export type RunVerifierOptions = {
  /**
   * Isolation backend. Defaults to `createSandbox()` (honors the
   * `CREWHAUS_SANDBOX` env; `docker` by default). The non-isolating
   * `noop` backend is REFUSED — see the SECURITY note on `runVerifier`.
   */
  readonly sandbox?: Sandbox;
  /** Per-evaluation wall-clock budget (ms). Default: 10_000. */
  readonly timeoutMs?: number;
  /** Container image. Default: `node:22-alpine` (on the sandbox allowlist). */
  readonly image?: string;
};

/**
 * The Critic: runs `code` against a sample set and returns the per-
 * sample verdict and the heuristic value. Deterministic given the same
 * code + samples (modulo the verifier's own determinism).
 *
 * SECURITY (FR-007): `code` is untrusted and is NOT run in this process.
 * `runVerifier` ships `{ code, samples }` to a locked-down
 * `@crewhaus/sandbox` container (`--network none`, `--read-only`, no
 * host env, cpu/mem caps, wall-clock kill, `no-new-privileges`) and
 * scores the returned verdicts here on the host — the container never
 * receives `expected`. Inside the jail the candidate is compiled with
 * the runtime's dynamic-function constructor and invoked over the
 * samples; an exfiltration/RCE attempt (e.g. a refiner emitting a
 * network call) is contained by the jail. FAIL CLOSED: when no real
 * isolation backend is available (the `noop` backend, or none),
 * `runVerifier` throws rather than executing untrusted code unsandboxed,
 * mirroring the `requiresSandbox` floor enforced elsewhere in the repo.
 *
 * Behavior contract: per-sample runtime errors are caught (verdict
 * `false`, `errors++`), matching the prior in-process semantics. Code
 * that fails to compile, times out, or otherwise crashes the harness
 * throws a `HarnessSynthesizerError`.
 */
export async function runVerifier(
  code: string,
  samples: ReadonlyArray<VerifierSample>,
  opts: RunVerifierOptions = {},
): Promise<{
  readonly verdicts: ReadonlyArray<boolean>;
  readonly heuristic: number;
  readonly errors: number;
}> {
  const ownsSandbox = opts.sandbox === undefined;
  const sandbox = opts.sandbox ?? createSandbox();
  try {
    // FR-007 — fail closed: never run untrusted verifier code without
    // a real isolation boundary.
    if (sandbox.backend === "noop") {
      throw new HarnessSynthesizerError(
        "refusing to evaluate verifier code in a noop sandbox (no isolation); set CREWHAUS_SANDBOX=docker|podman",
      );
    }
    return await runVerifierInSandbox(sandbox, code, samples, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.image !== undefined ? { image: opts.image } : {}),
    });
  } finally {
    if (ownsSandbox) await sandbox.close();
  }
}

/**
 * Thompson sampling over a node population. Picks the index whose
 * posterior sample is highest. Each node has a Beta(alpha, beta)
 * posterior over its heuristic value; the alpha/beta are accumulated
 * across iterations as the search refines.
 */
export function thompsonPick(
  nodes: ReadonlyArray<VerifierCandidate>,
  rng: () => number = Math.random,
): number {
  if (nodes.length === 0) throw new HarnessSynthesizerError("thompsonPick called on empty list");
  let bestIdx = 0;
  let bestSample = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n === undefined) continue;
    const sample = betaSample(n.alpha, n.beta, rng);
    if (sample > bestSample) {
      bestSample = sample;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Quick-and-deterministic Beta sample using two gamma samples
 * (Marsaglia–Tsang). For the sizes we deal with (alpha, beta < 100),
 * the approximation is fast and stable.
 */
function betaSample(a: number, b: number, rng: () => number): number {
  const x = gammaSample(a, rng);
  const y = gammaSample(b, rng);
  return x / (x + y);
}

function gammaSample(shape: number, rng: () => number): number {
  // For shape >= 1 use Marsaglia-Tsang; for shape < 1 use Ahrens-Dieter.
  if (shape < 1) {
    // Use shape+1 then transform by U^(1/shape).
    const x = gammaSample(shape + 1, rng);
    const u = Math.max(rng(), 1e-12);
    return x * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Loop until a valid sample.
  for (let i = 0; i < 64; i++) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.max(rng(), 1e-12);
      const u2 = Math.max(rng(), 1e-12);
      // Box-Muller for standard normal.
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Fallback — extremely rare. Return the deterministic mean.
  return shape;
}

export type SynthesizeOptions = {
  /** Initial seed candidates. Must be non-empty; provides the starting tree. */
  readonly seedCandidates: ReadonlyArray<string>;
  /** Samples the verifier is scored against. */
  readonly samples: ReadonlyArray<VerifierSample>;
  /** The refiner — usually an LLM-backed function. */
  readonly refiner: RefinerFn;
  /** Maximum tree-search iterations. Default: 16 (paper's median is ~14). */
  readonly maxIterations?: number;
  /** Target heuristic value — stop when reached. Default: 1.0 (100% correct). */
  readonly target?: number;
  /** RNG for Thompson sampling. Default: Math.random. */
  readonly rng?: () => number;
  /**
   * Isolation backend reused across every evaluation in the inner search.
   * Defaults to one `createSandbox()` per call (closed when the search
   * ends). See `runVerifier` for the isolation/fail-closed contract.
   */
  readonly sandbox?: Sandbox;
  /** Per-evaluation wall-clock budget (ms) forwarded to `runVerifier`. */
  readonly timeoutMs?: number;
};

export type SynthesizeResult = {
  readonly best: VerifierCandidate;
  readonly iterations: number;
  readonly converged: boolean;
  readonly trajectory: ReadonlyArray<VerifierCandidate>;
};

/**
 * Run the tree search. Returns the best candidate found, the
 * iteration count, and whether the target heuristic was reached.
 * Pure with respect to randomness: pass `rng` for determinism.
 *
 * One isolation backend is created (or reused, if `opts.sandbox` is
 * supplied) for the whole search and closed on exit — see `runVerifier`.
 */
export async function synthesizeVerifier(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  if (opts.seedCandidates.length === 0) {
    throw new HarnessSynthesizerError("at least one seed candidate is required");
  }
  if (opts.samples.length === 0) {
    throw new HarnessSynthesizerError("at least one sample is required to score the verifier");
  }
  const target = opts.target ?? 1.0;
  const rng = opts.rng ?? Math.random;
  const maxIter = opts.maxIterations ?? 16;

  // One isolation backend reused across the whole inner search; close it
  // on exit only if we created it (the caller owns an injected one).
  const ownsSandbox = opts.sandbox === undefined;
  const sandbox = opts.sandbox ?? createSandbox();
  const runOpts: RunVerifierOptions = {
    sandbox,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  try {
    // Initialize the candidate pool from seeds.
    const pool: VerifierCandidate[] = [];
    for (let i = 0; i < opts.seedCandidates.length; i++) {
      const code = opts.seedCandidates[i] as string;
      const { heuristic } = await runVerifier(code, opts.samples, runOpts);
      pool.push({
        id: `seed_${i}`,
        code,
        score: heuristic,
        heuristic,
        // Beta starts uniform; update with observed correct/incorrect counts.
        alpha: 1 + Math.round(heuristic * opts.samples.length),
        beta: 1 + Math.round((1 - heuristic) * opts.samples.length),
      });
    }
    const trajectory: VerifierCandidate[] = [...pool];

    // Early exit if a seed already satisfies the target.
    let best = pool.reduce((a, b) => (a.heuristic >= b.heuristic ? a : b));
    if (best.heuristic >= target) {
      return { best, iterations: 0, converged: true, trajectory };
    }

    for (let iter = 0; iter < maxIter; iter++) {
      const pickIdx = thompsonPick(pool, rng);
      const parent = pool[pickIdx] as VerifierCandidate;
      // Compute concrete failures for the refiner.
      const { verdicts } = await runVerifier(parent.code, opts.samples, runOpts);
      const failures: VerifierSample[] = [];
      for (let i = 0; i < opts.samples.length; i++) {
        const s = opts.samples[i] as VerifierSample;
        const v = verdicts[i] as boolean;
        if (v !== s.expected) failures.push(s);
      }
      let newCode: string;
      try {
        newCode = await opts.refiner(parent, failures);
      } catch (err) {
        throw new HarnessSynthesizerError(
          `refiner threw on iteration ${iter}: ${(err as Error).message}`,
          err,
        );
      }
      const { heuristic } = await runVerifier(newCode, opts.samples, runOpts);
      const child: VerifierCandidate = {
        id: `cand_${iter}`,
        code: newCode,
        score: heuristic,
        heuristic,
        alpha: 1 + Math.round(heuristic * opts.samples.length),
        beta: 1 + Math.round((1 - heuristic) * opts.samples.length),
      };
      pool.push(child);
      trajectory.push(child);
      if (heuristic > best.heuristic) best = child;
      if (best.heuristic >= target) {
        return { best, iterations: iter + 1, converged: true, trajectory };
      }
    }
    return { best, iterations: maxIter, converged: false, trajectory };
  } finally {
    if (ownsSandbox) await sandbox.close();
  }
}

/**
 * `MutationProvider` adapter so verifier search can drop into the
 * existing eval-optimizer-orchestrator loop. The provider's `next()`
 * runs one iteration of the inner tree search and emits a
 * prompt-edit that references the synthesized verifier.
 *
 * Typical wiring (programmatic): construct this provider with the
 * spec's skill samples and a `refiner` function, then pass it to
 * `optimizeSpec({ mutator: new VerifierMutationProvider(...) })`. The
 * orchestrator runs the standard search loop, but each "mutation" is
 * a freshly-synthesized verifier persisted to .crewhaus/verifiers/.
 * (CLI `--mutator verifier-synthesis` wiring is a follow-up; the CLI
 * today exposes `rule-based` and `claude` only.)
 *
 * SECURITY: the inner search executes refiner-produced code. Pass a
 * `sandbox` (or rely on the default) — `synthesizeVerifier`/`runVerifier`
 * isolate every evaluation and fail closed without a real backend. A
 * model-backed `refiner` is only safe to wire because of that jail.
 */
export class VerifierMutationProvider implements MutationProvider {
  readonly name = "verifier-synthesis";
  private synthesisIterations = 0;

  constructor(
    private readonly samples: ReadonlyArray<VerifierSample>,
    private readonly refiner: RefinerFn,
    private readonly seedCandidates: ReadonlyArray<string>,
    private readonly maxInnerIterations: number = 4,
    private readonly sandbox?: Sandbox,
  ) {}

  async next(state: OptimizerState): Promise<ProviderMutation> {
    this.synthesisIterations++;
    const result = await synthesizeVerifier({
      seedCandidates: this.seedCandidates,
      samples: this.samples,
      refiner: this.refiner,
      maxIterations: this.maxInnerIterations,
      ...(this.sandbox !== undefined ? { sandbox: this.sandbox } : {}),
    });
    const annotation = `\n\n[verifier ${result.best.id}, h=${result.best.heuristic.toFixed(3)}]`;
    return {
      prompt: state.best.prompt + annotation,
      mutations: [{ kind: "rephrase-instruction" }],
      rationale: `verifier-synthesis pass ${this.synthesisIterations}: ${result.best.id} reached heuristic ${result.best.heuristic.toFixed(3)} in ${result.iterations} inner iterations${result.converged ? " (converged)" : ""}`,
    };
  }
}

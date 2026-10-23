/**
 * The `proven` rung's re-check (design §6.4; `VerifyOptions.recheckProof`):
 * the statement and proof a stored artifact holds, checked again by the
 * builtin checker before the artifact backs a claim.
 *
 * An artifact is a file in the workspace. The verifier already requires the
 * run's own `ProofCheck` call that wrote it, with the input it was given;
 * this is the second, independent reading: the checker itself, run on what
 * the file says now. Only the builtin is re-run — it is pure, needs no
 * sandbox, runs on a worker thread and is bounded by `formal.timeoutMs`. The
 * sandbox checkers start a container per check, so their artifacts rest on
 * the logged call alone.
 *
 * A re-check that stops without a verdict (cancelled, out of time, the
 * checker failing) is not a verdict: it returns `undefined`, and the
 * verifier falls back to the logged call.
 */
import {
  BUILTIN_CHECKER_ID,
  type ProofChecker,
  createBuiltinChecker,
  stoppedWithoutVerdict,
} from "@crewhaus/proof-checker";
import type { ProofArtifact, RecheckedProof } from "@crewhaus/provability";

export type RecheckProofOptions = {
  /** The check's budget: the spec's `formal.timeoutMs`. */
  readonly timeoutMs: number;
  /** The turn's signal: an aborted turn re-checks nothing. */
  readonly signal?: AbortSignal;
  /** The builtin checker to run (tests). Default: one shared builtin. */
  readonly checker?: ProofChecker;
};

let shared: ProofChecker | undefined;

/** Re-check `artifact` with the builtin checker (see the module doc). */
export async function recheckProof(
  artifact: ProofArtifact,
  opts: RecheckProofOptions,
): Promise<RecheckedProof | undefined> {
  if (artifact.checker !== BUILTIN_CHECKER_ID) return undefined;
  // Read afresh each time: the turn may end while the check runs.
  const aborted = (): boolean => opts.signal?.aborted === true;
  if (aborted()) return undefined;
  shared ??= createBuiltinChecker();
  const checker = opts.checker ?? shared;
  const result = await checker.check({
    claim: artifact.claim,
    statement: artifact.statement,
    proof: artifact.proof,
    timeoutMs: opts.timeoutMs,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (result.ok) {
    return { ok: true, assumptions: [...result.assumptions], axioms: [...result.axioms] };
  }
  if (aborted() || stoppedWithoutVerdict(result)) return undefined;
  return { ok: false };
}

/** A `VerifyOptions.recheckProof` over {@link recheckProof} with these options. */
export function proofRecheck(
  opts: RecheckProofOptions,
): (artifact: ProofArtifact) => Promise<RecheckedProof | undefined> {
  return (artifact) => recheckProof(artifact, opts);
}

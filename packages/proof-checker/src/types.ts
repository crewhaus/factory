/**
 * The proof-checker contract (design/0.8.0-provability-release.md §6.4).
 *
 * A checker CHECKS; it never searches. The model writes the statement and the
 * proof, `ProofCheck` hands both here, and the checker's verdict is the only
 * thing the `proven` rung trusts. Three ship: `builtin` (a dependency-free
 * certificate checker, always available), `smt` (Z3 in a sandbox) and `lean4`
 * (Lean 4 in a sandbox). A plugin checker implements the same interface.
 */

export type CheckInput = {
  /** The prose claim this proof is for (recorded, not interpreted). */
  readonly claim: string;
  /** The formal statement, in the checker's language. */
  readonly statement: string;
  /** The proof / certificate / problem, in the checker's language. */
  readonly proof: string;
  /** Per-check budget; the checker's own default applies when absent. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type CheckResult = {
  readonly ok: boolean;
  readonly checker: string;
  /** Hypotheses the proof rests on — rendered in the bundle as assumptions. */
  readonly assumptions: readonly string[];
  /** Axioms beyond the checker's trusted base. */
  readonly axioms: readonly string[];
  /** Checker output, clipped to a few KB. */
  readonly output: string;
  /** A refuting model / case, when the checker found one (the retry nudge's best input). */
  readonly counterexample?: string;
  /** Why a proof was rejected, in one sentence. */
  readonly reason?: string;
  readonly durationMs: number;
};

export type CheckerAvailability = { readonly ok: boolean; readonly reason?: string };

export interface ProofChecker {
  /** Stable id: `builtin` | `smt` | `lean4` | a plugin id. */
  readonly id: string;
  /** One paragraph on the statement language, shown by `ProofCheckers`. */
  readonly language: string;
  /** Whether it can run here (sandbox backend + image health for the sandbox checkers). */
  available(): Promise<CheckerAvailability>;
  check(input: CheckInput): Promise<CheckResult>;
}

/** The slice of `@crewhaus/sandbox`'s `Sandbox` the sandbox checkers need. */
export type SandboxLike = {
  readonly backend: string;
  exec(opts: {
    readonly image: string;
    readonly argv: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
  }>;
};

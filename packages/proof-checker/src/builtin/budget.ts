/**
 * Bounds for the builtin certificate checker (design §6.4, §18 "checkers
 * bounded by timeout_ms").
 *
 * A check is synchronous on whatever thread runs it — a worker thread of its
 * own under `createBuiltinChecker` (see ./runner), the caller's when
 * `checkCertificate` is called directly — so every loop that a statement or
 * a proof can make long — quantifier enumeration, substitution, polynomial
 * expansion, alpha-comparison — spends from one {@link Budget}. A spent
 * budget is a rejection with a reason, never a hang and never a throw out of
 * `check()`.
 */

/** The hard caps. Exported so the README, the tests and `ProofCheckers` agree. */
export const BUILTIN_LIMITS = {
  /** Characters in the statement, and in any one step's `stmt`. */
  maxStatementChars: 20_000,
  /** Characters in the whole proof (the certificate JSON). */
  maxProofChars: 1_000_000,
  /** Steps in one certificate. */
  maxSteps: 2_000,
  /** Parser nesting depth (parentheses, operators, binders). */
  maxParseDepth: 200,
  /** Nodes in one formula after `let` expansion, counted as a tree. */
  maxFormulaNodes: 200_000,
  /** Depth of one formula after `let` expansion. */
  maxFormulaDepth: 1_000,
  /** Values in one quantifier domain (`{…}` or `a..b`). */
  maxDomainSize: 10_000,
  /** Quantifier-body evaluations across the whole check. */
  maxEnumerations: 1_000_000,
  /** Node visits across the whole check (substitution, comparison, expansion). */
  maxWork: 20_000_000,
  /** Monomials in one polynomial (`arith` over variables). */
  maxMonomials: 2_000,
  /** Exponent of a variable power `arith` will expand. */
  maxSymbolicExponent: 64,
  /** Wall-clock budget when the caller gives none (ms). */
  defaultTimeoutMs: 10_000,
  /**
   * The most wall-clock any one check may take (ms), whatever the caller
   * asks for: a check holds a core for all of it, and the caller's own
   * thread where no worker can start, so a longer `formal.timeout_ms` (sized
   * for a sandbox checker's container) must not stretch it.
   */
  maxTimeoutMs: 10_000,
  /**
   * Checks that run at once, each on a worker thread of its own (./runner);
   * one past that waits for a free thread, inside its own deadline. Every
   * tenant of a managed daemon shares them, so the threads, the cores and
   * the memory checks take stay bounded however many sessions prove at once.
   */
  maxConcurrentChecks: 4,
} as const;

/**
 * The reasons a stopped check gives: the budget's own clock and signal, and
 * the runner's when it stops a worker, say the same words.
 */
export const STOP_REASONS = {
  cancelled: "the check was cancelled",
  timedOut: "the check ran out of time; shrink the proof or raise timeout_ms",
} as const;

/**
 * A proof (or statement) that cannot be accepted. Internal: `check()` turns
 * it into `{ ok: false, reason }` and never lets it escape.
 */
export class CheckFailure extends Error {
  override readonly name = "CheckFailure";
  constructor(
    message: string,
    /** The refuting assignment, when the failure is a false formula. */
    readonly counterexample?: string,
  ) {
    super(message);
  }
}

/** One check's spend: enumerations, work units and the wall clock. */
export class Budget {
  private enumerations = 0;
  private work = 0;
  private readonly deadline: number;

  constructor(
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.deadline = Date.now() + timeoutMs;
  }

  /** The caller has aborted the check. */
  get cancelled(): boolean {
    return this.signal?.aborted === true;
  }

  /**
   * A fresh budget (its own work and enumeration counts) for a follow-up pass,
   * bounded by what is left of this one's deadline and by `capMs`, and still
   * tied to the same abort signal. Undefined when no time is left.
   */
  fork(capMs: number): Budget | undefined {
    const ms = Math.min(capMs, this.remainingMs());
    return ms > 0 ? new Budget(ms, this.signal) : undefined;
  }

  /** Count `n` units of work; checks the clock and the signal every 4096 units. */
  tick(n = 1): void {
    const before = this.work;
    this.work += n;
    if (this.work > BUILTIN_LIMITS.maxWork) {
      throw new CheckFailure(
        `the check needs more than ${BUILTIN_LIMITS.maxWork} steps of work; split the proof or use the smt checker`,
      );
    }
    if (before >>> 12 !== this.work >>> 12) this.checkClock();
  }

  /** Count one quantifier-body evaluation. */
  enumerate(): void {
    this.enumerations += 1;
    if (this.enumerations > BUILTIN_LIMITS.maxEnumerations) {
      throw new CheckFailure(
        `evaluation needs more than ${BUILTIN_LIMITS.maxEnumerations} quantifier cases; shrink the domains or use the smt checker`,
      );
    }
    this.tick();
  }

  get enumerationCount(): number {
    return this.enumerations;
  }

  /** Milliseconds left before the deadline (negative once it has passed). */
  remainingMs(): number {
    return this.deadline - Date.now();
  }

  checkClock(): void {
    if (this.signal?.aborted === true) throw new CheckFailure(STOP_REASONS.cancelled);
    if (Date.now() > this.deadline) throw new CheckFailure(STOP_REASONS.timedOut);
  }
}

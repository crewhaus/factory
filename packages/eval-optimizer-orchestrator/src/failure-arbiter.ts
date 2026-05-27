/**
 * Track B (Section 55) — four-way failure arbiter.
 *
 * Source: Meta-Engineering Harnesses (arxiv 2605.25665, HireNimbus,
 * May 2026, §5.3). When an adversarial test fails, classifying the
 * failure BEFORE choosing a corrective action prevents a major class of
 * wasted iteration cycles: retrying an implementation when the contract
 * itself is ambiguous, or "fixing" a flaky test that's actually a real
 * bug.
 *
 * The four classes and their corrective actions:
 *
 *   | Class                | Meaning                                          | Action                       |
 *   | -------------------- | ------------------------------------------------ | ---------------------------- |
 *   | bug                  | Impl violates a clear contract clause            | fix impl; promote regression |
 *   | spec-gap             | Contract omitted necessary behavior              | update contract; retry       |
 *   | noise                | Failure is environmental or irrelevant           | calibrate verifier or CI     |
 *   | contract-ambiguity   | Contract admits multiple valid interpretations   | refine contract; restart     |
 *
 * The classifier here is rule-based (no LLM call): it inspects the
 * grader's structured output, the sample's reference (when present),
 * and any error metadata to make a decision. A `claude` variant lives
 * separately in `prompt-optimizer-claude` for cases where rules don't
 * cleanly separate the four classes.
 *
 * See the Track B section of the §55–§59 batch in factory/CHANGELOG.md.
 */
import type { Sample } from "@crewhaus/eval-dataset";

/**
 * The four failure classes. Each maps to a different corrective action;
 * see the `Action` type below.
 */
export type FailureClass = "bug" | "spec-gap" | "noise" | "contract-ambiguity";

/**
 * The corrective action the optimizer should take based on the class.
 * `retryImpl` and `restartImpl` are different: retry assumes the contract
 * is correct and the impl needs another attempt; restart assumes the
 * contract was refined and we should start over from the new contract.
 */
export type ArbiterAction =
  | { readonly kind: "fix-impl"; readonly promoteRegression: true }
  | { readonly kind: "update-contract"; readonly retryImpl: true }
  | { readonly kind: "calibrate-verifier" }
  | { readonly kind: "refine-contract"; readonly restartImpl: true };

/**
 * Input to the arbiter for one failing sample.
 */
export type FailingSample = {
  readonly sample: Sample;
  /** Actual model output for this sample. */
  readonly actual: string;
  /** The grader's score for this sample (typically 0..1). */
  readonly score: number;
  /**
   * Optional grader-specific structured output. Arbiters that recognize
   * a grader's shape can use it; rule-based arbiters ignore it.
   */
  readonly graderOutput?: Readonly<Record<string, unknown>>;
  /** Optional error message when the run errored rather than scored. */
  readonly errorMessage?: string;
};

/**
 * Arbiter verdict for a single failing sample.
 */
export type ArbiterVerdict = {
  readonly class: FailureClass;
  readonly action: ArbiterAction;
  /** Plain-English explanation of the decision; goes into reports. */
  readonly reason: string;
};

/**
 * Aggregate verdict across a whole run. Used by the orchestrator to
 * decide what to do *next* — if the majority of failures are
 * `contract-ambiguity`, retrying the impl is wasteful and the
 * orchestrator should surface a contract-refinement prompt instead.
 */
export type AggregateVerdict = {
  readonly counts: Readonly<Record<FailureClass, number>>;
  readonly dominantClass: FailureClass;
  readonly recommendedAction: ArbiterAction;
  /** Total number of failing samples this aggregate considered. */
  readonly total: number;
};

/**
 * Rule-based arbiter. Each rule is tried in order; the first match
 * wins. Order is deliberate — the rules go from most-specific to
 * most-general so a sample matching multiple rules gets the most
 * informative classification.
 *
 * The rules:
 *
 *   1. **Noise** — errorMessage starts with a known transient marker
 *      (rate-limit, network timeout, sandbox preempted). These are
 *      not the model's fault.
 *   2. **Contract-ambiguity** — actual output is structurally valid
 *      AND the sample's reference (if any) is not the unique correct
 *      answer (multiple acceptable outputs, the grader couldn't pick
 *      one). Detected via grader output's `acceptable: true` flag or
 *      when the reference field is null/absent.
 *   3. **Spec-gap** — actual output addresses a question that the
 *      reference doesn't cover (the sample's metadata names a required
 *      behavior that isn't in the spec's `instructions`). Default
 *      signal: the sample has metadata.requiredBehavior and the grader
 *      output marks it `addressedByImpl: true, inContract: false`.
 *   4. **Bug** (default) — when no other rule fires, the impl just
 *      failed to satisfy a clear contract clause.
 */
export function arbitrate(failing: FailingSample): ArbiterVerdict {
  // Rule 1 — noise
  if (failing.errorMessage !== undefined) {
    const msg = failing.errorMessage.toLowerCase();
    if (
      msg.includes("rate limit") ||
      msg.includes("rate-limit") ||
      msg.includes("etimedout") ||
      msg.includes("econnreset") ||
      msg.includes("sandbox preempted") ||
      msg.includes("transient")
    ) {
      return {
        class: "noise",
        action: { kind: "calibrate-verifier" },
        reason: `Transient infrastructure error: ${failing.errorMessage}`,
      };
    }
  }

  // Rule 2 — contract-ambiguity
  if (failing.graderOutput?.["acceptable"] === true) {
    return {
      class: "contract-ambiguity",
      action: { kind: "refine-contract", restartImpl: true },
      reason:
        "Grader flagged the actual output as acceptable; the reference is not the unique correct answer. Contract admits multiple valid interpretations.",
    };
  }
  const ref = (failing.sample as { reference?: unknown }).reference;
  if (
    failing.graderOutput?.["multipleAcceptable"] === true ||
    ((ref === null || ref === undefined) && failing.score > 0)
  ) {
    return {
      class: "contract-ambiguity",
      action: { kind: "refine-contract", restartImpl: true },
      reason:
        "Reference is absent or grader saw multiple acceptable outputs; the contract underspecifies the desired behavior.",
    };
  }

  // Rule 3 — spec-gap
  const meta = (failing.sample as { metadata?: Record<string, unknown> }).metadata;
  const requiredBehavior =
    meta !== undefined && typeof meta["requiredBehavior"] === "string"
      ? (meta["requiredBehavior"] as string)
      : undefined;
  if (
    requiredBehavior !== undefined &&
    failing.graderOutput?.["addressedByImpl"] === true &&
    failing.graderOutput?.["inContract"] === false
  ) {
    return {
      class: "spec-gap",
      action: { kind: "update-contract", retryImpl: true },
      reason: `Impl correctly addressed "${requiredBehavior}" but the contract didn't require it. Update the contract template before retrying.`,
    };
  }

  // Rule 4 — bug (default)
  return {
    class: "bug",
    action: { kind: "fix-impl", promoteRegression: true },
    reason:
      "Impl violated a clear contract clause. Fix the impl and promote this sample to the regression suite.",
  };
}

/**
 * Run the arbiter over every failing sample and roll up into an
 * aggregate verdict. The recommended action is the action attached to
 * the dominant class; on ties, the order is contract-ambiguity →
 * spec-gap → bug → noise (the "most-process-correcting" action wins
 * over the "most-impl-correcting"; the goal is to fix the cheaper
 * thing first).
 */
export function aggregate(failings: ReadonlyArray<FailingSample>): AggregateVerdict {
  const counts: Record<FailureClass, number> = {
    bug: 0,
    "spec-gap": 0,
    noise: 0,
    "contract-ambiguity": 0,
  };
  for (const f of failings) {
    const v = arbitrate(f);
    counts[v.class]++;
  }
  // Tie-break order: process-correcting before impl-correcting.
  const order: FailureClass[] = ["contract-ambiguity", "spec-gap", "bug", "noise"];
  let dominant: FailureClass = "bug";
  let max = -1;
  for (const c of order) {
    if (counts[c] > max) {
      max = counts[c];
      dominant = c;
    }
  }
  const recommendedAction: ArbiterAction =
    dominant === "contract-ambiguity"
      ? { kind: "refine-contract", restartImpl: true }
      : dominant === "spec-gap"
        ? { kind: "update-contract", retryImpl: true }
        : dominant === "noise"
          ? { kind: "calibrate-verifier" }
          : { kind: "fix-impl", promoteRegression: true };
  return {
    counts,
    dominantClass: dominant,
    recommendedAction,
    total: failings.length,
  };
}

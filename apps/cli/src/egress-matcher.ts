import type { EgressMatcher } from "@crewhaus/egress-classifier";

/**
 * FR-006 — Pillar 3 sink-side egress-matcher selection for `crewhaus run`,
 * factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free and directly unit-testable, mirroring
 * `justification-gate.ts` (the FR-004 intent-gate judge selector this is the
 * sink-side analogue of).
 *
 * The egress check has two separable concerns: *where* it runs (wired from
 * the IR, on every external-scope tool call — the durable guarantee) and
 * *how* it decides an outbound payload "contains" tagged data-lineage (the
 * pluggable `EgressMatcher`). This module resolves the latter for the run
 * path and hands the constructed matcher to `runChatLoop({ egressMatcher })`.
 * The per-origin/per-sink policy fold and the three audit outcomes
 * (`egress-passed | egress-warned | egress-blocked`) live in `classifyEgress`
 * and are matcher-independent — selecting a matcher changes detection quality
 * and nothing else.
 *
 * Resolution precedence for the matcher choice:
 *   `--egress-matcher` flag > spec `security.egressMatcher` (lowered to
 *   `ir.security.egressMatcher`) > `"substring"`.
 *
 * OPTIONAL-DEPENDENCY POSTURE (acceptance #4). `@crewhaus/egress-matcher-semantic`
 * and `@crewhaus/embedder` are imported lazily — only when `"semantic"` is
 * actually selected — exactly like `createJustificationJudge` lazy-imports the
 * claude judge. The default path (`"substring"` / unset) returns `undefined`
 * and never touches the semantic package, so it pulls in no embedding code.
 */

export type EgressMatcherChoice = "substring" | "semantic";

const VALID_EGRESS_MATCHER_CHOICES: ReadonlyArray<EgressMatcherChoice> = ["substring", "semantic"];

/**
 * Default embedder model for the semantic matcher when neither
 * `--egress-embedder` nor `CREWHAUS_EGRESS_EMBEDDER` is supplied. A real
 * provider is the production intent; if its API key is unset the embedder
 * throws and `SemanticEgressMatcher` degrades to the substring tripwire
 * (its built-in safe fallback) rather than dropping the egress check.
 */
export const DEFAULT_EGRESS_EMBEDDER_MODEL = "openai/text-embedding-3-small";

/** Thrown by `resolveEgressMatcherChoice` on an unrecognised choice. The CLI
 *  entry file catches it and routes the message through `die()`; tests assert
 *  on `.choice` / `.message` without the process exiting. */
export class InvalidEgressMatcherChoiceError extends Error {
  override readonly name = "InvalidEgressMatcherChoiceError";
  constructor(readonly choice: string) {
    super(
      `invalid --egress-matcher "${choice}" — allowed: ${VALID_EGRESS_MATCHER_CHOICES.join(", ")}`,
    );
  }
}

function isEgressMatcherChoice(s: string): s is EgressMatcherChoice {
  return (VALID_EGRESS_MATCHER_CHOICES as ReadonlyArray<string>).includes(s);
}

/**
 * Pure resolution of the matcher choice from the flag value + the lowered IR
 * selector. `flagValue` is the raw `--egress-matcher` value (or undefined when
 * the flag is absent); `irEgressMatcher` is `ir.security?.egressMatcher`.
 * Throws `InvalidEgressMatcherChoiceError` for any value outside the allowed
 * set so the caller can `die()` with a friendly message.
 */
export function resolveEgressMatcherChoice(
  flagValue: string | undefined,
  irEgressMatcher: EgressMatcherChoice | undefined,
): EgressMatcherChoice {
  const raw = flagValue ?? irEgressMatcher ?? "substring";
  if (!isEgressMatcherChoice(raw)) throw new InvalidEgressMatcherChoiceError(raw);
  return raw;
}

export type CreateEgressMatcherOptions = {
  /**
   * Embedder model string for the `"semantic"` choice — the
   * `@crewhaus/embedder` prefix grammar (`openai/…`, `voyage/…`, `mock/…`).
   * Resolution precedence at the call site: `--egress-embedder` flag >
   * `CREWHAUS_EGRESS_EMBEDDER` env > `DEFAULT_EGRESS_EMBEDDER_MODEL`. Tests
   * pass `mock/…` for a deterministic, network-free embedder.
   */
  readonly embedderModel: string;
  /** Optional cosine threshold passed through to `SemanticEgressMatcher`. */
  readonly threshold?: number;
};

/**
 * Build the `EgressMatcher` for a resolved choice. Returns `undefined` for
 * `"substring"` so the caller omits `egressMatcher` from `runChatLoop`
 * (runtime-core then uses the built-in `substringMatcher`, the
 * behavior-preserving default — the default egress path pulls in no embedding
 * dependency). For `"semantic"` it lazily imports `@crewhaus/embedder` and
 * `@crewhaus/egress-matcher-semantic` and constructs a `SemanticEgressMatcher`
 * with the injected embedder, so the model-backed code only loads when
 * actually selected.
 */
export async function createEgressMatcher(
  choice: EgressMatcherChoice,
  opts: CreateEgressMatcherOptions,
): Promise<EgressMatcher | undefined> {
  if (choice === "substring") return undefined;
  const { createEmbedder } = await import("@crewhaus/embedder");
  const { createSemanticEgressMatcher } = await import("@crewhaus/egress-matcher-semantic");
  const embedder = createEmbedder({ model: opts.embedderModel });
  return createSemanticEgressMatcher({
    embedder,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
  });
}

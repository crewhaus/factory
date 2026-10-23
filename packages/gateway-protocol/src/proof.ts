/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.3, §5.4) — the proof bundle
 * on the wire.
 *
 * A managed run whose spec declares `provability:` answers `runs.create` /
 * `runs.continue` with the bundle the gate graded its final turn against, as
 * the optional `proof` field of the result. The bundle is the same one every
 * other surface renders (the cli footer, the research report section, the
 * JSON under `.crewhaus/proofs/`); this is its schema at the gateway
 * boundary, so a client can validate what it is handed instead of trusting
 * the shape.
 *
 * The schema MIRRORS `@crewhaus/provability`'s `ProofBundle` type rather than
 * importing it: this package is the dependency-light wire contract the
 * reference clients copy, and the provability package carries the whole
 * verifier. The two cannot drift silently — `proof.test.ts` (tests are not
 * typechecked by `tsc -b`, so it reads the type's SOURCE rather than
 * assigning types) holds this schema to `packages/provability/src/types.ts`:
 * every field of the bundle, a claim, a binding and a checker entry, with
 * its optionality; every member of the levels, the rungs, `BindingKind`,
 * `ClaimStatus`, `ProofVerdict` and `UnmetReason`. A field or a member added
 * on one side and not the other fails that test.
 *
 * `.strict()` throughout, like every other schema in this protocol: an
 * unknown key is a different protocol revision, not a field to ignore. The
 * bundle grows additively (its `version` stays 1), so a new field lands here
 * in the same change that adds it there.
 */
import { z } from "zod";

/** The four rungs of the ladder, lowest first (`PROVABILITY_LEVELS`). */
export const PROOF_LEVELS = ["cited", "grounded", "checked", "proven"] as const;

/** Every reason a binding falls short — provability's `UnmetReason`, verbatim. */
export const PROOF_UNMET_REASONS = [
  "no_citation",
  "no_definition",
  "not_locatable",
  "host_denied",
  "private_address",
  "path_outside_workspace",
  "path_missing",
  "unresolved",
  "not_fetched",
  "not_found_in_source",
  "polarity_conflict",
  "not_independent",
  "tool_missing",
  "tool_errored",
  "tool_not_allowed",
  "value_absent",
  "replay_mismatch",
  "proof_missing",
  "proof_rejected",
  "claim_mismatch",
  "assumption_forbidden",
  "below_floor",
] as const;

const level = z.enum(PROOF_LEVELS);
const rung = z.enum([...PROOF_LEVELS, "none"]);
const count = z.number().int().nonnegative();
/** `met / (claims − assumptions)` and the threshold it is held to: a fraction. */
const fraction = z.number().min(0).max(1);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex>");

const ProofBinding = z
  .object({
    ref: z.string().min(1),
    kind: z.enum(["source", "execution", "formal", "assumption"]),
    rung,
    ok: z.boolean(),
    reason: z.enum(PROOF_UNMET_REASONS).optional(),
    detail: z.string().optional(),
    origin: z.string().optional(),
    sha256: z.string().optional(),
    excerpt: z.string().optional(),
    replayed: z.boolean().optional(),
    judgeWaived: z.boolean().optional(),
    /** The earlier call of the run that wrote the grounding text there itself (design §10). */
    writtenBy: z
      .object({ toolUseId: z.string().min(1), toolName: z.string().min(1) })
      .strict()
      .optional(),
    checker: z.string().optional(),
    statement: z.string().optional(),
    /** A formal binding's proof hypotheses: assumptions too (design §6.4). */
    assumptions: z.array(z.string()).optional(),
  })
  .strict();

const ProofClaim = z
  .object({
    index: count,
    text: z.string(),
    line: z.number().int().positive().optional(),
    status: z.enum(["met", "unmet", "assumption"]),
    best: rung,
    bindings: z.array(ProofBinding),
    definition: z.string().optional(),
  })
  .strict();

/** The per-answer proof bundle (`@crewhaus/provability`'s `ProofBundle`). */
export const ProofBundle = z
  .object({
    version: z.literal(1),
    level,
    verdict: z.enum(["pass", "fail", "unverified"]),
    score: fraction,
    threshold: fraction,
    achieved: rung,
    claims: z.array(ProofClaim),
    claimCount: count,
    met: count,
    unmet: count,
    assumptions: count,
    assumptionsRefused: count.optional(),
    /** Distinct hypotheses the accepted proofs rest on, counted with `assumptions`. */
    hypotheses: count.optional(),
    sources: count,
    /** Of `sources`, the origins whose grounding text the run wrote itself. */
    selfWritten: count.optional(),
    judgeWaived: count,
    retryIndex: count,
    checkers: z
      .array(
        z
          .object({
            id: z.string().min(1),
            artifact: z.string().min(1),
            axioms: z.array(z.string()),
            assumptions: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    vacuous: z.string().optional(),
    error: z.string().optional(),
    judgeModel: z.string().optional(),
    spentUsdMicros: count.optional(),
    createdAt: z.string().min(1),
    bundleHash: digest,
  })
  .strict();
export type ProofBundleT = z.infer<typeof ProofBundle>;

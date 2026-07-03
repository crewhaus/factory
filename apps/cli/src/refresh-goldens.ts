/**
 * Item 5 — `crewhaus dataset refresh-goldens`: reconcile the human
 * corrections + up-rated turns that accumulated in production against an
 * existing dataset's stored gold answers. When a user's accepted/corrected
 * output diverges from a sample's `expected_output`, PROPOSE a gold update
 * (never in-place — the write is always a NEW dataset-registry version).
 *
 * Two evidence classes drive a proposal:
 *   - CORRECTION: a `user_feedback` record carrying a `correction` (the user
 *     typed a better answer) on a turn whose input matches a stored sample.
 *   - UP-RATED DIVERGENCE: an up-rated turn (normalized rating ≥ min-score)
 *     whose observed answer differs from the stored gold — the live behavior
 *     the user liked is not what the dataset asserts.
 *
 * Matching is input-equality first, then token-overlap similarity (the same
 * similarity the sibling flywheel features use), so a lightly-reworded prompt
 * still reconciles. Samples that FAIL consistently across eval runs yet are
 * repeatedly up-rated live are flagged STALE using the run-history index; a
 * sample with no cross-run history simply carries no stale signal (we never
 * fabricate one).
 *
 * Provenance: each proposal records the stored sample's content hash (via the
 * registry's own `hashSample`, so hashes line up with what `put` recorded) and
 * the evidence class. Kept in a side-effect-free module mirroring
 * `feedback.ts` / `graders-suggest.ts`; all filesystem access + the registry
 * version write live in `apps/cli/src/index.ts`.
 */
import { hashSample } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { type FeedbackRecord, type SessionTurn, mergeFeedback, normalizeRating } from "./feedback";
import { normalizeEvidenceTokens } from "./graders-suggest";

/** Thrown on malformed flags / unusable inputs. The CLI entry file routes it
 *  through `die()`; tests assert on `.message`. */
export class RefreshGoldensError extends Error {
  override readonly name = "RefreshGoldensError";
}

/** Default rating threshold above which a turn is "up-rated" (mirrors distill). */
export const DEFAULT_REFRESH_MIN_SCORE = 0.7;

/** Similarity at/above which a feedback turn matches a stored sample by input. */
export const INPUT_MATCH_SIMILARITY = 0.6;

export type GoldEvidence = "correction" | "up-rated-divergence";

/** One proposed gold update for a stored sample. */
export type GoldProposal = {
  readonly sampleId: string;
  /** Content hash of the CURRENT stored sample (registry hashSample). */
  readonly currentHash: string;
  readonly input: string;
  /** The stored gold (may be undefined — a sample with no expected_output). */
  readonly currentGold?: string;
  /** The proposed new gold, drawn from the correction/up-rated answer. */
  readonly proposedGold: string;
  readonly evidence: GoldEvidence;
  /** Where the proposed gold came from (sessionId#turn). */
  readonly sourceRef: string;
  /** True when the run-history index shows this sample failing across runs. */
  readonly stale: boolean;
};

export type RefreshResult = {
  readonly proposals: ReadonlyArray<GoldProposal>;
  /** Feedback turns that matched no stored sample (informational). */
  readonly unmatched: number;
  /** Number of samples inspected. */
  readonly sampleCount: number;
};

// -------- similarity --------

function tokenSet(text: string): Set<string> {
  return new Set(normalizeEvidenceTokens(text));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Normalize an input for equality matching (whitespace-collapsed, trimmed). */
function normInput(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Find the stored sample a feedback turn's input reconciles with: exact
 * (normalized) input equality first, then the best token-overlap match at/above
 * {@link INPUT_MATCH_SIMILARITY}. Returns undefined when nothing is close
 * enough — a genuinely new input is not a gold refresh (that is `dataset mine`).
 */
export function matchSampleByInput(
  input: string,
  samples: ReadonlyArray<Sample>,
): Sample | undefined {
  const target = normInput(input);
  for (const s of samples) {
    if (normInput(s.input) === target) return s;
  }
  const targetTokens = tokenSet(input);
  if (targetTokens.size === 0) return undefined;
  let best: Sample | undefined;
  let bestOverlap = INPUT_MATCH_SIMILARITY;
  for (const s of samples) {
    const overlap = jaccard(targetTokens, tokenSet(s.input));
    if (overlap >= bestOverlap) {
      // Strictly-greater keeps the FIRST best on ties (stable across runs);
      // use > so a later equal match doesn't flip the winner.
      if (overlap > bestOverlap || best === undefined) {
        bestOverlap = overlap;
        best = s;
      }
    }
  }
  return best;
}

// -------- cross-run staleness --------

/** Minimal per-run sample outcome the staleness check reads. */
export type RunSampleOutcome = { sampleId: string; passed: boolean };

/**
 * A sample is STALE when it FAILED in every run that included it AND was seen
 * in at least `minRuns` runs — a persistent eval failure. Callers pair this
 * with a live up-rating to conclude the GOLD is wrong, not the agent. A sample
 * absent from the run history carries no stale signal (returns false) — we
 * never fabricate one.
 */
export function isStaleSample(
  sampleId: string,
  runs: ReadonlyArray<ReadonlyArray<RunSampleOutcome>>,
  minRuns = 2,
): boolean {
  let seen = 0;
  let failedEvery = true;
  for (const run of runs) {
    const outcome = run.find((o) => o.sampleId === sampleId);
    if (outcome === undefined) continue;
    seen += 1;
    if (outcome.passed) failedEvery = false;
  }
  return seen >= minRuns && failedEvery;
}

// -------- reconciliation --------

/**
 * Reconcile merged feedback against the stored samples, proposing gold updates
 * where a correction or up-rated answer diverges from the stored
 * `expected_output`. `turns` supplies each feedback record's input + observed
 * answer (keyed sessionId#turn). `runOutcomes` (from the run-history index)
 * powers the stale flag; pass [] to skip staleness.
 *
 * A proposal is emitted only when the proposed gold is non-empty and actually
 * DIFFERS from the stored gold — a correction that matches the current gold is
 * already reconciled.
 */
export function reconcileGoldens(opts: {
  samples: ReadonlyArray<Sample>;
  turns: ReadonlyArray<SessionTurn>;
  records: ReadonlyArray<FeedbackRecord>;
  minScore: number;
  runOutcomes?: ReadonlyArray<ReadonlyArray<RunSampleOutcome>>;
}): RefreshResult {
  const turnByKey = new Map<string, SessionTurn>();
  for (const t of opts.turns) turnByKey.set(`${t.sessionId}#${t.turnNumber}`, t);
  const runs = opts.runOutcomes ?? [];

  const bySample = new Map<string, GoldProposal>();
  let unmatched = 0;

  for (const fb of mergeFeedback(opts.records)) {
    const turn = turnByKey.get(`${fb.sessionId}#${fb.turnNumber}`);
    if (turn === undefined) {
      unmatched += 1;
      continue;
    }
    const score = normalizeRating(fb);
    const upRated = score !== undefined && score >= opts.minScore;
    // The candidate better-answer: an explicit correction, else the up-rated
    // live answer.
    const proposed =
      fb.correction !== undefined && fb.correction.trim() !== ""
        ? fb.correction
        : upRated && turn.output.trim() !== ""
          ? turn.output
          : undefined;
    if (proposed === undefined) continue;

    const sample = matchSampleByInput(turn.input, opts.samples);
    if (sample === undefined) {
      unmatched += 1;
      continue;
    }
    const currentGold = sample.expected_output;
    if (currentGold !== undefined && normInput(currentGold) === normInput(proposed)) {
      continue; // already reconciled
    }
    const evidence: GoldEvidence =
      fb.correction !== undefined ? "correction" : "up-rated-divergence";
    const proposal: GoldProposal = {
      sampleId: sample.id,
      currentHash: hashSample(sample),
      input: sample.input,
      ...(currentGold !== undefined ? { currentGold } : {}),
      proposedGold: proposed,
      evidence,
      sourceRef: `${fb.sessionId}#${fb.turnNumber}`,
      stale: isStaleSample(sample.id, runs),
    };
    // A correction outranks an up-rated divergence for the same sample; on a
    // tie the first-seen wins (deterministic given merged-feedback order).
    const existing = bySample.get(sample.id);
    if (
      existing === undefined ||
      (existing.evidence !== "correction" && evidence === "correction")
    ) {
      bySample.set(sample.id, proposal);
    }
  }

  const proposals = [...bySample.values()].sort((a, b) => a.sampleId.localeCompare(b.sampleId));
  return { proposals, unmatched, sampleCount: opts.samples.length };
}

/**
 * Apply proposals to the stored samples, producing the NEW sample array to
 * register as a fresh version. Never mutates the input; a proposed sample gets
 * its `expected_output` replaced and a provenance note added to metadata.
 * Samples with no proposal pass through unchanged.
 */
export function applyProposals(
  samples: ReadonlyArray<Sample>,
  proposals: ReadonlyArray<GoldProposal>,
): Sample[] {
  const byId = new Map(proposals.map((p) => [p.sampleId, p]));
  return samples.map((s) => {
    const p = byId.get(s.id);
    if (p === undefined) return s;
    const metadata: Record<string, unknown> = { ...(s.metadata ?? {}) };
    metadata["gold_refreshed"] = {
      from: p.currentGold ?? null,
      evidence: p.evidence,
      source: p.sourceRef,
      prevHash: p.currentHash,
    };
    return { ...s, expected_output: p.proposedGold, metadata };
  });
}

// -------- rendering --------

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** The review diff — a per-proposal old→new gold report (printed by default). */
export function renderProposals(result: RefreshResult, datasetLabel: string): string {
  const lines: string[] = [];
  lines.push(
    `refresh-goldens: ${result.proposals.length} proposed gold update(s) for ${datasetLabel} (${result.sampleCount} sample(s))`,
  );
  if (result.unmatched > 0) {
    lines.push(`  (${result.unmatched} feedback turn(s) matched no stored sample — skipped)`);
  }
  lines.push("");
  if (result.proposals.length === 0) {
    lines.push("no gold updates — stored golds already agree with corrections and up-rated turns.");
    return `${lines.join("\n")}\n`;
  }
  for (const p of result.proposals) {
    lines.push(`● ${p.sampleId}  [${p.evidence}${p.stale ? ", STALE across runs" : ""}]`);
    lines.push(`    input:    ${clip(p.input, 100)}`);
    lines.push(
      `    - old:    ${p.currentGold !== undefined ? clip(p.currentGold, 120) : "(none)"}`,
    );
    lines.push(`    + new:    ${clip(p.proposedGold, 120)}`);
    lines.push(`    source:   ${p.sourceRef}`);
  }
  lines.push("");
  lines.push("re-run with --apply to write these as a NEW dataset version (never in-place).");
  return `${lines.join("\n")}\n`;
}

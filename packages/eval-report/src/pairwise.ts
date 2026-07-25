/**
 * A1 — pairwise-diff bookkeeping. The judging itself lives in
 * `@crewhaus/eval-judge` (`judgePairwise` — order-swapped calls, fresh
 * sentinels, strict verdict schema); this module is the pure, offline
 * half: tallying order-swapped verdicts into a win/loss/tie summary,
 * formatting the stdout block, and extracting a sample's original input
 * from its recorded transcript artifact so the judge can see what the two
 * outputs were answering.
 *
 * A tie is NEVER counted as a win — neither a judge-declared tie nor the
 * consolidated tie produced by an order disagreement (position bias).
 */
import type { LoadedRun } from "./load";

/** Which side a pairwise verdict named (mapped from the call's A/B labels). */
export type PairwiseWinner = "prev" | "new" | "tie";

/** One shared sample's order-swapped pairwise outcome. */
export type PairwiseSampleVerdict = {
  readonly sampleId: string;
  /** Verdict of the call that presented prev first (prev=A, new=B). */
  readonly prevFirst: { readonly winner: PairwiseWinner; readonly rationale: string };
  /** Verdict of the order-swapped call (new=A, prev=B). */
  readonly newFirst: { readonly winner: PairwiseWinner; readonly rationale: string };
  /** True when both orders named the same side (or both said tie). */
  readonly agreed: boolean;
  /** Consolidated: the agreed side, else "tie" (order disagreement). */
  readonly verdict: PairwiseWinner;
};

/** The additive `pairwise` block of diff.json. */
export type PairwiseDiff = {
  readonly judgeModel: string;
  /** Per-sample outcomes, in the deterministic (sorted-id) judging order. */
  readonly samples: ReadonlyArray<PairwiseSampleVerdict>;
  /** Consolidated-verdict tallies. Ties are counted here and ONLY here. */
  readonly newWins: number;
  readonly prevWins: number;
  readonly ties: number;
  /**
   * The NEW side's win rate over the judged samples, ties counted half:
   * (newWins + ties/2) / judged. 0.5 = dead even. Absent tallies (zero
   * judged samples) read 0.
   */
  readonly winRate: number;
  /** Fraction of judged samples whose two order-swapped calls agreed —
   *  the position-bias health check (1 = fully order-stable judge). */
  readonly orderConsistency: number;
  /** Samples skipped because a side ERRORED (no output to compare).
   *  Present only when > 0. */
  readonly skippedErrored?: number;
};

/**
 * Fold per-sample order-swapped verdicts into the aggregate block. Pure and
 * deterministic — tallies follow the consolidated verdicts, so a sample
 * whose orders disagreed contributes a tie (never a win) by construction.
 */
export function summarizePairwise(
  judgeModel: string,
  samples: ReadonlyArray<PairwiseSampleVerdict>,
  opts: { readonly skippedErrored?: number } = {},
): PairwiseDiff {
  let newWins = 0;
  let prevWins = 0;
  let ties = 0;
  let agreedCount = 0;
  for (const s of samples) {
    if (s.verdict === "new") newWins += 1;
    else if (s.verdict === "prev") prevWins += 1;
    else ties += 1;
    if (s.agreed) agreedCount += 1;
  }
  const judged = samples.length;
  return {
    judgeModel,
    samples,
    newWins,
    prevWins,
    ties,
    winRate: judged === 0 ? 0 : (newWins + ties / 2) / judged,
    orderConsistency: judged === 0 ? 0 : agreedCount / judged,
    ...(opts.skippedErrored !== undefined && opts.skippedErrored > 0
      ? { skippedErrored: opts.skippedErrored }
      : {}),
  };
}

/**
 * The compact stdout pairwise block (the CLI prepends `[eval-report] `).
 * One summary line, plus a skip note when errored samples were excluded.
 */
export function formatPairwiseLines(p: PairwiseDiff): string[] {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `pairwise (judge ${p.judgeModel}): new wins ${p.newWins} · prev wins ${p.prevWins} · ` +
      `ties ${p.ties} — win-rate ${pct(p.winRate)} (new over prev, ties half), ` +
      `order-consistency ${pct(p.orderConsistency)}`,
  ];
  if (p.skippedErrored !== undefined) {
    lines.push(
      `pairwise: ${p.skippedErrored} sample(s) skipped — errored on a side, no output to compare`,
    );
  }
  return lines;
}

/** Mirrors the eval-runner's per-sample directory sanitization, so a
 *  sample id can be resolved to its artifact directory name. */
function sanitizeSampleId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Extract a sample's ORIGINAL INPUT from its recorded per-sample transcript
 * artifact (`transcript.jsonl` — the same artifact `loadRun` already
 * loads): the first `user_message` event's text content. Returns undefined
 * when the run carries no transcript for the sample (stub invokers,
 * truncated artifacts) — the pairwise judge then compares outputs without
 * the prompt context rather than failing the whole diff.
 */
export function extractSampleInput(run: LoadedRun, sampleId: string): string | undefined {
  const perSample = run.perSample[sampleId] ?? run.perSample[sanitizeSampleId(sampleId)];
  const raw = perSample?.transcript;
  if (raw === undefined || raw === "") return undefined;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate a torn tail line — transcripts are append-only
    }
    const ev = parsed as { kind?: unknown; payload?: unknown };
    if (ev.kind !== "user_message") continue;
    const content = (ev.payload as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (b): b is { type: "text"; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("\n");
      if (text !== "") return text;
    }
    return undefined; // first user_message had no extractable text
  }
  return undefined;
}

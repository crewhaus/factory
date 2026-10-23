/**
 * `ProvabilityPreflight`: the gate's verdict on a draft, before the answer
 * is sent (design §2, §7).
 *
 * It calls the gate's own verifier — `verifyDocument`, the one function the
 * gate, this tool, `crewhaus provability check` and the research report
 * gate share — with the gate's config, its evidence and its artifact store,
 * so a draft is graded here exactly as the gate will grade it, except for
 * the three steps that reach outside the run, which a read-only preflight
 * never takes:
 *
 * - `sources.resolve: head` — the gate sends one guarded HEAD per cited URL
 *   (an egress). The preflight checks with `resolve: off` instead of
 *   failing every URL as `unresolved`, and says so.
 * - replay at `checked` — the gate re-runs a cited pure tool and compares
 *   digests. The preflight does not: a binding reads `replayed: false`.
 *   Replaying a pure tool with its logged input reproduces it, so this only
 *   matters for a tool that is not as deterministic as its flags say.
 * - the paraphrase-waiver judge — never consulted here (it spends, and a
 *   preflight must not). A paraphrase the gate's judge might accept shows
 *   as `not_found_in_source`: the preflight is the stricter of the two.
 *
 * Nothing is gated, persisted or published: the draft is not an answer.
 */
import {
  type EvidenceIndex,
  type ProofArtifactStore,
  type ProofBinding,
  type ProofBundle,
  type ProofClaim,
  type ProvabilityConfig,
  renderFooter,
  renderNudge,
  verifyDocument,
} from "@crewhaus/provability";
import { REPORT_BYTES, clip, clipMiddle, fitText, jsonBytes, listed } from "./check";

/** The longest draft a preflight reads (a long research report fits). */
export const DRAFT_CHARS = 200_000;
/**
 * The most claims the table lists; the counts above it always cover all of
 * them. The report's byte budget ({@link REPORT_BYTES}) usually stops the
 * table sooner.
 */
export const TABLE_ROWS = 100;
/** The most bindings one row lists; `moreEvidence` counts the rest. */
export const ROW_BINDINGS = 6;
/** The nudge's share of the report; cut in the middle, so its closing instructions stay. */
const NUDGE_BYTES = 3_500;
/**
 * The notes' share. The preflight writes at most three or four short ones
 * (where it differs from the gate, how the evidence was read), but they sit
 * ahead of the nudge, so they are budgeted like it: a note list that grew
 * with the run (one per unreadable log, say) would otherwise push the nudge
 * out of the head the runtime shows.
 */
export const NOTES_BYTES = 1_600;
/** One note as listed. */
const NOTE_CHARS = 500;
const moreNotes = (rest: number): string =>
  `… and ${rest} more ${rest === 1 ? "note" : "notes"} on how this preflight read the run`;

/** The config the preflight verifies with, and what it left out of the gate's. */
export function preflightConfig(config: ProvabilityConfig): {
  readonly config: ProvabilityConfig;
  readonly notes: ReadonlyArray<string>;
} {
  const notes: string[] = [];
  let checked = config;
  if (config.sources.resolve === "head") {
    checked = { ...config, sources: { ...config.sources, resolve: "off" } };
    if (config.level === "cited" || config.level === "grounded") {
      notes.push(
        "provability.sources.resolve is head: the gate also sends one HEAD request per cited URL and fails an unreachable one (unresolved); this preflight sends none, so it does not check reachability",
      );
    }
  }
  if (config.judge !== undefined && config.level === "grounded") {
    notes.push(
      "the gate may ask its paraphrase judge to accept a claim this preflight reports as not_found_in_source; the judge is never consulted here, so fix those claims rather than count on it",
    );
  }
  return { config: checked, notes };
}

/** Run the gate's verifier over `draft` with the preflight's config (see the module doc). */
export async function preflightBundle(
  draft: string,
  opts: {
    readonly config: ProvabilityConfig;
    readonly evidence: EvidenceIndex;
    readonly artifacts: ProofArtifactStore;
    readonly workspaceRoot: string;
    /**
     * `scope: turn` as the gate applies it to a session-wide index
     * (`VerifyOptions.turnNumbers`). Absent: `evidence` is used as given,
     * so it must already be scoped.
     */
    readonly turnNumbers?: ReadonlySet<number>;
    readonly now?: () => Date;
  },
): Promise<{ readonly bundle: ProofBundle; readonly notes: ReadonlyArray<string> }> {
  const { config, notes } = preflightConfig(opts.config);
  const bundle = await verifyDocument(draft, {
    config,
    evidence: opts.evidence,
    artifacts: opts.artifacts,
    workspaceRoot: opts.workspaceRoot,
    ...(opts.turnNumbers !== undefined ? { turnNumbers: opts.turnNumbers } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    // Deliberately absent: replay, isPureTool, resolveHead, judgeWaiver.
  });
  const replayed =
    config.level === "checked" &&
    config.execution.replay &&
    bundle.claims.some((c) => c.bindings.some((b) => b.kind === "execution" && b.ok));
  return {
    bundle,
    notes: replayed
      ? [
          ...notes,
          "the gate also re-runs each cited pure tool with its logged input and fails a claim whose output differs (replay_mismatch); this preflight does not re-run them",
        ]
      : notes,
  };
}

function bindingRow(b: ProofBinding): Record<string, unknown> {
  return {
    ref: b.ref,
    kind: b.kind,
    rung: b.rung,
    ok: b.ok,
    ...(b.reason !== undefined ? { reason: b.reason } : {}),
    // Detail says why a binding fell short; on a met binding it is noise.
    ...(!b.ok && b.detail !== undefined ? { detail: clip(b.detail, 300) } : {}),
    ...(b.origin !== undefined ? { origin: clip(b.origin, 200) } : {}),
    ...(b.kind === "execution" && b.replayed !== undefined ? { replayed: b.replayed } : {}),
    ...(b.checker !== undefined ? { checker: b.checker } : {}),
  };
}

function claimRow(c: ProofClaim): Record<string, unknown> {
  // A sentence can carry any number of markers; past a few the row says how
  // many more rather than spending the report on them.
  const shown = c.bindings.slice(0, ROW_BINDINGS);
  return {
    index: c.index,
    status: c.status,
    best: c.best,
    text: clip(c.text, 300),
    ...(c.line !== undefined ? { line: c.line } : {}),
    ...(c.definition !== undefined ? { definition: c.definition } : {}),
    evidence: shown.map(bindingRow),
    ...(c.bindings.length > shown.length ? { moreEvidence: c.bindings.length - shown.length } : {}),
  };
}

/** Room kept for `"tableOmitted":<n>` after the rows. */
const OMITTED_KEY_BYTES = 32;

/**
 * The preflight's answer, in the order the model should read it: the
 * verdict and counts, the footer the reader would see, what to do next,
 * the notes on where the preflight differs from the gate, the gate's own
 * retry nudge when the draft would not pass cleanly, and then a row per
 * claim with each binding's verdict — the unmet claims first.
 *
 * The whole report fits in {@link REPORT_BYTES}: the runtime shows the model
 * only the head of a larger result, so the instructions go first — the
 * notes and the nudge each held to a byte share ({@link NOTES_BYTES},
 * `NUDGE_BYTES`) — and the table takes the room that is left, row by row; `tableOmitted` counts the
 * claims it had no room for (the counts above it cover every claim, and the
 * nudge already names the unmet ones). Excerpts of fetched bodies are left
 * out on purpose: the model already read those bodies, and the nudge's rule
 * (no fetched content) is the right one for anything the gate machinery
 * hands back to the model.
 */
export function preflightReport(
  bundle: ProofBundle,
  notes: ReadonlyArray<string>,
): Record<string, unknown> {
  const clean = bundle.verdict === "pass" && bundle.unmet === 0;
  const head: Record<string, unknown> = {
    verdict: bundle.verdict,
    level: bundle.level,
    score: bundle.score,
    threshold: bundle.threshold,
    achieved: bundle.achieved,
    claims: bundle.claimCount,
    met: bundle.met,
    unmet: bundle.unmet,
    assumptions: bundle.assumptions,
    ...(bundle.assumptionsRefused !== undefined
      ? { assumptionsRefused: bundle.assumptionsRefused }
      : {}),
    sources: bundle.sources,
    ...(bundle.vacuous !== undefined ? { vacuous: bundle.vacuous } : {}),
    footer: renderFooter(bundle),
    next: clean
      ? "the gate would accept this draft as it stands; send it without changing the claims or their citations"
      : bundle.verdict === "pass"
        ? "the gate would accept this draft, but the claims marked unmet are not backed; fix or drop them if you can"
        : "the gate would not accept this draft; fix every unmet claim, then run ProvabilityPreflight again before you answer",
    ...(notes.length > 0 ? { notes: listed(notes, NOTES_BYTES, moreNotes, NOTE_CHARS) } : {}),
    // The nudge is written for the gate's retry; here the draft is not yet an
    // answer. Cut in the middle: its head names the verdict and the first
    // unmet claims, its tail how to cite and to preflight again.
    ...(clean
      ? {}
      : {
          nudge: fitText(
            renderNudge(bundle).replace("your last answer", "this draft"),
            NUDGE_BYTES,
            clipMiddle,
          ),
        }),
  };
  // Unmet claims first, each group in draft order: they are what to fix.
  const ordered = [
    ...bundle.claims.filter((c) => c.status === "unmet"),
    ...bundle.claims.filter((c) => c.status !== "unmet"),
  ];
  const rows: Array<Record<string, unknown>> = [];
  let used = jsonBytes({ ...head, table: [] }) + OMITTED_KEY_BYTES;
  for (const claim of ordered.slice(0, TABLE_ROWS)) {
    const row = claimRow(claim);
    const cost = jsonBytes(row) + (rows.length > 0 ? 1 : 0);
    if (used + cost > REPORT_BYTES) break;
    rows.push(row);
    used += cost;
  }
  return {
    ...head,
    table: rows,
    ...(bundle.claims.length > rows.length
      ? { tableOmitted: bundle.claims.length - rows.length }
      : {}),
  };
}

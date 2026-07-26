/**
 * Item 1 — the `feedback.autoDistill` consumer + the REPL exit-rating
 * gating logic. Gives the parsed-but-inert spec flag its first reader:
 *
 *   - **autoDistill**: at CLI `run` teardown (NOT a spawned hook — hooks
 *     run credential-stripped), when the accumulated feedback store holds
 *     ≥ N unprocessed `user_feedback` records, the existing `distill()`
 *     runs over ALL sessions — always PII/secret-redacted (B23: the
 *     teardown is unattended, so there is no opt-out) — and the result is
 *     registered as a new
 *     auto-bumped version of the `<specName>-ratings` registry dataset —
 *     immediately consumable as `--dataset registry:<specName>-ratings`
 *     (the item-12 shorthand `eval`/`optimize` already speak). The spec's
 *     `autoDistill` is a plain boolean, so the threshold defaults to
 *     {@link DEFAULT_AUTODISTILL_THRESHOLD} (env-tunable via
 *     `CREWHAUS_AUTODISTILL_THRESHOLD`).
 *
 *   - **Watermark** (`.crewhaus/feedback/.distill-state.json`): one small
 *     JSON file holding the ISO timestamp of the newest feedback record
 *     folded into the last auto-distill. "Unprocessed" = records with a
 *     strictly greater `ts`. The trigger counts only unprocessed records,
 *     but each distill re-reads EVERYTHING — the registry version is always
 *     a full rebuild (merge semantics live in `mergeFeedback`), so the
 *     watermark only rate-limits registrations, never shapes the dataset.
 *     A failed registration leaves the watermark untouched (retried next
 *     run); a distill that matched zero turns advances it (those records
 *     are unmatchable — their sessions are gone — so retrying is noise).
 *
 * The block's OTHER consumer — the one-keystroke `rate this session? [g]ood /
 * [b]ad / [enter] skip` prompt at clean REPL exit — moved to
 * @crewhaus/runtime-core (`exit-rating.ts`) so a COMPILED bundle asks it too;
 * see the note at the bottom of this file.
 *
 * Kept in a module with no import-time side effects (the CLI entry file
 * runs an argv switch on import), mirroring `eval-history.ts` /
 * `datasets.ts`. Filesystem access is limited to the watermark file plus —
 * when `reviewRootDir` is supplied — the B20 review queue (split-verdict
 * ties must not vanish just because the distill ran unattended).
 */
import type { DatasetRegistry } from "@crewhaus/dataset-registry";
import type { DatasetRecord } from "@crewhaus/dataset-registry";
import {
  DISTILL_STATE_RELPATH,
  countUnprocessed,
  newestTs,
  ratingsDatasetName,
  readDistillState,
  resolveAutoDistillThreshold,
  shouldAutoDistill,
  writeDistillState,
} from "@crewhaus/feedback-distill";
import type { IrFeedback } from "@crewhaus/ir";
import { redactDatasetText } from "./dataset-audit";
import { DEFAULT_SPLIT_SPEC, registerDataset } from "./datasets";
import { type FeedbackRecord, type SessionTurn, distill } from "./feedback";
import { isRegistrySafeName } from "./regression-pin";
import { enqueueReviewEntries, entriesFromRaterTies } from "./review-queue";

// D39 — the watermark/threshold/trigger primitives MOVED to
// `@crewhaus/feedback-distill` so the daemon janitor step and this teardown
// consumer share ONE implementation and ONE state file: once either lands a
// batch, the other sees nothing unprocessed. (It is a shared watermark, not a
// lock — see the package module doc for the overlapping-run caveat.)
// Re-exported here so every existing `./autodistill` importer is unaffected.
export {
  AUTODISTILL_THRESHOLD_ENV,
  DEFAULT_AUTODISTILL_THRESHOLD,
  DISTILL_STATE_RELPATH,
  type AutoDistillDecision,
  type DistillState,
  countUnprocessed,
  newestTs,
  parseDistillState,
  ratingsDatasetName,
  readDistillState,
  resolveAutoDistillThreshold,
  shouldAutoDistill,
  writeDistillState,
} from "@crewhaus/feedback-distill";

// -------- the consumer --------

export type MaybeAutoDistillOptions = {
  readonly specName: string;
  readonly feedback: IrFeedback | undefined;
  /** All sessions' turns (tagged with the sessionId join key). */
  readonly turns: ReadonlyArray<SessionTurn>;
  /** The accumulated store: in-transcript `user_feedback` records plus the
   *  web-UI `.crewhaus/feedback/*.jsonl` records. */
  readonly records: ReadonlyArray<FeedbackRecord>;
  readonly registry: DatasetRegistry;
  /** Watermark file path (see {@link DISTILL_STATE_RELPATH}). */
  readonly stateFilePath: string;
  /** Env for the threshold/opt-outs; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Positive-sample cutoff forwarded to distill(); default 0.7 (matches
   *  `crewhaus distill --min-score`). */
  readonly minScore?: number;
  /** Harness root for the B20 review queue. When set, split-verdict turns
   *  (B19 rater ties — withheld from the dataset) are enqueued as
   *  `rater_disagreement` items, best-effort, exactly like the `crewhaus
   *  distill` CLI path — an unattended teardown must not silently swallow a
   *  disagreement. Omitted → no queue writes (pure-unit callers). */
  readonly reviewRootDir?: string;
  readonly now?: () => Date;
  /** Line sink; defaults to stdout. */
  readonly write?: (line: string) => void;
};

export type MaybeAutoDistillResult = {
  readonly ran: boolean;
  readonly reason: string;
  readonly registered?: { readonly name: string; readonly version: string };
};

/**
 * The teardown consumer. One printed line per outcome that did anything;
 * silent when the trigger simply hasn't accumulated yet. Best-effort by
 * contract — the CALLER wraps it so a failure can never turn a successful
 * session into a non-zero exit.
 */
export async function maybeAutoDistill(
  opts: MaybeAutoDistillOptions,
): Promise<MaybeAutoDistillResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = opts.env ?? process.env;
  const threshold = resolveAutoDistillThreshold(env);
  const state = readDistillState(opts.stateFilePath);
  const unprocessed = countUnprocessed(opts.records, state?.lastProcessedTs);
  const decision = shouldAutoDistill({ feedback: opts.feedback, unprocessed, threshold });
  if (!decision.run) return { ran: false, reason: decision.reason };

  const name = ratingsDatasetName(opts.specName);
  if (!isRegistrySafeName(name)) {
    write(
      `[feedback] auto-distill skipped: spec name "${opts.specName}" can't form a registry dataset name ("${name}")`,
    );
    return { ran: false, reason: "spec name is not registry-safe" };
  }

  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const watermark = newestTs(opts.records) ?? nowIso;

  // Full rebuild over EVERYTHING (see the module doc): merge semantics stay
  // in mergeFeedback, and each registered version is self-contained. B23 —
  // this consumer runs unattended at teardown, so it ALWAYS redacts (there
  // is no --no-redact here): raw turn text and corrections must never land
  // in the auto-registered ratings dataset.
  const result = distill(opts.turns, opts.records, {
    minScore: opts.minScore ?? 0.7,
    redact: redactDatasetText,
  });
  // B19/B20 — this distill ran unattended, so its warnings (unmatched
  // ratings, rater disagreements, floor-grader fallback) and its withheld
  // split verdicts are the ONLY surfacing the teardown gets: print the
  // warnings and route the ties to the persistent review queue (best-effort,
  // idempotent by (sessionId, turn) — same as the `crewhaus distill` feeder).
  // Runs before the zero-sample return so an all-ties corpus still enqueues.
  for (const w of result.warnings) write(`[feedback] auto-distill warning: ${w}`);
  if (opts.reviewRootDir !== undefined && result.ties !== undefined && result.ties.length > 0) {
    try {
      const q = enqueueReviewEntries(
        opts.reviewRootDir,
        entriesFromRaterTies(result.ties, { ts: nowIso }),
      );
      write(
        `[feedback] auto-distill: ${result.ties.length} rater disagreement(s) withheld → review queue ` +
          `(${q.added} new) — \`crewhaus review next\` or \`crewhaus rate --adjudicate\``,
      );
    } catch (err) {
      write(
        `[feedback] auto-distill review queue skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (result.samples.length === 0) {
    // The ratings exist but none joined to a transcript turn (sessions
    // purged/rotated). Advance the watermark so the same unmatchable
    // records don't re-trigger a doomed distill on every run.
    writeDistillState(opts.stateFilePath, {
      schemaVersion: 1,
      lastProcessedTs: watermark,
      processedCount: opts.records.length,
      ...(state?.lastRegistered !== undefined ? { lastRegistered: state.lastRegistered } : {}),
    });
    write(
      "[feedback] auto-distill: no rated turn matched a transcript — nothing registered (watermark advanced)",
    );
    return { ran: false, reason: "no rated turns matched the transcripts" };
  }

  // Register FIRST, advance the watermark only on success — a transient
  // registry failure retries on the next teardown instead of losing the
  // trigger.
  let record: DatasetRecord;
  try {
    record = await registerDataset({
      registry: opts.registry,
      name,
      samples: result.samples,
      splitSpec: DEFAULT_SPLIT_SPEC,
    });
  } catch (err) {
    write(
      `[feedback] auto-distill failed to register ${name}: ${err instanceof Error ? err.message : String(err)} (will retry next run)`,
    );
    return { ran: false, reason: "registry put failed" };
  }
  writeDistillState(opts.stateFilePath, {
    schemaVersion: 1,
    lastProcessedTs: watermark,
    processedCount: opts.records.length,
    lastRegistered: { name: record.name, version: record.version, at: nowIso },
  });
  write(
    `[feedback] auto-distilled ${result.stats.matchedTurns} rating(s) → registry:${record.name}@${record.version} ` +
      `(train ${record.splits.train.length} / dev ${record.splits.dev.length} / test ${record.splits.test?.length ?? 0})`,
  );
  return {
    ran: true,
    reason: decision.reason,
    registered: { name: record.name, version: record.version },
  };
}

// -------- REPL exit rating prompt --------
//
// MOVED to @crewhaus/runtime-core (`src/exit-rating.ts`). The prompt used to
// be gated + read here and driven from the CLI's post-session teardown, which
// is exactly why a COMPILED cli bundle had no rating capture: the cli emitter
// dropped the `feedback:` block and only `crewhaus run` implemented it. The
// prompt belongs to the REPL, and the REPL is `runChatLoop`, so both surfaces
// now reach it by threading `feedback` into the loop. The opt-out env is
// re-exported below so this module's autoDistill docs stay self-contained.
export { NO_EXIT_RATING_ENV } from "@crewhaus/runtime-core";

import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { collectFeedbackFromDisk, resolveSessionsDirs } from "./collect";
/**
 * D39 — `createDistillJanitorStep`: the daemon-side auto-distill.
 *
 * `feedback.autoDistill` used to have exactly ONE production consumer, the
 * `crewhaus run` teardown. The shapes that actually generate ratings are the
 * daemon shapes — the channel bot's 👍/👎 reactions and the gateway's web UI —
 * so their feedback piled up in `.crewhaus/feedback` + `.crewhaus/sessions`
 * until somebody happened to run the CLI against that harness. The daemons
 * already boot a janitor with a registered-step seam (the dream step rides
 * it); this is the same seam, for the same reason.
 *
 * Design notes:
 *   - the credential-stripped-hooks rationale that kept auto-distill out of
 *     bundles does NOT apply here: the daemon runs with credentials, and base
 *     distill is fully offline anyway (no model call);
 *   - the trigger, the watermark file and the full-rebuild semantics are the
 *     SAME code the CLI teardown uses (`watermark.ts`), so once one consumer
 *     lands a batch the others see nothing unprocessed and register nothing
 *     new (the watermark is a shared read-modify-write, not a lock — see
 *     `watermark.ts` for exactly what that does and does not guarantee);
 *   - registration happens FIRST and the watermark advances only on success,
 *     so a transient registry failure retries on the next tick;
 *   - the transcripts are read from the root the DAEMON actually writes to
 *     (`sessionsDirs`/`tenantsRootDir`/`CREWHAUS_SESSION_DIR`, resolved by
 *     `collect.ts` the way the runtime resolves it) — a misconfigured root
 *     used to look exactly like "these ratings are unmatchable" and burn
 *     them, so a sweep that finds NO readable transcript now skips instead
 *     of advancing the watermark;
 *   - B19 split verdicts go to the persistent review queue before the
 *     watermark moves: a daemon has no teardown to print them, so the queue
 *     is their only surfacing;
 *   - every free-text field is redacted before it can reach the dataset —
 *     this tick is unattended, so there is no opt-out (B23).
 */
import { type FeedbackRecord, type SessionTurn, distill } from "./feedback";
import { redactText } from "./redact";
import { type ReviewQueueEntry, enqueueReviewEntries, entriesFromRaterTies } from "./review-queue";
import {
  DEFAULT_SPLIT_SPEC,
  type SplitSpec,
  isRegistrySafeDatasetName,
  nextVersion,
  splitSamples,
} from "./split";
import {
  type AutoDistillFeedback,
  DISTILL_STATE_RELPATH,
  countUnprocessed,
  newestTs,
  ratingsDatasetName,
  readDistillState,
  resolveAutoDistillThreshold,
  shouldAutoDistill,
  writeDistillState,
} from "./watermark";

/** The `@crewhaus/runtime-core` `JanitorStep` contract, declared structurally
 *  so this package does not depend on runtime-core (mirroring how the janitor
 *  itself declares its reservation-store subset). */
export type DistillJanitorStep = {
  readonly name: string;
  run(): Promise<{
    readonly status: "ok" | "skipped" | "error";
    readonly count?: number;
    readonly detail?: string;
  }>;
};

/** The step name in `JanitorRunResult` + `janitor_action` trace events. */
export const DISTILL_STEP_NAME = "feedback_distill";

/** Opt-out env — mirrors `CREWHAUS_DREAM=0` for the dream step. */
export const NO_DAEMON_DISTILL_ENV = "CREWHAUS_AUTODISTILL";

/** The registry surface the step needs — the structural subset of
 *  `@crewhaus/dataset-registry`'s `DatasetRegistry`. */
export type DistillRegistry = {
  list(name: string): Promise<string[]>;
  put(input: {
    name: string;
    version: string;
    splits: { train: Sample[]; dev: Sample[]; test?: Sample[] };
  }): Promise<{ name: string; version: string }>;
};

/** What the corpus reader hands back. `CollectedFeedback` satisfies it; a test
 *  seam may omit the diagnostic fields. */
export type CollectedFeedbackLike = {
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly records: ReadonlyArray<FeedbackRecord>;
  readonly sessionCount?: number;
  readonly sessionsDirs?: ReadonlyArray<string>;
};

export type CreateDistillJanitorStepOptions = {
  /** Spec name — the `<specName>-ratings` dataset this step maintains. */
  readonly specName: string;
  /** The spec's lowered `feedback:` block. Absent/disabled/opt-out ⇒ the step
   *  reports `skipped` forever (and codegen normally omits it entirely). */
  readonly feedback: AutoDistillFeedback | undefined;
  /** The dataset registry to register into. */
  readonly registry: DistillRegistry;
  /** Harness root (default `process.cwd()`): where `.crewhaus/feedback`, the
   *  watermark and (unless overridden below) `.crewhaus/sessions` live. */
  readonly cwd?: string;
  /** Explicit transcript roots. Set this when the daemon's session store is
   *  NOT `<cwd>/.crewhaus/sessions` — reading the wrong root makes every
   *  rating look unmatchable. */
  readonly sessionsDirs?: ReadonlyArray<string>;
  /** Managed daemons: sweep `<tenantsRootDir>/<tenantId>/sessions` for every
   *  tenant, re-enumerated each tick (the same sweep `createJanitor` and
   *  `createDreamJanitorStep` do). A tenant-scoped daemon writes EVERY
   *  transcript there — `<cwd>/.crewhaus/sessions` is empty for it. */
  readonly tenantsRootDir?: string;
  /** Harness root for the B20 review queue; defaults to `cwd`. B19 split
   *  verdicts land here as `rater_disagreement` items (best-effort — a queue
   *  write failure never fails the tick). */
  readonly reviewRootDir?: string;
  /** Env for the threshold + opt-out + `CREWHAUS_SESSION_DIR`; defaults to
   *  `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Positive-sample cutoff forwarded to `distill()`; default 0.7 (matches
   *  `crewhaus distill --min-score`). */
  readonly minScore?: number;
  /** Split spec for the registered version; default 70/15/15. */
  readonly splitSpec?: SplitSpec;
  /** Test seam: clock. */
  readonly now?: () => Date;
  /** Test seam: read the corpus (defaults to the on-disk collector). A seam
   *  that omits `sessionCount` keeps the pre-guard behavior (a zero-sample
   *  distill advances the watermark); the real collector always reports it. */
  readonly collect?: (rootDir: string) => CollectedFeedbackLike;
  /** Test seam: the review-queue writer (defaults to the on-disk appender). */
  readonly enqueueReview?: (
    rootDir: string,
    entries: ReadonlyArray<ReviewQueueEntry>,
  ) => { added: number; skipped: number };
};

/**
 * Build the janitor step. Returns `null` when the spec did not opt in, so a
 * caller can write `steps: step !== null ? [step] : []` exactly like the
 * dream step's registration.
 */
export function createDistillJanitorStep(
  opts: CreateDistillJanitorStepOptions,
): DistillJanitorStep | null {
  const feedback = opts.feedback;
  if (feedback === undefined || feedback.enabled === false || feedback.autoDistill !== true) {
    return null;
  }
  return {
    name: DISTILL_STEP_NAME,
    async run() {
      const env = opts.env ?? process.env;
      if (env[NO_DAEMON_DISTILL_ENV] === "0") {
        return { status: "skipped", detail: `${NO_DAEMON_DISTILL_ENV}=0` };
      }
      const rootDir = opts.cwd ?? process.cwd();
      const stateFilePath = join(rootDir, DISTILL_STATE_RELPATH);
      // Resolve the transcript roots the SAME way the runtime does, so a
      // tenant-scoped or CREWHAUS_SESSION_DIR-relocated daemon reads the root
      // it actually wrote to.
      const collectOptions = {
        ...(opts.sessionsDirs !== undefined ? { sessionsDirs: opts.sessionsDirs } : {}),
        ...(opts.tenantsRootDir !== undefined ? { tenantsRootDir: opts.tenantsRootDir } : {}),
        env,
      };
      const collect =
        opts.collect ?? ((dir: string) => collectFeedbackFromDisk(dir, collectOptions));
      const collected: CollectedFeedbackLike = collect(rootDir);
      const { turns, records, sessionCount, sessionsDirs } = collected;
      const state = readDistillState(stateFilePath);
      const threshold = resolveAutoDistillThreshold(env);
      const unprocessed = countUnprocessed(records, state?.lastProcessedTs);
      const decision = shouldAutoDistill({ feedback, unprocessed, threshold });
      if (!decision.run) return { status: "skipped", detail: decision.reason };

      const name = ratingsDatasetName(opts.specName);
      if (!isRegistrySafeDatasetName(name)) {
        return {
          status: "skipped",
          detail: `spec name "${opts.specName}" cannot form a registry dataset name ("${name}")`,
        };
      }

      const nowIso = (opts.now?.() ?? new Date()).toISOString();
      const watermark = newestTs(records) ?? nowIso;
      // Full rebuild over EVERYTHING: the watermark only rate-limits
      // registrations, it never shapes the dataset. ALWAYS redacted — this
      // tick is unattended, so there is no --no-redact here.
      const result = distill(turns, records, {
        minScore: opts.minScore ?? 0.7,
        redact: redactText,
      });

      // B19/B20 — split verdicts are NOT silently resolved. A daemon has no
      // teardown to print them, so the persistent review queue is the ONLY
      // surfacing; enqueue BEFORE the watermark write (and before the
      // zero-sample return, so an all-ties corpus still queues). Best-effort:
      // a queue failure must never fail the tick or block registration.
      let tieNote = "";
      if (result.ties !== undefined && result.ties.length > 0) {
        const enqueue = opts.enqueueReview ?? enqueueReviewEntries;
        try {
          const q = enqueue(
            opts.reviewRootDir ?? rootDir,
            entriesFromRaterTies(result.ties, { ts: nowIso }),
          );
          tieNote = ` — ${result.ties.length} rater disagreement(s) withheld → review queue (${q.added} new)`;
        } catch (err) {
          tieNote = ` — ${result.ties.length} rater disagreement(s) withheld; review queue write failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      if (result.samples.length === 0) {
        // NOT the same as "unmatchable": a sweep that found NO readable
        // transcript at all is a CONFIGURATION signal (wrong session root,
        // tenant layout, store not mounted yet). Advancing here would mark
        // every submitted rating processed forever, so skip instead — a
        // distill is offline and costs nothing to retry next tick.
        if (sessionCount === 0) {
          const where = (sessionsDirs ?? resolveSessionsDirs(rootDir, collectOptions)).join(", ");
          return {
            status: "skipped",
            detail:
              `${records.length} rating(s) but no readable transcript under ${where} — ` +
              `watermark NOT advanced (check the session root: tenantsRootDir / CREWHAUS_SESSION_DIR)${tieNote}`,
          };
        }
        // The ratings exist but none joined to a transcript turn (sessions
        // purged/rotated). Advance the watermark so the same unmatchable
        // records do not re-trigger a doomed distill on every tick.
        writeDistillState(stateFilePath, {
          schemaVersion: 1,
          lastProcessedTs: watermark,
          processedCount: records.length,
          ...(state?.lastRegistered !== undefined ? { lastRegistered: state.lastRegistered } : {}),
        });
        return {
          status: "ok",
          count: 0,
          detail: `no rated turn matched a transcript — nothing registered (watermark advanced)${tieNote}`,
        };
      }

      // Register FIRST, advance the watermark only on success.
      const spec = opts.splitSpec ?? DEFAULT_SPLIT_SPEC;
      const version = nextVersion(await opts.registry.list(name));
      const { train, dev, test } = splitSamples(result.samples, spec);
      const record = await opts.registry.put({
        name,
        version,
        splits: { train, dev, ...(spec.test > 0 ? { test } : {}) },
      });
      writeDistillState(stateFilePath, {
        schemaVersion: 1,
        lastProcessedTs: watermark,
        processedCount: records.length,
        lastRegistered: { name: record.name, version: record.version, at: nowIso },
      });
      const splitNote = `train ${train.length} / dev ${dev.length} / test ${spec.test > 0 ? test.length : 0}`;
      return {
        status: "ok",
        count: result.stats.matchedTurns,
        detail: `${result.stats.matchedTurns} rating(s) → registry:${record.name}@${record.version} (${splitNote})${tieNote}`,
      };
    },
  };
}

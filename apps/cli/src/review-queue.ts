/**
 * Wave 3 (B20) — the persistent human-review queue, MOVED to
 * `@crewhaus/feedback-distill`.
 *
 * The module was pure (`node:fs` + `node:path` only), and the D39 daemon
 * distill step needs its B19 tie feeder: a split verdict captured on a
 * channel/gateway daemon has no `crewhaus run` teardown to route it, so the
 * queue is its ONLY surfacing. Lifting it into the package lets a compiled
 * bundle enqueue exactly what the CLI enqueues, with one implementation of the
 * deterministic entry ids the idempotency guarantee rests on.
 *
 * This module stays as the CLI's import surface — every `./review-queue`
 * importer in `apps/cli` keeps working unchanged.
 */
export {
  REVIEW_KINDS,
  REVIEW_QUEUE_SCHEMA_VERSION,
  REVIEW_QUEUE_SUBDIR,
  type RaterTie,
  type ResolveReviewResult,
  type ReviewKind,
  type ReviewQueueEntry,
  type ReviewSourceRef,
  type ReviewStatus,
  describeSourceRef,
  enqueueReviewEntries,
  entriesFromEvalRun,
  entriesFromQuarantine,
  entriesFromRaterTies,
  formatReviewItem,
  formatReviewList,
  isReviewQueueEntry,
  nextOpenEntry,
  readReviewQueue,
  resolveReviewEntry,
  reviewEntryId,
  reviewQueuePath,
} from "@crewhaus/feedback-distill";

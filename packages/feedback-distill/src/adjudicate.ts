/**
 * Settling one review entry with a person's verdict, the same from Home, the inbox and the
 * CLI (`@crewhaus/feedback-distill/adjudicate`).
 *
 * A verdict on an entry that points at a session TURN (a rater disagreement) is more than a
 * queue close: closing it in the queue alone would leave the disagreement unsettled at the
 * feedback source, and the next distill would open it again. So `up`/`down` there takes the
 * path `crewhaus rate --adjudicate` takes: a `FeedbackRecord` built with `adjudicate: true`,
 * appended as a `user_feedback` event on the session's own log, and only then the entry
 * resolved. An entry with no session turn (an eval abstention, a quarantine pointer) records
 * `pass`/`fail` on the entry itself.
 *
 * The entry's claim is taken first, before a rating or a line is written: of two verdicts on
 * one entry one is recorded, whichever surface each came from, and it says who and where.
 *
 * A subpath of its own, so the package's main entry (which a compiled daemon carries) stays
 * as it was. The caller says where the harness's sessions folder is, as it reads one.
 */
import { randomBytes } from "node:crypto";
import { SESSION_ID_RE } from "@crewhaus/control-contract";
import { openEventLog } from "@crewhaus/event-log";
import { FEEDBACK_EVENT_KIND, buildFeedbackRecord } from "./feedback";
import {
  type ReviewActor,
  type ReviewQueueEntry,
  claimReviewEntry,
  readReviewQueue,
  resolveReviewEntry,
} from "./review-queue";

/** The verdicts on an entry: `up`/`down` settle a rated turn, `pass`/`fail` the entry itself. */
export const REVIEW_VERDICTS = ["up", "down", "pass", "fail"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Whether a word is a verdict. */
export function isReviewVerdict(value: string): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(value);
}

/** Whether an entry points at a session's turn, which a rating settles. */
export function isAdjudicable(entry: Pick<ReviewQueueEntry, "sourceRef">): boolean {
  return typeof entry.sourceRef.sessionId === "string" && typeof entry.sourceRef.turn === "number";
}

/** Where a harness's sessions are: its folder, or why it cannot be reached. */
export type SessionRootAnswer = { readonly root: string } | { readonly note: string };

export type AdjudicateResult =
  | {
      readonly outcome: "resolved";
      readonly entry: ReviewQueueEntry;
      /** True when the verdict also landed as an adjudicating FeedbackRecord. */
      readonly adjudicated: boolean;
      readonly resolution: string;
    }
  | { readonly outcome: "already-resolved"; readonly entry: ReviewQueueEntry }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "rejected"; readonly reason: string };

export type AdjudicateRequest = {
  readonly harnessDir: string;
  readonly itemId: string;
  readonly verdict: ReviewVerdict;
  readonly note?: string;
  /** The rater a rating names. */
  readonly by: string;
  /** Who resolves it as the resolved line records it: a stored actor and a door. */
  readonly actor?: ReviewActor;
  /** Where the rating was captured: Home's own screen, or the command line. */
  readonly source?: "ui" | "cli";
  readonly nowIso: string;
  /** The harness's sessions folder, asked only for a rating. */
  readonly sessionRoot: (harnessDir: string) => SessionRootAnswer;
};

/**
 * Close one review entry with a verdict. Of two callers on one entry, one resolves it and
 * the other answers `already-resolved`, having written nothing.
 *
 * First consumers: Home's review route and its inbox, and `crewhaus inbox decide`.
 */
export async function adjudicateReviewEntry(args: AdjudicateRequest): Promise<AdjudicateResult> {
  const entry = readReviewQueue(args.harnessDir).find((e) => e.id === args.itemId);
  if (entry === undefined) return { outcome: "not-found" };
  if (entry.status === "resolved") return { outcome: "already-resolved", entry };

  const isThumbs = args.verdict === "up" || args.verdict === "down";
  if (isThumbs && !isAdjudicable(entry)) {
    return {
      outcome: "rejected",
      reason:
        "this item points at no session turn — record pass/fail on the item instead of a thumbs adjudication",
    };
  }

  let rating: { record: ReturnType<typeof buildFeedbackRecord>; root: string } | undefined;
  if (isThumbs) {
    const sessionId = entry.sourceRef.sessionId as string;
    const turnNumber = entry.sourceRef.turn as number;
    if (!SESSION_ID_RE.test(sessionId)) {
      return { outcome: "rejected", reason: "queue entry names an invalid session id" };
    }
    const reach = args.sessionRoot(args.harnessDir);
    if (!("root" in reach)) return { outcome: "rejected", reason: reach.note };
    let record: ReturnType<typeof buildFeedbackRecord>;
    try {
      record = buildFeedbackRecord({
        id: `fb_${randomBytes(6).toString("hex")}`,
        sessionId,
        turnNumber,
        ts: args.nowIso,
        source: args.source ?? "ui",
        thumbs: args.verdict as "up" | "down",
        rater: args.by,
        adjudicate: true,
      });
    } catch (err) {
      return { outcome: "rejected", reason: err instanceof Error ? err.message : String(err) };
    }
    rating = { record, root: reach.root };
  }

  // Claimed before anything is written: a loser appends no rating and no line.
  const claim = claimReviewEntry(args.harnessDir, args.itemId, {
    at: args.nowIso,
    ...(args.actor !== undefined ? { actor: args.actor } : {}),
  });
  if (claim.outcome === "unavailable") return { outcome: "rejected", reason: claim.reason };
  if (claim.outcome === "taken") return { outcome: "already-resolved", entry };
  const adjudicated = rating !== undefined;
  if (rating !== undefined) {
    const log = await openEventLog(rating.record.sessionId, { rootDir: rating.root });
    try {
      await log.append({ kind: FEEDBACK_EVENT_KIND, payload: rating.record });
    } finally {
      await log.close();
    }
  }

  const resolution =
    args.note !== undefined && args.note !== ""
      ? args.note
      : adjudicated
        ? `adjudicated: thumbs ${args.verdict}`
        : args.verdict;
  const result = resolveReviewEntry(
    args.harnessDir,
    args.itemId,
    resolution,
    args.nowIso,
    args.actor,
    { claimed: true },
  );
  if (result.outcome === "not-found") return { outcome: "not-found" };
  if (result.outcome === "unavailable") return { outcome: "rejected", reason: result.reason };
  if (result.outcome === "already-resolved") {
    return { outcome: "already-resolved", entry: result.entry };
  }
  return { outcome: "resolved", entry: result.entry, adjudicated, resolution };
}

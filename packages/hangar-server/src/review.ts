/**
 * The fleet review queue — `.crewhaus/review/queue.jsonl` folded across every
 * registered harness, and the one write that closes an item.
 *
 * Both halves go through `@crewhaus/feedback-distill`'s own module
 * (`readReviewQueue` / `resolveReviewEntry`), which is append-only and folds
 * later-line-wins, so the manager and `crewhaus review` are literally the
 * same reader and the same writer.
 *
 * ADJUDICATION IS NOT JUST A QUEUE CLOSE. When the item points at a session
 * TURN — a B19 rater disagreement — closing it in the queue alone would
 * leave the disagreement unsettled at the feedback source, and the next
 * `crewhaus distill` would re-open it. So a verdict on such an item takes the
 * SAME path `crewhaus rate --adjudicate` takes: a `FeedbackRecord` built by
 * `buildFeedbackRecord({ adjudicate: true })`, appended as a `user_feedback`
 * event on the session's own log, and only then the queue entry resolved.
 * Items with no session turn (eval abstentions, quarantine pointers) record
 * the human's pass/fail on the item itself, exactly as the CLI's `next` does.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { openEventLog } from "@crewhaus/event-log";
import {
  FEEDBACK_EVENT_KIND,
  type ReviewQueueEntry,
  buildFeedbackRecord,
  readReviewQueue,
  resolveReviewEntry,
} from "@crewhaus/feedback-distill";
import { SESSION_ID_RE } from "./constants";
import { maskText } from "./mask";
import { resolveInside } from "./safety";
import { resolveSessionRoot } from "./sessions";

/** Verdicts the review route accepts. `up`/`down` adjudicate a rated turn;
 *  `pass`/`fail` record a verdict on the item itself. */
export const REVIEW_VERDICTS = ["up", "down", "pass", "fail"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(value: string): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(value);
}

export type ReviewRow = ReviewQueueEntry & {
  readonly harnessId: string;
  readonly harnessDir: string;
  readonly specName: string;
  /** True when a verdict can settle the underlying disagreement, not just
   *  the queue row (the item points at a session turn). */
  readonly adjudicable: boolean;
};

export type ReviewView = {
  readonly items: readonly ReviewRow[];
  readonly open: number;
};

export type ReviewHarness = {
  readonly id: string;
  readonly dir: string;
  readonly specName: string;
};

/** True when the harness even has a queue file (absence is not an error). */
function hasQueue(harnessDir: string): boolean {
  const path = resolveInside(harnessDir, [".crewhaus", "review", "queue.jsonl"]);
  return path !== undefined && existsSync(path);
}

function adjudicable(entry: ReviewQueueEntry): boolean {
  return typeof entry.sourceRef.sessionId === "string" && typeof entry.sourceRef.turn === "number";
}

/** Fold every registered harness's review queue, oldest open first. */
export function reviewInbox(
  harnesses: readonly ReviewHarness[],
  opts: { readonly includeResolved?: boolean } = {},
): ReviewView {
  const items: ReviewRow[] = [];
  for (const harness of harnesses) {
    if (!hasQueue(harness.dir)) continue;
    let entries: ReviewQueueEntry[];
    try {
      entries = readReviewQueue(harness.dir);
    } catch {
      continue; // unreadable queue — absence, not error
    }
    for (const entry of entries) {
      if (opts.includeResolved !== true && entry.status !== "open") continue;
      items.push({
        ...entry,
        // The feeders already redacted; masking again is defence in depth on
        // a field that is free text by construction.
        ...(entry.context !== undefined ? { context: maskText(entry.context) } : {}),
        harnessId: harness.id,
        harnessDir: harness.dir,
        specName: harness.specName,
        adjudicable: adjudicable(entry),
      });
    }
  }
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { items, open: items.filter((i) => i.status === "open").length };
}

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

/**
 * Close one review item. `up`/`down` on a session-turn item routes through
 * the capture path `crewhaus rate --adjudicate` uses; every other
 * combination records the verdict on the item.
 */
export async function adjudicateReview(args: {
  readonly harnessDir: string;
  readonly itemId: string;
  readonly verdict: ReviewVerdict;
  readonly note?: string;
  readonly by: string;
  readonly nowIso: string;
}): Promise<AdjudicateResult> {
  const entry = readReviewQueue(args.harnessDir).find((e) => e.id === args.itemId);
  if (entry === undefined) return { outcome: "not-found" };
  if (entry.status === "resolved") return { outcome: "already-resolved", entry };

  const isThumbs = args.verdict === "up" || args.verdict === "down";
  if (isThumbs && !adjudicable(entry)) {
    return {
      outcome: "rejected",
      reason:
        "this item points at no session turn — record pass/fail on the item instead of a thumbs adjudication",
    };
  }

  let adjudicated = false;
  if (isThumbs) {
    const sessionId = entry.sourceRef.sessionId as string;
    const turnNumber = entry.sourceRef.turn as number;
    if (!SESSION_ID_RE.test(sessionId)) {
      return { outcome: "rejected", reason: "queue entry names an invalid session id" };
    }
    const { root } = resolveSessionRoot(args.harnessDir);
    let record: ReturnType<typeof buildFeedbackRecord>;
    try {
      record = buildFeedbackRecord({
        id: `fb_${randomBytes(6).toString("hex")}`,
        sessionId,
        turnNumber,
        ts: args.nowIso,
        // The manager console is a `ui` capture surface, not the CLI.
        source: "ui",
        thumbs: args.verdict,
        rater: args.by,
        adjudicate: true,
      });
    } catch (err) {
      return { outcome: "rejected", reason: err instanceof Error ? err.message : String(err) };
    }
    const log = await openEventLog(sessionId, { rootDir: root });
    try {
      await log.append({ kind: FEEDBACK_EVENT_KIND, payload: record });
    } finally {
      await log.close();
    }
    adjudicated = true;
  }

  const resolution =
    args.note !== undefined && args.note !== ""
      ? args.note
      : adjudicated
        ? `adjudicated: thumbs ${args.verdict}`
        : args.verdict;
  const result = resolveReviewEntry(args.harnessDir, args.itemId, resolution, args.nowIso);
  if (result.outcome === "not-found") return { outcome: "not-found" };
  if (result.outcome === "already-resolved") {
    return { outcome: "already-resolved", entry: result.entry };
  }
  return { outcome: "resolved", entry: result.entry, adjudicated, resolution };
}

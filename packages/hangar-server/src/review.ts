/**
 * The fleet review queue — `.crewhaus/review/queue.jsonl` folded across every
 * registered harness, and the one write that closes an item.
 *
 * Both halves go through `@crewhaus/feedback-distill`'s own modules
 * (`readReviewQueue`, and `adjudicateReviewEntry` from its `./adjudicate`
 * subpath), which are append-only and fold later-line-wins, so the manager,
 * the inbox and `crewhaus review` are literally the same reader and the same
 * writer.
 *
 * ADJUDICATION IS NOT JUST A QUEUE CLOSE. When the item points at a session
 * TURN — a B19 rater disagreement — a verdict takes the SAME path
 * `crewhaus rate --adjudicate` takes: an adjudicating `FeedbackRecord` on the
 * session's own log, and only then the queue entry resolved. Items with no
 * session turn record the human's pass/fail on the item itself. Whoever
 * resolves an item takes its claim first, so of two verdicts on one item one is
 * recorded, and it says who and where.
 */
import { existsSync } from "node:fs";
import { type ReviewQueueEntry, readReviewQueue } from "@crewhaus/feedback-distill";
import {
  type AdjudicateRequest,
  type AdjudicateResult,
  REVIEW_VERDICTS,
  type ReviewVerdict,
  adjudicateReviewEntry,
  isAdjudicable,
  isReviewVerdict,
} from "@crewhaus/feedback-distill/adjudicate";
import { maskText } from "./mask";
import { resolveInside } from "./safety";
import { reachableSessionRoot } from "./sessions";

/** Verdicts the review route accepts. `up`/`down` adjudicate a rated turn;
 *  `pass`/`fail` record a verdict on the item itself. */
export { REVIEW_VERDICTS, type ReviewVerdict, isReviewVerdict };

export type ReviewRow = Omit<ReviewQueueEntry, "context"> & {
  /** The quoted context, masked; `null` when the reader may not read this harness's content. */
  readonly context?: string | null;
  readonly contextWithheld?: true;
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

/** Fold every registered harness's review queue, oldest open first. */
export function reviewInbox(
  harnesses: readonly ReviewHarness[],
  opts: {
    readonly includeResolved?: boolean;
    /** Whether the reader may read this harness's content; quoted context is withheld otherwise. */
    readonly showsContent?: (harnessId: string) => boolean;
  } = {},
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
    const content = opts.showsContent?.(harness.id) ?? true;
    for (const entry of entries) {
      if (opts.includeResolved !== true && entry.status !== "open") continue;
      items.push({
        ...entry,
        // The feeders already redacted; masking again is defence in depth on
        // a field that is free text by construction.
        ...(entry.context !== undefined
          ? content
            ? { context: maskText(entry.context) }
            : { context: null, contextWithheld: true }
          : {}),
        harnessId: harness.id,
        harnessDir: harness.dir,
        specName: harness.specName,
        adjudicable: isAdjudicable(entry),
      });
    }
  }
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { items, open: items.filter((i) => i.status === "open").length };
}

export type { AdjudicateResult };

/**
 * Close one review item, through the writer every surface shares
 * (`@crewhaus/feedback-distill/adjudicate`): `up`/`down` on a session-turn item routes
 * through the capture path `crewhaus rate --adjudicate` uses; every other combination
 * records the verdict on the item. The sessions folder is the one Home reads, inside the
 * harness.
 */
export function adjudicateReview(
  args: Omit<AdjudicateRequest, "sessionRoot">,
): Promise<AdjudicateResult> {
  return adjudicateReviewEntry({
    ...args,
    sessionRoot: (dir) => {
      const reach = reachableSessionRoot(dir);
      return reach.reachable ? { root: reach.root } : { note: reach.note };
    },
  });
}

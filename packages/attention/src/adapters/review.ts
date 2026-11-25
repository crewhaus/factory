/**
 * The review queue: grader disagreements and other items waiting for a person's verdict,
 * `.crewhaus/review/queue.jsonl`. Read contained in the harness from the newest end
 * (truncation reported), each line checked with the queue's own guard, the last line per
 * id winning, as the queue's own reader folds it.
 */
import { join } from "node:path";
import { REVIEW_KINDS, isReviewQueueEntry } from "@crewhaus/feedback-distill";
import { dirFits, draftItem, msOf, shellWord, timeOf } from "../items";
import { type AttentionReader, READ_CAPS } from "../read";
import type { AttentionModel, Drafted, ItemContext, ReviewFact } from "../types";

/** The queue, relative to the harness. */
export const REVIEW_QUEUE_REL = join(".crewhaus", "review", "queue.jsonl");

/** A resolved entry stays listable (with `state=all`) this long. */
const SETTLED_KEPT_MS = 30 * 86_400_000;

type ReviewSection = AttentionModel["review"];

/**
 * The ids the queue's own minter (`reviewEntryId`) gives: `rev_`, a review kind, and
 * id-safe tokens. An entry with any other id is not listed.
 */
export const REVIEW_ENTRY_ID_RE = new RegExp(
  `^rev_(?:${REVIEW_KINDS.join("|")})_[A-Za-z0-9._-]{0,256}$`,
);

function latestById(records: readonly unknown[]) {
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (
      isReviewQueueEntry(record) &&
      REVIEW_ENTRY_ID_RE.test(record.id) &&
      timeOf(record.ts) !== undefined
    ) {
      byId.set(record.id, record as unknown as Record<string, unknown>);
    }
  }
  return byId;
}

/** The command that resolves one entry, or `undefined` when its id or folder fits none. */
function resolveTwin(dir: string, id: string): string | undefined {
  if (!dirFits(dir) || !REVIEW_ENTRY_ID_RE.test(id)) return undefined;
  return `cd ${shellWord(dir)} && crewhaus review resolve ${shellWord(id)}`;
}

/** The review section, re-read only when the queue changed; `prev` itself when it did not. */
export function readReviewSection(
  dir: string,
  reader: AttentionReader,
  prev: ReviewSection | undefined,
): ReviewSection {
  const stamp = reader.stamp(dir, REVIEW_QUEUE_REL);
  if (prev !== undefined && prev.stamp === stamp) return prev;
  const read = reader.tail(dir, REVIEW_QUEUE_REL, READ_CAPS);
  if (read.state !== "read") return { stamp, facts: [] };
  const facts: ReviewFact[] = [];
  for (const entry of latestById(read.records).values()) {
    const resolvedTs = timeOf(entry["resolvedTs"]);
    facts.push({
      id: entry["id"] as string,
      reviewKind: entry["kind"] as string,
      ts: entry["ts"] as string,
      status: entry["status"] === "resolved" ? "resolved" : "open",
      ...(resolvedTs !== undefined ? { resolvedTs } : {}),
    });
  }
  return { stamp, facts, ...(read.truncated ? { truncated: true as const } : {}) };
}

/** Each open entry's excerpt, read now, for a caller who may read the content. */
export function reviewBodies(dir: string, reader: AttentionReader): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  const read = reader.tail(dir, REVIEW_QUEUE_REL, READ_CAPS);
  if (read.state !== "read") return out;
  for (const [id, entry] of latestById(read.records)) {
    if (typeof entry["context"] === "string") out.set(id, entry["context"]);
  }
  return out;
}

function resolveChoice(dir: string, id: string) {
  const cliTwin = resolveTwin(dir, id);
  return cliTwin !== undefined
    ? { id: "resolve", needs: "operator" as const, cliTwin }
    : {
        id: "resolve",
        needs: "operator" as const,
        cliTwin: null,
        nullReason: "This harness's folder fits no command; resolve it in Home's Review.",
      };
}

/** One item per open entry, and (settled) per entry resolved in the last 30 days. */
export function reviewItems(
  section: ReviewSection,
  ctx: ItemContext,
  bodies: ReadonlyMap<string, unknown> | undefined,
): Drafted[] {
  const out: Drafted[] = [];
  for (const fact of section.facts) {
    const open = fact.status === "open";
    const resolvedAt = msOf(fact.resolvedTs) ?? msOf(fact.ts) ?? 0;
    if (!open && ctx.now - resolvedAt > SETTLED_KEPT_MS) continue;
    const body = open && ctx.content ? bodies?.get(fact.id) : undefined;
    out.push(
      draftItem({
        scope: ctx.harness,
        kind: "review",
        key: `rev:${fact.id}`,
        harness: ctx.harness,
        source: { kind: "review", id: fact.id },
        title: { template: "review.open", params: { reviewKind: fact.reviewKind } },
        whyNow: { template: "why.review-open", params: { reviewKind: fact.reviewKind } },
        runs: [],
        count: 0,
        evidence: [{ kind: "review", ref: fact.id, label: fact.reviewKind }],
        revision: [{ id: fact.id, state: fact.status }],
        choices: open ? [resolveChoice(ctx.dir, fact.id)] : [],
        requiredClass: "operator",
        state: open ? "open" : "resolved",
        ...(open
          ? {}
          : {
              resolution: {
                how: "decided" as const,
                at: fact.resolvedTs ?? fact.ts,
              },
            }),
        ...(body !== undefined ? { body: { excerpt: body } } : {}),
        ...(open && !ctx.content ? { bodyWithheld: true as const } : {}),
        since: fact.ts,
        latestAt: msOf(fact.ts) ?? 0,
        freshness: ctx.freshness,
      }),
    );
  }
  return out;
}

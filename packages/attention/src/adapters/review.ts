/**
 * The review queue: grader disagreements and other items waiting for a person's verdict,
 * `.crewhaus/review/queue.jsonl`. Read contained in the harness from the newest end
 * (truncation reported), each line checked with the queue's own guard, the last line per
 * id winning, as the queue's own reader folds it.
 */
import { join } from "node:path";
import { type AttentionChoice, SESSION_ID_RE } from "@crewhaus/control-contract";
import { REVIEW_KINDS, isReviewQueueEntry } from "@crewhaus/feedback-distill";
import { attIdOf } from "../ids";
import { decideChoice, draftItem, msOf, timeOf } from "../items";
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

/** Whether the entry points at a session's turn, which a rating settles. */
function adjudicable(entry: Readonly<Record<string, unknown>>): boolean {
  const ref = entry["sourceRef"] as { sessionId?: unknown; turn?: unknown } | undefined;
  return (
    typeof ref?.sessionId === "string" &&
    SESSION_ID_RE.test(ref.sessionId) &&
    typeof ref.turn === "number"
  );
}

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
      ...(adjudicable(entry) ? { adjudicable: true as const } : {}),
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

/** A verdict on the entry, or, where it points at a session's turn, a rating of it. */
function choicesOf(att: string, fact: ReviewFact): AttentionChoice[] {
  const ids = fact.adjudicable === true ? ["up", "down", "pass", "fail"] : ["pass", "fail"];
  return ids.map((id) => decideChoice(att, id, "operator"));
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
        choices: open ? choicesOf(attIdOf(ctx.harness, "review", `rev:${fact.id}`), fact) : [],
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

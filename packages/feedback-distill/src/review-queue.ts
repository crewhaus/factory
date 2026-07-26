/**
 * Wave 3 (B20) — the persistent human-review queue.
 *
 * CrewHaus generates review-worthy items in several places and used to drop
 * them on stdout: judge-abstained eval samples (`needs_human`, A3),
 * panel-entropy flags (`needs_review`, A2), rater disagreements distill cannot
 * label (B19), and `dataset mine`'s quarantined hard-case candidates. This
 * module gives them one durable home — `.crewhaus/review/queue.jsonl` — so
 * "items awaiting a human" survives the terminal scrollback.
 *
 * Storage is APPEND-ONLY JSONL (the same discipline as the feedback log): a
 * resolution appends an updated line for the same id and readers reduce
 * later-line-wins. Entry ids are DETERMINISTIC from the source key, so every
 * feeder is idempotent — re-running distill/mine (or re-reading the same eval
 * summary) never duplicates an item, and an id that already exists is skipped
 * even after it was resolved (a settled question stays settled).
 *
 * Entries are POINTERS, not payload copies: `sourceRef` names the run/sample,
 * session/turn, or dataset/sample the item came from; `context` carries a
 * short (already-redacted, caller-supplied) excerpt so `crewhaus review next`
 * can show the item without a join. The pure helpers (entry builders, guards,
 * formatters, next-selection) are all unit-testable; the three fs functions
 * take an explicit harness root.
 *
 * Lives in `@crewhaus/feedback-distill` (it moved out of `apps/cli`, which
 * re-exports it unchanged) because the DAEMON distill step needs the B19 tie
 * feeder: a split verdict captured by a channel/gateway daemon has no CLI
 * teardown to route it, and the queue is the only place it can surface.
 * The module imports nothing but `node:fs`/`node:path`, so a compiled bundle
 * carries it fine.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_QUEUE_SCHEMA_VERSION = 1 as const;

export const REVIEW_KINDS = [
  "abstained",
  "needs_review",
  "rater_disagreement",
  "quarantine",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Where the item came from — exactly one of the three shapes is populated:
 *  {runId, sampleId} (eval), {sessionId, turn} (feedback), or
 *  {dataset, sampleId} (mined quarantine). */
export type ReviewSourceRef = {
  runId?: string;
  sampleId?: string;
  sessionId?: string;
  turn?: number;
  dataset?: string;
};

export type ReviewStatus = "open" | "resolved";

export type ReviewQueueEntry = {
  schemaVersion: 1;
  /** Deterministic from (kind, sourceRef) — the idempotency key. */
  id: string;
  kind: ReviewKind;
  sourceRef: ReviewSourceRef;
  /** ISO 8601 — when the item was enqueued. */
  ts: string;
  status: ReviewStatus;
  /** The human's verdict/note, present once resolved. */
  resolution?: string;
  /** ISO 8601 — when the item was resolved. */
  resolvedTs?: string;
  /** Short display excerpt (sample input, vote split, mine signal) — already
   *  redacted by the feeder; never the full payload. */
  context?: string;
};

export const REVIEW_QUEUE_SUBDIR = join(".crewhaus", "review");

/** The queue file under a harness root. */
export function reviewQueuePath(rootDir: string): string {
  return join(rootDir, REVIEW_QUEUE_SUBDIR, "queue.jsonl");
}

/** Fold arbitrary source-key material into an id-safe token. */
function idToken(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** Deterministic entry id — the idempotency key feeders rely on. */
export function reviewEntryId(kind: ReviewKind, ref: ReviewSourceRef): string {
  const parts: string[] = [];
  if (ref.runId !== undefined) parts.push(idToken(ref.runId));
  if (ref.dataset !== undefined) parts.push(idToken(ref.dataset));
  if (ref.sessionId !== undefined) parts.push(idToken(ref.sessionId));
  if (ref.turn !== undefined) parts.push(`t${ref.turn}`);
  if (ref.sampleId !== undefined) parts.push(idToken(ref.sampleId));
  return `rev_${kind}_${parts.join("_")}`;
}

/** Narrow an arbitrary parsed JSONL value to a ReviewQueueEntry (torn or
 *  hand-mangled lines are dropped by the reader, never thrown on). */
export function isReviewQueueEntry(value: unknown): value is ReviewQueueEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== 1) return false;
  if (typeof v["id"] !== "string" || v["id"] === "") return false;
  if (!REVIEW_KINDS.includes(v["kind"] as ReviewKind)) return false;
  if (typeof v["sourceRef"] !== "object" || v["sourceRef"] === null) return false;
  if (typeof v["ts"] !== "string") return false;
  if (v["status"] !== "open" && v["status"] !== "resolved") return false;
  return true;
}

function parseQueueLines(text: string): ReviewQueueEntry[] {
  const out: ReviewQueueEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isReviewQueueEntry(parsed)) out.push(parsed);
    } catch {
      // torn line — skip
    }
  }
  return out;
}

/**
 * Read the queue as its reduced view: one entry per id (the LAST line for an
 * id wins — that is how a resolution supersedes the open entry), in
 * first-enqueued order.
 */
export function readReviewQueue(rootDir: string): ReviewQueueEntry[] {
  const path = reviewQueuePath(rootDir);
  if (!existsSync(path)) return [];
  const byId = new Map<string, ReviewQueueEntry>();
  for (const entry of parseQueueLines(readFileSync(path, "utf-8"))) {
    // Map.set on an existing key keeps the original insertion position:
    // later lines win on VALUE, first-enqueued order wins on ORDER.
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * Append entries the queue has not seen yet. Idempotent by id: an id already
 * present (open OR resolved) is skipped, and duplicate ids within one batch
 * collapse to the first. Returns the added/skipped tally so feeders can log
 * honestly.
 */
export function enqueueReviewEntries(
  rootDir: string,
  entries: ReadonlyArray<ReviewQueueEntry>,
): { added: number; skipped: number } {
  const existing = new Set(readReviewQueue(rootDir).map((e) => e.id));
  const fresh: ReviewQueueEntry[] = [];
  for (const e of entries) {
    if (existing.has(e.id)) continue;
    existing.add(e.id);
    fresh.push(e);
  }
  if (fresh.length > 0) {
    mkdirSync(join(rootDir, REVIEW_QUEUE_SUBDIR), { recursive: true });
    appendFileSync(
      reviewQueuePath(rootDir),
      `${fresh.map((e) => JSON.stringify(e)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  return { added: fresh.length, skipped: entries.length - fresh.length };
}

export type ResolveReviewResult =
  | { outcome: "resolved"; entry: ReviewQueueEntry }
  | { outcome: "already-resolved"; entry: ReviewQueueEntry }
  | { outcome: "not-found" };

/**
 * Close one item: append an updated line (status resolved + the human's
 * resolution) for the id. Append-only — the open line stays in the file as
 * the audit trail; readers reduce to the resolution.
 */
export function resolveReviewEntry(
  rootDir: string,
  id: string,
  resolution: string,
  resolvedTs: string,
): ResolveReviewResult {
  const entry = readReviewQueue(rootDir).find((e) => e.id === id);
  if (entry === undefined) return { outcome: "not-found" };
  if (entry.status === "resolved") return { outcome: "already-resolved", entry };
  const updated: ReviewQueueEntry = { ...entry, status: "resolved", resolution, resolvedTs };
  appendFileSync(reviewQueuePath(rootDir), `${JSON.stringify(updated)}\n`, { mode: 0o600 });
  return { outcome: "resolved", entry: updated };
}

/** The oldest open entry (enqueue ts, then file order), optionally filtered
 *  by kind. Undefined when the queue is clear. */
export function nextOpenEntry(
  entries: ReadonlyArray<ReviewQueueEntry>,
  kind?: ReviewKind,
): ReviewQueueEntry | undefined {
  let best: ReviewQueueEntry | undefined;
  for (const e of entries) {
    if (e.status !== "open") continue;
    if (kind !== undefined && e.kind !== kind) continue;
    if (best === undefined || e.ts < best.ts) best = e;
  }
  return best;
}

// -------- feeders --------

function makeEntry(
  kind: ReviewKind,
  sourceRef: ReviewSourceRef,
  ts: string,
  context?: string,
): ReviewQueueEntry {
  return {
    schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
    id: reviewEntryId(kind, sourceRef),
    kind,
    sourceRef,
    ts,
    status: "open",
    ...(context !== undefined ? { context } : {}),
  };
}

/**
 * Eval feeder (A3/A2 → B20): one `abstained` entry per needs_human sample id
 * and one `needs_review` entry per panel-flagged sample id, keyed on
 * (runId, sampleId). `contextForSample` supplies a short display excerpt
 * (the CLI passes the clipped sample input from the triage tap).
 *
 * Keyed PER RUN deliberately (unlike the distill/mine feeders, whose source
 * artifacts are stable across re-reads): each eval run produces a FRESH
 * agent output for the sample, and a judge abstaining on the new output is a
 * genuinely new question for a human. Coalescing on (dataset, sampleId)
 * would let one resolved verdict permanently swallow every later run's
 * distinct abstentions ("a settled question stays settled" is id-scoped).
 * The cost is that a chronically-abstaining sample enqueues one open item
 * per run until the sample/grader is fixed — resolve the items or fix the
 * instrument; the queue is honest about the recurring flow.
 */
export function entriesFromEvalRun(opts: {
  runId: string;
  needsHumanSampleIds?: ReadonlyArray<string>;
  needsReviewSampleIds?: ReadonlyArray<string>;
  contextForSample?: (sampleId: string) => string | undefined;
  ts: string;
}): ReviewQueueEntry[] {
  const out: ReviewQueueEntry[] = [];
  const push = (kind: ReviewKind, ids: ReadonlyArray<string> | undefined): void => {
    for (const sampleId of ids ?? []) {
      const context = opts.contextForSample?.(sampleId);
      out.push(makeEntry(kind, { runId: opts.runId, sampleId }, opts.ts, context));
    }
  };
  push("abstained", opts.needsHumanSampleIds);
  push("needs_review", opts.needsReviewSampleIds);
  return out;
}

/** The shape distill's B19 tie report shares with the queue feeder. */
export type RaterTie = {
  sessionId: string;
  turnNumber: number;
  votes: ReadonlyArray<{ rater: string; score: number; thumbs?: "up" | "down" }>;
};

/**
 * Distill feeder (B19 → B20): one `rater_disagreement` entry per unresolved
 * split verdict, keyed on (sessionId, turn) so re-distilling the same corpus
 * is a no-op. The context lists each rater's verdict — the raters were
 * already redacted by distill's B23 pass before the tie reached here.
 */
export function entriesFromRaterTies(
  ties: ReadonlyArray<RaterTie>,
  opts: { ts: string },
): ReviewQueueEntry[] {
  return ties.map((t) => {
    const votes = t.votes
      .map(
        (v) => `${v.rater === "" ? "(unattributed)" : v.rater}: ${v.thumbs ?? v.score.toFixed(2)}`,
      )
      .join(", ");
    return makeEntry(
      "rater_disagreement",
      { sessionId: t.sessionId, turn: t.turnNumber },
      opts.ts,
      `split verdict — ${votes}`,
    );
  });
}

/**
 * Mine feeder (B20): one `quarantine` POINTER per staged candidate, keyed on
 * (dataset, sampleId). The quarantine JSONL stays the payload store — the
 * queue only points at it (never duplicates the sample), with the redacted
 * input excerpt + signal as display context.
 */
export function entriesFromQuarantine(
  samples: ReadonlyArray<{ id: string; input: string; metadata?: Record<string, unknown> }>,
  opts: { dataset: string; ts: string },
): ReviewQueueEntry[] {
  return samples.map((s) => {
    const signal = typeof s.metadata?.["signal"] === "string" ? `[${s.metadata["signal"]}] ` : "";
    const excerpt = s.input.length > 80 ? `${s.input.slice(0, 80)}…` : s.input;
    return makeEntry(
      "quarantine",
      { dataset: opts.dataset, sampleId: s.id },
      opts.ts,
      `${signal}${excerpt}`,
    );
  });
}

// -------- formatting --------

/** One-line source description for the list view. */
export function describeSourceRef(ref: ReviewSourceRef): string {
  if (ref.sessionId !== undefined && ref.turn !== undefined) {
    return `${ref.sessionId} turn ${ref.turn}`;
  }
  if (ref.runId !== undefined) {
    return `${ref.runId}${ref.sampleId !== undefined ? ` sample ${ref.sampleId}` : ""}`;
  }
  if (ref.dataset !== undefined) {
    return `${ref.dataset}${ref.sampleId !== undefined ? ` sample ${ref.sampleId}` : ""}`;
  }
  return ref.sampleId ?? "(unknown source)";
}

/** The `review list` rendering (already filtered by the caller). */
export function formatReviewList(entries: ReadonlyArray<ReviewQueueEntry>): string {
  if (entries.length === 0) {
    return (
      "review queue is empty — eval abstentions/panel flags, rater disagreements, and\n" +
      "mined quarantine candidates land in .crewhaus/review/queue.jsonl as they occur.\n"
    );
  }
  const open = entries.filter((e) => e.status === "open").length;
  const lines = [`${entries.length} review item(s) (${open} open):`];
  for (const e of entries) {
    const context = e.context !== undefined ? ` — ${e.context}` : "";
    const resolution =
      e.status === "resolved" && e.resolution !== undefined ? ` (${e.resolution})` : "";
    lines.push(`  [${e.status}] ${e.id}`);
    lines.push(`      ${e.kind}: ${describeSourceRef(e.sourceRef)}${context}${resolution}`);
  }
  lines.push("");
  lines.push(
    "review one with `crewhaus review next`, or close with `crewhaus review resolve <id>`.",
  );
  return `${lines.join("\n")}\n`;
}

/** The `review next` single-item detail block. */
export function formatReviewItem(entry: ReviewQueueEntry): string {
  const lines = [
    `review item ${entry.id}`,
    `  kind:    ${entry.kind}`,
    `  source:  ${describeSourceRef(entry.sourceRef)}`,
    `  since:   ${entry.ts}`,
  ];
  if (entry.context !== undefined) lines.push(`  context: ${entry.context}`);
  return `${lines.join("\n")}\n`;
}
